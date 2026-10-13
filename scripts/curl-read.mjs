import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CURL_SOURCE = "https://leetcode.com/problems/two-sum/description/";
const PROBE = fileURLToPath(new URL("./probe-curl-websocket.py", import.meta.url));
const MAX_OUTPUT_BYTES = 4096;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Only fixed categories leave this boundary. Process errors and output can
// include request details; neither is attached to the returned Error.
function failure(category) {
  return new Error(JSON.stringify({ error: category }));
}

export function parseCurlObservation(stdout, now = new Date()) {
  let value;
  try {
    if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
      throw new Error();
    }
    value = JSON.parse(stdout);
  } catch {
    throw failure("CurlSourceInvalidOutput");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "capturedAt,count,source"
    || value.source !== CURL_SOURCE
    || !Number.isSafeInteger(value.count) || value.count < 0) {
    throw failure("CurlSourceInvalidOutput");
  }

  const timestamp = typeof value.capturedAt === "string" && UTC_TIMESTAMP.test(value.capturedAt)
    ? Date.parse(value.capturedAt) : NaN;
  const currentTime = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(timestamp) || !Number.isFinite(currentTime)
    || new Date(timestamp).toISOString() !== value.capturedAt
    || currentTime - timestamp > 120000 || timestamp - currentTime > 1000) {
    throw failure("CurlSourceInvalidTimestamp");
  }
  // Preserve frame receipt time, rather than the later process cleanup time.
  return { count: value.count, capturedAt: value.capturedAt };
}

export async function readCountInCurl({ execFileRunner = execFile, clock = () => new Date() } = {}) {
  // This guard is independent of dependency injection. The normal runtime
  // never calls the cloud probe from a developer's local machine.
  if (process.env.GITHUB_ACTIONS !== "true") throw failure("CloudOnly");

  return new Promise((resolve, reject) => {
    try {
      execFileRunner("python3", [PROBE], {
        timeout: 40000,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          const category = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "CurlSourceOutputTooLarge"
            : error.killed && error.signal === "SIGKILL" ? "CurlSourceTimedOut" : "CurlSourceProcessFailed";
          reject(failure(category));
          return;
        }
        if (typeof stderr !== "string" || stderr.trim() !== "") {
          reject(failure("CurlSourceInvalidOutput"));
          return;
        }
        try { resolve(parseCurlObservation(stdout, clock())); }
        catch (invalid) {
          // The parser uses fixed categories. Keep a faulty injected clock's
          // arbitrary exception from escaping this same process boundary.
          const safe = ["CurlSourceInvalidOutput", "CurlSourceInvalidTimestamp"]
            .some((category) => invalid instanceof Error && invalid.message === JSON.stringify({ error: category }));
          reject(safe ? invalid : failure("CurlSourceInvalidOutput"));
        }
      });
    } catch {
      reject(failure("CurlSourceProcessFailed"));
    }
  });
}
