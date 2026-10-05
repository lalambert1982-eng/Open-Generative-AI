# Consolidation Integration: Design

Date: 2026-10-05
Status: Draft for review. No merges performed.

## Goal

Combine four unmerged, locally-built branches onto one integration branch created from `origin/main` (4aea67a), with tests and build verified. Nothing reaches `main` or Production in this work.

## Scope

In scope:
- Create `integration/consolidate-2026-10` from `origin/main` in a dedicated worktree.
- Merge four units in review order, one commit per unit.
- Run the verification suite and record results.
- Confirm default-off behavior for every opt-in feature.

Out of scope:
- Merging to `main`, deploying, pushing to origin (pending a separate decision), changing Vercel or env config, enabling paid generation, deleting existing worktrees or branches.

## Units

`feature/nvidia-image-provider` already contains `consolidate/optional-nvidia-provider`, so the units are:

1. **NVIDIA brain and image providers** (`feature/nvidia-image-provider`, tip `353bfb2`, includes `0970af3` and `df84525`). Opt-in via NVIDIA settings; image generation gated by `NVIDIA_IMAGE_ENABLED`. Also adds an explicit paid opt-in before Selena's brain uses the MuAPI Production key.
2. **Timeline compositor** (`feature/timeline-compositor`, tip `276fa9c`). Adds `creatorCompositor.js`, `renderCreatorTimeline`, `POST /projects/:id/render`. Gated by `CREATOR_RENDER_ENABLED`.
3. **Graphic Studio Layout mode** (`feature/graphic-studio-layout-mode`, tip `789619d`). Adds the canvas graphics editor as a Layout mode. Additive only (4 files, insertions only).
4. **Lint config and pinned workspace root** (`chore/lint-config-workspace-root`, tip `9cb6bed`).

## Conflict Evidence

Checked read-only with `git merge-tree --write-tree`:
- Each unit merges cleanly onto `origin/main`.
- Each unit pair merges cleanly.
- An earlier scratch test applied the consolidate tree and then `feature/nvidia-image-provider` on top, and conflicted in `.env.example`. This is likely an artifact of that test, since the image branch already contains the consolidate commits. It is not yet confirmed. The real merge in step 1 must resolve it or prove it is an artifact, and the result is reported either way.

## Order

Review order, not a conflict-driven order: 1, 2, 3, 4. Each unit gets a merge commit so any unit can be reverted alone.

## Verification

Run in the integration worktree after each unit merge, and again after all four:
- `npm install`
- `npm run test:security`
- `npm run test:creator-shell`
- `node --test tests/*.test.js`
- `npm run build:packages`
- `npm run build`

Lint runs only if the unit 4 config executes cleanly. Otherwise it is reported as blocked.

Previously recorded counts (229 security, 25 creator-shell, 46 top-level) are claims from an earlier pass. They are not treated as expected values until this run confirms them.

## Default-State Checks

Before the work is reported as done, the review must confirm from code, not notes:
- NVIDIA brain is not the primary provider unless explicitly configured.
- NVIDIA image generation is off without `NVIDIA_IMAGE_ENABLED`.
- Paid MuAPI generation stays off without its explicit gate.
- `CREATOR_RENDER_ENABLED` defaults to off.
- The fail-closed test for missing primary configuration still exists and passes.

## Stop Conditions

Stop and report, without fixing, if:
- A merge conflict appears that is not a trivial, both-sides-added case.
- A default-off check fails.
- A test regresses from the origin/main baseline.

## Known Production Gap (not fixed here)

Per the 2026-10-02 notes, Production has `BRAIN_PROVIDER=gemini` but no `GEMINI_API_KEY`, so Selena returns 503. Any later merge to `main` will auto-deploy and must account for this first.

## Open Items

- Whether to push the integration branch to origin after verification. Default: keep local.
- Whether the stray `~/package-lock.json` (root-owned, empty) is removed. Not part of this work.
