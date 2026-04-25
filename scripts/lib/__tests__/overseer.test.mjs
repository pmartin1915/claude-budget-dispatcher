// overseer.test.mjs -- unit tests for the gate-5 read-only Overseer.
//
// Pure-function + dependency-injection style. No network, no filesystem.
// Mirrors watchdog.test.mjs / auto-push.test.mjs conventions: node:test,
// node:assert/strict, all I/O via injected fetcher/palCallFn/appender/now.

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
    async listOpenDispatcherDraftPrs(repo) {
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
      async listOpenDispatcherDraftPrs(repo) {
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

  it("blocks when PR was reverted to draft AFTER ready-flip (human convert-to-draft)", () => {
    const approveAt = NOW - 60 * 60_000;
    const readyAt = NOW - 30 * 60_000;
    const r = evaluateCoolingOff({
      pr: makeAutoMergePr({ draft: true }), // reverted
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
    assert.equal(r.reason, "pr-converted-to-draft-after-ready-flip");
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
    async listOpenDispatcherDraftPrs() { calls.list++; return opts.prs ?? []; },
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

  it("setReady fails (non-422) -> auto-merge-error, no sentinel applied (so next tick retries)", async () => {
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
    assert.equal(r.outcome, "auto-merge-error");
    assert.match(r.reason, /set-ready-failed:403/);
    assert.equal(gh.calls.setReady.length, 1);
    // No ready-flipped sentinel was added, so next tick can retry.
    assert.ok(!gh.calls.add.some((c) => c.label === "overseer:ready-flipped"));
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
      async listOpenDispatcherDraftPrs(repo) {
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
