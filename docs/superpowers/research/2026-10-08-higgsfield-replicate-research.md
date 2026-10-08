# Research report: Higgsfield-inspired creator studio on Replicate (as of 2026-10-08)

## Method and caveats (read first)
- WebFetch/WebSearch were unavailable (model error) and the Replicate MCP returned 401 (no token in MCP env). Everything below was fetched read-only with curl from public pages: higgsfield.ai HTML, replicate.com collection pages (Accept: text/markdown), replicate.com/<owner>/<name>/api (embedded OpenAPI Input/Output schema, `replicate:is_official` meta tag, billingConfig), and replicate.com/docs/*.md. No predictions/trainings/models were created, no spend.
- Schema field names below are copied from each model's live page schema (latest version at fetch time). Prices are the page's billingConfig strings; units are NOT always stated (e.g. flux-schnell shows "$3" = per 1000 images by "333 images for $1"; real-esrgan "$2" = per 1000). Treat all prices as approximate and re-check before billing users. Latency is NOT stated on model pages; "not verified" unless a collection page says so.
- Sources: https://higgsfield.ai , https://higgsfield.ai/cinematic-video-generator , https://replicate.com/collections/{text-to-image,text-to-video,image-to-video,image-editing,super-resolution,remove-backgrounds,lipsync,video-editing} , https://replicate.com/<owner>/<name>/api for each model named , https://replicate.com/docs/reference/http , https://replicate.com/docs/topics/predictions/{create-a-prediction,lifecycle,data-retention,rate-limits,input-files} , https://replicate.com/docs/topics/webhooks/{verify-webhook,receive-webhook} , https://github.com/replicate/getting-started-nextjs .

---
## A. Higgsfield public feature areas (functionality only)
Source: https://higgsfield.ai (home nav + sections) and https://higgsfield.ai/cinematic-video-generator.
Top-level nav areas: Explore, Image, Video, Audio, MCP, API, AI Influencer, ChatGPT Plugin, Genjutsu, Ads Studio, Effects, Cinema Studio, Contests, Marketing Studio, Supercomputer (agent), 3D (new), Edit, Academy, Community, Plugins, Canvas, Originals, Pricing, Enterprise.

| Area | What it does / how users interact |
|---|---|
| Cinema Studio (v4 per page) | Director-style workspace. Pick genre (6: General, Action, Epic, Drama, Comedy, Horror); camera movement as `#` tags typed in the prompt or picked from a library, several stacked per shot and run in order; tempo control; era selector (scrub decades to regrade film look); color grading (temperature, contrast, presets); up to 50 reference assets per generation; per-shot model choice (multi-model engine incl. Seedance); build scene (locations, props); AI Cast (define actor: genre, era, archetype, physique, outfit); per-character emotion; project brief; sub-foldering of scenes/versions; real-time multi-user co-direction; embedded canvas; an assistant that picks camera/light/prompt and breaks scripts into shots. |
| Effects | Library of motion/VFX presets (e.g. cards labeled floating, flip, melting, world morphing...) each with a "Recreate" button: user uploads their own image/subject, preset applies. "View all presets" browse. |
| Genjutsu (video-to-video) | Transfer motion from a source video into new characters/locations/products, or swap specific elements while keeping the rest; one-click restyle of a video. |
| AI Influencer / character | Pick the look, add motion, build a persistent virtual creator; Elements (reusable characters/props shared across a team). |
| Ads Studio / Marketing Studio | Recreate an existing ad with your own product/characters ("Ad Multiplier"), static ad generation, product visuals. |
| Image models | Hosts third-party models (e.g. a Nano Banana variant, up to 14 references into one 4K image per the home page); Edit tool; Canvas (shared board for references/rough cuts). |
| Video models | Multi-model (Seedance etc.), image-to-video, start/end frame is implied by industry norm but NOT confirmed on the fetched pages (unverified). |
| Platform | Community feed, "Recreate/see all prompts and assets of a project" public projects, MCP server/ChatGPT plugin, API. |

---
## B. Replicate models per need
All listed are `is_official=true` (stable, call `POST /v1/models/{owner}/{name}/predictions`, no version pin) unless marked COMMUNITY. Output "URL" = single string URI; "array" = array of URIs. Prices = page strings (unit stated where the page showed it).

### B1. Text-to-image
| Model | Key inputs (exact) | Output | Price (page) | Notes |
|---|---|---|---|---|
| black-forest-labs/flux-2-pro | prompt*, aspect_ratio (incl. match_input_image, custom), width/height 256-2048, resolution (0.5 MP..4 MP), input_images[], seed, output_format, output_quality, safety_tolerance(1-5) | URL | $0.015 flat on page (unit/MP-dependence not verified) | Also does multi-reference edit. |
| black-forest-labs/flux-schnell | prompt*, aspect_ratio, num_outputs(1-4), megapixels, go_fast, seed, output_format, output_quality, num_inference_steps(1-4), disable_safety_checker | array | ~$3 per 1000 images ("333 images for $1") | Cheapest/fast draft tier; used by the Next.js starter. Latency not verified. |
| google/nano-banana-2 | prompt*, image_input[], aspect_ratio (13 values), resolution 1K/2K/4K, output_format, google_search, image_search | URL | $0.067 (1K) / $0.101 (2K) / $0.151 (4K) | Also edit + multi-ref. |
| ideogram-ai/ideogram-v3-turbo | prompt*, aspect_ratio, resolution, style_type, style_preset, style_reference_images[], magic_prompt_option, image+mask (inpaint), seed | URL | $0.03 | Good for text-in-image/posters. |
| openai/gpt-image-2 | prompt*, quality, aspect_ratio, background(transparent), input_images[], number_of_images, output_format, **openai_api_key** (field present; page implies user-supplied key - verify before use) | array | $0.012 low / $0.047 med / $0.128 high | |
Also available: recraft-ai/recraft-v4.1 (prompt*, size, aspect_ratio; URL; $0.04), bytedance/seedream-5-lite, bytedance/seedream-4.5, google/imagen-4 (collection https://replicate.com/collections/text-to-image).

### B2. Image-to-image / editing
| Model | Key inputs | Output | Price |
|---|---|---|---|
| google/nano-banana-pro | prompt*, image_input[] (up to 14 per collection text), aspect_ratio, resolution 1K/2K/4K, output_format, safety_filter_level, allow_fallback_model | URL | $0.15 (1K/2K), $0.30 (4K) |
| black-forest-labs/flux-kontext-pro | prompt*, input_image, aspect_ratio, output_format, safety_tolerance(0-6), prompt_upsampling, seed | URL | $0.04 |
| black-forest-labs/flux-2-max | prompt*, input_images[] (multi-ref identity), aspect_ratio, resolution, width/height, output_format | URL | $0.04 |
| qwen/qwen-image-edit-plus | prompt*, image* (array), aspect_ratio, go_fast, output_format | array | $0.03 |
| Inpaint/outpaint/erase: black-forest-labs/flux-fill-pro (image*, mask, prompt*, outpaint enum, steps, guidance) $0.05; bria/eraser (image, mask, mask_type) $0.04 | | | |
Also bytedance/seedream-4.5 (image_input[], max_images 1-15; array; $0.04).

### B3. Text-to-video and B4. Image-to-video (incl. first/last frame)
| Model | Key inputs (exact) | First/last frame | Output | Price (page) |
|---|---|---|---|---|
| google/veo-3.1 | prompt*, image, last_frame, reference_images[], duration enum 4/6/8, resolution 720p/1080p, aspect_ratio 16:9/9:16, generate_audio, negative_prompt, seed | image + last_frame | URL (mp4) | $0.40/s with audio, $0.20/s without |
| google/veo-3.1-fast | same minus reference_images | image + last_frame | URL | $0.15/s audio, $0.10/s no audio |
| kwaivgi/kling-v3-video | prompt*, start_image, end_image, duration 3-15, mode standard/pro/4k, aspect_ratio 16:9/9:16/1:1, generate_audio, negative_prompt, multi_prompt (string, multi-shot up to 6 scenes per collection text) | start_image + end_image | URL | $0.168-0.336/s depending on mode/audio; 4k $0.42/s |
| bytedance/seedance-2.0 | prompt*, image, last_frame_image, reference_images[] (up to 9), reference_videos[] (3), reference_audios[] (3), duration (-1..15), resolution 480p-4k, aspect_ratio (incl. adaptive, 21:9), generate_audio, seed | image + last_frame_image | URL | 480p $0.08-0.10/s, 720p $0.18-0.22/s, 1080p $0.45-0.55/s, 4k $1-1.25/s |
| bytedance/seedance-1.5-pro | prompt*, image, last_frame_image, duration 2-12, resolution 480p-1080p, aspect_ratio, camera_fixed (REAL camera param), generate_audio, fps | yes | URL | $0.013-0.12/s |
| runwayml/gen-4.5 | prompt*, image, duration 5/10, aspect_ratio, seed | no last frame field | URL | $0.12/s |
| vidu/q3-pro | prompt*, start_image, end_image, duration 1-16, resolution 540p-1080p, aspect_ratio, audio | yes | URL | $0.07-0.16/s |
| luma/ray-3.2 | prompt*, start_image, end_image, duration 5/10, resolution, aspect_ratio, loop, hdr, exr_export | yes | URL | $0.15-3.60 per clip tiered (unit per video) |
| minimax/hailuo-2.3 | prompt*, first_frame_image, duration 6/10, resolution 768p/1080p, prompt_optimizer | first only | URL | $0.28-0.56 (768p), $0.49 (1080p) per video |
| wan-video/wan-2.7-t2v / -i2v | t2v: prompt*, audio, duration 2-15, resolution, aspect_ratio, negative_prompt; i2v: first_frame, last_frame, first_clip, audio | yes (i2v) | URL | $0.10-0.15/s |
| xai/grok-imagine-video | prompt*, image, video, duration 1-15, resolution 480p/720p, aspect_ratio | n/a | URL | $0.05/s; collection says ~30 s generation |
| prunaai/p-video | prompt*, image, last_frame_image, audio, duration 1-20, resolution, aspect_ratio, draft, fps | yes | URL | $0.005-0.04/s (tiered, cheap draft tier) |
Latency: video is minutes class; not stated on pages (not verified except Grok ~30 s). Other cheaper options: bytedance/seedance-2.0-fast (same schema, 480p/720p only), veo-3.1-lite (t2v). Older/likely superseded: veo-2/3, kling v2.x, hailuo-02, wan 2.1/2.2, minimax video-01*, luma ray-2*, zeroscope/animate-diff/cogvideox community models: treat as legacy.

### B5. Video-to-video / transformation
| Model | Inputs | Notes |
|---|---|---|
| luma/modify-video | video, prompt, mode (adhere_1..3, flex_1..3, reimagine_1..3), first_frame | Restyle; price ~$0.019 per page-stated unit (unit unclear, not verified). |
| kwaivgi/kling-v3-omni-video | reference_video, video_reference_type feature/base, reference_images[], start/end_image, keep_original_sound | Edit/style/camera transfer; $0.168-0.42/s. |
| wan-video/wan-2.7-videoedit | video*, prompt*, reference_image, duration, resolution, audio_setting | $0.10/s. |
| bytedance/seedance-2.0 reference_videos[] | motion transfer | see above |
| prunaai/p-video-animate, xai/grok-imagine-video-extension (video extend) | not schema-checked | |

### B6. Lip sync (later)
sync/lipsync-2-pro (audio*, video*, sync_mode, temperature, active_speaker; $0.083 per page-stated unit); heygen/lipsync-speed (audio*, video*; ~$0.033); kwaivgi/kling-lip-sync (video_url, audio_file or text+voice_id; $0.014); veed/fabric-1.0 (image* + audio* talking image; 480p $0.08 / 720p $0.15 per sec presumed - unit not verified). All official, output URL.

### B7. Character consistency / reference-image models (later)
- Reference-image inputs: google/nano-banana-pro (`image_input[]` up to 14), black-forest-labs/flux-2-max (`input_images[]`, up to 8 refs per collection text), bytedance/seedream-4.5 (`image_input[]`), veo-3.1 (`reference_images[]` up to 3), kling-v3-omni-video / seedance-2.0 (`reference_images[]`).
- Fine-tuned identity: LoRA training (e.g. community ostris/flux-dev-lora-trainer, shown in https://replicate.com/llms.txt with a version hash; community = needs `version`; training creates trainings which I did not exercise). Higher cost/complexity: BUILD LATER.
- Elements/AI Cast equivalent must be built app-side (stored reference images + prompt prefix).

### B8. Background removal / upscale (optional)
bria/remove-background (image; $0.018; URL), recraft-ai/recraft-crisp-upscale (image*; ~$0.006/img by "166 images for $1"), google/upscaler (image*, upscale_factor x2/x4; $0.02), nightmareai/real-esrgan (image*, scale, face_enhance; ~$0.002/img), lucataco/real-esrgan-video (community per owner; schema not checked).

---
## C. Replicate API facts for the adapter
(source: https://replicate.com/docs/reference/http unless noted)
- Create: `POST https://api.replicate.com/v1/predictions` body `{version, input, webhook, webhook_events_filter, stream}`. Official models: `POST /v1/models/{model_owner}/{model_name}/predictions` body `{input, webhook, ...}` (no version). Community models need `version` (64-hex id) on /v1/predictions (or owner/name:version in client).
- Get: `GET /v1/predictions/{id}`; list: `GET /v1/predictions`; cancel: `POST /v1/predictions/{id}/cancel` (urls.cancel is returned in the object).
- Headers: `Prefer: wait` (default 60 s, `wait=n` 1-60 s; returns incomplete prediction if not done) ; `Cancel-After` (5 s - 24 h, e.g. `1m30s`; before start status becomes `aborted`, after start `canceled`) (https://replicate.com/docs/topics/predictions/create-a-prediction, /lifecycle).
- Statuses: starting, processing, succeeded, failed, canceled, aborted (https://replicate.com/docs/topics/predictions/lifecycle). Adapter should treat succeeded/failed/canceled/aborted as terminal. The playground docs enum also lists only the first five in the model schema; aborted is from lifecycle docs. Predictions time out after 30 min.
- Output retention: for API predictions, inputs, outputs, output files and logs are removed after 1 hour by default (https://replicate.com/docs/topics/predictions/data-retention). Adapter MUST copy outputs to own storage (e.g. Vercel Blob/S3) on completion.
- Input files: HTTP URL, data URL (recommend <=256 kB per http reference; input-files doc says base64 only for <1 MB), or Blob/File/Buffer uploaded by the JS client up to 100 MB (https://replicate.com/docs/topics/predictions/input-files).
- Webhooks: `webhook` URL + `webhook_events_filter` in ["start","output","logs","completed"]; output/logs throttled to 500 ms; terminal webhook retried with exponential backoff, last retry ~1 min after completion; intermediate states not retried; handlers must be idempotent (https://replicate.com/docs/topics/webhooks/receive-webhook). Signature (standard-webhooks style, https://replicate.com/docs/topics/webhooks/verify-webhook): headers `webhook-id`, `webhook-timestamp` (seconds), `webhook-signature` (space-delimited `v1,<base64>` list). Signed content = `${webhook_id}.${webhook_timestamp}.${rawBody}`; HMAC-SHA256 with key = base64-decoded part of secret after `whsec_`; compare constant-time against any signature in the header after stripping `v1,`; check timestamp tolerance for replay. Secret: `GET /v1/webhooks/default/secret` -> `{"key":"whsec_..."}` (MCP tool get_default_webhooks_secret; I did NOT call it so no secret was exposed). The JS client exports `validateWebhook(request, secret)`.
- Idempotency: NO idempotency-key header is documented for prediction creation (grep of the HTTP reference found none) -> adapter must dedupe itself (store our job id, create prediction once, persist replicate id before returning). Webhook delivery is at-least-once, so dedupe on `webhook-id` / prediction id + status.
- Rate limits: 600 req/min create-prediction; 3000 req/min other endpoints; bursts allowed; stricter near zero credit; 1 rps / 6 per min if credit granted without payment method; 429 body `{"detail":"Request was throttled. Your rate limit resets in ~30s."}` (https://replicate.com/docs/topics/predictions/rate-limits).
- npm client: `import Replicate, { validateWebhook } from 'replicate'`; `new Replicate({auth: process.env.REPLICATE_API_TOKEN})`; `replicate.predictions.create({model:'owner/name', input, webhook, webhook_events_filter})` (model field for official models), `replicate.predictions.get(id)`, `replicate.predictions.cancel(id)`. In recent versions `replicate.run` returns FileOutput objects (not verified here); simplest: use predictions.create and read `output` URLs.
- getting-started-nextjs patterns (https://github.com/replicate/getting-started-nextjs): App Router route handlers `app/api/predictions/route.js` (POST create) and `[id]/route.js` (GET poll), `app/api/webhooks/route.js` (validateWebhook with `REPLICATE_WEBHOOK_SIGNING_SECRET`, 401 on invalid, comment that handler must be idempotent). Worth adapting: override `replicate.fetch` with `cache:'no-store'` to defeat Next fetch caching; webhook host = `VERCEL_URL` in prod / ngrok in dev; `webhook_events_filter: ["start","completed"]`; server-only token. Do not copy: no persistence, no auth, client polls directly, fixed model.

---
## D. Capability matrix (9 modules)
| Module | What Replicate supports today | Real model params | Prompt-only guidance | Verdict |
|---|---|---|---|---|
| Home | Gallery/recent of our own outputs; no Replicate dependency beyond stored results | n/a | Preset prompt gallery | BUILD NOW |
| Image Studio | T2I (flux-2-pro, flux-schnell, nano-banana-2, ideogram-v3-turbo) | aspect_ratio, resolution, num_outputs/number_of_images, output_format, seed, style_preset (ideogram), reference images | Style/lighting words | BUILD NOW |
| Video Studio | T2V + I2V + first/last frame (veo-3.1, kling-v3-video, seedance-2.0, vidu q3-pro, wan 2.7) | duration, resolution, aspect_ratio, generate_audio, image/start_image, last_frame/end_image, negative_prompt, seed | Motion description | BUILD NOW (async + webhook + copy-out) |
| Projects/Assets | App-side only (DB + blob storage); required because outputs expire in 1 h | n/a | n/a | BUILD NOW (must be built before generation is useful) |
| Cinema Studio | Model-driven: genre/era/color grade are prompt text. Real controls only: seedance-1.5-pro `camera_fixed`, kling `multi_prompt` (multi-shot), `mode`, start/end frames, reference images, `loop` (ray-3.2). No exposed pan/zoom/lens/dolly parameter found on any inspected schema | camera_fixed, multi_prompt, start/end image, reference_images, duration | Camera move tags, lens, genre, era, grading -> compile into prompt (app-side tag library like `#dolly-in` expands to text) | PROMPT-ONLY for camera/lens; BUILD NOW as prompt-template UI over Video Studio |
| Effects Studio | No preset-effect models. Emulate via prompt templates + I2V; luma/modify-video and kling-v3-omni for video-to-video restyle | image/video input, mode (modify-video) | Effect description presets | PROMPT-ONLY (templates) now; BUILD LATER for v2v |
| Character Studio | Reference-image consistency (nano-banana-pro 14 refs, flux-2-max, seedream, veo reference_images, kling omni/seedance refs); LoRA training possible; lip sync later | reference/input_images arrays | Identity description prefix | BUILD LATER (ref-image version is feasible early; LoRA/lipsync later) |
| Marketing Studio | Product shots via flux-2-max/flux-kontext/nano-banana edit with product image; bria remove-background; upscalers; ad variants by templating prompts | image inputs, aspect_ratio, background (gpt-image-2) | Ad copy/layout language | BUILD LATER (BUILD NOW feasible for simple product-on-scene) |
| Canvas/Edit Studio | Edit: flux-kontext-pro, nano-banana, qwen-image-edit-plus; inpaint/outpaint flux-fill-pro, bria eraser/genfill; bg removal; upscale | image, mask, outpaint, prompt | Edit instruction | BUILD NOW for single-image edit; free-form multi-user canvas UI is app-side, BUILD LATER. Realtime co-edit NOT SUPPORTED by Replicate. |
Not supported: native camera/lens parameter controls, preset effect library, real-time collaboration, on-platform assistants (all app-side).

## Deprecation flags
Older families (veo-2/3, kling v2.x, hailuo-02, video-01*, luma ray-2*, wan 2.1/2.2, sdxl-era community models, flux-1.1-pro in favor of flux-2-*) look superseded per current collection lists; no explicit deprecation notice was seen. Model names in this report may churn quickly (several latest versions dated 2026-04 to 2026-09); re-read schemas at adapter build time and cache them.
