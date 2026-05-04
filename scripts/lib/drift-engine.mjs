// drift-engine.mjs — M4 semantic drift detector, pure functions only.
// No I/O, no ONNX, no side effects. All impure code lives in drift-engine-cli.mjs.
//
// Algorithm: EMA baseline + cosine distance.
//   baseline[i] = baseline[i] + α × (newVec[i] − baseline[i])
//   distance    = 1 − cosine_similarity(newVec, baseline)
//   trip        = distance > threshold
//
// First observation seeds the EMA baseline without tripping (no reference yet).
// Soft-alert-only for first 30 days (enforcement posture lives in dispatch.mjs Phase 0.1).

const EXTRACT_LIMIT = 20; // max log entries to concatenate for embed input

/**
 * Fresh drift detector state. All null/zero — caller persists and passes back each cycle.
 * @returns {{ ema_baseline: null, last_distance: null, trip_count: number, last_trip_ts: string|null }}
 */
export function freshDriftState() {
  return { ema_baseline: null, last_distance: null, trip_count: 0, last_trip_ts: null };
}

/**
 * Cosine distance = 1 - cosine_similarity.
 * Returns 0 (no distance) if either vector has zero magnitude — fail-soft.
 * @param {number[]|Float32Array} vecA
 * @param {number[]|Float32Array} vecB
 * @returns {number} value in [0, 1]
 */
export function cosineDist(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(vecA.length, vecB.length);
  for (let i = 0; i < len; i++) {
    dot  += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0; // zero-magnitude → fail-soft, treat as no distance
  return 1 - dot / (magA * magB);
}

/**
 * Exponential moving average update.
 * If baseline is null, seeds from newVec (first observation).
 * @param {Float32Array|null} baseline
 * @param {Float32Array} newVec
 * @param {number} [alpha=0.05]
 * @returns {Float32Array}
 */
export function updateEma(baseline, newVec, alpha = 0.05) {
  if (baseline === null) return new Float32Array(newVec);
  const out = new Float32Array(newVec.length);
  for (let i = 0; i < newVec.length; i++) {
    out[i] = baseline[i] + alpha * (newVec[i] - baseline[i]);
  }
  return out;
}

/**
 * Evaluate drift for one cycle.
 *   - First call (state.ema_baseline === null): seeds EMA, never trips.
 *   - Subsequent calls: compute cosine distance, update EMA, trip if distance > threshold.
 *
 * @param {{ ema_baseline: Float32Array|null, last_distance: number|null, trip_count: number, last_trip_ts: string|null }} state
 * @param {Float32Array} newVec - embedding of the current dispatch summaries
 * @param {{ threshold?: number, alpha?: number, now?: Date }} [opts]
 * @returns {{ tripped: boolean, distance: number|null, newState: object }}
 */
export function evaluateDrift(state, newVec, { threshold = 0.15, alpha = 0.05, now = new Date() } = {}) {
  const newBaseline = updateEma(state.ema_baseline, newVec, alpha);

  // First observation — seed baseline, no trip possible.
  if (state.ema_baseline === null) {
    return {
      tripped: false,
      distance: null,
      newState: { ...state, ema_baseline: newBaseline, last_distance: null },
    };
  }

  const distance = cosineDist(newVec, state.ema_baseline);
  const tripped = distance > threshold;

  const newState = {
    ema_baseline: newBaseline,
    last_distance: distance,
    trip_count: tripped ? state.trip_count + 1 : state.trip_count,
    last_trip_ts: tripped ? now.toISOString() : state.last_trip_ts,
  };

  return { tripped, distance, newState };
}

/**
 * Extract human-readable summary text from JSONL log entries for embedding.
 * Filters to the last EXTRACT_LIMIT entries and concatenates usable text fields.
 * Returns empty string if no usable fields are found (caller treats as skip condition).
 *
 * @param {object[]} logEntries - parsed JSONL entries (not pre-filtered by outcome)
 * @returns {string}
 */
export function extractSummaryText(logEntries, limit = EXTRACT_LIMIT) {
  const entries = logEntries.slice(-limit);
  const parts = [];
  for (const e of entries) {
    const candidates = [e.summary, e.pr_title, e.rationale, e.task];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim().length > 0) {
        parts.push(c.trim());
      }
    }
  }
  return parts.join("\n");
}
