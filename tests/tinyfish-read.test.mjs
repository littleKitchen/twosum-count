import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readCountInTinyFish, readVerifiedRemoteBadge, TINYFISH_API } from "../scripts/tinyfish-read.mjs";

const key = "unit-test-key-never-a-real-credential";
const cdp = "wss://fixture.tinyfish.test/cdp?token=unit-test-secret";
const now = Date.parse("2026-10-13T21:07:00.000Z");

function fixture(overrides = {}) {
  const calls = [];
  const state = { closed: false };
  const browser = {
    contexts: () => [{ pages: () => [{}] }],
    close: async () => { state.closed = true; },
  };
  return {
    calls, state, browser,
    options: {
      env: { GITHUB_ACTIONS: "true", TINYFISH_API_KEY: key },
      clock: () => now,
      sleep: async () => {},
      fetcher: async (url, options) => {
        calls.push({ url, ...options });
        return options.method === "POST"
          ? { status: 201, json: async () => ({ session_id: "br-unit-test", cdp_url: cdp }) }
          : { status: 204 };
      },
      connect: async () => browser,
      readBadge: async () => ({ count: 42, capturedAt: new Date(now).toISOString() }),
      ...overrides,
    },
  };
}

test("the optional backend requires cloud execution and a key before creating any session", async () => {
  const { calls, options } = fixture();
  await assert.rejects(readCountInTinyFish({ ...options, env: { TINYFISH_API_KEY: key } }), /cloud-only/);
  await assert.rejects(readCountInTinyFish({ ...options, env: { GITHUB_ACTIONS: "true" } }), /TINYFISH_API_KEY is required/);
  await assert.rejects(readCountInTinyFish({ ...options, timeoutMs: 90001 }), /timeout must be/);
  assert.equal(calls.length, 0);
});

test("one remote session returns its acquisition time and is explicitly terminated", async () => {
  const { calls, state, options } = fixture();
  const result = await readCountInTinyFish({ ...options, withTimestamp: true });
  assert.deepEqual(result, { count: 42, capturedAt: new Date(now).toISOString() });
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "DELETE"]);
  assert.equal(calls[0].url, TINYFISH_API);
  assert.deepEqual(JSON.parse(calls[0].body), {
    url: "https://leetcode.com/problems/two-sum/description/", timeout_seconds: 90,
  });
  assert.equal(calls[0].headers["X-API-Key"], key);
  assert.equal(calls[1].url, `${TINYFISH_API}/br-unit-test`);
  assert.equal(state.closed, true);
});

test("read failures still terminate the session and expose no key, CDP URL, or raw cause", async () => {
  const { calls, state, options } = fixture({
    readBadge: async () => { throw new Error(`private ${key} ${cdp}`); },
  });
  await assert.rejects(readCountInTinyFish(options), (error) => {
    assert.match(error.message, /did not provide a fresh verified Online count/);
    assert.equal(error.message.includes(key), false);
    assert.equal(error.message.includes(cdp), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "DELETE"]);
  assert.equal(state.closed, true);
});

test("connection failure terminates the known session without exposing the CDP connection error", async () => {
  const { calls, options } = fixture({ connect: async () => { throw new Error(cdp); } });
  await assert.rejects(readCountInTinyFish(options), (error) => {
    assert.match(error.message, /did not provide a valid connection/);
    assert.equal(error.message.includes(cdp), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "DELETE"]);
});

test("session creation errors are not retried and their response bodies are not read", async () => {
  let calls = 0;
  let bodyReads = 0;
  const { options } = fixture({
    fetcher: async () => {
      calls += 1;
      return { status: 401, json: async () => { bodyReads += 1; return { secret: key, url: cdp }; } };
    },
  });
  await assert.rejects(readCountInTinyFish(options), /session creation failed \(HTTP 401\)/);
  assert.equal(calls, 1);
  assert.equal(bodyReads, 0);
});

test("transient termination errors retry deletion, never session creation", async () => {
  const methods = [];
  let deletes = 0;
  const { options } = fixture({
    fetcher: async (_url, request) => {
      methods.push(request.method);
      if (request.method === "POST") return { status: 201, json: async () => ({ session_id: "br-unit-test", cdp_url: cdp }) };
      deletes += 1;
      return { status: deletes === 1 ? 409 : 204 };
    },
  });
  assert.equal(await readCountInTinyFish(options), 42);
  assert.deepEqual(methods, ["POST", "DELETE", "DELETE"]);
});

test("unconfirmed cleanup reports the cost-related failure without leaking response or transport details", async () => {
  let deletes = 0;
  const { options } = fixture({
    fetcher: async (_url, request) => {
      if (request.method === "POST") return { status: 201, json: async () => ({ session_id: "br-unit-test", cdp_url: cdp }) };
      deletes += 1;
      throw new Error(`${key} ${cdp}`);
    },
  });
  await assert.rejects(readCountInTinyFish(options), (error) => {
    assert.match(error.message, /termination could not be confirmed/);
    assert.equal(error.message.includes(key), false);
    assert.equal(error.message.includes(cdp), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(deletes, 3);
});

test("a connection-close error cannot leak secrets or replace a confirmed successful observation", async () => {
  const { browser, options } = fixture();
  browser.close = () => { throw new Error(`${key} ${cdp}`); };
  assert.equal(await readCountInTinyFish(options), 42);
});

function pageFixture({ endpoint = "wss://collaboration-ws.leetcode.com/problems/two-sum", payload = "42", badge = "42 Online", onRead = () => {} } = {}) {
  const socket = new EventEmitter();
  socket.url = () => endpoint;
  const page = new EventEmitter();
  page.goto = async () => {
    page.emit("websocket", socket);
    socket.emit("framereceived", { payload });
  };
  const locator = {
    first: () => locator,
    waitFor: async () => {},
    isVisible: async () => true,
    innerText: async () => { onRead(); return badge; },
  };
  page.getByText = () => locator;
  page.isClosed = () => false;
  return { page, socket };
}

test("visible count is accepted only with a fresh numeric frame from the exact official socket", async () => {
  const { page, socket } = pageFixture({ payload: "0", badge: "0 Online" });
  const result = await readVerifiedRemoteBadge(page, { deadline: now + 60000, clock: () => now });
  assert.deepEqual(result, { count: 0, capturedAt: new Date(now).toISOString() });
  assert.equal(page.listenerCount("websocket"), 0);
  assert.equal(socket.listenerCount("framereceived"), 0);
});

test("another socket cannot validate the visible official page badge", async () => {
  let time = now;
  const { page } = pageFixture({ endpoint: "wss://example.test/unrelated" });
  await assert.rejects(readVerifiedRemoteBadge(page, {
    deadline: now + 1000, clock: () => time, sleep: async () => { time += 1000; },
  }), /did not agree with a fresh official WebSocket count/);
});

test("a stale frame cannot validate an unchanged visible badge", async () => {
  let time = now;
  const { page } = pageFixture({ onRead: () => { time = Math.max(time, now + 11000); } });
  await assert.rejects(readVerifiedRemoteBadge(page, {
    deadline: now + 12000, clock: () => time, sleep: async () => { time += 1000; },
  }), /did not agree with a fresh official WebSocket count/);
});
