# Deep Research Mission: Dispatcher Metacognition & Autonomous Self-Repair

## System Context
You are analyzing a decentralized, autonomous "budget dispatcher" fleet running on multiple Windows PCs. 
- **Tech Stack:** Node.js (ESM), JavaScript, Git, GitHub REST/GraphQL APIs (via Octokit), `isolated-vm` for sandboxing.
- **AI Integration:** Direct calls to Google GenAI (Gemini) and Mistral free-tier APIs. 
- **Fleet Coordination:** Nodes coordinate using a centralized GitHub Gist containing `heartbeat.json`, `pending-merges.json`, and locking mechanisms.
- **Current Hardening:** The system has strict gate checks, AST mutation validation, `isolated-vm` execution for untrusted code, and a `sentinel.mjs` script that detects dead nodes and requeues tasks.

## The Mission
Your goal is to architect and propose a comprehensive design for a **Metacognition & Self-Repair Layer**. The dispatcher must be able to reflect on its own long-term performance, detect catastrophic out-of-band failures, and autonomously write code to fix itself when it crashes.

### Objective 1: Metacognitive Log Review (Self-Reflection)
Currently, the dispatcher outputs a rich JSONL log (`status/budget-dispatch-log.jsonl`) and generates PRs, but it lacks persistent memory of its historical success rates across runs.
- **Task:** Design a lightweight, zero-cost pipeline where the dispatcher analyzes its own recent logs and PR diffs. It must calculate an internal "confidence score" or "drift metric" to detect if it is caught in a loop, repeatedly generating bad code, or subtly degrading in quality over time.

### Objective 2: Out-of-Band Fault Detection (The Watcher)
If the Node.js dispatcher process crashes entirely (e.g., an unhandled exception, config corruption, or V8 engine crash), `sentinel.mjs` will flag the node as dead, but it cannot physically restart or fix the local machine.
- **Task:** Research and propose a free, highly reliable "Watcher" program. This could be a lightweight local Windows Service, a secondary isolated daemon, or a free-tier cloud hook (like a GitHub Actions cron job). It must detect when the host dispatcher has permanently died or the fleet has stalled.

### Objective 3: Autonomous Self-Repair Cascade
Once the Watcher detects a fatal crash, it must automatically initiate a fix without human intervention.
- **Task:** Design a workflow where the Watcher extracts the fatal stack trace and recent logs, and feeds them into a fresh LLM instance (Gemini/Mistral). 
- The LLM must be given access to read the broken source file, synthesize a patch, apply it directly to the file system or push a hotfix PR, and then forcefully restart the dispatcher service.
- **Safety Boundary:** Define explicit safeguards to prevent the self-repair cascade from permanently destroying the codebase or creating an infinite crash-loop if the LLM hallucinates a bad fix.

## Deliverables Required
1. A formal Architecture Decision Record (ADR) detailing how the Metacognition memory and Watcher components will be structured within the existing fleet topology.
2. A technical step-by-step implementation plan covering the out-of-band Watcher, the LLM patch-generation loop, and the rollback safety mechanisms.
3. Recommendations for the most cost-effective (free) and robust technologies to use for the Watcher service on Windows environments.
