# Graphics Studio Phase 1

Graphics Studio is a separate static-design workspace inspired by Canva's focused canvas, element library, layers list, and inspector layout. It is intentionally separate from Storyboard because its job is to create still graphics—not scenes, animation, voice, publishing, or final video composition.

## Audit and reuse decision

The repository already contains useful editor concepts in `DrawModal.jsx`, `LayersStudio.jsx`, and the legacy Design Agent: text, shapes, inserted images, canvas objects, layer ordering, undo/redo, and export-oriented interactions. Those concepts informed this workspace.

Their legacy AI paths were not reused because they depend on browser-scoped bring-your-own-key behavior. Graphics Studio has no provider request, API key prop, provider credential, or hidden AI generation path. Future AI-assisted graphics must call an authenticated Creator Studio server route and retain the existing safety, rate-limit, timeout, and error-sanitization boundaries.

## State

| Capability | Built | Configured | Tested | Production ready |
| --- | --- | --- | --- | --- |
| Separate `/studio/graphics` workspace | Yes — branch candidate | No provider configuration required | 4/4 targeted tests, package/production builds, and local HTTP 200 | No — not deployed or visually live-tested in this patch |
| Static text and shapes | Yes | Local React state | Pure model tests | No retained browser E2E evidence yet |
| Local PNG/JPEG/WebP placement | Yes — 8 MB limit | Browser-local only | Source/build checks only | No retained browser E2E evidence yet |
| Layers, drag placement, inspector, duplicate/delete/order | Yes | Local React state | Pure model tests where applicable | No retained browser E2E evidence yet |
| Square, portrait, story, and landscape formats | Yes | Fixed presets | Pure geometry test | No retained browser E2E evidence yet |
| PNG export | Yes — client-side export | No provider or upload required | Source/build checks only | No retained download evidence yet |
| Cloud save, shared assets, collaboration, templates | No | Not applicable | Not tested | No |
| AI image/edit generation | No | Not applicable | Not tested | No |

## Phase 1 capabilities

- G.FURY starter design using black, crimson, metallic gold, and high-contrast white.
- Editable design title, canvas background, text content, font size/weight, object color, opacity, position, and dimensions.
- Heading, body text, rectangle, circle, and local image elements.
- Layer selection, forward/backward ordering, duplication, deletion, drag positioning, undo, and redo.
- Static output presets: 1080×1080, 1080×1350, 1080×1920, and 1920×1080.
- Client-side PNG export with editor-only selection controls removed from the output.

All state is ephemeral. Refreshing the page resets the graphic. Local images are read into the active browser session and are not uploaded or presented as saved assets.

## Future Graphics Studio plan

1. Add tested resize handles, rotation, alignment guides, snapping, grouping, crop controls, richer typography, and reusable templates.
2. Add secure project and asset persistence after ownership, quotas, retention, and deletion behavior are designed.
3. Add a server-authenticated AI image/edit action by reusing Creator Studio routes or a deliberately extended provider gateway; never restore the old browser API-key path.
4. Add brand kits, reusable logos, social-size variants, background removal, and collaboration only after persistence and authorization exist.

Graphics Studio remains a still-design product. Storyboard owns scene generation and video continuity; a future compositor owns timed video/audio/caption/overlay assembly and final rendering.
