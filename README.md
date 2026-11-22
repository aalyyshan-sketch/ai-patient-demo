# AI Patient Demo

A practice encounter with a fictional AI patient. The student takes a history by text or voice. The patient stays in character until the student clicks "End visit", then the visit is scored against a scoring guide.

- Page: `public/index.html`
- AI server code: `netlify/edge-functions/chat/index.js`
- Patient case and scoring guide: `netlify/edge-functions/chat/case-linda-carter.js`

## Deploy on Netlify
1. Upload this folder to a GitHub repository.
2. On Netlify, choose Add new site → Import an existing project → GitHub, then pick the repository. Leave the build settings as they are and deploy.
3. In Site configuration → Environment variables, add `OPENROUTER_API_KEY` with your OpenRouter key, then go to Deploys and choose Trigger deploy → Deploy site.

Voice input works in Chrome and Edge. Typing works everywhere.
