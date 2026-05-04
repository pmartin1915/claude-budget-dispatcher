# M4 Semantic Drift Detector — Operator Guide

**File:** `scripts/lib/drift-engine-cli.mjs` + `scripts/lib/drift-engine.mjs`  
**Status:** Shipped (wave 1). Soft-alert only for first 30 days — never halts dispatch.

## What it detects

The dispatcher's `health.mjs` operates at the **outcome layer** — it detects failing exits, stuck pushes, and structural gate failures. It has no view of what the dispatcher *did*, only whether it exited cleanly.

M4 operates at the **semantic-content layer**. It embeds the last 20 dispatch summaries (PR titles, rationales, task names, summary fields) into a 384-dimensional vector and compares it against an exponential-moving-average baseline. A large cosine distance means the dispatcher's recent work has drifted semantically from its established pattern — the canonical signal for the **coherence trap**: plausible-looking output that retrieves irrelevant data and generates incorrect analysis while reporting success.

**M4 does not detect:**
- Exit codes (that's `health.mjs`)
- Stuck auto-push projects (that's `evaluateNoProgress`)
- Gemini quota outages (that's `selector_fallback_count`)

## How it works

```
JSONL log (last 20 entries)
  ↓  extractSummaryText()
  text string
  ↓  ONNX embed (all-MiniLM-L6-v2 INT8)
  Float32Array[384]
  ↓  evaluateDrift()
  cosine distance vs EMA baseline
  ↓  D > 0.15 → trip (soft alert)
```

**EMA update:** `ema[i] = ema[i] + α × (vec[i] − ema[i])` where α = 0.05 (high inertia — the baseline moves slowly, so a single unusual dispatch doesn't trip the alarm).

**First observation:** seeds the baseline without tripping (no reference to compare against).

**Trip action (first 30 days):** appends a `drift-alert` JSONL entry + fires an ntfy notification. Does NOT halt dispatch. Promote to hard-halt after the empirical-characterization window produces a calibrated false-positive rate.

## Setup

### 1. Download the INT8-quantized model

```bash
# ~22MB — download to the models/ directory
mkdir -p models
# The model file expected at: models/model_qint8_avx512_vnni.onnx
# Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
# Use the ONNX quantized variant (onnx/model_qint8_avx512_vnni.onnx)
```

If the model file is absent, M4 skips gracefully with `{skipped: true, reason: "model-not-found"}`. The dispatcher continues normally.

### 2. Install onnxruntime-node

```bash
npm install
# onnxruntime-node is in package.json — install picks it up automatically
```

### 3. Verify the setup

```bash
node scripts/lib/drift-engine-cli.mjs check
# Expected without model: {"tripped":false,"distance":null,"trip_count":0,"skipped":true,"reason":"model-not-found"}
# Expected with model + log entries: {"tripped":false,"distance":0.0312,...,"skipped":false,"reason":null}
```

## Config options

In `config/budget.json` or `config/local.json`:

```json
{
  "drift": {
    "threshold": 0.15,
    "alpha": 0.05
  }
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `drift.threshold` | `0.15` | Cosine distance floor for a trip. Provisional — calibrate empirically after 30 days. |
| `drift.alpha` | `0.05` | EMA decay rate. Lower = more inertia (slower baseline movement). |

The model path, state path, and log path are hardcoded relative to `REPO_ROOT` and are not configurable in v1.

## CLI reference

```bash
# Run a full drift check (embed + evaluate + persist state)
node scripts/lib/drift-engine-cli.mjs check

# Reset drift state (start fresh baseline)
node scripts/lib/drift-engine-cli.mjs reset

# Show current state without running an embed
node scripts/lib/drift-engine-cli.mjs status
```

All subcommands write JSON to stdout and fatal errors only to stderr.

## Reading the JSONL log

A `drift-alert` entry looks like:

```json
{"phase":"drift-check","outcome":"drift-alert","distance":0.2341,"trip_count":3,"ts":"2026-05-03T14:22:00.000Z"}
```

**Fields:**

| Field | Meaning |
|-------|---------|
| `distance` | Cosine distance at the time of the trip (0 = identical, 1 = orthogonal) |
| `trip_count` | Cumulative number of trips since baseline was seeded |
| `phase` | Always `"drift-check"` — filters this entry from outcome-layer health logic |

Skipped runs (model not found, unreadable log, no usable text) write no log entry and no ntfy — silent skip by design.

## Threshold calibration

The 0.15 threshold is provisional. Over the first 30 days:

1. Watch the `drift-alert` JSONL entries and ntfy notifications.
2. Read each alert and ask: does the dispatcher's recent work actually look semantically different from its usual pattern?
3. If alerts are predominantly **false positives** (normal variation in task selection), raise the threshold (e.g., 0.20).
4. If alerts are **consistently meaningful** and the dispatcher's output quality has visibly changed, the threshold is calibrated correctly.

After 30 days of empirically-grounded false-positive data, promote the trip action from soft-alert to hard-halt by adding an early-return in Phase 0.1 of `dispatch.mjs`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `skipped: true, reason: "model-not-found"` | Model not in `models/` | Download INT8 model (see Setup §1) |
| `skipped: true, reason: "log-unreadable"` | Log file missing or corrupt | Run a dispatch cycle to create the log; or check `status/budget-dispatch-log.jsonl` |
| `skipped: true, reason: "no-summary-text"` | Log has no entries with summary/pr_title/rationale/task fields | Normal on fresh installs — populate log via dispatch cycles |
| `drift check failed (non-fatal)` in console | ONNX session error | Check onnxruntime-node version; check model file integrity |
| Very high trip rate (every cycle) | Threshold too low for this workload | Raise `drift.threshold` to 0.20 and re-observe for 2 weeks |
| Baseline never established | `status/drift-state.json` corrupt | Run `node scripts/lib/drift-engine-cli.mjs reset` to start fresh |

## State file

Drift state persists at `status/drift-state.json`. It is written atomically (tmp + rename). On corrupt or missing file, the system fails open — starts fresh with a null baseline.

```json
{
  "ema_baseline": [0.12, -0.03, ...],
  "last_distance": 0.0841,
  "trip_count": 0,
  "last_trip_ts": null
}
```

`ema_baseline` is serialized as a plain JSON array (Float32Array is not JSON-serializable directly) and reconstituted on read.
