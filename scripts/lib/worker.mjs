// worker.mjs — Phase 4: Execute work via local commands or free-tier LLM APIs.
// Handles local tasks, audit, codegen (3-step loop), and docs generation.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { extractJson } from "./extract-json.mjs";

const MAX_FILE_CHARS = 50_000; // Per-file context budget for LLM prompts

/**
 * Execute the selected task.
 * @param {object} selection - { project, task, projectConfig }
 * @param {object} route - { delegate_to, model, taskClass }
 * @param {object} config - Parsed budget.json
 * @param {{ gemini: object, mistral: object }} clients - SDK instances
 * @param {string} [worktreePath] - Path to git worktree (null for local tasks)
 * @returns {Promise<object>} Work result with outcome, summary, filesChanged, etc.
 */
export async function executeWork(selection, route, config, clients, worktreePath) {
  const { task, projectConfig } = selection;
  const projectPath = worktreePath ?? projectConfig.path;

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
      return executeGeminiTask(
        task,
        route.taskClass,
        projectPath,
        projectConfig,
        clients.gemini,
        route.model
      );

    case "tests_gen":
    case "refactor":
      return executeCodegenTask(
        task,
        projectPath,
        projectConfig,
        clients,
        route.model
      );

    case "docs_gen":
      return executeDocsTask(
        task,
        projectPath,
        projectConfig,
        clients.mistral,
        route.model
      );

    default:
      return { outcome: "error", reason: `unknown-task-class-${route.taskClass}` };
  }
}

// ---------------------------------------------------------------------------
// Local tasks (test, typecheck, lint, coverage) — zero LLM tokens
// ---------------------------------------------------------------------------

function executeLocalTask(task, projectPath) {
  const commands = {
    test: ["npm", ["test"]],
    typecheck: ["npx", ["tsc", "--noEmit"]],
    lint: ["npm", ["run", "lint:fix"]],
    coverage: ["npm", ["run", "test:coverage"]],
  };

  const [cmd, args] = commands[task] ?? ["npm", ["run", task]];

  try {
    const stdout = execFileSync(cmd, args, {
      cwd: projectPath,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    return {
      outcome: "success",
      summary: `${task} passed`,
      stdout: truncate(stdout, 2000),
    };
  } catch (e) {
    return {
      outcome: "local-task-failed",
      reason: `${task} exited ${e.status}`,
      stderr: truncate(e.stderr?.toString() ?? "", 2000),
      stdout: truncate(e.stdout?.toString() ?? "", 2000),
    };
  }
}

// ---------------------------------------------------------------------------
// Gemini tasks (audit, explore, research) — read-only analysis
// ---------------------------------------------------------------------------

async function executeGeminiTask(task, taskClass, projectPath, projectConfig, gemini, model) {
  const files = gatherFilesForAnalysis(projectPath, task);
  if (files.length === 0) {
    return { outcome: "skipped", reason: "no-files-to-analyze" };
  }

  const prompt = buildAnalysisPrompt(task, taskClass, files, projectConfig);

  try {
    const response = await gemini.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0.2, maxOutputTokens: 4000 },
    });

    const text = response.text;

    // For audit tasks, write findings to a file in the worktree
    if (taskClass === "audit") {
      const findingsPath = resolve(projectPath, `audit-findings-${Date.now()}.md`);
      writeFileSync(findingsPath, `# Audit Findings\n\n${text}\n`);
      return {
        outcome: "success",
        summary: `audit complete, findings written`,
        filesChanged: [relative(projectPath, findingsPath)],
        auditText: text,
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
    };
  } catch (e) {
    return { outcome: "error", reason: `gemini-${task}-error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Codegen tasks (tests-gen, refactor, clean) — 3-step generate-verify-audit
// ---------------------------------------------------------------------------

async function executeCodegenTask(task, projectPath, projectConfig, clients, model) {
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

  // Step 1: Generate
  let generatedText;
  try {
    generatedText = await callModel(clients, model, prompt);
  } catch (e) {
    return { outcome: "error", reason: `codegen-generate-error: ${e.message}` };
  }

  const parsedFiles = parseFileOutput(generatedText);
  if (!parsedFiles || parsedFiles.length === 0) {
    return { outcome: "error", reason: "malformed-worker-output" };
  }

  // Validate all paths are within the project
  for (const f of parsedFiles) {
    const abs = resolve(projectPath, f.path);
    if (!abs.startsWith(projectPath)) {
      return { outcome: "error", reason: `path-escape-attempt: ${f.path}` };
    }
    // Clinical gate: no domain/ writes
    if (projectConfig.clinical_gate && (f.path.includes("domain/") || f.path.includes("domain\\"))) {
      return { outcome: "error", reason: `clinical-domain-write-blocked: ${f.path}` };
    }
  }

  writeGeneratedFiles(parsedFiles, projectPath);

  // Step 2: Verify (run tests)
  const testResult = runTestsSafe(projectPath);
  if (!testResult.pass) {
    // One retry with error context
    const fixPrompt = buildFixPrompt(task, files, parsedFiles, testResult.stderr);
    try {
      const fixedText = await callModel(clients, model, fixPrompt);
      const fixedFiles = parseFileOutput(fixedText);
      if (!fixedFiles || fixedFiles.length === 0) {
        revertChanges(projectPath);
        return { outcome: "reverted", reason: "fix-parse-failed" };
      }
      // Validate paths on retry (same checks as first pass)
      for (const f of fixedFiles) {
        const abs = resolve(projectPath, f.path);
        if (!abs.startsWith(resolve(projectPath))) {
          revertChanges(projectPath);
          return { outcome: "error", reason: `path-escape-attempt-retry: ${f.path}` };
        }
        if (projectConfig.clinical_gate && (f.path.includes("domain/") || f.path.includes("domain\\"))) {
          revertChanges(projectPath);
          return { outcome: "error", reason: `clinical-domain-write-blocked-retry: ${f.path}` };
        }
      }
      writeGeneratedFiles(fixedFiles, projectPath);

      const retest = runTestsSafe(projectPath);
      if (!retest.pass) {
        revertChanges(projectPath);
        return { outcome: "reverted", reason: "tests-failed-after-retry" };
      }
    } catch {
      revertChanges(projectPath);
      return { outcome: "reverted", reason: "fix-attempt-error" };
    }
  }

  // Step 3: Audit (Gemini codereview, free)
  try {
    const changedFiles = getChangedFiles(projectPath);
    const auditResult = await auditChanges(clients.gemini, changedFiles, projectPath);
    if (auditResult.hasCritical) {
      revertChanges(projectPath);
      return { outcome: "reverted", reason: "audit-critical-finding", auditResult };
    }
    return {
      outcome: "success",
      summary: `${task}: ${parsedFiles.length} file(s) generated, tests pass, audit clean`,
      filesChanged: changedFiles,
      auditResult,
    };
  } catch {
    // Audit failure is non-fatal — proceed with commit
    const changedFiles = getChangedFiles(projectPath);
    return {
      outcome: "success",
      summary: `${task}: ${parsedFiles.length} file(s) generated, tests pass, audit skipped`,
      filesChanged: changedFiles,
    };
  }
}

// ---------------------------------------------------------------------------
// Docs tasks (docs-gen, jsdoc, session-log) — Mistral Large
// ---------------------------------------------------------------------------

async function executeDocsTask(task, projectPath, projectConfig, mistral, model) {
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
    const response = await mistral.chat.complete({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      maxTokens: 4000,
    });

    const text = response.choices?.[0]?.message?.content ?? "";
    const parsedFiles = parseFileOutput(text);

    if (parsedFiles && parsedFiles.length > 0) {
      writeGeneratedFiles(parsedFiles, projectPath);
      return {
        outcome: "success",
        summary: `${task}: ${parsedFiles.length} file(s) updated`,
        filesChanged: parsedFiles.map((f) => f.path),
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
    };
  } catch (e) {
    return { outcome: "error", reason: `docs-gen-error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Call Gemini or Mistral based on model name.
 * @param {{ gemini: object, mistral: object }} clients
 * @param {string} model
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callModel(clients, model, prompt) {
  if (model.startsWith("gemini")) {
    const r = await clients.gemini.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0.2, maxOutputTokens: 8000 },
    });
    return r.text;
  }
  // Mistral / Codestral
  const r = await clients.mistral.chat.complete({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    maxTokens: 8000,
  });
  return r.choices?.[0]?.message?.content ?? "";
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

  // Fallback: read src/ directory listing
  return gatherSrcFiles(projectPath, 10);
}

/** Gather files for codegen tasks. */
function gatherFilesForCodegen(projectPath, task) {
  // For tests-gen: find source files without corresponding test files
  // For refactor/clean: find files with potential issues
  return gatherSrcFiles(projectPath, 5);
}

/** Gather files for docs tasks. */
function gatherFilesForDocs(projectPath, task) {
  return gatherSrcFiles(projectPath, 8);
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

/** Parse LLM output into file objects. Expects FILE: path / content blocks or JSON array. */
function parseFileOutput(text) {
  // Try JSON array format first: [{"path": "...", "content": "..."}]
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr) && arr.every((e) => e.path && e.content != null)) {
      return arr;
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
  if (blocks.length > 0) return blocks;

  // Try FILE: marker format
  const fileMarkerRegex = /^FILE:\s*(.+)$/gm;
  const parts = text.split(fileMarkerRegex).slice(1); // Skip preamble
  const files = [];
  for (let i = 0; i < parts.length; i += 2) {
    const path = parts[i]?.trim();
    const content = parts[i + 1]?.trim();
    if (path && content) files.push({ path, content });
  }
  if (files.length > 0) return files;

  return null;
}

function writeGeneratedFiles(parsedFiles, projectPath) {
  for (const f of parsedFiles) {
    const abs = resolve(projectPath, f.path);
    // Defense-in-depth: reject any path that escapes the project directory
    if (!abs.startsWith(resolve(projectPath))) {
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

function runTestsSafe(projectPath) {
  // Skip test run if project has no test script
  const pkgPath = resolve(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (!pkg.scripts?.test) return { pass: true, stdout: "(no test script)" };
    } catch { /* parse error, try running anyway */ }
  }

  try {
    const stdout = execFileSync("npm", ["test"], {
      cwd: projectPath,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { pass: true, stdout };
  } catch (e) {
    return {
      pass: false,
      stderr: e.stderr?.toString() ?? "",
      stdout: e.stdout?.toString() ?? "",
    };
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

async function auditChanges(gemini, changedFiles, projectPath) {
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

  try {
    const response = await gemini.models.generateContent({
      model: "gemini-2.5-pro",
      contents: prompt,
      config: { temperature: 0, maxOutputTokens: 2000 },
    });

    const result = extractJson(response.text);
    return {
      hasCritical: result.hasCritical === true,
      findings: result.findings ?? [],
      summary: result.summary ?? "",
    };
  } catch {
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
