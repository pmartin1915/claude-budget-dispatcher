# Gemini Synthesis — Dispatcher Hardening (2026-04-24)

**Source:** Gemini, via chat with Perry on 2026-04-24. Synthesized the `HARDENING-gemini-2026-04.md` and `HARDENING-gpt-2026-04.md` documents into a single execution plan mapped to Veydria's risk profile.

**Context:** Perry is building `budget-dispatcher` — an autonomous code dispatcher that uses unused AI subscription quotas to run bounded tasks on local Git worktrees across a 3-machine Windows fleet (perrypc, neighbor-pc, optiplex). The architecture relies on Node.js scripts, layered JSON configs (`shared.json` + `local.json`), an append-only JSONL log, and coordinates the fleet via a public GitHub Gist to avoid centralized databases. It is designed to "fail closed" for safety. However, a recent incident where a missing string in a schema enum caused a machine to exit with code 2 for hours highlighted that failure modes are too brittle, and logging/dashboarding needs to scale.

---

## Consensus and Divergence Between the Two Blueprints

The two blueprints largely agree on core architectural patterns but offer different tactical implementations.

### 1. Integration Testing (Mocked Providers)

**Consensus:** Executing actual Git operations during CI leads to polluted indexes, and hitting real AI APIs causes unpredictable rate limits. Both agree on in-memory filesystems and HTTP interception.

**The Best Approach:** Combine Gemini's `memfs` for virtual disk virtualization with GPT's recommendation of `nock` for generalized HTTP interception. `memfs` is generally more stable for modern Node.js environments than `mock-fs`, and `nock` handles API mocking beautifully without needing to deep-dive into the specific SDK internals.

### 2. Bulletproof Configuration & Schema Drift

**Consensus:** Total agreement. Both blueprints recommend catching AJV validation errors, using `better-ajv-errors` to generate readable alerts, pushing those alerts via `ntfy.sh`, and falling back to a Last-Known-Good (`.bak`) configuration.

**The Best Approach:** Implement this exactly as described. The "fail closed" approach is dangerous for availability; degrading gracefully to a safe, minimal state ensures the cron loop stays alive while awaiting human intervention.

### 3. Log Rotation & Dashboard Scaling

**Consensus:** Reading the entire append-only log into memory via `fs.readFileSync` guarantees an eventual V8 heap crash. Both insist on `fs.createReadStream` to pipe data in memory-safe chunks.

**The Best Approach:** Gemini's recommendation to use the `rotating-file-stream` library is much safer than GPT's manual `fs.statSync` approach, which risks blocking the Node event loop. However, GPT's direct streaming logic is slightly cleaner for simple endpoints. Use the dedicated rotation library, but keep the Express endpoint lean.

### 4. Distributed Locking via GitHub Gists

**Consensus:** Both identify GitHub API's `If-Match: <ETag>` header as the definitive way to achieve atomic, optimistic locking without a centralized database like Redis.

**The Best Approach:** Merge the two philosophies.

- **Acquisition:** Use Gemini's strict Time-To-Live (TTL) expiration and **Fencing Tokens**. This protects the fleet from "zombie" processes causing deadlocks if a machine experiences a long Garbage Collection pause.
- **Release:** Use GPT's method of releasing the lock by sending a `null` payload to delete the `lock.json` file entirely. This is cleaner than keeping the file and altering its internal state.

---

## Veydria Execution Plan

To safely support the Veydria project — specifically the Phase 1 validators and the upcoming Phase 2 cartography and timeline generations — infrastructure hardening should be prioritized by system risk.

### Phase A: Fleet Concurrency (HIGH PRIORITY)

Your architecture utilizes both a PC running Opus and an Optiplex handling free-tier batches. If both machines poll the `budget-dispatcher` queue simultaneously, they will corrupt the Veydria Git worktrees.

**Action:** Implement the GitHub ETag distributed locking mechanism immediately. Ensure the PC and Optiplex respect the lock TTL so that intensive Opus-tier tasks (like ADR generation) do not block the Optiplex from executing rapid free-tier tasks (like phoneme expansion).

### Phase B: Cowork-Bus Stability (MEDIUM PRIORITY)

The Laptop acts as the central monitoring node via the cowork-bus. As the Veydria repository scales toward Phase 5 (mechanics and 3D engine data), the telemetry logs will explode in size.

**Action:** Refactor the dashboard endpoints to use `fs.createReadStream` and implement `rotating-file-stream`. This ensures the laptop can continuously monitor the fleet without suffering Out-Of-Memory crashes.

### Phase C: Autonomous Safety Nets (ONGOING)

You currently have validators in place (`validate.js`, `phoneme-check.js`). However, configuration drift in `shared.json` could still take the system offline.

**Action:** Integrate the `better-ajv-errors` Last-Known-Good configuration loader. Pair this with the mocked integration testing suite to ensure that before you push new schema rules for Phase 2 (Economy & Timeline), the dispatcher's routing logic is fully verified.

---

## Recommended Starting Point

Given the immediate risk of data corruption between the PC and the Optiplex, start with the GitHub ETag locking mechanism (Phase A). Then move to cowork-bus log streaming (Phase B), then the LKG config loader + mocked tests (Phase C).
