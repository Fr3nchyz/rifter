# Subscription delegation inside an existing Claude cloud session

This route runs Codex CLI as a normal child process in Claude Code's existing cloud checkout. Claude uses its subscription for orchestration/review; Codex uses ChatGPT sign-in for implementation. It does not call `codex cloud exec`, does not depend on GitHub mentions discovering a Codex environment, and does not need another always-on machine or an OpenAI API key.

## One-time feasibility check in Claude's cloud terminal

1. Install the official Codex CLI using the official installation instructions. A normal npm installation is `npm install -g @openai/codex`; use a user-writable installation prefix if the runtime requires one. Do not change the project's dependency manifest or lockfile.
2. Run `codex login --device-auth`. The owner must approve the login in the browser using the ChatGPT account with the Plus subscription. Never paste tokens into chat or copy an authentication file from another session.
3. Run `bash scripts/session-worker.sh --check`. This verifies the CLI and login method only.
4. Run one small read-only canary before implementation:

   ```sh
   env -u CODEX_API_KEY -u OPENAI_API_KEY -u CODEX_AUTH_JSON codex exec \
     -c 'forced_login_method="chatgpt"' -c 'model_provider="openai"' \
     --sandbox read-only -C /path/to/checkout \
     'Read AGENTS.md and report the current branch. Change nothing.'
   ```

The Claude runtime must allow installing the CLI, browser/device authentication, outbound Codex connections and the CLI sandbox. A failed canary must be diagnosed; this guide does not claim Claude-side access is already working. If a destination is blocked, use that host's supported network settings. Keep TLS verification and sandboxing enabled.

## Each task, dispatched by Claude

Claude selects an open starter PR, uses its existing clean checkout on that PR's branch, and runs:

```sh
bash scripts/session-worker.sh /path/to/checkout 142
```

The launcher reads the PR description through the existing GitHub CLI authentication, passes it to subscription-authenticated Codex, and returns a report file. The worker's full transcript stays in a local log; Claude reads the final report and diff rather than paying context costs for the implementation transcript. It rejects dirty checkouts, the wrong branch, closed PRs and non-ChatGPT login. The implementation remains uncommitted for Claude to review. Claude then runs the relevant review checks, commits/pushes using its existing GitHub connection and posts the report. Review findings can be sent to a subsequent `codex exec` invocation in the same checkout. Do not start a second worker on an occupied checkout.

Set `WORKER_MODEL` to an actually supported CLI model ID and `WORKER_EFFORT` to `low`, `medium` or `high` when the issue specifies a tier. Without these overrides the CLI's configured defaults apply. Model/effort words inside the task description do not change the process's selected model. Keep Fast mode off in the CLI configuration if that is the owner's preference. An unsupported model should be reported, without an automatic fallback to a more expensive choice.

No separate MCP server is necessary: task input and the returned report are the communication channel. Authentication may need repeating if Claude's host discards its CLI state between cloud sessions. This route does not wake a paused Claude session; dispatch happens while Claude is active. Subscription usage limits still apply.

## Verification status

The launcher can be checked in this workspace for installed CLI/authentication and tested with stubbed CLIs for the dispatch contract. An actual authenticated canary inside Claude's cloud runtime is still required before calling this connection operational.

## Login in a custom cloud environment

Prefer signing in directly in the target runtime with `codex login --device-auth`: the owner approves the browser login, and no local auth file has to be transferred. First verify that the runtime permits device authentication and that the account enables it. Never put a login file or device code in a GitHub issue, chat, PR or tracked file.

If the owner explicitly chooses secret-based bootstrap instead, use the cloud provider's **secret** field for `CODEX_AUTH_JSON`, not a plain suggested environment value. The runtime and programs running under its user can access the credential; log masking is not isolation from those programs. Use only a trusted private environment and trusted repository/plugin code. The setup does not require an API key.

The optional `scripts/claude/codex-auth.sh` session hook restores a supplied JSON subscription login only when no cached auth file exists. It checks the JSON structure without printing it, rejects API-key-only input and symlink paths, creates owner-only storage, and never overwrites an existing login (which may have newer refreshed tokens). A failed restore is reported without credential fragments. The worker subprocess also removes the original bootstrap variable from its inherited environment; this does not remove the runtime's access to its CLI login file.

A Mac login may be stored in the OS keychain rather than `~/.codex/auth.json`. Check the CLI's documented `cli_auth_credentials_store` option; prefer direct target-runtime login instead of extracting a keychain. Do not assume an absent file or unreadable environment variable means an expired credential. Secret injection, auth storage, network policy and token expiry are separate diagnoses. When deliberately changing accounts, use the CLI's logout/login flow; the hook does not replace an existing cache automatically. Copying one refresh-token snapshot into multiple simultaneous runtimes can become unreliable when tokens rotate; it is not a durable credential sync system.

Allow the required outbound hosts in **Claude's** cloud environment, not merely this repository's Codex environment. `auth.openai.com` and `chatgpt.com` are relevant to ChatGPT authentication/backend access; `api.openai.com` alone does not establish subscription connectivity. Keep the package-manager destinations needed to install the CLI and plugin. Follow the actual denied destination if redirects or plugin downloads require another host; do not switch to unrestricted access, disable TLS, impersonate a client or disable the sandbox to make the test pass. These are starting requirements, not an independently verified exhaustive host list.

The official plugin repository is `openai/codex-plugin-cc`. The project enables its marketplace and plugin, but installation, `/codex:setup`, and a real read-only canary inside Claude's runtime must still succeed. Record the CLI/plugin versions that passed and pin the CLI setup to the tested version. Do not merge deployment/session integration changes based only on login status or stub tests.

## Local bootstrap checks

Run `node --test scripts/claude/codex-auth-check.mjs`. These use disposable directories and **dummy** token strings; they do not authenticate to OpenAI or inspect anyone's credential cache. The launcher still needs the actual Claude-runtime canary above.

### Repository verification for the hardened bootstrap

The seven dummy-credential checks also run through the normal test suite via `scripts/claude/codex-auth.test.mjs`. Verified locally: 3,061 tests passed and one was skipped, with lint, typecheck and production build passing. An independent static review found no blockers in the bootstrap changes. No game/AI/data files or fixed-seed hashes changed, so the whole-game comparison is not applicable. Neither these checks nor the installed local CLI (`0.163.0`) prove the plugin's behavior in the target cloud runtime. The actual subscription-authenticated read-only canary and plugin setup there remain unrun; neither PR should be merged on the strength of these checks alone.

For the first session on the draft branch, run the bootstrap hook explicitly if the session started before the branch/settings were checked out: SessionStart does not retroactively rerun on a branch switch. If the provider supplies only proxy-injected placeholders rather than raw environment secret values, that binding cannot be used as an auth-file bootstrap; use supported target-runtime device sign-in instead. A placeholder is not evidence of token expiry.
