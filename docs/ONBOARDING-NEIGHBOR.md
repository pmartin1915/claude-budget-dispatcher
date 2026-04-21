# "Neighbor" PC onboarding — join the free-tier dispatcher fleet

**Target:** New PC codenamed "neighbor", 16 GB RAM, standard Windows parts, low GPU.
**Starting state:** Antigravity + Claude Code installed. Nothing else.
**Estimated time:** 30–40 minutes, most of it waiting for installers.
**Result:** Neighbor runs `dispatch.mjs` every 20 min, reports to the shared status gist, Perry can see it from any machine.

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

Set git identity:

```powershell
git config --global user.name "PerryHMartin"
git config --global user.email "pmartin1913@gmail.com"
```

---

## Step 3 — Get your two API keys (free tier)

You need:
1. **GEMINI_API_KEY** — https://aistudio.google.com/app/apikey → Create API key → copy the string
2. **MISTRAL_API_KEY** — https://console.mistral.ai/api-keys → Create new key → copy the string

**Important:** these are free-tier keys, but they are **rate-limited per key**. If Perry is already running the PC + Optiplex on one shared key, adding a third machine can push you past the free-tier quotas. Safer: create a fresh API key on this machine so neighbor has its own quota bucket. Google AI Studio lets you make multiple keys under one account — that's expected.

Keep both strings ready in a Notepad window — the setup script will ask for them.

---

## Step 4 — Clone the dispatcher and run the setup script

Pick a folder to live in. This guide uses `C:\Users\<you>\DevProjects\`. Replace `<you>` with the actual Windows username on this machine.

```powershell
mkdir C:\Users\<you>\DevProjects
cd C:\Users\<you>\DevProjects
git clone https://github.com/pmartin1915/budget-dispatcher
cd budget-dispatcher
```

Then the automated setup:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-pc.ps1
```

It does: `git pull`, `npm install`, prompts for API keys, saves them to your user env vars, registers the Windows Scheduled Task `BudgetDispatcher-Node`, and fires a dry test.

When it asks for `GEMINI_API_KEY` and `MISTRAL_API_KEY`, paste the strings from Step 3.

---

## Step 5 — Create this machine's local config

The script uses `config/budget.json` which is **gitignored** (each machine has its own). Copy the template and edit:

```powershell
copy config\budget.example.json config\budget.json
notepad config\budget.json
```

In Notepad, make these changes:

1. **Add the shared gist ID.** Find the top-level `{` and add this line near the top (e.g., just after `"paused": false,`):
   ```json
   "status_gist_id": "655d02ce43b293cacdf333a301b63bbf",
   ```

2. **Minimal starter rotation.** Neighbor is fresh — start small, expand once it's proven stable. Trim `projects_in_rotation` to only:
   - `sandbox-canary-test` (smoke-test the pipeline)
   - `sandbox-biz-app` (greenfield, now produces brainstorm output via scaffold-docs fallback)
   - `sandbox-dnd-game` (greenfield)

   Delete every other entry for now.

3. **Fix the paths** in each remaining entry. Example uses `c:/Users/perry/DevProjects/...`. Change `perry` to whatever the Windows username is on this machine.

4. **Do NOT** add a `worldbuilder` entry. Perry has the real worldbuilder under active hand-authoring on his PC — no machine in the fleet should run Gemini against it.

5. **Phone alerts** — leave `alerting.enabled: false` for now. PC is already the primary alerting node. You can re-enable on neighbor later if you want.

Save and close Notepad.

Validate the JSON:

```powershell
node -e "JSON.parse(require('fs').readFileSync('config/budget.json','utf8')); console.log('config OK')"
```

---

## Step 6 — Clone the three project repos

Based on Step 5's rotation:

```powershell
mkdir C:\Users\<you>\DevProjects\sandbox
cd C:\Users\<you>\DevProjects\sandbox
git clone https://github.com/pmartin1915/extra-sub-standalone-canary-test
git clone https://github.com/pmartin1915/extra-sub-standalone-biz-app
git clone https://github.com/pmartin1915/extra-sub-standalone-dnd-game
```

Confirm paths in `config/budget.json` match where you cloned them.

---

## Step 7 — First forced run to prove it works

Back in the dispatcher repo:

```powershell
cd C:\Users\<you>\DevProjects\budget-dispatcher
node scripts\dispatch.mjs --force
```

Expected: output ends with `[dispatch] final: success` or `[dispatch] final: skipped` with a reason. Either is a valid sign the pipeline works end-to-end.

Verify neighbor is now visible in the shared gist:

```powershell
gh gist view 655d02ce43b293cacdf333a301b63bbf
```

You should see `fleet-<hostname>.json` listed (hostname = whatever `hostname` on CLI returns).

---

## Step 8 — Hand-off to the scheduler

The setup script already registered the Windows Scheduled Task. Verify:

```powershell
Get-ScheduledTask -TaskName 'BudgetDispatcher-Node' | Select-Object TaskName, State
```

State should be `Ready`. It will fire every 20 min as long as this user is logged in and the machine is awake.

**Heads-up on sleep settings:** laptops and low-power desktops often sleep aggressively. If neighbor is supposed to work overnight, confirm in **Settings → System → Power** that sleep is set to "Never" (or at least longer than your expected idle window). The scheduled task cannot fire while the machine is asleep.

---

## Step 9 — Verify Perry can see neighbor from anywhere

From Perry's PC or laptop, run:

```powershell
gh gist view 655d02ce43b293cacdf333a301b63bbf -f fleet-<neighbor-hostname>.json
```

If recent `last_run_ts` and `consecutive_errors: 0` — neighbor is in the fleet.

You can also just run `npm run monitor:watch` on any machine with the dispatcher repo cloned; it shows all machines side by side.

---

## Troubleshooting

**Setup script fails at "npm install"** — `node -v` must be ≥ 18. If older, reinstall Node LTS and retry.

**Setup script fails at "scheduled task"** — rerun PowerShell as **Administrator**, rerun `setup-pc.ps1`.

**`node scripts\dispatch.mjs --force` errors "GEMINI_API_KEY not set"** — env var didn't stick. Close all terminals, open a fresh one (PATH refreshes), retry.

**Rate limit errors (HTTP 429)** — likely sharing an API key with another machine and hitting the free-tier cap. Generate a separate API key for this machine (see Step 3 note).

**`fleet-<hostname>.json` never shows up in the gist** — confirm `status_gist_id` is set in `config/budget.json`, confirm `gh auth status` says logged in, check `status\dispatcher-runs\*.log`.

**Dispatcher always says "skipped, user-active"** — by design. Activity gate wants 20+ min of no input. Leave the machine alone and it will fire. For manual test, use `--force`.

**Pause all dispatches immediately** — `New-Item -ItemType File C:\Users\<you>\DevProjects\budget-dispatcher\config\PAUSED`. Remove the file to resume.

**Stop this machine from dispatching permanently** — `Disable-ScheduledTask -TaskName 'BudgetDispatcher-Node'` (admin PowerShell).
