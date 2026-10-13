import WebSocket from "ws";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

export const SOURCE = "https://leetcode.com/problems/two-sum/";
export const ENDPOINT = "wss://collaboration-ws.leetcode.com/problems/two-sum";
export const HISTORY = fileURLToPath(new URL("../web/data/history.json", import.meta.url));

export function validCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid online count");
  return value;
}

export function hourKey(at) {
  return new Date(Math.floor(new Date(at).getTime() / 3600000) * 3600000).toISOString();
}

export function readCount() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(ENDPOINT, {
      origin: "https://leetcode.com", handshakeTimeout: 15000,
      followRedirects: false, maxPayload: 1024,
    });
    let finished = false;
    const timer = setTimeout(() => finish(undefined, new Error("No online count received within 20 seconds")), 20000);
    function finish(count, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close(4000, "Hourly sample received");
      else socket.terminate();
      if (error) reject(error); else resolve(validCount(count));
    }
    socket.on("message", (data, binary) => {
      if (binary) return;
      const text = data.toString().trim();
      if (!/^\d+$/.test(text)) return;
      try { finish(validCount(Number(text))); }
      catch (error) { finish(undefined, error); }
    });
    socket.on("unexpected-response", (_request, response) => {
      const challenge = response.headers["cf-mitigated"] === "challenge" ? " (Cloudflare security challenge)" : "";
      response.resume();
      finish(undefined, new Error(`Source rejected WebSocket handshake: HTTP ${response.statusCode}${challenge}`));
    });
    socket.on("error", (error) => finish(undefined, error));
    socket.on("close", () => finish(undefined, new Error("Source closed before sending an online count")));
  });
}

export function appendObservation(history, count, capturedAt) {
  validCount(count);
  const hour = hourKey(capturedAt);
  if (!Array.isArray(history.observations)) throw new Error("Invalid history file; refusing to replace it");
  if (history.observations.some((record) => record.hour === hour)) return { history, added: false };
  const record = { hour, capturedAt: new Date(capturedAt).toISOString(), count };
  return {
    history: { source: SOURCE, updatedAt: record.capturedAt, observations: [...history.observations, record].sort((a, b) => a.hour.localeCompare(b.hour)) },
    added: true,
  };
}

export async function collect({ path = HISTORY, reader = readCount, clock = () => new Date() } = {}) {
  const history = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(history.observations)) throw new Error("Invalid history file");
  if (history.observations.some((record) => record.hour === hourKey(clock()))) {
    console.log("This hour already has a genuine sample; kept it unchanged.");
    return;
  }
  // A failed read throws before any history is written. Missing hours remain
  // missing; a security challenge is never converted into an observed zero.
  const count = validCount(await reader());
  const { history: next, added } = appendObservation(history, count, clock());
  if (!added) return;
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(temporary, path);
  console.log(JSON.stringify(next.observations[next.observations.length - 1]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collect().catch((error) => { console.error(`Collection failed: ${error.message}`); process.exitCode = 1; });
}
