# Auto-Push (Pillar 1 steps 1+2)

Path-firewalled push of `auto/<slug>-<task>-<date>` branches to `origin` plus a draft PR for the future Overseer. Gates 1 (path firewall) and 4 (canary success) of the seven-gate stack from `worldbuilder/VEYDRIA-VISION.md` Pillar 3.

## Default state

The mechanism ships **dormant** on all rotation projects. Top-level `auto_push: true` is on (fleet-wide kill switch is armed), but every project has `auto_push: false` and an empty `auto_push_allowlist: []`. Nothing actually pushes until you opt a repo in.

## Kill-switch ladder (defense-in-depth)

A push fires only if **all five** layers pass:

1. **Fleet flag** — top-level `auto_push: true` in `config/budget.json`.
2. **Project flag** — `projects_in_rotation[i].auto_push: true`.
3. **Non-empty allowlist** — `projects_in_rotation[i].auto_push_allowlist` has at least one pattern. Empty array always blocks (defensive default — prevents the footgun of opting in without listing eligible paths).
4. **All changed files match allowlist AND match no protected glob** — see "Path firewall" below.
5. **Canary command passes** — `projects_in_rotation[i].canary_command` is configured AND exits 0 within `canary_timeout_ms` — see "Canary gate (gate 4)" below. Missing `canary_command` on an opted-in project blocks the push (footgun guard).

Flip the fleet flag to `false` to disable everything across the fleet instantly without touching per-project config.

## Path firewall

Every changed file from `git diff-tree --no-commit-id --name-only -r -z HEAD` is checked:

- **Protected globs always win.** If any file matches `auto_push_protected_globs` (top-level), the push is blocked regardless of allowlist.
- **Allowlist is required.** Every file must match at least one pattern in the project's `auto_push_allowlist`.

### Glob grammar

POSIX separators only (`/`). Backslashes (Windows paths) are normalized to forward slashes before matching. Case-sensitive.

| Token   | Meaning                                          |
|---------|--------------------------------------------------|
| `**`    | any characters, including `/`                    |
| `*`     | any characters, NOT including `/`                |
| `?`     | single character, not `/`                        |
| literal | regex metacharacters escaped                     |

Examples:

- `src/**` matches `src/index.js` and `src/sub/deep/a.js` but not `tests/a.js`.
- `src/*.js` matches `src/index.js` but not `src/sub/a.js`.
- `**/secrets/**` matches `anything/secrets/key.txt` and `nested/dir/secrets/file`.

**Note on hidden files (dotfiles):** The matcher matches files and directories that start with a dot (`.`) by default. `src/*` matches `src/.env`, and `**/.env` is a valid pattern to catch `.env` at any depth. If you need to allow regular `src/` files but exclude dotfiles, list them explicitly in `auto_push_protected_globs` (e.g., `src/.*`).

### Default protected globs

```json
".github/**", "package.json", "package-lock.json",
"**/secrets/**", "**/credentials/**", "LICENSE*"
```

Edit `auto_push_protected_globs` in `config/budget.json` to extend. Adding to or modifying this list is **never** an autonomous operation — it requires a human-reviewed PR. The dispatcher cannot edit its own protected-globs list.

A hardcoded fallback list with the same six entries lives in `scripts/lib/auto-push.mjs` as `FALLBACK_PROTECTED_GLOBS`. If the config field is missing or empty, the fallback is used. Defense-in-depth: a config typo cannot disable protection.

## Canary gate (gate 4)

After the path firewall passes and before `git push` runs, the dispatcher executes the project's canary command in the worktree. Non-zero exit, timeout, or spawn-error blocks the push and preserves the local commit and branch — same fail-soft posture as the firewall.

### Configuration

```json
{
  "slug": "engine-2d",
  "auto_push": true,
  "auto_push_allowlist": ["src/**", "tests/**"],
  "canary_command": ["npm.cmd", "run", "canary"],
  "canary_timeout_ms": 120000
}
```

- **`canary_command`** is **required** when `auto_push: true`. Missing canary on an opted-in project blocks the push with `reason: "canary-not-configured"` (footgun guard — opting in without proof-the-engine-works is not allowed).
- **Must be an array of strings** (argv form). Single-string form like `"npm run canary"` is rejected by the JSON schema. The runner spawns with `shell: false` to close the config-injection vector — there is no path where a config string flows to a shell.
- **`canary_timeout_ms`** defaults to `120000` (2 min) when absent. Hard cap `600000` (10 min). On timeout, the process tree is killed via `taskkill /T /F /PID` (Windows) or `kill -SIGKILL` on the process group (POSIX, child spawned with `detached: true`).
- **Windows note:** `spawn(..., { shell: false })` does **not** auto-resolve `npm` to `npm.cmd`. Use `["npm.cmd", "run", "canary"]` or an absolute path. Bare `["npm", "run", "canary"]` will spawn-error on Windows.

### Outcomes

| Outcome | Reason | Failure mode | Recovery |
|---|---|---|---|
| `auto-push-blocked` | `canary-not-configured` | n/a | Add `canary_command` to the project's `projects_in_rotation` entry. |
| `auto-push-blocked` | `canary-failed` | `non-zero` | Reproduce locally: `cd <worktree> && <canary_command>`. Fix the test or the regression. |
| `auto-push-blocked` | `canary-failed` | `timeout` | Increase `canary_timeout_ms` if the canary is genuinely slow; otherwise diagnose the hang. |
| `auto-push-blocked` | `canary-failed` | `spawn-error` | Command not found or wrong argv shape (e.g. `["npm", ...]` instead of `["npm.cmd", ...]` on Windows). |
| `auto-push-dry-run` | n/a | n/a | When canary is configured, the log entry has `canary_skipped: "dry-run"`. |

Each `canary-failed` log entry carries `failure_mode`, `exit_code`, `duration_ms`, `timedOut`, `stdout_tail` (≤500 chars), `stderr_tail` (≤500 chars), and the `canary_command` argv array.

### Testing the canary locally

```bash
cd <worktree-or-repo-path>
# Run the same argv array your canary_command holds:
npm.cmd run canary    # or whatever the configured argv resolves to
echo $?               # 0 = pass; the dispatcher accepts only 0
```

### Permanent never-auto-push (per `worldbuilder/VEYDRIA-VISION.md`)

Even when adding a repo's allowlist, the following categories must never be in any allowlist anywhere:

- Clinical code (any healthcare domain — burn-wizard, healthcare-apps, ECG wizard, medilex)
- Veydria lore canon (`worldbuilder/religion/**`, `factions/**`, `magic/**`, `linguistics/**`, `ecology/**`, `economy/**`, `geography/**`, `timeline/**`)
- Narrative content (dialogue trees, quest definitions, character motivation)
- Game design (pacing, balance, encounter design, choice-consequence rules)
- Framework / orchestrator code (`combo/`, `claude-budget-dispatcher/`, `sandbox-workflow-enhancement`)
- CI/CD config (`.github/`, scheduled-task scripts, deploy pipelines)
- Production `package.json` dependency changes
- Secrets, credentials, license files
- The `auto_push` allowlist itself, or any path firewall config

These categories are best protected by NOT setting `auto_push: true` on the project at all. The protected-globs list catches the in-repo subset (`.github/**`, `package.json`, secrets, credentials, license).

## How to opt a repo in

1. In `config/budget.json`, find the project entry under `projects_in_rotation`.
2. Set `auto_push: true`.
3. Populate `auto_push_allowlist` with explicit globs covering only the paths whose changes are objectively-verifiable (engine, physics, asset pipeline, tests, golden fixtures, CHANGELOG-style docs). See VEYDRIA-VISION.md "majority autonomous, but safe" boundary.
4. Restart the dispatcher (or just wait for the next scheduled run).

Example (a hypothetical `engine-2d/` repo):

```json
{
  "slug": "engine-2d",
  "path": "c:/Users/perry/DevProjects/engine-2d",
  "auto_push": true,
  "auto_push_allowlist": [
    "src/**",
    "tests/**",
    "benchmarks/**",
    "CHANGELOG.md"
  ]
}
```

## How to verify a push happened

1. Look in `status/budget-dispatch-log.jsonl` for an entry with `phase: "auto-push"`. Outcomes:
   - `auto-push-success` — `pr_url` field has the PR link.
   - `auto-push-blocked` — `reason` is one of: `disabled-global`, `disabled-project`, `empty-allowlist`, `outside-allowlist`, `protected-glob`. `blocked_path` and `matched_pattern` identify the offender.
   - `auto-push-failed` — `reason` is one of: `git-push-failed`, `pr-create-failed`, `list-changed-files-failed`, `internal-error`. Local commit is still intact for manual recovery.
   - `auto-push-dry-run` — fired only when `dry_run: true` (config) or `--dry-run` (CLI). Firewall evaluated, no git/gh side effects.
2. On the GitHub repo, the **Pull requests** tab will list the new draft PR (filter by `is:draft author:@me`).

## Failure modes

The orchestrator never throws. Every failure path returns a structured outcome:

| Failure                          | Outcome                          | Recovery                                                             |
|----------------------------------|----------------------------------|----------------------------------------------------------------------|
| `git push` fails (auth, network) | `auto-push-failed/git-push-failed` | Local commit intact; next run retries OR push manually               |
| `gh pr create` fails             | `auto-push-failed/pr-create-failed`, `pushed: true` | Branch is on origin; create the PR manually with `gh pr create --draft` |
| Concurrent fleet push race       | Same as above (non-fast-forward) | One machine wins; loser logs and moves on. NEVER `--force`.          |
| Internal bug in the module       | `auto-push-failed/internal-error` | The dispatcher does not crash. Open a bug.                            |

## Gate 5: Overseer (read-only)

After the path firewall (gate 1), tests (gate 2), in-line cross-family audit (gate 3), and canary (gate 4) all clear and the draft PR is open, an out-of-band **Overseer** loop runs every 2h on GitHub Actions. It reads the diff and the PR body together and asks a model from the **opposite family** of whatever generated the PR (per C-1 anti-monoculture, `combo/ai/DECISIONS.md` 2026-04-14): *did this change actually achieve what the bot claimed?*

Read-only by default: the Overseer **labels** the PR with one of three verdicts. When `auto_merge: true` is set at BOTH the top-level (`config/shared.json`) AND in the per-repo `overseer.repos[]` entry (object form), gate 6 (cooling-off + ready-flip + merge) and gate 7 (post-merge canary monitor) take over. See `AUTO-MERGE.md` for the gate-6+7 lifecycle, opt-in procedure, and auto-suspend semantics. Without explicit opt-in, the bot stays in label-only mode forever.

### What the labels mean (for an operator deciding whether to merge)

| Label | Meaning | Operator action |
|---|---|---|
| `overseer:approved` | Audit model says diff matches the PR body claim and no semantic regression detected. | You can mark ready and merge. The label is *advisory* — manual review still recommended for non-trivial changes. |
| `overseer:rejected` | Audit model says the diff demonstrably breaks the body claim or introduces a critical regression. | Read the JSONL `summary`. Either close the PR or push a fixup commit (which retriggers review). |
| `overseer:abstain` | Audit model couldn't decide — low confidence, ambiguous family, quota-exhausted, or the audit model errored. | Manual review required. **Not** a failure signal; just *"the bot couldn't help here"*. |

Quota-exhausted is **always** mapped to `abstain`, never `rejected`. A transient free-tier outage cannot silently kill otherwise-fine PRs.

Full operator guide: `docs/OVERSEER.md`.

## Concurrency / race conditions

- Push is `git push origin <branch>` with **no `--force`**. Ever. Concurrent fleet pushes to the same branch get rejected as non-fast-forward, which is correct + non-destructive.
- Branch names already include the date (`auto/<slug>-<task>-<date>`), and worktrees are per-machine, so collisions on the exact same branch are uncommon and self-resolving.

## Deprecated: `auto_pr`

The `auto_pr` boolean in `config/budget.json` is no longer consulted. After a successful path-firewalled push, a draft PR is **always** opened. There is no longer a separate "push but don't open PR" mode — losing the PR loses the audit trail the future Overseer reads.

The key may be removed from configs in a follow-up cleanup.

## Minimum tooling

- `gh` CLI version 1.0+ (draft PRs have been GA since 2020).
- GitHub PAT with `repo` scope. `gh auth refresh -s repo` if needed.

## Related

- `worldbuilder/VEYDRIA-VISION.md` — full four-pillar architecture and seven-gate stack.
- `combo/ai/DECISIONS.md` 2026-04-11 — sandbox portfolio firewall (proposal-only meta-sandbox).
- `combo/ai/DECISIONS.md` 2026-04-14 — cross-family audit (C-1) requirement.
- `scripts/lib/auto-push.mjs` — implementation.
- `scripts/lib/__tests__/auto-push.test.mjs` — test suite.
