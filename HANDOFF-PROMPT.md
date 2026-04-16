# Handoff Prompt

Paste this into the next Claude Code session:

```
Resume work on claude-budget-dispatcher.

Required reading:
1. DISPATCHER-STATUS.md (dual-engine guide, scorecard, current state)
2. git log --oneline main -20
3. HANDOFF.md (Part 11 context + gotchas list at bottom)

Current state: Both engines validated and live. Auto mode active via scheduled
task. System tray app exists (tray.ps1) but shows as "Windows PowerShell" in
the tray settings -- needs to be compiled into a standalone .exe so it has its
own identity ("Budget Dispatcher") and icon.

Priority for this session: Compile the tray app into a standalone .exe.

The HANDOFF.md "what's left" section has a detailed plan:
- Port tray.ps1 to a C# WinForms app (scripts/tray-app.cs, ~200 lines)
- Build with csc.exe (ships with .NET Framework, no SDK install needed)
- /target:winexe /win32icon:assets/tray-green.ico /out:bin/BudgetDispatcher.exe
- Shows as "BudgetDispatcher" in Task Manager and tray settings
- Update shell:startup shortcut to point to the .exe
- The .ico files, dashboard-launcher.cmd, and dashboard API are all ready

The existing tray.ps1 is the reference implementation -- same logic, just
rewritten in C#. Key parts: NotifyIcon, ContextMenuStrip, Timer (30s),
WebClient for GET/POST to localhost:7380, Mutex for single-instance,
Icon loading from assets/*.ico, Process.Start for Chrome.

After the .exe works:
- Add Perry's iOS apps to project rotation (github.com/pmartin1915)
- WebSocket for live dashboard updates
- Budget trend sparkline

Tools available:
- System tray icon (currently PowerShell-based, to be replaced)
- node scripts/dashboard.mjs   # web UI at localhost:7380
- node scripts/control.mjs     # interactive CLI
- scripts/dashboard-launcher.cmd  # start dashboard + open Chrome

Before any commit: run mcp__pal__codereview with model: "gemini-2.5-pro".
Fallback to review_validation_type: "internal" if Gemini is 503-ing.
Do NOT flip dry_run back to true. Do NOT re-enable ClaudeBudgetDispatcher.
Do NOT use gemini-3-pro-preview. Do NOT add -ForceBudget to scheduled task.
```
