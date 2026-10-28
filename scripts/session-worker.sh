#!/usr/bin/env bash
# Run a subscription-authenticated worker inside the manager's existing cloud checkout.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
command -v codex >/dev/null || fail 'Install the official @openai/codex CLI in this cloud session first.'
# Inspect login status only. Never read or move authentication files.
login_status=$(codex -c 'forced_login_method="chatgpt"' login status 2>&1) || fail 'Sign in with: codex login --device-auth'
case "$login_status" in
  *'Logged in using ChatGPT'*) ;;
  *) fail 'ChatGPT subscription sign-in is required. API-key authentication is not accepted.' ;;
esac
if [[ ${1:-} == --check ]]; then
  codex --version
  printf '%s\n' 'ChatGPT login detected. A real task is still required to validate connectivity.'
  exit 0
fi

[[ $# == 2 && $2 =~ ^[1-9][0-9]*$ ]] || fail 'Usage: cloud-session-worker.sh /absolute/checkout PR_NUMBER | --check'
for dependency in git gh python3; do command -v "$dependency" >/dev/null || fail "Missing command: $dependency"; done
checkout=$(git -C "$1" rev-parse --show-toplevel)
[[ -z $(git -C "$checkout" status --porcelain) ]] || fail 'Checkout contains local changes. Preserve them before dispatching.'
pr=$2
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
gh pr view "$pr" --repo "${GITHUB_REPOSITORY:-OWNER/REPO}" --json headRefName,body,state > "$scratch/pr.json"
branch=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["state"]=="OPEN", "PR must be open"; print(d["headRefName"])' "$scratch/pr.json")
[[ $(git -C "$checkout" branch --show-current) == "$branch" ]] || fail "Check out this PR's branch first: $branch"
report=$(mktemp /tmp/cloud-worker-report.XXXXXX.md)
python3 - "$scratch/pr.json" > "$scratch/prompt.txt" <<'PY'
import json,sys
pr=json.load(open(sys.argv[1]))
print('Implement this pull request task. Read AGENTS.md and README.md first.')
print('The manager owns publishing: leave changes uncommitted; do not push, merge, post GitHub messages or change Git metadata.')
print('Run the required checks and self-review the diff. Restore every mutation. Return the report required by AGENTS.md, with failures and unrun checks stated plainly.')
print('If blocked by scope or an unsettled rule, report the exact blocker rather than guessing.')
print('\nPull request task:\n'+pr['body'])
PY
# The manager chooses supported model IDs explicitly; prose in the PR cannot select the running model.
worker_flags=()
if [[ -n ${WORKER_MODEL:-} ]]; then worker_flags+=(--model "$WORKER_MODEL"); fi
if [[ -n ${WORKER_EFFORT:-} ]]; then
  [[ $WORKER_EFFORT =~ ^(low|medium|high)$ ]] || fail 'WORKER_EFFORT must be low, medium or high.'
  worker_flags+=(-c "model_reasoning_effort=\"$WORKER_EFFORT\"")
fi
log=$(mktemp /tmp/cloud-worker-log.XXXXXX.log)
# Subscription login only. Keep the worker transcript out of the manager's context; it reads the final report.
if env -u CODEX_API_KEY -u OPENAI_API_KEY -u CODEX_AUTH_JSON codex exec \
  -c 'forced_login_method="chatgpt"' -c 'model_provider="openai"' \
  --sandbox workspace-write -C "$checkout" "${worker_flags[@]}" \
  --output-last-message "$report" - < "$scratch/prompt.txt" > "$log" 2>&1; then
  printf 'Worker log: %s\n' "$log"
else
  worker_exit=$?
  printf 'Worker failed with exit %s. Diagnostic log: %s\n' "$worker_exit" "$log" >&2
  exit "$worker_exit"
fi
printf '\nWorker report: %s\n' "$report"
printf '%s\n' 'Manager: review the diff and report, then commit/push and post the PR report through your existing GitHub connection.'
