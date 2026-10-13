import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SOURCE = "https://leetcode.com/problems/two-sum/description/";
const ENDPOINT = "wss://collaboration-ws.leetcode.com/problems/two-sum";
const DOCUMENT_ENDPOINT = "https://collaboration-ws.leetcode.com/problems/two-sum";
const BADGE = /^\d+\s+Online$/;
const MAX_FRAME_AGE_MS = 10000;
const CHALLENGE = /^(?:Just a moment\.{0,3}|Verify you are human|Verification required|Checking your browser|Performing security verification|Enable JavaScript and cookies to continue)[.!…]?$/i;

export function parseSystemChromeBadge(text) {
  if (typeof text !== "string" || !BADGE.test(text.trim())) {
    throw new Error("The visible Online badge did not contain a valid count");
  }
  const count = Number(text.trim().match(/^\d+/)[0]);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("The online count is invalid");
  return count;
}

export function hasFreshMatchingFrame(count, frame, nowMs) {
  return !!frame && Number.isSafeInteger(count) && count >= 0 && frame.count === count
    && Number.isFinite(frame.receivedAt) && Number.isFinite(nowMs)
    && frame.receivedAt <= nowMs && nowMs - frame.receivedAt <= MAX_FRAME_AGE_MS;
}

async function installedChrome() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
        .filter(Boolean).map((directory) => join(directory, "Google", "Chrome", "Application", "chrome.exe"))
      : ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; }
    catch { /* Check the next normal installation location. */ }
  }
  throw new Error("An installed Google Chrome executable was not found in its normal location");
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForChrome(endpoint, child, launchError, deadline) {
  while (Date.now() < deadline) {
    if (launchError.value) throw new Error("System Google Chrome could not start", { cause: launchError.value });
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("System Google Chrome exited before its debugging endpoint was ready");
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* Chrome is still starting; no external requests are retried. */ }
    await delay(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  throw new Error("System Google Chrome's loopback debugging endpoint did not become ready");
}

async function stopChrome(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(1000)]);
  }
}

export function publicSourcePreview(text, maximumLength = 500) {
  if (typeof text !== "string") return "";
  if (/cloudflare|captcha|verify you are human|checking your browser|challenge-platform/i.test(text)) {
    return "[security challenge content omitted]";
  }
  // The anonymous endpoint is public, but even diagnostics should not retain
  // script source or anything resembling credentials/challenge tokens.
  if (/<script\b|\b(?:token|cookie|authorization|password|secret|csrf|session|nonce|bearer|signature)\b/i.test(text)
    || /[A-Za-z0-9_+\/-]{32,}/.test(text)) return "[credential-like or script content omitted]";
  const limit = Number.isInteger(maximumLength) ? Math.min(500, Math.max(0, maximumLength)) : 500;
  return text.replace(/[^\x20-\x7E\r\n\t]/g, "?").replace(/\s+/g, " ").trim().slice(0, limit);
}

async function warmupSourceDocument(page, deadline, diagnosticsEnabled) {
  const result = { initialStatus: null, finalStatus: null, title: "", challengeRemained: false, navigationFailed: false };
  let latestResponse = null;
  const onResponse = (response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()
      && response.url().split("?")[0] === DOCUMENT_ENDPOINT) {
      latestResponse = response;
      result.finalStatus = response.status();
    }
  };
  page.on("response", onResponse);
  try {
    const response = await page.goto(DOCUMENT_ENDPOINT, {
      waitUntil: "domcontentloaded", timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
    }).catch(() => { result.navigationFailed = true; return null; });
    result.initialStatus = response?.status() ?? null;
    while (Date.now() < deadline) {
      const title = await page.title().catch(() => null);
      if (title === null) {
        await delay(Math.min(500, Math.max(1, deadline - Date.now())));
        continue;
      }
      result.title = title.slice(0, 120);
      result.challengeRemained = CHALLENGE.test(result.title.trim())
        || await page.getByText(CHALLENGE).first().isVisible().catch(() => false);
      if (result.finalStatus === 400 || result.finalStatus === 404 || !result.challengeRemained) break;
      // Only the site's own normal document scripts run. No interactions or
      // clearance-cookie extraction, transfers, injection, or persistence occur.
      await delay(Math.min(500, Math.max(1, deadline - Date.now())));
    }
    if (diagnosticsEnabled && latestResponse?.status() === 200) {
      const contentType = await latestResponse.headerValue("content-type").catch(() => null);
      result.contentType = (contentType ?? "unknown").split(";")[0].trim().slice(0, 80);
      const challengeMarker = await latestResponse.headerValue("cf-mitigated").catch(() => null);
      result.cloudflareChallenge = challengeMarker === "challenge";
      if (!result.cloudflareChallenge && !result.challengeRemained) {
        // Browsers render text/JSON documents in their body as well. Read only
        // visible text; do not copy HTML, scripts, response headers, or cookies.
        const text = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
        result.publicBodyPreview = publicSourcePreview(text, /html/i.test(result.contentType) ? 300 : 500);
      }
    }
    return result;
  } finally {
    page.removeListener("response", onResponse);
  }
}

// This backend is restricted to a disposable GitHub-hosted cloud job. It never
// connects to an existing browser or uses a real person's profile. Chrome starts
// normally, with only an isolated profile and loopback debugging configured.
export async function readCountInSystemChrome({
  timeoutMs = process.env.COLLECT_BROWSER_WARMUP === "1" ? 90000 : 60000,
  withTimestamp = false,
} = {}) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("System Chrome sampling is cloud-only and requires a GitHub Actions job");
  }
  const warmupEnabled = process.env.COLLECT_BROWSER_WARMUP === "1";
  const diagnosticsEnabled = process.env.COLLECT_SOURCE_DIAGNOSTICS === "1";
  const maximumTimeout = warmupEnabled ? 90000 : 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumTimeout) {
    throw new Error(`System Chrome timeout must be between 1 and ${maximumTimeout} milliseconds`);
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let profile;
  let child;
  let browser;
  let networkSession;
  let page;
  let status = null;
  let latestNumericFrame = null;
  let warmup = null;
  const handshakes = [];
  const sockets = { attempts: 0, closed: 0, errors: 0, receivedFrames: 0, lastErrors: [] };
  const launchError = { value: null };
  try {
    const executable = await installedChrome();
    profile = await mkdtemp(join(tmpdir(), "twosum-cloud-chrome-"));
    const port = await availableLoopbackPort();
    child = spawn(executable, [
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { stdio: "ignore", shell: false });
    child.on("error", (error) => { launchError.value = error; });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForChrome(endpoint, child, launchError, Math.min(deadline, Date.now() + 15000));
    browser = await chromium.connectOverCDP(endpoint, { timeout: Math.min(15000, remaining()), noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("System Chrome did not expose its isolated browser context");
    page = context.pages().find((candidate) => candidate.url() === "about:blank") ?? await context.newPage();
    page.setDefaultTimeout(Math.min(5000, remaining()));
    if (diagnosticsEnabled) {
      networkSession = await context.newCDPSession(page);
      const officialRequestIds = new Set();
      networkSession.on("Network.webSocketCreated", ({ requestId, url }) => {
        if (url === ENDPOINT) officialRequestIds.add(requestId);
      });
      networkSession.on("Network.webSocketHandshakeResponseReceived", ({ requestId, response }) => {
        if (!officialRequestIds.has(requestId)) return;
        const markerKey = Object.keys(response.headers ?? {}).find((key) => key.toLowerCase() === "cf-mitigated");
        handshakes.push({ status: response.status, cloudflareChallenge: markerKey !== undefined && response.headers[markerKey] === "challenge" });
        if (handshakes.length > 5) handshakes.shift();
      });
      networkSession.on("Network.webSocketClosed", ({ requestId }) => officialRequestIds.delete(requestId));
      await networkSession.send("Network.enable");
    }
    if (warmupEnabled) warmup = await warmupSourceDocument(page, Math.min(deadline, Date.now() + 30000), diagnosticsEnabled);
    const sourceDeadline = Math.min(deadline, Date.now() + 60000);
    const sourceRemaining = () => Math.max(1, sourceDeadline - Date.now());
    page.on("websocket", (socket) => {
      if (socket.url() !== ENDPOINT) return;
      sockets.attempts += 1;
      socket.on("close", () => {
        sockets.closed += 1;
        if (latestNumericFrame?.socket === socket) latestNumericFrame = null;
      });
      socket.on("socketerror", (message) => {
        sockets.errors += 1;
        const text = String(message);
        const status = text.match(/Unexpected response code:\s*(\d{3})/i);
        const networkCode = text.match(/net::ERR_[A-Z_]+/);
        // Extract only protocol status/error identifiers. Arbitrary error text
        // could contain source data, so it is never copied into job logs.
        const safeError = status ? `WebSocket response HTTP ${status[1]}`
          : networkCode ? networkCode[0] : "Official WebSocket connection error";
        sockets.lastErrors = [...sockets.lastErrors, safeError].slice(-2);
      });
      socket.on("framereceived", ({ payload }) => {
        sockets.receivedFrames += 1;
        if (typeof payload !== "string" || !/^\d+$/.test(payload)) return;
        const count = Number(payload);
        if (!Number.isSafeInteger(count) || count < 0) return;
        latestNumericFrame = { count, receivedAt: Date.now(), socket };
      });
    });
    const response = await page.goto(SOURCE, { waitUntil: "domcontentloaded", timeout: Math.min(30000, sourceRemaining()) });
    status = response?.status() ?? null;
    const badge = page.getByText(BADGE).first();
    // Allow normal automatic page loading to finish. Do not interact with a
    // security challenge, change fingerprints, or import clearance cookies.
    await badge.waitFor({ state: "visible", timeout: sourceRemaining() });
    // The DOM can briefly lag a newer frame. Wait for agreement rather than
    // rejecting a normal render race or accepting a disconnected, stale badge.
    while (Date.now() < sourceDeadline) {
      if (await badge.isVisible()) {
        try {
          const count = parseSystemChromeBadge(await badge.innerText({ timeout: Math.min(500, sourceRemaining()) }));
          const capturedMs = Date.now();
          if (hasFreshMatchingFrame(count, latestNumericFrame, capturedMs)) {
            const capturedAt = new Date(capturedMs).toISOString();
            return withTimestamp ? { count, capturedAt } : count;
          }
        } catch (error) {
          // The matching badge can disappear during a render or reconnect. All
          // attempts still share the original bounded sampling deadline.
          if (page.isClosed()) throw error;
        }
      }
      await delay(Math.min(100, sourceRemaining()));
    }
    throw new Error("The visible Online badge did not agree with a fresh official WebSocket count");
  } catch (error) {
    const title = page ? await page.title().catch(() => "unavailable") : "unavailable";
    const badgeCount = page ? await page.getByText(BADGE).count().catch(() => 0) : 0;
    const reason = CHALLENGE.test(title.trim())
      ? "LeetCode still displayed a security challenge; no count was collected"
      : page ? "LeetCode did not provide a visible Online count in system Chrome" : error.message;
    throw new Error(`${reason}. Diagnostics: ${JSON.stringify({
      title: title.slice(0, 120), status, onlineBadges: badgeCount,
      webSockets: sockets, chromeExitCode: child?.exitCode ?? null,
      ...(warmupEnabled ? { warmup } : {}),
      ...(diagnosticsEnabled ? { officialWebSocketHandshakes: handshakes } : {}),
    })}`, { cause: error });
  } finally {
    if (browser) await Promise.race([browser.close().catch(() => {}), delay(1500)]);
    await stopChrome(child).catch(() => {});
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }).catch(() => {});
  }
}
