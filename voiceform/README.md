# VoiceForm

Speak → live transcript → AI fills a form → send it to a person.
Single static file, no build step. Synthetic data only.

## Run

```bash
cd voiceform
python3 -m http.server 8000
```

Open http://localhost:8000 in Chrome or Edge (the microphone needs `localhost` or `https`).

1. Click **Settings**, choose Gemini or Claude, paste an API key (the key stays in this browser only).
2. Click **Start recording**, allow the microphone, and speak.
3. Click **Fill form with AI**. Green = filled by AI, yellow = not mentioned, so check it.
4. Send by email, copy as text, print or save as PDF, or download .txt.

## Notes

- Speech-to-text uses the browser's Web Speech API (Chrome, Edge, Safari). It needs internet.
- The AI is told to use only what was said and to leave other fields empty. The person always reviews before sending.
- Form fields are editable in the UI ("Edit form fields") and saved in the browser.
- Default fields are a generic early-intervention intake sheet, not a clinical instrument.
- For production the API key must move behind a server, and real patient data needs consent, encryption and EU/India data residency.
