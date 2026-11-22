// AI patient simulation - Netlify Edge Function (allows ~40s for the AI to answer)
// The case file (and its hidden facts and scoring guide) stays on the server,
// so students can't read the answers from the browser.
import caseData from './case-linda-carter.js';

const env = k => (globalThis.Netlify?.env?.get(k)) ?? (typeof process !== 'undefined' ? process.env[k] : undefined);
const KEY = env('OPENROUTER_API_KEY') || '';
const MOCK = env('MOCK_AI') === '1';
// Free models change often, so rank by pattern: strongest first. Tiny models are never used.
const PREFER = [/gemma-4-31b/i, /nemotron.*ultra/i, /deepseek.*(chat|v3)/i, /llama.*70b/i, /qwen.*(235b|72b|32b)/i,
  /nemotron.*super/i, /gemma-4/i, /mistral-(small|medium)/i, /gemma-3-27b/i, /gemma/i];
const sizeB = id => { const m = id.match(/(\d+(?:\.\d+)?)b(?![a-z])/i); return m ? +m[1] : null; };
const tooSmall = id => { const b = sizeB(id); return (b !== null && b < 20) || /nano|lfm|1\.7b/i.test(id); };

let modelCache = { at: 0, list: [] };
async function freeModels() {
  if (Date.now() - modelCache.at < 3600e3 && modelCache.list.length) return modelCache.list;
  const r = await fetch('https://openrouter.ai/api/v1/models');
  const all = ((await r.json()).data || []).filter(m => m.id.endsWith(':free') && +m.pricing?.prompt === 0 &&
    (m.architecture?.output_modalities || ['text']).includes('text') && !tooSmall(m.id));
  const ranked = [];
  for (const re of PREFER) for (const m of all) if (re.test(m.id) && !ranked.includes(m.id)) ranked.push(m.id);
  for (const m of all) if (!ranked.includes(m.id)) ranked.push(m.id);
  modelCache = { at: Date.now(), list: ranked.slice(0, 5) };
  return modelCache.list;
}

async function ask(messages, { json = false, skip = 0, deadline = Date.now() + 34000, check = null } = {}) {
  if (MOCK) return mockReply(messages, json);
  if (!KEY) throw new Error('The AI key is not set yet (OPENROUTER_API_KEY).');
  const all = await freeModels();
  const models = [...all.slice(skip % all.length), ...all.slice(0, skip % all.length)];
  let lastErr = 'No free AI model is available right now.';
  let backup = null, badReplies = 0; // a usable reply that failed the quality check, kept in case nothing better comes back
  for (const model of models) { // if a free model is busy or answers badly, try the next one
    for (const effort of ['none', 'low']) { // turn thinking off; if a model insists on thinking, keep it short
      const left = deadline - Date.now();
      if (left < 4000) break;
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'AI Patient Demo' },
          body: JSON.stringify({ model, messages, temperature: json ? 0.2 : 0.7, max_tokens: json ? 4000 : 1500,
            reasoning: { effort, exclude: true } }),
          signal: AbortSignal.timeout(Math.min(json ? 30000 : 18000, left)),
        });
        const j = await r.json().catch(() => ({}));
        const choice = j.choices?.[0] || {};
        const text = String(choice.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
        if (r.ok && text && choice.finish_reason !== 'length') {
          if (!check || check(text)) return text;
          backup = backup || text; lastErr = 'Reply was out of character';
          if (++badReplies >= 2) return backup; // don't burn the daily free allowance on retries
          break; // try the next model
        }
        lastErr = j.error?.message || (choice.finish_reason === 'length' ? 'Reply was cut off' : `Model busy (${r.status})`);
        // Account-wide free plan limit: other models would fail too, and failed tries still count, so stop here.
        if (r.status === 429 && /free-models-per|per-day|per-min/i.test(lastErr)) { if (backup) return backup; throw new Error('Rate limit: The free AI is busy right now. Please wait a minute and try again.'); }
        if (effort === 'none' && r.status === 400 && /reason|effort|think/i.test(lastErr)) continue; // model needs some thinking
        break;
      } catch (e) { if (/^Rate limit: /.test(e.message)) throw new Error(e.message.slice(12)); lastErr = e.message; break; }
    }
  }
  if (backup) return backup;
  throw new Error(/rate limit|429/i.test(lastErr) ? 'The free AI is busy right now. Please wait a few seconds and try again.' : 'The AI did not answer this time. Please try again.');
}

function patientPrompt() {
  const p = caseData.patient;
  return `You ARE ${p.name}, a ${p.age}-year-old ${p.sex} patient at a clinic visit. The person talking to you is your clinician (a nurse practitioner). They ask the questions. You answer about YOURSELF, in first person ("I", "my"), as the patient.

HOW TO ACT
- Personality: ${p.personality}
- You are the patient, not a clinician. Never diagnose yourself, never name a disease unless you are repeating something a doctor told you before, never give medical advice, never mention a scoring guide or that this is a simulation.
- Answer only what the clinician asks. Volunteer little. Open questions get fuller answers; yes/no questions get short answers.
- Use plain, everyday words. Keep each reply to 1 to 4 sentences, the way a real patient talks.
- If asked about something not in your facts, give a realistic, consistent answer that does not change the clinical picture, or say you're not sure.
- If the clinician says something unprofessional, react the way a real patient would.
- Never summarize or repeat back what the clinician said. Never ask the clinician about their symptoms or feelings. Never act as the doctor or nurse.
- If the clinician says something like "you are the patient", just carry on naturally as yourself.
- Plain spoken words only: no asterisks, no bold, no lists, no headings, no stage directions.
- Stay in character no matter what, until the visit ends.

YOUR OWN STORY (written about you; tell it in first person, and only the parts you are asked about)
${Object.entries(p.facts).map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`).join('\n')}`;
}

function feedbackPrompt(transcript) {
  const guide = caseData.scoring_guide.map((g, i) => `${i + 1}. ${g.item} (${g.points} pt${g.points > 1 ? 's' : ''})`).join('\n');
  return [{ role: 'system', content: `You are a nurse practitioner clinical instructor grading a student's history-taking with a simulated patient. Grade ONLY with the scoring guide below and ONLY on what the student actually said in the transcript. Be fair and specific. Quote the student's words as evidence when you award points.

SCORING GUIDE
${guide}

Write your answer in EXACTLY this plain-text format, nothing else:
SCORES
<item number>|<points awarded>|<short evidence: the student's words, or Not asked>
(one line for every item, 1 to ${caseData.scoring_guide.length}, in order)
STRENGTHS
- <one strength>
- <another strength>
IMPROVE
- <one thing to improve>
- <another thing to improve>
SUMMARY
<2 sentences of encouraging, honest feedback>` },
  { role: 'user', content: `TRANSCRIPT\n${transcript}` }];
}

function parseFeedback(text) {
  text = String(text);
  try { const m = text.match(/\{[\s\S]*\}/); const j = JSON.parse(m ? m[0] : text);
    if (Array.isArray(j.items) && j.items.length) return j; } catch {}
  const items = [], strengths = [], improve = []; let summary = '', sec = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*\*/g, '').trim(); if (!line) continue;
    const head = line.replace(/[:#]/g, '').trim().toUpperCase();
    if (['SCORES', 'STRENGTHS', 'IMPROVE', 'SUMMARY'].includes(head)) { sec = head; continue; }
    const m = line.match(/^(\d+)\s*[|.):-]\s*(\d+(?:\.\d+)?)\s*(?:\/\s*\d+)?\s*\|?\s*(.*)$/);
    if (m && (sec === 'SCORES' || sec === '')) { items[+m[1] - 1] = { points_awarded: +m[2], evidence: m[3].replace(/^["']|["']$/g, '') || 'Not asked' }; continue; }
    const bullet = line.replace(/^[-*•]\s*/, '');
    if (sec === 'STRENGTHS') strengths.push(bullet); else if (sec === 'IMPROVE') improve.push(bullet); else if (sec === 'SUMMARY') summary += (summary ? ' ' : '') + line;
  }
  const found = items.filter(Boolean).length;
  if (found < Math.ceil(caseData.scoring_guide.length / 2)) throw new Error('The AI scoring came back incomplete.');
  return { byNumber: true, items, strengths: strengths.slice(0, 4), improve: improve.slice(0, 4), summary };
}

export const config = { path: '/api/chat' };

export default async (req) => {
  if (req.method === 'GET') {
    const p = caseData.patient;
    return Response.json({ title: caseData.title, setting: caseData.setting, name: p.name, age: p.age, sex: p.sex, opening: p.opening_line });
  }
  try {
    const { mode, history = [] } = await req.json();
    const turns = history.filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
      .slice(-40).map(t => ({ role: t.role, content: t.content.slice(0, 2000) }));
    if (mode === 'patient') {
      const first = caseData.patient.name.split(' ')[0];
      // A short reminder on the latest question keeps weaker free models in character.
      const last = turns.length - 1;
      const msgs = turns.map((t, i) => i === last && t.role === 'user'
        ? { role: 'user', content: `${t.content}\n\n(Reply only as ${first}, the patient, in 1 to 4 plain spoken sentences.)` } : t);
      const looksLikePatient = t => !/^#|\bas an ai\b|language model|\bsimulation\b|scoring guide|\byou said you\b|does that match how you|\byour symptoms\b|\bas your (doctor|nurse|provider)\b/i.test(t) && t.length < 900;
      const reply = (await ask([{ role: 'system', content: patientPrompt() },
        { role: 'assistant', content: caseData.patient.opening_line }, ...msgs], { check: looksLikePatient }))
        .replace(/\(?\s*Reply only as [^)\n]*\)?\.?/gi, '').replace(/\*+/g, '').replace(/^\s*\(.*?\)\s*/, '').trim();
      const label = new RegExp(`^\\s*\\**\\s*(${first}|${caseData.patient.name}|Patient)\\s*\\**\\s*:\\s*\\**\\s*`, 'i');
      return Response.json({ reply: reply.replace(label, '') });
    }
    if (mode === 'feedback') {
      const transcript = [`Patient: ${caseData.patient.opening_line}`, ...turns.map(t => `${t.role === 'user' ? 'Student' : 'Patient'}: ${t.content}`)].join('\n');
      let result;
      let lastErr;
      const deadline = Date.now() + 36000; // one time budget for all tries (Netlify allows ~40s)
      for (let i = 0; i < 3 && !result && deadline - Date.now() > 8000; i++) {
        try { result = parseFeedback(await ask(feedbackPrompt(transcript), { json: true, skip: i, deadline })); }
        catch (e) { lastErr = e; if (/busy|key/i.test(e.message)) break; }
      }
      if (!result) throw new Error(lastErr && /busy|key/i.test(lastErr.message) ? lastErr.message : 'Scoring did not finish this time. Please click End visit again.');
      // Always grade against the guide itself, so points can never exceed what each item is worth.
      const got = Array.isArray(result.items) ? result.items : [];
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').slice(0, 28);
      const items = caseData.scoring_guide.map((g, i) => {
        const it = result.byNumber ? (got[i] || {}) : (got.find(x => norm(x.item) === norm(g.item)) || got[i] || {});
        return { item: g.item, possible: g.points, awarded: Math.max(0, Math.min(g.points, Math.round(+it.points_awarded || 0))), evidence: it.evidence || 'Not assessed' };
      });
      const total = items.reduce((a, b) => a + b.awarded, 0), max = caseData.scoring_guide.reduce((a, b) => a + b.points, 0);
      return Response.json({ items, total, max, strengths: result.strengths || [], improve: result.improve || [], summary: result.summary || '' });
    }
    return Response.json({ error: 'Unknown request' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
};

// Local testing only (MOCK_AI=1): canned answers so the page can be tested without AI access.
function mockReply(messages, json) {
  if (json) return 'Here is the grading.\n**SCORES**\n' + caseData.scoring_guide.map((g, i) => `${i + 1}|${i % 3 ? g.points : 0}|${i % 3 ? '"Tell me what brings you in today"' : 'Not asked'}`).join('\n') +
    '\nSTRENGTHS:\n- Warm, open start\nIMPROVE:\n- Ask about family history\nSUMMARY:\nSolid start. Cover family and social history next time.';
  const last = messages[messages.length - 1]?.content || '';
  return /thirst|water|drink/i.test(last) ? 'Yeah, I drink maybe ten or twelve glasses a day and I\'m still thirsty.' : 'It started maybe two months ago, and it\'s been slowly getting worse.';
}
