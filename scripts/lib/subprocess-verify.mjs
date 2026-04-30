// subprocess-verify.mjs — P0-1 (re-scoped): 3-step dispatch→wait→verify
// wrapper for subprocess execution.
//
// The original P0-1 audit item ("interactive shell sinkholes") targeted
// tmux-based keystroke dispatch, which the Node engine has replaced with
// direct API calls. However, the dispatch→wait→verify pattern is still
// valuable for subprocess execution (canaryRunner, post-merge replays)
// where a process can exit(0) without producing expected output markers.
//
// Usage:
//   import { verifiedExec } from "./subprocess-verify.mjs";
//   const result = await verifiedExec({
//     command: ["npm.cmd", "test"],
//     cwd: "/path/to/project",
//     successMarkers: [/passing|tests? passed|ok/i],
//     timeoutMs: 60000,
//   });
//   if (!result.verified) {
//     // Command ran but output didn't contain success markers
//   }
//
// Design:
//   - Step 1: Spawn the subprocess with stdout/stderr capture.
//   - Step 2: Wait for settleMs after exit before checking output (allows
//     buffered I/O to flush; default 200ms).
//   - Step 3: Verify output buffer contains at least one successMarker.
//   - On verification failure: retry up to maxRetries times.
//   - On all retries exhausted: return { verified: false, retries }.
//   - Never throws. Returns a structured result on every path.
//
// Cross-platform: uses getCanarySpawnOptions from auto-push.mjs for
// .cmd/.bat handling on Windows.
//
// P0-1 of the Architectural Audit and Hardening Roadmap (2026-04-30).

import { spawn } from "node:child_process";

/**
 * Decide spawn options based on platform + command extension.
 * Extracted from auto-push.mjs for reuse. Same logic: shell:true only
 * for .cmd/.bat on Windows; detached:true on POSIX for process-group kill.
 *
 * @param {string[]} command
 * @param {string} [platform=process.platform]
 * @returns {{ shell: boolean, detached: boolean }}
 */
function spawnOptions(command, platform = process.platform) {
  const isWindows = platform === "win32";
  const exe = String(command[0]).toLowerCase();
  const isCmdShim = isWindows && (exe.endsWith(".cmd") || exe.endsWith(".bat"));
  return { shell: isCmdShim, detached: !isWindows };
}

/**
 * Trail-limit a string to its last `max` characters.
 * @param {string} s
 * @param {number} [max=2000]
 * @returns {string}
 */
function trail(s, max = 2000) {
  if (!s) return "";
  return s.length > max ? s.slice(-max) : s;
}

/**
 * Single execution attempt. Returns a structured result.
 *
 * @param {object} opts
 * @param {string[]} opts.command
 * @param {string} opts.cwd
 * @param {number} opts.timeoutMs
 * @param {number} opts.settleMs
 * @param {string} [opts.platform]
 * @returns {Promise<{
 *   exitCode: number|null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   spawnError: boolean,
 *   durationMs: number
 * }>}
 */
function execOnce({ command, cwd, timeoutMs, settleMs, platform }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let resolved = false;

    const safeResolve = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve(payload);
    };

    let child;
    try {
      const { shell, detached } = spawnOptions(command, platform);
      child = spawn(command[0], command.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell,
        detached,
      });
    } catch (e) {
      safeResolve({
        exitCode: null,
        stdout: "",
        stderr: String(e?.message ?? e),
        timedOut: false,
        spawnError: true,
        durationMs: Date.now() - t0,
      });
      return;
    }

    child.stdout?.on("data", (d) => stdoutChunks.push(d));
    child.stderr?.on("data", (d) => stderrChunks.push(d));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if ((platform ?? process.platform) === "win32") {
          // On Windows we can't use process.kill(-pid) for process groups.
          // child.kill() sends SIGTERM which Node translates to TerminateProcess.
          // For tree-kill we'd need taskkill, but spawning a child to kill a
          // child in ESM is fragile. child.kill('SIGKILL') is best-effort.
          child.kill("SIGKILL");
        } else {
          // On POSIX with detached:true, kill the process group.
          process.kill(-child.pid, "SIGKILL");
        }
      } catch { /* best-effort kill */ }
    }, timeoutMs);

    const finalize = (code) => {
      clearTimeout(timer);
      // Step 2: settle period — let buffered I/O flush.
      setTimeout(() => {
        safeResolve({
          exitCode: timedOut ? null : code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut,
          spawnError: false,
          durationMs: Date.now() - t0,
        });
      }, settleMs);
    };

    child.on("close", finalize);
    child.on("error", (err) => {
      clearTimeout(timer);
      safeResolve({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8") + (err?.message ?? ""),
        timedOut: false,
        spawnError: true,
        durationMs: Date.now() - t0,
      });
    });
  });
}

/**
 * 3-step verified subprocess execution.
 *
 * Step 1: Spawn the command and capture output.
 * Step 2: Wait settleMs after exit for I/O buffer flush.
 * Step 3: Verify stdout+stderr contain at least one successMarker regex.
 *
 * If verification fails (exit code 0 but no markers), retry up to
 * maxRetries times. On final failure, return { verified: false }.
 *
 * @param {object} opts
 * @param {string[]} opts.command - argv array (e.g. ["npm.cmd", "test"])
 * @param {string} opts.cwd - working directory
 * @param {RegExp[]} [opts.successMarkers] - regex patterns. At least one
 *   must match in stdout or stderr for the run to be "verified". If empty
 *   or omitted, verification is skipped (exit code is sufficient).
 * @param {number} [opts.timeoutMs=120000] - overall timeout per attempt
 * @param {number} [opts.settleMs=200] - post-exit settle before checking output
 * @param {number} [opts.maxRetries=1] - retries on verification failure (not on non-zero exit)
 * @param {string} [opts.platform] - process.platform override for testing
 * @returns {Promise<{
 *   verified: boolean,
 *   exitCode: number|null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   spawnError: boolean,
 *   durationMs: number,
 *   attempts: number,
 *   verificationFailures: number,
 *   stdout_tail: string,
 *   stderr_tail: string
 * }>}
 */
export async function verifiedExec({
  command,
  cwd,
  successMarkers = [],
  timeoutMs = 120_000,
  settleMs = 200,
  maxRetries = 1,
  platform,
}) {
  const totalAttempts = 1 + maxRetries;
  let lastResult = null;
  let verificationFailures = 0;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    lastResult = await execOnce({
      command,
      cwd,
      timeoutMs,
      settleMs,
      platform,
    });

    // If the process failed hard (non-zero exit, timeout, spawn error),
    // verification is irrelevant — the command didn't succeed.
    if (lastResult.timedOut || lastResult.spawnError || lastResult.exitCode !== 0) {
      return {
        verified: false,
        ...lastResult,
        attempts: attempt + 1,
        verificationFailures,
        stdout_tail: trail(lastResult.stdout),
        stderr_tail: trail(lastResult.stderr),
      };
    }

    // Step 3: Verify output markers (if any are specified).
    if (successMarkers.length === 0) {
      // No markers required — exit code 0 is sufficient verification.
      return {
        verified: true,
        ...lastResult,
        attempts: attempt + 1,
        verificationFailures,
        stdout_tail: trail(lastResult.stdout),
        stderr_tail: trail(lastResult.stderr),
      };
    }

    const combined = lastResult.stdout + lastResult.stderr;
    const markerFound = successMarkers.some((re) => re.test(combined));

    if (markerFound) {
      return {
        verified: true,
        ...lastResult,
        attempts: attempt + 1,
        verificationFailures,
        stdout_tail: trail(lastResult.stdout),
        stderr_tail: trail(lastResult.stderr),
      };
    }

    // Verification failed — buffer may have been absorbed. Retry.
    verificationFailures++;
  }

    // All attempts exhausted — verification never succeeded.
  return {
    verified: false,
    ...lastResult,
    attempts: totalAttempts,
    verificationFailures,
    stdout_tail: trail(lastResult?.stdout ?? ""),
    stderr_tail: trail(lastResult?.stderr ?? ""),
  };
}

/**
 * P0-1 Hardening: Localized IPC Watchdog Timer.
 * Prevents infinite silent stalls when waiting for an IPC response from a child process
 * (e.g. child_process.fork()) that may have crashed out-of-band or deadlocked.
 * 
 * @param {import("node:child_process").ChildProcess} child - The child process with an IPC channel.
 * @param {any} message - The message payload to send via IPC.
 * @param {number} [watchdogMs=5000] - Timeout in milliseconds before rejecting the promise.
 * @returns {Promise<any>} A promise that resolves with the first received IPC message.
 */
export function sendIpcWithWatchdog(child, message, watchdogMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!child || typeof child.send !== "function") {
      return reject(new Error("Child process does not have an active IPC channel."));
    }

    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("message", onMsg);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      child.removeListener("disconnect", onDisconnect);
    };

    const onMsg = (m) => {
      cleanup();
      resolve(m);
    };

    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`IPC failed: child process exited with code ${code} signal ${signal}`));
    };

    const onError = (err) => {
      cleanup();
      reject(new Error(`IPC failed: child process error: ${err.message}`));
    };

    const onDisconnect = () => {
      cleanup();
      reject(new Error("IPC failed: child process disconnected out-of-band"));
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`IPC watchdog timeout: silent stall detected after ${watchdogMs}ms`));
    }, watchdogMs);

    child.on("message", onMsg);
    child.on("exit", onExit);
    child.on("error", onError);
    child.on("disconnect", onDisconnect);

    child.send(message, (err) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });
}
