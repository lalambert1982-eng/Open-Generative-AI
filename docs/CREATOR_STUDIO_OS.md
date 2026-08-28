# G.FURY Creator Studio operating system

This document records the integrated shell implemented on `feature/integrated-creator-shell`. It separates source existence from configuration and real provider evidence. No deployment, Production change, paid generation, or social post is part of this branch.

## Product hierarchy

Creator Studio is the shell. Selena is the primary agent identity. Provider brains and execution APIs remain infrastructure beneath it.

```text
User
  → Selena
  → POST /api/creator/assistant
  → Brain Router (Gemini, bounded fallbacks)
  → plan / recommendation
  → explicit tool or workflow action
  → validation / approval
  → existing provider adapter
```

The shell now organizes working destinations as:

- **Home:** intent-first Selena prompt and working quick actions.
- **Agent:** Selena, using the secure Creator assistant route without agent creation.
- **Tools:** secure Image, Video, Voice, and Avatar plus preserved legacy Music, Advanced Video, Lip Sync, Motion Graphics, Transform, and Smart Clip.
- **Apps:** AI Generator, AI Influencer, Graphic Studio, Scene Builder, Marketing Studio, and Edit Studio.
- **Workflows:** the existing MuAPI workflow list, playground, and builder.
- **Assets:** browser-session generated URLs with working Scene Builder and Lip Sync handoffs.
- **Publish:** the existing direct private YouTube workflow.
- **Advanced:** Agent Blueprints, Marketplace/Developer Templates, and legacy provider settings.

Projects are intentionally absent from primary navigation because `main` has no durable Project source of truth. A cosmetic empty page would misrepresent product state. Music Video is likewise not presented as a complete App until a real end-to-end builder exists.

## Reused architecture

| Capability | Reused implementation |
|---|---|
| Selena reasoning | `CreatorStudio.jsx` → `POST /api/creator/assistant` → `handleBrainAssistant()` → `reasonWithBrain()` |
| Image/video generation | Existing Creator gateway, `muapiCreatorProvider.js`, shared request/polling functions |
| Storyboard | Existing feature commit and `StoryboardWorkspace.jsx`; local scene state |
| Graphic Studio | Wrapper around `DesignAgentStudio`/`CreativeCanvas`, `ImageStudio`/`DrawModal`, and `LayersStudio` |
| Workflow | Existing `WorkflowStudio`, `WorkflowUI`, and MuAPI workflow functions |
| Agent Blueprints | Existing `AgentStudio` and generic MuAPI Agent endpoints |
| Video utilities | Existing Lip Sync, Vibe Motion, Recast, Clipping, Video, and Cinema components |
| YouTube | Existing direct OAuth, private Blob staging, encrypted token storage, approval gate, and forced-private publishing |

## Selena boundary

Selena owns the conversational identity and project intent. Brain providers return normalized reasoning only. A plan or tool call does not itself spend money, publish, schedule, delete, or perform another external side effect. Existing same-origin, owner-auth, content-safety, rate-limit, timeout, and provider-error controls remain in force.

The current Selena workspace has in-memory conversation history and Home-to-Selena prompt handoff. Attachments, durable conversations, durable project context, approval cards, and structured orchestration are **not yet built** in this shell pass.

## Agent Blueprints

`AgentStudio` is preserved and renamed in navigation as **Advanced → Agent Blueprints**. Its templates, agents, chats, create flow, and conversations remain the generic MuAPI Agent product. Studio use now supplies `/studio/advanced/agents` as its base path so create/chat/back transitions stay inside the shell. Standalone `/agents/*` pages remain available and unchanged.

## Graphic Studio and CreativeCanvas

Graphic Studio is a consolidation wrapper, not a new editor. It exposes:

1. **Creative Canvas:** existing conversational sessions, assets, uploads, canvas state, generation jobs, and asset-aware edits.
2. **Generate & Edit:** existing image generation/upload plus `DrawModal` pencil, eraser, rectangles, arrows, text, inserted images, undo, redo, and export concepts.
3. **Layers:** existing layer decomposition and composition workspace.

Security limitation: `DesignAgentStudio` still copies the session-scoped BYOK credential into `localStorage.token` while CreativeCanvas is active because CreativeCanvas reads a Bearer token from that location. Cleanup remains in place on exit. This is a known legacy compatibility boundary, not the preferred Creator security model. Migration should add a Creator-authenticated server adapter to CreativeCanvas, then remove browser token compatibility without rewriting the canvas.

## Storyboard and Auto routing

Storyboard remains distinct from Workflow. Scene transitions are metadata only; no compositor renders them.

```text
Generate Still → /api/creator/image → MUAPI_IMAGE_MODEL
Generate Video without image → /api/creator/video (no firstFrameUrl) → MUAPI_VIDEO_MODEL
Animate Image → /api/creator/video (firstFrameUrl) → MUAPI_IMAGE_TO_VIDEO_MODEL
```

The browser cannot select provider keys or arbitrary model IDs. The UI reports **AI Engine: Auto**.

## Assets and projects

The shell records successful HTTPS generation outputs in `sessionStorage` for the current browser session. An image can enter Scene Builder as its first frame without copying a URL; image/video assets can populate Lip Sync without re-uploading. This is a working handoff, but it is not a durable multi-device Asset service.

A future Project source of truth should own conversations, assets, storyboard manifests, workflow references, outputs, and publish drafts. It needs explicit ownership, versioning, retention, deletion, and storage rules before implementation.

## Publish and current social API verification

The direct YouTube implementation remains the only built Studio publishing path. It requires per-upload approval and forces private visibility.

MuAPI's official Social Publishing documentation was checked on 2026-08-27. It documents current REST endpoints for account listing, per-platform connect URLs, Instagram publishing, TikTok publishing, and prediction polling. It also documents multiple accounts. Those endpoints are **verified but not implemented in this branch** because publishing costs money and needs a separate secure server adapter, review UI, connection lifecycle, and mocked security tests.

The official REST page does not document `scheduled_at`, scheduled-post listing, cancellation, or updates. MuAPI's MCP page advertises those operations only for CLI stdio. Creator Studio therefore must not invent REST scheduling. Scheduling remains **not available** until an official usable REST/OpenAPI contract is verified.

Future Instagram/TikTok implementation must use:

```text
Browser
  → Creator-authenticated same-origin route
  → server-only MuAPI social credential
  → validated account + public HTTPS media URL
  → review screen
  → explicit approval
  → async publish + confirmed provider status
```

## Provider and feature status

| Area | Built | Configured | Tested | Production ready |
|---|---|---|---|---|
| Integrated shell/navigation | Yes, feature branch | No provider change required | Automated source/routes + production build | No; not deployed or browser-smoked |
| Selena secure reasoning UI | Yes | Inherits Brain status | Route/security tests; no new live reasoning request | No |
| Agent Blueprints role/routes | Yes | Requires legacy BYOK for MuAPI data | Automated route tests | No live create/chat test |
| Graphic Studio wrapper | Yes | Requires legacy BYOK | Compile/source integration tests | No live editor E2E |
| Storyboard | Yes | Inherits MuAPI status | Pure state/request/routing tests | No live Storyboard generation on this branch |
| Workflow | Preserved | Requires legacy BYOK | Production build only in this pass | Not claimed |
| Browser-session Assets | Yes | No new environment | Automated handoff checks | No durable asset service |
| YouTube | Preserved | Environment-specific | Existing security tests; no live publish | No new claim |
| Instagram | No; official REST contract verified | Not configured | Not tested | No |
| TikTok | No; official REST contract verified | Not configured | Not tested | No |
| Social scheduling | No REST contract verified | No | No | No |
| MuAPI media | Existing | Environment-specific | Existing retained evidence; no paid request here | Sandbox scope only where configured |
| Runway | Adapter preserved/deferred | Key optional | No paid test | No |
| ElevenLabs | Secure route preserved | Credential currently returns 401/403 | Failed provider evidence, not success | No |
| HeyGen | Secure route preserved | Environment-specific | No request in this pass | No new claim |

## MuAPI environment reconciliation

Current source in `muapiConfiguration()` is authoritative:

- `MUAPI_KEY_MODE=sandbox` selects `MUAPI_API_KEY`.
- `MUAPI_KEY_MODE=production` selects `MUAPI_PRODUCTION_API_KEY`.
- Production mode fails closed unless `MUAPI_ALLOW_PAID_GENERATION=true`.
- Model selection remains server-side through `MUAPI_IMAGE_MODEL`, `MUAPI_VIDEO_MODEL`, and `MUAPI_IMAGE_TO_VIDEO_MODEL`.

This branch does not alter any environment value. It does not enable paid generation.

## Next architecture increments

1. Add durable Project/Asset storage with ownership and retention.
2. Migrate CreativeCanvas authentication to the Creator gateway and remove browser token compatibility.
3. Add a Creator orchestrator contract for structured Selena plans and explicit approval cards.
4. Implement mocked and security-reviewed MuAPI Instagram/TikTok routes, then connection UI and review-only publish drafts.
5. Verify an official REST scheduling schema before adding scheduling.
6. Build a compositor only after defining a versioned timeline manifest, media normalization, render jobs, storage, cancellation, and export authorization.

