# Kadai — build status (paused)

Paused at the user's request on 2026-10-21 ~04:45 UTC, during the **module build** stage.
Everything is saved in git; nothing depends on the old container.

## Stages

| Stage | Status |
|---|---|
| 1. Architecture, API surface, product docs, DB schema (`docs/`, `apps/server/migrations/0001–0010`) | ✅ done |
| 2. Foundation: shared domain library, server core, posting services, auth, web shell, deploy/CI | ✅ done (1,197 tests at the time) |
| 3. On-prem-first pivot: vendor licensing schema (0010), editions, PRODUCT.md, ARCHITECTURE §21 | ✅ done |
| 4. API contracts for all 13 modules + shared pickers + typed route registration | ✅ done (2,452 tests, commit `d5e83e8`) |
| 5. Module build (backend ∥ frontend per module, then review) | ⏸ **paused — partially done** |
| 6. Merge modules into the integration branch, one by one, with full checks | not started |
| 7. Harden: E2E per vertical (on-prem first), demo seed, perf, 7 audits, fixes, release docs | not started |

## Module build status (updated 2026-10-21 21:35 UTC)

Each module is built on its own branch `mod/<key>`, all saved in
`tools/build-orchestration/module-branches.bundle` (some are also on `origin`). WIP commits are
unreviewed partial work; a reviewer agent finishes, verifies and commits each module. The bundle
also holds `wip/<key>` refs: snapshots of uncommitted worktree changes taken while agents run
(restore with `git checkout -B mod/<key> wip/<key>` if the worktree was lost).

| Module | Backend | Frontend | Review |
|---|---|---|---|
| parties (customers & khata, suppliers, doctors, loyalty) | ✅ | ✅ | ✅ |
| catalog | ✅ | ✅ | ✅ |
| identity (users, roles, stores, devices, settings) | ✅ | ✅ | ✅ |
| inventory | ✅ | ✅ | ✅ |
| purchases | ✅ | ✅ | ✅ |
| sales (POS + back office) | ✅ | ✅ | ✅ |
| accounting | ✅ | ✅ (in `wip/accounting`) | ⬜ queued |
| payments & UPI | ✅ | ✅ (in `wip/payments`) | ⬜ queued |
| notifications | ✅ | ✅ (in `wip/notifications`) | ⬜ queued |
| reports & GST | ✅ | 🔄 in progress | ⬜ |
| platform (cloud billing, API keys) | 🔄 in progress | 🔄 in progress | ⬜ |
| licensing (vendor console) | 🔄 in progress | ⬜ | ⬜ |
| onprem (activation, updates, backups) | ⬜ | ⬜ | ⬜ |

Restart with `tools/build-orchestration/modules.js` stage `build`, passing `modules` (what is left)
and `skip` (roles already done, e.g. `inventory:backend`, `inventory:frontend`) — skipped roles
hand the reviewer a pointer to the committed work.

## How to resume

1. Local services: PostgreSQL 16 with roles `kadai_owner`/`kadai_app` (see README), Redis.
   If the container was restarted: `pg_ctlcluster 16 main start; redis-server --daemonize yes`.
2. Restore module branches if they are not local: `git fetch origin 'refs/heads/mod/*:refs/heads/mod/*'`
   (or `git fetch tools/build-orchestration/module-branches.bundle 'refs/heads/*:refs/heads/*'`).
3. Recreate worktrees + per-module databases. `setup-worktrees.sh` creates `mod/<key>` from the
   integration branch only when the branch does not exist, so existing WIP branches are reused:
   check out existing branches first (`git worktree add /home/user/wt/<key> mod/<key>`), then run
   `bash tools/build-orchestration/setup-worktrees.sh` for the rest.
4. Copy `tools/build-orchestration/{foundation,contracts}-notes.txt` to a scratch location and
   point the `notes` argument at it (the notes tell agents to read these files).
5. Run the build workflow (`tools/build-orchestration/modules.js`, stage `build`) for the remaining
   modules, e.g. `args: {stage: 'build', modules: ['catalog','identity','inventory','sales','purchases','payments',...], notes: '...'}`.
   Agents first inspect `git status`, `git diff` and `git log <integration>..HEAD` in their worktree
   and continue from saved WIP instead of starting over. `parties` only needs merging.
6. Then `tools/build-orchestration/integrate.js` stage `merge` (serial merges with full checks),
   then stage `harden` (E2E, audits, fixes, release).

## Known notes from the paused agents

* Catalog backend added migration 0100 (extra columns on `imports`); parties' 0200 adds the same
  columns idempotently. Customer imports should also be served by `GET /imports/:id` (catalog).
* Suggested foundation follow-ups (from parties): generic localisation of snake_case validation
  keys in `apps/web/src/lib/validation.ts`; export `Textarea` from the UI kit; `min-w-0` on the
  Select trigger; a typed multipart upload helper; dialog-aware hotkey scopes.
* XLSX import is not supported (CSV only; no spreadsheet dependency).
