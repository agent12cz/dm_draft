import assert from "node:assert/strict";
import { startInstantAutoPick } from "../src/lib/instantAutoPick.ts";

async function flush() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    schedule(callback, delayMs) {
      const timer = { callback, at: now + delayMs };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      await flush();
      while (true) {
        const timer = [...timers].filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at)[0];
        if (!timer) break;
        now = timer.at;
        timers.delete(timer);
        timer.callback();
        await flush();
      }
      now = target;
      await flush();
    },
    pending: () => timers.size,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  const clock = fakeClock();
  const diagnostics = [];
  const messages = [];
  const requests = [];
  const tokenRefreshes = [];
  const options = {
    draftId: "ABCDE",
    currentPickIndex: 0,
    turnKey: "ABCDE-0-1000",
    schedule: clock.schedule,
    log: (event) => diagnostics.push(event),
    onMessage: (message) => messages.push(message),
    getIdToken: async (forceRefresh) => {
      tokenRefreshes.push(forceRefresh);
      return "test-token";
    },
    request: async (_, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ status: "picked" });
    },
    refreshDraft: async () => {},
    ...overrides,
  };
  return { clock, diagnostics, messages, requests, tokenRefreshes, options };
}

{
  const test = fixture();
  const sent = [];
  let stop;
  let previousResponse;
  for (let index = 0; index < 10; index += 1) {
    const response = deferred();
    stop = startInstantAutoPick({
      ...test.options,
      currentPickIndex: index,
      turnKey: `ABCDE-${index}-${index * 15_000}`,
      request: async (_, init) => {
        sent.push(JSON.parse(init.body).currentPickIndex);
        return response.promise;
      },
    });
    await flush();
    assert.equal(sent.at(-1), index);
    const messagesBeforeResponse = test.messages.length;
    previousResponse?.resolve(Response.json({ status: "picked" }));
    await flush();
    assert.equal(test.messages.length, messagesBeforeResponse);
    // The listener already sees the committed next turn while HTTP is pending.
    stop();
    await test.clock.advance(15_000);
    assert.equal(test.clock.pending(), 0);
    previousResponse = response;
  }
  previousResponse.resolve(Response.json({ status: "completed" }));
  await flush();
  assert.deepEqual(sent, Array.from({ length: 10 }, (_, index) => index));
  assert.equal(test.diagnostics.filter((entry) => entry.event === "request-sent").length, 10);
  console.log("✓ Ten consecutive 15-second turns send requests even while old responses are pending");
}

{
  const test = fixture();
  for (let index = 0; index < 10; index += 1) {
    const stop = startInstantAutoPick({
      ...test.options,
      currentPickIndex: index,
      turnKey: `ABCDE-${index}-${index * 15_000}`,
    });
    await flush();
    assert.equal(test.diagnostics.filter((entry) => entry.event === "awaiting-snapshot").length, index + 1);
    stop();
    await test.clock.advance(15_000);
    assert.equal(test.clock.pending(), 0);
  }
  assert.deepEqual(test.requests.map((request) => request.currentPickIndex),
    Array.from({ length: 10 }, (_, index) => index));
  console.log("✓ Ten normally acknowledged turns each send exactly one independent request");
}

for (const outcome of ["network", 409, 429, 503, "not-expired", "invalid-json"]) {
  let calls = 0;
  const test = fixture({
    request: async () => {
      calls += 1;
      if (calls > 1) return Response.json({ status: "picked" });
      if (outcome === "network") throw new TypeError("Network unavailable");
      if (outcome === "invalid-json") return new Response("not JSON");
      if (outcome === "not-expired") return Response.json({ status: "not-expired" });
      return Response.json({ status: "failed" }, { status: outcome });
    },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(1_000);
  assert.equal(calls, 2, String(outcome));
  assert.equal(test.diagnostics.some((entry) => entry.event === "awaiting-snapshot"), true);
  stop();
  await test.clock.advance(60_000);
  assert.equal(calls, 2);
  console.log(`✓ ${outcome} is retried without refreshing the page`);
}

{
  let calls = 0;
  const test = fixture({
    request: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ status: "unauthorized" }, { status: 401 })
        : Response.json({ status: "picked" });
    },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(1_000);
  assert.deepEqual(test.tokenRefreshes, [false, true]);
  assert.equal(calls, 2);
  stop();
  console.log("✓ HTTP 401 refreshes the Firebase token before retrying");
}

{
  let calls = 0;
  const test = fixture({
    request: async () => {
      calls += 1;
      return Response.json({ status: "failed" }, { status: calls === 1 ? 401 : 503 });
    },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(3_000);
  assert.deepEqual(test.tokenRefreshes, [false, true, false]);
  stop();
  console.log("✓ Retries after token renewal reuse the refreshed token rather than forcing renewals");
}

for (const status of [401, 403, 404, 422]) {
  let calls = 0;
  const test = fixture({
    request: async () => {
      calls += 1;
      return new Response("error", { status });
    },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(60_000);
  assert.equal(calls, status === 401 ? 2 : 1);
  assert.equal(test.diagnostics.some((entry) => entry.event === "request-stopped"), true);
  assert.doesNotMatch(test.messages.at(-1), /probíhá/);
  stop();
  console.log(`✓ Persistent HTTP ${status} is surfaced instead of showing endless progress`);
}

for (const phase of ["token", "fetch"]) {
  const pending = deferred();
  let calls = 0;
  const test = fixture(phase === "token" ? {
    getIdToken: async () => {
      calls += 1;
      return calls === 1 ? pending.promise : "new-token";
    },
  } : {
    request: async () => {
      calls += 1;
      return calls === 1 ? pending.promise : Response.json({ status: "picked" });
    },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(11_000);
  assert.equal(calls, 2);
  assert.equal(test.diagnostics.some((entry) => entry.event === "request-timeout"), true);
  pending.resolve(phase === "token" ? "old-token" : Response.json({ status: "picked" }));
  await flush();
  assert.equal(test.diagnostics.filter((entry) => entry.event === "awaiting-snapshot").length, 1);
  stop();
  console.log(`✓ A hanging ${phase} times out and its late completion cannot affect the retry`);
}

for (const status of ["picked", "completed", "changed"]) {
  let stop;
  let reads = 0;
  const test = fixture({
    request: async () => Response.json({ status }),
    refreshDraft: async () => {
      reads += 1;
      stop(); // Models the refreshed snapshot advancing/completing the turn.
    },
  });
  stop = startInstantAutoPick(test.options);
  await test.clock.advance(60_000);
  assert.equal(reads, 1);
  assert.equal(test.diagnostics.some((entry) => entry.event === "snapshot-missing"), true);
  assert.equal(test.clock.pending(), 0);
  console.log(`✓ ${status} without a listener update triggers a server read and then stops`);
}

{
  let reads = 0;
  const test = fixture({
    refreshDraft: async () => {
      reads += 1;
      throw new Error("Firestore unavailable");
    },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(5_000);
  assert.equal(reads, 1);
  assert.equal(test.requests.length, 2);
  assert.equal(test.diagnostics.some((entry) => entry.event === "snapshot-refresh-failed"), true);
  stop();
  console.log("✓ A failed Firestore refresh cannot permanently block the expired turn");
}

{
  const test = fixture();
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(5_000);
  assert.equal(test.requests.length, 2);
  assert.equal(test.diagnostics.some((entry) => entry.event === "snapshot-missing"), true);
  stop();
  console.log("✓ An unchanged recovery snapshot retries the same guarded pick instead of freezing");
}

{
  const test = fixture();
  const firstStop = startInstantAutoPick(test.options);
  firstStop(); // React Strict Mode setup/cleanup before token acquisition finishes.
  const secondStop = startInstantAutoPick(test.options);
  await flush();
  assert.equal(test.requests.length, 1);
  secondStop();
  assert.equal(test.clock.pending(), 0);
  console.log("✓ Immediate effect cleanup and restart cannot leave a turn marked as already sent");
}

{
  const test = fixture();
  const calls = [];
  const options = {
    ...test.options,
    request: async (_, init) => {
      const { currentPickIndex } = JSON.parse(init.body);
      calls.push(currentPickIndex);
      return Response.json({ status: "unavailable" }, { status: 503 });
    },
  };
  const firstStop = startInstantAutoPick(options);
  await flush();
  firstStop(); // A manual pick or another client advances the turn during backoff.
  const nextStop = startInstantAutoPick({
    ...options,
    currentPickIndex: 1,
    turnKey: "ABCDE-1-16000",
  });
  await flush();
  assert.deepEqual(calls, [0, 1]);
  await test.clock.advance(1_000);
  assert.deepEqual(calls, [0, 1, 1]);
  nextStop();
  console.log("✓ A new turn does not inherit the previous turn's backoff or retry");
}

{
  const test = fixture({
    getIdToken: async () => { throw new Error("Token unavailable"); },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(1_000);
  assert.equal(test.requests.length, 0);
  assert.equal(test.diagnostics.filter((entry) => entry.event === "token-request").length, 2);
  assert.equal(test.diagnostics.some((entry) => entry.event === "request-sent"), false);
  assert.equal(test.diagnostics.some((entry) => entry.event === "request-failed"), true);
  stop();
  console.log("✓ Diagnostics distinguish failed token acquisition from a dispatched HTTP request");
}

{
  const delayedRead = deferred();
  let appliedSnapshots = 0;
  const test = fixture({
    refreshDraft: async (signal) => {
      await delayedRead.promise;
      if (!signal.aborted) appliedSnapshots += 1;
    },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(3_000);
  stop();
  delayedRead.resolve();
  await flush();
  assert.equal(appliedSnapshots, 0);
  assert.equal(test.clock.pending(), 0);
  console.log("✓ A stale recovery read cannot overwrite a newer turn after cleanup");
}

{
  const test = fixture({
    request: async () => { throw new TypeError("Offline"); },
  });
  const stop = startInstantAutoPick(test.options);
  await test.clock.advance(60_000);
  const delays = test.diagnostics.filter((entry) => entry.event === "retry-scheduled")
    .map((entry) => entry.delayMs);
  assert.deepEqual(delays.slice(0, 5), [1_000, 2_000, 4_000, 8_000, 10_000]);
  assert.equal(delays.every((delay) => delay <= 10_000), true);
  stop();
  assert.equal(test.clock.pending(), 0);
  console.log("✓ Transient failures use capped backoff and cleanup removes every timer");
}

console.log("\nALL CLIENT INSTANT AUTOMATIC PICK TESTS PASSED!");
