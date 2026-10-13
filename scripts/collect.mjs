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

export function retentionCutoff(at) {
  const cutoff = new Date(at);
  if (!Number.isFinite(cutoff.getTime())) throw new Error("Invalid retention reference time");
  const day = cutoff.getUTCDate();
  // Move from day one to avoid JavaScript rolling a short target month into
  // the next month. Keep the UTC time, then clamp the original calendar day.
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  const lastDay = new Date(cutoff);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  cutoff.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return cutoff.toISOString();
}

function pruneHistory(history, now) {
  const cutoff = Date.parse(retentionCutoff(now));
  const observations = history.observations.filter((record) => {
    const timestamp = typeof record?.capturedAt === "string" ? Date.parse(record.capturedAt) : NaN;
    if (!Number.isFinite(timestamp)) throw new Error("Invalid history observation time; refusing to prune it");
    // Use the actual sample time so records earlier in the cutoff's hour do
    // not extend retention beyond six calendar months.
    return timestamp >= cutoff;
  });
  const removed = observations.length !== history.observations.length;
  return { history: removed ? { ...history, observations } : history, removed };
}

async function saveHistory(path, history) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(history, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}

export function appendObservation(history, count, capturedAt) {
  validCount(count);
  const hour = hourKey(capturedAt);
  if (!Array.isArray(history.observations)) throw new Error("Invalid history file; refusing to replace it");
  if (history.observations.some((record) => record.hour === hour)) return { history, added: false };
  const record = { hour, capturedAt: new Date(capturedAt).toISOString(), count };
  return {
    history: { ...history, source: SOURCE, updatedAt: record.capturedAt, observations: [...history.observations, record].sort((a, b) => a.hour.localeCompare(b.hour)) },
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
  const startedAt = clock();
  const initial = pruneHistory(history, startedAt);
  if (initial.history.observations.some((record) => record.hour === hourKey(startedAt))) {
    if (initial.removed) await saveHistory(path, initial.history);
    console.log("This hour already has a genuine sample; kept it unchanged.");
    return;
  }
  let observation;
  let finishedAt;
  try {
    const observed = await reader();
    finishedAt = clock();
    observation = validateObservation(observed, finishedAt);
  } catch (error) {
    // Failure still remains visible to the caller. Only expired observations
    // may be removed; retained samples and their metadata stay unchanged.
    const expired = pruneHistory(history, clock());
    if (expired.removed) await saveHistory(path, expired.history);
    throw error;
  }
  const retained = pruneHistory(history, finishedAt);
  const { history: next, added } = appendObservation(retained.history, observation.count, observation.capturedAt);
  if (!added && !retained.removed) return;
  await saveHistory(path, next);
  if (added) console.log(JSON.stringify(next.observations.find((record) => record.hour === hourKey(observation.capturedAt))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collect().catch((error) => { console.error(`Collection failed: ${error.message}`); process.exitCode = 1; });
}
