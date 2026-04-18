import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acquireDispatchLock, releaseDispatchLock } from "../gist.mjs";

// --- Mock helpers ---

/** Create a mock read function that returns a preset value. */
function mockRead(returnVal) {
  let callCount = 0;
  const fn = async () => { callCount++; return returnVal; };
  fn.callCount = () => callCount;
  return fn;
}

/** Create a mock read that returns different values on successive calls. */
function mockReadSequence(values) {
  let idx = 0;
  const fn = async () => values[idx++] ?? null;
  return fn;
}

/** Create a mock write that captures written data. */
function mockWrite(success = true) {
  let lastData = null;
  let callCount = 0;
  const fn = async (_gistId, _filename, data) => { lastData = data; callCount++; return success; };
  fn.lastData = () => lastData;
  fn.callCount = () => callCount;
  return fn;
}

// --- acquireDispatchLock ---

describe("acquireDispatchLock", () => {
  it("acquires lock when no existing lock", async () => {
    const read = mockReadSequence([
      null, // no existing lock
      null, // re-read returns null (we'll make it return our lock)
    ]);
    const write = mockWrite(true);

    // Override re-read to return whatever was written
    let written = null;
    const seqRead = async (gistId, filename, opts) => {
      if (written) return written;
      return null;
    };
    const seqWrite = async (gistId, filename, data, opts) => {
      written = data;
      return true;
    };

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: seqRead,
      _writeFn: seqWrite,
    });

    assert.equal(result.acquired, true);
    assert.ok(result.lockId);
    assert.equal(result.degraded, undefined);
  });

  it("acquires lock when existing lock is stale (> TTL)", async () => {
    const staleLock = {
      machine: "other-pc",
      locked_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 min ago
      lock_id: "old-uuid",
    };

    let written = null;
    const seqRead = async () => written ?? staleLock;
    const seqWrite = async (_g, _f, data) => { written = data; return true; };

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: seqRead,
      _writeFn: seqWrite,
    });

    assert.equal(result.acquired, true);
    assert.ok(result.lockId);
  });

  it("rejects when lock held by another machine within TTL", async () => {
    const activeLock = {
      machine: "other-pc",
      locked_at: new Date(Date.now() - 30_000).toISOString(), // 30s ago
      lock_id: "active-uuid",
    };

    const read = mockRead(activeLock);
    const write = mockWrite(true);

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: read,
      _writeFn: write,
    });

    assert.equal(result.acquired, false);
    assert.match(result.reason, /locked by other-pc/);
    assert.equal(write.callCount(), 0); // should not attempt to write
  });

  it("rejects when lock race is lost (re-read returns different lock_id)", async () => {
    const winnerLock = {
      machine: "other-pc",
      locked_at: new Date().toISOString(),
      lock_id: "winner-uuid",
    };

    let callNum = 0;
    const seqRead = async () => {
      callNum++;
      if (callNum === 1) return null; // no existing lock on first read
      return winnerLock; // another machine claimed it before our re-read
    };
    const write = mockWrite(true);

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      lockTtlMs: 600_000,
      _readFn: seqRead,
      _writeFn: write,
    });

    assert.equal(result.acquired, false);
    assert.match(result.reason, /lost lock race to other-pc/);
  });

  it("degrades gracefully when no token provided", async () => {
    const result = await acquireDispatchLock("gist123", "laptop", {
      // no token
    });

    assert.equal(result.acquired, true);
    assert.equal(result.lockId, null);
    assert.equal(result.degraded, true);
  });

  it("degrades gracefully when read throws (network error)", async () => {
    const failRead = async () => { throw new Error("network timeout"); };
    const write = mockWrite(true);

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      _readFn: failRead,
      _writeFn: write,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.degraded, true);
  });

  it("degrades gracefully when write fails", async () => {
    const read = mockRead(null); // no existing lock
    const write = mockWrite(false); // write returns false

    const result = await acquireDispatchLock("gist123", "laptop", {
      token: "tok",
      _readFn: read,
      _writeFn: write,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.degraded, true);
  });

  it("degrades gracefully when write throws", async () => {
    const read = mockRead(null);
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

describe("releaseDispatchLock", () => {
  it("writes null machine to release lock", async () => {
    const write = mockWrite(true);

    await releaseDispatchLock("gist123", {
      token: "tok",
      _writeFn: write,
    });

    assert.equal(write.callCount(), 1);
    assert.equal(write.lastData().machine, null);
    assert.ok(write.lastData().released_at);
  });

  it("does not throw on write failure", async () => {
    const failWrite = async () => { throw new Error("500 server error"); };

    // Should not throw
    await releaseDispatchLock("gist123", {
      token: "tok",
      _writeFn: failWrite,
    });
  });

  it("does nothing without token", async () => {
    const write = mockWrite(true);

    await releaseDispatchLock("gist123", { _writeFn: write });

    assert.equal(write.callCount(), 0);
  });
});
