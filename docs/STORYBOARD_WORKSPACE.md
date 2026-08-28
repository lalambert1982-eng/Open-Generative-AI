# Creator Studio Storyboard workspace

This document defines the first project-based Creator Studio UX pass. It records implementation state separately from deployment/provider state so a compiled interface is not mistaken for a live-tested production editor.

## Status vocabulary

| State | Meaning for this workspace |
|---|---|
| **Built** | Source exists locally, uses the existing authenticated Creator routes, and passes local compilation/automated checks. |
| **Configured** | The target deployment exposes a configured provider through the existing provider-status endpoint. No environment values are changed by this UI patch. |
| **Tested** | Retained evidence exists for the named test. Pure scene/request tests are not equivalent to a real provider generation. |
| **Production ready** | Built, configured, reviewed, merged, deployed, and successfully exercised end to end with security and release evidence. |

## Current phase status

| Capability | Built | Configured | Tested | Production ready |
|---|---|---|---|---|
| Project/scene workspace | Yes — integrated feature branch | No new configuration required | Automated scene/request and shell-handoff tests only | No — not deployed |
| Generate Still bridge | Yes — existing `POST /api/creator/image` | Inherits MuAPI status | Request-shape test only in this patch | No — Storyboard E2E pending |
| Text → Video bridge | Yes — existing `POST /api/creator/video` | Inherits MuAPI status | Request shape and server T2V-selection tests | No — Storyboard E2E pending |
| Image → Video bridge | Yes — existing `POST /api/creator/video` with `firstFrameUrl` | Inherits MuAPI status | First-frame request and server I2V-selection tests | No — Storyboard E2E pending |
| Scene transitions | UI metadata only | Not applicable | Scene-state test | No compositor; not rendered |
| Final export | Planned/disabled | Not applicable | Not tested | No |
| Graphic Studio | Yes — reuses CreativeCanvas, ImageStudio/DrawModal, and LayersStudio | Legacy BYOK required pending secure migration | Compile/source integration tests only | No |

No deployment, Production environment edit, paid-generation activation, or provider request is part of this patch.

## Reused architecture

`CreatorStudio.jsx` remains the browser integration boundary. Storyboard calls one `runProjectMedia()` bridge in that component, which reuses:

- the authenticated `request()` function;
- `responseError()` sanitization;
- `generationTokenRef` cancellation semantics;
- `pollTask()` and its bounded polling schedule;
- the existing `/api/creator/image`, `/api/creator/video`, and `/api/creator/muapi/status` routes.

The existing gateway, MuAPI provider, GitHub owner authentication, same-origin checks, content safety, rate limits, request limits, timeouts, and server-only credentials remain unchanged.

## Scene model and behavior

Phase 1 keeps scenes in local React state. A scene contains an ID, title, prompt, image/video URLs, duration, aspect ratio, transition, status, and returned model metadata. Persistence, collaboration, version history, and server-side project storage are intentionally deferred.

The workspace supports:

- add, select, duplicate, and delete scene;
- edit title, prompt, aspect ratio, duration, and transition metadata;
- preview a scene video, otherwise its image, otherwise an empty canvas;
- display generated scene images/videos in the local asset panel;
- generate a still;
- generate video directly from text;
- animate the selected scene image;
- copy the previous scene image into the current scene without generating;
- show per-scene working and error states.

The local asset panel does not reuse `DrawModal.jsx`'s browser-key upload/generation path. No secure Creator Studio upload route currently provides a provider-reachable first-frame URL, so Upload is explicitly disabled/planned rather than creating a second backend.

## AI Engine: Auto

The UI never sends a provider model override:

```text
Generate Still
  → POST /api/creator/image
  → server-selected MUAPI_IMAGE_MODEL

Generate Video with no scene image
  → POST /api/creator/video without firstFrameUrl
  → server-selected MUAPI_VIDEO_MODEL (T2V; currently Seedance by default)

Animate Image
  → POST /api/creator/video with the scene image as firstFrameUrl
  → server-selected MUAPI_IMAGE_TO_VIDEO_MODEL (I2V; currently Kling by default)
```

Runway remains a preserved, deferred server adapter. A future Auto/Kling/Seedance/Runway override must extend the existing gateway safely; it must not add browser credentials or a second provider dispatch implementation.

## Future Design mode

Design mode should reuse interaction concepts from `DrawModal.jsx`, including pointer selection, pencil, eraser, rectangles, arrows, text, inserted images, canvas objects, undo, and redo. It should not reuse the legacy direct `muapi.js` browser-key generation call.

A safe implementation sequence is:

1. Extract provider-independent canvas document/history operations into pure modules.
2. Add a `Storyboard | Design` mode switch with Design backed by that document model.
3. Reuse generated Storyboard assets as inserted Design objects.
4. Route every Design AI generation/edit through authenticated Creator Studio server routes.
5. Add a secure asset-ingestion boundary only after storage, validation, ownership, retention, and provider-reachable URL policy are defined.
6. Add persistence and export only after the document format is versioned and tested.

## Future compositor/timeline

The current storyboard orders scenes and records transition intent; it does not render a final program. A future compositor should use a versioned project manifest with references to immutable owned assets and then process:

```text
ordered scene clips
  → trims / splits / scene timing
  → rendered transitions
  → voice-over and music tracks
  → captions
  → text and graphic overlays
  → final render job
  → validated downloadable export
```

The compositor needs real media probing, codec/frame-rate normalization, timeline validation, background render jobs, bounded polling, progress, cancellation, failure recovery, storage cleanup, and export authorization. Transition controls must remain labeled metadata-only until this pipeline produces retained output evidence.

## Separate provider issue

Voice stays available through `POST /api/creator/speech`. An ElevenLabs `401`/`403` is a server credential/permission problem and is not addressed by the Storyboard UI change. The key must remain server-only.
