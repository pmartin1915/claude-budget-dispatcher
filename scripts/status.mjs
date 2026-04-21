#!/usr/bin/env node
// status.mjs -- Multi-machine dispatch status board CLI.
// Reads/writes structured comments on GitHub Issue #1.
// Zero external dependencies (uses gh CLI via child_process).
//
// Usage:
//   node scripts/status.mjs checkin  "P4 Flash truncation guard" main
//   node scripts/status.mjs checkout "P4 shipped (ff15273)" "combo e9e659a, dispatcher ff15273" "P1 Ollama, P2 Optiplex"
//   node scripts/status.mjs conflict "worker.mjs edited on both machines" "rebased laptop on PC"
//   node scripts/status.mjs read     [--count 5]
//   node scripts/status.mjs tasks
//   node scripts/status.mjs check    "P1: Install Ollama on PC"

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

const REPO = "pmartin1915/budget-dispatcher";
const ISSUE = "1";
const MACHINE = hostname();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gh(...args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const stderr = e.stderr?.toString().trim() ?? e.message;
    console.error(`[status] gh error: ${stderr}`);
    process.exit(1);
  }
}

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function postComment(body) {
  gh("issue", "comment", ISSUE, "--repo", REPO, "--body", body);
  console.log(`[status] Comment posted to ${REPO}#${ISSUE}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function checkin(task, branch = "main") {
  if (!task) {
    console.error("Usage: status.mjs checkin <task> [branch]");
    process.exit(1);
  }
  const body = [
    `### [CHECKIN] ${MACHINE}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Machine** | ${MACHINE} |`,
    `| **Time** | ${now()} |`,
    `| **Task** | ${task} |`,
    `| **Branch** | ${branch} |`,
  ].join("\n");
  postComment(body);
}

function checkout(completed, pushed, next) {
  if (!completed) {
    console.error("Usage: status.mjs checkout <completed> [pushed] [next]");
    process.exit(1);
  }
  const rows = [
    `| **Machine** | ${MACHINE} |`,
    `| **Time** | ${now()} |`,
    `| **Completed** | ${completed} |`,
  ];
  if (pushed) rows.push(`| **Pushed** | ${pushed} |`);
  if (next) rows.push(`| **Next** | ${next} |`);

  const body = [
    `### [CHECKOUT] ${MACHINE}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    ...rows,
  ].join("\n");
  postComment(body);
}

function conflict(issue, resolution) {
  if (!issue) {
    console.error("Usage: status.mjs conflict <issue> [resolution]");
    process.exit(1);
  }
  const rows = [
    `| **Machine** | ${MACHINE} |`,
    `| **Time** | ${now()} |`,
    `| **Issue** | ${issue} |`,
  ];
  if (resolution) rows.push(`| **Resolution** | ${resolution} |`);

  const body = [
    `### [CONFLICT] ${MACHINE}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    ...rows,
  ].join("\n");
  postComment(body);
}

function read(count = 5) {
  const comments = gh(
    "api",
    `repos/${REPO}/issues/${ISSUE}/comments`,
    "--jq",
    `.[-${count}:] | .[] | "---\\n" + .body + "\\n"`,
  );
  if (!comments) {
    console.log("[status] No comments yet.");
    return;
  }
  console.log(`\n=== Last ${count} status updates ===\n`);
  console.log(comments);
}

function tasks() {
  // Fetch issue body and extract checkbox lines
  const body = gh(
    "issue", "view", ISSUE, "--repo", REPO, "--json", "body", "--jq", ".body",
  );
  const lines = body.split("\n").filter((l) => /^\s*- \[[ x]\]/.test(l));
  if (lines.length === 0) {
    console.log("[status] No tasks found in issue body.");
    return;
  }
  const done = lines.filter((l) => l.includes("[x]")).length;
  const total = lines.length;
  console.log(`\n=== Task Checklist (${done}/${total} done) ===\n`);
  for (const line of lines) {
    console.log(line.trim());
  }
}

// NOTE: read-modify-write on issue body is NOT atomic. Two concurrent edits
// clobber each other. The checkin protocol mitigates this: only one instance
// should edit at a time. If this ever becomes a problem, switch to posting a
// "[TASK DONE]" comment instead of editing the body.
function checkTask(taskSubstring) {
  if (!taskSubstring) {
    console.error("Usage: status.mjs check <task substring>");
    process.exit(1);
  }
  // Fetch current body
  const body = gh(
    "issue", "view", ISSUE, "--repo", REPO, "--json", "body", "--jq", ".body",
  );
  // Find the unchecked task line matching the substring
  const lines = body.split("\n");
  let found = false;
  const updated = lines.map((line) => {
    if (!found && line.includes("- [ ]") && line.toLowerCase().includes(taskSubstring.toLowerCase())) {
      found = true;
      return line.replace("- [ ]", "- [x]");
    }
    return line;
  });
  if (!found) {
    console.error(`[status] No unchecked task matching "${taskSubstring}" found.`);
    process.exit(1);
  }
  // Update issue body
  gh("issue", "edit", ISSUE, "--repo", REPO, "--body", updated.join("\n"));
  console.log(`[status] Checked off task matching "${taskSubstring}"`);
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "checkin":
    checkin(args[0], args[1]);
    break;
  case "checkout":
    checkout(args[0], args[1], args[2]);
    break;
  case "conflict":
    conflict(args[0], args[1]);
    break;
  case "read": {
    let count = 5;
    const countIdx = args.indexOf("--count");
    if (countIdx > -1 && args.length > countIdx + 1) {
      const parsed = parseInt(args[countIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) count = parsed;
    }
    read(count);
    break;
  }
  case "tasks":
    tasks();
    break;
  case "check":
    checkTask(args[0]);
    break;
  default:
    console.log(`Usage: node scripts/status.mjs <command> [args]

Commands:
  checkin  <task> [branch]              Post a check-in comment
  checkout <completed> [pushed] [next]  Post a check-out comment
  conflict <issue> [resolution]         Post a conflict alert
  read     [--count N]                  Read last N status updates (default 5)
  tasks                                 Show task checklist from issue body
  check    <task substring>             Check off a task in the issue body

Environment:
  Machine hostname: ${MACHINE}
  GitHub repo:      ${REPO}
  Issue:            #${ISSUE}`);
}
