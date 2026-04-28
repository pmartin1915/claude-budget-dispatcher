// overseer.test.mjs -- unit tests for the gate-5 read-only Overseer.
//
// Pure-function + dependency-injection style. No network, no filesystem.
// Mirrors watchdog.test.mjs / auto-push.test.mjs conventions: node:test,
// node:assert/strict, all I/O via injected fetcher/palCallFn/appender/now.

import "./_test-status-dir.mjs"; // Must be first -- redirects fallback writes
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideAuditModel,
  evaluateRunDecision,
  parseGenerationModelFromPr,
  parseTaskFromPr,
  buildReviewPrompt,
  parseReviewResponse,
  isQuotaExhausted,
  mapPalErrorToVerdict,
  findLatestOverseerLabel,
  findLabelEvents,
  evaluateCoolingOff,
  resolveAutoMergeConfig,
  findRepoEntry,
  normalizeRepoList,
  providerFamily,
  reviewOnePr,
  runOverseer,
  runCli,
  createDefaultGitHubClient,
  createDefaultGistClient,
  writePendingMergeEntry,
  _trail,
} from "../../overseer.mjs";

const NOW = new Date("2026-04-27T12:00:00.000Z").getTime();

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockAppender() {
  const calls = [];
  return {
    fn: (entry) => calls.push(entry),
    calls,
  };
}

function mockGh({
  prs = [],
  diff = "",
  events = [],
  commit = { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } },
  listThrows = null,
  diffThrows = null,
  eventsThrows = null,
  commitThrows = null,
  addThrows = null,
  removeThrows = null,
} = {}) {
  const calls = { list: 0, diff: 0, events: 0, commit: 0, add: [], remove: [] };
  return {
    calls,
    async listOpenDispatcherActionablePrs(repo) {
      calls.list++;
      if (listThrows) throw listThrows;
      return prs;
    },
    async getPrDiff(repo, n) {
      calls.diff++;
      if (diffThrows) throw diffThrows;
      return diff;
    },
    async getIssueEvents(repo, n) {
      calls.events++;
      if (eventsThrows) throw eventsThrows;
      return events;
    },
    async getHeadCommit(repo, sha) {
      calls.commit++;
      if (commitThrows) throw commitThrows;
      return commit;
    },
    async addLabel(repo, n, label) {
      calls.add.push({ repo, n, label });
      if (addThrows) throw addThrows;
    },
    async removeLabel(repo, n, label) {
      calls.remove.push({ repo, n, label });
      if (removeThrows) throw removeThrows;
    },
  };
}

function makePr({ number = 1, sha = "abcd1234", labels = [], body = "", html_url = "https://github.com/test/repo/pull/1" } = {}) {
  return {
    number,
    html_url,
    body,
    draft: true,
    head: { sha },
    labels: labels.map((name) => ({ name })),
  };
}

// ---------------------------------------------------------------------------
// providerFamily() + decideAuditModel() -- C-1 cross-family logic
// ---------------------------------------------------------------------------

describe("providerFamily()", () => {
  it("classifies common model strings correctly", () => {
    assert.equal(providerFamily("gemini-2.5-pro"), "gemini");
    assert.equal(providerFamily("gemini-2.5-flash"), "gemini");
    assert.equal(providerFamily("mistral-large-latest"), "mistral");
    assert.equal(providerFamily("codestral-latest"), "mistral");
    assert.equal(providerFamily("devstral-small-2"), "mistral");
    assert.equal(providerFamily("groq/gpt-oss-120b"), "groq");
    assert.equal(providerFamily("openrouter/minimax-m2.5"), "openrouter");
    assert.equal(providerFamily("local/qwen2.5-coder:14b"), "ollama");
    assert.equal(providerFamily(""), "unknown");
    assert.equal(providerFamily(null), "unknown");
    assert.equal(providerFamily("claude-opus-4-7"), "unknown"); // not in map; abstain territory
  });
});

describe("decideAuditModel() -- C-1 cross-family", () => {
  it("Gemini-generated PR -> Mistral audit", () => {
    const r = decideAuditModel({ generationModel: "gemini-2.5-pro" });
    assert.equal(r.abstain, false);
    assert.equal(r.model, "mistral-large-latest");
    assert.equal(r.family, "mistral");
  });

  it("Mistral/Codestral-generated PR -> Gemini audit", () => {
    const r1 = decideAuditModel({ generationModel: "mistral-large-latest" });
    assert.equal(r1.abstain, false);
    assert.equal(r1.model, "gemini-2.5-pro");
    assert.equal(r1.family, "gemini");

    const r2 = decideAuditModel({ generationModel: "codestral-latest" });
    assert.equal(r2.abstain, false);
    assert.equal(r2.model, "gemini-2.5-pro");
  });

  it("missing generation model -> abstain (no silent default)", () => {
    const r = decideAuditModel({ generationModel: null });
    assert.equal(r.abstain, true);
    assert.match(r.reason, /no-generation-model/);
  });

  it("unknown / routed family (groq/openrouter/local) -> abstain", () => {
    // A C-1 violation would be picking gemini or mistral silently for these.
    // The spec says: abstain if family is ambiguous.
    for (const m of ["groq/gpt-oss-120b", "openrouter/minimax-m2.5", "local/qwen2.5-coder:14b", "claude-opus-4-7"]) {
      const r = decideAuditModel({ generationModel: m });
      assert.equal(r.abstain, true, `expected abstain for ${m}`);
      assert.match(r.reason, /unknown-or-routed-family/);
    }
  });
});

// ---------------------------------------------------------------------------
// parseGenerationModelFromPr / parseTaskFromPr -- prefer labels, fall back to body
// ---------------------------------------------------------------------------

describe("parseGenerationModelFromPr()", () => {
  it("reads from labels when present", () => {
    const m = parseGenerationModelFromPr({
      labels: [{ name: "dispatcher:auto" }, { name: "model:gemini-2.5-pro" }, { name: "task:audit" }],
      body: "ignored",
    });
    assert.equal(m, "gemini-2.5-pro");
  });

  it("falls back to body when no model label", () => {
    const body = "## Dispatcher auto-PR\n- **Model:** `mistral-large-latest`\n- **Task:** `refactor`";
    const m = parseGenerationModelFromPr({ labels: [{ name: "dispatcher:auto" }], body });
    assert.equal(m, "mistral-large-latest");
  });

  it("returns null when neither label nor body has a model", () => {
    assert.equal(parseGenerationModelFromPr({ labels: [], body: "" }), null);
    assert.equal(parseGenerationModelFromPr({ labels: undefined, body: undefined }), null);
  });
});

describe("parseTaskFromPr()", () => {
  it("reads task from labels", () => {
    assert.equal(parseTaskFromPr({ labels: [{ name: "task:audit" }] }), "audit");
    assert.equal(parseTaskFromPr({ labels: [{ name: "task:tests_gen" }] }), "tests_gen");
    assert.equal(parseTaskFromPr({ labels: [] }), null);
  });
});

// ---------------------------------------------------------------------------
// evaluateRunDecision() -- idempotency
// ---------------------------------------------------------------------------

describe("evaluateRunDecision() -- idempotency", () => {
  it("no prior overseer label -> review", () => {
    const r = evaluateRunDecision({ latestOverseerLabel: null, headCommittedAt: new Date(NOW).toISOString() });
    assert.equal(r.skip, false);
    assert.equal(r.reason, "no-prior-label");
  });

  it("label newer than head commit -> SKIP (already reviewed this sha)", () => {
    const r = evaluateRunDecision({
      latestOverseerLabel: { name: "overseer:approved", createdAt: new Date(NOW - 5 * 60_000).toISOString() },
      headCommittedAt: new Date(NOW - 60 * 60_000).toISOString(),
    });
    assert.equal(r.skip, true);
    assert.match(r.reason, /already-reviewed:overseer:approved/);
  });

  it("label older than head commit -> review (re-review fires on new push)", () => {
    const r = evaluateRunDecision({
      latestOverseerLabel: { name: "overseer:abstain", createdAt: new Date(NOW - 60 * 60_000).toISOString() },
      headCommittedAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    assert.equal(r.skip, false);
    assert.match(r.reason, /head-advanced/);
  });

  it("missing head commit date -> SKIP (don't double-spend on transient hiccup)", () => {
    const r = evaluateRunDecision({
      latestOverseerLabel: { name: "overseer:approved", createdAt: new Date(NOW).toISOString() },
      headCommittedAt: null,
    });
    assert.equal(r.skip, true);
    assert.equal(r.reason, "head-commit-date-unknown");
  });
});

// ---------------------------------------------------------------------------
// findLatestOverseerLabel -- only events for overseer:* labels count, only most-recent
// ---------------------------------------------------------------------------

describe("findLatestOverseerLabel()", () => {
  it("ignores non-overseer label events and unlabeled events", () => {
    const events = [
      { event: "labeled", label: { name: "dispatcher:auto" }, created_at: "2026-04-27T11:00:00Z" },
      { event: "labeled", label: { name: "overseer:abstain" }, created_at: "2026-04-27T11:30:00Z" },
      { event: "unlabeled", label: { name: "overseer:abstain" }, created_at: "2026-04-27T11:45:00Z" },
      { event: "labeled", label: { name: "overseer:approved" }, created_at: "2026-04-27T11:50:00Z" },
      { event: "labeled", label: { name: "task:audit" }, created_at: "2026-04-27T11:55:00Z" },
    ];
    const r = findLatestOverseerLabel(events);
    assert.equal(r.name, "overseer:approved");
    assert.equal(r.createdAt, "2026-04-27T11:50:00Z");
  });

  it("returns null when no overseer events exist", () => {
    assert.equal(findLatestOverseerLabel([{ event: "labeled", label: { name: "dispatcher:auto" }, created_at: "2026-04-27T11:00:00Z" }]), null);
    assert.equal(findLatestOverseerLabel([]), null);
    assert.equal(findLatestOverseerLabel(null), null);
  });
});

// ---------------------------------------------------------------------------
// parseReviewResponse + buildReviewPrompt
// ---------------------------------------------------------------------------

describe("parseReviewResponse()", () => {
  it("parses well-formed JSON with verdict + issues", () => {
    const r = parseReviewResponse(JSON.stringify({
      verdict: "approved",
      confidence: "high",
      summary: "Diff matches the body claim and has no semantic regressions.",
      issues: [
        { severity: "low", note: "minor: stylistic" },
        { severity: "medium", note: "consider extracting helper" },
        { severity: "medium", note: "another medium" },
      ],
    }));
    assert.equal(r.verdict, "approved");
    assert.equal(r.confidence, "high");
    assert.deepEqual(r.issueCounts, { critical: 0, high: 0, medium: 2, low: 1 });
    assert.match(r.summary, /matches the body claim/);
  });

  it("strips ```json fence and tolerates surrounding prose", () => {
    const r = parseReviewResponse("Here is my review:\n```json\n{\"verdict\":\"rejected\",\"confidence\":\"medium\",\"summary\":\"diff doesn't match claim\",\"issues\":[]}\n```\nHope that helps.");
    assert.equal(r.verdict, "rejected");
    assert.equal(r.confidence, "medium");
  });

  it("non-JSON or unknown verdict -> abstain", () => {
    assert.equal(parseReviewResponse("absolute garbage").verdict, "abstain");
    assert.equal(parseReviewResponse(JSON.stringify({ verdict: "wat" })).verdict, "abstain");
    assert.equal(parseReviewResponse("").verdict, "abstain");
    assert.equal(parseReviewResponse(null).verdict, "abstain");
  });

  it("trail-limits long summaries to <=500 chars", () => {
    const big = "x".repeat(2000);
    const r = parseReviewResponse(JSON.stringify({ verdict: "approved", confidence: "high", summary: big, issues: [] }));
    assert.ok(r.summary.length <= 500, `summary length ${r.summary.length} should be <=500`);
  });
});

describe("buildReviewPrompt()", () => {
  it("truncates oversized diffs to maxDiffChars", () => {
    const big = "+".repeat(60_000);
    const out = buildReviewPrompt({ prBody: "did stuff", diff: big, maxDiffChars: 1000 });
    assert.ok(out.length < 60_000, "prompt should not contain the full untruncated diff");
    assert.match(out, /truncated 59000 chars/);
  });
});

// ---------------------------------------------------------------------------
// isQuotaExhausted + mapPalErrorToVerdict
// ---------------------------------------------------------------------------

describe("isQuotaExhausted() and mapPalErrorToVerdict()", () => {
  it("HTTP 429 -> quota-exhausted", () => {
    assert.equal(isQuotaExhausted({ status: 429, message: "Too Many Requests" }), true);
  });

  it("Gemini-style 'daily quota exceeded' message -> quota-exhausted", () => {
    assert.equal(isQuotaExhausted(new Error("Resource has been exhausted: daily quota exceeded")), true);
  });

  it("generic non-quota error -> not quota", () => {
    assert.equal(isQuotaExhausted(new Error("Internal server error")), false);
    assert.equal(isQuotaExhausted({ status: 500 }), false);
  });

  it("quota error maps to abstain (NOT rejected)", () => {
    const v = mapPalErrorToVerdict({ status: 429, message: "daily quota exceeded" });
    assert.equal(v.verdict, "abstain");
    assert.equal(v.reason, "quota-exhausted");
  });

  it("non-quota error also maps to abstain (fail-soft)", () => {
    const v = mapPalErrorToVerdict(new Error("DNS lookup failed"));
    assert.equal(v.verdict, "abstain");
    assert.equal(v.reason, "pal-error");
  });
});

// ---------------------------------------------------------------------------
// reviewOnePr() -- end-to-end integration with injected gh + palCallFn
// ---------------------------------------------------------------------------

describe("reviewOnePr() integration", () => {
  it("happy path: Gemini-generated PR, Mistral audit returns approved -> applies overseer:approved label", async () => {
    const pr = makePr({
      number: 42,
      sha: "deadbeef",
      labels: ["dispatcher:auto", "model:gemini-2.5-pro", "task:audit"],
      body: "## Dispatcher auto-PR\n- **Model:** `gemini-2.5-pro`",
    });
    const gh = mockGh({
      events: [], // no prior overseer label
      commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } },
      diff: "+++ b/src/foo.js\n@@\n+const x = 1;",
    });
    const palCalls = [];
    const palCallFn = async ({ model, prompt }) => {
      palCalls.push({ model, prompt });
      return JSON.stringify({ verdict: "approved", confidence: "high", summary: "matches claim", issues: [] });
    };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "approved");
    assert.equal(r.audit_model, "mistral-large-latest"); // C-1 opposite family
    assert.equal(palCalls.length, 1);
    assert.equal(palCalls[0].model, "mistral-large-latest");
    assert.equal(gh.calls.add.length, 1);
    assert.equal(gh.calls.add[0].label, "overseer:approved");
    assert.equal(gh.calls.remove.length, 0); // no prior label to remove
    assert.equal(ap.calls.length, 1);
    assert.equal(ap.calls[0].outcome, "approved");
    assert.equal(ap.calls[0].head_sha, "deadbeef");
  });

  it("idempotency: prior overseer:approved newer than head commit -> SKIP (no PAL call)", async () => {
    const pr = makePr({ number: 7, sha: "old", labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });
    const gh = mockGh({
      events: [{ event: "labeled", label: { name: "overseer:approved" }, created_at: new Date(NOW - 5 * 60_000).toISOString() }],
      commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } },
    });
    let palCalled = 0;
    const palCallFn = async () => { palCalled++; return ""; };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "skipped");
    assert.match(r.reason, /already-reviewed/);
    assert.equal(palCalled, 0);
    assert.equal(gh.calls.add.length, 0);
    assert.equal(gh.calls.remove.length, 0);
  });

  it("unknown family in PR -> abstain label, no PAL call", async () => {
    // Claude-generated PR (not in cross-family map). Must abstain, not silently
    // pick gemini or mistral.
    const pr = makePr({
      number: 99,
      sha: "abc",
      labels: ["dispatcher:auto", "model:claude-opus-4-7"],
      body: "",
    });
    const gh = mockGh({ events: [], commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } } });
    let palCalled = 0;
    const palCallFn = async () => { palCalled++; return ""; };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "abstain");
    assert.match(r.reason, /unknown-or-routed-family/);
    assert.equal(palCalled, 0);
    assert.equal(gh.calls.add[0].label, "overseer:abstain");
  });

  it("PAL quota-exhausted -> abstain, NOT rejected", async () => {
    const pr = makePr({ number: 11, sha: "qq", labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });
    const gh = mockGh({ events: [], commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } }, diff: "+x" });
    const palCallFn = async () => {
      const e = new Error("Resource exhausted: daily quota exceeded");
      e.status = 429;
      throw e;
    };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "abstain");
    assert.equal(gh.calls.add[0].label, "overseer:abstain");
    assert.match(ap.calls[0].summary ?? "", /quota/i);
  });

  it("GitHub events fetch 403 -> log-and-skip, never crashes (fail-soft)", async () => {
    const pr = makePr({ number: 12, labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });
    const err = new Error("rate limited");
    err.status = 403;
    const gh = mockGh({ eventsThrows: err });
    let palCalled = 0;
    const palCallFn = async () => { palCalled++; return ""; };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "skipped");
    assert.match(r.reason, /events-fetch-failed:403/);
    assert.equal(palCalled, 0);
    assert.equal(gh.calls.add.length, 0);
  });

  it("removes prior overseer:abstain before adding overseer:approved (re-review on new push)", async () => {
    const pr = makePr({ number: 5, sha: "newer", labels: ["dispatcher:auto", "model:codestral-latest"] });
    const gh = mockGh({
      events: [{ event: "labeled", label: { name: "overseer:abstain" }, created_at: new Date(NOW - 90 * 60_000).toISOString() }],
      commit: { commit: { committer: { date: new Date(NOW - 5 * 60_000).toISOString() } } },
      diff: "+x",
    });
    const palCallFn = async () => JSON.stringify({ verdict: "approved", confidence: "medium", summary: "looks good", issues: [] });
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "approved");
    assert.equal(gh.calls.remove.length, 1);
    assert.equal(gh.calls.remove[0].label, "overseer:abstain");
    assert.equal(gh.calls.add.length, 1);
    assert.equal(gh.calls.add[0].label, "overseer:approved");
  });

  it("422 on label add (already applied) is treated as success", async () => {
    const pr = makePr({ number: 13, labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });
    const err = new Error("label conflict");
    err.status = 422;
    const gh = mockGh({ events: [], commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } }, diff: "+x", addThrows: err });
    const palCallFn = async () => JSON.stringify({ verdict: "approved", confidence: "high", summary: "ok", issues: [] });
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });
    assert.equal(r.outcome, "approved");
    assert.equal(r.label_outcome.added, true);
    assert.equal(r.label_outcome.note, "already-applied");
  });
});

// ---------------------------------------------------------------------------
// runOverseer() -- top-level orchestrator
// ---------------------------------------------------------------------------

describe("runOverseer() top-level", () => {
  it("empty repos list -> log-and-skip, no work", async () => {
    const ap = mockAppender();
    const results = await runOverseer({ repos: [], appender: ap.fn, gh: mockGh(), palCallFn: async () => "" });
    assert.equal(results.length, 0);
    assert.equal(ap.calls.length, 1);
    assert.equal(ap.calls[0].outcome, "skipped");
    assert.equal(ap.calls[0].reason, "no-repos-configured");
  });

  it("list-prs failure on one repo -> sequential fail-soft, other repos still processed", async () => {
    const ap = mockAppender();
    const goodPr = makePr({ number: 1, labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });

    // Simulate a multi-repo run where the first repo's listing fails.
    const calls = { listed: [] };
    const gh = {
      async listOpenDispatcherActionablePrs(repo) {
        calls.listed.push(repo);
        if (repo === "p/bad") {
          const e = new Error("forbidden");
          e.status = 403;
          throw e;
        }
        return [goodPr];
      },
      async getPrDiff() { return "+x"; },
      async getIssueEvents() { return []; },
      async getHeadCommit() { return { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } }; },
      async addLabel() {},
      async removeLabel() {},
    };
    const palCallFn = async () => JSON.stringify({ verdict: "approved", confidence: "high", summary: "ok", issues: [] });

    const results = await runOverseer({ repos: ["p/bad", "p/good"], gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });
    assert.deepEqual(calls.listed, ["p/bad", "p/good"]);
    assert.equal(results.length, 1); // only p/good produced a result
    assert.equal(results[0].outcome, "approved");
    // ap should have one error log for p/bad and one approved for p/good
    const errors = ap.calls.filter((c) => c.outcome === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /list-failed:403/);
  });
});

// ---------------------------------------------------------------------------
// _trail
// ---------------------------------------------------------------------------

describe("_trail()", () => {
  it("preserves the tail (where errors usually land)", () => {
    const s = "head".padEnd(2000, "x") + "<<TAIL>>";
    const out = _trail(s, 500);
    assert.equal(out.length, 500);
    assert.match(out, /<<TAIL>>$/);
  });
  it("returns empty for nullish input", () => {
    assert.equal(_trail(null), "");
    assert.equal(_trail(undefined), "");
  });
});

// ===========================================================================
// Gate 6 (Pillar 1 step 4) -- cooling-off + ready-flip + merge.
// ===========================================================================

// Helpers for gate-6 tests.
function labelEvent(name, atMs) {
  return { event: "labeled", label: { name }, created_at: new Date(atMs).toISOString() };
}
function commentAt(atMs, body = "lgtm but actually wait") {
  return { body, created_at: new Date(atMs).toISOString(), user: { login: "perry" } };
}
function makeAutoMergePr({ number = 42, sha = "headsha1234", draft = true, labels = ["dispatcher:auto", "model:gemini-2.5-pro", "overseer:approved"] } = {}) {
  return {
    number,
    html_url: `https://github.com/test/repo/pull/${number}`,
    body: "auto PR\n- **Model:** `gemini-2.5-pro`",
    draft,
    head: { sha },
    labels: labels.map((name) => ({ name })),
  };
}
function mockGistClient({ pending = null, etag = "W/etag1", writeStatus = 200 } = {}) {
  const calls = { reads: 0, writes: [], lastEtag: null };
  return {
    calls,
    async readPendingMerges() {
      calls.reads++;
      return { data: pending, etag };
    },
    async writePendingMerges(payload, etagSent) {
      calls.writes.push({ payload, etag: etagSent });
      calls.lastEtag = etagSent;
      if (writeStatus >= 400) return { ok: false, status: writeStatus, reason: "test-fault" };
      return { ok: true, status: writeStatus };
    },
  };
}

describe("findLabelEvents()", () => {
  it("returns matching labeled events newest-first", () => {
    const events = [
      labelEvent("overseer:approved", NOW - 30 * 60_000),
      labelEvent("dispatcher:auto", NOW - 60 * 60_000),
      labelEvent("overseer:approved", NOW - 5 * 60_000),
      labelEvent("overseer:rejected", NOW - 10 * 60_000),
    ];
    const got = findLabelEvents(events, "overseer:approved");
    assert.equal(got.length, 2);
    assert.ok(got[0].ts > got[1].ts);
  });
  it("returns [] for unknown label", () => {
    assert.deepEqual(findLabelEvents([], "x"), []);
    assert.deepEqual(findLabelEvents(null, "x"), []);
  });
});

describe("normalizeRepoList() / findRepoEntry()", () => {
  it("accepts mixed string + object entries; legacy strings are auto_merge-false", () => {
    const cfg = ["a/b", { owner_repo: "c/d", auto_merge: true, project_slug: "cd" }];
    assert.deepEqual(normalizeRepoList(cfg), ["a/b", "c/d"]);
    assert.equal(findRepoEntry(cfg, "a/b"), "a/b");
    const cd = findRepoEntry(cfg, "c/d");
    assert.equal(cd.auto_merge, true);
    assert.equal(cd.project_slug, "cd");
    assert.equal(findRepoEntry(cfg, "missing"), null);
  });
});

describe("resolveAutoMergeConfig()", () => {
  it("default-to-disabled when either flag is false", () => {
    assert.equal(resolveAutoMergeConfig({ topLevelAutoMerge: false, repoEntry: { owner_repo: "a/b", auto_merge: true } }).enabled, false);
    assert.equal(resolveAutoMergeConfig({ topLevelAutoMerge: true,  repoEntry: { owner_repo: "a/b", auto_merge: false } }).enabled, false);
    assert.equal(resolveAutoMergeConfig({ topLevelAutoMerge: true,  repoEntry: "a/b" }).enabled, false);
    assert.equal(resolveAutoMergeConfig({ topLevelAutoMerge: true,  repoEntry: null }).enabled, false);
  });
  it("enables only when BOTH layers are true", () => {
    const c = resolveAutoMergeConfig({
      topLevelAutoMerge: true,
      repoEntry: { owner_repo: "a/b", auto_merge: true, merge_strategy: "rebase", project_slug: "demo" },
      coolingOffMinutes: 30,
      coolingOffMinutesAfterReady: 5,
    });
    assert.equal(c.enabled, true);
    assert.equal(c.mergeStrategy, "rebase");
    assert.equal(c.projectSlug, "demo");
    assert.equal(c.coolingOffMinutes, 30);
    assert.equal(c.coolingOffMinutesAfterReady, 5);
  });
  it("clamps merge_strategy to allowed values", () => {
    const c = resolveAutoMergeConfig({
      topLevelAutoMerge: true,
      repoEntry: { owner_repo: "a/b", auto_merge: true, merge_strategy: "shenanigans" },
    });
    assert.equal(c.mergeStrategy, "squash");
  });
});

describe("evaluateCoolingOff() -- pure state machine", () => {
  const baseEvents = (approveAtMs) => [labelEvent("overseer:approved", approveAtMs)];

  it("returns skip:auto-merge-not-enabled when disabled", () => {
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr(),
      events: baseEvents(NOW - 60 * 60_000),
      comments: [],
      autoMergeEnabled: false,
      now: NOW,
    });
    assert.equal(r.action, "skip");
    assert.equal(r.reason, "auto-merge-not-enabled");
  });

  it("returns skip:no-approve-label when never approved", () => {
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ labels: ["dispatcher:auto"] }),
      events: [],
      comments: [],
      autoMergeEnabled: true,
      now: NOW,
    });
    assert.equal(r.action, "skip");
    assert.equal(r.reason, "no-approve-label");
  });

  it("returns skip when cooling-off has not yet elapsed", () => {
    const approveAt = NOW - 10 * 60_000; // 10 min ago
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr(),
      events: baseEvents(approveAt),
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "skip");
    assert.match(r.reason, /^cooling-off-not-elapsed:\d+s-remaining$/);
  });

  it("returns ready-flip when cooling-off has elapsed and PR is draft", () => {
    const approveAt = NOW - 60 * 60_000;
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: true }),
      events: baseEvents(approveAt),
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "ready-flip");
    assert.equal(r.approveAtMs, approveAt);
  });

  it("blocks when human comment landed AFTER approval", () => {
    const approveAt = NOW - 60 * 60_000;
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr(),
      events: baseEvents(approveAt),
      comments: [commentAt(approveAt + 5 * 60_000)],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "block");
    assert.equal(r.reason, "human-comment-after-approval");
  });

  it("blocks when head SHA advanced after approval (re-review needed)", () => {
    const approveAt = NOW - 60 * 60_000;
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr(),
      events: baseEvents(approveAt),
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      now: NOW,
      headCommittedAt: new Date(approveAt + 5 * 60_000).toISOString(), // newer than label
    });
    assert.equal(r.action, "block");
    assert.equal(r.reason, "head-advanced-since-approval");
  });

  it("blocks when PR is no longer draft and bot has not flipped ready (human flipped)", () => {
    const approveAt = NOW - 60 * 60_000;
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: false }),
      events: baseEvents(approveAt), // no overseer:ready-flipped sentinel
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "block");
    assert.equal(r.reason, "pr-not-draft-and-not-flipped-by-bot");
  });

  it("returns merge when bot has ready-flipped, after-cooling-off elapsed, PR ready", () => {
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: false }),
      events: [
        labelEvent("overseer:approved", approveAt),
        labelEvent("overseer:ready-flipped", readyAt),
      ],
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      coolingOffMinutesAfterReady: 0,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "merge");
    assert.equal(r.headSha, "headsha1234");
  });

  it("blocks when PR was reverted to draft AFTER ready-flip (human convert-to-draft event present)", () => {
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    const convertAt = NOW - 20 * 60_000; // human reverted after the bot's ready-flip
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: true }), // reverted
      events: [
        labelEvent("overseer:approved", approveAt),
        labelEvent("overseer:ready-flipped", readyAt),
        { event: "convert_to_draft", created_at: new Date(convertAt).toISOString() },
      ],
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      coolingOffMinutesAfterReady: 0,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "block");
    assert.equal(r.reason, "pr-converted-to-draft-after-ready-flip");
  });

  it("retries (completing-ready-flip) when sentinel applied but PR still draft and NO convert-to-draft event (orphan recovery from PAL HIGH)", () => {
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    // Sentinel landed (label-first ordering) but the subsequent setReady call
    // failed or the runner died before completing it. No convert_to_draft event
    // in the timeline -> the bot's previous tick orphaned the half-completed
    // ready-flip; we should retry.
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: true }),
      events: [
        labelEvent("overseer:approved", approveAt),
        labelEvent("overseer:ready-flipped", readyAt),
        // no convert_to_draft event
      ],
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      coolingOffMinutesAfterReady: 0,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "ready-flip");
    assert.equal(r.reason, "completing-ready-flip");
  });

  it("blocks (stalled-ready-flip) when sentinel applied + still draft + recovery has been retrying for >24h (PAL MEDIUM fix)", () => {
    const approveAt = NOW - 25 * 60 * 60_000; // 25h ago
    const readyAt = NOW - 25 * 60 * 60_000 + 60_000; // sentinel landed ~25h ago
    // The orphan-recovery loop must not retry forever; bail after 24h so the
    // operator must intervene (likely permissions permanently revoked).
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: true }),
      events: [
        labelEvent("overseer:approved", approveAt),
        labelEvent("overseer:ready-flipped", readyAt),
      ],
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      coolingOffMinutesAfterReady: 0,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "block");
    assert.equal(r.reason, "stalled-ready-flip-exceeded-max-duration");
  });

  it("blocks when convert_to_draft event predates ready-flip (stale event from prior cycle)", () => {
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    const convertAt = NOW - 50 * 60_000; // convert_to_draft BEFORE ready-flip -> stale, not human revert
    // This stale convert_to_draft must not block the bot from retrying a
    // half-completed ready-flip. Without the >= readyAtMs guard, the bot
    // would block forever on a PR that had a stale convert event.
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: true }),
      events: [
        { event: "convert_to_draft", created_at: new Date(convertAt).toISOString() },
        labelEvent("overseer:approved", approveAt),
        labelEvent("overseer:ready-flipped", readyAt),
      ],
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      coolingOffMinutesAfterReady: 0,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "ready-flip");
    assert.equal(r.reason, "completing-ready-flip");
  });

  it("returns skip when bot has merged already (terminal)", () => {
    const approveAt = NOW - 60 * 60_000;
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: false }),
      events: [
        labelEvent("overseer:approved", approveAt),
        labelEvent("overseer:ready-flipped", NOW - 30 * 60_000),
        labelEvent("overseer:merged", NOW - 25 * 60_000),
      ],
      comments: [],
      autoMergeEnabled: true,
      coolingOffMinutes: 45,
      now: NOW,
      headCommittedAt: new Date(approveAt - 60_000).toISOString(),
    });
    assert.equal(r.action, "skip");
    assert.equal(r.reason, "already-merged-by-overseer");
  });
});

// ---------------------------------------------------------------------------
// reviewOnePr() integration tests for gate 6
// ---------------------------------------------------------------------------

function gateMockGh(opts = {}) {
  // Extend the existing mockGh with gate-6 methods. setReady/mergePr/listIssueComments.
  const calls = {
    list: 0, diff: 0, events: 0, commit: 0, comments: 0,
    add: [], remove: [], setReady: [], merge: [],
  };
  return {
    calls,
    async listOpenDispatcherActionablePrs() { calls.list++; return opts.prs ?? []; },
    async getPrDiff() { calls.diff++; return opts.diff ?? "+x"; },
    async getIssueEvents() { calls.events++; if (opts.eventsThrows) throw opts.eventsThrows; return opts.events ?? []; },
    async getHeadCommit() { calls.commit++; if (opts.commitThrows) throw opts.commitThrows; return opts.commit ?? { commit: { committer: { date: new Date(NOW - 24 * 60 * 60_000).toISOString() } } }; },
    async listIssueComments() { calls.comments++; if (opts.commentsThrows) throw opts.commentsThrows; return opts.comments ?? []; },
    async addLabel(repo, n, label) { calls.add.push({ repo, n, label }); if (opts.addThrows) throw opts.addThrows; },
    async removeLabel(repo, n, label) { calls.remove.push({ repo, n, label }); if (opts.removeThrows) throw opts.removeThrows; },
    async setReady(repo, n) { calls.setReady.push({ repo, n }); if (opts.setReadyThrows) throw opts.setReadyThrows; },
    async mergePr(repo, n, args) { calls.merge.push({ repo, n, args }); if (opts.mergeThrows) throw opts.mergeThrows; return opts.mergeResp ?? { sha: "mergesha789", merged: true }; },
  };
}

describe("reviewOnePr() gate 6 -- auto-merge progression", () => {
  it("auto_merge:false (label-only mode) takes the existing skip path on already-approved PRs", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
    });
    const palCallFn = async () => "(should not be called)";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr(),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: { enabled: false },
      now: () => NOW,
    });
    assert.equal(r.outcome, "skipped");
    assert.match(r.reason, /already-reviewed:overseer:approved/);
    // No gate-6 side effects
    assert.equal(gh.calls.setReady.length, 0);
    assert.equal(gh.calls.merge.length, 0);
  });

  it("cooling-off not elapsed -> auto-merge-pending log entry, no merge", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 5 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr(),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000, 3_600_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-pending");
    assert.match(r.reason, /^cooling-off-not-elapsed/);
    assert.equal(gh.calls.setReady.length, 0);
    assert.equal(gh.calls.merge.length, 0);
  });

  it("cooling-off elapsed + draft -> ready-flip + sentinel label, no merge yet", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: true }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-ready-flipped");
    assert.equal(gh.calls.setReady.length, 1);
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(gh.calls.add[0].label, "overseer:ready-flipped");
  });

  it("post ready-flip + after-cooling-off elapsed + ready -> merge + sentinel + gist write", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt), labelEvent("overseer:ready-flipped", readyAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
    });
    const palCallFn = async () => "";
    const gistClient = mockGistClient();
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: false }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000, 3_600_000],
      },
      gistClient,
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-merged");
    assert.equal(gh.calls.merge.length, 1);
    assert.equal(gh.calls.merge[0].args.mergeMethod, "squash");
    assert.equal(gh.calls.merge[0].args.sha, "headsha1234");
    // overseer:merged sentinel must be applied AFTER the merge call.
    assert.ok(gh.calls.add.some((c) => c.label === "overseer:merged"));
    // Gist write captured the entry with project_slug + merge SHA.
    assert.equal(gistClient.calls.writes.length, 1);
    const written = gistClient.calls.writes[0].payload;
    assert.equal(written.entries.length, 1);
    assert.equal(written.entries[0].repo, "a/b");
    assert.equal(written.entries[0].project_slug, "demo");
    assert.equal(written.entries[0].merge_commit_sha, "mergesha789");
    assert.equal(written.entries[0].replays_done, 0);
    assert.equal(written.schema_version, 1);
  });

  it("human comment after approval -> auto-merge-blocked, no ready-flip, no merge", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
      comments: [commentAt(approveAt + 10 * 60_000, "actually wait, let me look")],
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr(),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-blocked");
    assert.equal(r.reason, "human-comment-after-approval");
    assert.equal(gh.calls.setReady.length, 0);
    assert.equal(gh.calls.merge.length, 0);
  });

  it("comments fetch failure -> auto-merge-blocked (default-to-block)", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const err = new Error("network down"); err.status = 502;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
      commentsThrows: err,
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr(),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-blocked");
    assert.match(r.reason, /comments-fetch-failed/);
    assert.equal(gh.calls.merge.length, 0);
  });

  it("PR not draft and bot did not flip ready -> auto-merge-blocked", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)], // no ready-flipped sentinel
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: false }), // human flipped ready early
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-blocked");
    assert.equal(r.reason, "pr-not-draft-and-not-flipped-by-bot");
    assert.equal(gh.calls.merge.length, 0);
  });

  it("merged sentinel present -> skipped silently (terminal, already gate-7's job)", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const gh = gateMockGh({
      events: [
        labelEvent("overseer:approved", approveAt),
        labelEvent("overseer:ready-flipped", NOW - 30 * 60_000),
        labelEvent("overseer:merged", NOW - 25 * 60_000),
      ],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: false }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "skipped");
    assert.equal(r.reason, "already-merged-by-overseer");
    assert.equal(gh.calls.merge.length, 0);
  });

  it("PAL HIGH-2: missing gistClient blocks the merge -- gate-7-monitor-not-configured", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt), labelEvent("overseer:ready-flipped", readyAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
    });
    const palCallFn = async () => "";
    // gistClient intentionally omitted (operator forgot STATUS_GIST_ID).
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: false }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      // gistClient: undefined,
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-blocked");
    assert.equal(r.reason, "gate-7-monitor-not-configured");
    // No merge call, no merged sentinel.
    assert.equal(gh.calls.merge.length, 0);
    assert.ok(!gh.calls.add.some((c) => c.label === "overseer:merged"));
  });

  it("PAL HIGH-1: future-version pending-merges.json refuses write (no schema downgrade)", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt), labelEvent("overseer:ready-flipped", readyAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
    });
    const palCallFn = async () => "";
    // Gist returns schema_version: 99 -- a future version we don't recognize.
    const gistClient = mockGistClient({
      pending: {
        schema_version: 99,
        entries: [{ repo: "a/b", pr_number: 1, future_field: "important", merge_commit_sha: "old" }],
      },
    });
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: false }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      gistClient,
      now: () => NOW,
    });
    // Merge happened (the safety net here is gist-side, not merge-side --
    // the merge was already cleared by gates 1-6).
    assert.equal(r.outcome, "auto-merge-merged");
    // But gist was NOT clobbered.
    assert.equal(gistClient.calls.writes.length, 0, "no v1 write to a v99 gist");
    assert.match(r.gist_outcome.reason, /^gist-schema-version-newer:remote=99-local=1$/);
  });

  it("merge fails (e.g. branch protection 405) -> auto-merge-error, no sentinel, no gist write", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    const err = new Error("Method Not Allowed"); err.status = 405;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt), labelEvent("overseer:ready-flipped", readyAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
      mergeThrows: err,
    });
    const palCallFn = async () => "";
    const gistClient = mockGistClient();
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: false }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      gistClient,
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-error");
    assert.match(r.reason, /merge-failed:405/);
    assert.equal(gh.calls.merge.length, 1); // attempted
    assert.ok(!gh.calls.add.some((c) => c.label === "overseer:merged"), "no merged sentinel on failed merge");
    assert.equal(gistClient.calls.writes.length, 0, "no gist write on failed merge");
  });

  it("setReady fails (non-422) AFTER sentinel landed -> auto-merge-ready-flipped-set-ready-failed; sentinel preserved so next tick retries via completing-ready-flip (PAL HIGH fix)", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const err = new Error("forbidden"); err.status = 403;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
      setReadyThrows: err,
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: true }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-ready-flipped-set-ready-failed");
    assert.match(r.reason, /set-ready-failed:403/);
    assert.equal(gh.calls.setReady.length, 1);
    // Sentinel WAS applied first (label-first ordering) so next tick can find
    // the PR via the listing filter and complete the half-finished ready-flip.
    assert.ok(gh.calls.add.some((c) => c.label === "overseer:ready-flipped"));
  });

  it("addLabel sentinel fails -> auto-merge-error with sentinel-add-failed; setReady NOT called (no half-state, next tick retries clean)", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const err = new Error("rate limited"); err.status = 403;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)],
      commit: { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } },
      addThrows: err,
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: true }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-error");
    assert.equal(r.reason, "sentinel-add-failed");
    // setReady NOT called -> no PR mutation -> next tick still sees draft===true
    // and re-enters the ready-flip path cleanly.
    assert.equal(gh.calls.setReady.length, 0);
  });

  it("head SHA advanced past approve label -> auto-merge-blocked, no merge", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const gh = gateMockGh({
      events: [labelEvent("overseer:approved", approveAt)],
      commit: { commit: { committer: { date: new Date(approveAt + 10 * 60_000).toISOString() } } },
    });
    const palCallFn = async () => "";
    const r = await reviewOnePr({
      repo: "a/b",
      pr: makeAutoMergePr({ draft: true }),
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig: {
        enabled: true,
        coolingOffMinutes: 45,
        coolingOffMinutesAfterReady: 0,
        mergeStrategy: "squash",
        projectSlug: "demo",
        postMergeReplayScheduleMs: [900_000],
      },
      now: () => NOW,
    });
    assert.equal(r.outcome, "auto-merge-blocked");
    assert.equal(r.reason, "head-advanced-since-approval");
    assert.equal(gh.calls.merge.length, 0);
  });
});

// runOverseer wiring for the new shape -----------------------------------------

describe("runOverseer() with reposCfg objects", () => {
  it("resolves per-repo auto_merge from object entries; bare strings stay read-only", async () => {
    const ap = mockAppender();
    const approveAt = NOW - 60 * 60_000;
    const calls = { listed: [] };
    const gh = {
      async listOpenDispatcherActionablePrs(repo) {
        calls.listed.push(repo);
        // Return one previously-approved draft PR per repo.
        return [makeAutoMergePr({ number: 7 })];
      },
      async getPrDiff() { return "+x"; },
      async getIssueEvents() { return [labelEvent("overseer:approved", approveAt)]; },
      async getHeadCommit() { return { commit: { committer: { date: new Date(approveAt - 60_000).toISOString() } } }; },
      async listIssueComments() { return []; },
      async addLabel() {},
      async removeLabel() {},
      async setReady() {},
      async mergePr() { return { sha: "msha", merged: true }; },
    };
    const palCallFn = async () => JSON.stringify({ verdict: "approved", confidence: "high", summary: "ok", issues: [] });
    const gistClient = mockGistClient();
    const results = await runOverseer({
      reposCfg: [
        "legacy/readonly",                                                 // string -> auto_merge:false
        { owner_repo: "opted/in", auto_merge: true, project_slug: "in" },  // object opted-in
      ],
      topLevelAutoMerge: true,
      gh, palCallFn, gistClient, appender: ap.fn,
      now: () => NOW,
    });
    assert.deepEqual(calls.listed, ["legacy/readonly", "opted/in"]);
    // legacy/readonly: was already approved -> existing skip path (idempotent).
    const legacy = results.find((r) => r.repo === "legacy/readonly");
    assert.equal(legacy.outcome, "skipped");
    // opted/in: cooling-off elapsed, draft -> ready-flip.
    const opted = results.find((r) => r.repo === "opted/in");
    assert.equal(opted.outcome, "auto-merge-ready-flipped");
  });
});

// ---------------------------------------------------------------------------
// Bug A regression coverage: createDefaultGitHubClient.setReady() must use
// GraphQL markPullRequestReadyForReview because GitHub REST PATCH /pulls
// silently no-ops the `draft` body param. These tests stub globalThis.fetch
// because createDefaultGitHubClient uses module-level ghFetch (no DI hook).
// ---------------------------------------------------------------------------

function withFetchStub(handler, fn) {
  return async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = handler;
    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  };
}

function fetchResponse({ ok = true, status = 200, statusText = "OK", body = {} }) {
  return {
    ok,
    status,
    statusText,
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

describe("createDefaultGitHubClient.setReady() -- GraphQL markPullRequestReadyForReview (Bug A fix)", () => {
  it("happy path: REST GET returns node_id, GraphQL mutation returns isDraft:false -> resolves", withFetchStub(
    async (url, opts) => {
      if (typeof url === "string" && url.includes("/pulls/")) {
        return fetchResponse({ body: { node_id: "PR_kwDOABC123" } });
      }
      if (typeof url === "string" && url.endsWith("/graphql")) {
        const parsed = JSON.parse(opts?.body ?? "{}");
        assert.equal(parsed.variables.id, "PR_kwDOABC123", "graphql: passes node_id from REST step");
        assert.match(parsed.query, /markPullRequestReadyForReview/);
        return fetchResponse({
          body: { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_kwDOABC123", isDraft: false } } } },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async () => {
      const gh = createDefaultGitHubClient("ghp_test");
      await gh.setReady("owner/repo", 42); // resolves without throwing
    },
  ));

  it("REST detail missing node_id -> throws GitHubError", withFetchStub(
    async (url) => {
      if (typeof url === "string" && url.includes("/pulls/")) {
        return fetchResponse({ body: { number: 42 } }); // no node_id
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async () => {
      const gh = createDefaultGitHubClient("ghp_test");
      await assert.rejects(
        () => gh.setReady("owner/repo", 42),
        (err) => /missing node_id/.test(err?.message),
      );
    },
  ));

  it("GraphQL response has non-empty errors array -> throws GitHubError with errors trail", withFetchStub(
    async (url) => {
      if (typeof url === "string" && url.includes("/pulls/")) {
        return fetchResponse({ body: { node_id: "PR_x" } });
      }
      if (typeof url === "string" && url.endsWith("/graphql")) {
        return fetchResponse({
          body: {
            errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
            data: null,
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async () => {
      const gh = createDefaultGitHubClient("ghp_test");
      await assert.rejects(
        () => gh.setReady("owner/repo", 42),
        (err) => /setReady graphql:/.test(err?.message) && /FORBIDDEN/.test(err?.message),
      );
    },
  ));

  it("GraphQL response has isDraft:true (silent no-op like Bug A had) -> throws GitHubError", withFetchStub(
    async (url) => {
      if (typeof url === "string" && url.includes("/pulls/")) {
        return fetchResponse({ body: { node_id: "PR_x" } });
      }
      if (typeof url === "string" && url.endsWith("/graphql")) {
        return fetchResponse({
          body: { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_x", isDraft: true } } } },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async () => {
      const gh = createDefaultGitHubClient("ghp_test");
      await assert.rejects(
        () => gh.setReady("owner/repo", 42),
        (err) => /still draft after mutation/.test(err?.message),
      );
    },
  ));
});

// ---------------------------------------------------------------------------
// Bug B regression coverage: listOpenDispatcherActionablePrs must include
// ready PRs that carry the overseer:ready-flipped sentinel, otherwise the
// gate-6 merge tick never finds the PR it just flipped.
// ---------------------------------------------------------------------------

describe("createDefaultGitHubClient.listOpenDispatcherActionablePrs() -- filter (Bug B fix)", () => {
  function makeApiPr({ number, draft, labels }) {
    return {
      number,
      draft,
      labels: labels.map((name) => ({ name })),
      head: { sha: `sha${number}` },
    };
  }

  function listingFetchStub(prs) {
    return async (url) => {
      if (typeof url === "string" && url.includes("/pulls?state=open")) {
        return fetchResponse({ body: prs });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  }

  it("draft + dispatcher:auto -> returned (gate-5 + ready-flip path)", withFetchStub(
    listingFetchStub([makeApiPr({ number: 1, draft: true, labels: ["dispatcher:auto"] })]),
    async () => {
      const gh = createDefaultGitHubClient("ghp_test");
      const got = await gh.listOpenDispatcherActionablePrs("owner/repo");
      assert.equal(got.length, 1);
      assert.equal(got[0].number, 1);
    },
  ));

  it("ready + dispatcher:auto + overseer:ready-flipped -> returned (gate-6 merge path; the Bug B fix)", withFetchStub(
    listingFetchStub([makeApiPr({ number: 2, draft: false, labels: ["dispatcher:auto", "overseer:approved", "overseer:ready-flipped"] })]),
    async () => {
      const gh = createDefaultGitHubClient("ghp_test");
      const got = await gh.listOpenDispatcherActionablePrs("owner/repo");
      assert.equal(got.length, 1);
      assert.equal(got[0].number, 2);
    },
  ));

  it("ready + dispatcher:auto WITHOUT sentinel -> filtered out (defends against unrelated human-flipped PRs)", withFetchStub(
    listingFetchStub([makeApiPr({ number: 3, draft: false, labels: ["dispatcher:auto", "overseer:approved"] })]),
    async () => {
      const gh = createDefaultGitHubClient("ghp_test");
      const got = await gh.listOpenDispatcherActionablePrs("owner/repo");
      assert.equal(got.length, 0);
    },
  ));

  it("draft but no dispatcher:auto -> filtered out", withFetchStub(
    listingFetchStub([makeApiPr({ number: 4, draft: true, labels: ["bugfix", "wip"] })]),
    async () => {
      const gh = createDefaultGitHubClient("ghp_test");
      const got = await gh.listOpenDispatcherActionablePrs("owner/repo");
      assert.equal(got.length, 0);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration test crossing the listing layer. The gap that allowed both
// Bug A and Bug B to ship: existing tests construct gateMockGh with state
// baked in at construction time, so setReady/addLabel never feed back into
// listOpenDispatcherActionablePrs. This test uses a stateful mock where
// mutator methods feed the listing layer, and exercises three ticks:
//
//   tick 1: draft + no overseer label   -> approve
//   tick 2: cooling-off elapsed + draft -> setReady (Bug A fix proof)
//                                       + ready-flipped sentinel
//   tick 3: ready + sentinel            -> merge (Bug B fix proof:
//                                          listing layer must STILL return
//                                          the PR even though draft===false)
// ---------------------------------------------------------------------------

function statefulMockGh({ initialPr, headCommitTs, mergeResp = { sha: "mergesha789", merged: true } }) {
  let nowMs = NOW;
  const pr = { ...initialPr, labels: [...(initialPr.labels ?? [])] };
  const events = [];
  const calls = { list: [], setReady: [], merge: [], add: [], removeLabel: [], comments: 0 };
  return {
    pr, events, calls,
    setNow(ms) { nowMs = ms; },
    async listOpenDispatcherActionablePrs(repo) {
      calls.list.push(repo);
      const names = pr.labels.map((l) => l?.name);
      if (!names.includes("dispatcher:auto")) return [];
      if (pr.draft === true || names.includes("overseer:ready-flipped")) return [pr];
      return [];
    },
    async getPrDiff() { return "+x\n"; },
    async getIssueEvents() { return events.slice(); },
    async getHeadCommit() {
      return { commit: { committer: { date: new Date(headCommitTs).toISOString() } } };
    },
    async listIssueComments() { calls.comments++; return []; },
    async addLabel(repo, n, label) {
      calls.add.push({ repo, n, label });
      if (!pr.labels.some((l) => l?.name === label)) pr.labels.push({ name: label });
      events.push({ event: "labeled", created_at: new Date(nowMs).toISOString(), label: { name: label } });
    },
    async removeLabel(repo, n, label) {
      calls.removeLabel.push({ repo, n, label });
      pr.labels = pr.labels.filter((l) => l?.name !== label);
    },
    async setReady(repo, n) {
      calls.setReady.push({ repo, n });
      pr.draft = false;
      events.push({ event: "ready_for_review", created_at: new Date(nowMs).toISOString() });
    },
    async mergePr(repo, n, args) {
      calls.merge.push({ repo, n, args });
      return mergeResp;
    },
  };
}

describe("runOverseer() -- integration across ticks (Bug A + Bug B regression coverage)", () => {
  it("end-to-end: draft -> approved -> ready-flipped -> merged across three reviewOnePr ticks", async () => {
    const ap = mockAppender();
    const TICK1_NOW = NOW;
    const TICK2_NOW = TICK1_NOW + 70_000;       // > 1 min cooling-off after tick-1 approve
    const TICK3_NOW = TICK2_NOW + 10_000;       // > 0 min after-ready cooling-off
    const HEAD_COMMIT_TS = TICK1_NOW - 60 * 60_000; // 1h before tick 1 (idempotency: head < approve)

    const initialPr = makeAutoMergePr({
      number: 99,
      draft: true,
      labels: ["dispatcher:auto", "model:gemini-2.5-pro"], // no overseer:* yet
    });
    const gh = statefulMockGh({ initialPr, headCommitTs: HEAD_COMMIT_TS });
    const palCallFn = async () => JSON.stringify({
      verdict: "approved",
      confidence: "high",
      summary: "ok",
      issues: [],
    });
    const gistClient = mockGistClient();
    const autoMergeConfig = {
      enabled: true,
      coolingOffMinutes: 1,                    // smoke value for tight test
      coolingOffMinutesAfterReady: 0,
      mergeStrategy: "squash",
      projectSlug: "demo",
      postMergeReplayScheduleMs: [900_000],
    };
    const reviewArgs = {
      repo: "a/b",
      gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000,
      autoMergeConfig, gistClient,
    };

    // ----- TICK 1 -- gate 5: review the draft -> approve
    gh.setNow(TICK1_NOW);
    const prs1 = await gh.listOpenDispatcherActionablePrs("a/b");
    assert.equal(prs1.length, 1, "tick 1: draft + dispatcher:auto must be listed");
    const r1 = await reviewOnePr({ ...reviewArgs, pr: prs1[0], now: () => TICK1_NOW });
    assert.equal(r1.outcome, "approved", "tick 1: gate-5 emits verdict outcome");
    assert.ok(gh.pr.labels.some((l) => l.name === "overseer:approved"), "tick 1: overseer:approved applied");
    assert.equal(gh.pr.draft, true, "tick 1: PR is still a draft");

    // ----- TICK 2 -- gate 6: cooling-off elapsed + draft -> setReady + sentinel
    gh.setNow(TICK2_NOW);
    const prs2 = await gh.listOpenDispatcherActionablePrs("a/b");
    assert.equal(prs2.length, 1, "tick 2: draft + dispatcher:auto must still be listed");
    const r2 = await reviewOnePr({ ...reviewArgs, pr: prs2[0], now: () => TICK2_NOW });
    assert.equal(r2.outcome, "auto-merge-ready-flipped", "tick 2: gate-6 ready-flip");
    assert.equal(gh.calls.setReady.length, 1, "tick 2: setReady fired exactly once");
    assert.equal(gh.pr.draft, false, "tick 2: stateful mock flipped draft -> false (Bug A fix proof)");
    assert.ok(gh.pr.labels.some((l) => l.name === "overseer:ready-flipped"), "tick 2: sentinel applied");

    // ----- TICK 3 -- gate 6: ready + sentinel -> merge
    // This is the Bug B fix proof: the listing layer MUST return the PR
    // even though pr.draft === false, because of the sentinel label.
    gh.setNow(TICK3_NOW);
    const prs3 = await gh.listOpenDispatcherActionablePrs("a/b");
    assert.equal(prs3.length, 1, "tick 3 (Bug B fix proof): ready PR with sentinel must still be listed");
    const r3 = await reviewOnePr({ ...reviewArgs, pr: prs3[0], now: () => TICK3_NOW });
    assert.equal(r3.outcome, "auto-merge-merged", "tick 3: gate-6 merge");
    assert.equal(gh.calls.merge.length, 1, "tick 3: mergePr fired exactly once");
    assert.equal(gh.calls.merge[0].args.mergeMethod, "squash");
    assert.ok(gh.pr.labels.some((l) => l.name === "overseer:merged"), "tick 3: overseer:merged sentinel applied");
    assert.equal(gistClient.calls.writes.length, 1, "tick 3: pending-merges entry written to gist");
    const written = gistClient.calls.writes[0].payload;
    assert.equal(written.entries[0].project_slug, "demo");
    assert.equal(written.entries[0].merge_commit_sha, "mergesha789");
  });
});

// ===========================================================================
// runCli (CLI integration) -- Bug C regression coverage.
//
// Bug C (2026-04-26): the prior `if (cli.repo) reposCfg = [cli.repo];` line
// in the CLI block destructively overwrote object-form OVERSEER_REPOS_JSON
// entries (which carry per-repo auto_merge / merge_strategy / project_slug)
// with bare-string arrays whenever the --repo CLI flag was passed. Gate 6
// silent-skipped because cfg.enabled collapsed to false.
//
// These tests exercise the import.meta.url branch through the exported
// runCli() seam with injected gh / palCallFn / gistClient mocks.
// ===========================================================================

function makeApprovedPrAtSha(opts = {}) {
  return makeAutoMergePr({
    number: opts.number ?? 42,
    sha: opts.sha ?? "approvedsha",
    draft: opts.draft ?? true,
  });
}

function ghForCliTest({ prsByRepo = {}, approveAtMs = NOW - 60 * 60_000 } = {}) {
  // Stateful mock that records which repos were listed and supports the
  // gate-6 cooling-off path: getIssueEvents returns a labeled event for
  // overseer:approved at approveAtMs; getHeadCommit returns a commit older
  // than the approve event so headCommittedAt < approveAt (idempotency
  // guard at evaluateCoolingOff passes).
  const calls = { listed: [], setReady: [], merge: [], add: [] };
  return {
    calls,
    async listOpenDispatcherActionablePrs(repo) {
      calls.listed.push(repo);
      return prsByRepo[repo] ?? [];
    },
    async getPrDiff() { return "+x"; },
    async getIssueEvents() { return [labelEvent("overseer:approved", approveAtMs)]; },
    async getHeadCommit() {
      return { commit: { committer: { date: new Date(approveAtMs - 60_000).toISOString() } } };
    },
    async listIssueComments() { return []; },
    async addLabel(repo, n, label) { calls.add.push({ repo, n, label }); },
    async removeLabel() {},
    async setReady(repo, n) { calls.setReady.push({ repo, n }); },
    async mergePr(repo, n, args) {
      calls.merge.push({ repo, n, args });
      return { sha: `merged-${n}`, merged: true };
    },
  };
}

const cliPalApproved = async () =>
  JSON.stringify({ verdict: "approved", confidence: "high", summary: "ok", issues: [] });

describe("runCli (CLI integration) -- Bug C regression", () => {
  it("--repo + object-form REPOS_JSON preserves per-repo auto_merge (gate 6 engages)", async () => {
    const gh = ghForCliTest({ prsByRepo: { "o/r": [makeApprovedPrAtSha({ number: 42 })] } });
    const gistClient = mockGistClient();
    const env = {
      OVERSEER_REPOS_JSON: JSON.stringify([
        { owner_repo: "o/r", auto_merge: true, merge_strategy: "squash", project_slug: "x" },
      ]),
      OVERSEER_AUTO_MERGE: "true",
      OVERSEER_COOLING_OFF_MINUTES: "1",
    };
    const results = await runCli({
      argv: ["--pr", "42", "--repo", "o/r"],
      env,
      deps: { gh, palCallFn: cliPalApproved, gistClient, now: () => NOW },
    });
    // Bug C proof: cfg.enabled === true means gate 6 reaches setReady on the
    // already-approved draft PR (cooling-off-elapsed since coolingOffMinutes=0).
    assert.equal(gh.calls.setReady.length, 1, "Bug C regression: gate 6 ready-flip must fire when REPOS_JSON object carries auto_merge:true");
    assert.equal(gh.calls.setReady[0].repo, "o/r");
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "auto-merge-ready-flipped");
  });

  it("--repo + bare-string REPOS_JSON correctly disables auto_merge (read-only contract held)", async () => {
    const gh = ghForCliTest({ prsByRepo: { "o/r": [makeApprovedPrAtSha({ number: 42 })] } });
    const gistClient = mockGistClient();
    const env = {
      OVERSEER_REPOS_JSON: JSON.stringify(["o/r"]),
      OVERSEER_AUTO_MERGE: "true",
      OVERSEER_COOLING_OFF_MINUTES: "1",
    };
    const results = await runCli({
      argv: ["--pr", "42", "--repo", "o/r"],
      env,
      deps: { gh, palCallFn: cliPalApproved, gistClient, now: () => NOW },
    });
    // Bare strings -> auto_merge:false at the per-repo layer -> cfg.enabled
    // false -> gate 6 must NOT fire. PR is already approved, so the gate-5
    // idempotency skip applies.
    assert.equal(gh.calls.setReady.length, 0, "bare-string entries must keep gate 6 dormant even with --repo");
    assert.equal(results[0].outcome, "skipped");
    assert.match(results[0].reason ?? "", /already-reviewed/);
  });

  it("no --repo flag passes only:{prNumber} (no repo filter; both object-form repos iterated)", async () => {
    const gh = ghForCliTest({
      prsByRepo: {
        "o/r1": [makeApprovedPrAtSha({ number: 42, sha: "sha1" })],
        "o/r2": [makeApprovedPrAtSha({ number: 42, sha: "sha2" })],
      },
    });
    const env = {
      OVERSEER_REPOS_JSON: JSON.stringify([
        { owner_repo: "o/r1", auto_merge: true, project_slug: "p1" },
        { owner_repo: "o/r2", auto_merge: true, project_slug: "p2" },
      ]),
      OVERSEER_AUTO_MERGE: "true",
      OVERSEER_COOLING_OFF_MINUTES: "1",
    };
    await runCli({
      argv: ["--pr", "42"],
      env,
      deps: { gh, palCallFn: cliPalApproved, gistClient: mockGistClient(), now: () => NOW },
    });
    // Both repos must be iterated when no --repo filter is set.
    assert.deepEqual(gh.calls.listed.sort(), ["o/r1", "o/r2"]);
  });

  it("--repo only (no --pr) filters via runOverseer's only.repo at the loop level", async () => {
    const gh = ghForCliTest({
      prsByRepo: {
        "o/r1": [makeApprovedPrAtSha({ number: 42, sha: "sha1" })],
        "o/r2": [makeApprovedPrAtSha({ number: 99, sha: "sha2" })],
      },
    });
    const env = {
      OVERSEER_REPOS_JSON: JSON.stringify([
        { owner_repo: "o/r1", auto_merge: true, project_slug: "p1" },
        { owner_repo: "o/r2", auto_merge: true, project_slug: "p2" },
      ]),
      OVERSEER_AUTO_MERGE: "true",
      OVERSEER_COOLING_OFF_MINUTES: "1",
    };
    await runCli({
      argv: ["--repo", "o/r2"],
      env,
      deps: { gh, palCallFn: cliPalApproved, gistClient: mockGistClient(), now: () => NOW },
    });
    // Only the matching repo listed. Proves the filter runs at the
    // runOverseer loop layer (overseer.mjs:1459), not at the resolution
    // layer (which the bug was destroying).
    assert.deepEqual(gh.calls.listed, ["o/r2"]);
  });
});

// ===========================================================================
// writePendingMergeEntry against createDefaultGistClient -- Bug D fetch-level
// integration coverage.
//
// Bug D (2026-04-26): pending-merges.json was NOT written to the status gist
// during the Pillar 1 re-smoke despite PR #44 successfully merging at
// eed3749. The gist_outcome.ok===false was captured into the JSONL log
// (overseer.mjs:1307) but never printed to stdout/stderr, so it was
// invisible from the GH Actions UI. Code analysis cannot determine which
// failure path produced the silent failure -- that's the next smoke's job
// (the new console.warn surfaces it). These tests fill the missing test
// coverage for writePendingMergeEntry against the real createDefaultGistClient
// using the existing withFetchStub helper to monkey-patch globalThis.fetch.
// ===========================================================================

const SAMPLE_PENDING_ENTRY = {
  repo: "o/r",
  pr_number: 1,
  branch: "auto/test-branch",
  project_slug: "p",
  merge_commit_sha: "sha1",
  merged_at_ms: 0,
  replay_schedule_ms: [900_000],
  replays_done: 0,
  next_deadline_ms: 900_000,
  completed: false,
};

function gistJsonResponse(filesObj, etag = 'W/"abc"') {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (k) => (k.toLowerCase() === "etag" ? etag : null) },
    async json() { return { files: filesObj }; },
    async text() { return JSON.stringify({ files: filesObj }); },
  };
}

function emptyOkResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: { get: () => null },
    async json() { return {}; },
    async text() { return ""; },
  };
}

function fetchErrorResponse(status, statusText, body = "") {
  return {
    ok: false,
    status,
    statusText,
    headers: { get: () => null },
    async json() { return {}; },
    async text() { return body; },
  };
}

describe("writePendingMergeEntry against createDefaultGistClient -- Bug D fetch-level", () => {
  it("returns ok:true on successful PATCH (gate 7 happy path)", withFetchStub(
    async (url, opts) => {
      if (!opts?.method || opts.method === "GET") return gistJsonResponse({});
      return emptyOkResponse(200);
    },
    async () => {
      const client = createDefaultGistClient("g123", "tok");
      const out = await writePendingMergeEntry({ gistClient: client, entry: SAMPLE_PENDING_ENTRY });
      assert.equal(out.ok, true);
      assert.equal(out.status, 200);
    },
  ));

  it("returns ok:false with reason carrying `gist 403 Forbidden` on missing gist scope (Bug D hypothesis A)", withFetchStub(
    async (url, opts) => {
      if (!opts?.method || opts.method === "GET") return gistJsonResponse({});
      return fetchErrorResponse(403, "Forbidden", "Resource not accessible by personal access token");
    },
    async () => {
      const client = createDefaultGistClient("g123", "tok-without-gist-scope");
      const out = await writePendingMergeEntry({ gistClient: client, entry: SAMPLE_PENDING_ENTRY });
      assert.equal(out.ok, false);
      assert.equal(out.status, 403);
      // Tighter than /403/ -- proves we caught the GistError-formatted
      // message ("gist 403 Forbidden on https://...") specifically and not
      // some other 403-bearing string.
      assert.match(out.reason, /gist 403/);
    },
  ));

  it("PATCH never includes If-Match header (Bug E regression: gists API rejects conditional headers with 400)", async () => {
    // Bug E (2026-04-27): writePendingMergeEntry used to forward read.etag as
    // If-Match on the PATCH. GitHub gists API rejects this with 400 Bad
    // Request. The fix drops the If-Match header entirely. This test asserts
    // the PATCH request body sent to fetch carries no `If-Match` key in
    // its headers object, regardless of what etag the read returned.
    const realFetch = globalThis.fetch;
    let patchHeaders = null;
    globalThis.fetch = async (url, opts) => {
      if (!opts?.method || opts.method === "GET") {
        return gistJsonResponse({}, 'W/"etag-from-read"');
      }
      patchHeaders = opts.headers ?? {};
      return emptyOkResponse(200);
    };
    try {
      const client = createDefaultGistClient("g123", "tok");
      const out = await writePendingMergeEntry({ gistClient: client, entry: SAMPLE_PENDING_ENTRY });
      assert.equal(out.ok, true);
      assert.ok(patchHeaders, "PATCH must have fired");
      // Case-insensitive scan: GitHub-side and various HTTP libs normalize
      // header names differently, so check both forms explicitly.
      const headerKeys = Object.keys(patchHeaders).map((k) => k.toLowerCase());
      assert.equal(
        headerKeys.includes("if-match"),
        false,
        `PATCH must NOT include an If-Match header; got headers: ${JSON.stringify(Object.keys(patchHeaders))}`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does NOT retry on 412 (post-Bug-E: 412 is unreachable from prod, single attempt only)", async () => {
    // Bug E removed the 412 retry branch in writePendingMergeEntry because
    // GitHub gists API doesn't support If-Match (the only way 412 could
    // surface). If a stub still returns 412, the result is a single failed
    // attempt with the failure carried back to the caller.
    const realFetch = globalThis.fetch;
    let writeAttempt = 0;
    globalThis.fetch = async (url, opts) => {
      if (!opts?.method || opts.method === "GET") {
        return gistJsonResponse({}, 'W/"etag1"');
      }
      writeAttempt++;
      return fetchErrorResponse(412, "Precondition Failed");
    };
    try {
      const client = createDefaultGistClient("g123", "tok");
      const out = await writePendingMergeEntry({ gistClient: client, entry: SAMPLE_PENDING_ENTRY });
      assert.equal(out.ok, false);
      assert.equal(out.status, 412);
      assert.equal(writeAttempt, 1, "must make exactly 1 PATCH attempt -- no retry post-Bug-E");
      // No `retried:true` flag -- that field was tied to the now-deleted retry path.
      assert.equal(out.retried, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("surfaces a 400 Bad Request (Bug E live signature) cleanly via reason", async () => {
    // Bug E's live observable was a 400 with the message "Conditional request
    // headers are not allowed in unsafe requests unless supported by the
    // endpoint". Pre-fix, this came from the gists API rejecting If-Match.
    // Post-fix, the code path that produced 400 is gone -- but if the gist
    // PATCH ever returns 400 for ANY reason in the future, the reason field
    // should carry the GistError-formatted message intact (same shape as
    // the 403 test above).
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (!opts?.method || opts.method === "GET") {
        return gistJsonResponse({}, 'W/"etag1"');
      }
      return fetchErrorResponse(400, "Bad Request", "Conditional request headers are not allowed");
    };
    try {
      const client = createDefaultGistClient("g123", "tok");
      const out = await writePendingMergeEntry({ gistClient: client, entry: SAMPLE_PENDING_ENTRY });
      assert.equal(out.ok, false);
      assert.equal(out.status, 400);
      assert.match(out.reason, /gist 400/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns ok:false with gist-schema-version-newer when remote schema_version > local (HIGH-1 PAL fix re-validation)", withFetchStub(
    async (url, opts) => {
      if (!opts?.method || opts.method === "GET") {
        return gistJsonResponse({
          "pending-merges.json": {
            content: JSON.stringify({ schema_version: 999, entries: [] }),
          },
        });
      }
      throw new Error("PATCH must NOT fire when remote schema_version > local");
    },
    async () => {
      const client = createDefaultGistClient("g123", "tok");
      const out = await writePendingMergeEntry({ gistClient: client, entry: SAMPLE_PENDING_ENTRY });
      assert.equal(out.ok, false);
      assert.match(out.reason, /gist-schema-version-newer/);
    },
  ));

  it("returns ok:false with no-gist-id when gistClient was constructed without an id (degraded path)", async () => {
    // No fetch stub needed -- the no-gist-id guard short-circuits before any
    // network call.
    const client = createDefaultGistClient("", "tok");
    const out = await writePendingMergeEntry({ gistClient: client, entry: SAMPLE_PENDING_ENTRY });
    assert.equal(out.ok, false);
    // The degraded read returns reason:"no-gist-id" (overseer.mjs:563) and
    // the writePendingMergeEntry early-return at line 1342 surfaces it as
    // the outer reason.
    assert.equal(out.reason, "no-gist-id");
  });

  it("idempotent on duplicate (repo, pr_number, merge_commit_sha): returns ok:true with note `already-present`, no PATCH", async () => {
    const realFetch = globalThis.fetch;
    let patchFired = false;
    globalThis.fetch = async (url, opts) => {
      if (!opts?.method || opts.method === "GET") {
        return gistJsonResponse({
          "pending-merges.json": {
            content: JSON.stringify({
              schema_version: 1,
              entries: [{ repo: "o/r", pr_number: 1, merge_commit_sha: "sha1" }],
            }),
          },
        });
      }
      patchFired = true;
      return emptyOkResponse(200);
    };
    try {
      const client = createDefaultGistClient("g123", "tok");
      const out = await writePendingMergeEntry({ gistClient: client, entry: SAMPLE_PENDING_ENTRY });
      assert.equal(out.ok, true);
      assert.equal(out.note, "already-present");
      assert.equal(patchFired, false, "idempotency must NOT trigger a PATCH");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
