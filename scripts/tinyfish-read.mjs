import { chromium } from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseSystemChromeBadge, hasFreshMatchingFrame } from "./system-chrome-read.mjs";

export const TINYFISH_API = "https://api.browser.tinyfish.ai";
const SOURCE = "https://leetcode.com/problems/two-sum/description/";
const ENDPOINT = "wss://collaboration-ws.leetcode.com/problems/two-sum";
const BADGE = /^\d+\s+Online$/;

// This reads only the official page's visible badge and matching push frame.
// Attaching before navigation avoids treating an existing, stale DOM as proof.
export async function readVerifiedRemoteBadge(page, { deadline, clock = Date.now, sleep = delay } = {}) {
  const remaining = () => Math.max(1, deadline - clock());
  let latestFrame = null;
  const removeSocketListeners = [];
  const onSocket = (socket) => {
    if (socket.url() !== ENDPOINT) return;
    const onFrame = ({ payload }) => {
      if (typeof payload !== "string" || !/^\d+$/.test(payload)) return;
      const count = Number(payload);
      if (!Number.isSafeInteger(count) || count < 0) return;
      latestFrame = { count, receivedAt: clock(), socket };
    };
    const onClose = () => { if (latestFrame?.socket === socket) latestFrame = null; };
    socket.on("framereceived", onFrame);
    socket.on("close", onClose);
    removeSocketListeners.push(() => {
      socket.removeListener("framereceived", onFrame);
      socket.removeListener("close", onClose);
    });
  };
  page.on("websocket", onSocket);
  try {
    if (!Number.isFinite(deadline) || deadline <= clock()) throw new Error("The remote sampling window expired");
    await page.goto(SOURCE, { waitUntil: "domcontentloaded", timeout: Math.min(30000, remaining()) });
    const badge = page.getByText(BADGE).first();
    await badge.waitFor({ state: "visible", timeout: remaining() });
    while (clock() < deadline) {
      if (await badge.isVisible()) {
        try {
          const count = parseSystemChromeBadge(await badge.innerText({ timeout: Math.min(500, remaining()) }));
          const capturedMs = clock();
          if (hasFreshMatchingFrame(count, latestFrame, capturedMs)) {
            return { count, capturedAt: new Date(capturedMs).toISOString() };
          }
        } catch {
          if (page.isClosed()) break;
        }
      }
      await sleep(Math.min(100, remaining()));
    }
    throw new Error("The visible Online badge did not agree with a fresh official WebSocket count");
  } finally {
    page.removeListener("websocket", onSocket);
    for (const remove of removeSocketListeners) remove();
  }
}

function safeHttpStatus(response) {
  return Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
    ? ` (HTTP ${response.status})` : "";
}

async function terminateSession(sessionId, apiKey, fetcher, sleep) {
  const retryable = new Set([409, 429, 500, 503, 504]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetcher(`${TINYFISH_API}/${encodeURIComponent(sessionId)}`, {
        method: "DELETE", headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Transport errors may contain the API key or a session URL. Retain none.
      if (attempt === 2) return false;
      await sleep(250 * (attempt + 1));
      continue;
    }
    if (response.status === 204) return true;
    if (!retryable.has(response.status) || attempt === 2) return false;
    const retryAfter = response.headers?.get?.("Retry-After");
    const retryMs = /^\d+(?:\.\d+)?$/.test(retryAfter ?? "") ? Number(retryAfter) * 1000 : 250 * (attempt + 1);
    // Do not retry early when the provider requests a longer cooling-off period.
    if (!Number.isFinite(retryMs) || retryMs > 3000) return false;
    await sleep(retryMs);
  }
  return false;
}

// Optional remote backend, selected only by explicit COLLECT_PROVIDER=tinyfish.
// One session uses the documented provider transport and receives no personal
// browser state, cookies, fingerprint changes, or local browser process.
export async function readCountInTinyFish({
  timeoutMs = 90000,
  withTimestamp = false,
  env = process.env,
  fetcher = fetch,
  connect = (url, options) => chromium.connectOverCDP(url, options),
  readBadge = readVerifiedRemoteBadge,
  clock = Date.now,
  sleep = delay,
} = {}) {
  if (env.GITHUB_ACTIONS !== "true") throw new Error("TinyFish sampling is cloud-only and requires a GitHub Actions job");
  const apiKey = env.TINYFISH_API_KEY;
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("TINYFISH_API_KEY is required for the optional remote browser");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60000 || timeoutMs > 90000) {
    throw new Error("TinyFish sampling timeout must be between 60000 and 90000 milliseconds");
  }
  const deadline = clock() + timeoutMs;
  const remaining = () => Math.max(1, deadline - clock());
  let sessionId;
  let browser;
  let result;
  let failure;
  let cleanupConfirmed = true;
  let stage = "Remote browser session creation could not be confirmed";
  try {
    // Creation is never retried: an unknown outcome could create extra paid
    // sessions. This inactivity limit is a fallback, not a wall-clock guarantee.
    const response = await fetcher(TINYFISH_API, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ url: SOURCE, timeout_seconds: Math.ceil(timeoutMs / 1000) }),
      signal: AbortSignal.timeout(Math.min(60000, remaining())),
    });
    if (response.status !== 201) {
      stage = `Remote browser session creation failed${safeHttpStatus(response)}`;
      throw new Error(stage);
    }
    const session = await response.json();
    if (typeof session?.session_id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(session.session_id)) {
      sessionId = session.session_id;
    }
    if (!sessionId) throw new Error(stage);
    stage = "The remote browser did not provide a valid connection";
    const cdpUrl = new URL(session.cdp_url);
    if (cdpUrl.protocol !== "wss:") throw new Error(stage);
    if (clock() >= deadline) throw new Error(stage);
    browser = await connect(session.cdp_url, { timeout: Math.min(15000, remaining()), noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error(stage);
    stage = "The remote browser did not provide a fresh verified Online count";
    const page = context.pages()[0] ?? await context.newPage();
    const observation = await readBadge(page, { deadline, clock, sleep });
    const capturedMs = typeof observation?.capturedAt === "string" ? Date.parse(observation.capturedAt) : NaN;
    const nowMs = clock();
    if (!Number.isSafeInteger(observation?.count) || observation.count < 0 || !Number.isFinite(capturedMs)
      || capturedMs > nowMs || nowMs - capturedMs > 10000) throw new Error(stage);
    result = { count: observation.count, capturedAt: new Date(capturedMs).toISOString() };
  } catch {
    // Never propagate an upstream error, body, CDP URL, key, or raw cause.
    failure = new Error(stage);
  } finally {
    if (sessionId) {
      try { cleanupConfirmed = await terminateSession(sessionId, apiKey, fetcher, sleep); }
      catch { cleanupConfirmed = false; }
    }
    if (browser) {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => browser.close()).catch(() => {}),
          new Promise((resolve) => { timer = setTimeout(resolve, 1500); }),
        ]);
      } finally { clearTimeout(timer); }
    }
  }
  if (!cleanupConfirmed) {
    const message = "Remote browser termination could not be confirmed; its inactivity timeout remains configured";
    throw new Error(failure ? `${failure.message}; ${message}` : message);
  }
  if (failure) throw failure;
  return withTimestamp ? result : result.count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readCountInTinyFish({ withTimestamp: true }).then((observation) => console.log(JSON.stringify(observation)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
