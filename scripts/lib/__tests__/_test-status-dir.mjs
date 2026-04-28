// _test-status-dir.mjs -- shared test prelude.
//
// Sets BUDGET_DISPATCH_STATUS_DIR to a tmpdir BEFORE any module under test
// resolves its STATUS_DIR / LOG_PATH constants. Test files import this as
// their first import; ESM evaluates sibling imports in source order, so the
// env var is set before downstream imports of overseer.mjs / log.mjs read it.
//
// Without this prelude, default-appender fallback paths (e.g. runCli ->
// defaultAppender in overseer.mjs) write fixture entries to the live
// status/budget-dispatch-log.jsonl that fleet.mjs syncs to the gist.

import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

if (!process.env.BUDGET_DISPATCH_STATUS_DIR) {
  process.env.BUDGET_DISPATCH_STATUS_DIR = mkdtempSync(
    resolve(tmpdir(), "dispatcher-test-status-"),
  );
}

export const TEST_STATUS_DIR = process.env.BUDGET_DISPATCH_STATUS_DIR;
