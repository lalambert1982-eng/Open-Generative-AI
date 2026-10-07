# Consolidation Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combine four unmerged branches onto `integration/consolidate-2026-10`, created from `origin/main` (4aea67a), with the test suite and build verified and opt-in defaults confirmed from code.

**Architecture:** This is an integration plan, not a feature build. Each unit is merged with `--no-ff` as its own merge commit, verified, and reviewed before the next unit. Conflict resolution is limited to trivial both-sides-added cases; anything larger stops the plan. No new product behavior is added. Default-state checks are the only new test code.

**Tech Stack:** Git worktrees and merges, Node.js `node --test`, Next.js build via npm scripts.

**Spec:** `docs/superpowers/specs/2026-10-05-consolidate-integration-design.md`

## Global Constraints

- Do not merge to `main`. Do not push to origin. Do not deploy. Do not change Vercel or env config.
- Do not enable paid generation. `MUAPI_ALLOW_PAID_GENERATION` stays off.
- `NVIDIA_IMAGE_ENABLED` defaults to `false`. NVIDIA is never the default `BRAIN_PROVIDER`.
- `CREATOR_RENDER_ENABLED` defaults to `false`.
- Default `BRAIN_PROVIDER` is `muapi-agent`, as set in `origin/main`'s `src/lib/brainRouter.js`.
- Do not delete existing worktrees or branches.
- Do not use bare `git stash`. Use a WIP commit if you need to set work aside.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Review Focus

1. `NVIDIA_IMAGE_ENABLED` unset, but `NVIDIA_API_KEY` set. Expected: NVIDIA image generation is off.
2. `BRAIN_PROVIDER=nvidia` with no `NVIDIA_API_KEY`. Expected: stops with an error. It must not fall back to a paid provider silently.
3. `CREATOR_RENDER_ENABLED` unset. Expected: `POST /projects/:id/render` refuses.
4. `BRAIN_PROVIDER` unset. Expected: resolves to `muapi-agent`, not `nvidia`.
5. `BRAIN_PROVIDER` set to an unknown id. Expected: rejected with a configuration error, not a silent default.

Each line above is pinned by a test in Task 6.

## Verification Commands (used by every task)

Run from `~/ogai-integration-2026-10`:

```bash
npm install
npm run test:security
npm run test:creator-shell
node --test tests/*.test.js
npm run build:packages
npm run build
```

Lint: `npm run lint` is included only if the Task 5 config runs cleanly non-interactively. Otherwise record it as blocked, with the exact prompt output.

---

### Task 1: Record the origin/main baseline

**Files:**
- Read only: `package.json`, `tests/security/`, `tests/*.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: baseline pass counts for every suite, used by Tasks 2–6 as the regression floor.

- [ ] **Step 1: Confirm the worktree is clean and on the right base**

Run: `git -C ~/ogai-integration-2026-10 status -sb && git -C ~/ogai-integration-2026-10 log --oneline -2`
Expected: branch `integration/consolidate-2026-10`, no uncommitted changes, HEAD is the spec commit `257edff` on top of `4aea67a`.

- [ ] **Step 2: Install dependencies**

Run: `cd ~/ogai-integration-2026-10 && npm install`
Expected: exits 0. If it fails, stop and report the error. Do not change `package.json`.

- [ ] **Step 3: Run the verification commands on the baseline**

Run each command from Verification Commands in order. Record for each: exit code, and the `# pass` / `# fail` lines from `node --test` output.
Expected: all pass. If a baseline suite fails, record it as a pre-existing failure and do not treat it as caused by later merges.

- [ ] **Step 4: Record the baseline in the final report**

Keep the counts in working notes. They are compared against Tasks 2–6.

- [ ] **Step 5: Commit**

Nothing to commit. Task 1 is read-only.

---

### Task 2: Merge unit 1, NVIDIA brain and image providers

**Files:**
- Merge: `feature/nvidia-image-provider` (tip `353bfb2`, includes `0970af3` and `df84525`)
- Possibly modified on conflict: `.env.example`

**Interfaces:**
- Consumes: baseline from Task 1.
- Produces: a merge commit on the integration branch. Later units rely on `.env.example` containing `NVIDIA_IMAGE_ENABLED=false`.

- [ ] **Step 1: Merge the unit**

Run: `git -C ~/ogai-integration-2026-10 merge --no-ff feature/nvidia-image-provider -m "Merge NVIDIA brain and image providers (opt-in)"`

- [ ] **Step 2: If `.env.example` conflicts**

Inspect with `git diff`. If both sides added different lines in the same block, keep both sets. Do not drop any `NVIDIA_*` or `BRAIN_*` variable. Then run `git add .env.example && git commit --no-edit`.
If the conflict is anything other than both-sides-added, run `git merge --abort` and stop. Report the conflict verbatim.

- [ ] **Step 3: Confirm the defaults in the merged tree**

Run: `grep -n -E 'NVIDIA_IMAGE_ENABLED|DEFAULT_BRAIN_PROVIDER' ~/ogai-integration-2026-10/.env.example ~/ogai-integration-2026-10/src/lib/brainRouter.js`
Expected: `NVIDIA_IMAGE_ENABLED=false`, and `DEFAULT_BRAIN_PROVIDER = 'muapi-agent'`. If either differs, stop and report.

- [ ] **Step 4: Run the verification commands**

Expected: every suite passes at or above the Task 1 baseline.

- [ ] **Step 5: Commit**

The merge commit from Step 1 (and any Step 2 conflict commit) is the commit for this unit. No extra commit is needed.

---

### Task 3: Merge unit 2, timeline compositor

**Files:**
- Merge: `feature/timeline-compositor` (tip `276fa9c`)

**Interfaces:**
- Consumes: Task 2 merge commit.
- Produces: `CREATOR_RENDER_ENABLED=false` in `.env.example`, and `POST /projects/:id/render` behind that flag.

- [ ] **Step 1: Merge the unit**

Run: `git -C ~/ogai-integration-2026-10 merge --no-ff feature/timeline-compositor -m "Merge v1 timeline compositor (gated by CREATOR_RENDER_ENABLED)"`

- [ ] **Step 2: Resolve conflicts, same rule as Task 2 Step 2**

- [ ] **Step 3: Confirm the render gate defaults off**

Run: `git -C ~/ogai-integration-2026-10 grep -n 'CREATOR_RENDER_ENABLED' -- src app components packages .env.example`
Expected: the flag is read in the render path and defaults to disabled. If the render route does not check the flag at all, stop and report.

- [ ] **Step 4: Run the verification commands**

- [ ] **Step 5: Commit**

The merge commit from Step 1 is the commit for this unit.

---

### Task 4: Merge unit 3, Graphic Studio Layout mode

**Files:**
- Merge: `feature/graphic-studio-layout-mode` (tip `789619d`)

**Interfaces:**
- Consumes: Task 3 merge commit.
- Produces: an additive Layout mode in Graphic Studio. No existing exports change.

- [ ] **Step 1: Merge the unit**

Run: `git -C ~/ogai-integration-2026-10 merge --no-ff feature/graphic-studio-layout-mode -m "Merge Graphic Studio Layout mode (recovered PR #11 editor)"`

- [ ] **Step 2: Resolve conflicts, same rule as Task 2 Step 2**

This unit is insertion-only, so a conflict here is unexpected. Stop on any conflict and report it.

- [ ] **Step 3: Confirm nothing was removed**

Run: `git -C ~/ogai-integration-2026-10 diff --numstat HEAD^1 HEAD`
Expected: the diff against the first parent shows no deletions from this unit's files.

- [ ] **Step 4: Run the verification commands**

- [ ] **Step 5: Commit**

The merge commit from Step 1 is the commit for this unit.

---

### Task 5: Merge unit 4, lint config and pinned workspace root

**Files:**
- Merge: `chore/lint-config-workspace-root` (tip `9cb6bed`)

**Interfaces:**
- Consumes: Task 4 merge commit.
- Produces: an ESLint flat config and a pinned Next.js workspace root. Later tasks may use `npm run lint`.

- [ ] **Step 1: Merge the unit**

Run: `git -C ~/ogai-integration-2026-10 merge --no-ff chore/lint-config-workspace-root -m "Merge ESLint flat config and pinned workspace root"`

- [ ] **Step 2: Resolve conflicts, same rule as Task 2 Step 2**

- [ ] **Step 3: Check whether lint runs non-interactively**

Run: `cd ~/ogai-integration-2026-10 && npm run lint < /dev/null`
Expected: runs without prompting. If it prompts or hangs, record `lint: blocked (interactive prompt)` and do not work around it.

- [ ] **Step 4: Run the verification commands**

- [ ] **Step 5: Commit**

The merge commit from Step 1 is the commit for this unit.

---

### Task 6: Final verification and default-state checks

**Files:**
- Create: `tests/integration/defaultState.test.js`

**Interfaces:**
- Consumes: the merged tree from Task 5.
- Produces: one test file pinning the five Review Focus lines. It is the only new code in this plan.

- [ ] **Step 1: Locate the functions the tests will call**

Run: `git -C ~/ogai-integration-2026-10 grep -n -E 'export (function|const) (resolveBrain|brainProviderOrder|getBrainProvider|parseBrainMaxAttempts)' -- src`
Use the exact exported names from the output. Do not guess names. If the brain resolution is not exported, stop and report which function a test would need to export. Do not add exports without reporting.

- [ ] **Step 2: Write the failing tests**

Create `tests/integration/defaultState.test.js` with one test per Review Focus line. Each test sets only the env vars it needs, calls the function located in Step 1, and asserts the expected result from Review Focus. Restore `process.env` in an `afterEach`.

- [ ] **Step 3: Run the new tests**

Run: `node --test tests/integration/defaultState.test.js`
Expected: PASS. If a test fails, the code does not match the design. Stop and report the failing line; do not change product code to make it pass.

- [ ] **Step 4: Run the full verification commands**

Expected: every suite passes at or above the Task 1 baseline, plus the new file.

- [ ] **Step 5: Commit**

```bash
git -C ~/ogai-integration-2026-10 add tests/integration/defaultState.test.js
git -C ~/ogai-integration-2026-10 commit -m "Pin opt-in defaults for consolidated integration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Report (after Task 6)

Report, without a push:
- Baseline counts (Task 1) and final counts (Task 6), per suite.
- Each merge commit SHA, and any conflict and how it was resolved.
- Results of each Review Focus line.
- Lint status.
- Anything stopped on, and why.
- The branch name and worktree path. Nothing pushed; nothing merged to `main`.
