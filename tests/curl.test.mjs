import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CURL_SOURCE, parseCurlObservation, readCountInCurl } from "../scripts/curl-read.mjs";

const now = new Date("2026-10-13T20:12:05.000Z");
const capturedAt = "2026-10-13T20:12:03.021Z";
const output = (patch = {}) => JSON.stringify({ count: 713, capturedAt, source: CURL_SOURCE, ...patch });

function cloud(t, enabled = true) {
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = enabled ? "true" : "false";
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  });
}

function fixedError(category) {
  return (error) => {
    assert.deepEqual(JSON.parse(error.message), { error: category });
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("curl frame observations preserve their actual timestamp and accept genuine zero", () => {
  assert.deepEqual(parseCurlObservation(output(), now), { count: 713, capturedAt });
  assert.deepEqual(parseCurlObservation(output({ count: 0 }), now), { count: 0, capturedAt });
  assert.equal(parseCurlObservation(output({ count: Number.MAX_SAFE_INTEGER }), now).count, Number.MAX_SAFE_INTEGER);
});

test("the exact official source and safe integer protocol are required", () => {
  for (const source of [undefined, null, "https://leetcode.com/problems/two-sum/", "https://leetcode.cn/problems/two-sum/description/", "https://example.com/"]) {
    assert.throws(() => parseCurlObservation(output({ source }), now), fixedError("CurlSourceInvalidOutput"));
  }
  for (const count of [undefined, null, "713", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, false, {}]) {
    assert.throws(() => parseCurlObservation(output({ count }), now), fixedError("CurlSourceInvalidOutput"));
  }
});

test("freshness boundaries allow two minutes past and one second future only", () => {
  assert.equal(parseCurlObservation(output({ capturedAt: "2026-10-13T20:10:05.000Z" }), now).count, 713);
  assert.equal(parseCurlObservation(output({ capturedAt: "2026-10-13T20:12:06.000Z" }), now).count, 713);
  for (const timestamp of ["2026-10-13T20:10:04.999Z", "2026-10-13T20:12:06.001Z"]) {
    assert.throws(() => parseCurlObservation(output({ capturedAt: timestamp }), now), fixedError("CurlSourceInvalidTimestamp"));
  }
});

test("malformed or noncanonical timestamps cannot become observations", () => {
  for (const timestamp of [null, 1791922323021, "invalid", "2026-10-13T20:12:03Z", "2026-10-13T20:12:03.021+00:00", "2026-02-30T20:12:03.021Z"]) {
    assert.throws(() => parseCurlObservation(output({ capturedAt: timestamp }), now), fixedError("CurlSourceInvalidTimestamp"));
  }
  assert.throws(() => parseCurlObservation(output(), new Date(NaN)), fixedError("CurlSourceInvalidTimestamp"));
});

test("extra output, malformed JSON, unexpected fields, and oversized output are rejected", () => {
  for (const stdout of ["", "713", "null", "[]", "not JSON", `${output()}\n${output()}`, `debug output\n${output()}`, `${output()}\ndebug output`, output({ extra: "secret" }), output({ capturedAt: undefined }), " ".repeat(4097), Buffer.from(output())]) {
    assert.throws(() => parseCurlObservation(stdout, now), fixedError("CurlSourceInvalidOutput"));
  }
  assert.deepEqual(parseCurlObservation(`${output()}\n`, now), { count: 713, capturedAt });
});

test("the adapter uses the fixed Python probe with a bounded process and stdout", async (t) => {
  cloud(t);
  let calls = 0;
  const result = await readCountInCurl({
    clock: () => now,
    execFileRunner(executable, args, options, callback) {
      calls += 1;
      assert.equal(executable, "python3");
      assert.deepEqual(args, [fileURLToPath(new URL("../scripts/probe-curl-websocket.py", import.meta.url))]);
      assert.equal(options.timeout, 40000);
      assert.equal(options.maxBuffer, 4096);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.shell, false);
      assert.equal(options.encoding, "utf8");
      callback(null, `${output()}\n`, "");
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { count: 713, capturedAt });
});

test("local calls are blocked before executing a runner, including injected options", async (t) => {
  cloud(t, false);
  let calls = 0;
  await assert.rejects(readCountInCurl({
    env: { GITHUB_ACTIONS: "true" },
    execFileRunner() { calls += 1; },
  }), fixedError("CloudOnly"));
  assert.equal(calls, 0);
});

test("process failures and timeout errors use only fixed JSON categories", async (t) => {
  cloud(t);
  for (const [error, category] of [
    [new Error("SECRET-token source request headers"), "CurlSourceProcessFailed"],
    [Object.assign(new Error("SECRET-token"), { killed: true, signal: "SIGKILL" }), "CurlSourceTimedOut"],
    [Object.assign(new Error("SECRET-token"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }), "CurlSourceOutputTooLarge"],
  ]) {
    await assert.rejects(readCountInCurl({
      clock: () => now,
      execFileRunner(_file, _args, _options, callback) { callback(error, "SECRET-token", "SECRET-token"); },
    }), fixedError(category));
  }
  await assert.rejects(readCountInCurl({ execFileRunner() { throw new Error("SECRET-token"); } }), fixedError("CurlSourceProcessFailed"));
});

test("success callbacks still reject extra stderr, invalid stdout, and stale frames safely", async (t) => {
  cloud(t);
  for (const [stdout, stderr, category] of [
    [output(), "SECRET-token", "CurlSourceInvalidOutput"],
    ["SECRET-token", "", "CurlSourceInvalidOutput"],
    [output({ capturedAt: "2026-10-13T20:10:04.999Z" }), "", "CurlSourceInvalidTimestamp"],
  ]) {
    await assert.rejects(readCountInCurl({
      clock: () => now,
      execFileRunner(_file, _args, _options, callback) { callback(null, stdout, stderr); },
    }), fixedError(category));
  }
});

test("an injected clock error cannot expose arbitrary error contents", async (t) => {
  cloud(t);
  await assert.rejects(readCountInCurl({
    clock() { throw new Error("SECRET-token"); },
    execFileRunner(_file, _args, _options, callback) { callback(null, output(), ""); },
  }), fixedError("CurlSourceInvalidOutput"));
});
