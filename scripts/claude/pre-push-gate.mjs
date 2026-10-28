// PreToolUse hook: before any `git push`, run the repo's checks and block the push if they fail.
import { execSync } from 'node:child_process'
import { isPush, pushDir, unsignedCommits } from './trailer-check.mjs'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
const command = JSON.parse(raw || '{}').tool_input?.command ?? ''

if (isPush(command)) {
  const unsigned = unsignedCommits(pushDir(command))
  if (unsigned.length > 0) {
    console.error(`Blocked: these commits lack the Claude-Session trailer line (CLAUDE.md, Commits): ${unsigned.join(' | ')}. Add a new commit or redo the merge with the trailer lines in its message; never amend a pushed commit.`)
    process.exit(2)
  }
  try {
    // Lint only tracked files so untracked scratch files cannot block a push; CI lints the whole checkout.
    execSync('npm run gate', { stdio: ['ignore', 2, 2] })
  } catch {
    console.error('Blocked: the gate (`npm run gate`) failed. Fix them, then push again. If the error is a missing module or command, run `npm ci` first.')
    process.exit(2)
  }
}
