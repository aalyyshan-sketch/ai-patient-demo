// AI patient simulation - Netlify Edge Function (allows ~40s for the AI to answer)
// The case file (and its hidden facts and scoring guide) stays on the server,
// so students can't read the answers from the browser.
import caseData from './case-linda-carter.js';

const env = k => (globalThis.Netlify?.env?.get(k)) ?? (typeof process !== 'undefined' ? process.env[k] : undefined);
const KEY = env('OPENROUTER_API_KEY') || '';
const MOCK = env('MOCK_AI') === '1';
const PREFER = [/deepseek.*(chat|v3)/i, /llama-3\.3-70b/i, /qwen.*(72b|235b|32b)/i, /gemma-3-27b/i, /mistral-small/i, /llama/i, /gemma/i];

let modelCache = { at: 0, list: [] };
async function freeModels() {
  if (Date.now() - modelCache.at < 3600e3 && modelCache.list.length) return modelCache.list;
  const r = await fetch('https://openrouter.ai/api/v1/models');
  const all = ((await r.json()).data || []).filter(m => m.id.endsWith(':free') && +m.pricing?.prompt === 0 &&
    (m.architecture?.output_modalities || ['text']).includes('text'));
  const ranked = [];
  for (const re of PREFER) for (const m of all) if (re.test(m.id) && !ranked.includes(m.id)) ranked.push(m.id);
  for (const m of all) if (!ranked.includes(m.id)) ranked.push(m.id);
  // "Thinking" models are slow and add hidden reasoning to replies, so try them last.
  const slow = id => /(^|[-/])r1|think|reason/i.test(id);
  ranked.sort((x, y) => slow(x) - slow(y));
  modelCache = { at: Date.now(), list: ranked.slice(0, 6) };
  return modelCache.list;
}

async function ask(messages, { json = false, skip = 0, deadline = Date.now() + 34000 } = {}) {
  if (MOCK) return mockReply(messages, json);
  if (!KEY) throw new Error('The AI key is not set yet (OPENROUTER_API_KEY).');
  const all = await freeModels();
  const models = [...all.slice(skip % all.length), ...all.slice(0, skip % all.length)];
  let lastErr = 'No free AI model is available right now.';
  for (const model of models) { // if a free model is busy, try the next one
    const left = deadline - Date.now();
    if (left < 4000) break;
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'AI Patient Demo' },
        body: JSON.stringify({ model, messages, temperature: json ? 0.2 : 0.7, max_tokens: json ? 1400 : 300 }),
        signal: AbortSignal.timeout(Math.min(json ? 30000 : 18000, left)),
      });
      const j = await r.json().catch(() => ({}));
      const text = String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
      if (r.ok && text) return text;
      lastErr = j.error?.message || `Model busy (${r.status})`;
      // Account-wide free plan limit: other models would fail too, and failed tries still count, so stop here.
      if (r.status === 429 && /free-models-per|per-day|per-min/i.test(lastErr)) break;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(/rate limit|429/i.test(lastErr) ? 'The free AI is busy right now. Please wait a few seconds and try again.' : lastErr);
}

function patientPrompt() {
  const p = caseData.patient;
  return `You are role-playing a patient in a nurse practitioner training simulation. Stay fully in character as ${p.name}, ${p.age}-year-old ${p.sex}.

HOW TO ACT
- Personality: ${p.personality}
- You are the patient, not a clinician. Never diagnose yourself, never name a disease unless you are repeating something a doctor told you before, never give medical advice, never mention a scoring guide or that this is a simulation.
- Answer only what the student asks. Volunteer little. Open questions get fuller answers; yes/no questions get short answers.
- Use plain, everyday words. Keep each reply to 1 to 4 sentences, the way a real patient talks.
- If asked about something not in your facts, give a realistic, consistent answer that does not change the clinical picture, or say you're not sure.
- If the student says something unprofessional, react the way a real patient would.
- Stay in character no matter what, until the visit ends.

YOUR PRIVATE FACTS (reveal only when asked)
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
      const reply = await ask([{ role: 'system', content: patientPrompt() },
        { role: 'assistant', content: caseData.patient.opening_line }, ...turns]);
      const first = caseData.patient.name.split(' ')[0];
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
