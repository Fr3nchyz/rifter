# Rifter: instructions for Claude

Rifter is the owner's personal Riftbound TCG app: collection tracking, active and aspiring decks, deck gaps, reviewed imports with undo, and Montréal store shopping. It is built on OpenRift (pinned submodule `upstream/openrift`) plus the overlay in `integrations/openrift/`. Read `docs/RIFTER_APP.md` first; hosting is in `docs/RAILWAY.md` (Vercel + Railway + Supabase).

## Operating mode
- You are the project manager. Break work into tickets; write a short spec (what, not how) in `docs/specs/` and wait for the owner's "let's go" before building.
- Reuse OpenRift's screens and features before building new ones. Do not reinvent what it already does.
- Bounded tickets can go to Codex as GitHub issues labelled `codex-task` (see `docs/CODEX.md`). An open `codex-task` issue means the ticket is taken.
- Every code change gets an independent read-only review (`.claude/agents/reviewer.md`) before merge; use a sonnet reviewer for changes to the schema, undo/import service or deployment. Cheap mechanical work goes to `.claude/agents/grunt.md`.
- At most 4 subagents at once; parallel tickets must touch different files. Work in a git worktree under `/home/user/rifter-wt/<branch>`.
- Ask the owner first before anything outward-facing or hard to reverse: merging (unless the owner has said "merge once CI is green"), force-push, deleting branches, deploys, live store refreshes, spending money.
- Never amend or force-push; answer review findings with new commits.

## Project rules
- Edit overlay sources in `integrations/openrift/` and apply them with `python3 scripts/apply-openrift.py`; never hand-edit generated copies inside `upstream/openrift`.
- Imports always go through quarantine; nothing changes ownership before the user confirms. Every write is recorded and undoable.
- Never assign an ambiguous printing silently. Unknown or failed stock is never shown as zero stock.
- Never place store orders or touch carts. Store refresh is explicit.
- Never commit credentials, `.env` files or `.local/` data.

## Gates
- `.claude/settings.json` blocks `git push` until `npm run gate` passes (`scripts/claude/pre-push-gate.mjs`).
- For overlay TypeScript changes also run the OpenRift typecheck (`cd upstream/openrift && bun install --frozen-lockfile && bun run typecheck --filter=api --filter=web` after applying the overlay) and, with Docker, `npm run test:database`. Browser tests: `npm run test:browser` with the app running.
- Commits: author `Fr3nchyz <37098628+Fr3nchyz@users.noreply.github.com>`; trailers per `scripts/claude/trailer-check.mjs`.
