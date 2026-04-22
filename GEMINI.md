# GEMINI.md - Project Context

## Project Overview
**claude-budget-dispatcher** is a budget-aware orchestration layer for Claude Code. It allows users with Claude Max subscriptions to utilize their unused compute quota for autonomous, bounded tasks (e.g., testing, type-checking, auditing) while they are away.

The project is designed with a **decoupled architecture**:
1.  **Estimator (Node.js):** Scans Claude Code transcripts locally to estimate budget consumption vs. a target pace. This step is "free" (zero LLM cost).
2.  **Dispatcher (Gemini/Mistral/Claude):** A separate gate that only triggers when the estimator reports sufficient headroom and the user has been idle for a configurable period (default 20 mins).

### Key Technologies
- **Runtime:** Node.js (v18+)
- **Source Control:** Git (utilizing worktrees for task isolation)
- **APIs:** Anthropic (via Claude Code), Google Gemini, Mistral AI
- **Configuration:** Layered JSON (`shared.json` + `local.json` → `budget.json`) with AJV schema validation.

## Architecture & Core Components
- **`scripts/estimate-usage.mjs`**: The core math engine. Parses transcripts in `~/.claude/projects/` to compute weighted token costs and determines if dispatch is authorized.
- **`scripts/dispatch.mjs`**: The primary entry point for the direct-API dispatcher. It runs through a 5-phase pipeline: Gates → Selector → Router → Worker → Verify/Commit.
- **`scripts/lib/`**: Modularized logic for gating, project selection, model routing, and git operations.
- **`tasks/budget-dispatch.md`**: A standalone Claude-native prompt for users who prefer running the dispatcher directly through Claude Code's scheduler.
- **`docs/`**: Extensive documentation, including an `OPERATOR-GUIDE.md` and various audit logs.

## Building and Running

### Key Commands
- **Estimate Budget:** `npm run estimate` (Updates `status/usage-estimate.json`)
- **Execute Dispatch:** `npm run dispatch` (Runs the full opportunistic work pipeline)
- **Dry Run:** `node scripts/dispatch.mjs --dry-run` (Logs decisions without making changes)
- **Run Tests:** `npm run test` (Executes the `node --test` suite in `scripts/lib/__tests__`)
- **Show Status:** `npm run status` (Displays current budget and gate state)
- **Monitor Fleet:** `npm run dashboard` (Launches a local monitoring dashboard)

### Configuration
- The source of truth is `config/budget.json`. 
- Projects in rotation must have a `DISPATCH.md` file at their root defining `## Pre-Approved Tasks`.
- Kill switches: `touch config/PAUSED` or set `"paused": true` in `budget.json`.

## Development Conventions

### "Fail Closed" Philosophy
If any check (config missing, estimator error, transcript ambiguity) fails, the dispatcher must default to "do nothing." Security and budget preservation are prioritized over task execution.

### Task Isolation
Dispatched work always happens on `auto/` branches in dedicated Git worktrees. The dispatcher never pushes to origin or merges to `main` autonomously; human review is required.

### Logging & Observability
- All decisions (Success, Skip, Error) are appended to `status/budget-dispatch-log.jsonl`.
- The `last-run.json` file tracks the performance and outcome of the most recent cycle.

### Coding Style
- **Modules:** Native ES Modules (`.mjs`).
- **Safety:** Uses `Ajv` for schema validation and `gist.mjs` for distributed locking to prevent multi-machine collisions.
- **Testing:** New features should include a corresponding `.test.mjs` file in `scripts/lib/__tests__`.
