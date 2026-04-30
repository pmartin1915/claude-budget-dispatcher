# Deep Research Prompt: Dispatcher Hardening and Autonomy Audit

## Context
We are operating an autonomous, multi-machine "budget dispatcher" fleet. It maximizes Claude Max subscription value by rotating non-destructive tasks (tests, audits, docs, cleanups) across a pool of local repositories when the environment is idle.

### Core Architecture
- **Engine:** Node.js CLI (`dispatch.mjs`) that routes tasks to free-tier LLM providers (Gemini, Mistral).
- **Control:** Layered configuration (`shared.json` + `local.json`).
- **Gating:** A seven-gate stack (Activity, Budget, Path-Firewall, Canary, Overseer, Auto-Merge, Replay).
- **Monitoring:** Fleet-wide status monitoring via GitHub Gist, surfaced on a central dashboard.
- **Autonomy:** Recently enabled Gate 6 (Auto-Merge) for a canary repo and enabled Auto-Push for a production project (`burn-wizard`).

### Current Status
- **Success:** Fleet is dispatching; limit expansions to 200 runs/day are live; the system is "fail-soft" for missing API keys.
- **Friction:** 
  - Periodic network/OS-level silence on fleet nodes.
  - Configuration drift (missing environment variables on auxiliary nodes).
  - Occasional "no-progress" or "degraded" alerts due to project allowlist misconfigurations.
- **Goal:** Shift from "autonomous with operator-in-the-loop" to "fully hardened, self-healing, and self-auditing."

## Your Audit Task
Perform a comprehensive architectural audit of the project (using the provided codebase context). Propose a concrete roadmap for:

1. **Robustness & Self-Healing:**
   - How can we detect and alert on node-specific environmental failures (e.g., missing API keys, path issues) before they result in a "stuck" project?
   - Propose a "self-healing" heartbeat monitor that can automatically re-register tasks or suggest fixes when a node reports a structural failure.

2. **Autonomous Hardening:**
   - The path firewall (`auto-push.mjs`) is currently rigid (empty allowlists block all). Propose a design for a "probabilistic allowlist expansion" strategy — where a project could propose its own `DISPATCH.md` updates based on successful smoke runs, and the Overseer validates them.
   - Analyze Gate 7 (Canary Replay): How can we make it more granular? Currently, a canary failure auto-suspends the project. Propose a mechanism to "auto-bisect" the failure instead of giving up.

3. **Overseer Intelligence:**
   - The Overseer currently merges PRs based on simple labels. Propose a "semantic integration test" that runs as part of the Overseer process before it grants `overseer:approved`, ensuring that the generated code is not just lint-clean but integration-stable.

4. **Safety Boundaries:**
   - Identify any "silent failure" vectors. We have already mitigated the missing `DISPATCH.md` skip, but are there other locations where a configuration error or provider outage could cause a silent stall?

## Output Requirements
- Provide a prioritized technical roadmap (P0: Security/Integrity, P1: Robustness, P2: Autonomy).
- Suggest specific modifications to `dispatch.mjs`, `auto-push.mjs`, or the `Overseer` logic to implement these improvements.
- Keep recommendations compatible with the current layered JSON config architecture.
