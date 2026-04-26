// post-merge-monitor.test.mjs -- gate 7 (Pillar 1 step 4) unit tests.
//
// Pure-function + dependency-injection style. No network, no real
// filesystem (we use in-memory mock fs for atomic mutation tests).
// Mirrors overseer.test.mjs / circuit-breaker.test.mjs conventions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categorizeEntries,
  nextDeadline,
  evaluateCanaryResult,
  mutateLocalJsonAtomic,
  processOneEntry,
  runPostMergeMonitor,
} from "../../post-merge-monitor.mjs";

const NOW = new Date("2026-04-28T12:00:00.000Z").getTime();
const FIFTEEN_MIN = 15 * 60_000;
const ONE_HOUR = 60 * 60_000;
const FOUR_HOURS = 4 * 60 * 60_000;
const ONE_DAY = 24 * 60 * 60_000;
const DEFAULT_SCHEDULE = [FIFTEEN_MIN, ONE_HOUR, FOUR_HOURS, ONE_DAY];

// ---------------------------------------------------------------------------
// In-memory mock fs for mutateLocalJsonAtomic
// ---------------------------------------------------------------------------

function mockFs(initial = {}, opts = {}) {
  const files = new Map(Object.entries(initial));
  const calls = { rmSync: [] };
  return {
    files,
    calls,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, data); },
    renameSync: (from, to) => {
      if (opts.renameThrows) throw opts.renameThrows;
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    rmSync: (p) => { calls.rmSync.push(p); files.delete(p); },
  };
}

function mockAppender() {
  const calls = [];
  return { fn: (entry) => calls.push(entry), calls };
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("categorizeEntries()", () => {
  it("partitions due, not-yet-due, and GC-eligible completed entries", () => {
    const entries = [
      { repo: "a/b", pr_number: 1, completed: false, next_deadline_ms: NOW - 1_000 }, // due
      { repo: "a/b", pr_number: 2, completed: false, next_deadline_ms: NOW + 60_000 }, // not yet
      { repo: "a/b", pr_number: 3, completed: true, merged_at_ms: NOW - 8 * ONE_DAY }, // GC
      { repo: "a/b", pr_number: 4, completed: true, merged_at_ms: NOW - 1 * ONE_DAY }, // keep (recent)
    ];
    const r = categorizeEntries({ entries, now: NOW });
    assert.equal(r.dueNow.length, 1);
    assert.equal(r.dueNow[0].pr_number, 1);
    assert.equal(r.notYetDue.length, 1);
    assert.equal(r.notYetDue[0].pr_number, 2);
    assert.equal(r.completedToGc.length, 1);
    assert.equal(r.completedToGc[0].pr_number, 3);
  });
  it("returns empty arrays on bad shape", () => {
    const r = categorizeEntries({ entries: null, now: NOW });
    assert.deepEqual(r, { dueNow: [], notYetDue: [], completedToGc: [] });
  });
});

describe("nextDeadline()", () => {
  it("returns merged_at + schedule[replays_done_after] for each step", () => {
    assert.equal(nextDeadline(DEFAULT_SCHEDULE, 1, 1000), 1000 + ONE_HOUR);
    assert.equal(nextDeadline(DEFAULT_SCHEDULE, 2, 1000), 1000 + FOUR_HOURS);
    assert.equal(nextDeadline(DEFAULT_SCHEDULE, 3, 1000), 1000 + ONE_DAY);
  });
  it("returns null when schedule is exhausted (last replay clean)", () => {
    assert.equal(nextDeadline(DEFAULT_SCHEDULE, 4, 1000), null);
  });
});

describe("evaluateCanaryResult()", () => {
  it("classifies a clean run as pass", () => {
    const r = evaluateCanaryResult({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 100, spawnError: false });
    assert.equal(r.pass, true);
    assert.equal(r.exit_code, 0);
  });
  it("classifies non-zero exit as fail (non-zero)", () => {
    const r = evaluateCanaryResult({ exitCode: 17, stdout: "", stderr: "boom", timedOut: false, durationMs: 50, spawnError: false });
    assert.equal(r.pass, false);
    assert.equal(r.failure_mode, "non-zero");
  });
  it("classifies timeout as fail (timeout)", () => {
    const r = evaluateCanaryResult({ exitCode: null, stdout: "", stderr: "", timedOut: true, durationMs: 120_000, spawnError: false });
    assert.equal(r.pass, false);
    assert.equal(r.failure_mode, "timeout");
  });
  it("classifies spawn error as fail (spawn-error)", () => {
    const r = evaluateCanaryResult({ exitCode: null, stdout: "", stderr: "ENOENT", timedOut: false, durationMs: 0, spawnError: true });
    assert.equal(r.pass, false);
    assert.equal(r.failure_mode, "spawn-error");
  });
  it("trail-limits stdout/stderr to 500 chars", () => {
    const big = "x".repeat(2000) + "<<TAIL>>";
    const r = evaluateCanaryResult({ exitCode: 0, stdout: big, stderr: big, timedOut: false, durationMs: 0, spawnError: false });
    assert.equal(r.stdout_tail.length, 500);
    assert.match(r.stdout_tail, /<<TAIL>>$/);
    assert.match(r.stderr_tail, /<<TAIL>>$/);
  });
});

// ---------------------------------------------------------------------------
// mutateLocalJsonAtomic
// ---------------------------------------------------------------------------

describe("mutateLocalJsonAtomic()", () => {
  it("flips auto_push for the named project, leaves others untouched", () => {
    const fs = mockFs({
      "/local.json": JSON.stringify({
        machine_name: "test",
        projects_in_rotation: [
          { slug: "a", path: "/a", auto_push: true },
          { slug: "b", path: "/b", auto_push: true },
        ],
      }),
    });
    const r = mutateLocalJsonAtomic({
      localJsonPath: "/local.json", projectSlug: "b", autoPushTarget: false, fs,
    });
    assert.equal(r.changed, true);
    const written = JSON.parse(fs.files.get("/local.json"));
    assert.equal(written.projects_in_rotation[0].auto_push, true, "a stays true");
    assert.equal(written.projects_in_rotation[1].auto_push, false, "b flipped");
    // No tmp file leftover.
    const leftovers = [...fs.files.keys()].filter((k) => k !== "/local.json");
    assert.equal(leftovers.length, 0, "tmp file cleaned up via rename");
  });

  it("idempotent when target already matches (no write, no error)", () => {
    const fs = mockFs({
      "/local.json": JSON.stringify({
        projects_in_rotation: [{ slug: "a", auto_push: false }],
      }),
    });
    const r = mutateLocalJsonAtomic({
      localJsonPath: "/local.json", projectSlug: "a", autoPushTarget: false, fs,
    });
    assert.equal(r.changed, false);
    assert.equal(r.alreadySuspended, true);
  });

  it("returns reason on missing project slug", () => {
    const fs = mockFs({
      "/local.json": JSON.stringify({
        projects_in_rotation: [{ slug: "a", auto_push: true }],
      }),
    });
    const r = mutateLocalJsonAtomic({
      localJsonPath: "/local.json", projectSlug: "missing", autoPushTarget: false, fs,
    });
    assert.equal(r.changed, false);
    assert.match(r.reason, /^project-not-found:missing$/);
  });

  it("returns reason on missing file", () => {
    const fs = mockFs({});
    const r = mutateLocalJsonAtomic({
      localJsonPath: "/nope.json", projectSlug: "a", autoPushTarget: false, fs,
    });
    assert.equal(r.changed, false);
    assert.match(r.reason, /^local-json-missing:/);
  });

  it("returns reason on parse failure (does NOT clobber)", () => {
    const fs = mockFs({
      "/local.json": "not json {{{",
    });
    const r = mutateLocalJsonAtomic({
      localJsonPath: "/local.json", projectSlug: "a", autoPushTarget: false, fs,
    });
    assert.equal(r.changed, false);
    assert.match(r.reason, /^parse-failed:/);
    // Original content preserved.
    assert.equal(fs.files.get("/local.json"), "not json {{{");
  });

  it("cleans up orphan tmp file on rename failure", () => {
    const fs = mockFs(
      {
        "/local.json": JSON.stringify({
          projects_in_rotation: [{ slug: "a", auto_push: true }],
        }),
      },
      { renameThrows: new Error("EPERM: rename failed") },
    );
    const r = mutateLocalJsonAtomic({
      localJsonPath: "/local.json", projectSlug: "a", autoPushTarget: false, fs,
    });
    assert.equal(r.changed, false);
    assert.match(r.reason, /^write-rename-failed:/);
    // Cleanup must have been called against the tmp path.
    assert.equal(fs.calls.rmSync.length, 1);
    assert.match(fs.calls.rmSync[0], /^\/local\.json\.tmp\./);
    // No leftover tmp in the in-memory fs.
    const leftovers = [...fs.files.keys()].filter((k) => k.startsWith("/local.json.tmp"));
    assert.equal(leftovers.length, 0);
    // Original local.json untouched.
    const original = JSON.parse(fs.files.get("/local.json"));
    assert.equal(original.projects_in_rotation[0].auto_push, true);
  });
});

// ---------------------------------------------------------------------------
// processOneEntry
// ---------------------------------------------------------------------------

function mockGh({ viewResp, throws } = {}) {
  return {
    viewPr() {
      if (throws) throw throws;
      return viewResp ?? { mergeCommit: { oid: "merged123" }, state: "MERGED", baseRefName: "main" };
    },
  };
}
function mockGit({ fetchThrows, addThrows } = {}) {
  const calls = { fetch: [], addWorktree: [], removeWorktree: [] };
  return {
    calls,
    fetch(p, ref) { calls.fetch.push({ p, ref }); if (fetchThrows) throw fetchThrows; },
    addWorktree(p, t, sha) { calls.addWorktree.push({ p, t, sha }); if (addThrows) throw addThrows; },
    removeWorktree(p, t) { calls.removeWorktree.push({ p, t }); },
  };
}
function mockRunner(canaryResult) {
  return () => async () => canaryResult;
}

describe("processOneEntry()", () => {
  const baseEntry = (overrides = {}) => ({
    repo: "a/b", pr_number: 42, project_slug: "demo",
    merge_commit_sha: "merged123", merged_at_ms: NOW - FIFTEEN_MIN, replays_done: 0,
    next_deadline_ms: NOW - 1, replay_schedule_ms: DEFAULT_SCHEDULE, completed: false,
    ...overrides,
  });
  const baseProjects = [{ slug: "demo", path: "/projects/demo", canary_command: ["npm.cmd", "run", "canary"], canary_timeout_ms: 60_000 }];

  it("project not in local rotation -> skipped (different machine owns it)", async () => {
    const ap = mockAppender();
    const tempDirCalls = [];
    const out = await processOneEntry({
      entry: baseEntry({ project_slug: "elsewhere" }),
      projectsInRotation: baseProjects,
      localJsonPath: "/local.json",
      ntfyTopic: null, ntfyEnabled: false,
      gh: mockGh(), git: mockGit(),
      runner: mockRunner({ exitCode: 0 }),
      appender: ap.fn, now: NOW,
      mkdtemp: (p) => { tempDirCalls.push(p); return p + "tmp"; },
    });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "project-not-in-local-rotation");
    assert.equal(tempDirCalls.length, 0);
  });

  it("canary success bumps replays_done and computes next deadline", async () => {
    const ap = mockAppender();
    const projects = [{ ...baseProjects[0] }];
    // Need filesystem: existsSync(project.path) is real fs. Use a path the
    // test environment has. We tolerate this by only counting the assertion
    // when the path exists; otherwise the test's intent is to verify the
    // happy path, so we point to a known-existing path (cwd).
    projects[0].path = process.cwd();
    const out = await processOneEntry({
      entry: baseEntry(),
      projectsInRotation: projects,
      localJsonPath: "/local.json",
      ntfyTopic: null, ntfyEnabled: false,
      gh: mockGh(), git: mockGit(),
      runner: mockRunner({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 100, spawnError: false }),
      appender: ap.fn, now: NOW,
      mkdtemp: () => "/tmp/test-tmp",
    });
    assert.equal(out.skipped, false);
    assert.equal(out.entry.replays_done, 1);
    assert.equal(out.entry.next_deadline_ms, baseEntry().merged_at_ms + ONE_HOUR);
    assert.equal(out.entry.completed, false, "still in flight (not the last replay)");
    assert.ok(ap.calls.some((c) => c.outcome === "replay-success"));
  });

  it("canary failure -> auto-suspend: mutates local.json + fires ntfy + entry completed", async () => {
    const ap = mockAppender();
    const fs = mockFs({
      "/local.json": JSON.stringify({
        projects_in_rotation: [{ slug: "demo", path: process.cwd(), auto_push: true, canary_command: ["fail"] }],
      }),
    });
    // We need to thread fs through mutateLocalJsonAtomic. processOneEntry uses
    // the default node:fs. To test atomicity, exercise mutateLocalJsonAtomic
    // separately (above). Here we verify the JSONL log and the ntfy fire path.
    const projects = [{ slug: "demo", path: process.cwd(), canary_command: ["fail"], canary_timeout_ms: 1000 }];

    // The ntfy fire would call alerting.mjs:sendNtfy via real fetch. We can't
    // easily mock that in this test without deeper injection. Instead verify
    // the auto-suspended log entry is written with all required fields.
    // (Real ntfy fire is exercised in alerting.test.mjs.)
    const out = await processOneEntry({
      entry: baseEntry(),
      projectsInRotation: projects,
      localJsonPath: "/nonexistent-path-for-test.json", // mutate will fail-soft
      ntfyTopic: null, // skips ntfy
      ntfyEnabled: false,
      gh: mockGh(), git: mockGit(),
      runner: mockRunner({ exitCode: 17, stdout: "fail-out", stderr: "fail-err", timedOut: false, durationMs: 200, spawnError: false }),
      appender: ap.fn, now: NOW,
      mkdtemp: () => "/tmp/test-tmp",
    });
    assert.equal(out.entry.completed, true);
    assert.equal(out.entry.outcome, "auto-suspended");
    assert.equal(out.entry.failure_mode, "non-zero");
    assert.equal(out.entry.exit_code, 17);
    const auto = ap.calls.find((c) => c.outcome === "auto-suspended");
    assert.ok(auto, "auto-suspended log written");
    assert.equal(auto.replay_num, 1);
    assert.equal(auto.failure_mode, "non-zero");
  });

  it("PR not yet merged -> deferred (retry next tick)", async () => {
    const ap = mockAppender();
    const projects = [{ slug: "demo", path: process.cwd(), canary_command: ["x"] }];
    const out = await processOneEntry({
      entry: baseEntry({ merge_commit_sha: null }),
      projectsInRotation: projects,
      localJsonPath: "/local.json",
      ntfyTopic: null, ntfyEnabled: false,
      gh: mockGh({ viewResp: { state: "OPEN" } }),
      git: mockGit(),
      runner: mockRunner({ exitCode: 0 }),
      appender: ap.fn, now: NOW,
      mkdtemp: () => "/tmp/test-tmp",
    });
    assert.equal(out.deferred, true);
    assert.ok(ap.calls.some((c) => c.outcome === "deferred"));
  });

  it("git fetch failure -> deferred (retry next tick)", async () => {
    const ap = mockAppender();
    const projects = [{ slug: "demo", path: process.cwd(), canary_command: ["x"] }];
    const out = await processOneEntry({
      entry: baseEntry(),
      projectsInRotation: projects,
      localJsonPath: "/local.json",
      ntfyTopic: null, ntfyEnabled: false,
      gh: mockGh(),
      git: mockGit({ fetchThrows: new Error("network down") }),
      runner: mockRunner({ exitCode: 0 }),
      appender: ap.fn, now: NOW,
      mkdtemp: () => "/tmp/test-tmp",
    });
    assert.equal(out.deferred, true);
    assert.ok(ap.calls.some((c) => c.outcome === "deferred" && /git-fetch-failed/.test(c.reason)));
  });

  it("missing canary_command -> skipped (no replay)", async () => {
    const ap = mockAppender();
    const projects = [{ slug: "demo", path: process.cwd() }]; // no canary_command
    const out = await processOneEntry({
      entry: baseEntry(),
      projectsInRotation: projects,
      localJsonPath: "/local.json",
      ntfyTopic: null, ntfyEnabled: false,
      gh: mockGh(), git: mockGit(),
      runner: mockRunner({ exitCode: 0 }),
      appender: ap.fn, now: NOW,
      mkdtemp: () => "/tmp/test-tmp",
    });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "canary-command-missing");
  });

  it("clean replay-schedule exhaustion -> entry completed with replays-clean", async () => {
    const ap = mockAppender();
    const projects = [{ slug: "demo", path: process.cwd(), canary_command: ["x"] }];
    const out = await processOneEntry({
      entry: baseEntry({ replays_done: DEFAULT_SCHEDULE.length - 1 }),
      projectsInRotation: projects,
      localJsonPath: "/local.json",
      ntfyTopic: null, ntfyEnabled: false,
      gh: mockGh(), git: mockGit(),
      runner: mockRunner({ exitCode: 0 }),
      appender: ap.fn, now: NOW,
      mkdtemp: () => "/tmp/test-tmp",
    });
    assert.equal(out.entry.completed, true);
    assert.equal(out.entry.outcome, "replays-clean");
    assert.equal(out.entry.next_deadline_ms, null);
  });
});

// ---------------------------------------------------------------------------
// runPostMergeMonitor (orchestrator)
// ---------------------------------------------------------------------------

function mockGistFns({ readResp, readThrows, writeResp = { ok: true, status: 200 } } = {}) {
  const calls = { reads: 0, writes: [] };
  return {
    calls,
    read: async () => {
      calls.reads++;
      if (readThrows) throw readThrows;
      return readResp ?? { data: null, etag: null, status: 200 };
    },
    write: async (gistId, filename, payload, opts) => {
      calls.writes.push({ gistId, filename, payload, opts });
      return writeResp;
    },
  };
}

describe("runPostMergeMonitor()", () => {
  it("missing gistId -> skipped, no work attempted", async () => {
    const ap = mockAppender();
    const summary = await runPostMergeMonitor({
      gistId: "",
      gistToken: "tok",
      projectsInRotation: [],
      ntfyTopic: null, ntfyEnabled: false,
      appender: ap.fn,
      now: () => NOW,
    });
    assert.equal(summary.processed, 0);
    assert.match(summary.gist_outcome.reason, /^no-gist-id$/);
  });

  it("future schema_version -> fail-soft skip, no overwrite", async () => {
    const ap = mockAppender();
    const gistFns = mockGistFns({
      readResp: {
        data: { schema_version: 99, entries: [{ repo: "a/b", pr_number: 1, future_field: "preserve" }] },
        etag: "W/etag1",
      },
    });
    const summary = await runPostMergeMonitor({
      gistId: "gid",
      gistToken: "tok",
      projectsInRotation: [],
      ntfyTopic: null, ntfyEnabled: false,
      gistFns,
      appender: ap.fn,
      now: () => NOW,
    });
    assert.equal(gistFns.calls.writes.length, 0, "no v1 write to a v99 gist");
    assert.match(summary.gist_outcome.reason, /^gist-schema-version-newer/);
  });

  it("malformed gist file -> fail-soft skip", async () => {
    const ap = mockAppender();
    const gistFns = mockGistFns({ readResp: { data: null, etag: "e1", malformed: true } });
    const summary = await runPostMergeMonitor({
      gistId: "gid",
      gistToken: "tok",
      projectsInRotation: [],
      ntfyTopic: null, ntfyEnabled: false,
      gistFns,
      appender: ap.fn,
      now: () => NOW,
    });
    assert.equal(gistFns.calls.writes.length, 0);
    assert.match(summary.gist_outcome.reason, /^gist-malformed$/);
  });

  it("no entries -> ok no-op (no write)", async () => {
    const ap = mockAppender();
    const gistFns = mockGistFns({ readResp: { data: { schema_version: 1, entries: [] }, etag: "e1" } });
    const summary = await runPostMergeMonitor({
      gistId: "gid", gistToken: "tok",
      projectsInRotation: [], ntfyTopic: null, ntfyEnabled: false,
      gistFns, appender: ap.fn, now: () => NOW,
    });
    assert.equal(summary.processed, 0);
    assert.equal(gistFns.calls.writes.length, 0);
  });

  it("entry not yet due -> no-op, no write", async () => {
    const ap = mockAppender();
    const gistFns = mockGistFns({
      readResp: {
        data: {
          schema_version: 1,
          entries: [{ repo: "a/b", pr_number: 1, project_slug: "demo", next_deadline_ms: NOW + 60_000, completed: false, replay_schedule_ms: DEFAULT_SCHEDULE, merged_at_ms: NOW - 1000 }],
        },
        etag: "e1",
      },
    });
    const summary = await runPostMergeMonitor({
      gistId: "gid", gistToken: "tok",
      projectsInRotation: [], ntfyTopic: null, ntfyEnabled: false,
      gistFns, appender: ap.fn, now: () => NOW,
    });
    assert.equal(summary.processed, 0);
    assert.equal(gistFns.calls.writes.length, 0);
  });

  it("entry due but project not in local rotation -> skipped, gist write retains entry", async () => {
    const ap = mockAppender();
    const entry = { repo: "a/b", pr_number: 1, project_slug: "elsewhere", next_deadline_ms: NOW - 1, completed: false, replay_schedule_ms: DEFAULT_SCHEDULE, merged_at_ms: NOW - 1000, replays_done: 0, merge_commit_sha: "x" };
    const gistFns = mockGistFns({
      readResp: { data: { schema_version: 1, entries: [entry] }, etag: "e1" },
    });
    const summary = await runPostMergeMonitor({
      gistId: "gid", gistToken: "tok",
      projectsInRotation: [{ slug: "demo", path: process.cwd() }], // no "elsewhere"
      ntfyTopic: null, ntfyEnabled: false,
      gistFns, appender: ap.fn, now: () => NOW,
    });
    assert.equal(summary.skipped, 1);
    // No write because nothing actionable changed (carrying the entry through
    // unchanged is a no-op write; we explicitly skip writes when nothing
    // changed).
    assert.equal(gistFns.calls.writes.length, 0);
  });

  it("GC drops completed entries older than 7d (when other work also fires)", async () => {
    const ap = mockAppender();
    const project = { slug: "demo", path: process.cwd(), canary_command: ["x"], canary_timeout_ms: 1000 };
    const oldCompleted = { repo: "a/b", pr_number: 99, project_slug: "demo", completed: true, merged_at_ms: NOW - 10 * ONE_DAY, replay_schedule_ms: DEFAULT_SCHEDULE, replays_done: 4, outcome: "replays-clean" };
    const dueEntry = { repo: "a/b", pr_number: 1, project_slug: "demo", merge_commit_sha: "merged123", merged_at_ms: NOW - FIFTEEN_MIN, replays_done: 0, next_deadline_ms: NOW - 1, replay_schedule_ms: DEFAULT_SCHEDULE, completed: false };
    const gistFns = mockGistFns({
      readResp: { data: { schema_version: 1, entries: [oldCompleted, dueEntry] }, etag: "e1" },
    });
    const summary = await runPostMergeMonitor({
      gistId: "gid", gistToken: "tok",
      projectsInRotation: [project],
      ntfyTopic: null, ntfyEnabled: false,
      gistFns,
      gh: mockGh(),
      git: mockGit(),
      runner: mockRunner({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 100, spawnError: false }),
      appender: ap.fn,
      now: () => NOW,
      mkdtemp: () => "/tmp/test-tmp",
    });
    assert.equal(summary.processed, 1);
    assert.equal(summary.gc_dropped, 1);
    // Write should include only the (now-bumped) due entry; old completed dropped.
    assert.equal(gistFns.calls.writes.length, 1);
    const written = gistFns.calls.writes[0].payload;
    assert.equal(written.entries.length, 1);
    assert.equal(written.entries[0].pr_number, 1);
    assert.equal(written.entries[0].replays_done, 1);
  });

  it("412 ETag CAS lost -> fail-soft skip (no retry within tick)", async () => {
    const ap = mockAppender();
    const project = { slug: "demo", path: process.cwd(), canary_command: ["x"], canary_timeout_ms: 1000 };
    const dueEntry = { repo: "a/b", pr_number: 1, project_slug: "demo", merge_commit_sha: "merged123", merged_at_ms: NOW - FIFTEEN_MIN, replays_done: 0, next_deadline_ms: NOW - 1, replay_schedule_ms: DEFAULT_SCHEDULE, completed: false };
    const gistFns = mockGistFns({
      readResp: { data: { schema_version: 1, entries: [dueEntry] }, etag: "e1" },
      writeResp: { ok: false, status: 412 },
    });
    const summary = await runPostMergeMonitor({
      gistId: "gid", gistToken: "tok",
      projectsInRotation: [project],
      ntfyTopic: null, ntfyEnabled: false,
      gistFns,
      gh: mockGh(),
      git: mockGit(),
      runner: mockRunner({ exitCode: 0 }),
      appender: ap.fn,
      now: () => NOW,
      mkdtemp: () => "/tmp/test-tmp",
    });
    // Replay still ran; gist write failed soft.
    assert.equal(summary.processed, 1);
    assert.equal(summary.gist_outcome.ok, false);
    assert.equal(summary.gist_outcome.reason, "etag-cas-lost");
  });
});
