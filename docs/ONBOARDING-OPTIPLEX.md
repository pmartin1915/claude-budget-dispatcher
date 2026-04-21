# Optiplex onboarding — join the free-tier dispatcher fleet

**Target:** Perry's Optiplex, 16 GB RAM, standard Windows parts, low GPU.
**Starting state:** Antigravity + Claude Code installed. Nothing else.
**Estimated time:** 30–40 minutes, most of it waiting for installers.
**Result:** Optiplex runs `dispatch.mjs` every 20 min, reports to the shared status gist, PC Perry can see it from laptop.

---

## Step 1 — Install the three missing tools

Open PowerShell as **Administrator** (Start → type "powershell" → right-click → Run as administrator), then run each of these. Accept defaults when prompted.

```powershell
winget install --id OpenJS.NodeJS.LTS --silent
winget install --id Git.Git --silent
winget install --id GitHub.cli --silent
```

Close PowerShell and reopen it (normal, not admin this time) so the new PATH entries take effect. Verify:

```powershell
node -v    # should show v20.x or higher
git --version
gh --version
```

If any of those error with "not recognized", restart the machine — winget sometimes needs a reboot for PATH.

---

## Step 2 — Authenticate with GitHub

```powershell
gh auth login
```

Answer the prompts:
- **What account?** → GitHub.com
- **Protocol?** → HTTPS
- **Authenticate Git with your GitHub credentials?** → Yes
- **How would you like to authenticate?** → Login with a web browser

It shows an 8-character code. Copy it, press Enter, Chrome opens, paste the code, authorize. Done.

Set your git identity:

```powershell
git config --global user.name "PerryHMartin"
git config --global user.email "pmartin1913@gmail.com"
```

---

## Step 3 — Get your two API keys (free tier)

You need:
1. **GEMINI_API_KEY** — https://aistudio.google.com/app/apikey → Create API key → copy the string
2. **MISTRAL_API_KEY** — https://console.mistral.ai/api-keys → Create new key → copy the string

Keep both strings ready in a Notepad window — the setup script will ask for them.

---

## Step 4 — Clone the dispatcher and run the setup script

Pick a folder you want to live in. This guide uses `C:\Users\<you>\DevProjects\`. Replace `<you>` with your actual Windows username.

```powershell
mkdir C:\Users\<you>\DevProjects
cd C:\Users\<you>\DevProjects
git clone https://github.com/pmartin1915/budget-dispatcher
cd budget-dispatcher
```

Then run the automated setup. It does: `git pull`, `npm install`, prompts for API keys and saves them to your user env vars, registers the Windows Scheduled Task, and fires a dry test.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-pc.ps1
```

When it asks for `GEMINI_API_KEY` and `MISTRAL_API_KEY`, paste the strings from Step 3.

---

## Step 5 — Create this machine's local config

The setup script uses `config/budget.json` which is **gitignored** (each machine has its own). Copy the template and edit it:

```powershell
copy config\budget.example.json config\budget.json
notepad config\budget.json
```

In Notepad, make these changes:

1. **Add the shared gist ID.** Find the top-level `{` and add this line near the top (e.g., just after `"paused": false,`):
   ```json
   "status_gist_id": "655d02ce43b293cacdf333a301b63bbf",
   ```

2. **Trim `projects_in_rotation` to what this machine should work on.** Delete entries you don't want. For initial Optiplex, a safe starter set is:
   - `sandbox-canary-test` (keep — pipeline smoke test)
   - `sandbox-biz-app` (keep — greenfield scaffold, produces brainstorm output)
   - `sandbox-game-adventure` (keep — greenfield scaffold)
   - Remove everything else for now — you can add back later once Optiplex is producing clean cycles.

3. **Fix the paths** in each remaining entry. The example file uses `c:/Users/perry/DevProjects/...`. Change `perry` to your actual Windows username.

4. **Do NOT** add a `worldbuilder` entry. Perry has the real worldbuilder under active hand-authoring on the PC and Gemini must not touch it.

5. **Optional — share phone alerts.** If you want Optiplex alerts to go to the same phone, copy the `alerting` block from PC's `C:\Users\perry\DevProjects\budget-dispatcher\config\budget.json` (topic + enabled: true). Otherwise leave it disabled — PC already alerts.

Save and close Notepad.

Validate the JSON is still well-formed:

```powershell
node -e "JSON.parse(require('fs').readFileSync('config/budget.json','utf8')); console.log('config OK')"
```

---

## Step 6 — Clone the project repos the dispatcher will work on

Based on the rotation in Step 5, clone these into `C:\Users\<you>\DevProjects\sandbox\`:

```powershell
mkdir C:\Users\<you>\DevProjects\sandbox
cd C:\Users\<you>\DevProjects\sandbox
git clone https://github.com/pmartin1915/extra-sub-standalone-canary-test
git clone https://github.com/pmartin1915/extra-sub-standalone-biz-app
git clone https://github.com/pmartin1915/extra-sub-standalone-game-adventure
```

Confirm paths in `config/budget.json` match where you cloned them.

---

## Step 7 — First forced run to prove it works

Back in the dispatcher repo:

```powershell
cd C:\Users\<you>\DevProjects\budget-dispatcher
node scripts\dispatch.mjs --force
```

This bypasses the idle-user gate and runs one cycle immediately. Expected output ends with `[dispatch] final: success` or `[dispatch] final: skipped` with a valid reason. Either one proves the pipeline works end-to-end.

Verify the machine is now visible in the shared gist:

```powershell
gh gist view 655d02ce43b293cacdf333a301b63bbf
```

You should see `fleet-<hostname>.json` listed for this machine (hostname will be whatever `hostname` returns on the command line).

---

## Step 8 — Hand-off to the scheduler

The setup script already registered the Windows Scheduled Task. Verify:

```powershell
Get-ScheduledTask -TaskName 'BudgetDispatcher-Node' | Select-Object TaskName, State
```

State should be `Ready`. It will fire every 20 min as long as you're logged in and the machine is not sleeping.

---

## Step 9 — Tell Perry it's live

From any machine with `gh` authenticated:

```powershell
gh gist view 655d02ce43b293cacdf333a301b63bbf -f fleet-<optiplex-hostname>.json
```

If you see recent `last_run_ts` and `consecutive_errors: 0`, it's working.

---

## Troubleshooting

**Setup script fails at "npm install"** — check `node -v` is ≥ 18. If older, reinstall Node LTS and retry.

**Setup script fails at "scheduled task"** — re-run PowerShell as **Administrator**, rerun `setup-pc.ps1`.

**`node scripts\dispatch.mjs --force` errors "GEMINI_API_KEY not set"** — env var didn't stick. Close all terminals, open a fresh one (PATH refreshes from the registry), retry.

**`gh auth status` says "not logged in"** on a terminal where it worked before — gh token lives in `%LOCALAPPDATA%\GitHub CLI\`; ensure you're logged in as the same Windows user who ran `gh auth login`.

**`fleet-<hostname>.json` never shows up in the gist** — confirm `status_gist_id` is set in `config/budget.json`, confirm the dispatcher user has `gh` auth, check `status\dispatcher-runs\*.log` for upload errors.

**Dispatcher always says "skipped, user-active"** — by design. The activity gate wants 20+ min of no keyboard/mouse. Leave the machine alone and it will fire. For a manual test, use `node scripts\dispatch.mjs --force` (bypasses that gate only; does not bypass budget).

**Want to pause all dispatches** — `New-Item -ItemType File C:\Users\<you>\DevProjects\budget-dispatcher\config\PAUSED`. Remove the file to resume.
