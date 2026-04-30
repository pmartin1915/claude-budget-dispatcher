# Handoff: Dispatcher Phase 2 - Task 2 (Dynamic Authorization)

## Objective
Implement a secure, sandboxed V8 Isolate for dynamic authorization and allowlist expansion. Replace rigid firewall rules with probabilistically expanded agentic execution.

## Context
The current `auto-push_allowlist` firewall in `scripts/lib/auto-push.mjs` is entirely rigid. We want the agent to be able to safely run untrusted code in a strictly bounded sandbox to prove its validity. Once proven, the agent should orchestrate a cryptographically signed commit proposing its own allowlist expansion.

## Planning Requirements
1. **Isolate Sandboxing:**
   - Modify `scripts/lib/auto-push.mjs` to incorporate `isolated-vm`.
   - **CRITICAL:** Do NOT use `vm2` under any circumstances due to the CVE-2026-22709 vulnerability.
   - Set up strict memory (e.g., 32MB) and timeout limits on the Isolate to prevent memory leaks or infinite loops.

2. **Cryptographic Signing:**
   - If the sandboxed smoke run succeeds, generate a signed commit updating `DISPATCH.md` with the new allowlist entry.
   - Use the recently added `@octokit/rest` and a local GPG shell command (`git commit -S`) to execute the commit.
   - Push the signed commit to the repository as a formal proposal.

## Auditing & Safety Constraints
- **Fail-Soft Philosophy:** If the isolate faults, panics, or times out, the authorization attempt must fail safely and reject the PR. It must never leak out of the sandbox or crash the host node process.
- **Dependencies:** Run `npm install isolated-vm`.
- **Review:** Test the sandbox with a benign payload and a malicious payload (e.g., attempting a `while(true)` loop or memory overallocation) to ensure the boundaries hold.

## Getting Started
- Review `scripts/lib/auto-push.mjs` to see where the current allowlist checks take place.
- Setup an integration test file using `isolated-vm` to verify context passing and timeout behavior before wiring it up to the main auto-push logic.
