import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCountInCurl } from "./curl-read.mjs";

export const SOURCE = "https://leetcode.com/problems/two-sum/";
export const HISTORY = fileURLToPath(new URL("../web/data/history.json", import.meta.url));

export function validCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid online count");
  return value;
}

export function hourKey(at) {
  return new Date(Math.floor(new Date(at).getTime() / 3600000) * 3600000).toISOString();
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

export async function readSourceObservation() {
  return readCountInCurl();
}

export function validateObservation(value, now) {
  const structured = value !== null && typeof value === "object";
  const count = validCount(structured ? value.count : value);
  const capturedAt = structured ? value.capturedAt : new Date(now).toISOString();
  const observedTime = typeof capturedAt === "string" ? Date.parse(capturedAt) : NaN;
  const currentTime = new Date(now).getTime();
  if (!Number.isFinite(observedTime) || observedTime > currentTime + 1000 || currentTime - observedTime > 120000) {
    throw new Error("Invalid or stale observation time");
  }
  return { count, capturedAt: new Date(observedTime).toISOString() };
}

export async function collect({ path = HISTORY, reader = readSourceObservation, clock = () => new Date() } = {}) {
  const history = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(history.observations)) throw new Error("Invalid history file");
  if (history.observations.some((record) => record.hour === hourKey(clock()))) {
    console.log("This hour already has a genuine sample; kept it unchanged.");
    return;
  }
  // A failed read throws before any history is written. Missing hours remain
  // missing; a security challenge is never converted into an observed zero.
  const observed = await reader();
  const { count, capturedAt } = validateObservation(observed, clock());
  const { history: next, added } = appendObservation(history, count, capturedAt);
  if (!added) return;
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(temporary, path);
  console.log(JSON.stringify(next.observations[next.observations.length - 1]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collect().catch((error) => { console.error(`Collection failed: ${error.message}`); process.exitCode = 1; });
}
