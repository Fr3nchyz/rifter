# Setup recipe: Claude as manager, Codex as builder

Tickable web version: https://claude.ai/artifact/6d17qLR37eJQEK1friDXox

Claude writes specs and GitHub issues, reviews and merges. Codex Cloud picks up the issues and opens the pull requests.

## Phase 1: Accounts (you)
- [ ] GitHub account and a repo made from this template (Use this template).
- [ ] Claude paid plan with Claude Code on the web, and the Claude GitHub app installed on the repo.
- [ ] ChatGPT Plus or higher. Codex runs on it, no API key needed.
- [ ] At chatgpt.com/codex: connect GitHub, add the repo, set its setup script to your install command (for Node: `npm ci`).

## Phase 2: Repo files
- [ ] Fill the TODO markers in `CLAUDE.md`, `AGENTS.md` and `scripts/claude/pre-push-gate.mjs`.
- [ ] Edit the example tables in `docs/CODEX.md`.
- [ ] Add a CI workflow under `.github/workflows/`.
- [ ] Create the `codex-task` label.

## Phase 3: Claude cloud environment (once)
In the project settings, Cloud environment, Add:
- [ ] Allowed domains: `api.openai.com`, `auth.openai.com`, `chatgpt.com` (add `ab.chatgpt.com` if login complains). Keep package managers allowed.
- [ ] Setup script: `npm install -g @openai/codex`
- [ ] Select this environment for the project, then start a new session (the environment is fixed at session start).
- [ ] In the new session run `/codex:setup`, then `bash scripts/session-worker.sh --check`.

## Phase 4: Codex login (each new session)
- [ ] Ask Claude to run `codex login --device-auth`, open the link, enter the code, approve with your ChatGPT account.
- Never paste tokens into chat or a repo. Optional shortcut: store `CODEX_AUTH_JSON` as an environment secret, restored by `scripts/claude/codex-auth.sh`. It works like a password: private environments only, and it can go stale.
- The Codex Cloud route (issues and PRs on GitHub) needs no login in Claude's container.

## Phase 5: The loop
1. Claude writes a spec; you approve ("let's go").
2. Claude files one issue per bounded ticket from the Codex task form, with a tier.
3. Claude opens a draft starter PR containing `Closes #N` and the task text.
4. Start Codex on that PR: comment `@codex implement this`, or if the bot refuses, type in the Codex chat: `Implement PR #N in owner/repo: the task is in its description. Follow AGENTS.md, push to its branch, post the report as a PR comment.`
5. Codex pushes and posts its report. Claude re-runs the gates, has an independent reviewer read it, and sends one list of fixes.
6. Merge when the reviewer says merge and CI is green on the exact head commit. Tell Claude once, in writing, that this is allowed.

## Tiers and budget
- Light: smallest model, low effort (docs rows, constants, tests copying a pattern).
- Standard: default model, medium effort (most tickets).
- Heavy: top model, high effort (branchy logic, second attempts). Rare.

Plus has a rolling 5-hour window and a weekly cap. Keep Fast mode off, keep four ready issues queued, start about two tasks per window, at most two or three issues at once on different files. Name models in the issue, not in repo files.

## Pitfalls
| Symptom | Cause and fix |
|---|---|
| Codex install or login cannot connect | Default environment blocks OpenAI. Use the custom environment. |
| Changed the environment, nothing changed | Fixed at session start. Open a new session. |
| Login gone in a new session | Containers are reset. Log in again or restore the secret. |
| `codex mcp-server` fails | Removed by OpenAI (Sept 2026). Use the `openai/codex-plugin-cc` plugin or `codex exec`. |
| Plugin will not install by hand | Blocked in sessions. Enable it in `.claude/settings.json` and start a new session. |
| `@codex` answers "create an environment" | Connect the repo and publish an environment at chatgpt.com/codex. If still refused, use the Codex chat line. |
| Codex ignores issues | It only reacts to PR comments, hence the starter PR. |
| "required status checks expected" on merge | Merge main into the branch and wait for CI. |
| Claude will not edit `.claude/` or hooks | It treats that as editing its own rules. Give an explicit OK. |
