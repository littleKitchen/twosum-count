import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect, SOURCE, validCount } from "../scripts/collect.mjs";

const observedAt = "2026-10-13T18:07:00.000Z";
const observedHour = "2026-10-13T18:00:00.000Z";

async function fixture(t, observations = []) {
  const directory = await mkdtemp(join(tmpdir(), "twosum-collector-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "history.json");
  const history = { source: SOURCE, updatedAt: null, observations };
  // Preserve deliberately noncanonical whitespace so a rewrite on a failed or
  // duplicate sample is detected even if the parsed data would look unchanged.
  const original = ` ${JSON.stringify(history)} \n`;
  await writeFile(path, original);
  return { directory, path, original };
}

test("a real zero is a valid observation and is saved", async (t) => {
  const { path } = await fixture(t);
  assert.equal(validCount(0), 0);
  await collect({ path, reader: async () => 0, clock: () => new Date(observedAt) });
  const history = JSON.parse(await readFile(path, "utf8"));
  assert.equal(history.updatedAt, observedAt);
  assert.deepEqual(history.observations, [
    { hour: observedHour, capturedAt: observedAt, count: 0 },
  ]);
});

test("invalid counts are rejected without modifying the history", async (t) => {
  const { directory, path, original } = await fixture(t);
  const invalid = [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", "123", null, undefined, false, {}];
  for (const value of invalid) {
    assert.throws(() => validCount(value), /Invalid online count/);
    await assert.rejects(
      collect({ path, reader: async () => value, clock: () => new Date(observedAt) }),
      /Invalid online count/,
    );
    assert.equal(await readFile(path, "utf8"), original);
  }
  assert.deepEqual(await readdir(directory), ["history.json"]);
});

test("a failed source read preserves the exact saved history bytes", async (t) => {
  const previous = { hour: "2026-10-13T17:00:00.000Z", capturedAt: "2026-10-13T17:07:00.000Z", count: 42 };
  const { directory, path, original } = await fixture(t, [previous]);
  await assert.rejects(
    collect({ path, reader: async () => { throw new Error("HTTP 403"); }, clock: () => new Date(observedAt) }),
    /HTTP 403/,
  );
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(directory), ["history.json"]);
});

test("a missing history file is not created with a fabricated zero", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "twosum-missing-history-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "history.json");
  let readerCalls = 0;
  await assert.rejects(
    collect({ path, reader: async () => { readerCalls += 1; return 0; }, clock: () => new Date(observedAt) }),
    { code: "ENOENT" },
  );
  assert.equal(readerCalls, 0);
  assert.deepEqual(await readdir(directory), []);
});

test("the first successful sample for an hour is immutable and skips another source read", async (t) => {
  const { path } = await fixture(t);
  let readerCalls = 0;
  await collect({
    path,
    reader: async () => { readerCalls += 1; return 128; },
    clock: () => new Date(observedAt),
  });
  const firstBytes = await readFile(path, "utf8");
  await collect({
    path,
    reader: async () => { readerCalls += 1; return 999; },
    clock: () => new Date("2026-10-13T18:59:59.000Z"),
  });
  assert.equal(readerCalls, 1);
  assert.equal(await readFile(path, "utf8"), firstBytes);
  assert.deepEqual(JSON.parse(firstBytes).observations, [
    { hour: observedHour, capturedAt: observedAt, count: 128 },
  ]);
});

test("a source response crossing an hour belongs to its capture hour", async (t) => {
  const { path } = await fixture(t);
  let now = new Date("2026-10-13T18:59:59.000Z");
  await collect({
    path,
    clock: () => now,
    reader: async () => {
      now = new Date("2026-10-13T19:00:01.000Z");
      return 67;
    },
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).observations, [
    { hour: "2026-10-13T19:00:00.000Z", capturedAt: "2026-10-13T19:00:01.000Z", count: 67 },
  ]);
});

test("an hour crossed during reading cannot replace an already saved sample", async (t) => {
  const existing = { hour: "2026-10-13T19:00:00.000Z", capturedAt: "2026-10-13T19:00:00.000Z", count: 82 };
  const { path, original } = await fixture(t, [existing]);
  let now = new Date("2026-10-13T18:59:59.000Z");
  await collect({
    path,
    clock: () => now,
    reader: async () => {
      now = new Date("2026-10-13T19:00:01.000Z");
      return 500;
    },
  });
  assert.equal(await readFile(path, "utf8"), original);
});

test("collecting after a gap appends only the current observed hour", async (t) => {
  const previous = { hour: "2026-10-13T13:00:00.000Z", capturedAt: "2026-10-13T13:07:00.000Z", count: 21 };
  const { path } = await fixture(t, [previous]);
  await collect({ path, reader: async () => 95, clock: () => new Date(observedAt) });
  const history = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(history.observations, [
    previous,
    { hour: observedHour, capturedAt: observedAt, count: 95 },
  ]);
});

test("browser shutdown crossing an hour keeps the actual observation hour", async (t) => {
  const { path } = await fixture(t);
  let now = new Date("2026-10-13T18:59:50.000Z");
  await collect({
    path, clock: () => now,
    reader: async () => {
      now = new Date("2026-10-13T19:00:03.000Z");
      return { count: 67, capturedAt: "2026-10-13T18:59:59.000Z" };
    },
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).observations, [
    { hour: observedHour, capturedAt: "2026-10-13T18:59:59.000Z", count: 67 },
  ]);
});

test("stale, missing and future source timestamps do not change saved data", async (t) => {
  const { path, original } = await fixture(t);
  for (const capturedAt of [undefined, "invalid", "2026-10-13T18:04:59.000Z", "2026-10-13T18:08:00.000Z"]) {
    await assert.rejects(collect({
      path, clock: () => new Date(observedAt), reader: async () => ({ count: 23, capturedAt }),
    }), /observation time/);
    assert.equal(await readFile(path, "utf8"), original);
  }
});
