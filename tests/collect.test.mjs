import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect, retentionCutoff, SOURCE, validCount } from "../scripts/collect.mjs";

const observedAt = "2026-10-13T18:07:00.000Z";
const observedHour = "2026-10-13T18:00:00.000Z";

async function fixture(t, observations = [], metadata = {}) {
  const directory = await mkdtemp(join(tmpdir(), "twosum-collector-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "history.json");
  const history = { source: SOURCE, updatedAt: null, ...metadata, observations };
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

test("six-month retention uses UTC calendar months and clamps month-end dates", () => {
  for (const [now, expected] of [
    ["2026-10-13T18:07:00.123Z", "2026-04-13T18:07:00.123Z"],
    ["2024-08-31T23:59:59.999Z", "2024-02-29T23:59:59.999Z"],
    ["2025-08-31T23:59:59.999Z", "2025-02-28T23:59:59.999Z"],
    ["2026-03-31T12:00:00.000Z", "2025-09-30T12:00:00.000Z"],
    ["2026-01-31T12:00:00.000Z", "2025-07-31T12:00:00.000Z"],
    ["2024-02-29T12:00:00.000Z", "2023-08-29T12:00:00.000Z"],
    ["2026-11-01T01:30:00-08:00", "2026-05-01T09:30:00.000Z"],
  ]) {
    assert.equal(retentionCutoff(new Date(now)), expected, now);
  }
  assert.throws(() => retentionCutoff(new Date(NaN)), /retention reference time/);
});

test("retention compares actual capture time at the exact cutoff, including its hour", async (t) => {
  const current = { hour: observedHour, capturedAt: observedAt, count: 81 };
  for (const [capturedAt, keep] of [
    ["2026-04-13T18:06:59.999Z", false],
    ["2026-04-13T18:07:00.000Z", true],
    ["2026-04-13T18:07:00.001Z", true],
  ]) {
    const boundary = { hour: "2026-04-13T18:00:00.000Z", capturedAt, count: 0 };
    const { path } = await fixture(t, [boundary, current]);
    await collect({
      path, clock: () => new Date(observedAt),
      reader: async () => { throw new Error("An already observed hour must skip the source"); },
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).observations, keep ? [boundary, current] : [current]);
  }
});

test("an already sampled hour prunes expired records without another source read or metadata changes", async (t) => {
  const expired = { hour: "2026-04-12T18:00:00.000Z", capturedAt: "2026-04-12T18:07:00.000Z", count: 55 };
  const previous = { hour: "2026-10-13T17:00:00.000Z", capturedAt: "2026-10-13T17:07:00.000Z", count: 42, note: "original sample" };
  const current = { hour: observedHour, capturedAt: observedAt, count: 0 };
  const metadata = { updatedAt: observedAt, schemaVersion: 2, details: { intervalMinutes: 60 } };
  const { directory, path } = await fixture(t, [expired, previous, current], metadata);
  let readerCalls = 0;
  await collect({ path, clock: () => new Date(observedAt), reader: async () => { readerCalls += 1; return 99; } });
  assert.equal(readerCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { source: SOURCE, ...metadata, observations: [previous, current] });
  assert.deepEqual(await readdir(directory), ["history.json"]);
});

test("a failed read still prunes expired data while retaining real samples and metadata", async (t) => {
  const expired = { hour: "2026-04-13T18:00:00.000Z", capturedAt: "2026-04-13T18:06:59.999Z", count: 55 };
  const previous = { hour: "2026-10-13T17:00:00.000Z", capturedAt: "2026-10-13T17:07:00.000Z", count: 0, note: "original sample" };
  const metadata = { updatedAt: previous.capturedAt, schemaVersion: 2, details: { intervalMinutes: 60 } };
  const { directory, path } = await fixture(t, [expired, previous], metadata);
  const sourceError = new Error("HTTP 403");
  await assert.rejects(collect({ path, clock: () => new Date(observedAt), reader: async () => { throw sourceError; } }), (error) => error === sourceError);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { source: SOURCE, ...metadata, observations: [previous] });
  assert.deepEqual(await readdir(directory), ["history.json"]);
});

test("expired observations are removed when validation fails, without inventing a new sample", async (t) => {
  const expired = { hour: "2026-04-12T18:00:00.000Z", capturedAt: "2026-04-12T18:07:00.000Z", count: 55 };
  const metadata = { updatedAt: expired.capturedAt, schemaVersion: 2 };
  for (const invalid of ["0", { count: 91, capturedAt: "2026-10-13T18:04:00.000Z" }]) {
    const { path } = await fixture(t, [expired], metadata);
    await assert.rejects(collect({ path, clock: () => new Date(observedAt), reader: async () => invalid }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { source: SOURCE, ...metadata, observations: [] });
  }
});

test("successful collection keeps retained samples sorted, preserves metadata, and uses completion time for pruning", async (t) => {
  const expiredDuringRead = { hour: "2026-04-13T18:00:00.000Z", capturedAt: "2026-04-13T18:07:00.001Z", count: 77 };
  const older = { hour: "2026-04-14T18:00:00.000Z", capturedAt: "2026-04-14T18:07:00.000Z", count: 42, note: "original sample" };
  const recent = { hour: "2026-10-13T17:00:00.000Z", capturedAt: "2026-10-13T17:07:00.000Z", count: 19 };
  const metadata = { schemaVersion: 2, details: { intervalMinutes: 60 } };
  const { directory, path } = await fixture(t, [recent, expiredDuringRead, older], metadata);
  let now = new Date(observedAt);
  await collect({
    path, clock: () => now,
    reader: async () => {
      now = new Date("2026-10-13T18:07:03.000Z");
      return { count: 0, capturedAt: observedAt };
    },
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    source: SOURCE, updatedAt: observedAt, ...metadata,
    observations: [older, recent, { hour: observedHour, capturedAt: observedAt, count: 0 }],
  });
  assert.deepEqual(await readdir(directory), ["history.json"]);
});

test("failure pruning also uses the real clock after a slow source read", async (t) => {
  const expiredDuringRead = { hour: "2026-04-13T18:00:00.000Z", capturedAt: "2026-04-13T18:07:00.001Z", count: 77 };
  const { path } = await fixture(t, [expiredDuringRead]);
  let now = new Date(observedAt);
  await assert.rejects(collect({
    path, clock: () => now,
    reader: async () => { now = new Date("2026-10-13T18:07:03.000Z"); throw new Error("HTTP 403"); },
  }), /HTTP 403/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).observations, []);
});

test("a response crossing into an already observed hour still saves retention pruning", async (t) => {
  const expired = { hour: "2026-04-12T18:00:00.000Z", capturedAt: "2026-04-12T18:07:00.000Z", count: 55 };
  const existing = { hour: "2026-10-13T19:00:00.000Z", capturedAt: "2026-10-13T19:00:00.000Z", count: 82 };
  const metadata = { updatedAt: existing.capturedAt, schemaVersion: 2 };
  const { path } = await fixture(t, [expired, existing], metadata);
  let now = new Date("2026-10-13T18:59:59.000Z");
  await collect({
    path, clock: () => now,
    reader: async () => { now = new Date("2026-10-13T19:00:01.000Z"); return 500; },
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { source: SOURCE, ...metadata, observations: [existing] });
});

test("malformed historical timestamps prevent deletion and preserve exact history bytes", async (t) => {
  const malformed = { hour: "2026-04-12T18:00:00.000Z", capturedAt: "invalid", count: 55 };
  const { path, original } = await fixture(t, [malformed]);
  let readerCalls = 0;
  await assert.rejects(collect({ path, clock: () => new Date(observedAt), reader: async () => { readerCalls += 1; return 23; } }), /Invalid history observation time/);
  assert.equal(readerCalls, 0);
  assert.equal(await readFile(path, "utf8"), original);
});
