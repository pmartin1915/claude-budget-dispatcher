# HARDENING + Autonomy Phase 2 — synthesis

_Cross-doc synthesis of the Phase 2 hardening + autonomy audit (`HARDENING-PHASE-2-AUDIT-claude-2026-04-30.md`, the strategy doc) against the Phase 2 tactical roadmap (`HARDENING-PHASE-2-ROADMAP-claude-2026-04-30.md`). Single-family pair (Claude strategy + Claude tactics) — strategy ↔ tactics, complementary rather than competing. Convergence is the dominant section; divergence is thin._

_Synthesized 2026-05-03 by Opus 4.7 1M (laptop). PAL audit completed 2026-05-03 (Mistral Large 2 cross-family — Gemini 2.5 Pro free-tier daily quota exhausted; same C-1 cross-family discipline as B.1 metacognition synthesis). Audit returned 2 CRITICAL + 3 HIGH + 3 MEDIUM + 2 LOW findings; on critical evaluation, 5 of 8 critical/high/medium were misreads of the synthesis (the synthesis already addresses each), 3 produced minor clarifying edits this revision (StrykerJS incremental-vs-full-suite distinction, Overseer false-negative-rate explicit acknowledgment, H1→H2 dependency note), 2 LOW were rejected (philosophical reframing + commit-hash references not used in dispatcher convention). Net: 0 load-bearing changes from audit. Mechanism dormant on ship — surfaces six load-bearing dispatcher ADR candidates (H1-H6, plus added-during-cross-check H7) for explicit operator decision before any Phase 2 implementation work begins. Continuation of the April hardening arc (`HARDENING-{gemini,gpt}-2026-04.md` + `HARDENING-synthesis-gemini-2026-04-24.md` baseline)._

---

## Reading order (read first)

This is the **canonical layer** over the strategy + tactics pair. For implementation work, read in this order:

1. **`HARDENING-synthesis-gemini-2026-04-24.md`** — the **Phase 1 baseline** synthesis. Establishes what shipped in the April hardening arc (S-series findings; the 12-category dispatcher security audit; ConfigDriftError; subprocess-verify; push-based heartbeat to gist; sentinel auto-remediation). Read first to understand the current shipped state.
2. **`HARDENING-PHASE-2-AUDIT-claude-2026-04-30.md`** — the strategy. Identifies P0/P1/P2 priorities for Phase 2: P0 (safety boundaries — silent failure vector eradication), P1 (robustness — distributed heartbeat upgrade + Sentinel auto-remediation), P0/P1 Overseer intelligence (AST + mutation + DCTD), P2 (autonomous hardening — probabilistic allowlist expansion + automated canary bisection).
3. **`HARDENING-PHASE-2-ROADMAP-claude-2026-04-30.md`** — the tactics. Provides specific implementations: AST entropy via `@babel/parser` + Jensen-Shannon divergence; StrykerJS mutation testing in incremental mode + AST-traversal-based assertion-density check; DCTD via `node:inspector` + `Profiler.startPreciseCoverage`; isolated-vm sandbox for smoke runs (vm2 prohibited per CVE-2026-22709); GPG-signed Octokit commits for allowlist expansion; `git bisect run` with exit-code-125 for ambiguous commits. Also names two newly-discovered silent-failure vectors: `@octokit/plugin-throttling` for GitHub rate-limit handling, and `child_process` IPC severance watchdog timers.
4. **This synthesis** — what survives both layers, what's already shipped in the dispatcher today (significant overlap with the AUDIT's P0/P1 items per the ROADMAP's own retro), and the six ADR candidates Perry must commit to before any Phase 2 implementation work begins.
5. **The dispatcher source** — current state of the systemic-hardening layer:
   - `scripts/lib/subprocess-verify.mjs` (P0 shell-sinkhole fix — already shipped)
   - `scripts/lib/health.mjs` (4-state outcome-rule classifier — partial coverage of the AUDIT's P1 telemetry concerns)
   - `scripts/lib/circuit-breaker.mjs` (P3 wrapper auto-update breaker — pattern reusable for new gates)
   - `scripts/watchdog.mjs` (P7 out-of-band fleet watchdog — partial coverage of the AUDIT's P1 Sentinel concept)
   - `scripts/lib/auto-push.mjs` (gate 4 canary — extension target for probabilistic allowlist)
   - Recent commits `4bbf348 Phase 2 Task 4: Octokit rate limiting and IPC watchdogs` (already addresses two of the ROADMAP's silent-failure findings)

The AUDIT is architecturally sound at the macro layer (silent-failure taxonomy + heartbeat-as-foundation + Overseer-as-semantic-firewall + autonomous-allowlist-expansion + automated-bisection-for-Gate-7). The ROADMAP grounds the AUDIT's strategy with specific tool choices, configuration schemas, and code patterns. Together they form a coherent Phase 2 architecture that builds on the Phase 1 hardening baseline.

---

## Convergence (load-bearing design choices both docs ground)

The strategy and tactics agree on six architectural moves. Each survives the cross-check against the current dispatcher state. Material overlap with already-shipped work is flagged inline.

### 1. Silent-failure-vector taxonomy as the organizing frame

Both docs treat **silent failure** as the dominant failure-mode class for an autonomous LLM-driven dispatcher fleet, distinct from the deterministic-software failure modes (stack traces, segfaults, HTTP error codes) that traditional CI tools were built for. The taxonomy:

- **Interactive shell sinkholes** — terminal commands that the OS reports as exited-zero but never actually executed (block-paste mode, modal dialogue, input-buffer absorption). **Already addressed** in Phase 1 per `subprocess-verify.mjs` + the ROADMAP's intro retro ("verifiedExec subprocess wrapper neutralized the critical Interactive Shell Sinkhole"). Net-new in Phase 2: extend the verification pattern to cover IPC channel collapse in `child_process.fork()` (see § 6 below).
- **Configuration drift** — layered JSON parsing where `local.json` overrides `shared.json` and a malformed `local.json` silently produces an empty config object that the dispatcher treats as "no overrides"; missing `.env` variables silently default to `undefined`; LLM agents resilient-by-design retry through missing API keys masking the underlying drift. **Already addressed** in Phase 1 per `ConfigDriftError` + fail-fast startup validation. Net-new in Phase 2: the AUDIT's call to enforce schema validation at boot for every required config field (Zod or Joi). The dispatcher's existing `scripts/lib/schemas.mjs` (per STATE.md / `R-1` in DECISIONS) implements ajv-based validation for LLM audit responses; extending the same pattern to config schemas is the natural Phase 2 extension.
- **Agentic conformity bias** — chained LLM agents inherit upstream hallucinations as ground truth; downstream agents do not challenge or validate, they conform. **Net-new in Phase 2**. The AUDIT's mitigation is "deterministic boundaries between agent handoffs" (regex / schema validation / AST analysis at every gate); the ROADMAP's specific implementation is the Overseer intelligence stack (§ 2 below).
- **GitHub API throttling vs `retry-after` header** — primary 403/429 limits return `x-ratelimit-reset`; secondary limits return `retry-after`; without comprehensive interception, unhandled promise rejections silently terminate worker threads while heartbeat keeps pulsing. **Partially addressed** in commit `4bbf348 Phase 2 Task 4: Octokit rate limiting and IPC watchdogs` per recent dispatcher log. The ROADMAP's specific recommendation (`@octokit/plugin-throttling` + `@octokit/plugin-retry`) likely matches the implementation; verification needed.
- **`child_process` IPC severance** — child crashes mid-execution → `subprocess.send()` on disconnected channel fails silently rather than throwing → parent enters infinite-wait state for a JSON payload that never arrives → heartbeat keeps pulsing → Sentinels can't identify the node as dead. **Partially addressed** per same `4bbf348` commit. The ROADMAP recommends per-IPC-promise watchdog timer + monitoring `disconnect`/`error`/`exit` lifecycle events; verification needed.

This taxonomy is load-bearing convergence and should be the canonical vocabulary for any future failure-mode discussion in the dispatcher.

### 2. Overseer intelligence — three-layer semantic-firewall stack

Both docs converge on the **Overseer (gate 5)** as the load-bearing semantic-firewall for LLM-generated PRs. The current Overseer is **read-only label-applying** per Pillar 1 step 3 (per STATE.md 2026-04-27 entry). Phase 2 upgrades it to a **multilayer verification engine** with three protocols:

- **AST-driven duplication + structural-entropy analysis** — `@babel/parser` parses incoming diff and target codebase; normalize ASTs by stripping identifiers/literals while preserving operation-type nodes (`LogicalExpression` / `CallExpression` / `IfStatement` / `ReturnStatement`); calculate **Jaccard similarity** for surface-level duplication detection AND **Jensen-Shannon divergence** for deep topological hallucination detection. Reject PRs where structural cross-entropy exceeds threshold (configurable in `shared.json`; ROADMAP default `2.5`). Failure mode this defends against: LLM reinvents a custom retry-loop when the project already has a global backoff library.
- **Mutation testing + assertion density** — StrykerJS in incremental mode (`stryker.config.json`: `incremental: true`) runs mutation testing on the incremental diff only (uses `reports/stryker-incremental.json` for state). Reject if mutation score < `overseer.min_mutation_score` (ROADMAP default 85% for core utilities). Plus static AST traversal counts `expect()` `CallExpression` nodes; reject if assertion-to-test-block ratio < `overseer.min_assertion_density` (ROADMAP default 1.0). Failure mode this defends against: LLM generates 100% line-coverage tests with weak assertions that pass even when the application logic is mutated.
- **Dynamic Canonical Trace Divergence (DCTD)** — instrument the test runner with `node:inspector` Session + `Profiler.startPreciseCoverage` to capture function-call counts and byte-offset coverage; compare candidate's opcode probability mass function (PMF) against baseline PMF via Jensen-Shannon divergence; reject if Behavioral Expression Factor (BEF) exceeds threshold. Failure mode this defends against: LLM ships a functionally-correct algorithm with O(N²) runtime when O(N log N) is implicitly required.

All three protocols are **net-new**; none is currently in the dispatcher. The Overseer (`scripts/overseer.mjs`) currently does cross-family Gemini/Mistral semantic review and applies `overseer:approved` / `overseer:rejected` / `overseer:abstain` labels — this is the **pre-AST** gate. Phase 2 adds the AST/mutation/DCTD layers as gates between cross-family review and label application.

### 3. Probabilistic allowlist expansion — the autonomy growth mechanism

Both docs converge on the path firewall (gate 1) being the wrong shape for long-term autonomy. The current model is **rigid + deterministic**: per-project `auto_push_allowlist` arrays in `shared.json` / `local.json` block any path outside the allowlist; expansion requires manual operator edit. The Phase 2 model is **probabilistic + verifiable**:

- Agent encounters blocked path → dispatcher orchestrates **sandboxed smoke run** (isolated-vm; ROADMAP-mandated, vm2 explicitly prohibited per CVE-2026-22709 prototype-pollution sandbox-escape).
- Smoke run is non-destructive (dry-run lint, in-memory build, etc.) with strict resource limits (memory cap, CPU timeout).
- If smoke run succeeds → agent generates a **DISPATCH.md modification PR** that's **GPG-signed via Octokit `git.createCommit` API** (signature parameter populated from local bot service account key; GitHub validates and attaches "Verified" badge).
- Overseer (operating with elevated privileges outside the sandbox) evaluates the proposal against global organizational constraints; if approved, the allowlist expansion merges and the path firewall organically widens.

This mechanism transforms gate 1 from a **rigid barrier** into a **verifiable security perimeter**. The strategy framing is in the AUDIT § P2; the tactical implementation is in the ROADMAP § Autonomous Hardening § Implementation Architecture: auto-push.mjs Modification.

### 4. Automated canary bisection — Gate 7 evolution

Both docs converge on `git bisect run` as the right algorithmic primitive for Gate 7 (post-merge canary monitor) failure response. Current Gate 7 is **fail-closed**: any canary failure auto-suspends the project (per STATE.md 2026-04-27). Phase 2 makes it **self-diagnosing**:

- Canary fails at Gate 7 → dispatcher intercepts standard suspension → initializes `git bisect start` with current HEAD as `bad`, last-known-stable-tag as `good` (queried from telemetry gist).
- Generates a deterministic predicate script (`canary-bisect.sh`) that returns exit `0` for clean, `1-124` for failure, `125` for ambiguous (uncompilable / unreachable test environment / transient external dependency failure).
- `git bisect run ./scripts/canary-bisect.sh` performs binary search in O(log n) commit-history time, automatically skipping ambiguous commits via exit-125.
- Once isolated, dispatcher extracts the localized diff via `git show <bad-commit>` and feeds it to a fresh LLM context for autonomous root-cause analysis + hotfix PR generation.
- `git bisect reset` restores repository to original state.

This is the load-bearing Phase 2 evolution of Gate 7. Without it, Gate 7's binary fail-closed behavior negates the velocity benefits of autonomous code generation. The ROADMAP's pseudocode in `dispatch.mjs` § Automated Canary Bisection Module is the implementation skeleton.

### 5. Distributed heartbeat upgrade — Sentinel pattern

Both docs converge on extending the current passive `watchdog.mjs` (P7 fleet-silence detector) to an **active reconciliation loop**:

- **Push-based heartbeat from every active node** at staggered/jittered cadence to avoid GitHub rate-limit collisions. Payload extends beyond simple liveness boolean: `node_id` (UUID) + `last_active_timestamp` (epoch) + `current_task_hash` (SHA-256 of repo+branch+commit) + `environmental_health` (object: API key validation, disk space, etc.) + `drift_velocity` (probabilistic deviation from historical baseline).
- **Sentinel role** dynamically elected via consensus or assigned to primary control node; continuously parses gist; calculates temporal delta against `last_active_timestamp` for every registered node.
- **Multi-miss threshold** (ROADMAP suggests 3 consecutive misses) prevents false positives from transient network congestion / CPU throttling. Single miss → status `degraded`; three misses → status `dead`.
- **Idempotent task re-registration** on dead node: extract `current_task_hash` from deceased node's last state payload; forcefully re-register into global pending queue; healthy idle node claims it on next load-balancing cycle.
- **Self-imposed suspension** at the node level: if node detects its own degradation (revoked API key, unmounted volume, file permission loss), it must update its own gist state to `suspended` and release task lock without waiting for Sentinel to declare it dead.

The current `watchdog.mjs` implements **fleet-silence detection** (max-heartbeat-across-fleet > 2h → ntfy alert) but does **not** implement: (a) per-node multi-miss thresholding; (b) Sentinel role with task re-registration; (c) self-imposed suspension. These are the net-new Phase 2 layers.

### 6. Hardening of newly-discovered silent-failure vectors

The ROADMAP names two specific silent-failure vectors that the AUDIT identifies as a category but doesn't enumerate:

- **GitHub API rate-limiting comprehensive interception** — `@octokit/plugin-throttling` + `@octokit/plugin-retry` automatically queue requests, parse `x-ratelimit-reset` and `retry-after` headers, apply exponential backoff. **Partially shipped** per commit `4bbf348`. Phase 2 verification needed: are both plugins wired? Is the throttling plugin's queueing applied to all Octokit calls in `dispatch.mjs` + `overseer.mjs` + `auto-push.mjs` + `post-merge-monitor.mjs`?
- **`child_process` IPC severance watchdog** — explicitly monitor `disconnect` / `error` / `exit` lifecycle events; bind localized watchdog timer to every IPC promise; on severance or threshold-exceed, manually reject promise + emit explicit failure log to gist. **Partially shipped** per same commit.

The convergent recommendation is: extend the `verifiedExec` pattern from interactive shells (Phase 1) to cover IPC channel collapse (Phase 2). The pattern is the same — never trust binary exit codes; always verify the expected positive signal happened.

---

## Where the docs diverge (thin section)

The strategy + tactics pair is **complementary**, not competing — divergence is mostly framing/scope, not facts. Three minor divergences worth canonicalizing:

- **AUDIT proposes Zod or Joi for config schema validation; ROADMAP doesn't specify the tool.** The dispatcher's existing `schemas.mjs` uses ajv (per DECISIONS R-1). For schema-stack consistency, **prefer ajv** for the Phase 2 config-schema extension. No new dependency required.
- **AUDIT frames Sentinel as "dynamically elected via consensus algorithm or permanently assigned"; ROADMAP defaults to permanently assigned (a primary control node).** For the dispatcher's actual fleet shape (laptop monitor-only + 3 active PCs + Optiplex + Neighbor), permanent assignment to a single Sentinel is structurally fragile (the Sentinel itself becomes a SPOF). A **stateless Sentinel** running as a GitHub Actions cron — same pattern as the existing `scripts/watchdog.mjs` — is the cleanest fit. Sentinel logic runs out-of-band of any individual fleet node; it doesn't matter which physical machine the cron lands on. Resolution: ship the Sentinel as a `scripts/sentinel.mjs` GitHub Actions cron, not as a daemon on a designated control node.
- **AUDIT recommends StrykerJS, mutmut, or PIT for mutation testing; ROADMAP commits to StrykerJS.** StrykerJS is the right choice for this codebase (Node.js + JavaScript). Resolution: StrykerJS only.

---

## Cross-check against current dispatcher state

What's already shipped at the systemic-hardening layer, and what would be net-new from Phase 2:

### Already shipped (does not change with Phase 2)

| Component | File | Audit/Roadmap concern addressed |
|---|---|---|
| **Interactive shell sinkhole fix** | [`scripts/lib/subprocess-verify.mjs`](../scripts/lib/subprocess-verify.mjs) | AUDIT § P0 Interactive Shell Sinkholes; ROADMAP intro retro confirms |
| **Config drift fail-fast** | `ConfigDriftError` + `validateConfigCompleteness` (per recent commits `9557078`/`5419123`) | AUDIT § P0 Configuration Drift; ROADMAP intro retro confirms |
| **Push-based heartbeat to gist** | `status/fleet-<hostname>.json` writes (per `scripts/lib/health.mjs:writeHealthFile`) | Partial — covers heartbeat-write side of AUDIT § P1; missing the multi-miss-threshold + Sentinel-election + task-re-registration side |
| **Out-of-band fleet-silence detector** | [`scripts/watchdog.mjs`](../scripts/watchdog.mjs) | Partial — covers fleet-wide silence detection (max-heartbeat threshold); missing per-node multi-miss + task-re-registration |
| **Selector fallback degraded-rate detection** | C2/C3 in `scripts/lib/health.mjs` (`FALLBACK_DEGRADED_THRESHOLD = 3`) | Cross-cuts AUDIT § P1 (silent-failure detection at the LLM-quota layer) |
| **No-progress detector (3-day stuck push)** | `evaluateNoProgress` in `scripts/lib/health.mjs` | Cross-cuts AUDIT § P1 (silent-failure detection at the auto-push-blocked layer) |
| **GitHub API rate-limit handling + IPC watchdog** | Per commit `4bbf348 Phase 2 Task 4: Octokit rate limiting and IPC watchdogs` | ROADMAP § Safety Boundaries: Discovering Remaining Silent Failures § Undocumented Subprocess and API Stall Vectors — verify both plugins are wired and IPC watchdog is bound to all `child_process.fork()` call sites |
| **Cross-family Overseer (gate 5) — semantic review** | `scripts/overseer.mjs` (read-only label-applying; Gemini/Mistral cross-family) | Pre-AST layer of the proposed three-layer Overseer-intelligence stack; Phase 2 adds the AST/mutation/DCTD layers below it. **Important caveat:** cross-family agreement does NOT guarantee correctness — when both Gemini and Mistral hallucinate identically (rare but observable), the cross-family check passes silently. The H1+H2 deterministic gates are the primary defense against this failure mode; cross-family review is the first-line filter, not the safety floor |
| **Auto-push canary (gate 4)** | [`scripts/lib/auto-push.mjs`](../scripts/lib/auto-push.mjs) | Extension target for probabilistic-allowlist M-mechanism (sandboxed smoke run + GPG-signed expansion PR) |
| **Schema validation pattern (ajv)** | `scripts/lib/schemas.mjs` | Reusable pattern for the AUDIT's call to enforce config schema validation at boot |

### Net-new in Phase 2 design (not present today)

| Component | Load-bearing? | ADR ref |
|---|---|---|
| **AST entropy analyzer in Overseer** | Yes — only mechanism to catch agentic structural duplication | H1 |
| **StrykerJS mutation testing in Overseer** | Yes — only mechanism to catch high-coverage low-assertion test hallucination | H2 |
| **Static AST assertion-density check** | Yes — lighter-weight + deterministic complement to mutation testing | H2 |
| **DCTD via `node:inspector` Profiler** | Defensible-not-required — catches algorithmic-complexity regressions; brittle implementation | H6 |
| **isolated-vm sandbox for smoke runs** | Yes if M-mechanism (allowlist expansion) is greenlit | H3 |
| **GPG-signed Octokit allowlist-expansion PRs** | Yes if M-mechanism greenlit | H4 |
| **`git bisect run` Gate 7 self-diagnostic** | Defensible-not-required — converts fail-closed to self-diagnosing; substantial complexity surface | H5 |
| **Stateless GitHub-Actions Sentinel** (extension to existing P7 watchdog) | Yes — multi-miss-threshold + task-re-registration close the autonomous-recovery loop | H7 (added below) |
| **Config schema validation via ajv** at boot | Yes — extends already-shipped fail-fast pattern | (folded into existing pattern; not a separate ADR) |

### What survives audit but is also already partially solved

The dispatcher's existing **outcome-rule-based health classifier** + **selector-fallback detector** + **no-progress detector** + **2h fleet-silence watchdog** together cover a substantial portion of the AUDIT's P1 telemetry concerns. The Phase 2 additions are at the **per-node multi-miss thresholding** + **task-re-registration** + **drift_velocity / environmental_health field extension** layer. **Implementation can borrow heavily** from the existing pure-function patterns in `scripts/lib/health.mjs` (REAL_OUTCOMES set, BENIGN_SKIP_REASONS set, evaluateNoProgress pure function). The ROADMAP's Sentinel logic parallels the watchdog.mjs structure — fetch gist → compute temporal deltas → emit alert / take action — and should be implementable as a sister script (`scripts/sentinel.mjs`) running on the same GitHub Actions infrastructure.

---

## Six load-bearing dispatcher ADR candidates (H1-H7, with H6 split)

These are the load-bearing design choices Perry must commit to **before** any Phase 2 implementation work begins. Each carries explicit framing and resolution recommendation grounded in the audit + roadmap + cross-check.

### H1 — AST-entropy threshold + algorithm choice for the Overseer

**Decision needed:** Adopt the AST-driven duplication + structural-entropy gate in the Overseer? And if yes, what entropy algorithm + threshold?

**Single resolution path with explicit tunables:**

**Adopt.** The AST entropy gate is the only mechanism that catches agentic structural duplication (LLM reinventing existing utilities); LLM-generated code rarely has syntax errors but routinely has structural duplication. Without this gate, the existing Overseer cross-family review is the only defense, and the cross-family review has no view of the wider codebase topology — it judges the diff in isolation.

**Tunables to commit (each has a defensible default; alternatives carry annotation):**

| Tunable | Default | Alternative consideration |
|---|---|---|
| AST parser | `@babel/parser` with `errorRecovery: true, strictMode: true` | TypeScript native compiler API (more accurate for `.ts` files, heavier dependency) |
| Normalization rule | Strip Identifier + Literal nodes; preserve operation-type nodes | Strip MemberExpression too (more aggressive deduplication; risks false positives on legitimate refactors) |
| Similarity algorithm | **Jaccard for first pass + Jensen-Shannon divergence for second pass** (dual-gate per ROADMAP) | Jaccard-only (faster, less precise); Cross-entropy-only (slower, no symmetric-distance property) |
| Entropy threshold | `2.5` (ROADMAP default for `shared.json` `overseer.entropy_threshold`) | Provisional pending production-data calibration; first 30 days of soft-alert mode is the empirical-characterization window (mirrors M4 in the metacognition synthesis) |
| Gate behavior on parse failure | Fail-soft: log warning to telemetry gist, fall back to string-match heuristic, allow PR to proceed to next gate | Fail-closed: reject PR on any parse failure (more conservative, more false positives during initial LLM-output-shape characterization) |

**Operator decision required at ship time:** soft-alert vs hard-block trip behavior for the entropy threshold. **Recommendation:** soft-alert for first 30 days (matches the metacognition synthesis M4 pattern), promote to hard-block once false-positive rate is empirically characterized.

### H2 — Mutation testing tool + thresholds + assertion-density floor

**Decision needed:** Adopt StrykerJS-based mutation testing + static AST assertion-density check in the Overseer? And if yes, what thresholds?

**Single resolution path with explicit tunables:**

**Adopt.** Mutation testing is the only mechanism to catch high-coverage / low-assertion test hallucination — the most deceptive LLM-generated-test failure mode. Static assertion-density check via the same `@babel/parser` + traversal as H1 is a lighter-weight deterministic complement that catches the obvious cases without needing a full mutation run.

**Tunables to commit:**

| Tunable | Default | Notes |
|---|---|---|
| Mutation tool | StrykerJS in incremental mode (`stryker.config.json: { incremental: true }`) | mutmut/PIT not Node.js-native; StrykerJS is the only viable choice |
| Mutation score floor | `overseer.min_mutation_score = 85` (% for core utilities) | Provisional; tune based on production-data. **Note:** the 85% floor is calibrated for StrykerJS **incremental-mode** runs (where only mutated code is tested); a full-suite nightly run would naturally produce a higher score and the floor should be tuned upward (~95%) for that mode. The dispatcher ships incremental-only at v1; full-suite is deferred |
| Assertion-density floor | `overseer.min_assertion_density = 1.0` (assertions per test block) | Loose floor; many test patterns legitimately have <1 assertions per block (snapshot tests, structural-only tests) |
| Per-file scope | `core utilities` only initially; expand to all source code after 30 days clean signal | Mutation testing on a full codebase can take hours; incremental + per-file-scope keeps cycle time bounded |
| Gate behavior on test framework not recognized | Fail-soft: pass with warning | Matches ROADMAP fail-soft principle; matches M4 metacognition synthesis pattern |

**Operator decision required at ship time:** which test framework targets initially. Burn-wizard is the obvious target per its production-target status; canary-test is the natural smoke test.

### H3 — Sandbox technology choice for probabilistic allowlist smoke runs

**Decision needed (only if H4 probabilistic allowlist expansion is greenlit, deferable for now):** What sandbox technology runs the smoke run for an agent attempting to expand its allowlist?

**Single resolution path; no operator decision needed:**

**Adopt isolated-vm.** The decision is forced by security:

| Technology | Verdict | Why |
|---|---|---|
| Node `vm` built-in | **Prohibited** | Trivial prototype-pollution escapes (contextified globals are reachable from the sandbox) |
| `vm2` library | **Prohibited** | CVE-2026-22709, CVSS 9.8 — Promise rejection prototype-chain traversal escape, unpatchable; library is unmaintained |
| `child_process.fork()` | **Insufficient** | No filesystem isolation; IPC exploitation surface; event-loop sharing |
| **`isolated-vm`** | **Approved** | Native V8 Isolate via C++ bindings; distinct memory heap; explicit memory + CPU caps; no host bindings |

This is a security-floor decision, not a preference. The metacognition synthesis surfaced the same conclusion (M3 path (a) inherits the same isolated-vm requirement for AST patch validation). Phase 2 hardening reuses the same primitive.

### H4 — Probabilistic allowlist expansion adoption (vs. operator-only allowlist edits)

**Decision needed:** Does the dispatcher autonomously expand its own path firewall via sandboxed smoke runs + GPG-signed PR + Overseer approval, or does the path firewall stay operator-edit-only?

**Two defensible paths:**

- **(a) Adopt the probabilistic allowlist expansion.** Maximum autonomy; closes the operational-friction loop where the agent encounters a blocked path and the operator must manually edit the allowlist. The mechanism has strong cryptographic + sandboxed-validation safety: smoke run proves capability; GPG-signed Octokit commit proves identity; Overseer evaluation provides global-policy enforcement.
- **(b) Keep operator-edit-only allowlist.** Less autonomy; preserves the strongest guarantee against autonomous-agent-driven scope creep (the agent can never widen its own permissions).

**Resolution recommendation:** path (b) for the initial Phase 2 ship. Mirrors the metacognition synthesis M3 (LLM-driven AST repair) deferral logic: the Pillar 1 seven-gate stack is barely-validated under real load. Stacking an autonomous-allowlist-expansion mechanism on top of a barely-validated auto-merge stack compounds risk surface in a way that the audit's safety analysis underweights. Defer H4 to Phase 3 after Pillar 1 has merged 10+ real auto-push-eligible PRs without operator intervention; bring H4 online when the operator has empirical confidence that agent-generated PRs respect their bounds.

### H5 — Automated canary bisection adoption (vs. fail-closed Gate 7)

**Decision needed:** Does Gate 7 (post-merge canary monitor) keep its current fail-closed-suspend behavior, or does it integrate `git bisect run` + autonomous hotfix synthesis?

**Two defensible paths:**

- **(a) Adopt automated bisection + autonomous hotfix synthesis.** Maximum velocity; transforms Gate 7 from "this project is now suspended; operator please investigate" to "Gate 7 caught a regression, isolated the bad commit via binary-search, and opened a hotfix PR." The mechanism is well-grounded — `git bisect run` is a mature primitive with logarithmic-time commit isolation.
- **(b) Keep fail-closed suspension.** Operator stays in the loop on every Gate 7 failure; lower autonomy but stronger guarantee that no autonomous-loop-of-loops can fire (e.g., Gate 7 catches a regression → bisection isolates a commit → autonomous-hotfix-LLM produces a worse regression → next merge → Gate 7 catches again → bisect again → ...).

**Resolution recommendation:** path (b) for the initial Phase 2 ship; revisit after H4 path (a) is greenlit. The bisection mechanism is sound, but the **autonomous hotfix synthesis** layer is exactly the same surface as the metacognition M3 (LLM-driven AST repair) — and inherits the same MFM2 zombie-patch risk. Without the 4-state ACB from the metacognition synthesis (audit correction A1) protecting the bisection-hotfix loop, the loop can fire infinitely. **Conditional adoption:** path (a) becomes implementable once metacognition A1 (4-state ACB with Probationary state) ships AND H4 path (a) has 30 days clean signal. Until then, the bisection mechanism alone (path a-prime) — isolate the bad commit, surface the diff to the operator, do NOT auto-synthesize a hotfix — is a defensible interim that provides some velocity benefit without the loop-of-loops risk.

### H6 — DCTD adoption (vs. defer)

**Decision needed:** Adopt Dynamic Canonical Trace Divergence profiling in the Overseer for algorithmic-complexity regression detection?

**Two defensible paths:**

- **(a) Adopt DCTD.** Catches algorithmic-complexity regressions that AST + mutation testing can't see. The mechanism uses public Node.js `node:inspector` API + `Profiler.startPreciseCoverage` from the Chrome DevTools Protocol — well-documented surface.
- **(b) Defer DCTD to Phase 3.** The implementation surface is brittle (V8 inspector session lifecycle; CDP message ordering; bytecode-opcode interpretation that may shift across Node.js minor versions). The mechanism has the highest implementation cost and lowest payoff among the six ADRs (algorithmic-complexity regressions are rare in practice for the dispatcher's workload). The other Phase 2 layers (AST + mutation + cross-family) catch the dominant failure modes; DCTD is the marginal case.

**Resolution recommendation:** path (b). Defer DCTD until the other five Phase 2 ADRs have shipped and operational data exists about whether algorithmic-complexity regressions are an actual problem for the dispatcher's workload. If 6 months pass with zero observed Big-O regressions, DCTD remains-deferred indefinitely — the cost-benefit doesn't pencil. If regressions surface, revisit then with concrete examples to inform threshold tuning.

### H7 — Distributed-heartbeat upgrade scope (added during cross-check)

**Decision needed:** What's the load-bearing scope of the Sentinel layer extension to the existing P7 watchdog?

**Single resolution path with explicit scope:**

**Adopt these specific extensions; defer the rest:**

| Extension | Adopt? | Rationale |
|---|---|---|
| Per-node multi-miss thresholding (3 misses → dead) | **Yes** | The existing watchdog uses fleet-max-heartbeat (2h); per-node thresholds detect partial fleet failures sooner |
| Heartbeat payload extension (drift_velocity, environmental_health, current_task_hash beyond what's already written) | **Yes (partial)** | `current_task_hash` is highest-value addition; `drift_velocity` defers until metacognition M4 lands (drift_velocity IS the metacognition signal); `environmental_health` extends the existing `selector_fallback_count` pattern naturally |
| Idempotent task re-registration via gist queue | **Defer to Phase 3** | The dispatcher's tasks are local-only; gist-mediated cross-machine task-handoff is a substantial new mechanism that requires distributed-locking primitives the dispatcher doesn't yet have. Phase 1 idempotency was at the local-worktree level (auto/branch deletion + recreation); cross-machine coordination is genuinely net-new |
| Self-imposed suspension on environmental degradation | **Yes** | Cheapest of the four; reuses existing `scripts/lib/circuit-breaker.mjs` pattern for the local-state-write |
| Stateless Sentinel as `scripts/sentinel.mjs` GitHub Actions cron | **Yes** | Mirrors the watchdog.mjs pattern; no new SPOF; runs out-of-band of fleet nodes |

**Operator decision required:** none. The recommended-yes items are mechanical extensions of already-shipped patterns; the deferred item (idempotent task re-registration) is genuinely Phase 3 scope and out of the Phase 2 envelope.

---

## Three named failure modes canonized

The audit and roadmap together name three systemic-hardening failure modes. The synthesis canonicalizes them with explicit IDs:

- **HFM1 — Silent dispatch absorption.** Command sent to terminal/IPC channel reports exit-zero but never executes; downstream agents proceed with corrupted state. **Defense:** verifiedExec pattern (Phase 1 shipped) + IPC watchdog timer extension (`4bbf348`, partially shipped, verify completeness during H7 implementation).
- **HFM2 — Conformity-bias error compounding.** Sequenced LLM agents inherit upstream hallucinations as ground truth; errors compound silently. **Defense:** deterministic semantic boundaries between agent handoffs (regex / schema / AST validation at every gate); the H1 + H2 Overseer-intelligence stack is the load-bearing instance.
- **HFM3 — Autonomous-loop-of-loops.** Autonomous mechanism (LLM-driven repair, bisection-hotfix, allowlist-expansion) produces a flawed output that triggers itself again, creating an infinite resource-burning loop. **Defense:** the metacognition synthesis's 4-state ACB (A1) + audit's algorithmic circuit breaker pattern; H5 path-(a) deferral is gated on this.

---

## Methodological note

This synthesis is a **single-family strategy+tactics pair** (Claude AUDIT + Claude ROADMAP) — different shape from cross-family Fork B precedent and different from the metacognition design+audit pair. Two methodological observations:

1. **Strategy + tactics convergence is the dominant content.** Unlike design + adversarial-audit (where the audit's CRITICAL findings reshape the design — see metacognition synthesis), strategy + tactics docs are mostly complementary. The convergence section is dominant; divergence is thin (3 minor framing items). This is a healthy pattern for the architecture-roadmap genre — when strategy and tactics diverge substantively, that's a signal one of them isn't grounded in the other's constraints.

2. **The Phase 1 baseline is load-bearing context.** The ROADMAP explicitly retros that several AUDIT-flagged P0 items already shipped in Phase 1 (`subprocess-verify.mjs`, `ConfigDriftError`, push-based heartbeat, sentinel auto-remediation). Without the baseline cross-check (§ Cross-check section above), the synthesis would over-recommend already-shipped work. The cross-check against `scripts/lib/`, `scripts/watchdog.mjs`, and recent commit log (`4bbf348 Phase 2 Task 4: Octokit rate limiting and IPC watchdogs`) is the substitute for an independent verification layer. Cross-checking against running code is the same discipline established in the metacognition synthesis (§ Methodological note); it generalizes across both Phase 2 syntheses.

The pattern observation: Phase 2 has **two complementary syntheses** that ship together — metacognition (the local-cognitive layer; design + audit pair) and hardening (the systemic-fleet layer; strategy + tactics pair). Both surface ADR candidates that interact (metacognition M3 ↔ hardening H5; metacognition A1 4-state ACB protects hardening H4 + H5 autonomous loops). **Reading both together is required for any Phase 2 implementation work.**

---

## Adversarial review findings (deferred)

This synthesis has not been adversarially reviewed. Deferred. **Trigger conditions** for commissioning a fresh adversarial pass:

1. H4 path (a) probabilistic allowlist expansion enters active implementation. The auto-allowlist-widening surface has the highest blast radius among the six ADRs; cross-family adversarial verification is warranted before code lands.
2. H5 path (a) automated bisection + autonomous hotfix enters active implementation. The bisection-hotfix loop interacts with the metacognition 4-state ACB in ways the synthesis does not exhaustively verify.
3. The probabilistic-allowlist GPG-signing implementation is built. The cryptographic surface (PGP key management, Octokit signature parameter format, GitHub's verification path) has high primary-source-verification value.
4. The DCTD profiling implementation is built (if H6 is ever greenlit). Node.js `node:inspector` API + CDP message handling has minor-version-volatility risk that single-family verification can't catch.
5. Operator-driven trigger: any AUDIT/ROADMAP claim that needs to inform a load-bearing implementation decision and that the synthesis classifies as "defensible-not-required" — a fresh cross-family adversarial pass against that specific claim becomes the right safety floor.

---

## Recommended downstream actions

In dependency order:

1. **Operator decisions on H1-H7.** Synthesis surfaces the choices; operator commits. Recommendation summary:
   - H1: adopt; ship soft-alert for 30 days then promote to hard-block
   - H2: adopt; StrykerJS incremental mode + AST assertion-density; soft-alert for 30 days
   - H3: forced (isolated-vm) — only relevant if H4 path (a) is greenlit
   - H4: path (b) for initial ship — operator-edit-only allowlist; defer probabilistic expansion to Phase 3
   - H5: interim path-a-prime — bisection isolates bad commit, surfaces to operator, does NOT auto-synthesize hotfix; full path (a) deferred to Phase 3 after metacognition A1 4-state ACB ships
   - H6: defer DCTD to Phase 3+
   - H7: adopt the recommended-yes items (per-node multi-miss + heartbeat-payload extension + self-imposed suspension + stateless GH-Actions Sentinel); defer idempotent task re-registration to Phase 3
2. **Verify already-partially-shipped Phase 2 work.** Read commit `4bbf348` to confirm `@octokit/plugin-throttling` + `@octokit/plugin-retry` are wired across all Octokit call sites, and that IPC watchdog timers are bound to all `child_process.fork()` calls. Audit gap closure if either is incomplete.
3. **Implementation of H1 (AST entropy gate) as the first-ship Phase 2 component.** Smallest risk surface; reuses existing `scripts/lib/schemas.mjs` ajv pattern + `@babel/parser`. Estimated scope: ~300 LOC across `scripts/lib/ast-entropy.mjs` (pure: AST normalize, PMF compute, Jaccard + JS divergence) + `scripts/lib/__tests__/ast-entropy.test.mjs` (~25 unit tests) + Overseer integration in `scripts/overseer.mjs` (extend `reviewOnePr` to call the new gate after the cross-family review and before label application). **The `@babel/parser` introduced here is the shared dependency for H2's static assertion-density check** — H2 reuses H1's parser invocation and AST traversal pattern.
4. **Implementation of H7 Sentinel extensions** as the second-ship Phase 2 component. Per-node multi-miss thresholding + self-imposed suspension extend `scripts/lib/health.mjs` and `scripts/watchdog.mjs` with minimal new surface; stateless GH-Actions Sentinel is a sister script + workflow. Estimated scope: ~200 LOC + ~15 unit tests + 1 GitHub Actions workflow file. **Independent of H1/H2** — can ship in parallel.
5. **Implementation of H2 (mutation testing + assertion density) as the third-ship Phase 2 component.** Sub-step **5a (assertion-density check)** reuses H1's AST parser and traversal — minimal new code surface; ship together with H1 if convenient. Sub-step **5b (StrykerJS mutation testing)** is the larger independent surface (new StrykerJS dependency, incremental config, JSON report parsing, integration with Overseer). Estimated scope: 5a ~80 LOC + 8 tests; 5b ~250 LOC + StrykerJS config + ~15 tests.
6. **PAL audit of each Phase 2 implementation** before committing. Cross-family per Fork B precedent.
7. **Operational observation period — 30 days post-ship of H1+H2+H7.** Empirically characterize false-positive rates. Adjust thresholds + trip actions per data.
8. **Re-revisit H4/H5 path (a) decisions** after 30 days clean signal AND ≥10 successful auto-push-eligible PR merges through the seven-gate stack AND metacognition synthesis A1 4-state ACB has shipped. All three conditions must hold; the AND is load-bearing.

---

## Cross-references

- AUDIT: [`docs/research/HARDENING-PHASE-2-AUDIT-claude-2026-04-30.md`](./HARDENING-PHASE-2-AUDIT-claude-2026-04-30.md)
- ROADMAP: [`docs/research/HARDENING-PHASE-2-ROADMAP-claude-2026-04-30.md`](./HARDENING-PHASE-2-ROADMAP-claude-2026-04-30.md)
- Companion Phase 2 synthesis (local-cognitive layer): [`docs/research/METACOGNITION-synthesis-2026-05-03.md`](./METACOGNITION-synthesis-2026-05-03.md) — H4/H5 deferral logic depends on metacognition A1 4-state ACB shipping first
- Phase 1 hardening synthesis baseline: [`docs/research/HARDENING-synthesis-gemini-2026-04-24.md`](./HARDENING-synthesis-gemini-2026-04-24.md)
- Phase 2 in-flight context: [`docs/HANDOFF-dispatcher-2026-04-30-phase2.md`](../HANDOFF-dispatcher-2026-04-30-phase2.md)
- Already-shipped Phase 2 work: dispatcher commit `4bbf348 Phase 2 Task 4: Octokit rate limiting and IPC watchdogs` on `origin/main`
- Current systemic-hardening source:
  - `scripts/lib/subprocess-verify.mjs` (Phase 1 verifiedExec — extension target for IPC severance)
  - `scripts/lib/health.mjs` (4-state classifier + no-progress detector + selector-fallback detector)
  - `scripts/lib/circuit-breaker.mjs` (P3 wrapper auto-pull breaker — pattern for self-imposed suspension)
  - `scripts/watchdog.mjs` (P7 fleet-silence detector — extension target for stateless Sentinel)
  - `scripts/lib/auto-push.mjs` (gate 4 canary — extension target for H4 if greenlit)
  - `scripts/overseer.mjs` (gate 5 cross-family review — extension target for H1 + H2)
  - `scripts/post-merge-monitor.mjs` (gate 7 canary monitor — extension target for H5 if greenlit)
  - `scripts/lib/schemas.mjs` (ajv pattern — reusable for config schema validation extension)
- Combo cross-link (synthesis-as-canonical-layer policy + raw-doc-immutable policy): `combo/ai/DECISIONS.md` 2026-04-28 GFX-1 adversarial entry establishes the precedent

---

## Push posture

Mechanism dormant on ship — this synthesis is reference, not implementation. No source code edits to dispatcher this commit. Operator-go-required posture applies: synthesis ships local-only as part of the combo-side organization session; per-repo commit is staged for Perry's go before push.

The companion METACOGNITION synthesis ships in the same dispatcher-repo commit. Together they document the full Phase 2 design surface; operator decisions on metacognition M1-M6 + hardening H1-H7 land before any Phase 2 implementation work begins. Per the same operator-go-required posture from prior Fork B / Pillar 2 sessions, all three repo commits (combo + dispatcher + worldbuilder) stay local-only at end of session.
