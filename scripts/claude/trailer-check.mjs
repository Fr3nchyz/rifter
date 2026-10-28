// Every commit a session pushes must end with its Claude-Session trailer (CLAUDE.md, "Commits"). A merge made with `--no-edit` is the usual way to lose it.
import { execFileSync } from 'node:child_process'

/** Whether the command pushes: `git push` or `git -C <dir> push`. */
export const isPush = (command) => /\bgit\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?push\b/.test(command)

/** The directory a push command runs in: the last `cd <dir>` before it, or `git -C <dir> push`, else the current one. */
export function pushDir(command) {
  const c = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+push\b/.exec(command)
  if (c) return unquote(c[1])
  const cds = [...command.split(/\bgit\s+push\b/)[0].matchAll(/\bcd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)]
  return cds.length ? unquote(cds[cds.length - 1][1]) : process.cwd()
}

const unquote = (s) => s.replace(/^["']|["']$/g, '')

/** The subjects of the commits whose message lacks a `Claude-Session:` line. `log` is `git log --format=%H%x00%s%x00%B%x01` output. */
export function missingTrailer(log) {
  return log.split('\x01').map((r) => r.trim()).filter(Boolean).flatMap((r) => {
    const [, subject, body] = r.split('\x00')
    return /^Claude-Session: \S+/m.test(body ?? '') ? [] : [subject]
  })
}

/** The commits about to be pushed in `dir` that lack the trailer: those not yet on origin/<branch>, or on origin/main when the branch is new; [] when the range cannot be read (no origin/main, not a repo). */
export function unsignedCommits(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    let base = 'origin/main'
    try {
      const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
      git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)
      base = `origin/${branch}`
    } catch {
      // a branch with no remote counterpart yet: everything beyond origin/main is new
    }
    return missingTrailer(git('log', `${base}..HEAD`, '--format=%H%x00%s%x00%B%x01'))
  } catch {
    return []
  }
}
