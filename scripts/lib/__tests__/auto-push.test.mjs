// auto-push.test.mjs -- unit tests for the Pillar 1 step 1 path firewall
// + draft-PR orchestrator. Pure-function + dependency-injection style.
// No filesystem, no network, no real git/gh. Mirrors watchdog.test.mjs and
// circuit-breaker.test.mjs conventions: node:test, node:assert/strict.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchGlob,
  evaluatePathFirewall,
  maybeAutoPush,
  FALLBACK_PROTECTED_GLOBS,
} from "../auto-push.mjs";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockLogger() {
  const calls = [];
  return {
    appendLog(entry) { calls.push(entry); },
    calls,
  };
}

function mockGit({ files = [], pushThrows = null, listThrows = null } = {}) {
  const pushCalls = [];
  const listCalls = { count: 0 };
  return {
    push(branch) {
      pushCalls.push(branch);
      if (pushThrows) throw pushThrows;
    },
    listChangedFiles() {
      listCalls.count++;
      if (listThrows) throw listThrows;
      return files;
    },
    pushCalls,
    listCalls,
  };
}

function mockGh({ url = "https://github.com/test/repo/pull/1", createThrows = null } = {}) {
  const createCalls = [];
  const labelCalls = [];
  return {
    createDraftPr(args) {
      createCalls.push(args);
      if (createThrows) throw createThrows;
      return url;
    },
    addLabels(prUrl, labels) {
      labelCalls.push({ prUrl, labels });
    },
    createCalls,
    labelCalls,
  };
}

function mockFs() {
  const writeCalls = [];
  const unlinkCalls = [];
  return {
    writeFileSync(path, content) { writeCalls.push({ path, content }); },
    unlinkSync(path) { unlinkCalls.push(path); },
    writeCalls,
    unlinkCalls,
  };
}

function fakeBuildPrBody(finalResult, selection /* , route */) {
  return `# auto-PR\n- task: ${selection?.task}\n- summary: ${finalResult?.summary ?? ""}\n`;
}

const baseHappyArgs = () => ({
  branch: "auto/test-task-2026-04-26",
  project: "test-project",
  projectConfig: {
    auto_push: true,
    auto_push_allowlist: ["src/**", "tests/**", "CHANGELOG.md"],
  },
  globalConfig: {
    auto_push: true,
    auto_push_protected_globs: [".github/**", "package.json"],
  },
  finalResult: { summary: "did the thing", modelUsed: "gemini-2.5-pro", branch: "auto/test-task-2026-04-26" },
  selection: { project: "test-project", task: "audit", reason: "rotation" },
  route: { taskClass: "audit", model: "gemini-2.5-pro" },
  buildPrBody: fakeBuildPrBody,
  workingDir: "/fake/worktree",
});

// ---------------------------------------------------------------------------
// matchGlob() -- 3 tests
// ---------------------------------------------------------------------------

describe("matchGlob()", () => {
  it("matches a literal path exactly and rejects close-but-not-equal", () => {
    assert.equal(matchGlob("README.md", "README.md"), true);
    assert.equal(matchGlob("README.txt", "README.md"), false);
    assert.equal(matchGlob("readme.md", "README.md"), false); // case-sensitive
  });

  it("'*' does NOT cross the '/' boundary", () => {
    assert.equal(matchGlob("src/a.js", "src/*.js"), true);
    assert.equal(matchGlob("src/sub/a.js", "src/*.js"), false);
    assert.equal(matchGlob("src/index.js", "src/*"), true);
  });

  it("'**' crosses '/' boundaries (recursive match)", () => {
    assert.equal(matchGlob("src/a.js", "src/**"), true);
    assert.equal(matchGlob("src/sub/deep/a.js", "src/**"), true);
    assert.equal(matchGlob("other/a.js", "src/**"), false);
    assert.equal(matchGlob("anything/secrets/key.txt", "**/secrets/**"), true);
  });
});

// ---------------------------------------------------------------------------
// evaluatePathFirewall() -- 4 tests
// ---------------------------------------------------------------------------

describe("evaluatePathFirewall()", () => {
  it("'src/**' allows files at any depth under src/", () => {
    const decision = evaluatePathFirewall({
      changedFiles: ["src/lib/a.js", "src/index.js", "tests/a.test.mjs"],
      allowlist: ["src/**", "tests/**"],
      protectedGlobs: [],
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.blockedBy, null);
  });

  it("empty allowlist with non-empty changedFiles is BLOCKED (defensive default)", () => {
    const decision = evaluatePathFirewall({
      changedFiles: ["anything"],
      allowlist: [],
      protectedGlobs: [".github/**"],
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.blockedBy.reason, "empty-allowlist");
  });

  it("one path outside the allowlist blocks; blocked_path identifies the offender", () => {
    const decision = evaluatePathFirewall({
      changedFiles: ["src/a.js", "README.md"],
      allowlist: ["src/**"],
      protectedGlobs: [],
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.blockedBy.reason, "outside-allowlist");
    assert.equal(decision.blockedBy.path, "README.md");
  });

  it("protected glob ALWAYS wins over allowlist (even when allowlist would allow)", () => {
    const decision = evaluatePathFirewall({
      changedFiles: ["src/index.js", "package.json"],
      allowlist: ["**"], // permissive allowlist
      protectedGlobs: ["package.json", ".github/**"],
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.blockedBy.reason, "protected-glob");
    assert.equal(decision.blockedBy.path, "package.json");
    assert.equal(decision.blockedBy.pattern, "package.json");
  });
});

// ---------------------------------------------------------------------------
// maybeAutoPush() -- 5 tests
// ---------------------------------------------------------------------------

describe("maybeAutoPush()", () => {
  it("globalConfig.auto_push=false -> blocked/disabled-global, no git/gh calls", async () => {
    const args = baseHappyArgs();
    args.globalConfig.auto_push = false;
    const git = mockGit({ files: ["src/a.js"] });
    const gh = mockGh();
    const log = mockLogger();
    const result = await maybeAutoPush({
      ...args,
      gitClient: git,
      ghClient: gh,
      logger: log,
      fs: mockFs(),
    });
    assert.equal(result.outcome, "auto-push-blocked");
    assert.equal(result.reason, "disabled-global");
    assert.equal(git.pushCalls.length, 0);
    assert.equal(git.listCalls.count, 0); // short-circuit before listChangedFiles
    assert.equal(gh.createCalls.length, 0);
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].outcome, "auto-push-blocked");
    assert.equal(log.calls[0].reason, "disabled-global");
    assert.equal(log.calls[0].phase, "auto-push");
  });

  it("projectConfig.auto_push=false -> blocked/disabled-project, no git/gh calls", async () => {
    const args = baseHappyArgs();
    args.projectConfig.auto_push = false;
    const git = mockGit({ files: ["src/a.js"] });
    const gh = mockGh();
    const log = mockLogger();
    const result = await maybeAutoPush({
      ...args,
      gitClient: git,
      ghClient: gh,
      logger: log,
      fs: mockFs(),
    });
    assert.equal(result.outcome, "auto-push-blocked");
    assert.equal(result.reason, "disabled-project");
    assert.equal(git.pushCalls.length, 0);
    assert.equal(gh.createCalls.length, 0);
    assert.equal(log.calls[0].reason, "disabled-project");
  });

  it("happy path: all paths allowed -> push + draft PR + log success with pr_url", async () => {
    const args = baseHappyArgs();
    const git = mockGit({ files: ["src/index.js", "tests/a.test.mjs"] });
    const gh = mockGh({ url: "https://github.com/test/repo/pull/42" });
    const log = mockLogger();
    const fs = mockFs();
    const result = await maybeAutoPush({
      ...args,
      gitClient: git,
      ghClient: gh,
      logger: log,
      fs,
    });
    assert.equal(result.outcome, "auto-push-success");
    assert.equal(result.pr_url, "https://github.com/test/repo/pull/42");
    assert.equal(git.pushCalls.length, 1);
    assert.equal(git.pushCalls[0], "auto/test-task-2026-04-26");
    assert.equal(gh.createCalls.length, 1);
    // Draft semantics are encoded in createDraftPr's NAME -- the orchestrator
    // never calls a non-draft variant. Verify the title shape and bodyPath
    // are threaded through correctly.
    assert.equal(gh.createCalls[0].branch, "auto/test-task-2026-04-26");
    assert.match(gh.createCalls[0].title, /^\[dispatcher\] audit:/);
    assert.match(gh.createCalls[0].bodyPath, /dispatcher-pr-body-/);
    // Body file written and cleaned up.
    assert.equal(fs.writeCalls.length, 1);
    assert.equal(fs.unlinkCalls.length, 1);
    assert.equal(fs.writeCalls[0].path, fs.unlinkCalls[0]);
    // Labels added best-effort.
    assert.equal(gh.labelCalls.length, 1);
    assert.match(gh.labelCalls[0].labels, /dispatcher:auto/);
    assert.match(gh.labelCalls[0].labels, /task:audit/);
    // Single log entry with the success outcome + pr_url.
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].outcome, "auto-push-success");
    assert.equal(log.calls[0].pr_url, "https://github.com/test/repo/pull/42");
  });

  it("dryRun=true -> firewall evaluated, no git/gh side effects, dry-run outcome logged", async () => {
    const args = baseHappyArgs();
    const git = mockGit({ files: ["src/a.js"] });
    const gh = mockGh();
    const log = mockLogger();
    const fs = mockFs();
    const result = await maybeAutoPush({
      ...args,
      dryRun: true,
      gitClient: git,
      ghClient: gh,
      logger: log,
      fs,
    });
    assert.equal(result.outcome, "auto-push-dry-run");
    assert.equal(result.changed_file_count, 1);
    assert.equal(git.pushCalls.length, 0);
    assert.equal(gh.createCalls.length, 0);
    assert.equal(fs.writeCalls.length, 0);
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].outcome, "auto-push-dry-run");
  });

  it("git push throws -> failed/git-push-failed; gh untouched; commit preserved", async () => {
    const args = baseHappyArgs();
    const git = mockGit({
      files: ["src/a.js"],
      pushThrows: new Error("non-fast-forward (concurrent fleet push)"),
    });
    const gh = mockGh();
    const log = mockLogger();
    const result = await maybeAutoPush({
      ...args,
      gitClient: git,
      ghClient: gh,
      logger: log,
      fs: mockFs(),
    });
    assert.equal(result.outcome, "auto-push-failed");
    assert.equal(result.reason, "git-push-failed");
    assert.match(result.error, /non-fast-forward/);
    assert.equal(git.pushCalls.length, 1);
    assert.equal(gh.createCalls.length, 0); // PR creation NOT attempted
    assert.equal(log.calls[0].outcome, "auto-push-failed");
    assert.equal(log.calls[0].reason, "git-push-failed");
  });

  it("gh pr create throws after successful push -> failed/pr-create-failed with pushed:true", async () => {
    // Regression guard: when push succeeds but gh pr create fails (auth scope,
    // rate limit, branch protection rejecting draft), the local commit AND the
    // remote branch are both intact. Operator can `gh pr create --draft` manually.
    const args = baseHappyArgs();
    const git = mockGit({ files: ["src/a.js"] });
    const gh = mockGh({ createThrows: new Error("API rate limit exceeded") });
    const log = mockLogger();
    const result = await maybeAutoPush({
      ...args,
      gitClient: git,
      ghClient: gh,
      logger: log,
      fs: mockFs(),
    });
    assert.equal(result.outcome, "auto-push-failed");
    assert.equal(result.reason, "pr-create-failed");
    assert.equal(result.pushed, true); // Critical: branch IS on origin
    assert.match(result.error, /API rate limit/);
    assert.equal(git.pushCalls.length, 1); // Push was attempted and succeeded
    assert.equal(gh.createCalls.length, 1); // PR creation was attempted
    assert.equal(gh.labelCalls.length, 0); // No labels because no PR URL
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].outcome, "auto-push-failed");
    assert.equal(log.calls[0].reason, "pr-create-failed");
    assert.equal(log.calls[0].pushed, true);
  });
});

// ---------------------------------------------------------------------------
// FALLBACK_PROTECTED_GLOBS sanity (defense-in-depth)
// ---------------------------------------------------------------------------

describe("FALLBACK_PROTECTED_GLOBS", () => {
  it("includes the canonical six minimum protections", () => {
    assert.ok(FALLBACK_PROTECTED_GLOBS.includes(".github/**"));
    assert.ok(FALLBACK_PROTECTED_GLOBS.includes("package.json"));
    assert.ok(FALLBACK_PROTECTED_GLOBS.includes("package-lock.json"));
    assert.ok(FALLBACK_PROTECTED_GLOBS.includes("**/secrets/**"));
    assert.ok(FALLBACK_PROTECTED_GLOBS.includes("**/credentials/**"));
    assert.ok(FALLBACK_PROTECTED_GLOBS.includes("LICENSE*"));
  });

  it("is frozen so accidental mutation throws (in strict mode) or no-ops", () => {
    assert.equal(Object.isFrozen(FALLBACK_PROTECTED_GLOBS), true);
  });
});
