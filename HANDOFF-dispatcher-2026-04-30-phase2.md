# Handoff: Dispatcher Fleet Hardening (Phase 2)

## Context
We are upgrading our autonomous multi-node LLM dispatcher fleet. In Phase 1, we successfully implemented foundational stability measures (`ConfigDriftError`, `verifiedExec` for sub-processes, push-based heartbeat telemetry, and sentinel auto-remediation). The fleet is now structurally stable but lacks advanced semantic validation and autonomous self-correction.

Our goal for this session is to begin executing the **Phase 2 Hardening Roadmap** as detailed in `Dispatcher Fleet Hardening Phase 2.txt`.

## Current System State
- The dispatcher runs via `scripts/dispatch.mjs` and uses a layered JSON configuration (`config/shared.json` and `local.json`).
- Gate 4 (Canary Runner) uses `verifiedExec` to catch interactive shell sinkholes.
- `scripts/lib/health.mjs` and `alerting.mjs` handle degraded state transitions (which we recently fixed to accurately surface fatal schema and environment errors in `ntfy.sh` payloads).
- All work happens on the `main` branch.

## Your Immediate Tasks

Please select one of the following Phase 2 initiatives to implement first. Review the provided theoretical foundation and modify the architecture accordingly.

### 1. Overseer Intelligence: AST Entropy & Mutation Validation
Currently, `overseer.mjs` merges LLM-generated PRs if they pass shallow unit tests. We need to prevent "Agentic Conformity Bias" (hallucinated structure, weak assertions).
- **Task A (Structural Entropy):** Integrate `@babel/parser` into `overseer.mjs` to calculate the Structural Cross-Entropy (SCE) between the baseline and the PR. Reject PRs that exceed the configured entropy threshold to prevent topological hallucinations.
- **Task B (Mutation Testing & Assertion Density):** Integrate `StrykerJS` via incremental mode. Parse test ASTs to statically calculate Jest `expect` assertion density. Block merges if the mutation score or assertion density is too low.

### 2. Autonomous Hardening: Dynamic Authorization
The current `auto-push_allowlist` firewall is rigid. We want the agent to probabilistically expand it using "sandboxed smoke runs" and cryptographically signed PRs.
- **Task:** Modify `scripts/lib/auto-push.mjs` to incorporate `isolated-vm` (do NOT use `vm2` due to CVE-2026-22709). Allow the agent to execute untrusted code in a strictly bounded V8 Isolate. If successful, use `@octokit/rest` and a local GPG shell command to create a `Verified` signed commit proposing the allowlist expansion to `DISPATCH.md`.

### 3. Automated Canary Bisection (Gate 7)
Currently, `scripts/post-merge-monitor.mjs` fails-closed if a canary replay fails.
- **Task:** Implement automated `git bisect` logic wrapped in a child process. Isolate the exact broken commit in $O(\log N)$ time, explicitly handling ambiguous states with an `exit 125` script, and then synthesize a targeted rollback or hotfix request for a fresh LLM instance.

### 4. Safety Boundaries: IPC Watchdogs & API Rate Limits
- **Task:** Enforce strict semantic firewalls by routing GitHub requests through `@octokit/plugin-throttling` to catch secondary rate-limit headers (`retry-after`). Add localized watchdog timers to `verifiedExec`'s IPC promises to prevent infinite silent stalls when `child_process.fork()` crashes out-of-band.

## Guidelines
- Adhere to the "fail-soft" design philosophy. If a new validation component (like `isolated-vm` or `@babel/parser`) fails catastrophically, log a warning but do not crash the host Node process.
- Avoid introducing heavy global dependencies where standard Node.js utilities will suffice, but do use the specific libraries mandated by the roadmap (e.g., `isolated-vm` for sandboxing).
- Test all modifications using the existing `sandbox-canary-test` or `sandbox-workflow-enhancement` projects.
