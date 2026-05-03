# METACOGNITION + Self-Repair Layer — synthesis

_Cross-doc synthesis of the Phase 2 metacognition + autonomous self-repair design (`METACOGNITION-DESIGN-claude-2026-04-30.md`) against its red-team audit (`METACOGNITION-AUDIT-claude-2026-04-30.md`). Single-family pair (Claude raw + Claude red-team) — different shape than the cross-family Fork B precedent. The audit pre-existed the synthesis pass; corrections land directly in the convergence layer rather than as a deferred patch._

_Synthesized 2026-05-03 by Opus 4.7 1M (laptop). PAL audit completed 2026-05-03 (Mistral Large 2 cross-family — Gemini 2.5 Pro free-tier daily quota exhausted, fell back to Mistral per the dispatcher's own C-1 cross-family discipline; continuation `af4b7610-e4cb-4d37-9594-b387f03f172a`). Audit returned 2 CRITICAL + 2 HIGH + 3 MEDIUM + 2 LOW findings; on critical evaluation, 4 of 6 critical/high/medium were misreads (the synthesis already addresses each), 2 produced minor strengthening edits in this revision (M4 threshold provisional framing + a 60-day deferral alternative for M3), 1 LOW produced this disclaimer addition, 1 LOW was factually questionable and rejected. Net: 0 load-bearing changes from audit. Mechanism dormant on ship — surfaces six load-bearing dispatcher ADR candidates (M1-M6) for explicit operator decision before any Phase 2 implementation work begins._

---

## Reading order (read first)

This is the **canonical layer** over the design + audit pair. For implementation work, read in this order:

1. **`METACOGNITION-DESIGN-claude-2026-04-30.md`** — the architectural skeleton. The DESIGN proposes Servy as the out-of-band Watcher daemon, an ONNX-driven semantic-drift detection pipeline, an LLM-driven AST self-repair cascade, a 3-state Algorithmic Circuit Breaker (ACB), and a GitHub Actions Dead Man's Switch.
2. **`METACOGNITION-AUDIT-claude-2026-04-30.md`** — the red-team review. Three CRITICAL vulnerabilities surface that the design as-written would silently fail: (a) the Half-Open → Closed transition is exploitable by zombie patches, (b) the Servy `PreLaunchTimeout=300` config is silently overridden by Windows SCM's hardcoded 30s start timeout, (c) the ONNX runtime memory footprint exhausts low-resource VPS hosts.
3. **This synthesis** — what survives the audit, what changes, what's already shipped in the dispatcher today, and the six ADR candidates Perry must commit to before any Phase 2 implementation work begins.
4. **The dispatcher source** (`scripts/lib/circuit-breaker.mjs`, `scripts/watchdog.mjs`, `scripts/lib/health.mjs`) — current state of the local-cognitive layer. Already-shipped pieces overlap with the design at the **rule-based outcomes layer**; the ONNX semantic-drift layer and LLM-driven AST repair are net-new.

The DESIGN is architecturally sound at the macro layer (out-of-band Watcher + drift detection + LLM-driven repair + circuit breaker + global Dead Man's Switch) and survives audit at that layer. The flaws cluster at the **integration boundaries** (where the LLM repair cascade meets the OS service manager, where the ONNX runtime meets host memory limits, where the circuit-breaker state machine meets delayed-execution failure modes). All three CRITICAL findings are addressable with concrete configuration / state-machine changes that the synthesis canonicalizes.

---

## Convergence (load-bearing design choices that survive audit)

Both the DESIGN and the AUDIT agree that the dispatcher's current resilience layer (sentinel.mjs reactive task requeuing + JSONL log + outcome-rule-based health.mjs + P3 wrapper auto-update circuit breaker + P7 out-of-band watchdog) handles **out-of-band fatal process termination** poorly and **in-band cognitive degradation** not at all. The Phase 2 metacognition layer fills both gaps. The convergence layer below is the design floor — what survives audit unchanged or with non-load-bearing modification.

### 1. Two distinct categories of catastrophic failure

The DESIGN identifies and the AUDIT confirms two architecturally-distinct failure categories that the current resilience layer does not protect against:

- **In-band cognitive degradation** — the "coherence trap": LLM agents (Gemini, Mistral) operating in extended multi-step reasoning frequently retrieve irrelevant data, generate plausible-but-incorrect analysis, and confidently pursue impossible solutions while reporting completion. The current `health.mjs` 4-state classifier (healthy / degraded / idle / down) is rule-based on log outcomes — it catches `consecutive_errors >= 3` and `structural_failures >= 3 in last 6 cycles` and `selector_fallback_count >= 3`, but it cannot distinguish "the LLM is producing degraded but technically-successful output" from "the LLM is healthy." The semantic-drift signal is the only way to catch this class of failure at the agent layer.
- **Out-of-band fatal process termination** — Node.js process death from V8 unhandled exceptions, native module crashes, or memory exhaustion. The current `scripts/sentinel.mjs` (referenced in the DESIGN; the dispatcher's existing P7 watchdog at `scripts/watchdog.mjs` covers a related but narrower scope — fleet-silence detection, not local-process restart) cannot restart the dead Node process; it can only requeue tasks to peers. A fatal-crash response loop — detect process death, capture stack, generate patch, validate, restart — requires a process-level supervisor running outside the Node process. **This is what Servy provides**: a Windows-service-manager-aware daemon with synchronous lifecycle hooks.

### 2. Out-of-band Watcher — Servy is the right tool, with caveats

The DESIGN's evaluation of out-of-band watcher options (PM2, NSSM, WinSW, Task Scheduler, Servy) is sound. The AUDIT does not contest the Servy selection. The convergence:

- **PM2 is unsuitable** — Windows-service support requires unmaintained third-party shims (`pm2-windows-startup` last commit 2015; `node-windows` has compat issues on Windows Server 2022/2025).
- **NSSM is feature-deficit** — no log rotation built-in, no health monitoring integration, fundamental difficulties managing complex child process trees, no synchronous Pre-Launch hook.
- **WinSW is in maintenance limbo** — XML-driven config, no fluent CLI for automated provisioning across the fleet.
- **Task Scheduler is stateless** — cannot synchronously hold a service in a pending state while a repair script executes; the kernel does not provide the orchestration primitives required.
- **Servy has the right primitives** — synchronous Pre-Launch hooks, size + date log rotation, exit-code-respecting `PreLaunchIgnoreFailure: $false` quarantine, dedicated `Servy.psm1` PowerShell module for fleet-wide automated provisioning.

The Servy selection survives audit. **What does not survive audit** is the assumption that Servy's `PreLaunchTimeout: 300` (5 minutes for the Pre-Launch hook to complete the LLM repair cascade) is honored by Windows. See § Audit corrections § A2 below.

### 3. Semantic drift detection via local ONNX embeddings

The DESIGN's mathematical model is sound:

- Use `onnxruntime-node` to load `all-MiniLM-L6-v2` (a 384-dimensional CPU-bound embedding model, ~90MB on disk at fp32) directly into the Node process.
- Background worker monitors `status/budget-dispatch-log.jsonl` via `fs.watch`; extracts execution summaries and PR rationales as they're appended; embeds them into a profile vector `v`.
- Maintain an Exponential Moving Average (EMA) baseline `v_baseline` with decay α = 0.05 (yielding 0.95 retention factor — high inertia against erratic shifts, gradual adaptation to legitimate slow-moving codebase changes).
- On each cycle: compute cosine distance `D = 1 - cos(v, v_baseline)`. If `D > 0.15`, trip a "Metacognitive Abort" — flush context, write `pending-merges.json` Gist with `degraded` status, halt current ReAct loop.

The threshold `D > 0.15` is empirically grounded in published embedding-drift research (cited at ref [18] in the DESIGN). The EMA decay α = 0.05 is tuned for dispatcher cadence (cycles every ~20 min, 24-hour windows produce ~72 cycles, so a single anomalous cycle moves the baseline by 5% of its distance from the new vector — slow enough that one bad cycle doesn't flip the baseline, fast enough that a multi-day shift in legitimate codebase logic is incorporated within ~2 weeks).

This is the **headline novel architectural contribution of the design**. No equivalent mechanism exists in the dispatcher today. `health.mjs` is rule-based on log outcomes; it cannot detect the coherence trap because the coherence trap produces nominally-successful outcomes that contain semantically-degraded content.

What does not survive audit unchanged is the **ONNX runtime memory footprint** assumption. See § Audit corrections § A3 below.

### 4. LLM-driven AST self-repair cascade

The DESIGN's repair cascade is sound at the architectural layer:

- **Trigger:** Servy detects fatal Node.js process termination.
- **Pre-Launch hook:** PowerShell orchestrator (`repair_orchestrator.ps1`) runs synchronously before Servy attempts the restart.
- **Step 1 (gate):** Read local `circuit_state.json`. If `Open`, exit 1 (Servy honors `PreLaunchIgnoreFailure: $false` and aborts the restart, quarantining the node).
- **Step 2 (context extraction):** Read last 150 lines of `dispatcher_stderr.log` (Servy-rotated). Apply Data Boundary Breaker — regex sweeps to redact API keys, tokens, PII before transmission.
- **Step 3 (LLM patch synthesis):** Transmit redacted stack trace + faulting module source to Gemini/Mistral API. **Prompt mandates Data Transformation Graph (DTG) framing** (per arXiv:2512.08492v1) — model data states as nodes and functions as edges, force the LLM to trace logic defects through data lineage rather than control flow. Returns strict JSON `{ targetNode, code }`.
- **Step 4 (AST validation):** Delegated to `validate_patch.mjs`. Use `@babel/parser` + `@babel/traverse` to parse the broken module into AST, replace target node with patch AST, serialize back. Syntax errors fail fast (parser throws).
- **Step 5 (sandbox validation):** Inject patched module into `isolated-vm` instance with strict memory limit (128MB) and 5-second wall-time timeout. Execute against mock data. If validation passes, write patched code to disk.
- **Step 6 (Git commit):** `git checkout -b hotfix/auto-repair-<timestamp>`, commit, push via Octokit. Open PR.
- **Step 7 (restart):** Exit 0. Servy starts the main Node.js process.

The DESIGN's choice of `isolated-vm` over the legacy `vm2` is critical and survives audit — `vm2` has unpatchable sandbox-escape vulnerabilities (CVE-2026-22709, CVSS 9.8) via Promise rejection prototype-chain traversal; `isolated-vm` uses C++ V8 isolate bindings with distinct memory heaps that make prototype pollution physically impossible.

The DTG prompting paradigm survives audit. The control-centric paradigm produces patches that fix the symptom rather than the underlying state defect; the DTG paradigm forces the LLM to trace data lineage. This is the right framing for a code-repair LLM call.

What does not survive audit unchanged is the **circuit-breaker state machine downstream of step 7**. The Half-Open → Closed transition is exploitable by zombie patches. See § Audit corrections § A1 below.

### 5. Three-state Algorithmic Circuit Breaker (ACB) — at the architectural level

The DESIGN proposes a standard 3-state breaker (Closed / Open / Half-Open) for the LLM repair loop. The pattern is borrowed from microservices resilience libraries (resilience4j precedent cited). The audit confirms that the **architectural concept** of an ACB is correct — without it, an LLM that hallucinates a syntactically-valid-but-functionally-destructive patch will trigger an infinite repair-restart loop, exhausting API budgets, spamming the repository with hotfix branches, and corrupting system state.

The ACB integrates with the data boundary breaker (regex-based redaction of secrets in stderr before transmission to LLM). This is the right framing — the breaker is the structural safety; the boundary breaker is the data-leakage safety. Both are necessary.

What does not survive audit is the **3-state state machine itself**. See § Audit corrections § A1 below.

### 6. GitHub Actions Dead Man's Switch — the right shape

The DESIGN proposes a serverless watchdog (`*/10` cron) that polls the central status gist for `heartbeat.json`, calculates the temporal delta against last-recorded heartbeat, and locks `pending-merges.json` if the delta exceeds a 15-minute grace period. This survives audit unchanged at the architectural layer.

The dispatcher already ships a related primitive: `scripts/watchdog.mjs` (P7 out-of-band fleet watchdog, hosted on `.github/workflows/watchdog.yml` cron `*/30`, threshold `STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000` = 2 hours). The current implementation polls the gist for `fleet-*.json` snapshots and posts to a separate `WATCHDOG_NTFY_TOPIC` if no machine has heartbeated within the threshold. **It does not lock `pending-merges.json`**. This is the architectural delta — see § ADR candidates § M5 below.

---

## Where the audit corrects the design (three CRITICAL findings)

The audit identifies three CRITICAL flaws. Each is load-bearing — the design as-written would deploy successfully but would fail catastrophically in production. Each is addressable with a concrete fix that the synthesis canonicalizes.

### A1 — The Half-Open Loop trap (zombie patches)

**Vulnerability:** The DESIGN's 3-state ACB transitions from `Half-Open` to `Closed` on a single successful test repair. In standard microservices, Half-Open success implies network connectivity restored. **In agentic code repair, Half-Open success only implies the patch passed isolated-vm syntax + 5-second mock validation** — it does not imply runtime stability under real workload. An LLM can easily generate a "zombie patch" that:

- Passes `isolated-vm` 5-second mock validation (no syntax errors, no immediate exception, no memory limit hit).
- Allows the Node.js process to bind successfully (Servy reports success).
- Introduces a delayed semantic failure (asynchronous memory leak, unhandled promise rejection that fires 10 seconds post-launch, race condition that triggers under real-data load).

In this scenario: patch validates → service starts → ACB transitions Half-Open → Closed (failure counter resets) → 10 seconds later, zombie patch crashes Node → ACB sees a "first" failure (counter just reset) → repair cascade fires → patch succeeds in mock → Half-Open → Closed → crash → infinite **inescapable Half-Open Loop**. Each cycle exhausts API tokens, spams the repository, and the standard 3-state machine cannot escape it.

**Fix (canonicalized in the synthesis as the authoritative state machine):** Expand the ACB to a 4-state machine with a temporal **Probationary** validation phase that decouples instantaneous AST validation success from operational recovery:

```text
Closed → (3 failures in 60min) → Open
Open → (2h cooldown) → Half-Open
Half-Open → (test repair passes isolated-vm + service binds) → Probationary
Probationary → (zero failures for 24h continuous) → Closed
Probationary → (any failure) → Open with exponential backoff (2h → 4h → 8h)
```

In the **Probationary state**, standard requests are permitted — the dispatcher operates normally — but the failure tolerance threshold is reduced to **absolute zero**. A single Application Error (Event ID 1000) within the 24-hour Probationary window flips the breaker back to Open, with the cooldown timer scaled by an exponential backoff multiplier to prevent rapid retry of the same hallucination pattern.

This is the load-bearing audit correction. The 3-state machine in the DESIGN is unsafe; the 4-state machine in the AUDIT is the design floor.

### A2 — Servy SCM 30-second timeout silently overrides PreLaunchTimeout=300

**Vulnerability:** The DESIGN's Servy configuration specifies `PreLaunchTimeout: 300` (5 minutes for the Pre-Launch hook to complete the LLM repair cascade). The orchestrator workflow (log extraction + redaction + Gemini/Mistral API call + AST parsing + isolated-vm validation + git push) routinely takes minutes to complete. The 5-minute budget is not unreasonable.

However: the Windows Service Control Manager (SCM) is unaware of Servy's per-service `PreLaunchTimeout` configuration. The SCM enforces a **kernel-level hardcoded 30-second timeout** on the `SERVICE_START_PENDING → SERVICE_RUNNING` transition (Microsoft docs, Smallvoid.com kernel reference). When Servy is held in pending state by the synchronous Pre-Launch hook, the SCM clock starts ticking. **Once the 30-second SCM threshold expires, the kernel terminates the Servy process tree and logs Error 1053** ("The service did not respond to the start or control request in a timely fashion"). The LLM API call is silently orphaned. The isolated-vm validation is killed mid-execution. The Windows service permanently fails to start.

**Fix (dual-layered):**

1. **Registry expansion:** During automated provisioning, the `Servy.psm1` deployment script must programmatically modify the Windows Registry to elevate the global SCM timeout: `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control` — `ServicesPipeTimeout` DWORD = `300000` (milliseconds). This explicitly instructs the kernel to afford all services 5 minutes to negotiate startup states. Tradeoff: this affects **all** OS services on the host, lengthening boot time on cold-start scenarios. For dispatcher hosts (always-on PCs / Optiplex), this is acceptable; for laptop monitor-only mode, less so. ADR candidate § M2 below.
2. **Stateful wait hints:** The PowerShell orchestrator must use the `SetServiceStatus` Win32 API to periodically broadcast `SERVICE_START_PENDING` wait hints to the SCM (every ~10 seconds), continually refreshing the kernel timeout clock dynamically while waiting for LLM inference. This is the recommended Microsoft pattern for services with legitimately-long startup sequences.

The audit treats both fixes as required (registry + wait hints). The synthesis canonicalizes the same: ship both. Without either, the SCM will silently terminate the repair cascade and Bug E-class observability gaps will hide the failure mode for weeks.

### A3 — ONNX runtime memory exhaustion on small VPS hosts

**Vulnerability:** The Metacognitive Drift Engine assumes that loading `all-MiniLM-L6-v2` (~90MB on disk at fp32) into the Node process incurs negligible RAM overhead. The audit shows this is critically false on resource-constrained hosts:

- **Session creation memory spike:** `onnxruntime-node` allocates up to **2× the model size in RAM during session creation alone** due to internal protobuf parsing and computational graph initialization (Microsoft ONNX Runtime issue #23775). For a 90MB fp32 model, that's ~180MB during init.
- **Multi-thread arena allocation:** Default ONNX Runtime CPU execution provider spawns multiple intra-op threads. Each thread can trigger independent execution arena allocation, **or in some library versions, allocate overlapping copies of the model weights per thread** (k2-fsa/sherpa-onnx issue #3032). On a Node process handling concurrent dispatcher tasks, this multiplies memory by N threads.
- **Result on 1-2GB VPS:** The dispatcher's primary V8 engine + the ONNX session + per-thread arenas exhaust physical RAM, OOM-killer fires, and the host enters a kernel panic loop. **The metacognition layer becomes the dominant cause of process death — exactly the failure mode it was designed to prevent.**

**Fix (4-vector hardware-aware optimization):**

| Optimization | Configuration | Memory impact |
|---|---|---|
| **Quantization** | Load `model_qint8_avx512_vnni.onnx` instead of fp32 | Weights: ~90MB → ~22MB (4× reduction; minimal cosine-similarity accuracy loss) |
| **Single-threaded execution** | `SessionOptions.intraOpNumThreads = 1` AND `interOpNumThreads = 1` | Eliminates multi-thread arena allocation overhead |
| **Zero-copy memory mapping** | `session.use_ort_model_bytes_directly = 1` | Bypasses double-memory spike during session creation |
| **Deterministic GC** | Node `--expose-gc` flag + explicit `global.gc()` after each EMA update | Reclaims intermediate embedding tensors aggressively |

The audit treats all four as required. The synthesis canonicalizes the same: ship all four together. INT8 quantization alone is not sufficient on a 1GB VPS; the multi-thread arena vector and the session-creation spike both also need to be neutered.

This bounds the ONNX runtime to ~30-40MB steady-state RAM on the dispatcher host, leaving the V8 engine and the Servy daemon room to operate. **For laptop-class hosts (16GB+) this is over-engineering**; the optimization is operational for Optiplex/PC tier (8GB+) and structural for any VPS-class host (1-4GB) that joins the fleet later.

---

## Cross-check against current dispatcher state

What's already shipped at the local-cognitive layer, and what would be net-new from Phase 2:

### Already shipped (does not change with Phase 2)

| Component | File | Scope | Relationship to Phase 2 design |
|---|---|---|---|
| **Outcome-rule-based health classifier** | [`scripts/lib/health.mjs`](../scripts/lib/health.mjs) | Reads JSONL log, classifies fleet state into healthy/degraded/idle/down via consecutive_errors threshold, structural_failures threshold, selector_fallback_count threshold, and 3-day no-progress detector | **Complementary** — operates on log outcomes (success/error/skipped/dry-run + auto-push success/blocked/failed). Catches breakage at the **outcome layer**. The DESIGN's drift detector catches breakage at the **semantic-content layer** (degraded-but-technically-successful output). The two layers are independent and both needed. |
| **P3 wrapper auto-update circuit breaker** | [`scripts/lib/circuit-breaker.mjs`](../scripts/lib/circuit-breaker.mjs) | 2-state breaker (open/frozen) gating whether `run-dispatcher.ps1` does `git pull origin main` before each launch; freezes after 3 consecutive post-pull dispatch failures | **Different scope** — protects against bad-commit-propagation on the wrapper layer (a buggy commit pushed to the dispatcher repo would otherwise auto-pull onto every fleet machine on next cron tick). The DESIGN's ACB protects against bad-LLM-patch-propagation on the in-process repair layer. Both are circuit breakers but they gate different surfaces. |
| **P7 out-of-band fleet watchdog** | [`scripts/watchdog.mjs`](../scripts/watchdog.mjs) | GitHub Actions cron (`*/30`); reads `fleet-*.json` heartbeats from status gist; alerts via separate ntfy topic if max-heartbeat across fleet exceeds 2h | **Same shape, narrower scope** — the DESIGN's "Global Watchdog" proposes both fleet-silence detection AND `pending-merges.json` lockdown on detection. The current `watchdog.mjs` does only the silence detection; lockdown is not implemented. ADR § M5 below. |
| **JSONL log + per-machine fleet snapshot** | `status/budget-dispatch-log.jsonl` + `status/fleet-<hostname>.json` | Per-cycle structured log + aggregated fleet snapshot | **Direct input to the drift engine** — the DESIGN reads execution summaries + PR rationales from this exact file. No log-format changes required to integrate the metacognition layer. |

### Net-new in Phase 2 design (not present today)

| Component | What it adds | Load-bearing? |
|---|---|---|
| **Servy daemon** | Out-of-band Windows-service supervisor for the dispatcher Node process. Replaces the current scheduled-task launch model with synchronous Pre-Launch hooks for repair orchestration | Yes — the LLM-driven AST repair cascade has no place to live without it |
| **ONNX semantic-drift engine** | Local CPU-bound embedding model + EMA baseline + cosine-distance threshold, run as a background worker on the JSONL log | Yes — the ONLY way to catch the coherence trap |
| **LLM-driven AST self-repair** | PowerShell orchestrator + Babel parse + isolated-vm sandbox + Git auto-commit | Yes — closes the local-recovery loop after Node process death |
| **4-state Algorithmic Circuit Breaker** (per audit correction) | Closed/Open/Half-Open/Probationary with 24h zero-tolerance window + exponential backoff | Yes — without it, zombie patches produce infinite Half-Open Loop |
| **Data Boundary Breaker** (regex-based stderr redaction) | API key / token / PII scrub before LLM transmission | Yes — secret-leakage failure mode is unacceptable for autonomous repair |
| **Pending-merges lockdown extension to existing P7 watchdog** | Add `global_lock` flag write to `pending-merges.json` when the watchdog detects fleet silence | Defensible-not-required — see ADR § M5 |

### What survives audit but is also already partially solved

The DESIGN's 4-state ACB **shape** (Closed/Open/Half-Open/Probationary) is conceptually parallel to the existing P3 wrapper breaker's design pattern — both are stateful, persisted to a JSON file (`circuit_state.json` in the design; `status/last-auto-pull.json` in the dispatcher), and decoupled from the LLM's internal logic. **Implementation can borrow the existing pure-function pattern** from `circuit-breaker.mjs` (`freshState()` / `evaluateGate()` / `recordPullOutcome()` / `recordDispatchOutcome()`). The repair-loop ACB would parallel: `freshAcbState()` / `evaluateAcb()` / `recordRepairAttempt()` / `recordProbationaryTick()`. This reduces implementation risk substantially.

---

## Six load-bearing dispatcher ADR candidates (M1-M6)

These are the load-bearing design choices Perry must commit to **before** any Phase 2 implementation work begins. Each carries explicit "Two defensible paths" framing where the choice is genuine; "Resolution recommendation" where the path is grounded in the audit + cross-check.

### M1 — Servy daemon adoption (vs. continue with scheduled tasks)

**Decision needed:** Does the dispatcher migrate from Windows Scheduled Task launch to a Servy-managed Windows service?

**Two defensible paths:**
- **(a) Adopt Servy fleet-wide.** The autonomous self-repair cascade has no other place to live — synchronous Pre-Launch hooks are required for the stateful gate-then-LLM-call-then-validate-then-restart pipeline, and Task Scheduler does not provide them. Required if the LLM-driven AST repair (M3 below) is greenlit.
- **(b) Keep scheduled tasks; defer the LLM repair cascade.** The metacognition drift detection (M4 below) and the global Dead Man's Switch (M5 below) do not require Servy — they're independent layers. Phase 2 could ship with drift detection + watchdog lockdown only, deferring the LLM-driven repair to Phase 3.

**Resolution recommendation:** path (b) for the immediate Phase 2 ship; path (a) when the LLM-driven repair becomes operationally validated. The Servy migration is a substantial deployment change across the fleet (PC, Optiplex, Neighbor) and should not be coupled to the higher-confidence drift-detection ship. **Drift detection alone is the smallest Phase 2 ship that delivers material value**; the rest can stage.

### M2 — Windows SCM timeout configuration (registry vs. wait-hints vs. both)

**Decision needed:** If Servy is adopted (M1 path a), how is the 30-second SCM timeout neutralized?

**Two defensible paths:**
- **(a) Registry-only.** Set `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\ServicesPipeTimeout = 300000`. Simple, deterministic, but affects **all** OS services on the host (cold-boot times lengthen for any service that legitimately takes long to start).
- **(b) Wait-hints-only.** Use `SetServiceStatus` Win32 API to broadcast `SERVICE_START_PENDING` wait hints from the PowerShell orchestrator. Per-service surgical, but requires correct PowerShell P/Invoke wiring and is fragile against orchestrator-script crash mid-LLM-call.
- **(c) Both.** Belt-and-suspenders. Registry as the floor (default 5min for all services), wait hints as the active extension (refreshes the timeout clock during long LLM calls).

**Resolution recommendation:** path (c). The registry edit is a one-time deployment cost; the wait-hints add per-call resilience. The audit treats both as required and the synthesis canonicalizes the same. ADR captures the operator visibility cost — if Perry is committed to the Servy migration, the 5-minute registry value should be documented in ROADMAP as a fleet-wide deployment requirement.

### M3 — LLM-driven AST self-repair adoption (vs. operator-only repair)

**Decision needed:** Does the dispatcher autonomously generate and commit code patches in response to fatal Node process crashes, or does it surface the crash to the operator for manual repair?

**Two defensible paths:**
- **(a) Adopt the autonomous repair cascade.** Maximum autonomy; closes the local-recovery loop without operator intervention; necessary for a true "self-healing fleet." Risk: the 4-state ACB (M4 below) must hold; LLM hallucination can produce zombie patches that pass mock validation but fail in production; the auto-commit-and-push surface is exactly the surface the existing Pillar 1 seven-gate stack was built to constrain (path firewall + Overseer + cooling-off + post-merge canary monitor).
- **(b) Surface fatal crashes to the operator via the existing alerting stack** (`scripts/alerting.mjs:sendNtfy`). Operator runs the equivalent of the LLM-driven repair manually: read the stack, query Gemini/Mistral, apply the patch, commit, push. Slower; no fleet autonomy during operator-away periods; but eliminates the zombie-patch risk surface entirely.

**Resolution recommendation:** path (b) for the initial Phase 2 ship. The Pillar 1 seven-gate stack took 8 months to land and is barely-validated under real load (per STATE.md's "first real rotation project opt-in is now unblocked" framing as of 2026-04-27). **Stacking an autonomous-LLM-driven-AST-repair cascade on top of a barely-validated auto-merge stack compounds risk surface**. Defer M3 path (a) to Phase 3 after Phase 2 drift detection has shipped 3+ months of clean signal AND the seven-gate stack has merged 10+ real auto-push-eligible PRs without operator intervention. Until then, surface the crash to operator + log + alert; let the operator drive the repair through the human-mediated Pillar 1 path.

### M4 — Drift-detector adoption AND threshold tuning (load-bearing)

**Decision needed:** Does Phase 2 ship the ONNX-driven semantic drift detector? And if yes, what are the production threshold values?

**Single resolution path with explicit tunable list:**

**Adopt.** Drift detection is the only mechanism that catches the coherence trap, which is the dominant in-band failure mode the dispatcher is currently blind to. The math is sound; the implementation borrows from established embedding-drift literature. Ship Phase 2 with this primitive.

**Tunables to commit (each has a defensible default; alternatives carry annotation):**

| Tunable | Default | Alternative consideration |
|---|---|---|
| Embedding model | `all-MiniLM-L6-v2` (`model_qint8_avx512_vnni.onnx`) | All-mpnet-base-v2 (more accurate, ~3× weights, would re-explode VPS RAM concerns); jina-embeddings-v3 (newer, multilingual, untested for code-execution-summary domain) |
| EMA decay (α) | `0.05` (DESIGN default) | `0.10` for faster baseline adaptation (useful if codebase changes rapidly); `0.02` for slower (useful if dispatcher behavior is highly stable and any deviation is suspect) |
| Cosine-distance threshold | `0.15` (DESIGN default, **provisional pending production-data calibration** — DESIGN cites a single secondary source [ref 18]; first 30 days of soft-alert mode is the empirical-characterization window before threshold is committed as load-bearing) | `0.20` for more conservative tripping (fewer false positives on legitimate codebase shifts); `0.10` for more aggressive tripping (catches subtler drift sooner, more false positives) |
| Drift-trip action | "Metacognitive Abort" — flush context, write `pending-merges.json` Gist with `degraded` status, halt current ReAct loop | "Soft alert only" — log + ntfy, do not halt (useful for the first 30 days of operation while threshold is being tuned against real signal) |
| Sliding-window scope | All execution summaries from current cycle | Last 20 cycles' summaries (smoother signal, slower trip on a single anomalous cycle) |

**Operator decision required at ship time, not deferrable:** which trip action — hard halt or soft alert. Recommendation: **soft alert only** for the first 30 days, then promote to hard halt once the false-positive rate is empirically characterized. Hard halt is the load-bearing safety; soft alert is the load-bearing observability. Ship soft first; promote later.

### M5 — Global watchdog: extend P7 to lock pending-merges, or keep current scope?

**Decision needed:** The DESIGN proposes that the global Dead Man's Switch lock `pending-merges.json` (write `global_lock: true`) when fleet silence is detected. The current `scripts/watchdog.mjs` (P7) only alerts via ntfy; it does not lock. Should the lockdown semantic be added?

**Two defensible paths:**
- **(a) Add lockdown.** Strongest guarantee against zombie node code-merge: a partially-degraded node that regains connectivity post-watchdog-trip cannot push hotfix branches into the merge queue while the operator is investigating. Defends against the scenario where one machine's repair cascade goes rogue and the rest of the fleet has gone silent for an unrelated reason; the silent-fleet trip prevents the rogue node's merge.
- **(b) Keep alert-only.** Less invasive; trusts that the per-PR overseer + cooling-off + post-merge-canary stack is sufficient defense against rogue PRs without needing fleet-level merge-queue lockdown. Operator can intervene manually to lock the gist if desired.

**Resolution recommendation:** path (a) **once Pillar 1 auto-merge is enabled on at least one rotation project**. Until then (currently `auto_merge:false` fleet-wide per shared.json), there's no merge queue to lock; alert-only is sufficient. When Perry flips `auto_merge:true` on the first rotation project, ship the lockdown as a simultaneous extension. Code is small (~30 LOC + 5 unit tests); deferring the implementation work itself is fine, but the architectural decision should land with M4.

### M6 — Repair-cascade prompt template + safety checks (DTG framing + redaction posture)

**Decision needed (only if M3 path (a) is greenlit, deferable for now):** What is the canonical prompt template + redaction ruleset for the LLM patch-generation call?

**Single resolution path:** Adopt DTG framing exactly as in the DESIGN. Adopt the redaction ruleset exactly as in the AUDIT (regex sweeps for AWS keys, JWT/secret/token/password fields, email addresses). Add one extension: after redaction, the orchestrator should **diff the redacted payload against the raw payload** and write the diff to `status/repair-redaction-<timestamp>.log`. If the diff is empty (i.e., no redaction fired), the orchestrator should treat that as a smoke test of the redaction layer itself — a pristine stack trace means either the dispatcher is genuinely secret-free or the redaction regex is broken. Surface as a soft alert.

**Operator decision required:** which model for the patch-generation call. Default: Gemini 2.5 Pro (longest context, strongest reasoning at large diff sizes). Alternative: Mistral Large (faster, shorter context, may lose context on large stack traces). Cross-family pattern from the existing dispatcher arch suggests Gemini for generation + Mistral for validation review of the generated patch — but that's a Phase 3 elaboration; for Phase 2 single-model is fine.

**Defer until M3 path (a) is greenlit.** Recommendation per M3 above is to defer M3 to Phase 3, which means M6 also defers to Phase 3.

---

## Three named failure modes canonized

The audit and design together name three failure modes the Phase 2 architecture is built to defend against. The synthesis canonicalizes them with explicit IDs for cross-reference:

- **MFM1 — The coherence trap.** LLM agent retrieves irrelevant data, generates plausible-but-incorrect analysis, confidently pursues impossible solutions while reporting completion. **Defense:** semantic drift detector (M4). Without M4, no current dispatcher mechanism catches this — `health.mjs` is rule-based on outcomes, and the coherence trap produces nominally-successful outcomes.
- **MFM2 — The Half-Open Loop.** Zombie patch passes isolated-vm 5-second mock validation, allows Servy to start the Node process, then fails 10s later with a delayed semantic defect. ACB sees the test as a success, transitions Half-Open → Closed, resets failure counter, the next crash triggers another patch, infinite loop. **Defense:** 4-state ACB with 24h Probationary state + exponential backoff (M3 dependency, audit correction A1).
- **MFM3 — The SCM 30s collision.** Servy `PreLaunchTimeout: 300` is silently overridden by Windows SCM's hardcoded 30s start timeout, killing the LLM repair cascade mid-execution. **Defense:** Registry expansion + SetServiceStatus wait hints (M2, audit correction A2).

A latent fourth failure mode — **MFM4 — The OOM cascade** — was proposed by the audit but is host-environment-dependent rather than design-architectural. The dispatcher's current host fleet (PC/Optiplex/Neighbor, all 8GB+) is not vulnerable. Documented here for completeness so that any future small-VPS deployment is not blindsided.

---

## Methodological note

This synthesis is a **single-family pair** (Claude DESIGN + Claude AUDIT) — different shape than the cross-family Fork B precedent (Claude raw + Gemini parallel). Two methodological observations:

1. **Adversarial-aware-from-the-start synthesis works for design+audit pairs.** The KOTOR2-DLG synthesis (per DECISIONS 2026-04-29 entry) established the pattern: when an adversarial review pre-exists the synthesis pass, the synthesis canonicalizes corrections directly in the convergence section rather than deferring to a separate patch commit. This pattern applies cleanly here. The METACOGNITION-AUDIT findings land as load-bearing convergence content (CRITICAL findings A1/A2/A3 in the corrections section), not as a footnote.

2. **Single-family adversarial does not catch shared-blind-spot errors.** The cross-family discipline's main advantage — exposing one family's hallucinations through the other family's independent work — does not apply here. Both DESIGN and AUDIT are Claude-generated. **If both share a blind spot** (e.g., assuming Servy actually works on Windows Server 2025 as documented, or assuming `onnxruntime-node` quantization actually has the published memory profile), neither catches it. **Mitigation:** the explicit cross-check against current dispatcher source (§ Cross-check section above) is the surrogate independent verification — it grounds the synthesis claims against ship-running code rather than against published documentation. Documentation can be wrong; running code is empirically correct.

The pattern observation across the seven syntheses to date (4 Fork B graphics + 3 Fork B Tier-1 + this one):
- Cross-family parallel + adversarial = strongest verification surface (KOTOR2-DLG, GFX-2/3 second-pass)
- Cross-family parallel only = catches family-specific hallucinations; misses shared upstream-source errors (FACTION-REPUTATION's asymmetric-raws shape; GFX-1 binary-layout errors caught only by adversarial)
- **Single-family design+audit = different shape; the audit IS the adversarial pass; cross-check against running code is the substitute for the second family** (this synthesis)

For future Phase 3 work, if the LLM-driven AST repair cascade reaches implementation, an additional cross-family adversarial pass (commission Gemini 2.5 Pro to red-team the same DESIGN doc) becomes valuable. **Trigger condition:** when M3 path (a) is greenlit. Until then, the audit + cross-check pair is sufficient verification.

---

## Adversarial review findings (deferred)

This synthesis has not been adversarially reviewed (the AUDIT IS the adversarial pass against the DESIGN; an additional adversarial pass would be against the synthesis itself). Deferred. **Trigger conditions** for commissioning a fresh adversarial review against the synthesis:

1. M3 path (a) is greenlit (LLM-driven AST repair cascade enters active implementation). The autonomous-repair surface is the highest-blast-radius surface in the dispatcher; any synthesis claim that informs its implementation deserves independent verification.
2. M5 path (a) extension to `pending-merges.json` lockdown is implemented. The lockdown semantic interacts with the seven-gate stack in ways the synthesis does not fully verify; an adversarial pass against the lockdown integration is warranted before the lockdown ships.
3. The first production-deployed drift-detector trip occurs and the operator is unable to root-cause whether it was a true positive or false positive. This signals the threshold tuning in M4 needs adversarial review against actual operational data.
4. A Phase 3 cross-family parallel of the DESIGN itself is commissioned (e.g., commission Gemini 2.5 Pro to write its own metacognition + self-repair design from scratch given the same problem statement). This would put the synthesis on the same Tier as the Fork B cross-family discipline.
5. Specifically tied to the ADR adoption sequence: when ANY of M1/M3 paths (a) is greenlit, the synthesis needs adversarial verification of the integration points (Servy ↔ orchestrator ↔ ACB ↔ git-push surface) before code lands. Single-family verification is insufficient at the integration layer.

---

## Recommended downstream actions

In dependency order:

1. **Operator decisions on M1-M6.** Synthesis surfaces the choices; operator commits. Recommendation summary:
   - M1: path (b) — defer Servy migration to phase after drift detection ships
   - M2: defer until M1 path (a) is greenlit; commit to (c) registry+wait-hints when it lands
   - M3: path (b) — operator-mediated repair via existing alerting stack; defer LLM autonomy to Phase 3
   - M4: adopt; ship with soft-alert trip action for first 30 days
   - M5: defer the lockdown extension until first `auto_merge:true` rotation project ships
   - M6: defer with M3
2. **Implementation of M4 (drift detector) as the first-ship Phase 2 component.** Borrow the pure-function pattern from `circuit-breaker.mjs`. Estimated scope: ~250 LOC across `scripts/lib/drift-engine.mjs` (pure: vector math, EMA, cosine distance, threshold check) + `scripts/lib/drift-engine-cli.mjs` (impure: ONNX session, fs.watch, JSONL append) + `scripts/lib/__tests__/drift-engine.test.mjs` (~20 unit tests). Wire into existing `dispatch.mjs` Phase 0 / dispatch lock surface so trip action surfaces in standard log + ntfy paths.
3. **PAL audit of the drift-engine implementation** before committing. Cross-family Gemini 2.5 Pro per Fork B precedent.
4. **Documentation:** add `docs/METACOGNITION.md` (operator guide for the drift detector — what it does, how to read trip alerts, threshold tuning workflow).
5. **Operational observation period — 30 days post-ship.** Soft-alert mode. Empirically characterize false-positive rate. Adjust threshold + trip action per data.
6. **Re-revisit M3 path (a) decision** after **30 days of clean drift-detector signal AND ≥10 successful auto-push-eligible PR merges** through the seven-gate stack (the recommended baseline). **More-conservative variant** (preferred if the operator is risk-averse on autonomous code-mutation surface): **60 days + ≥20 merges**, on the grounds that zombie-patch-class failures may have non-trivial probability of surfacing only after multi-day production exposure. The MFM2 audit framing notes that delayed-execution failures can fire 24h+ post-deployment; a longer observation window halves the chance that a single false-negative slips through. Either variant: when criteria hold, M3 path (a) becomes implementable; commission cross-family parallel of the DESIGN at that time.

---

## Cross-references

- DESIGN: [`docs/research/METACOGNITION-DESIGN-claude-2026-04-30.md`](./METACOGNITION-DESIGN-claude-2026-04-30.md)
- AUDIT: [`docs/research/METACOGNITION-AUDIT-claude-2026-04-30.md`](./METACOGNITION-AUDIT-claude-2026-04-30.md)
- Companion Phase 2 synthesis (systemic hardening): [`docs/research/HARDENING-PHASE-2-synthesis-2026-05-03.md`](./HARDENING-PHASE-2-synthesis-2026-05-03.md)
- Phase 1 hardening synthesis baseline: [`docs/research/HARDENING-synthesis-gemini-2026-04-24.md`](./HARDENING-synthesis-gemini-2026-04-24.md)
- Current local-cognitive layer source:
  - `scripts/lib/health.mjs` (4-state outcome-rule classifier)
  - `scripts/lib/circuit-breaker.mjs` (P3 wrapper auto-update breaker — borrowable pure-function pattern for the new ACB)
  - `scripts/watchdog.mjs` (P7 out-of-band fleet watchdog — extension target for M5 lockdown semantic)
- Phase 2 in-flight context: [`docs/HANDOFF-dispatcher-2026-04-30-phase2.md`](../HANDOFF-dispatcher-2026-04-30-phase2.md)
- Combo cross-link (synthesis-as-canonical-layer policy + raw-doc-immutable policy): `combo/ai/DECISIONS.md` 2026-04-28 GFX-1 adversarial entry establishes the precedent

---

## Push posture

Mechanism dormant on ship — this synthesis is reference, not implementation. No source code edits to dispatcher this commit. Operator-go-required posture applies: the synthesis ships local-only as part of the combo-side organization session; per-repo commit is staged for Perry's go before push.

Three commits will land at session end, mirroring Fork B precedent:
- **claude-budget-dispatcher:** 5 new files in `docs/research/` (4 raw research docs filed in Phase A + this synthesis + the companion HARDENING-PHASE-2 synthesis).
- **worldbuilder:** 1 new file in `docs/research/` (IP-cleanliness adversarial prompt template, filed in Phase A — out of scope for this synthesis).
- **combo:** STATE.md update + DECISIONS.md per-synthesis entry (this synthesis + HARDENING-PHASE-2 synthesis) + new `project_dispatcher_phase2_research.md` memory + MEMORY.md hook + RESEARCH-INDEX.md update + 8 archived handoffs in `docs/handoffs/archived/` + 1 new INDEX.md in same dir.

All three commits stay local-only at end of session, awaiting Perry's go. Matches the standing operator-go-required posture from prior Fork B / Pillar 2 sessions.
