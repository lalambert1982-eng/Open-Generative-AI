# Creator Studio Home and navigation

This document records the Phase 1 Creator Studio information-architecture candidate on `feature/storyboard-workspace`. It is a navigation and launch layer over existing components; it is not a replacement provider gateway, agent system, project database, asset backend, or compositor.

## State

| Capability | Built | Configured | Tested | Production ready |
| --- | --- | --- | --- | --- |
| Home prompt and quick-action launcher | Yes — branch candidate | No provider configuration required | Pure routing tests and build only | No — not deployed or live-tested |
| Selena navigation | Yes — routes to existing Agent Studio | Inherits existing Brain configuration | Existing security tests only | No new Selena E2E evidence in this patch |
| Create / Tool navigation | Yes — reuses existing studios | Inherits each existing provider | Navigation and compilation only | Provider-specific state remains unchanged |
| Graphics Studio | Yes — separate static-design branch candidate | No provider configuration required | 4/4 targeted tests, package/production builds, and local HTTP 200 | No — not deployed or visually live-tested in this patch |
| YouTube direct entry | Yes — opens the existing Creator Studio YouTube tool | Inherits existing Google OAuth configuration | Existing YouTube security tests | Live connection state remains deployment-specific |
| Projects | Navigation placeholder only | Not applicable | Not tested as persistence | No — persistence is not built |
| Assets | Navigation placeholder only | Not applicable | Not tested as persistence | No — persistence is not built |

## Navigation model

- **Home** presents the Selena prompt and quick actions.
- **Agent · Selena** opens the existing Agent Studio and Brain Router boundary.
- **Create / Tool** exposes Storyboard, Graphics Studio, Voice, Avatar, YouTube, and preserved legacy studios without duplicating their request logic.
- **Apps** groups existing guided experiences and specialist studios.
- **Workflows** opens the existing workflow implementation.
- **Projects** and **Assets** explicitly explain that durable persistence is a later phase.

Home intent matching is deterministic navigation. It does not call a reasoning provider, generate media, publish, spend credits, or imply that Selena completed work. Unknown requests route to the existing Agent Studio.

Image, Video, Storyboard, AI Generator, Scene Builder, Multi-Shot Video, and Music Video entry points should converge on the secure project workspace rather than fork new provider clients. YouTube opens the existing owner-authenticated publishing tool, which retains private staging, explicit per-upload approval, upload-only OAuth scope, and server-only credentials.

Graphics and design intent routes to the separate `/studio/graphics` workspace. It is a local-only static canvas documented in [`GRAPHICS_STUDIO.md`](./GRAPHICS_STUDIO.md). The preserved legacy Design Agent remains under Apps for compatibility; its browser-scoped generation path is not reused by the secure Graphics Studio.

## Preserved boundaries

- Creator Studio authentication, provider status, content safety, rate limits, request limits, timeouts, and polling remain unchanged.
- MuAPI, ElevenLabs, HeyGen, Brain Router, and YouTube integrations remain server-side.
- No environment variable, deployment configuration, billing flag, or Production value is changed by this UX layer.
- Storyboard scenes remain local React state.
- Projects and Assets do not claim persistence.
- Workflow transitions remain metadata until a real compositor renders them.
- Graphics Studio state and imported images remain browser-local until a secure asset/project persistence layer exists.
