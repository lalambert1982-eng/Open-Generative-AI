# Creator Studio provider setup

Creator Studio is a private, Runway-inspired workspace that coordinates five specialist services:

| Tool | Provider | Required deployment variables |
|---|---|---|
| Creative assistant | Anthropic | `ANTHROPIC_API_KEY` |
| Image generation | OpenAI | `OPENAI_API_KEY` |
| Voice generation | ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| Avatar video | HeyGen | `HEYGEN_API_KEY`, `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID` |
| Cinematic video | Runway | `RUNWAY_API_KEY` |

All provider credentials are read only by the Next.js server. They are never sent to the browser, returned by the provider-status endpoint, or committed to the repository.

## Configure Vercel

1. Open the Vercel project.
2. Go to **Settings → Environment Variables**.
3. Add each provider variable from the table above. Select the Production, Preview, and Development targets where that provider should be available.
4. Add `CREATOR_STUDIO_ACCESS_KEY`. Generate a private value of at least 32 characters, for example:

   ```bash
   openssl rand -base64 48
   ```

5. Keep the access key in a password manager. Do not reuse a provider API key for it.
6. Redeploy the project after saving the variables.
7. Open `/studio/creator` and enter only `CREATOR_STUDIO_ACCESS_KEY` in the unlock screen.

Never paste an API key into a GitHub file, issue, pull request, build log, or browser-side `NEXT_PUBLIC_*` variable. Rotate a credential immediately if it was exposed in any of those places.

## Optional controls

The defaults are listed in `.env.example`:

- `CREATOR_STUDIO_RATE_LIMIT=5` limits each generation action per minute for the shared access key.
- `CREATOR_STUDIO_STATUS_RATE_LIMIT=120` permits provider task polling without relaxing generation limits.
- `CONTENT_SAFETY_MODE=enforce` blocks the built-in high-risk content classes before any paid provider call. `audit` and `off` remain explicit operator choices.
- `OPENAI_IMAGE_DEFAULT_QUALITY=low` keeps exploratory image calls less expensive; the UI can request medium or high quality.
- Provider model/version variables can be pinned without changing source code.

Rate limiting is an abuse guard, not a billing budget. Set spending limits and alerts in each provider account as well.

## Provider-specific notes

- An existing provider web subscription does not always include API usage. Confirm that each account has API access and an API balance before testing.
- ElevenLabs requires a reusable voice ID in addition to the API key.
- HeyGen requires an avatar ID and a voice ID. Its API billing can be separate from the HeyGen web-app plan.
- Runway video jobs are asynchronous. Creator Studio polls the task endpoint no more frequently than every five seconds and stops after about ten minutes.
- A Runway first-frame image must use a provider-reachable HTTPS URL. Direct local-file handoff is not part of this first version.

## Security model

- The browser sends the private Creator Studio access key only to same-origin `/api/creator/*` routes.
- Server routes use a constant-time comparison, per-action rate limiting, request-size limits, content safety, fixed upstream hosts, strict input validation, timeouts, no-store responses, and sanitized provider errors.
- Provider-status responses expose only configuration booleans and model labels—not credential values.
- The access key is stored in browser `sessionStorage`, so closing the tab removes it. The **Lock Creator Studio** button removes it immediately.
- This is a private shared-key gate, not multi-user identity. Add real account authentication and per-user authorization before opening the deployment to customers or collaborators.
