import { chromium } from "playwright";

const SOURCE = "https://leetcode.com/problems/two-sum/description/";
const BADGE = /^[1-9]\d*\s+Online$/;
const CHALLENGE = /^(?:Just a moment\.{0,3}|Verify you are human|Verification required|Checking your browser|Performing security verification|Enable JavaScript and cookies to continue)[.!…]?$/i;

// Read the same visible badge that an anonymous visitor sees. This uses ordinary
// Chromium without saved sessions, credentials, or changes to security checks.
export async function readCountInBrowser({ timeoutMs = 60000 } = {}) {
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
    browser = await chromium.launch({ headless: true, timeout: Math.min(30000, remaining()) });
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
    if (CHALLENGE.test((await page.title()).trim())) {
      throw new Error("LeetCode displayed a security challenge; no count was collected");
    }

    const challenge = page.getByText(CHALLENGE).first();
    const result = await Promise.race([
      badge.waitFor({ state: "visible", timeout: remaining() }).then(() => "count"),
      challenge.waitFor({ state: "visible", timeout: remaining() }).then(() => "challenge"),
    ]);
    if (result === "challenge") {
      throw new Error("LeetCode displayed a security challenge; no count was collected");
    }
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
    const reason = /security challenge/.test(error.message)
      ? error.message
      : "LeetCode did not provide a visible Online count within the browser sampling window";
    throw new Error(`${reason}. Diagnostics: ${JSON.stringify({
      title: title.slice(0, 120), status, onlineBadges: badgeCount, webSockets: sockets,
    })}`, { cause: error });
  } finally {
    if (browser) await browser.close();
  }
}
