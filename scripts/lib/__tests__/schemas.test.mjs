// schemas.test.mjs — Unit tests for schemas.mjs (R-1: ajv validation).
// Uses Node built-in test runner. Zero deps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateAuditResponse, validateSelectorResponse } from "../schemas.mjs";

// ---------------------------------------------------------------------------
// validateAuditResponse
// ---------------------------------------------------------------------------

describe("validateAuditResponse", () => {
  it("accepts well-formed audit response", () => {
    const data = {
      hasCritical: false,
      findings: [
        { file: "src/parkland.ts", severity: "HIGH", issue: "missing validation" },
      ],
      summary: "one critical finding",
    };
    const r = validateAuditResponse(data);
    assert.equal(r.hasCritical, false);
    assert.equal(r.findings.length, 1);
    assert.equal(r.summary, "one critical finding");
  });

  it("accepts minimal audit response (hasCritical only)", () => {
    const data = { hasCritical: true };
    const r = validateAuditResponse(data);
    assert.equal(r.hasCritical, true);
    assert.deepEqual(r.findings, []);
    assert.equal(r.summary, "");
  });

  it("rejects missing hasCritical field", () => {
    assert.throws(() => {
      validateAuditResponse({ findings: [], summary: "ok" });
    }, /schema violation/);
  });

  it("rejects wrong type for hasCritical (string 'yes')", () => {
    // This is the exact bug that R-1 was written to catch:
    // "yes" is truthy in JS but the schema demands boolean.
    assert.throws(() => {
      validateAuditResponse({ hasCritical: "yes" });
    }, /schema violation/);
  });

  it("rejects wrong type for hasCritical (number 1)", () => {
    assert.throws(() => {
      validateAuditResponse({ hasCritical: 1 });
    }, /schema violation/);
  });

  it("rejects invalid severity enum", () => {
    assert.throws(() => {
      validateAuditResponse({
        hasCritical: false,
        findings: [{ file: "x.ts", severity: "URGENT", issue: "bad" }],
      });
    }, /schema violation/);
  });

  it("allows extra unknown fields (additionalProperties: true)", () => {
    const data = {
      hasCritical: false,
      extraField: "whatever",
      nested: { foo: 1 },
    };
    // Should not throw — additionalProperties is tolerated
    const r = validateAuditResponse(data);
    assert.equal(r.hasCritical, false);
  });

  it("coerces hasCritical to strict boolean comparison", () => {
    // Even if ajv doesn't coerce, our wrapper uses === true
    const data = { hasCritical: true, findings: [] };
    const r = validateAuditResponse(data);
    assert.equal(r.hasCritical, true);
  });
});

// ---------------------------------------------------------------------------
// validateSelectorResponse
// ---------------------------------------------------------------------------

describe("validateSelectorResponse", () => {
  it("accepts well-formed selector response", () => {
    const data = { project: "burn-wizard", task: "test", reason: "oldest dispatch" };
    const r = validateSelectorResponse(data);
    assert.equal(r.project, "burn-wizard");
    assert.equal(r.task, "test");
    assert.equal(r.reason, "oldest dispatch");
  });

  it("accepts selector response without reason", () => {
    const data = { project: "wilderness", task: "audit" };
    const r = validateSelectorResponse(data);
    assert.equal(r.reason, "");
  });

  it("rejects missing project", () => {
    assert.throws(() => {
      validateSelectorResponse({ task: "test" });
    }, /schema violation/);
  });

  it("rejects missing task", () => {
    assert.throws(() => {
      validateSelectorResponse({ project: "burn-wizard" });
    }, /schema violation/);
  });

  it("rejects empty project string", () => {
    assert.throws(() => {
      validateSelectorResponse({ project: "", task: "test" });
    }, /schema violation/);
  });

  it("rejects non-string project", () => {
    assert.throws(() => {
      validateSelectorResponse({ project: 123, task: "test" });
    }, /schema violation/);
  });

  it("allows extra unknown fields", () => {
    const data = { project: "combo", task: "audit", extra: "data" };
    const r = validateSelectorResponse(data);
    assert.equal(r.project, "combo");
  });
});
