// worker.mjs — Phase 4: Execute work via local commands or free-tier LLM APIs.
// Handles local tasks, audit, codegen (3-step loop), and docs generation.

import { execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve, relative, sep, dirname, basename } from "node:path";
import { extractJson } from "./extract-json.mjs";
import { throttleFor, withTimeout, API_TIMEOUT_MS } from "./throttle.mjs";
import { providerFor, callProvider } from "./provider.mjs";
import { validateAuditResponse } from "./schemas.mjs";

const MAX_FILE_CHARS = 50_000; // Per-file context budget for LLM prompts

// P4: Flash truncation guard — code-like extensions that must have balanced delimiters.
const CODE_EXTENSIONS = /\.(m?[jt]sx?|json|css|scss|vue|svelte)$/i;

// Windows reserved device names — CVE-2025-23084 / CVE-2025-27210 bypass vector.
// Matches CON, PRN, AUX, NUL, COM1-9, LPT1-9 with or without extension.
const WIN_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:$|\.)/i;

// Env allowlist for subprocesses running untrusted / generated code (S-5).
// Strips API keys (GEMINI_API_KEY, MISTRAL_API_KEY, etc.) so they cannot be
// read by generated tests. Keeps the minimum needed for npm / node / git on Windows.
const SAFE_ENV_KEYS = [
  "PATH", "Path", "PATHEXT",
  "SystemRoot", "SYSTEMDRIVE", "windir", "COMSPEC",
  "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData",
  "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "USERNAME",
  "TEMP", "TMP",
  "NODE_PATH", "npm_config_cache",
];

export function getSafeTestEnv() {
  const safe = {};
  for (const k of SAFE_ENV_KEYS) {
    if (process.env[k] !== undefined) safe[k] = process.env[k];
  }
  return safe;
}

/**
 * Verify that `candidate` resolves (after symlink canonicalization) inside `base`.
 * Defeats: symlink escapes (S-3), prefix-substring match (e.g. "/foo/bar" vs
 * "/foo/bar-evil"), Windows case-insensitivity (S-4), and Windows reserved
 * device names (S-9, CVE-2025-23084/27210).
 *
 * Handles not-yet-existing write targets by walking up to the longest existing
 * ancestor, realpath'ing that, and rejoining the non-existent suffix.
 *
 * @param {string} candidate - Absolute path to check.
 * @param {string} base - Absolute project root (must exist on disk).
 * @returns {boolean} true iff candidate is safely inside base.
 */
export function isPathInside(candidate, base) {
  let realBase;
  try {
    realBase = realpathSync(base);
  } catch {
    return false; // base missing/unreadable — fail closed
  }
  const baseWithSep = realBase.endsWith(sep) ? realBase : realBase + sep;

  if (process.platform === "win32") {
    const segs = candidate.split(/[\\/]/);
    if (segs.some((s) => WIN_RESERVED.test(s))) return false;
  }

  // Walk up until we find an existing ancestor, realpath it, then rejoin.
  let existing = candidate;
  const suffix = [];
  for (let guard = 0; guard < 100; guard++) {
    try {
      existing = realpathSync(existing);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") return false;
      const parent = dirname(existing);
      if (parent === existing) return false; // hit root without finding anything
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }

  const real = suffix.length ? resolve(existing, ...suffix) : existing;

  if (process.platform === "win32") {
    return real.toLowerCase().startsWith(baseWithSep.toLowerCase());
  }
  return real.startsWith(baseWithSep);
}

/**
 * Execute the selected task.
 * @param {object} selection - { project, task, projectConfig }
 * @param {object} route - { delegate_to, model, taskClass, auditModel?, candidates? }
 * @param {object} config - Parsed budget.json
 * @param {{ gemini: object, mistral: object }} clients - SDK instances
 * @param {string} [worktreePath] - Path to git worktree (null for local tasks)
 * @returns {Promise<object>} Work result with outcome, summary, filesChanged, etc.
 */
export async function executeWork(selection, route, config, clients, worktreePath) {
  const { task, projectConfig } = selection;
  const projectPath = worktreePath ?? projectConfig.path;
  const providerConfig = config.free_model_roster?.providers ?? {};

  if (route.delegate_to === "local") {
    return executeLocalTask(task, projectPath);
  }

  if (route.delegate_to === "skip") {
    return { outcome: "skipped", reason: route.reason };
  }

  switch (route.taskClass) {
    case "audit":
    case "explore":
    case "research":
      return executeAnalysisTask(
        task,
        route.taskClass,
        projectPath,
        projectConfig,
        clients,
        providerConfig,
        route
      );

    case "tests_gen":
    case "refactor":
      return executeCodegenTask(
        task,
        projectPath,
        projectConfig,
        clients,
        providerConfig,
        route
      );

    case "docs_gen":
      return executeDocsTask(
        task,
        projectPath,
        projectConfig,
        clients,
        providerConfig,
        route
      );

    case "slot_fill":
      return executeSlotFillTask(
        projectPath,
        projectConfig,
        clients,
        providerConfig,
        route
      );

    default:
      return { outcome: "error", reason: `unknown-task-class-${route.taskClass}` };
  }
}

// ---------------------------------------------------------------------------
// Local tasks (test, typecheck, lint, coverage) — zero LLM tokens
// ---------------------------------------------------------------------------

async function executeLocalTask(task, projectPath) {
  const commands = {
    test: ["npm", ["test"]],
    typecheck: ["npx", ["tsc", "--noEmit"]],
    lint: ["npm", ["run", "lint:fix"]],
    coverage: ["npm", ["run", "test:coverage"]],
  };

  const [cmd, args] = commands[task] ?? ["npm", ["run", task]];
  const result = await runWithTreeKill(cmd, args, {
    cwd: projectPath,
    env: getSafeTestEnv(), // S-5: strip API keys from project scripts
    timeoutMs: TEST_TIMEOUT_MS,
  });

  if (result.pass) {
    return {
      outcome: "success",
      summary: `${task} passed`,
      stdout: truncate(result.stdout, 2000),
    };
  }
  return {
    outcome: "local-task-failed",
    reason: `${task} failed`,
    stderr: truncate(result.stderr, 2000),
    stdout: truncate(result.stdout, 2000),
  };
}

// ---------------------------------------------------------------------------
// Analysis tasks (audit, explore, research) — read-only, any provider
// ---------------------------------------------------------------------------

async function executeAnalysisTask(task, taskClass, projectPath, projectConfig, clients, providerConfig, route) {
  const files = gatherFilesForAnalysis(projectPath, task);
  if (files.length === 0) {
    return { outcome: "skipped", reason: "no-files-to-analyze" };
  }

  const prompt = buildAnalysisPrompt(task, taskClass, files, projectConfig);

  try {
    // C-5: try primary model, fall back to alternatives on 503/5xx
    const { text, model: usedModel } = await callModelWithFallback(clients, providerConfig, route.candidates ?? [route.model], prompt);

    // For audit tasks, write findings to a file in the worktree
    if (taskClass === "audit") {
      const findingsPath = resolve(projectPath, `audit-findings-${Date.now()}.md`);
      writeFileSync(findingsPath, `# Audit Findings\n\n${text}\n`);
      return {
        outcome: "success",
        summary: `audit complete, findings written`,
        filesChanged: [relative(projectPath, findingsPath)],
        auditText: text,
        modelUsed: usedModel,
      };
    }

    // Explore/research: write a session log
    const logPath = resolve(projectPath, "ai", `dispatch-${task}-${Date.now()}.md`);
    ensureDir(resolve(projectPath, "ai"));
    writeFileSync(logPath, `# ${task} results\n\n${text}\n`);
    return {
      outcome: "success",
      summary: `${task} complete`,
      filesChanged: [relative(projectPath, logPath)],
      modelUsed: usedModel,
    };
  } catch (e) {
    return { outcome: "error", reason: `analysis-${task}-error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Codegen tasks (tests-gen, refactor, clean) — 3-step generate-verify-audit
// ---------------------------------------------------------------------------

async function executeCodegenTask(task, projectPath, projectConfig, clients, providerConfig, route) {
  const files = gatherFilesForCodegen(projectPath, task);
  if (files.length === 0) {
    return { outcome: "skipped", reason: "no-files-for-codegen" };
  }

  // Validate: never generate code for domain/ on clinical projects
  if (projectConfig.clinical_gate) {
    const domainFiles = files.filter((f) => f.relPath.includes("domain/") || f.relPath.includes("domain\\"));
    if (domainFiles.length > 0) {
      return { outcome: "skipped", reason: "clinical-domain-files-forbidden" };
    }
  }

  const prompt = buildCodegenPrompt(task, files, projectConfig);

  // Step 1: Generate — C-5: try candidates in order on 503/5xx
  let generatedText;
  let usedModel;
  try {
    const result = await callModelWithFallback(clients, providerConfig, route.candidates ?? [route.model], prompt);
    generatedText = result.text;
    usedModel = result.model;
  } catch (e) {
    return { outcome: "error", reason: `codegen-generate-error: ${e.message}` };
  }

  const parsedFiles = parseFileOutput(generatedText);
  if (!parsedFiles || parsedFiles.length === 0) {
    // T1-A coverage: malformed-worker-output (first-pass parse, zero blocks)
    // Captures: usedModel + task + project + generatedText (4KB tail) + length
    // Writes: status/last-malformed-output.json (overwritten by fix-parse-failed writer below)
    try {
      const diagnosticPath = resolve(process.cwd(), "status", "last-malformed-output.json");
      const payload = {
        ts: new Date().toISOString(),
        model: usedModel ?? null,
        task: task ?? null,
        project: projectConfig?.slug ?? null,
        generatedText: (generatedText || "").slice(0, 4096),
        generatedTextLength: (generatedText || "").length,
      };
      writeFileSync(diagnosticPath, JSON.stringify(payload, null, 2));
    } catch { /* fail-soft */ }
    return { outcome: "error", reason: "malformed-worker-output" };
  }

  // Validate all paths are within the project (realpath + trailing-sep + case-safe)
  for (const f of parsedFiles) {
    const abs = resolve(projectPath, f.path);
    if (!isPathInside(abs, projectPath)) {
      return { outcome: "error", reason: `path-escape-attempt: ${f.path}` };
    }
    // Clinical gate: no domain/ writes
    if (projectConfig.clinical_gate && (f.path.includes("domain/") || f.path.includes("domain\\"))) {
      return { outcome: "error", reason: `clinical-domain-write-blocked: ${f.path}` };
    }
  }

  writeGeneratedFiles(parsedFiles, projectPath);

  // Step 2: Verify (run tests)
  const testResult = await runTestsSafe(projectPath);
  if (!testResult.pass) {
    // One retry with error context
    const fixPrompt = buildFixPrompt(task, files, parsedFiles, testResult.stderr);
    try {
      // Pin fix step to the model that generated the code (don't restart fallback walk)
      const fixedText = await callModelThrottled(clients, providerConfig, usedModel, fixPrompt);
      const fixedFiles = parseFileOutput(fixedText);
      if (!fixedFiles || fixedFiles.length === 0) {
        // T1-A coverage: fix-parse-failed (autofix-pass parse, zero blocks)
        // Captures: usedModel + task + project + fixedText (4KB tail) + length
        // Writes: status/last-malformed-output.json (intentional overwrite -- most recent event is most actionable)
        try {
          const diagnosticPath = resolve(process.cwd(), "status", "last-malformed-output.json");
          const payload = {
            ts: new Date().toISOString(),
            model: usedModel ?? null,
            task: task ?? null,
            project: projectConfig?.slug ?? null,
            generatedText: (fixedText || "").slice(0, 4096),
            generatedTextLength: (fixedText || "").length,
            phase: "fix-parse-failed",
          };
          writeFileSync(diagnosticPath, JSON.stringify(payload, null, 2));
        } catch { /* fail-soft */ }
        revertChanges(projectPath);
        return { outcome: "reverted", reason: "fix-parse-failed" };
      }
      // Validate paths on retry (same checks as first pass)
      for (const f of fixedFiles) {
        const abs = resolve(projectPath, f.path);
        if (!isPathInside(abs, projectPath)) {
          revertChanges(projectPath);
          return { outcome: "error", reason: `path-escape-attempt-retry: ${f.path}` };
        }
        if (projectConfig.clinical_gate && (f.path.includes("domain/") || f.path.includes("domain\\"))) {
          revertChanges(projectPath);
          return { outcome: "error", reason: `clinical-domain-write-blocked-retry: ${f.path}` };
        }
      }
      writeGeneratedFiles(fixedFiles, projectPath);

      const retest = await runTestsSafe(projectPath);
      if (!retest.pass) {
        revertChanges(projectPath);
        return { outcome: "reverted", reason: "tests-failed-after-retry" };
      }
    } catch {
      revertChanges(projectPath);
      return { outcome: "reverted", reason: "fix-attempt-error" };
    }
  }

  // Step 3: Audit (cross-family, free)
  try {
    const changedFiles = getChangedFiles(projectPath);
    const auditResult = await auditChanges(clients, providerConfig, changedFiles, projectPath, usedModel, route.auditModel);
    if (auditResult.hasCritical) {
      revertChanges(projectPath);
      return { outcome: "reverted", reason: "audit-critical-finding", auditResult };
    }
    return {
      outcome: "success",
      summary: `${task}: ${parsedFiles.length} file(s) generated, tests pass, audit clean`,
      filesChanged: changedFiles,
      auditResult,
      modelUsed: usedModel,
    };
  } catch {
    // Audit failure is non-fatal — proceed with commit
    const changedFiles = getChangedFiles(projectPath);
    return {
      outcome: "success",
      summary: `${task}: ${parsedFiles.length} file(s) generated, tests pass, audit skipped`,
      filesChanged: changedFiles,
      modelUsed: usedModel,
    };
  }
}

// ---------------------------------------------------------------------------
// Docs tasks (docs-gen, jsdoc, session-log) — any provider
// ---------------------------------------------------------------------------

async function executeDocsTask(task, projectPath, projectConfig, clients, providerConfig, route) {
  const files = gatherFilesForDocs(projectPath, task);
  if (files.length === 0) {
    return { outcome: "skipped", reason: "no-files-for-docs" };
  }

  // Clinical gate: block domain/ files from free-model docs generation
  if (projectConfig.clinical_gate) {
    const domainFiles = files.filter(
      (f) => f.relPath.includes("domain/") || f.relPath.includes("domain\\")
    );
    if (domainFiles.length > 0) {
      return { outcome: "skipped", reason: "clinical-domain-docs-forbidden" };
    }
  }

  const prompt = buildDocsPrompt(task, files, projectConfig);

  try {
    // C-5: try primary model, fall back to alternatives on 503/5xx
    const { text, model: usedModel } = await callModelWithFallback(clients, providerConfig, route.candidates ?? [route.model], prompt);
    const parsedFiles = parseFileOutput(text);

    if (parsedFiles && parsedFiles.length > 0) {
      writeGeneratedFiles(parsedFiles, projectPath);
      return {
        outcome: "success",
        summary: `${task}: ${parsedFiles.length} file(s) updated`,
        filesChanged: parsedFiles.map((f) => f.path),
        modelUsed: usedModel,
      };
    }

    // If no structured output, write as a markdown file
    const outputPath = resolve(projectPath, "ai", `dispatch-${task}-${Date.now()}.md`);
    ensureDir(resolve(projectPath, "ai"));
    writeFileSync(outputPath, `# ${task}\n\n${text}\n`);
    return {
      outcome: "success",
      summary: `${task}: output written`,
      filesChanged: [relative(projectPath, outputPath)],
      modelUsed: usedModel,
    };
  } catch (e) {
    return { outcome: "error", reason: `docs-gen-error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Slot-fill tasks — expand flagged subsections in worldbuilder content files
// ---------------------------------------------------------------------------

// Regex to parse provenance header subsection flags.
// Matches lines like: "#   [!] sacred_register_phonology  — MISSING ..."
const FLAG_RE = /^#\s+\[([!?xX])\]\s+(\S+)/;

/**
 * Parse the provenance header from a YAML file's comment block.
 * Returns an array of { flag, subsection } in file order.
 * @param {string} content - Full file content
 * @returns {{ flag: string, subsection: string }[]}
 */
export function parseProvenanceFlags(content) {
  const flags = [];
  const lines = content.split("\n");
  let inHeader = false;

  for (const line of lines) {
    if (line.startsWith("# ====")) {
      if (inHeader) break; // end of header block
      inHeader = true;
      continue;
    }
    if (!inHeader) continue;

    const m = line.match(FLAG_RE);
    if (m) {
      flags.push({ flag: m[1], subsection: m[2] });
    }
  }
  return flags;
}

/**
 * Extract a section from a markdown file by heading prefix.
 * Reads from the heading line until the next `---` horizontal rule or EOF.
 * @param {string} content - Full markdown content
 * @param {string} headingPrefix - The heading text to search for (prefix match)
 * @returns {string|null}
 */
export function extractPromptSection(content, headingPrefix) {
  const lines = content.split("\n");
  let capturing = false;
  const captured = [];

  for (const line of lines) {
    if (!capturing) {
      // Match heading lines (any level) whose text starts with the prefix
      const headingMatch = line.match(/^#{1,6}\s+(.+)/);
      if (headingMatch && headingMatch[1].startsWith(headingPrefix)) {
        capturing = true;
        captured.push(line);
      }
    } else {
      if (/^---\s*$/.test(line)) break; // horizontal rule terminates section
      captured.push(line);
    }
  }

  return captured.length > 0 ? captured.join("\n") : null;
}

/**
 * Run validator commands against a generated file.
 * Substitutes {file} and {schema} placeholders in args.
 * @param {{ cmd: string, args: string[], schema?: string }[]} validators
 * @param {string} filePath - Absolute path to the file to validate
 * @param {string} projectPath - Project root (cwd for validators)
 * @returns {Promise<{ pass: boolean, stderr: string }>}
 */
async function runValidators(validators, filePath, projectPath) {
  const relFile = relative(projectPath, filePath);
  for (const v of validators) {
    const args = v.args.map((a) =>
      a.replace("{file}", relFile).replace("{schema}", v.schema ?? "")
    );
    const result = await runWithTreeKill(v.cmd, args, {
      cwd: projectPath,
      env: getSafeTestEnv(),
      timeoutMs: 30_000,
    });
    if (!result.pass) {
      return { pass: false, stderr: `${v.cmd} ${args.join(" ")}: ${result.stderr}` };
    }
  }
  return { pass: true, stderr: "" };
}

/**
 * Write a diagnostic note when slot_fill validation fails after retry.
 * @param {string} projectPath
 * @param {string} file - Relative path of the file that failed
 * @param {string} subsection - The subsection being expanded
 * @param {string} stderr - Validator error output
 */
function writeDiagnostic(projectPath, file, subsection, stderr) {
  const machine = hostname().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const notesDir = resolve(projectPath, "state", "notes");
  ensureDir(notesDir);
  const notePath = resolve(notesDir, `${machine}.md`);
  if (!isPathInside(notePath, projectPath)) return; // safety check on hostname

  const entry = [
    "",
    `## slot_fill failure — ${new Date().toISOString()}`,
    `- File: ${file}`,
    `- Subsection: ${subsection}`,
    `- Error: ${stderr.slice(0, 500)}`,
    "",
  ].join("\n");

  const payload = existsSync(notePath) ? entry : `# Dispatch Notes — ${machine}\n${entry}`;
  appendFileSync(notePath, payload);
}

/**
 * Execute a slot_fill task: expand the first flagged subsection in worldbuilder content.
 *
 * Flow:
 * 1. Read slot_fill_config from projectConfig
 * 2. Scan lane_files for the first [!] or [?] subsection
 * 3. Load and extract prompt section from prompt_file
 * 4. Call LLM with context + prompt + current file
 * 5. Parse output, validate path, write file
 * 6. Run validators; retry once on failure, revert + diagnostic on second failure
 */
async function executeSlotFillTask(projectPath, projectConfig, clients, providerConfig, route) {
  // Step 1: Validate slot_fill_config
  const sfc = projectConfig.slot_fill_config;
  if (!sfc || !Array.isArray(sfc.lane_files) || !sfc.prompt_file || !sfc.prompt_section) {
    return { outcome: "skipped", reason: "missing-slot_fill-config" };
  }

  // Step 2: Find the first actionable subsection across all lane files
  let targetFile = null;
  let targetSubsection = null;
  let targetFlag = null;
  let targetContent = null;

  for (const relPath of sfc.lane_files) {
    const absPath = resolve(projectPath, relPath);
    if (!isPathInside(absPath, projectPath)) {
      return { outcome: "error", reason: `path-escape-in-lane_files: ${relPath}` };
    }
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, "utf8");
    const flags = parseProvenanceFlags(content);

    // Priority: [!] first, then [?]
    const urgent = flags.find((f) => f.flag === "!");
    const partial = flags.find((f) => f.flag === "?");
    const pick = urgent ?? partial;

    if (pick) {
      targetFile = relPath;
      targetSubsection = pick.subsection;
      targetFlag = pick.flag;
      targetContent = content;
      break;
    }
  }

  if (!targetFile) {
    // All files are [x]/[X] — nothing to expand
    return { outcome: "skipped", reason: "slot_fill-complete" };
  }

  // Step 3: Load prompt body
  const promptFilePath = resolve(projectPath, sfc.prompt_file);
  if (!isPathInside(promptFilePath, projectPath)) {
    return { outcome: "error", reason: `path-escape-in-prompt_file: ${sfc.prompt_file}` };
  }
  if (!existsSync(promptFilePath)) {
    return { outcome: "error", reason: `prompt_file-not-found: ${sfc.prompt_file}` };
  }

  const promptFileContent = readFileSync(promptFilePath, "utf8");
  const promptSection = extractPromptSection(promptFileContent, sfc.prompt_section);
  if (!promptSection) {
    return { outcome: "error", reason: `prompt_section-not-found: ${sfc.prompt_section}` };
  }

  // Step 4: Build LLM prompt and call
  const prompt = [
    "You are a worldbuilder expanding a flagged subsection in a YAML culture/geography file.",
    "Follow the instructions in the prompt section below exactly.",
    `Target file: ${targetFile}`,
    `Target subsection to expand: ${targetSubsection} (currently flagged [${targetFlag}])`,
    "",
    "--- PROMPT SECTION ---",
    promptSection,
    "",
    "--- CURRENT FILE CONTENT ---",
    targetContent.slice(0, MAX_FILE_CHARS),
    "",
    "--- OUTPUT INSTRUCTION ---",
    `Respond with a single fenced YAML block labeled with the exact target path:`,
    "```" + targetFile,
    "(your complete updated YAML file content here)",
    "```",
    "Output the COMPLETE file with the subsection expanded in place. Do not omit existing content.",
  ].join("\n");

  let generatedText;
  let usedModel;
  try {
    const result = await callModelWithFallback(
      clients, providerConfig, route.candidates ?? [route.model], prompt
    );
    generatedText = result.text;
    usedModel = result.model;
  } catch (e) {
    return { outcome: "error", reason: `slot_fill-llm-error: ${e.message}` };
  }

  // Step 5: Parse output
  const parsedFiles = parseFileOutput(generatedText);
  if (!parsedFiles || parsedFiles.length === 0) {
    return { outcome: "error", reason: "slot_fill-parse-failed" };
  }

  // Validate: should be exactly our target file
  const outputFile = parsedFiles[0];
  const outputAbs = resolve(projectPath, outputFile.path);
  if (!isPathInside(outputAbs, projectPath)) {
    return { outcome: "error", reason: `path-escape-attempt: ${outputFile.path}` };
  }

  // Write the file
  writeGeneratedFiles([outputFile], projectPath);

  // Step 6: Run validators (if configured)
  const validators = sfc.validators ?? [];
  if (validators.length > 0) {
    const absTarget = resolve(projectPath, outputFile.path);
    const vResult = await runValidators(validators, absTarget, projectPath);

    if (!vResult.pass) {
      // Retry: re-invoke LLM with validator stderr appended
      const retryPrompt = prompt + "\n\n--- VALIDATOR ERROR (fix this) ---\n" + vResult.stderr.slice(0, 2000);
      try {
        const retryResult = await callModelThrottled(clients, providerConfig, usedModel, retryPrompt);
        const retryParsed = parseFileOutput(retryResult);
        if (!retryParsed || retryParsed.length === 0) {
          revertChanges(projectPath);
          writeDiagnostic(projectPath, targetFile, targetSubsection, "retry parse failed: " + vResult.stderr);
          return { outcome: "reverted", reason: "slot_fill-validation-failed" };
        }

        const retryAbs = resolve(projectPath, retryParsed[0].path);
        if (!isPathInside(retryAbs, projectPath)) {
          revertChanges(projectPath);
          return { outcome: "error", reason: `path-escape-attempt-retry: ${retryParsed[0].path}` };
        }

        writeGeneratedFiles([retryParsed[0]], projectPath);

        const v2 = await runValidators(validators, resolve(projectPath, retryParsed[0].path), projectPath);
        if (!v2.pass) {
          revertChanges(projectPath);
          writeDiagnostic(projectPath, targetFile, targetSubsection, v2.stderr);
          return { outcome: "reverted", reason: "slot_fill-validation-failed" };
        }
      } catch (e) {
        revertChanges(projectPath);
        writeDiagnostic(projectPath, targetFile, targetSubsection, `retry error: ${e.message}`);
        return { outcome: "reverted", reason: "slot_fill-retry-error" };
      }
    }
  }

  return {
    outcome: "success",
    summary: `slot_fill: expanded ${targetSubsection} in ${targetFile}`,
    filesChanged: [outputFile.path],
    modelUsed: usedModel,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Call any model via the provider abstraction, with throttling.
 * @param {{ gemini: object, mistral: object }} clients
 * @param {object} providerConfig - free_model_roster.providers from budget.json
 * @param {string} model
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callModelThrottled(clients, providerConfig, model, prompt) {
  await throttleFor(providerFor(model)); // I-2: free-tier rate limit
  return callProvider(clients, providerConfig, model, prompt);
}

/**
 * Try calling each candidate model in order until one succeeds (C-5).
 * Falls back to the next candidate on 429/5xx (transient), 401/403 (auth/missing key),
 * or messages matching api_key/requires-env-var patterns.
 * Non-retryable errors (e.g. 400 bad request, parse errors) throw immediately.
 * Uses the provider abstraction for multi-provider support.
 * @param {{ gemini: object, mistral: object }} clients
 * @param {object} providerConfig - free_model_roster.providers from budget.json
 * @param {string[]} candidates - Ordered model list from router
 * @param {string} prompt
 * @returns {Promise<{ text: string, model: string }>}
 */
async function callModelWithFallback(clients, providerConfig, candidates, prompt) {
  // Inject real date so models don't hallucinate timestamps from training cutoff.
  // Gemini has written "Analysis Date: 2024-10-27" and "2026-04-14" for outputs
  // generated weeks later — the LLM anchors on file mtimes or its own prior.
  const datedPrompt =
    `Today's date is ${new Date().toISOString().slice(0, 10)} (UTC). ` +
    `Use this when writing any "Date:" or "As of:" line in your output.\n\n` +
    prompt;
  let lastError;
  const MAX_RETRIES = 2; // per candidate, before advancing to next
  for (const model of candidates) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const text = await callModelThrottled(clients, providerConfig, model, datedPrompt);
        return { text, model };
      } catch (e) {
        lastError = e;
        const status = e.status ?? e.statusCode ?? e.httpStatusCode ?? 0;
        const msg = e.message ?? "";
        const isTransient = status === 429 || (status >= 500 && status < 600) ||
            /\b(429|50[0-9]|51[0-9]|52[0-9]|53[0-9])\b/.test(msg) ||
            /timed out/i.test(msg);

        const isSkipCandidate = isTransient || status === 401 || status === 403 || /api_key|API_KEY|requires .* environment variable/i.test(msg);

        if (isTransient && attempt < MAX_RETRIES) {
          // C4.1: Exponential backoff before retrying same model
          const backoffMs = 1000 * Math.pow(2, attempt); // 1s, 2s
          console.warn(`[worker] ${model} attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${status || "timeout"}), retrying in ${backoffMs}ms`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        if (isSkipCandidate) {
          // Exhausted retries, or auth/missing key error — try next candidate
          console.warn(`[worker] ${model} failed (${status || msg}), trying next candidate`);
          break;
        }
        // Non-retryable (parse errors, bad requests) — don't try other candidates
        throw e;
      }
    }
  }
  // All candidates exhausted
  throw lastError;
}

/** Gather files for analysis tasks (audit, explore, research). */
function gatherFilesForAnalysis(projectPath, task) {
  // For audit: use git diff to find recently changed files
  try {
    const diffOutput = execFileSync("git", ["diff", "--name-only", "HEAD~5"], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (diffOutput) {
      return diffOutput.split("\n").map((relPath) => ({
        relPath,
        content: readFileSafe(resolve(projectPath, relPath), MAX_FILE_CHARS),
      })).filter((f) => f.content !== null);
    }
  } catch {
    // No git history or error — fall through
  }

  // Fallback 1: read src/ directory listing
  const fromSrc = gatherSrcFiles(projectPath, 10);
  if (fromSrc.length > 0) return fromSrc;

  // Fallback 2: scaffold docs. When a project has no src/ and no diff history
  // (greenfield scaffolds), read project-brief docs so the LLM can brainstorm
  // the next concrete step rather than skipping with no-files-to-analyze.
  return gatherScaffoldDocs(projectPath);
}

/** Gather files for codegen tasks. */
function gatherFilesForCodegen(projectPath, task) {
  // For tests-gen: find source files without corresponding test files
  // For refactor/clean: find files with potential issues
  const fromSrc = gatherSrcFiles(projectPath, 5);
  if (fromSrc.length > 0) return fromSrc;
  return gatherScaffoldDocs(projectPath);
}

/** Gather files for docs tasks. */
function gatherFilesForDocs(projectPath, task) {
  const fromSrc = gatherSrcFiles(projectPath, 8);
  if (fromSrc.length > 0) return fromSrc;
  return gatherScaffoldDocs(projectPath);
}

/**
 * Fallback: gather scaffold/brief docs when a project has no src/ and no diff.
 * Lets the LLM reason over the project's stated intent (CLAUDE.md, ROADMAP.md,
 * ai/STATE.md, etc.) instead of returning empty → no-files-to-analyze skip.
 * All candidates are pinned to known-safe relative paths inside projectPath.
 */
function gatherScaffoldDocs(projectPath) {
  const candidates = [
    "CLAUDE.md",
    "ROADMAP.md",
    "README.md",
    "DISPATCH.md",
    "ai/STATE.md",
    "docs/README.md",
  ];
  const found = [];
  for (const relPath of candidates) {
    const abs = resolve(projectPath, relPath);
    if (!isPathInside(abs, projectPath)) continue;
    if (!existsSync(abs)) continue;
    const content = readFileSafe(abs, MAX_FILE_CHARS);
    if (content !== null) found.push({ relPath, content });
  }
  return found;
}

/** Read up to N source files from the project's src/ directory. */
function gatherSrcFiles(projectPath, maxFiles) {
  const srcDir = resolve(projectPath, "src");
  if (!existsSync(srcDir)) return [];

  try {
    const lsOutput = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "src/"],
      { cwd: projectPath, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!lsOutput) return [];

    return lsOutput
      .split("\n")
      .slice(0, maxFiles)
      .map((relPath) => ({
        relPath,
        content: readFileSafe(resolve(projectPath, relPath), MAX_FILE_CHARS),
      }))
      .filter((f) => f.content !== null);
  } catch {
    return [];
  }
}

function readFileSafe(filePath, maxChars) {
  try {
    const content = readFileSync(filePath, "utf8");
    return content.length > maxChars
      ? content.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)`
      : content;
  } catch {
    return null;
  }
}

/**
 * P4: Heuristic check for balanced delimiters — catches Gemini 2.5 Flash silent truncation
 * (returns finish_reason=STOP mid-function). Only checks code-like file extensions.
 *
 * Known limitations (all fail toward false-positive, which triggers retry — safe direction):
 * - Comments: braces inside line or block comments are counted (false positive possible)
 * - Regex literals: /[{]/ braces are counted (false positive possible)
 * - Template expressions: `${expr}` — braces inside expressions are NOT counted
 *   (skipped as part of template string), so truncation mid-template-expression passes.
 *   A stack-based parser would fix this but adds complexity beyond the guard's value.
 *
 * @param {string} content - File content to validate
 * @param {string} path - File path (used to check extension)
 * @returns {boolean} true if balanced or non-code file, false if truncation detected
 */
function hasBalancedDelimiters(content, path) {
  if (!CODE_EXTENSIONS.test(path)) return true; // skip non-code files (markdown, etc.)

  let curlies = 0, squares = 0, parens = 0;
  let inString = null; // track ' " `
  let escaped = false;

  for (const ch of content) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }

    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }

    switch (ch) {
      case '"': case "'": case "`": inString = ch; break;
      case "{": curlies++; break;
      case "}": curlies--; break;
      case "[": squares++; break;
      case "]": squares--; break;
      case "(": parens++; break;
      case ")": parens--; break;
    }

    // Early exit: more closers than openers means malformed, not just truncated
    if (curlies < 0 || squares < 0 || parens < 0) return false;
  }

  // Also catch unterminated strings (truncation inside a string literal)
  return curlies === 0 && squares === 0 && parens === 0 && inString === null;
}

/** Parse LLM output into file objects. Expects FILE: path / content blocks or JSON array. */
function parseFileOutput(text) {
  // P4: shared truncation guard — returns null if any code file has unbalanced delimiters
  function validateFiles(files) {
    for (const f of files) {
      if (!hasBalancedDelimiters(f.content, f.path)) {
        console.warn(`[worker] truncation detected in ${f.path}: unbalanced delimiters`);
        return null;
      }
    }
    return files;
  }

  // Try JSON array format first: [{"path": "...", "content": "..."}]
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr) && arr.every((e) => e.path && e.content != null)) {
      return validateFiles(arr);
    }
  } catch {
    // Not JSON, try structured format
  }

  // Try fenced code blocks with file paths:
  // ```path/to/file.ts
  // content
  // ```
  const blocks = [];
  const regex = /```(\S+)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const path = match[1];
    const content = match[2];
    // Filter out obviously non-path labels like "json", "javascript", etc.
    if (path.includes("/") || path.includes("\\") || path.includes(".")) {
      blocks.push({ path, content });
    }
  }
  if (blocks.length > 0) return validateFiles(blocks);

  // Try FILE: marker format
  const fileMarkerRegex = /^FILE:\s*(.+)$/gm;
  const parts = text.split(fileMarkerRegex).slice(1); // Skip preamble
  const files = [];
  for (let i = 0; i < parts.length; i += 2) {
    const path = parts[i]?.trim();
    const content = parts[i + 1]?.trim();
    if (path && content) files.push({ path, content });
  }
  if (files.length > 0) return validateFiles(files);

  return null;
}

function writeGeneratedFiles(parsedFiles, projectPath) {
  for (const f of parsedFiles) {
    const abs = resolve(projectPath, f.path);
    // Defense-in-depth: reject any path that escapes the project directory
    if (!isPathInside(abs, projectPath)) {
      throw new Error(`path escape blocked: ${f.path}`);
    }
    ensureDir(resolve(abs, ".."));
    writeFileSync(abs, f.content);
  }
}

function revertChanges(projectPath) {
  try {
    execFileSync("git", ["checkout", "--", "."], {
      cwd: projectPath,
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Also clean untracked files that were added
    execFileSync("git", ["clean", "-fd"], {
      cwd: projectPath,
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Best effort
  }
}

const TEST_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Run tests with process-tree-safe timeout (R-2).
 * Uses spawn instead of execFileSync so we can kill the entire process tree
 * on timeout. On Windows, child processes spawned by npm don't die when the
 * parent is killed — taskkill /T /F /PID kills the tree.
 * @param {string} projectPath
 * @returns {Promise<{ pass: boolean, stdout?: string, stderr?: string }>}
 */
async function runTestsSafe(projectPath) {
  // Skip test run if project has no test script
  const pkgPath = resolve(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (!pkg.scripts?.test) return { pass: true, stdout: "(no test script)" };
    } catch { /* parse error, try running anyway */ }
  }

  return runWithTreeKill("npm", ["test"], {
    cwd: projectPath,
    env: getSafeTestEnv(),
    timeoutMs: TEST_TIMEOUT_MS,
  });
}

/**
 * Spawn a process with a hard timeout that kills the entire process tree (R-2).
 * On Windows: taskkill /T /F /PID. On POSIX: kill -9 -pid (process group).
 * Returns { pass, stdout, stderr }.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env: object, timeoutMs: number }} opts
 * @returns {Promise<{ pass: boolean, stdout: string, stderr: string }>}
 */
export function runWithTreeKill(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((res) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let killed = false;

    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Windows needs shell:true for npm (it's a .cmd file)
      shell: process.platform === "win32",
    });

    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));

    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (killed) {
        res({ pass: false, stderr: `[R-2] test killed after ${timeoutMs}ms timeout\n${stderr}`, stdout });
      } else {
        res({ pass: code === 0, stdout, stderr });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      res({ pass: false, stderr: err.message, stdout: "" });
    });
  });
}

/**
 * Kill an entire process tree by PID.
 * Windows: taskkill /T /F /PID (kills the tree).
 * POSIX: kill -9 -pid (kills the process group).
 * @param {number} pid
 */
function killProcessTree(pid) {
  try {
    if (process.platform === "win32") {
      // Async fire-and-forget: taskkill can stall under AV interception.
      // Keeping it synchronous would block the event loop up to 10s.
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: 10_000 }, () => {});
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Best effort — process may have already exited
  }
}

function getChangedFiles(projectPath) {
  try {
    const output = execFileSync("git", ["diff", "--name-only"], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      {
        cwd: projectPath,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();
    const all = [output, untracked].filter(Boolean).join("\n");
    return all ? all.split("\n") : [];
  } catch {
    return [];
  }
}

/**
 * Audit code changes using a DIFFERENT model family than generation (C-1).
 * If an explicit audit model is provided (from per-project config), use it directly.
 * Otherwise, auto-select the opposite family from the generation model.
 * @param {{ gemini: object, mistral: object }} clients
 * @param {object} providerConfig - free_model_roster.providers from budget.json
 * @param {string[]} changedFiles
 * @param {string} projectPath
 * @param {string} generationModel - The model that generated the code
 * @param {string} [explicitAuditModel] - Per-project audit model override (from route.auditModel)
 */
async function auditChanges(clients, providerConfig, changedFiles, projectPath, generationModel, explicitAuditModel) {
  if (changedFiles.length === 0) {
    return { hasCritical: false, summary: "no changes to audit" };
  }

  const fileContents = changedFiles
    .slice(0, 5) // Limit to 5 files for context budget
    .map((relPath) => {
      const content = readFileSafe(resolve(projectPath, relPath), MAX_FILE_CHARS);
      return content ? `### ${relPath}\n\`\`\`\n${content}\n\`\`\`` : null;
    })
    .filter(Boolean)
    .join("\n\n");

  const prompt = `Review these code changes for critical issues (bugs, security vulnerabilities, logic errors).

Rate each finding as LOW, MEDIUM, HIGH, or CRITICAL.

${fileContents}

Respond with JSON:
{"hasCritical": true/false, "findings": [{"file": "...", "severity": "...", "issue": "..."}], "summary": "one line"}`;

  // Resolve audit model: explicit config > auto C-1 opposite family
  let auditModel;
  if (explicitAuditModel) {
    auditModel = explicitAuditModel;
  } else {
    // C-1: Use opposite model family from generation to avoid monoculture
    const genFamily = providerFor(generationModel);
    auditModel = genFamily === "gemini" ? "mistral-large-latest" : "gemini-2.5-pro";
  }

  // C-1 safety check: warn if audit and generation use the same provider family
  const auditFamily = providerFor(auditModel);
  const genFamily = providerFor(generationModel);
  if (auditFamily === genFamily) {
    console.warn(`[audit] C-1 warning: audit (${auditModel}) and gen (${generationModel}) share provider "${auditFamily}"`);
  }

  try {
    const text = await callModelThrottled(clients, providerConfig, auditModel, prompt);

    const raw = extractJson(text);
    const result = validateAuditResponse(raw); // R-1: schema validation
    return {
      ...result,
      auditModel,
    };
  } catch (e) {
    console.warn(`[audit] error: ${e.message}`);
    return { hasCritical: false, summary: "audit-parse-error (non-fatal)" };
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildAnalysisPrompt(task, taskClass, files, projectConfig) {
  const fileBlock = files
    .map((f) => `### ${f.relPath}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const taskInstructions = {
    audit: "Review for bugs, security issues, code quality problems, and potential improvements. Rate findings by severity.",
    explore: "Explore the codebase structure and document key patterns, dependencies, and architecture decisions.",
    research: "Research the current state and identify opportunities for improvement, missing tests, or documentation gaps.",
  };

  return `You are performing an automated ${task} on the "${projectConfig.slug}" project.

## Instructions
${taskInstructions[taskClass] ?? taskInstructions.audit}

## Files
${fileBlock}

Provide a structured report with clear findings and recommendations.`;
}

function buildCodegenPrompt(task, files, projectConfig) {
  const fileBlock = files
    .map((f) => `### ${f.relPath}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const taskInstructions = {
    "tests-gen": "Generate comprehensive test files for the source files below. Use the project's existing test framework (vitest or jest). Include edge cases.",
    "add-tests": "Add missing test cases for uncovered code paths in the files below.",
    refactor: "Refactor the code below to improve readability, reduce duplication, and follow best practices. Preserve all existing behavior.",
    clean: "Clean up the code below: remove dead code, unused imports, fix lint issues, improve naming.",
  };

  return `You are performing automated ${task} on the "${projectConfig.slug}" project.

## Instructions
${taskInstructions[task] ?? "Improve the code below."}

## Source Files
${fileBlock}

## Output Format
Respond with one or more file blocks in this format:
\`\`\`path/to/file.ts
file content here
\`\`\`

Use the FULL file content (not patches). Only include files you are creating or modifying.`;
}

function buildFixPrompt(task, originalFiles, generatedFiles, stderr) {
  return `Your previous ${task} output caused test failures. Fix the issues.

## Error Output
\`\`\`
${truncate(stderr, 3000)}
\`\`\`

## Files You Generated
${generatedFiles.map((f) => `### ${f.path}\n\`\`\`\n${truncate(f.content, 5000)}\n\`\`\``).join("\n\n")}

Fix the errors and respond with corrected files in the same format:
\`\`\`path/to/file.ts
corrected content
\`\`\``;
}

function buildDocsPrompt(task, files, projectConfig) {
  const fileBlock = files
    .map((f) => `### ${f.relPath}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  return `You are performing automated ${task} on the "${projectConfig.slug}" project.

## Instructions
Generate or update documentation for the files below. Add JSDoc comments to exported functions, update README sections, or create missing documentation files as appropriate.

## Source Files
${fileBlock}

## Output Format
Respond with file blocks:
\`\`\`path/to/file.ts
full file content with documentation added
\`\`\``;
}

function truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}
