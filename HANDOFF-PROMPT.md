# Handoff Prompt

Paste this into the next Claude Code session:

```
Resume work on claude-budget-dispatcher.

Required reading:
1. DISPATCHER-STATUS.md (dual-engine guide, scorecard, current state)
2. git log --oneline main -25
3. HANDOFF.md (Part 12 context + gotchas list at bottom)

Current state: Everything is live and working. Tray app (.exe) running,
auto mode active, both engines validated, 89 successful overnight runs.
The system works -- it just needs real projects to work ON.

Priority for this session: Add real projects to the dispatcher rotation.

The dispatcher currently bounces between two sandbox repos. Perry wants
his actual codebases improved overnight. The HANDOFF.md "what's left"
section has the full plan, but here's the short version:

1. Start with combo (already cloned at c:\Users\perry\DevProjects\combo,
   has CLAUDE.md). Check if it has DISPATCH.md; if not, create one with
   pre-approved tasks (audit, explore, tests-gen, docs-gen). Add it to
   projects_in_rotation in config/budget.json. Verify with:
   node scripts/dispatch.mjs --force --dry-run

2. Clone 2-3 more repos from github.com/pmartin1915:
   - boardbound (TypeScript, recently active)
   - shortless-ios (Swift, iOS content blocker -- Perry specifically wants iOS apps)
   - wilderness (React + TypeScript game, has Playwright tests)
   Create CLAUDE.md and DISPATCH.md for each. Add to rotation.

3. For any medical/clinical repos (medilex, ecg-wizard-pwa), set
   clinical_gate: true in the budget.json entry.

4. Verify each project dispatches before adding the next:
   node scripts/dispatch.mjs --force --dry-run

The config format for projects_in_rotation is in config/budget.example.json.
Each entry needs: slug, path (absolute), clinical_gate (bool),
opportunistic_tasks (array of task strings).

After projects are added:
- WebSocket for live dashboard updates
- Budget trend sparkline

Tools available:
- Tray app: bin\BudgetDispatcher.exe (running, green dot in tray)
- Dashboard: node scripts/dashboard.mjs (localhost:7380)
- CLI: node scripts/control.mjs
- Launcher: scripts/dashboard-launcher.cmd

Before any commit: run mcp__pal__codereview with model: "gemini-2.5-pro".
Fallback to review_validation_type: "internal" if Gemini is 503-ing.
Do NOT flip dry_run back to true. Do NOT re-enable ClaudeBudgetDispatcher.
Do NOT use gemini-3-pro-preview. Do NOT add -ForceBudget to scheduled task.
Do NOT kill BudgetDispatcher.exe unless rebuilding.
```
