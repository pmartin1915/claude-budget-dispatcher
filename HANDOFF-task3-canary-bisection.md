# Handoff: Dispatcher Phase 2 - Task 3 (Automated Canary Bisection)

## Objective
Implement automated `git bisect` logic in the post-merge canary runner to isolate broken commits in $O(\log N)$ time and synthesize intelligent rollback/hotfix requests.

## Context
Currently, `scripts/post-merge-monitor.mjs` strictly fails-closed if a canary replay fails (Gate 7), simply auto-suspending the project. We want the agent to automatically isolate the precise commit that broke the canary and generate a mitigation request.

## Planning Requirements
1. **Automated Bisection:**
   - In `scripts/post-merge-monitor.mjs`, when `canaryOutcome.pass` is false, execute a programmatic `git bisect` session.
   - `git bisect start`, `git bisect bad <mergeSha>`, and find the last known `good` base SHA (using the PR's baseRef).
   - Use `git bisect run <canaryCommand>` using the native `execFileSync` or the newly improved `verifiedExec`.

2. **Ambiguous State Handling:**
   - Specifically handle `exit 125` states. If a step cannot be tested cleanly, the bisect script must exit 125 so `git bisect` gracefully skips it without marking it bad.

3. **Rollback Synthesis:**
   - Once the exact broken commit is isolated, use the `@google/genai` or `@mistralai/mistralai` package to synthesize a targeted rollback or hotfix request prompt for a fresh LLM instance.
   - Log this request or append it to a designated queue.

## Auditing & Safety Constraints
- **Worktree Hygiene:** The bisection requires checking out old commits. You must ensure `git bisect reset` and worktree cleanups are executed in a `finally` block so the host repo is not left in a detached head or mid-bisect state.
- **Fail-Soft Philosophy:** If the bisection stalls or fails, it should default to the existing fail-closed auto-suspend behavior. It must not crash the dispatcher loop.
- **Review:** Test this manually by creating a branch with a known broken commit, triggering the bisection, and observing the git commands executed via debug logs.

## Getting Started
- Review `scripts/post-merge-monitor.mjs`, specifically `processOneEntry()` and how `canaryOutcome` is evaluated.
- You will need to construct a robust shell/node script that wraps the canary command to emit the correct `0` (good), `1-124, 126-127` (bad), or `125` (skip) codes.
