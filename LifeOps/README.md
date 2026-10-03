# LifeOps

A schoolwork companion prototype for Round 3 of The Ken Case Competition: The Great Rewiring. LifeOps combines a continuing chat, voice transcripts and one task list. Theme, local tasks and settings work without an account. Student/guardian accounts, synced tasks and saved chat use optional Supabase configuration.

## Run locally

Requires Node.js 18 or later; there are no npm dependencies.

### Windows

Double-click `START_LIFEOPS.bat`. It opens the app in your browser and runs the local server in the same command window (no second console). Closing the last LifeOps browser tab stops the server after a 2-second reconnect grace period, and the command window closes automatically. If the browser is force-closed before it can notify the server, a heartbeat timeout stops it within about 12 seconds. Without Groq credentials, **See one scripted example** plays a fixed example; it does not support free-form chat.

### Configure live AI (optional)

Set `GROQ_API_KEY` and `GROQ_MODEL` in `.env`, save, and restart LifeOps. Without these values, only the clearly labeled scripted example works. The API key stays on the server and is never sent to the browser.

For every live request, LifeOps sends the latest 32 chat messages (up to 16 exchanges) and all active task titles/deadlines to Groq as context. Older chat messages remain visible but are not sent. Groq generates the reply, but a model can still overlook details; this guarantees the context is included in the request, not that every generated answer will use it correctly. This happens only when live Groq is configured and the student sends a live message; the scripted rehearsal sends no request to Groq. When signed in, chat and tasks are also stored in Supabase. **New chat** starts a separate conversation; **Delete this saved conversation** removes the current conversation from the signed-in account. Tasks can be created by hand or from chat-approved suggestions, edited, completed and removed. Voice input uses browser speech recognition where available, not Gnani. Email addresses, Indian mobile numbers, passwords, one-time codes, UPI PINs and card security codes are blocked before live chat is saved or sent; this is a basic safeguard, not a complete privacy filter.

## Supabase accounts and persistence

1. Create a Supabase project and apply `database/schema.sql` once in its SQL editor.
2. In Supabase Auth URL Configuration, set the Site URL to `http://localhost:4173` and add `http://localhost:4173/**` to the Redirect URLs allow list (or use your configured `PORT` instead).
3. Enable email confirmation in Supabase Auth.
4. Set `SUPABASE_URL` and the public `SUPABASE_ANON_KEY` in `.env`, then restart LifeOps.
5. Keep LifeOps running while you click the confirmation email. The confirmation link returns to `http://localhost:4173/`; if the local server is stopped, the browser will show “localhost refused to connect.” Start `START_LIFEOPS.bat` and sign in after confirmation.

If the schema was already run and LifeOps reports `permission denied for table tasks`, run this **permissions-only** block in the Supabase SQL Editor. It grants table-level access to authenticated accounts; the row-level security policies above still restrict access to each user's permitted rows. Do not rerun the complete schema just to repair these grants.

```sql
grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, update, delete on public.conversation_messages to authenticated;
grant select, insert, update on public.user_settings to authenticated;
grant select on public.guardian_invitations to authenticated;
grant select on public.guardian_links to authenticated;
grant select, insert, update on public.payment_requests to authenticated;
```

Do not put a service-role key in this app. Sign-up/sign-in use Supabase Auth through the local server. Provider access/refresh tokens stay in server memory; only a random HttpOnly, SameSite cookie is sent to the browser. Restarting the local server signs users out. Row-level security scopes tasks, conversations, payment requests, settings and guardian links to the signed-in account.

A student can create a one-time guardian invite code to share directly. The guardian signs in with that exact invited email and accepts the code. This verifies control of an email inbox—not legal guardianship. The prototype does not send invitation emails or verify a guardian's identity. Local tasks are not uploaded automatically when someone signs in.

## Payments and approval boundaries

Payment tasks can record an amount and UPI/card preference. Student payment requests require a verified guardian link and cannot exceed the configured per-request cap. A guardian can approve or decline the request in LifeOps. **Approval does not charge money.** A previous AgenticOrg view showed the `pinelabs_plural` connector, but the latest Overview showed “No tools configured” after tool-scope changes. The agent's current tool configuration is unknown and must be rechecked. This local Node prototype does not invoke AgenticOrg connector tools; a Pine Labs key in `.env` alone will not enable that path. Do not run the platform agent or enter real payment credentials until the documented flow is confirmed. Every student payment requires guardian approval; the limit never auto-approves or auto-charges.

Account settings let each signed-in user choose chat retention from 7 to 365 days (default 90). Expired chat messages are deleted when the app starts or the user signs in; this is not a scheduled background purge. Tasks remain until deleted. There is no complete account-deletion control in this prototype. Use synthetic data only.

## Prototype boundaries

- Approved tasks are stored in the task list; no reminders, calendar events or external messages are sent.
- Spoken replies use browser `speechSynthesis`; voice input uses browser speech recognition where supported. Neither is Gnani. The Gnani connector/API contract has not been supplied or integrated.
- Payment requests create a pending guardian-approval record only. Although the AgenticOrg Pine Labs connector is now present, this local app does not call it and no payment is made here; the platform tool schemas and safe test flow still need verification.
- The case-pack story and rehearsal transcript are templates/specimens, not a real recorded simulation. Replace them with the named participant's consented story and timestamps from a real run. Record the configured live run from first input to the outcome, include at least two different human inputs, keep the final clip under five minutes, and submit the model name, system prompt, trace and recording link.
- `public/evaluation-pack.json` contains ten proposed schoolwork evaluation cases and the observed failed Shadow-sample attempt. The cases are not marked as run; the Shadow attempt produced zero samples, and no full platform error trace is available.

## Integration status

- Groq OpenAI-compatible chat completions: `POST https://api.groq.com/openai/v1/chat/completions` — [API reference](https://console.groq.com/docs/api-reference#chat-create). Requires a server-side key and model ID.
- Supabase Auth, PostgREST and RLS paths are implemented; they require project keys and the SQL schema.
- The AgenticOrg Pine Labs connector/agent configuration is currently unknown: the latest Overview showed no tools configured. Its tool schemas and platform-agent payment flow are not verified. Gnani is not connected. The competition requires running the agent on AgenticOrg; this local prototype cannot invoke those platform connectors or claim those partner calls.

`.env` is ignored by Git. Never commit it or put provider keys in frontend code. Run syntax checks with `node --check server.js` and `node --check public/app.js`.
