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
const BADGE = /^[1-9]\d*\s+Online$/;
const CHALLENGE = /^(?:Just a moment\.{0,3}|Verify you are human|Verification required|Checking your browser|Performing security verification|Enable JavaScript and cookies to continue)[.!…]?$/i;

export function parseSystemChromeBadge(text) {
  if (typeof text !== "string" || !BADGE.test(text.trim())) {
    throw new Error("The visible Online badge did not contain a valid count");
  }
  const count = Number(text.trim().match(/^\d+/)[0]);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("The online count is invalid");
  return count;
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

// This backend is restricted to a disposable GitHub-hosted cloud job. It never
// connects to an existing browser or uses a real person's profile. Chrome starts
// normally, with only an isolated profile and loopback debugging configured.
export async function readCountInSystemChrome({ timeoutMs = 60000 } = {}) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("System Chrome sampling is cloud-only and requires a GitHub Actions job");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw new Error("System Chrome timeout must be between 1 and 60000 milliseconds");
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let profile;
  let child;
  let browser;
  let page;
  let status = null;
  const sockets = { attempts: 0, closed: 0, errors: 0, receivedFrames: 0 };
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
    page.on("websocket", (socket) => {
      if (socket.url() !== ENDPOINT) return;
      sockets.attempts += 1;
      socket.on("close", () => { sockets.closed += 1; });
      socket.on("socketerror", () => { sockets.errors += 1; });
      socket.on("framereceived", () => { sockets.receivedFrames += 1; });
    });
    const response = await page.goto(SOURCE, { waitUntil: "domcontentloaded", timeout: Math.min(30000, remaining()) });
    status = response?.status() ?? null;
    const badge = page.getByText(BADGE).first();
    // Allow normal automatic page loading to finish. Do not interact with a
    // security challenge, change fingerprints, or import clearance cookies.
    await badge.waitFor({ state: "visible", timeout: remaining() });
    return parseSystemChromeBadge(await badge.innerText({ timeout: remaining() }));
  } catch (error) {
    const title = page ? await page.title().catch(() => "unavailable") : "unavailable";
    const badgeCount = page ? await page.getByText(BADGE).count().catch(() => 0) : 0;
    const reason = CHALLENGE.test(title.trim())
      ? "LeetCode still displayed a security challenge; no count was collected"
      : page ? "LeetCode did not provide a visible Online count in system Chrome" : error.message;
    throw new Error(`${reason}. Diagnostics: ${JSON.stringify({
      title: title.slice(0, 120), status, onlineBadges: badgeCount,
      webSockets: sockets, chromeExitCode: child?.exitCode ?? null,
    })}`, { cause: error });
  } finally {
    if (browser) await Promise.race([browser.close().catch(() => {}), delay(1500)]);
    await stopChrome(child);
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
  }
}
