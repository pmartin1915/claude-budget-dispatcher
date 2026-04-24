# 1. Full-Pipeline Integration Testing (Mocked Providers)

**The Approach:** Use a test framework like Jest to stub out all external dependencies and file operations. In tests, call `jest.mock()` on the AI client libraries to replace their methods with no-op or dummy implementations (so no real API calls). You can also intercept any HTTP calls those SDKs make using an HTTP mocking tool like *nock*【44†L186-L192】. For the Git worktrees and commits, use an in-memory or fake filesystem (e.g. `mock-fs`) so that creating and deleting directories doesn’t touch disk【12†L284-L292】. This ensures each test runs in isolation without leaving real files behind. 

**Code Snippets:** For example, you might do: 

```js
// Mock the Google GenAI client
jest.mock('@google/genai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({
      generate: jest.fn().mockResolvedValue({ content: "mocked-genius" })
    })
  }))
}));

// Mock the Mistral client
jest.mock('@mistralai/mistralai', () => ({
  Mistral: jest.fn().mockImplementation(() => ({
    chat: { 
      complete: jest.fn().mockResolvedValue({ text: "mocked-response" }) 
    }
  }))
}));

// Mock HTTP if needed (e.g. if SDK does raw fetch internally)
const nock = require('nock');
nock('https://api.google.com')
  .post('/v1/genai')
  .reply(200, { result: "mocked-genai-result" });

// Use mock-fs to simulate git worktree directories
const mockFs = require('mock-fs');
beforeEach(() => {
  mockFs({
    '/tmp/worktrees': {
      // empty directory structure; tests can create files here
    }
  });
});
afterEach(() => {
  mockFs.restore();
});
```

This setup intercepts calls to the AI SDKs and filesystem. For example, `jest.mock('@google/genai', …)` replaces the `GoogleGenerativeAI` export so that `generate()` returns a fake result【6†L251-L259】. Meanwhile, `mock-fs` creates a virtual directory (`/tmp/worktrees`) so your code can “create” and “commit” worktrees there without touching the real disk【12†L284-L292】.

**Error Handling:** In tests, explicitly verify error paths by having mocks throw or return error codes. For instance, use `nock` to simulate a 400 response and assert that your code under test throws or handles the error appropriately. The example above uses `nock(…)…reply(400, {error:{…}})` and `await expect(...).rejects.toThrow(...)` to check error handling【44†L203-L212】. Always restore the real filesystem in a `finally` or `afterEach` so that an exception won’t leave the fake FS active. This ensures that even if a mock throws or the test fails, `mockFs.restore()` runs and no orphaned directories are left【12†L284-L292】. Any failure of the mocked APIs (e.g. network down, missing stub) should be caught by the test as a rejection, preventing hangs. 

# 2. Bulletproof Configuration & Schema Drift

**The Approach:** Load and validate configs inside a `try/catch`. Use AJV to validate `shared.json` against the schema, but on failure do **not** crash – instead capture all validation errors. Format these errors into human-readable text (for example, with the **better-ajv-errors** library) so you can log exactly what enum or field was wrong【29†L424-L432】. Send an alert (e.g. HTTP POST to your `ntfy.sh` topic) containing the detailed error message. Finally, fall back to a safe configuration: first attempt to re-load a previously saved good config (e.g. `shared.json.bak`), or if that’s not available, use a hardcoded minimal/default config. This “fail-closed” design keeps the system running on the last-known-good settings even if the new config is invalid.

**Code Snippet:** Example loader module: 

```js
const fs = require('fs');
const axios = require('axios');
const Ajv = require('ajv');
const betterAjvErrors = require('better-ajv-errors');

const SCHEMA = require('./budget.schema.json');
const ajv = new Ajv();

// Helper to send alert via ntfy.sh
async function sendAlert(message) {
  await axios.post('https://ntfy.sh/alerts', message, {
    headers: { 'Topic': 'budget-dispatcher-alerts' }
  });
}

function loadConfig() {
  let config;
  try {
    const raw = fs.readFileSync('config/shared.json', 'utf8');
    config = JSON.parse(raw);
    const valid = ajv.validate(SCHEMA, config);
    if (!valid) {
      // Format errors into actionable text
      const errorMsg = betterAjvErrors(SCHEMA, config, ajv.errors, { format: 'cli' });
      throw new Error(errorMsg);
    }
    // Save last-known-good
    fs.writeFileSync('config/shared.json.bak', JSON.stringify(config, null, 2));
    return config;
  } catch (err) {
    // Log detailed error and alert
    console.error(`Config validation failed:\n${err.message}`);
    sendAlert(`Config error on ${process.env.HOSTNAME}: ${err.message}`);
    // Fallback: try last-good, else default minimal
    try {
      const backup = fs.readFileSync('config/shared.json.bak', 'utf8');
      console.warn('Loading last-known-good config');
      return JSON.parse(backup);
    } catch {
      console.warn('Using safe default config');
      return { alerting: { on_transitions: ['down','idle','healthy'] } };
    }
  }
}
```

This code prints out a formatted AJV error (using **better-ajv-errors**) so the log might show something like “`/alerting/on_transitions should be equal to one of the allowed values: down, idle, healthy. Did you mean ‘idle’?`”【29†L424-L432】. It then posts a notification via `ntfy.sh`. If validation fails, it loads `shared.json.bak` (previous config); if that’s missing, it falls back to a minimal config with known-safe fields. 

**Error Handling:** Any parse or validation error is caught. We log the full AJV error details (with context and suggestions)【29†L424-L432】. We notify the operator via ntfy immediately. If writing/reading the backup also fails (e.g. no disk space), we catch that too and use a built-in safe defaults. This ensures the process never crashes on a schema mismatch. Upstream (cron) can detect the fallback by, e.g., an error return code or a special log entry, but the dispatcher itself will continue running on the older or default settings until the config is fixed. 

# 3. Log Rotation & Dashboard Scaling

**The Approach:** Instead of letting a single JSONL log grow unbounded (which OOMs when fully read), rotate and stream. Implement a rotation check (either on each write or via a periodic job) that does: if the log file is >5 MB *or* older than 30 days, move it to an archive (e.g. `budget-dispatch-log-YYYYMMDD.jsonl`) and start a fresh log. In Node.js you can use `fs.statSync()` to check `size` and `mtimeMs`, then `fs.renameSync()` to archive and `fs.writeFileSync()` to create a new file. 

On the API side, **never buffer the whole file in memory**. Instead, use a streaming approach with `fs.createReadStream` and pipe to the HTTP response【34†L47-L55】. This streams chunks directly and handles backpressure, so even very large logs won’t exhaust RAM. You can also implement basic pagination by reading lines with Node’s `readline` if needed, but piping is simplest for “get all logs” endpoints. 

**Code Snippet:** Example log rotation and streaming endpoint: 

```js
// Log rotation (run at startup or on each write)
function rotateLogIfNeeded(filePath) {
  const stats = fs.statSync(filePath);
  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (stats.size > MAX_SIZE || (now - stats.mtimeMs) > MAX_AGE_MS) {
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const archiveName = `budget-dispatch-log-${ts}.jsonl`;
    fs.renameSync(filePath, `./logs/archives/${archiveName}`);
    fs.writeFileSync(filePath, '');  // start fresh log
    console.log(`Rotated log to ${archiveName}`);
  }
}

// Express endpoint that streams log file
app.get('/api/logs', (req, res) => {
  const logPath = path.join(__dirname, 'status', 'budget-dispatch-log.jsonl');
  if (!fs.existsSync(logPath)) {
    return res.status(404).json({ error: 'Log not found' });
  }
  const readStream = fs.createReadStream(logPath, { encoding: 'utf8' });
  readStream.on('error', (err) => {
    console.error('Stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error reading log' });
  });
  readStream.pipe(res);
});
```

This uses `createReadStream()` which “pipes files directly to the response” and handles any size without high memory usage【34†L47-L55】. In the example we also set up an error handler: if the file is missing or a read error occurs, we log it and send a 404/500 response as appropriate.

**Error Handling:** In the rotation function, any `fs` error (e.g. disk full, permission denied) should be caught so you don’t lose data. For example, wrap `renameSync` in a try/catch and log a failure (you might simply skip rotation until next cycle). In the streaming endpoint, we check file existence and attach an `error` handler on the stream【34†L80-L84】. If streaming fails mid-transfer, we log the error and send a 500. By streaming data in chunks, even if an unexpected error occurs (like the disk becoming read-only mid-stream), only the current chunk is affected and the client sees a partial result or error – the Node process stays alive. This “O(n) fix” ensures our API endpoints never attempt to load the full log into memory, and rotated logs keep file sizes bounded. 

# 4. Distributed Locking via GitHub (Concurrency)

**The Approach:** Use the shared GitHub Gist as a simple distributed mutex. Represent the lock by a dedicated file (e.g. `lock.json`) in the gist. To **acquire** the lock, have each machine fetch the gist, check if `lock.json` exists and is recent, and if not (or if it’s stale) create/update it atomically with its own hostname and a timestamp. Use the GitHub API’s `Update a gist` endpoint with an `If-Match: <ETag>` header so that the update will fail if someone else modified the gist in the meantime – this makes the check-and-set operation atomic. To **release** the lock, call the same endpoint setting `lock.json` to `null` in the `files` payload, which deletes that file【42†L1016-L1024】. This avoids needing a separate “unlock” comment or external service.

**Code Snippet:** Pseudo-implementation using Octokit or similar:

```js
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // e.g. 10 minutes

async function acquireLock(octokit, gistId, myId) {
  const res = await octokit.gists.get({ gist_id: gistId });
  const files = res.data.files;
  const etag = res.headers.etag;
  const now = Date.now();

  // If a lock exists and is recent, do not acquire
  if (files['lock.json']) {
    const lock = JSON.parse(files['lock.json'].content);
    if (now - lock.ts < LOCK_TIMEOUT_MS) {
      return false; // still locked by someone
    }
    // stale lock: allow overwrite
  }

  const newLock = { owner: myId, ts: now };
  try {
    await octokit.gists.update({
      gist_id: gistId,
      files: { 'lock.json': { content: JSON.stringify(newLock) } },
      headers: { 'If-Match': etag }
    });
    return true; // acquired lock
  } catch (e) {
    return false; // failed (e.g. ETag mismatch -> someone else got it)
  }
}

async function releaseLock(octokit, gistId) {
  // Delete the lock file by setting it to null【42†L1016-L1024】.
  await octokit.gists.update({ gist_id: gistId, files: { 'lock.json': null } });
}
```

This code tries to create `lock.json` only if it’s safe (no current lock or an expired one). The `If-Match` header ensures the update is atomic – if another node updated the gist just before us, our update will fail (we catch that and treat it as “didn’t get lock”). To handle brief contention, simply retry a few times with backoff: e.g. loop 3 times calling `acquireLock()` with 1s→2s→4s delays until it returns true. Once a machine is done with its critical section, it calls `releaseLock()` to remove the file. (You must keep track of your own ID so you don’t accidentally release another’s lock; here we assume only the holder ever calls release.)

**Error Handling:** If the GitHub API is down or returns an error (rate-limit, network error, etc.), catch and retry a few times before giving up. If an update fails due to ETag mismatch or precondition failed, interpret that as “lost the race” and retry later. For stale locks (e.g. a machine died while holding it), our logic above will detect the timestamp aged out and allow the next acquirer to overwrite the lock. If something goes wrong during acquisition (like out-of-memory before releasing), the lock file stays in the gist. Our timeout check means another machine won’t wait forever on it. By deleting the lock file (using the `: null` technique) when releasing, we cleanly remove the lock【42†L1016-L1024】. In all cases, errors (GitHub API failures, JSON parse errors, etc.) should be logged, and the machine should safely abort its dispatch run rather than proceeding without a lock. This ensures the system always either holds a valid lock or fails benignly, never silently causing duplicate work. 

**Sources:** We used Jest’s official mocking (e.g. `jest.mock`) and HTTP intercept patterns【6†L251-L259】【44†L186-L192】, AJV error formatting best practices【29†L424-L432】, Node.js streaming docs【34†L47-L55】【34†L80-L84】, and the GitHub Gist API guide for updating/deleting files【42†L1016-L1024】 to inform these patterns. These ensure robust unit tests, clear error logs, memory-safe streaming, and atomic locks.