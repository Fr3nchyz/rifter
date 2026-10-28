# Instructions for coding agents (Codex)

You are implementing one GitHub issue labelled `codex-task`. Claude reviews your pull request before it is merged (see `docs/CODEX.md`). Read `docs/RIFTER_APP.md` for how the app is built.

## Setup
`git submodule update --init --recursive && npm ci --ignore-scripts`. Python 3.10+, no extra packages. For overlay TypeScript work: `python3 scripts/apply-openrift.py && cd upstream/openrift && bun install --frozen-lockfile`.

## Hard rules
1. Stay in scope: touch only the files the issue lists, plus tests.
2. Edit the overlay in `integrations/openrift/`, never `upstream/openrift` directly. Do not change the submodule pointer unless the issue says so.
3. Imports go through quarantine; every write stays recorded and undoable. Never auto-pick an ambiguous printing.
4. Do not weaken, skip or delete tests. No secrets, `.env` files or `.local/` data in commits.
5. Never merge, never push to `main`, never change secrets, deploys or repository settings. No live store requests in tests.

## Gates (all must pass before you open the PR)
- `npm run gate` (Python tests and compile checks).
- If you touched TypeScript: the OpenRift typecheck (`bun run typecheck --filter=api --filter=web` in `upstream/openrift`, after applying the overlay).

## When to stop and ask
If the issue does not settle a behaviour, or the work needs changes outside the listed files: open the PR as a **draft** with what you have and put the question first under "Remaining concerns".

## Commits and the pull request
- One branch and one pull request per issue. If started on a starter PR, push to that PR's branch and post the report as a PR comment.
- Never force-push; answer review comments with new commits.
- Report sections, in order: What it does; Files changed; Tests added; Gate results; Remaining concerns. Reference the issue with `Closes #<issue>`.
