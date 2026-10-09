# Replicate Creator Studio UI: mocked browser verification (2026-10-09)

Branch `rebuild/creator-studio-replicate`, fixture commit `53080fd`. Everything ran against the in-memory mocked fixture
(`GENERATION_MODE=mock`, fabricated credentials, no Replicate/Blob/GitHub/MuAPI calls). No product code was modified.

## Commands

```bash
node --experimental-test-module-mocks scripts/replicate-ui-fixture-server.mjs        # fixture on 127.0.0.1:4010
CREATOR_UI_FIXTURE_ORIGIN=http://127.0.0.1:4010 npm run dev -- -H 127.0.0.1           # Next 15.5.23 on http://127.0.0.1:3000
"/Applications/Google Chrome 3.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 \
  --user-data-dir=<fresh temp dir> --no-first-run --disable-gpu about:blank
# driven over CDP by a throwaway Node 24 script (WebSocket + fetch), kept outside the repo
# sign in: GET http://127.0.0.1:3000/api/creator/__fixture/login  (302 -> /studio, creator_session cookie)
kill -USR2 <fixture pid>   # prints outbound-fetch count
```

Actual Next URL: `http://127.0.0.1:3000` (an unrelated pre-existing `next-server` v16 was listening on `*:3000` over IPv6; the
`127.0.0.1:3000` IPv4 bind reached our server, confirmed by the fixture's 401 on `/api/creator/replicate/models`). Asset URL form:
`https://creator.public.blob.vercel-storage.com/creator-assets/<project>/replicate-mock_<id>.png` (fixture fallback form).
The run used a freshly restarted fixture (empty state). Screenshots: `.superpowers/sdd/2026-10-09-replicate-creator-ui/shots/` (git-ignored).

## Results

| # | Item | Result | Evidence |
|---|------|--------|----------|
| 1 | Image page defaults and Project gating | PASS | Radio `Replicate` aria-checked=true; badge "Mock · no paid generation"; `#replicate-model` has 5 options, default `black-forest-labs/flux-2-pro`; `#replicate-prompt` and `#replicate-aspect_ratio` present; with no Project Generate `disabled` and text "Open a Project to generate." / "Open a Project to save results." Project created through the `/studio/projects` UI (New Project, name "Verify Project", Create); after returning, "Results are saved to Verify Project." Shots 01, 02, 03. See observation A. |
| 2 | Mock image, single click | PASS | One POST `/api/creator/replicate/generate`. Result text: "Mock placeholder — nothing was generated or charged. Saved to Project · Asset 8d617a9d-be2b-4853-83d8-29589f2e3c43 Download"; `<img src>` and Download `href` = the blob URL above; 0 `<video>`. `/studio/assets` went 0 to 1 article; after `location.reload()` the same single Asset (same title and src) listed. Shots 04, 05. |
| 3 | Rapid double click | PASS | `b.click(); b.click()` in one `Runtime.evaluate`, new prompt: 1 generate POST; Assets 1 to 2 (exactly one new). |
| 4 | Video defaults and mock result | PASS | First option `google/veo-3.1-fast` selected (3 models: Veo 3.1 Fast, Kling v3, Seedance 1.5 Pro; duration 6, aspect 16:9). Generate completed with no over-cap banner. Result had `<img>` placeholder with the mock label, `<video>` count 0. The numeric cap value was not read from the UI (no price panel is shown before confirm); "within cap" is inferred from the job completing without a cap error. Shot 06. |
| 5 | Provider selector | PASS | `role=radiogroup` present. Clicking MuAPI: radio checked flips; Replicate wrapper `div[hidden]` set, `#replicate-prompt` still in DOM (`offsetParent===null`); existing studio content rendered ("Sign in to Creator Studio / Continue with GitHub", see note B). Back to Replicate: wrapper not hidden, prompt value "values-should-persist" retained. Shot 07. The disabled-while-running branch (`busy`) was not exercised (mock jobs complete instantly). |
| 6 | Keyboard and live regions | PASS | Tab order from model: `replicate-model`, `replicate-prompt`, `replicate-aspect_ratio`, Generate button. Enter on focused Generate: 1 generate POST; Space: 1 generate POST. `aria-live="polite"` region present. `role=alert` rendered on error: empty-prompt submit shows "alert: Fix the highlighted settings before generating." with `aria-invalid` on `#replicate-prompt` and "Required." (shot 11); sign-out case also shows `role=alert`. |
| 7 | Mobile 375px | PASS | CDP `setDeviceMetricsOverride` 375x812: image and video pages `scrollWidth`=375, `innerWidth`=375, body 375, no overflowing elements; Generate button spans x 20 to 267. Shots 08-mobile-image/video. |
| 8 | Home | PASS | "Recent in this Project" shows 4 Assets (most recent first: echo, delta, charlie, bravo; limit of 4 of 5 Assets), each with `<img>` src; "Featured models" shows FLUX 2 Pro, FLUX Schnell, Nano Banana 2, FLUX Kontext Pro. Typing in the Selena textarea and clicking "Ask Selena" navigated to `/studio/selena`. Shot 09. |
| 9 | Sign-out | PASS | `Network.deleteCookies creator_session`; Generate (still enabled) clicked: first request `POST /api/creator/replicate/quote` returned 401; UI shows `role=alert` "Your session ended. Sign in again to continue; nothing was carried over."; Generate then `disabled`; no result figure, no Cancel/Check status, aria-live empty; 0 generate POSTs sent. Shot 10. |
| 10 | Network | PASS | Non-localhost requests in the main run: 13, all to `creator.public.blob.vercel-storage.com` (preview images). Nothing to replicate.com, api.replicate.com, or muapi hosts. Fixture `SIGUSR2`: `outbound-fetch-blocked=0 stubCalls=0`. See limitation 2. |

## Observations (not failures)

- A. With a Project open and an empty prompt, Generate is enabled (not disabled). Clicking it makes no request and shows the inline
  "Required." field error plus the alert "Fix the highlighted settings before generating." The brief says "enabled once prompt is typed";
  behaviour is validate-on-submit instead. Accessible and harmless, but differs from the wording of the checklist.
- B. MuAPI side shows a "Sign in to Creator Studio ... session authentication is not configured securely" panel because the fixture does not
  provide GitHub/NextAuth config; `GET /api/auth/session` returns 503 (pre-existing, unrelated to the new components).
- C. `StandaloneShell` renders `<CreatorMediaStudio ... onJobSettled>` without `onAuthLost` (components/StandaloneShell.js lines 514-515). The
  sign-out flow still worked because the controller shows the session-ended banner itself; any shell-level reaction to `onAuthLost` (if intended) is not wired. Not verified as a defect.

## Console findings (Runtime.consoleAPICalled / Log.entryAdded / exceptions)

- No React key warnings, hydration errors, act/hook warnings, or uncaught exceptions on the studio pages.
- `Failed to load resource ... 400` for `https://creator.public.blob.vercel-storage.com/...` images (13): expected, the fixture's fabricated blob URLs do not exist. Relates to the fixture, not the components.
- `GET /api/auth/session` 503 (4): pre-existing, unrelated (MuAPI studio / auth not configured).
- `GET /favicon.ico` 404: pre-existing, unrelated.
- `POST /api/creator/replicate/quote` 401 (1): the intended sign-out test.
- React DevTools info message: noise. Next dev server also logged "Several Konva instances detected" (pre-existing, unrelated).

## Not verified / limitations

1. Headless Chrome driven over CDP, not a full interactive browser; no real touch, screen reader, or throttled network. Mobile check is viewport emulation only.
2. Preview images could not load (blob host URLs are fabricated), so previews were verified by DOM `src`/`href`. The browser still issued real
   requests to that Vercel Blob host and got 400; those are browser image fetches triggered by the fixture's URL form, not credentialed or paid calls.
3. Provider selector disabled-during-running-job and Cancel/Check status/confirm (paid quote) paths were not exercised: mock jobs complete immediately.
4. Per-job cap value not displayed in the UI, so the video cap check is by absence of a cap error.
5. Fixture state is in memory; the first partial run (before the final clean run) was discarded. An unrelated `next-server` was left running on `*:3000` (IPv6) and was not touched.
6. Stopped at the end: Chrome, fixture (pid started by me), and the dev server I started; ports 4010 and 9333 are free.

## Additional limitations (final review)

- Navigating away from Image/Video in-app (or a page reload / `kind` change) while a job is running or uncertain tears down the on-screen controller. The job still completes server-side and its Asset is saved to the Project, but the jobId, progress, and the "uncertain, acknowledge first" lock are lost on return; only the server's 60-second duplicate lock then protects against a second paid create. Fixing this needs lifting the controller to the shell or persisting the jobId in sessionStorage, which is beyond the approved spec.
- Live-mode confirm, Cancel, Check status, and provider-lock-during-running were covered only by unit tests, not by the browser run.
- `onAuthLost` is not wired from the shell (the studio shows the session-ended banner itself).
- Preview `<img>` requests hit creator.public.blob.vercel-storage.com in the fixture run. Run the dev server with `-H 127.0.0.1` for fixture runs.
