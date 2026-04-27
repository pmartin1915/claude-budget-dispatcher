import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acquireDispatchLock, releaseDispatchLock } from "../gist.mjs";

// --- Mock helpers ---
// Phase A shape (2026-04-24):
//   _readFn(gistId, opts) -> { data, etag, status }
//   _writeFn(gistId, payload, opts) -> { ok, status }

function mockReadOnce(returnVal) {
  const fn = async () => returnVal;
  return fn;
}

function mockReadLiveFromWriter(writerRef) {
  // Reads reflect whatever the write mock last persisted (same process).
  return async () => ({
    data: writerRef.lastData,
    etag: writerRef.nextEtag ?? "etag-0",
    status: 200,
  });
}

function mockWriter(opts = {}) {
  const state = {
    lastData: opts.initial ?? null,
    callCount: 0,
    nextEtag: opts.etag ?? "etag-1",
    nextStatus: opts.status ?? 200,
    nextOk: opts.ok ?? true,
    receivedEtags: [],
  };
  const fn = async (_gistId, payload, opts) => {
    state.callCount++;
    state.receivedEtags.push(opts?.etag ?? null);
    if (state.nextOk === false) return { ok: false, status: state.nextStatus };
    state.lastData = payload; // null on release = file deleted
    return { ok: true, status: state.nextStatus };
  };
  fn.state = state;
  return fn;
}

// --- acquireDispatchLock ---

describe("acquireDispatchLock (ETag edition)", () => {
  it("acquires lock when no existing lock exists on the gist", async () => {
    const writer = mockWriter();
    const read = async () => ({ data: null, etag: "etag-init", status: 200 });
    // After write, re-read must surface our payload for the DID-I-WIN verification.
    let seenWrite = false;
    const verifyingRead = async () => {
      if (!seenWrite) {
        seenWrite = true;
        return { data: null, etag: "etag-init", status: 200 };
      }
      return { data: writer.state.lastData, etag: "etag-after", status: 200 };
    };

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: verifyingRead,
      _writeFn: writer,
    });

    assert.equal(result.acquired, true);
    assert.ok(result.lockId);
    assert.equal(result.fencingToken, 1);
    // Bug E (2026-04-27): GitHub gists API rejects If-Match on PATCH with
    // 400. acquireDispatchLock no longer forwards the etag to the writer;
    // concurrency lives in the re-read confirmation below.
    assert.equal(writer.state.receivedEtags[0], null);
  });

  it("acquires lock when existing lock is expired (past expiresAt)", async () => {
    const expiredLock = {
      locked: true,
      lockedBy: "other-pc",
      acquiredAt: Date.now() - 20 * 60_000,
      expiresAt: Date.now() - 5 * 60_000, // expired 5 min ago
      fencingToken: 7,
      lockId: "old-uuid",
    };
    const writer = mockWriter();
    let calls = 0;
    const read = async () => {
      calls++;
      if (calls === 1) return { data: expiredLock, etag: "etag-stale", status: 200 };
      return { data: writer.state.lastData, etag: "etag-after", status: 200 };
    };

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: read,
      _writeFn: writer,
    });

    assert.equal(result.acquired, true);
    assert.ok(result.lockId);
    assert.equal(result.fencingToken, 8, "fencing token must monotonically advance across holders");
  });

  it("rejects when lock is held by another machine and not yet expired", async () => {
    const activeLock = {
      locked: true,
      lockedBy: "other-pc",
      acquiredAt: Date.now() - 30_000,
      expiresAt: Date.now() + 10 * 60_000,
      fencingToken: 3,
      lockId: "active-uuid",
    };
    const writer = mockWriter();
    const read = async () => ({ data: activeLock, etag: "etag-active", status: 200 });

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: read,
      _writeFn: writer,
    });

    assert.equal(result.acquired, false);
    assert.match(result.reason, /locked by other-pc until /);
    assert.equal(writer.state.callCount, 0, "should not attempt write when lock is held");
  });

  it("degrades fail-open when PATCH returns 412 (post-Bug-E unreachable in prod, kept for behavior coverage)", async () => {
    // Bug E (2026-04-27): GitHub gists API rejects If-Match on PATCH with
    // 400, so 412 is no longer reachable from production code. If the
    // writer somehow returns 412 anyway (e.g., a future GitHub change),
    // the post-Bug-E behavior is fail-open (degraded), same as any other
    // non-2xx — there's no special "lost ETag race" branch anymore.
    const writer = mockWriter({ ok: false, status: 412 });
    const read = async () => ({ data: null, etag: "etag-init", status: 200 });

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: read,
      _writeFn: writer,
    });

    assert.equal(result.acquired, true, "fail-open on any non-2xx write status");
    assert.equal(result.degraded, true);
    assert.equal(result.lockId, null);
  });

  it("rejects when re-read shows a different lockId (post-Bug-E sole concurrency primitive)", async () => {
    // Simulates GitHub accepting our write but another machine's write also
    // landed during the same window. Our defense-in-depth re-read catches it.
    const writer = mockWriter({ ok: true, status: 200 });
    let callNum = 0;
    const read = async () => {
      callNum++;
      if (callNum === 1) return { data: null, etag: "etag-init", status: 200 };
      // Re-read returns someone else's lock, NOT ours
      return {
        data: {
          locked: true,
          lockedBy: "other-pc",
          expiresAt: Date.now() + 60_000,
          fencingToken: 1,
          lockId: "not-our-uuid",
        },
        etag: "etag-after",
        status: 200,
      };
    };

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: read,
      _writeFn: writer,
    });

    assert.equal(result.acquired, false);
    assert.match(result.reason, /lost lock race to other-pc \(re-read mismatch\)/);
  });

  it("fencing token monotonically increments across successive acquisitions", async () => {
    // First acquisition: no prior lock
    const writer1 = mockWriter();
    let r1Calls = 0;
    const read1 = async () => {
      r1Calls++;
      if (r1Calls === 1) return { data: null, etag: "etag-0", status: 200 };
      return { data: writer1.state.lastData, etag: "etag-1", status: 200 };
    };
    const first = await acquireDispatchLock("g", "laptop", {
      token: "t", lockTtlMs: 60_000, _readFn: read1, _writeFn: writer1,
    });
    assert.equal(first.acquired, true);
    assert.equal(first.fencingToken, 1);

    // Second acquisition: prior (released) lock is still visible with token=5
    const prior = { locked: false, fencingToken: 5 };
    const writer2 = mockWriter();
    let r2Calls = 0;
    const read2 = async () => {
      r2Calls++;
      if (r2Calls === 1) return { data: prior, etag: "etag-5", status: 200 };
      return { data: writer2.state.lastData, etag: "etag-6", status: 200 };
    };
    const second = await acquireDispatchLock("g", "laptop", {
      token: "t", lockTtlMs: 60_000, _readFn: read2, _writeFn: writer2,
    });
    assert.equal(second.acquired, true);
    assert.equal(second.fencingToken, 6, "must increment even when reclaiming");
  });

  it("same machine can reclaim its own lock", async () => {
    const ownLock = {
      locked: true,
      lockedBy: "laptop",
      acquiredAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
      fencingToken: 2,
      lockId: "own-uuid",
    };
    const writer = mockWriter();
    let calls = 0;
    const read = async () => {
      calls++;
      if (calls === 1) return { data: ownLock, etag: "etag-own", status: 200 };
      return { data: writer.state.lastData, etag: "etag-after", status: 200 };
    };

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: read,
      _writeFn: writer,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.fencingToken, 3);
  });

  it("degrades gracefully when no token provided", async () => {
    const result = await acquireDispatchLock("gist123", "laptop", {});
    assert.equal(result.acquired, true);
    assert.equal(result.lockId, null);
    assert.equal(result.degraded, true);
  });

  it("degrades gracefully when read throws (network error)", async () => {
    const failRead = async () => { throw new Error("network timeout"); };
    const writer = mockWriter();
    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      _readFn: failRead,
      _writeFn: writer,
    });
    assert.equal(result.acquired, true);
    assert.equal(result.degraded, true);
  });

  it("degrades gracefully when write returns a non-412 error status", async () => {
    const writer = mockWriter({ ok: false, status: 500 });
    const read = async () => ({ data: null, etag: "etag-init", status: 200 });
    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      _readFn: read,
      _writeFn: writer,
    });
    assert.equal(result.acquired, true);
    assert.equal(result.degraded, true);
  });

  it("degrades gracefully when write throws", async () => {
    const read = async () => ({ data: null, etag: "etag-init", status: 200 });
    const failWrite = async () => { throw new Error("403 forbidden"); };
    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      _readFn: read,
      _writeFn: failWrite,
    });
    assert.equal(result.acquired, true);
    assert.equal(result.degraded, true);
  });
});

// --- releaseDispatchLock ---

describe("releaseDispatchLock (null-payload delete)", () => {
  it("deletes the lock file via null payload", async () => {
    const writer = mockWriter();
    await releaseDispatchLock("gist123", { token: "tok", _writeFn: writer });
    assert.equal(writer.state.callCount, 1);
    assert.equal(writer.state.lastData, null, "null payload removes the file entirely");
  });

  it("does not throw on write failure", async () => {
    const failWrite = async () => { throw new Error("500 server error"); };
    // Should not throw
    await releaseDispatchLock("gist123", { token: "tok", _writeFn: failWrite });
  });

  it("does nothing without token", async () => {
    const writer = mockWriter();
    await releaseDispatchLock("gist123", { _writeFn: writer });
    assert.equal(writer.state.callCount, 0);
  });
});
