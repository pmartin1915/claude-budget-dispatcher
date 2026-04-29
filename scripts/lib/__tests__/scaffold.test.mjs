// scaffold.test.mjs -- unit tests for the Bug A defensive scaffold-verify.
// Pure-function + dependency-injection style. No filesystem, no network.
// Mirrors auto-push.test.mjs conventions: node:test, node:assert/strict.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  evaluateProjectScaffold,
  verifyProjectScaffolds,
} from "../scaffold.mjs";

function mockLogger() {
  const calls = [];
  return {
    appendLog(entry) { calls.push(entry); },
    calls,
  };
}

function mockFs(presentPaths) {
  const set = new Set(presentPaths.map((p) => resolve(p)));
  return {
    existsSync(p) { return set.has(resolve(p)); },
  };
}

describe("evaluateProjectScaffold()", () => {
  it("returns ok when DISPATCH.md is present", () => {
    const project = { slug: "burn-wizard", path: "c:/projects/burn-wizard" };
    const fs = mockFs(["c:/projects/burn-wizard/DISPATCH.md"]);
    const verdict = evaluateProjectScaffold({ project, fs });
    assert.deepEqual(verdict, { ok: true });
  });

  it("returns scaffold-missing when DISPATCH.md is absent", () => {
    const project = { slug: "combo", path: "c:/projects/combo" };
    const fs = mockFs([]); // nothing present
    const verdict = evaluateProjectScaffold({ project, fs });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "dispatch-md-missing");
    assert.equal(verdict.path, resolve("c:/projects/combo/DISPATCH.md"));
  });
});

describe("verifyProjectScaffolds()", () => {
  it("emits one scaffold-missing log entry per project with no DISPATCH.md", () => {
    const projects = [
      { slug: "burn-wizard", path: "c:/projects/burn-wizard" },
      { slug: "combo", path: "c:/projects/combo" },
      { slug: "wilderness", path: "c:/projects/wilderness" },
    ];
    const fs = mockFs([
      "c:/projects/burn-wizard/DISPATCH.md",
      "c:/projects/wilderness/DISPATCH.md",
    ]);
    const log = mockLogger();
    const result = verifyProjectScaffolds({
      projects,
      fs,
      appendLog: log.appendLog,
    });

    assert.equal(log.calls.length, 1);
    assert.deepEqual(log.calls[0], {
      engine: "dispatch.mjs",
      phase: "scaffold-check",
      project: "combo",
      outcome: "scaffold-missing",
      reason: "dispatch-md-missing",
    });
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].project, "combo");
    assert.equal(result.missing[0].ok, false);
    assert.equal(result.missing[0].reason, "dispatch-md-missing");
  });

  it("emits zero log entries when every project has DISPATCH.md", () => {
    const projects = [
      { slug: "burn-wizard", path: "c:/projects/burn-wizard" },
      { slug: "wilderness", path: "c:/projects/wilderness" },
    ];
    const fs = mockFs([
      "c:/projects/burn-wizard/DISPATCH.md",
      "c:/projects/wilderness/DISPATCH.md",
    ]);
    const log = mockLogger();
    const result = verifyProjectScaffolds({
      projects,
      fs,
      appendLog: log.appendLog,
    });
    assert.equal(log.calls.length, 0);
    assert.deepEqual(result.missing, []);
  });

  it("catches per-project errors and emits scaffold-check-error without aborting", () => {
    const projects = [
      { slug: "burn-wizard", path: "c:/projects/burn-wizard" },
      { slug: "broken" /* missing path triggers throw inside resolve */ },
      { slug: "wilderness", path: "c:/projects/wilderness" },
    ];
    const fs = mockFs([
      "c:/projects/burn-wizard/DISPATCH.md",
      "c:/projects/wilderness/DISPATCH.md",
    ]);
    const log = mockLogger();
    const result = verifyProjectScaffolds({
      projects,
      fs,
      appendLog: log.appendLog,
    });

    // Exactly one log entry: the broken project's scaffold-check-error.
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].outcome, "scaffold-check-error");
    assert.equal(log.calls[0].project, "broken");
    assert.equal(log.calls[0].phase, "scaffold-check");
    assert.equal(log.calls[0].engine, "dispatch.mjs");
    assert.ok(typeof log.calls[0].reason === "string" && log.calls[0].reason.length > 0);

    // burn-wizard and wilderness still inspected; broken surfaced in missing.
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].project, "broken");
    assert.equal(result.missing[0].reason, "scaffold-check-error");
  });

  it("tolerates a null projects argument (treats as empty list)", () => {
    const log = mockLogger();
    const result = verifyProjectScaffolds({
      projects: null,
      fs: mockFs([]),
      appendLog: log.appendLog,
    });
    assert.equal(log.calls.length, 0);
    assert.deepEqual(result.missing, []);
  });
});
