Architectural Blueprint for Autonomous Bounded-Task Dispatch Systems
Introduction and System Context
The deployment of distributed, autonomous compute nodes across disparate hardware environments presents unique challenges in state synchronization, concurrency control, fault tolerance, and memory management. The system architecture of the "budget-dispatcher" relies on decentralized coordination, utilizing a public GitHub Gist as an advisory board to manage a three-machine Windows fleet comprising perrypc, neighbor-pc, and optiplex. While avoiding a centralized relational database significantly reduces infrastructure overhead, it introduces severe vulnerabilities related to race conditions, configuration drift, and state corruption. The architecture is designed to execute bounded tasks on local Git worktrees utilizing unused AI subscription quotas, requiring precise coordination to prevent quota exhaustion and duplicate execution.
The recent incident involving perrypc, wherein a minor schema enumeration drift—specifically the introduction of the "degraded" state—caused a critical failure and a localized denial of service via a sustained exit code 2 loop, illustrates the brittleness of a strict "fail closed" paradigm. When applied without graceful degradation mechanisms, failing closed ensures safety but catastrophically impacts availability, requiring manual human intervention to restore baseline functionality. Furthermore, the existing operational telemetry poses an imminent threat to the Node.js V8 engine's memory heap limit. The memory-bound processing of unbounded JSONL append-only logs for dashboard analytics will inevitably lead to Out-Of-Memory (OOM) crashes as the operation scales.1
This comprehensive architectural report provides exhaustive implementation plans, architectural blueprints, and Node.js codebase hardening strategies across four critical vectors: full-pipeline integration testing via mocked providers, bulletproof configuration loading with graceful degradation, scaling log rotation alongside memory-efficient stream pagination, and atomic distributed locking mechanisms via GitHub's conditional HTTP headers.
1. Full-Pipeline Integration Testing (Mocked Providers)
The Approach
Unit tests alone are fundamentally insufficient for an autonomous dispatcher operating across network boundaries and interacting with local file systems. To achieve a high degree of confidence for 24/7 operations, full-pipeline integration tests must simulate the entire execution flow—from Gates and Selectors to the Router, Worker, Audit, and Commit phases—without incurring the latency, financial cost, and rate-limiting side effects of actual API calls to external providers like Google Gemini or Mistral AI.3 Furthermore, executing actual Git operations on the host file system during Continuous Integration (CI) leads to orphaned directories, polluted Git indexes, and race conditions between parallel test runners.5
The architectural solution involves Dependency Injection (DI) and network interception for HTTP requests, combined with an in-memory virtual file system to intercept the Node.js fs module operations before they write to the physical disk.7 This approach guarantees deterministic test execution, entirely isolating the system from external volatility and side effects.
The Node.js ecosystem provides modern paradigms for achieving this hermetic isolation. The @google/generative-ai SDK (and its successor @google/genai) supports custom HTTP fetcher overrides via the customFetch property within its request options, allowing the test harness to intercept outbound requests and inject predefined JSON responses.9 Concurrently, the @mistralai/mistralai SDK supports an optional fetcher argument in its HTTPClient constructor, fulfilling the same interceptor role.11
Mocking file system interactions requires the memfs library, which creates a volatile, in-memory representation of the file system. When combined with a test runner like Vitest or Jest, the native node:fs and node:fs/promises modules can be overridden to point to the memfs volume.7 Finally, mocking the simple-git module requires stubbing the factory function to intercept checkout and commit commands, bypassing the execution of local Git binaries while still tracking the payloads passed to the commit function.12


Dependency Target
	Interception Vector
	Implementation Tool
	Architectural Benefit
	Google Gemini API
	HTTP fetch override
	customFetch property 9
	Eliminates network I/O; allows deterministic simulation of API hallucinations or 429 rate limits.
	Mistral AI API
	HTTPClient constructor
	fetcher argument 11
	Grants total control over mocked LLM outputs and network timeout simulations.
	Physical Disk I/O
	node:fs/promises mock
	memfs (vol object) 7
	Guarantees zero orphaned directories; maintains an isolated, parallel-safe test state.
	Git Worktrees
	simple-git module mock
	Vitest/Jest vi.mock 12
	Bypasses local binary execution; allows assertion of commit payloads without polluting repositories.
	Code Snippets
The following implementation demonstrates how to configure a robust integration test suite utilizing Vitest to intercept the AI providers, virtualize the file system, and mock Git operations. This code represents the test setup required to validate the end-to-end pipeline.


JavaScript




import { vi, describe, it, expect, beforeEach } from 'vitest';
import { fs, vol } from 'memfs';
import { GoogleGenAI } from '@google/genai';
import { MistralClient } from '@mistralai/mistralai';
import simpleGit from 'simple-git';
import { runDispatcherPipeline } from '../src/pipeline.js';

// 1. Virtualize the entire File System using memfs 
// This intercepts all fs operations across the entire Node process.
vi.mock('node:fs', async () => {
 const memfs = await vi.importActual('memfs');
 return memfs.fs;
});
vi.mock('node:fs/promises', async () => {
 const memfs = await vi.importActual('memfs');
 return memfs.fs.promises;
});

// 2. Mock simple-git factory to prevent physical git execution 
vi.mock('simple-git', () => {
 const mockGit = {
   checkout: vi.fn().mockResolvedValue(true),
   add: vi.fn().mockResolvedValue(true),
   commit: vi.fn().mockResolvedValue({ commit: 'mock-sha-12345' }),
   push: vi.fn().mockResolvedValue(true),
   status: vi.fn().mockResolvedValue({ isClean: () => false })
 };
 // simple-git exports both default and named, so we mock the default factory 
 return { default: vi.fn(() => mockGit) };
});

describe('Full-Pipeline Integration Test: Bounded Tasks', () => {
 beforeEach(() => {
   // Reset virtual file system state before each test run to ensure idempotency
   vol.reset();
   vol.fromJSON({
     '/app/config/shared.json': JSON.stringify({ ai_quota: 'available' }),
     '/app/local/worktree/target-script.js': 'console.log("initial state");'
   });
 });

 it('should successfully execute the end-to-end pipeline using mocked AI providers', async () => {
   // 3. Custom Fetcher for Google Gemini [10]
   // Intercepts the outbound request and returns a controlled JSON structure
   const customGoogleFetch = async (url, init) => {
     return new Response(JSON.stringify({
       candidates: } }]
     }), { status: 200, headers: { 'Content-Type': 'application/json' } });
   };

   const googleAi = new GoogleGenAI({ 
     apiKey: 'test-key-do-not-use', 
     httpOptions: { customFetch: customGoogleFetch } 
   });

   // 4. Custom Fetcher for Mistral AI 
   const customMistralFetch = async (url, init) => {
     return new Response(JSON.stringify({
       choices: [{ message: { content: "Mocked Mistral Audit: Approved" } }]
     }), { status: 200, headers: { 'Content-Type': 'application/json' } });
   };

   const mistral = new MistralClient('test-key-do-not-use', { fetcher: customMistralFetch });

   // Execute the pipeline with injected, mocked dependencies
   const result = await runDispatcherPipeline({ 
       googleAi, 
       mistral, 
       worktreePath: '/app/local/worktree' 
   });

   // Assertions against the virtualized environment
   expect(result.status).toBe('success');
   expect(fs.readFileSync('/app/local/worktree/target-script.js', 'utf8')).toContain('Mocked Gemini Output');
   
   const gitInstance = simpleGit();
   expect(gitInstance.commit).toHaveBeenCalledWith(expect.stringContaining('Audit: Approved'));
 });
});

Error Handling and the Unhappy Path
The testing framework must explicitly simulate the unhappy paths to ensure the fail closed mechanism behaves predictably without halting the Node.js process permanently or leaving the system in a corrupted state. Integration tests must validate the error boundaries of the architecture.
The first critical unhappy path involves AI provider API outages, resulting in HTTP 500 or 503 errors. By modifying the customFetch mock to return new Response('Service Unavailable', { status: 503 }), the test harness can assert that the Router module successfully catches the network exception. The expected behavior is that the system logs a deterministic error to the virtualized JSONL log file, releases any acquired distributed locks, and gracefully exits the pipeline run without throwing an unhandled promise rejection that would crash the daemon.
The second scenario addresses provider rate limiting, specifically HTTP 429 Too Many Requests. The mock fetcher must be programmed to return a 429 status code accompanied by a Retry-After header. The corresponding test asserts that the system parses this header and triggers an exponential backoff sequence, rather than retrying the request in an immediate, infinite loop that would result in permanent account suspension.13
The third scenario involves local resource exhaustion, specifically a virtual disk full error (ENOSPC). The memfs volume can be artificially constrained or mocked to throw an ENOSPC error during the Git commit phase or while attempting to write the output of an LLM generation to the local worktree.7 The integration test must assert that the system detects the failed write operation, executes a rollback of the Git worktree to its pristine state via the mocked simple-git instance, and cleans up any temporary task files to prevent disk space monopolization.
Finally, the test suite must simulate extreme network latency and connection timeouts. The customFetch function can be designed to utilize a setTimeout that exceeds the AbortController signal timeout configured within the pipeline's fetch requests. This ensures that hung API calls are aggressively terminated by the Node.js runtime, preventing the worker thread from stalling indefinitely, which would otherwise hold the distributed GitHub lock until the system's eventual memory exhaustion.
2. Bulletproof Configuration & Schema Drift
The Approach
The critical incident on perrypc demonstrates the inherent systemic risk of rigid schema validation in distributed, loosely coupled systems. While validating shared.json and local.json against config/budget.schema.json via the Another JSON Schema Validator (AJV) ensures strict type safety, a blunt "crash on invalid" policy violates the core principles of high availability and autonomous operation.15 Configuration drift is inevitable in a distributed fleet where manual interventions or partial updates occur; therefore, the system must employ a "Last-Known-Good" (LKG) configuration persistence pattern.18
The proposed architecture dictates that upon successful validation of a configuration file during standard operation, the system writes a serialized, minified copy to a secure backup path (e.g., .shared.json.bak and .local.json.bak). When the primary configuration loader detects an AJV schema violation during a subsequent boot or hot-reload cycle—such as the unauthorized introduction of the enum string "degraded" into the alerting.on_transitions array—the system must explicitly catch the validation error.20 Rather than terminating the process with an exit code 2, the system must map the validation failure to a human-readable format, push a high-priority alert to the administration team via the existing ntfy.sh integration, and seamlessly downgrade to the .bak file.15
If the .bak file is also corrupted or missing, the system must fall back to a hardcoded "Safe Minimal State" to maintain the cron loop and advisory lock observation without executing external tasks.18
To parse and log AJV errors comprehensively, the integration of an error formatting library such as better-ajv-errors is required.22 Standard AJV errors provide cryptographic JSON pointer paths that are difficult to debug in a production alert.21 better-ajv-errors translates these pointers into actionable, contextual error messages indicating exactly which line and property caused the fault.22
Furthermore, the ntfy.sh integration must be optimized to ensure guaranteed delivery of the schema drift alert. The HTTP POST request to the ntfy.sh topic must utilize specific headers, including Priority: 5 (the highest priority, bypassing device silent modes) and specific tags (e.g., warning, skull) to visually differentiate the alert on the receiving mobile device.23
Failure Condition
	Immediate System Action
	Fallback Strategy
	Resulting System State
	Invalid JSON (Syntax Error)
	Emit ntfy.sh Priority 5 Alert
	Load .bak file
	Operational (Running Stale Config)
	Schema Enum Mismatch
	Log formatted better-ajv-errors
	Load .bak file
	Operational (Running Stale Config)
	.bak file missing/corrupt
	Emit ntfy.sh Priority 5 Alert
	Load Hardcoded Default
	Minimal Safe Mode (Idle/No Tasks)
	ntfy.sh network timeout
	Log error locally to JSONL
	Continue Fallback
	Operational (Degraded Telemetry)
	Code Snippets
The following Node.js module implements the bulletproof configuration loader, incorporating AJV validation, error mapping, ntfy.sh alerting, and the Last-Known-Good fallback mechanism.


JavaScript




import fs from 'node:fs/promises';
import Ajv from 'ajv';
import betterAjvErrors from 'better-ajv-errors';
import budgetSchema from '../config/budget.schema.json' assert { type: 'json' };

// Initialize AJV once for performance, enabling all errors to be collected [15, 16]
const ajv = new Ajv({ allErrors: true, useDefaults: true });
const validate = ajv.compile(budgetSchema);

export class ConfigManager {
 /**
  * Initializes the Configuration Manager with primary and fallback file paths.
  * @param {string} configPath - The path to the primary configuration file.
  * @param {string} fallbackPath - The path to the Last-Known-Good backup file.
  */
 constructor(configPath, fallbackPath) {
   this.configPath = configPath;
   this.fallbackPath = fallbackPath;
   // The ultimate fallback: prevents quota burn while keeping the daemon alive
   this.safeDefault = { 
       ai_quota: "idle", 
       alerting: { on_transitions: ["down"] } 
   };
 }

 /**
  * Attempts to load, parse, and validate the configuration file.
  * Gracefully degrades on any failure.
  * @returns {Promise<Object>} The validated configuration object.
  */
 async loadConfig() {
   try {
     const rawData = await fs.readFile(this.configPath, 'utf8');
     const parsedConfig = JSON.parse(rawData);

     // Validate against the AJV compiled schema [15, 26]
     if (!validate(parsedConfig)) {
       // Map abstract AJV errors to highly actionable strings 
       const errorOutput = betterAjvErrors(budgetSchema, parsedConfig, validate.errors, { format: 'js' });
       const errorDetails = errorOutput.map(e => e.error).join(' | ');
       
       await this.triggerAlert(`Schema Drift Detected in ${this.configPath}: ${errorDetails}`);
       return await this.loadFallbackConfig();
     }

     // Valid configuration achieved: persist as Last-Known-Good 
     // Written asynchronously to avoid blocking the return of the config
     fs.writeFile(this.fallbackPath, JSON.stringify(parsedConfig), 'utf8')
      .catch(err => console.error('Failed to persist LKG config cache:', err));
       
     return parsedConfig;

   } catch (error) {
     if (error instanceof SyntaxError) {
       await this.triggerAlert(`FATAL: JSON Syntax Error in ${this.configPath}. Parsing aborted.`);
       return await this.loadFallbackConfig();
     }
     if (error.code === 'ENOENT') {
       await this.triggerAlert(`WARNING: Config file ${this.configPath} missing.`);
       return await this.loadFallbackConfig();
     }
     throw error; // Bubble up unexpected I/O errors (e.g., hardware failure)
   }
 }

 /**
  * Loads the Last-Known-Good configuration or defaults to the Safe Minimal State.
  * @returns {Promise<Object>} The fallback configuration object.
  */
 async loadFallbackConfig() {
   try {
     const rawFallback = await fs.readFile(this.fallbackPath, 'utf8');
     console.warn('Operating on Last-Known-Good configuration backup.');
     return JSON.parse(rawFallback);
   } catch (fallbackError) {
     console.error('LKG Fallback corrupted or missing. Engaging Safe Minimal State.');
     await this.triggerAlert('CRITICAL: Using Hardcoded Safe Minimal State Configuration');
     return this.safeDefault;
   }
 }

 /**
  * Pushes a high-priority notification to the administration team via ntfy.sh.
  * @param {string} message - The error details to transmit.
  */
 async triggerAlert(message) {
   try {
     // Push via Ntfy.sh utilizing priority headers and tags [24, 25, 27]
     await fetch('https://ntfy.sh/budget_dispatch_alerts_secure', {
       method: 'POST',
       body: message,
       headers: {
         'Title': 'Budget Dispatcher Fault',
         'Priority': '5', // Max priority to bypass do-not-disturb [24]
         'Tags': 'warning,rotating_light'
       },
       signal: AbortSignal.timeout(5000) // Prevent network hangs 
     });
   } catch (netError) {
     // Catch network errors so alerting failures do not crash the configuration loader
     console.error('Failed to dispatch Ntfy.sh alert. Telemetry degraded.', netError);
   }
 }
}

Error Handling and the Unhappy Path
The design of the ConfigManager ensures that the configuration loading phase is exceptionally resilient to environmental anomalies, adhering strictly to the principle of graceful degradation.
The primary unhappy path involves strict validation failure, identically matching the perrypc incident. When the string "degraded" is detected in the alerting.on_transitions array, the ajv(parsedConfig) execution evaluates to false.21 The system immediately invokes betterAjvErrors, generating an exact JSON pointer path error (e.g., "/alerting/on_transitions/0 should be equal to one of the allowed values"). It sends this exact, highly contextual string via an HTTP POST to ntfy.sh and instantly diverts execution to load the .bak file. The Node.js process does not exit with code 2; it remains online, functioning precisely as it did prior to the unauthorized manual edit.
The second unhappy path concerns alerting failure. If the ntfy.sh service is experiencing an outage, or if the Windows machine loses outbound network connectivity, the native fetch request could hang indefinitely, stalling the configuration load process. To prevent this, an AbortSignal.timeout(5000) cancels the request after five seconds.25 The resulting AbortError is trapped by the catch (netError) block, ensuring the alert failure does not bubble up to crash the fallback initialization sequence.
The third scenario involves disk space exhaustion during the persistence of the Last-Known-Good cache. If the disk is full (ENOSPC) when the system attempts to execute fs.writeFile to update the .bak file, the promise rejection is caught asynchronously. The system logs the failure to console.error but proceeds to return the valid configuration object, allowing the machine to operate normally even when local caching is disabled by hardware constraints.
Finally, the most severe unhappy path is total configuration annihilation. If both local.json and local.json.bak are unreadable, corrupted, or deleted by a rogue process, the loadFallbackConfig method traps the secondary ENOENT or SyntaxError. The system gracefully falls back to this.safeDefault. This minimal state guarantees the dispatcher will "fail closed" functionally—executing zero AI tasks and avoiding quota waste—while remaining "open" operationally. The Node.js daemon continues to run, log its idle status, and monitor the GitHub Gist, awaiting administrative intervention to deploy a new configuration file.
3. Log Rotation & Dashboard Scaling (O(n) Fixes)
The Approach
As the fleet executes tasks eight times daily across three machines, the status/budget-dispatch-log.jsonl file grows monotonically. The existing dashboard implementation, which relies on fs.readFileSync or JSON.parse to buffer the entire file into memory on every API request (getAnalytics, getLogs), is fundamentally flawed.2 Node.js processes load this data directly into the V8 engine's heap space. By default, the V8 JavaScript engine restricts the memory heap to approximately 1.4GB to 2GB depending on the system architecture. Once the JSONL file size approaches these bounds, or if concurrent API requests trigger multiple full-file reads simultaneously, the garbage collector will fail to reclaim space, invariably resulting in a JavaScript heap out of memory crash.1
To achieve    memory consumption concerning file size, the architecture requires a rigorous, two-pronged approach centered around streaming paradigms.
First, the system must implement a rolling file appender. Unbounded append-only logs are an operational anti-pattern. The rotating-file-stream library provides an elegant solution for JSONL rotation based on both temporal boundaries (e.g., rotating every 30 days) and physical storage boundaries (e.g., archiving when the file hits 5MB).28 This rotation occurs entirely in the background, without blocking the main event loop, and can seamlessly compress archived logs using Gzip to conserve physical disk space on the Windows nodes.28
Second, the Express.js dashboard API must abandon memory buffering entirely. Instead of reading the file into a variable, it must utilize fs.createReadStream piped into the node:readline module.31 Streams in Node.js operate by reading data in chunks (typically 64KB buffers), processing it, and then discarding it, ensuring the memory footprint remains flat regardless of the total file size.1
By introducing skip and limit query parameters, the server implements highly efficient offset-based pagination at the stream level.33 The readline interface iterates asynchronously over the file. It increments a counter, discarding lines until the skip threshold is reached, then pipes the subsequent lines up to the limit directly to the HTTP response.
To provide the dashboard client with real-time, unbuffered data, the Express endpoint must respond with the application/x-ndjson (Newline Delimited JSON) content type.36 Coupled with Transfer-Encoding: chunked, this streams the data sequentially over the network. The client browser parses each JSON line as it arrives, ensuring memory pressure is mitigated on both the backend server and the frontend client.36


Implementation Strategy
	Peak Memory Profile
	Event Loop Impact
	Architectural Scalability
	fs.readFileSync (Current)
	Scales linearly (  ) with file size
	Blocks Event Loop completely
	Fails predictably at V8 heap limit (~1.4GB)
	fs.createReadStream (Proposed)
	Constant (  ) buffer (~64KB) 1
	Minimal (Yields asynchronously)
	Practically infinite capacity
	Code Snippets
The implementation is divided into two segments: the configuration of the rotating logger, and the refactored Express.js endpoint utilizing asynchronous iteration over file streams.
Part 1: The Rotating Logger Implementation


JavaScript




import { createStream } from 'rotating-file-stream';

// Configure log rotation: 5MB size limit or 30 days time limit 
// This ensures the active log file never grows large enough to impact stream initialization times.
const logStream = createStream('budget-dispatch-log.jsonl', {
 size: '5M', 
 interval: '30d', 
 compress: 'gzip', // Compress archived logs to save disk space [28]
 path: './status/'
});

/**
* Appends a structured JSON entry to the rotating log stream.
* @param {string} level - The log severity level.
* @param {string} message - The primary log message.
* @param {Object} metadata - Additional contextual data.
*/
export function logEvent(level, message, metadata = {}) {
 const logEntry = JSON.stringify({
   timestamp: new Date().toISOString(),
   level,
   message,
  ...metadata
 });
 
 // Appends to the active stream; the library handles rotation internally
 logStream.write(logEntry + '\n');
}

Part 2: The Express.js Streaming and Pagination Endpoint


JavaScript




import express from 'express';
import fs from 'node:fs';
import readline from 'node:readline';

const app = express();

/**
* GET /api/logs
* Streams paginated JSONL logs directly from disk to the network socket.
* Query Parameters:
*  - page: The page number to fetch (default: 1)
*  - limit: The number of records per page (default: 50, max: 100)
*/
app.get('/api/logs', async (req, res) => {
 // Parse pagination parameters with safe boundaries [33, 37]
 const page = Math.max(1, parseInt(req.query.page, 10) |

| 1);
 const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) |

| 50));
 const skip = (page - 1) * limit; 

 // Set headers for streamable Newline Delimited JSON and chunked transfer 
 res.setHeader('Content-Type', 'application/x-ndjson');
 res.setHeader('Transfer-Encoding', 'chunked');

 // Initialize the read stream and readline interface 
 const fileStream = fs.createReadStream('./status/budget-dispatch-log.jsonl', { encoding: 'utf8' });
 const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity }); 

 let currentLine = 0;
 let itemsSent = 0;

 // Cleanup handler: If the client aborts the request mid-stream, destroy the file handles immediately.
 req.on('close', () => {
   rl.close();
   fileStream.destroy();
 });

 try {
   // Asynchronously iterate over the file line-by-line 
   for await (const line of rl) {
     if (currentLine >= skip) {
       if (itemsSent < limit) {
         // Stream the valid JSONL string directly to the client without parsing it into an object
         res.write(line + '\n');
         itemsSent++;
       } else {
         // Pagination limit reached; aggressively close streams to conserve OS resources
         rl.close();
         fileStream.destroy();
         break;
       }
     }
     currentLine++;
   }
   
   // Terminate the HTTP response payload cleanly
   res.end(); 
 } catch (streamError) {
   console.error('Error streaming JSONL log:', streamError);
   if (!res.headersSent) {
     res.status(500).json({ error: 'Internal stream processing error' });
   } else {
     res.end(); // Terminate chunked response if headers were already sent
   }
 }
});

Error Handling and the Unhappy Path
Transitioning to a streaming architecture introduces specific edge cases regarding file handles and backpressure that must be meticulously managed.
The first unhappy path involves file permissions or disk exhaustion during the background rotation process. The rotating-file-stream library operates autonomously; if it encounters an EACCES (permission denied) or ENOSPC (disk full) error while attempting to compress or move the archived log, it emits an error event. A global listener (logStream.on('error',...)) must be attached to route this error to the ConfigManager's alerting system, pushing an emergency ntfy.sh alert. If rotation fails critically, the logger must gracefully degrade, routing output to process.stdout or a temporary memory buffer to avoid catastrophic loss of audit telemetry.
The second critical scenario is a dashboard client disconnect. If a dashboard user initiates a large paginated request and subsequently refreshes the browser or closes the tab mid-stream, the HTTP socket terminates prematurely. Without explicit handling, the Node.js createReadStream continues reading from the disk, creating hanging file descriptors. Over time, this leads to an EMFILE (too many open files) error at the operating system level, crashing the server. The architecture mitigates this by binding to the req.on('close') event, which explicitly triggers fileStream.destroy() and rl.close(), instantly releasing the OS file handles back to the pool.36
Finally, the system must handle corrupted JSONL lines. Because the stream reads text sequentially and pipes the raw string directly to the response via res.write(line + '\n'), a corrupted or half-written JSON line (e.g., resulting from a hard power loss during a write operation) will not crash the Node.js server. By intentionally bypassing JSON.parse() on the backend, the server acts purely as a dumb pipe, immunizing the backend API from bad data payloads on disk. The dashboard frontend is exclusively responsible for wrapping its JSON.parse(line) execution in a try/catch block during rendering, dropping invalid lines gracefully without disrupting the user interface.
4. Distributed Locking via GitHub (Concurrency)
The Approach
The deployment of three concurrent, autonomous nodes executing a 20-minute cron gate introduces severe and unavoidable race conditions. Because the Windows fleet uses system clocks that may drift, if multiple nodes successfully pass the time gate simultaneously, they will invariably attempt to execute the same bounded task. This leads to duplicate API consumption, corrupted local Git worktrees, and the rapid exhaustion of the shared AI subscription quotas.38
In traditional cloud deployments, this concurrency is managed by a centralized, highly available data store such as Redis (utilizing Redlock) or DynamoDB.38 However, the "budget-dispatcher" architecture relies entirely on a public GitHub Gist to act as the coordination medium, specifically to avoid the financial and maintenance overhead of a centralized database.
Attempting to implement a distributed lock by posting comments to a GitHub Issue with a specific timestamp—as suggested by initial architectural proposals—is fundamentally flawed. The GitHub Issues Comment API does not guarantee strict serialization or atomicity when multiple clients post simultaneously.40 Multiple nodes could post a comment claiming the lock at the exact same millisecond, leading to a split-brain scenario where each node believes it holds exclusive rights to the task execution.
To achieve true atomic distributed locking over an inherently asynchronous REST API, the system must employ Optimistic Concurrency Control utilizing Entity Tags (ETags) applied to the GitHub Gist API.43
When a machine requests the shared Gist via the GitHub REST API (using the @octokit/rest SDK), GitHub returns an ETag header representing the precise cryptographic hash of the resource's current version.45 To acquire a lock, the machine modifies the local JSON payload (e.g., setting lockedBy: "perrypc", status: "acquired", and expiresAt: 1713870000000) and issues a PATCH request to update the Gist. Crucially, this request must include the If-Match: <ETag> HTTP header.47
If another machine has successfully updated the Gist in the intervening milliseconds, the ETag on GitHub's servers will have changed. GitHub will enforce atomicity at its database layer, rejecting the second PATCH request with a 412 Precondition Failed HTTP status.43 This standard HTTP mechanism provides an ironclad, race-condition-free lock acquisition phase without requiring a dedicated locking server.
Furthermore, the distributed architecture must solve the "Stale Lock" dilemma. If a machine successfully acquires the lock and subsequently suffers an Out-Of-Memory (OOM) crash, a hardware failure, or an extended Garbage Collection (GC) pause 51, the lock will remain perpetually acquired on the Gist, causing a global deadlock for the entire fleet.52
To mitigate this, the lock payload must include a strict Time-To-Live (TTL) integer via an expiresAt property.13 When a peer machine fetches the Gist and encounters a locked state, it evaluates the expiresAt timestamp against the current UTC time. If the lock has expired, the peer assumes the holding node has crashed and executes a forceful acquisition, overwriting the lock ownership and resetting the TTL.54
Code Snippets
The following Node.js class implements an atomic, distributed lock utilizing the GitHub Gist API, incorporating ETag validation, stale lock recovery, and fencing token logic to manage concurrency.


JavaScript




import { Octokit } from '@octokit/rest';

// Initialize Octokit client with a valid Personal Access Token
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GIST_ID = process.env.COORDINATION_GIST_ID;

// Define the maximum execution time for a task before the lock is considered abandoned
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes 

export class DistributedGistLock {
 /**
  * Initializes the distributed lock manager for a specific node.
  * @param {string} machineId - The unique identifier of the node (e.g., "perrypc").
  */
 constructor(machineId) {
   this.machineId = machineId;
 }

 /**
  * Attempts to acquire an exclusive lock on the GitHub Gist using ETag optimistic locking.
  * @returns {Promise<boolean>} True if the lock was acquired, false otherwise.
  */
 async acquireLock() {
   try {
     // 1. Fetch current state and the associated ETag [46, 47]
     const response = await octokit.rest.gists.get({ gist_id: GIST_ID });
     const currentEtag = response.headers.etag;
     const rawContent = response.data.files['lock.json'].content;
     const lockState = JSON.parse(rawContent);

     const now = Date.now();

     // 2. Evaluate existing lock and detect Stale Locks [52, 54]
     if (lockState.locked && lockState.lockedBy!== this.machineId) {
       if (now < lockState.expiresAt) {
         console.log(`Lock actively held by ${lockState.lockedBy}. Yielding execution.`);
         return false; // Safely exit and wait for the next cron cycle
       }
       console.warn(`Detected stale lock from ${lockState.lockedBy}. Initiating recovery override.`);
       // Proceed to acquire lock; the stale lock is ignored
     }

     // 3. Prepare new lock state payload
     const newLockState = JSON.stringify({
       locked: true,
       lockedBy: this.machineId,
       acquiredAt: now,
       expiresAt: now + LOCK_TTL_MS // Define strict TTL for crash recovery [13, 53]
     });

     // 4. Attempt Atomic Update using the If-Match header [43, 44, 45, 48]
     await octokit.request('PATCH /gists/{gist_id}', {
       gist_id: GIST_ID,
       files: {
         'lock.json': { content: newLockState }
       },
       headers: {
         'If-Match': currentEtag // Instructs GitHub to reject if the ETag has changed
       }
     });

     console.log('Atomic lock acquired successfully via Gist ETag.');
     return true;

   } catch (error) {
     if (error.status === 412) {
       // 412 Precondition Failed indicates a mid-air collision. Another node won the race. [44, 50]
       console.warn('Mid-air collision detected. Lock acquired by peer machine. Yielding.');
       return false;
     }
     if (error.status === 409 |

| error.status >= 500) {
        console.error('GitHub API disruption or conflict. Failing closed to prevent corruption.');
        return false;
     }
     throw error; // Rethrow unrecognized network errors
   }
 }

 /**
  * Safely releases the lock, ensuring the node only releases a lock it still owns.
  */
 async releaseLock() {
   try {
     const response = await octokit.rest.gists.get({ gist_id: GIST_ID });
     const currentEtag = response.headers.etag;
     const lockState = JSON.parse(response.data.files['lock.json'].content);

     // Fencing token protection: Only release if this machine is still the owner [39]
     if (lockState.lockedBy!== this.machineId) {
         console.warn('Lock ownership changed. Bypassing release to prevent releasing peer lock.');
         return;
     }

     const releasedState = JSON.stringify({ locked: false, lockedBy: null, expiresAt: 0 });
     
     await octokit.request('PATCH /gists/{gist_id}', {
       gist_id: GIST_ID,
       files: { 'lock.json': { content: releasedState } },
       headers: { 'If-Match': currentEtag }
     });
     console.log('Lock released successfully.');
   } catch (err) {
       console.error('Failed to release lock cleanly. System will rely on TTL expiration.', err);
   }
 }
}

Error Handling and the Unhappy Path
The reliance on GitHub as a distributed coordination layer demands resilient error-handling methodologies to manage inevitable network latencies, API disruptions, and edge cases inherent to distributed systems programming.
The primary unhappy path is the anticipated "Mid-Air Collision." As explicitly designed, if perrypc and optiplex invoke the acquireLock() method at the exact same millisecond, they both fetch the exact same Gist payload and the exact same ETag string. Whichever machine's HTTP PATCH request traverses the network and arrives at GitHub's API gateway first will be processed successfully, instantly altering the ETag hash on the server. The trailing request, arriving milliseconds later, presents an outdated If-Match header. GitHub rejects this request with a 412 Precondition Failed error.44 The code explicitly catches error.status === 412, logs the collision, and returns false. This causes the losing node to safely yield execution, preventing duplicate AI task processing.
A significantly more complex unhappy path involves Long Garbage Collection (GC) Pauses, commonly known as a "Stop-The-World" event. In Node.js environments, heavy object allocations can trigger a V8 garbage collection cycle that freezes the entire event loop.51 If perrypc acquires a 15-minute lock but experiences severe CPU throttling or a GC freeze lasting 20 minutes, its lock will expire on the Gist. At this point, neighbor-pc observes the expired TTL, claims the lock, and begins executing tasks. If perrypc suddenly wakes up from its GC coma, finishes its original task, and attempts to invoke releaseLock(), a catastrophic state corruption could occur where it releases a lock that neighbor-pc is actively relying on.
This scenario is prevented by checking the lockedBy identity inside the releaseLock function, a paradigm known as a fencing token.39 If perrypc fetches the Gist to release its lock and observes that neighbor-pc is the current owner, it immediately aborts its cleanup operation. This guarantees that a resurrected "zombie" process cannot accidentally release an active lock held by a healthy peer.
Finally, the architecture must account for GitHub API outages. GitHub occasionally experiences 500 Internal Server Errors or applies strict rate limiting (HTTP 429) to clients. The catch block identifies error.status >= 500. In these scenarios, the system defaults to the strict "fail closed" paradigm by returning false. This means that during a GitHub outage, the entire fleet halts processing, executing zero tasks. While availability drops to zero, the integrity of the data and the AI subscription quota is perfectly preserved. To further harden this, integration with an exponential backoff library should be considered to wrap the octokit.request calls, allowing the system to seamlessly endure transient 502/503 network anomalies without completely abandoning the cron cycle.13
Works cited
1. # Why Node.js Streams Will Save Your Server's Memory - DEV Community, accessed April 23, 2026, https://dev.to/sudiip__17/-why-nodejs-streams-will-save-your-servers-memory-4ced
2. Handling Big JSON Files in Node.js Efficiently Using Streams and Workers - Medium, accessed April 23, 2026, https://medium.com/@shahzad.malik_75994/handling-big-json-files-in-node-js-efficiently-using-streams-and-workers-91722846cbfd
3. How to create integration tests medium sized, 3rd party API heavy nodejs applications?, accessed April 23, 2026, https://stackoverflow.com/questions/64737419/how-to-create-integration-tests-medium-sized-3rd-party-api-heavy-nodejs-applica
4. How to mock a dependency in a Node.js, and why you should do it. - ITNEXT, accessed April 23, 2026, https://itnext.io/how-to-mock-dependency-in-a-node-js-and-why-2ad4386f6587
5. Using Git Worktree - Adam Israel, accessed April 23, 2026, https://www.adamisrael.com/blog/using-git-worktree/
6. Git Worktrees in Use - Medium, accessed April 23, 2026, https://medium.com/ngconf/git-worktrees-in-use-f4e516512feb
7. How to mock file system with memfs in NodeJS - Stack Overflow, accessed April 23, 2026, https://stackoverflow.com/questions/74841423/how-to-mock-file-system-with-memfs-in-nodejs
8. Testing filesystem in Node.js: Please use memfs | Nerd For Tech - Medium, accessed April 23, 2026, https://medium.com/nerd-for-tech/testing-in-node-js-easy-way-to-mock-filesystem-883b9f822ea4
9. Google Generative AI Provider - AI SDK, accessed April 23, 2026, https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
10. [Feature Request] Add customFetch and customHeaders support to ChatGoogleGenerativeAI · Issue #9622 · langchain-ai/langchainjs - GitHub, accessed April 23, 2026, https://github.com/langchain-ai/langchainjs/issues/9622
11. @mistralai/mistralai - npm, accessed April 23, 2026, https://www.npmjs.com/package/@mistralai/mistralai/
12. How to properly mock simple-git library in Jest - Stack Overflow, accessed April 23, 2026, https://stackoverflow.com/questions/76176798/how-to-properly-mock-simple-git-library-in-jest
13. TimMikeladze/s3-mutex: A simple distributed locking mechanism for Node.js applications using AWS S3 as the backend storage. - GitHub, accessed April 23, 2026, https://github.com/TimMikeladze/s3-mutex
14. tzahifadida/go-pg-distributed-lock - GitHub, accessed April 23, 2026, https://github.com/tzahifadida/go-pg-distributed-lock
15. Ajv: Another JSON Schema Validator - Gricad-gitlab, accessed April 23, 2026, https://gricad-gitlab.univ-grenoble-alpes.fr/verimag/synchrone/sasa/-/tree/7-process-should-have-acess-to-their-identity/node_modules/ajv
16. Getting started - Ajv JSON schema validator, accessed April 23, 2026, https://ajv.js.org/guide/getting-started.html
17. Using AJV for schema validation with NodeJS | by Haris Zujo | NSoft - Medium, accessed April 23, 2026, https://medium.com/nsoft/using-ajv-for-schema-validation-with-nodejs-1dfef0a372f8
18. Remote Configuration in Node.js: From Basics to Production - CodeLessons, accessed April 23, 2026, https://codelessons.dev/en/remote-configuration-nodejs/
19. 10 Node.js Patterns That Make You Look Like a Pro | by Thinking Loop - Medium, accessed April 23, 2026, https://medium.com/@ThinkingLoop/10-node-js-patterns-that-make-you-look-like-a-pro-d5136a8f9124
20. ajv-errors - Ajv JSON schema validator, accessed April 23, 2026, https://ajv.js.org/packages/ajv-errors.html
21. AJV always throws error "should be an object" · Issue #690 · ajv-validator/ajv - GitHub, accessed April 23, 2026, https://github.com/ajv-validator/ajv/issues/690
22. better-ajv-errors | JSON Schema validation for Human ‍, accessed April 23, 2026, https://atlassian.github.io/better-ajv-errors/
23. ntfy.sh | Send push notifications to your phone via PUT/POST, accessed April 23, 2026, https://ntfy.sh/
24. Sending messages - ntfy docs, accessed April 23, 2026, https://docs.ntfy.sh/publish/
25. Automate Your Workflow: Effortless Notifications with ntfy.sh | by Mahmoud Bebars - Medium, accessed April 23, 2026, https://mbebars.medium.com/automate-your-workflow-effortless-notifications-with-ntfy-sh-ef2a71dac6b5
26. bunyan-rotating-file-stream - NPM, accessed April 23, 2026, https://www.npmjs.com/package/bunyan-rotating-file-stream
27. How can I rotate the file I'm writing to in node.js? - Stack Overflow, accessed April 23, 2026, https://stackoverflow.com/questions/22870141/how-can-i-rotate-the-file-im-writing-to-in-node-js
28. Streams and Buffers in Node.js — Efficiently Handling Large Files | by Ankit Anilbhai Rathod, accessed April 23, 2026, https://medium.com/@ankitrathod4596/streams-and-buffers-in-node-js-efficiently-handling-large-files-73bb7b31ee3a
29. How to read JSONL line-by-line after hitting url in Node.JS? - Stack Overflow, accessed April 23, 2026, https://stackoverflow.com/questions/73991260/how-to-read-jsonl-line-by-line-after-hitting-url-in-node-js
30. How To Use Streams | Node.js Learn, accessed April 23, 2026, https://nodejs.org/learn/modules/how-to-use-streams
31. How to Create Pagination in Node.js REST APIs - OneUptime, accessed April 23, 2026, https://oneuptime.com/blog/post/2026-01-25-pagination-nodejs-rest-apis/view
32. Building Scalable REST APIs with Pagination: From Concept to Production | by Serif Colakel, accessed April 23, 2026, https://medium.com/@serifcolakel/building-scalable-rest-apis-with-pagination-from-concept-to-production-d1ec178d9ee4
33. Server-Side Pagination with Express.js and MongoDB - DEV Community, accessed April 23, 2026, https://dev.to/michaelikoko/server-side-pagination-with-expressjs-and-mongodb-3g5i
34. Loading large amounts of data performantly using Node.js Streams - Corey Cleary, accessed April 23, 2026, https://www.coreycleary.me/loading-tons-of-data-performantly-using-node-js-streams
35. awslabs/amazon-dynamodb-lock-client: The AmazonDynamoDBLockClient is a general purpose distributed locking library built on top of DynamoDB. It supports both coarse-grained and fine-grained locking. - GitHub, accessed April 23, 2026, https://github.com/awslabs/amazon-dynamodb-lock-client
36. GitHub - kodebooth/dlock: A lease based locking implementations for distributed clients with support for a fencing token to prevent usage of stale locks., accessed April 23, 2026, https://github.com/kodebooth/dlock
37. Locking conversations - GitHub Docs, accessed April 23, 2026, https://docs.github.com/en/communities/moderating-comments-and-conversations/locking-conversations
38. Unable to post comments to a Pull Request using Github API - Stack Overflow, accessed April 23, 2026, https://stackoverflow.com/questions/53047565/unable-to-post-comments-to-a-pull-request-using-github-api
39. Stale session locks block message handling after gateway crash · Issue #4189 - GitHub, accessed April 23, 2026, https://github.com/openclaw/openclaw/issues/4189
40. 0042 Use If-Match / E-tags for optimistic locking | MilMove Developer Portal - GitHub Pages, accessed April 23, 2026, https://transcom.github.io/mymove-docs/docs/adrs/optimistic-locking/
41. What HTTP Error 412 Precondition Failed and How to Fix it? - Scrapfly Blog, accessed April 23, 2026, https://scrapfly.io/blog/posts/what-is-http-412-error-precondition-failed
42. Optimistic locking in REST Web API - GitHub Gist, accessed April 23, 2026, https://gist.github.com/47e1bc21104797e61e1d28505c6d4526
43. Which is more reliable for Github API Conditional Requests, ETag or Last-Modified?, accessed April 23, 2026, https://stackoverflow.com/questions/28060116/which-is-more-reliable-for-github-api-conditional-requests-etag-or-last-modifie
44. ETag support for the REST API · Issue #21356 - GitHub, accessed April 23, 2026, https://github.com/netbox-community/netbox/issues/21356
45. octokit/rest.js - Libraries for the REST API, accessed April 23, 2026, https://octokit.github.io/rest.js/
46. [BUG]: Octokit doesn't seem to support conditional requests using ETags #2563 - GitHub, accessed April 23, 2026, https://github.com/octokit/octokit.js/issues/2563
47. When is it appropriate to respond with a HTTP 412 error? - Stack Overflow, accessed April 23, 2026, https://stackoverflow.com/questions/5369480/when-is-it-appropriate-to-respond-with-a-http-412-error
48. Distributed Lock Failure: How Long GC Pauses Break Concurrency : r/programming - Reddit, accessed April 23, 2026, https://www.reddit.com/r/programming/comments/1pege3b/distributed_lock_failure_how_long_gc_pauses_break/
49. How to do distributed locking - Martin Kleppmann, accessed April 23, 2026, https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
50. DistributedLock/docs/DistributedLock.MongoDB.md at master · madelson/DistributedLock - GitHub, accessed April 23, 2026, https://github.com/madelson/DistributedLock/blob/master/docs/DistributedLock.MongoDB.md
51. Ruby implementation of a distributed lock based on Google Cloud Storage - GitHub, accessed April 23, 2026, https://github.com/FooBarWidget/distributed-lock-google-cloud-storage-ruby
52. Handling 412 Precondition Failed and 428 Precondition Required Errors in SAP APIs Using ETag - SAP Community, accessed April 23, 2026, https://community.sap.com/t5/technology-blog-posts-by-sap/handling-412-precondition-failed-and-428-precondition-required-errors-in/ba-p/13558022