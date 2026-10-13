import { chromium } from "playwright";

const SOURCE = "https://leetcode.com/problems/two-sum/description/";
const BADGE = /^[1-9]\d*\s+Online$/;
const CHALLENGE = /^(?:Just a moment\.{0,3}|Verify you are human|Verification required|Checking your browser|Performing security verification|Enable JavaScript and cookies to continue)[.!…]?$/i;

// Read the same visible badge that an anonymous visitor sees. This uses ordinary
// Chromium without saved sessions, credentials, or changes to security checks.
export async function readCountInBrowser({ timeoutMs = 60000 } = {}) {
  if (process.env.COLLECT_BROWSER_SYSTEM === "1") {
    const { readCountInSystemChrome } = await import("./system-chrome-read.mjs");
    return readCountInSystemChrome({ timeoutMs });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw new Error("Browser count timeout must be between 1 and 60000 milliseconds");
  }
  let browser;
  let page;
  let badge;
  let status = null;
  const sockets = { attempts: 0, closed: 0, errors: 0, receivedFrames: 0 };
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    browser = await chromium.launch({
      headless: process.env.COLLECT_BROWSER_HEADLESS !== "0",
      timeout: Math.min(30000, remaining()),
      ...(process.env.COLLECT_BROWSER_CHANNEL === "chrome" ? { channel: "chrome" } : {}),
    });
    const context = await browser.newContext({ locale: "en-US" });
    page = await context.newPage();
    page.setDefaultTimeout(Math.min(5000, remaining()));
    badge = page.getByText(BADGE).first();
    page.on("websocket", (socket) => {
      if (socket.url() !== "wss://collaboration-ws.leetcode.com/problems/two-sum") return;
      sockets.attempts += 1;
      socket.on("close", () => { sockets.closed += 1; });
      socket.on("socketerror", () => { sockets.errors += 1; });
      socket.on("framereceived", () => { sockets.receivedFrames += 1; });
    });
    const response = await page.goto(SOURCE, {
      waitUntil: "domcontentloaded", timeout: Math.min(30000, remaining()),
    });
    status = response?.status() ?? null;
    // A normal browser can finish the site's automatic loading checks without
    // interaction. Allow that bounded load to complete; never click a CAPTCHA,
    // alter browser security, inject clearance cookies, or evade fingerprinting.
    await badge.waitFor({ state: "visible", timeout: remaining() });
    const text = (await badge.innerText({ timeout: remaining() })).trim();
    if (!BADGE.test(text)) throw new Error("LeetCode's visible Online badge did not contain a valid count");
    const count = Number(text.match(/^\d+/)[0]);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("LeetCode's online count is invalid");
    return count;
  } catch (error) {
    // Only small, non-sensitive diagnostics are retained: no page HTML, cookies,
    // request headers, screenshots, or arbitrary console messages.
    const title = page ? await page.title().catch(() => "unavailable") : "unavailable";
    const badgeCount = page ? await page.getByText(BADGE).count().catch(() => 0) : 0;
    const reason = CHALLENGE.test(title.trim())
      ? "LeetCode still displayed a security challenge after the browser sampling window; no count was collected"
      : "LeetCode did not provide a visible Online count within the browser sampling window";
    throw new Error(`${reason}. Diagnostics: ${JSON.stringify({
      title: title.slice(0, 120), status, onlineBadges: badgeCount, webSockets: sockets,
    })}`, { cause: error });
  } finally {
    if (browser) await browser.close();
  }
}
