// config.test.mjs -- Unit tests for config.mjs merge semantics.
// Focus: mergeProjectsBySlug behavior so the per-slug deep-merge invariant
// for projects_in_rotation can't silently regress to array-replace.
// Uses Node built-in test runner. Zero deps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mergeProjectsBySlug,
  _deepMergeForTests as deepMerge,
} from "../config.mjs";

describe("mergeProjectsBySlug", () => {
  it("returns a copy of base when override is empty", () => {
    const base = [
      { slug: "a", auto_push: false, path: "/a" },
      { slug: "b", auto_push: false, path: "/b" },
    ];
    const out = mergeProjectsBySlug(base, []);
    assert.equal(out.length, 2);
    assert.equal(out[0].slug, "a");
    assert.notStrictEqual(out[0], base[0]);
  });

  it("override with matching slug deep-merges into base entry", () => {
    const base = [
      {
        slug: "x",
        auto_push: false,
        auto_push_allowlist: [],
        canary_timeout_ms: 30000,
      },
    ];
    const override = [
      {
        slug: "x",
        auto_push: true,
        auto_push_allowlist: ["docs/**"],
        canary_command: ["node", "test.mjs"],
      },
    ];
    const [merged] = mergeProjectsBySlug(base, override);
    assert.equal(merged.auto_push, true);
    assert.deepEqual(merged.auto_push_allowlist, ["docs/**"]);
    assert.equal(merged.canary_timeout_ms, 30000);
    assert.deepEqual(merged.canary_command, ["node", "test.mjs"]);
  });

  it("override with new slug is appended (per-machine project addition)", () => {
    const base = [{ slug: "a", path: "/a" }];
    const override = [{ slug: "b", path: "/b" }];
    const out = mergeProjectsBySlug(base, override);
    assert.equal(out.length, 2);
    assert.equal(out[1].slug, "b");
    assert.equal(out[1].path, "/b");
  });

  it("path override per machine works without clobbering other fields", () => {
    const base = [
      {
        slug: "burn-wizard",
        path: "c:/Users/perry/DevProjects/burn-wizard",
        clinical_gate: true,
        opportunistic_tasks: ["test", "audit"],
      },
    ];
    const override = [{ slug: "burn-wizard", path: "d:/altpath/burn-wizard" }];
    const [merged] = mergeProjectsBySlug(base, override);
    assert.equal(merged.path, "d:/altpath/burn-wizard");
    assert.equal(merged.clinical_gate, true);
    assert.deepEqual(merged.opportunistic_tasks, ["test", "audit"]);
  });

  it("array fields inside merged entries are array-replaced (not concatenated)", () => {
    const base = [{ slug: "x", auto_push_allowlist: ["docs/notes/**"] }];
    const override = [{ slug: "x", auto_push_allowlist: ["sessions/*.md"] }];
    const [merged] = mergeProjectsBySlug(base, override);
    assert.deepEqual(merged.auto_push_allowlist, ["sessions/*.md"]);
  });

  it("override entry without slug is skipped (defense in depth)", () => {
    const base = [{ slug: "a", auto_push: false }];
    const override = [{ auto_push: true }, { slug: "a", auto_push: true }];
    const out = mergeProjectsBySlug(base, override);
    assert.equal(out.length, 1);
    assert.equal(out[0].auto_push, true);
  });

  it("does not mutate input arrays or their entries", () => {
    const base = [{ slug: "a", auto_push: false }];
    const override = [{ slug: "a", auto_push: true }];
    const baseSnapshot = JSON.stringify(base);
    const overrideSnapshot = JSON.stringify(override);
    mergeProjectsBySlug(base, override);
    assert.equal(JSON.stringify(base), baseSnapshot);
    assert.equal(JSON.stringify(override), overrideSnapshot);
  });

  it("preserves base ordering when override only mutates fields", () => {
    const base = [
      { slug: "a" },
      { slug: "b" },
      { slug: "c" },
    ];
    const override = [{ slug: "b", path: "/b-override" }];
    const out = mergeProjectsBySlug(base, override);
    assert.deepEqual(out.map((p) => p.slug), ["a", "b", "c"]);
    assert.equal(out[1].path, "/b-override");
  });

  it("multiple override entries with same slug all merge into the base entry", () => {
    const base = [{ slug: "a", auto_push: false, canary_timeout_ms: 30000 }];
    const override = [
      { slug: "a", auto_push: true },
      { slug: "a", canary_timeout_ms: 60000 },
    ];
    const [merged] = mergeProjectsBySlug(base, override);
    assert.equal(merged.auto_push, true);
    assert.equal(merged.canary_timeout_ms, 60000);
  });

  it("nested projects_in_rotation key is array-replaced (depth-0 gate)", () => {
    // A future schema with `presets.projects_in_rotation` MUST keep standard
    // array-replace semantics rather than silently inheriting the by-slug
    // merge. Otherwise the merge contract becomes positional-magical.
    const base = {
      projects_in_rotation: [{ slug: "top", auto_push: false }],
      presets: {
        projects_in_rotation: [{ slug: "nested-a", auto_push: false }],
      },
    };
    const override = {
      presets: {
        projects_in_rotation: [{ slug: "nested-b", auto_push: true }],
      },
    };
    deepMerge(base, override);
    // Top-level by-slug merge stays intact.
    assert.equal(base.projects_in_rotation.length, 1);
    assert.equal(base.projects_in_rotation[0].slug, "top");
    // Nested array is replaced wholesale, not slug-merged.
    assert.equal(base.presets.projects_in_rotation.length, 1);
    assert.equal(base.presets.projects_in_rotation[0].slug, "nested-b");
    assert.equal(base.presets.projects_in_rotation[0].auto_push, true);
  });

  it("returned merged entries are deeply isolated from base inputs (structuredClone)", () => {
    const baseAllowlist = ["docs/**"];
    const baseCommand = ["node", "x.mjs"];
    const base = [
      {
        slug: "iso",
        auto_push_allowlist: baseAllowlist,
        canary_command: baseCommand,
      },
    ];
    const [merged] = mergeProjectsBySlug(base, []);
    // Mutate the merged output's nested arrays.
    merged.auto_push_allowlist.push("MUTATED");
    merged.canary_command[0] = "MUTATED";
    // Base must be untouched.
    assert.deepEqual(base[0].auto_push_allowlist, ["docs/**"]);
    assert.deepEqual(base[0].canary_command, ["node", "x.mjs"]);
    // And the original references must no longer be the same object as merged.
    assert.notStrictEqual(merged.auto_push_allowlist, baseAllowlist);
    assert.notStrictEqual(merged.canary_command, baseCommand);
  });
});
