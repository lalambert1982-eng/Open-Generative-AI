# Run Creator Studio locally

Use Node 24 and npm. Replicate mock mode is the default: it produces placeholders without a Replicate token or provider call. **Normal persisted app use still requires GitHub OAuth and two Vercel Blob stores.** The isolated fixtures below use fake sessions and stores instead.

## Normal owner-authenticated app

1. From the repository root, run `npm ci` on Node 24. No submodule or separate workspace build step is required.
2. Copy the example environment file:

   ```sh
   cp .env.example .env.local
   ```

3. Configure a GitHub OAuth application for local development. Use `http://127.0.0.1:3000` as the app origin and register the exact callback `http://127.0.0.1:3000/api/auth/github/callback`. The auth validator accepts HTTP loopback callbacks at `127.0.0.1` in development; use that same origin in the browser. If the port changes, update both callback registrations before signing in.
4. Set the following server variables in `.env.local`. Obtain your own values; the example defaults are not credentials or an authorized owner configuration.

   | Variable | Required value |
   | --- | --- |
   | `GITHUB_OAUTH_CLIENT_ID` | Local OAuth application client ID |
   | `GITHUB_OAUTH_CLIENT_SECRET` | Local OAuth application secret |
   | `GITHUB_OAUTH_CALLBACK_URL` | Exact callback above |
   | `CREATOR_SESSION_SECRET` | Independent random secret of at least 32 characters; generate with `openssl rand -base64 48` |
   | `CREATOR_GITHUB_ALLOWED_USER_IDS` | Your immutable numeric GitHub user ID (recommended) |
   | `CREATOR_GITHUB_ALLOWED_LOGINS` | Your GitHub login; remove the example owner's login |
   | `BLOB_READ_WRITE_TOKEN` | Token for a **private** Blob store for Projects, job/spend records, and publishing records |
   | `CREATOR_ASSET_BLOB_READ_WRITE_TOKEN` | Token for a separate **public** Blob store for generated/uploaded media |

   At least one owner allowlist must be set. If both are set, both must match. Use both Blob store tokens even in mock mode; persistence still performs real storage operations. Uploading to the public media store makes those media URLs public. See [security configuration](SECURITY_CONFIGURATION.md) before using sensitive material.
5. Leave `GENERATION_MODE` unset or `mock`, keep `REPLICATE_LIVE_ENABLED=false`, and leave `REPLICATE_API_TOKEN` empty. Leave optional provider credentials empty for this Replicate-only check. Replicate mock mode does not mock Selena, MuAPI, voice, avatar, rendering, or publishing.
6. Run `npm run dev`, open `http://127.0.0.1:3000/studio`, sign in, and create/select a Project. In Image or Video, choose Replicate, enter a prompt, and Generate. The result is saved as an Asset on its originating Project. Image is a placeholder; Video is a PNG graphic, not playable video.

Provider keys belong only in server configuration. MuAPI remains selectable, but its Sandbox still calls the external provider and requires a server key; it is not this credential-free fixture path.

## Credential-free HTTP smoke

With dependencies installed, run:

```sh
node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs
```

The smoke has 11 checks. It uses actual Creator route dispatch/handlers with fabricated signed sessions, injected provider responses, and in-memory private/public Blob stores; external fetches are blocked. It does not exercise Next middleware, real GitHub OAuth, real Blob, or browser UI. No `.env.local` credentials are needed. Node's module-mocking flag is experimental, and a sandbox may require permission to listen on localhost.

## Credential-free browser fixture

Use a checkout without real `.env.local` credentials. Start the isolated API fixture in one terminal:

```sh
node --experimental-test-module-mocks scripts/replicate-ui-fixture-server.mjs
```

In a second terminal:

```sh
CREATOR_UI_FIXTURE_ORIGIN=http://127.0.0.1:4010 \
CREATOR_SESSION_SECRET=creator-ui-fixture-session-secret-over-thirty-two-characters \
CREATOR_GITHUB_ALLOWED_USER_IDS=12345678,87654321 \
CREATOR_GITHUB_ALLOWED_LOGINS=fixture-owner,other-owner \
npm run dev -- -H 127.0.0.1
```

Open `http://127.0.0.1:3000/api/creator/__fixture/login` using the actual Next port. That local fixture URL issues a fabricated session and redirects to Studio. The dev-only rewrite proxies `/api/creator/*` to the fixture; it is disabled in production. `/api/auth/session` and logout still run in Next, so the fabricated signing secret and allowlists above must match the fixture to authenticate the recovery controller. These literal values are test-only fixtures, not real credentials. Fake private/public stores disappear when the fixture restarts. Exercise Projects and Replicate Image/Video only: this fixture does not mock every retained provider or publishing route. `GET http://127.0.0.1:4010/api/creator/__fixture/stats` shows create/status traffic and blocked outbound fetches.

For a job that stays pending long enough to test recovery, enable the fixture hold before generating:

```sh
curl -X POST http://127.0.0.1:4010/api/creator/__fixture/control -H 'Content-Type: application/json' -d '{"action":"hold"}'
```

Generate, navigate to Home and back, then reload the same tab. The job should recover through status without a second create. Read its `jobId` from the Image/Video pointer in the browser's session-storage inspector. To complete or discard the fixture job, POST `{"action":"release","jobId":"<saved job ID>"}` or `{"action":"missing","jobId":"<saved job ID>"}` to the same control endpoint. After `missing`, reload; the recovery pointer is cleared, but generation stays locked with a billing-uncertainty warning until you explicitly acknowledge it. A missing record does not prove that no generation occurred. Sign out and confirm both kinds of recovery and uncertainty markers are gone. These are fixture controls, not production API endpoints.

## Recovery limits and verification

Image and Video retain separate pointers named `ogai.replicate.activeJob.v1.image` and `.video`. They store only `{ v, jobId, projectId, userId, ts }`. Recovery requires the same signed-in owner, the same tab's storage, a valid server record, and a pointer no more than 30 minutes old. Storage denial is handled without breaking generation, but recovery across reload cannot be guaranteed when storage is unavailable. Terminal status, a 404, confirmed session loss, and sign-out clear recovery pointers. Default mock jobs often finish immediately, so use the hold fixture for a navigation/reload check.

Unknown submissions also retain a minimal marker under `ogai.replicate.uncertain.v1.image` or `.video`, using the same identity-only fields and validation; `jobId` may be null when the server has not returned one. This preserves the duplicate-generation lock across navigation/reload until a terminal result or explicit acknowledgment. A resumed 404 preserves uncertainty even though its recovery pointer is cleared. Prompts, credentials, input media, and quote tokens are never stored in either marker. A failed or malformed session check preserves markers and blocks generation until identity can be verified; it is not treated as confirmed logout. Unknown submissions and accepted jobs whose record cannot be confirmed do not promise automatic recovery; do not resubmit them blindly.

The fixture walkthrough above is a reproducible check, not a claim that the current branch's final browser pass is complete. The controller records actual results in [the cleanup/resume verification handoff](superpowers/handoff/2026-10-10-cleanup-and-resume-verification.md). This rebuild has not been merged or deployed, and no live provider, paid generation, real OAuth/Blob, or Preview verification is claimed by this guide.
