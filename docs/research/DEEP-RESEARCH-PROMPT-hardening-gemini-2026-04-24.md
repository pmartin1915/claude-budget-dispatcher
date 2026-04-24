# Deep Research Prompt — Dispatcher Hardening Implementation Blueprints

**Source:** Gemini generated this paste-ready prompt for commissioning Claude Code (or any frontier model) to produce concrete implementation blueprints for the 4 hardening pillars.

**When to use:** If we decide to commission more research *before* starting implementation. Otherwise, the two `HARDENING-*.md` blueprints plus `HARDENING-synthesis-gemini-2026-04-24.md` should be enough to start coding Phase A (distributed locking) directly.

---

## Prompt (paste below verbatim into a fresh Claude Code session)

> Copy everything below this line:

### Context

You are a Staff-level Systems Architect and Node.js expert. I am building "budget-dispatcher," an autonomous code dispatcher that uses unused AI subscription quotas to run bounded tasks on local Git worktrees across a 3-machine Windows fleet (perrypc, neighbor-pc, optiplex).

The system relies on local Node.js scripts, layered JSON configurations (`shared.json` + `local.json`), an append-only JSONL log, and coordinates the fleet via a public GitHub Gist to avoid centralized databases. It is designed to "fail closed" for safety. However, a recent incident where a missing string in a schema enum caused a machine to exit with code 2 for hours highlighted that our failure modes are too brittle, and our logging/dashboarding needs to scale.

### Objective

I need detailed architectural blueprints, error-handling patterns, and specific code snippets to harden this system for 24/7 overnight operation. Focus heavily on graceful fallbacks, detailed error output for easy debugging, and robust recovery mechanisms.

Please analyze and provide implementation plans for the following four critical areas:

### 1. Full-Pipeline Integration Testing (Mocked Providers)

Currently, we only have unit tests for the router. I need a test suite that verifies the entire end-to-end flow (Gates → Selector → Router → Worker → Audit → Commit) without making real API calls.

**Deliverable:** Show me how to set up a mock-provider in Node.js that intercepts the `@google/genai` and `@mistralai/mistralai` calls. How do we mock the Git worktree creation and commit process so the tests run cleanly in CI without leaving orphaned directories?

### 2. Bulletproof Configuration & Schema Drift

Recently, perrypc went hard-down because a local edit to `alerting.on_transitions` added the string `"degraded"`, but `config/budget.schema.json` only allowed `["down", "idle", "healthy"]`. AJV rejected it and the process crashed repeatedly.

**Deliverable:** Design a configuration loading module that gracefully degrades instead of crashing. If `shared.json` fails strict validation, how can the system emit a highly detailed, actionable error log, push an alerting notification via our existing `ntfy.sh` setup, and safely fall back to the last-known-good configuration or a safe minimal state?

### 3. Log Rotation & Dashboard Scaling (O(n) Fixes)

The dashboard reads the entire `status/budget-dispatch-log.jsonl` file on every API request (`getAnalytics`, `getLogs`). As this runs 8x a day across 3 machines, this will eventually OOM the Node process.

**Deliverable:** Provide a Node.js implementation for rotating the JSONL log (e.g., archiving when it hits 5MB or 30 days). Also, provide an updated Express.js endpoint pattern that streams the log file from disk to the client or paginates it natively, rather than buffering the whole file in memory.

### 4. Distributed Locking via GitHub (Concurrency)

Our gist-based coordination acts as an advisory board. If the PC and Optiplex pass their 20-minute cron gate at the exact same millisecond, they could step on each other and pick the same task.

**Deliverable:** Design a robust, atomic distributed locking mechanism using GitHub. Should we use a GitHub Issue comment with a specific timestamp? How do we handle stale locks if a machine acquires the lock and then OOM crashes? Provide the specific retry logic and lock-timeout code.

### Output Format

For each of the 4 areas, provide:

- **The Approach:** A brief explanation of the architecture choice.
- **Code Snippets:** The specific Node.js code required.
- **Error Handling:** Explicitly detail how it handles the "unhappy path" (e.g., GitHub API goes down, disk is full).
