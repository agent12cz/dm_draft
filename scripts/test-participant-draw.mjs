import assert from "node:assert/strict";
import { animateParticipantDraw, drawParticipantOrder, ParticipantDrawError } from "../src/lib/participantDraw";
import { startDraft } from "../src/lib/startDraft";
import { commitParticipantUpdate, ParticipantUpdateConflict } from "../src/lib/participantUpdate";
import { createDraftWithUniqueCode } from "../src/lib/createDraft";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { Timestamp } from "firebase/firestore";

const originalCrypto = globalThis.crypto;
let randomCalls = 0;
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: { getRandomValues: (array) => { array[0] = ++randomCalls; return array; } },
});

function createStore(overrides = {}) {
  let document = {
    status: "waiting",
    participants: Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `Player ${index}` })),
    ...overrides,
  };
  let version = 0;
  return {
    get data() { return structuredClone(document); },
    api: {
      doc: () => "draft",
      serverTimestamp: () => "timestamp",
      async runTransaction(_db, update) {
        for (;;) {
          const readVersion = version;
          let changes;
          const tx = {
            get: async () => ({ exists: () => true, data: () => structuredClone(document) }),
            update: (_ref, values) => { changes = values; },
          };
          await update(tx);
          if (readVersion !== version) continue;
          document = { ...document, ...changes };
          version += 1;
          return;
        }
      },
    },
  };
}

try {
  const store = createStore();
  const initial = store.data.participants;
  const outcomes = await Promise.allSettled([
    drawParticipantOrder({}, store.api, "draft", initial, (participant) => participant),
    drawParticipantOrder({}, store.api, "draft", initial, (participant) => participant),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.ok(rejected.reason instanceof ParticipantDrawError);
  assert.equal(rejected.reason.reason, "already-drawn");
  assert.equal(randomCalls, 14, "transaction retries must not draw a new permutation");
  assert.equal(store.data.participantOrderDrawn, true);
  assert.deepEqual(store.data.participants.map((participant) => participant.id).sort(), initial.map((participant) => participant.id).sort());

  const saved = store.data;
  await assert.rejects(
    drawParticipantOrder({}, store.api, "draft", saved.participants, (participant) => participant),
    (error) => error instanceof ParticipantDrawError && error.reason === "already-drawn",
  );
  assert.deepEqual(store.data, saved, "a reload or repeated request must not change the stored order");
  console.log("✓ Concurrent draws commit once; retry and reload cannot replace the stored result");

  const participants = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index}`, name: `Player ${index}`, userId: `user${index}`, picks: [],
  }));
  const concurrent = createStore({
    participants,
    participantCount: 8,
    pickOrder: [0, 1],
    availableItemIds: ["team-a", "team-b"],
    teamRanking: ["team-a", "team-b"],
    turnDurationSeconds: 30,
  });
  const start = () => startDraft(
    {}, concurrent.api, "draft", participants, participants.map((participant) => participant.name),
    ["team-a", "team-b"], ["team-a", "team-b"], (participant) => participant,
  );
  const racing = await Promise.allSettled([
    drawParticipantOrder({}, concurrent.api, "draft", participants, (participant) => participant),
    start(),
  ]);
  assert.equal(racing.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.data.participantOrderDrawn, true);
  assert.equal(concurrent.data.status, "waiting");
  await assert.rejects(start(), /Draft se mezitím změnil/);
  const latest = concurrent.data.participants;
  await startDraft(
    {}, concurrent.api, "draft", latest, latest.map((participant) => participant.name),
    ["team-a", "team-b"], ["team-a", "team-b"], (participant) => participant,
  );
  assert.equal(concurrent.data.status, "drafting");
  assert.deepEqual(concurrent.data.participants.map((participant) => participant.id), latest.map((participant) => participant.id));
  assert.equal(concurrent.data.turnDurationSeconds, 30);
  console.log("✓ A concurrent draw invalidates a stale start; retry uses the confirmed order and timer");

  const startFirst = createStore({
    participants, participantCount: 8, pickOrder: [0, 1],
    availableItemIds: ["team-a"], teamRanking: ["team-a"],
  });
  const startFirstOutcomes = await Promise.allSettled([
    startDraft({}, startFirst.api, "draft", participants, participants.map((participant) => participant.name),
      ["team-a"], ["team-a"], (participant) => participant),
    drawParticipantOrder({}, startFirst.api, "draft", participants, (participant) => participant),
  ]);
  assert.equal(startFirstOutcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(startFirst.data.status, "drafting");
  assert.equal(startFirst.data.participantOrderDrawn, undefined);
  assert.equal(startFirstOutcomes[1].reason.reason, "not-waiting");
  console.log("✓ A simultaneous draw cannot commit after a successful start");

  const changedAssignment = createStore({
    participants: participants.map((participant, index) => index === 0 ? { ...participant, userId: "new-user" } : participant),
    participantCount: 8, pickOrder: [0, 1], availableItemIds: ["team-a"], teamRanking: ["team-a"],
  });
  await assert.rejects(
    startDraft({}, changedAssignment.api, "draft", participants, participants.map((participant) => participant.name),
      ["team-a"], ["team-a"], (participant) => participant),
    /Draft se mezitím změnil/,
  );
  assert.equal(changedAssignment.data.status, "waiting");
  console.log("✓ A start based on stale participant assignment is rejected");

  const identity = (participant) => participant;
  for (const [label, makeUpdate, options] of [
    ["PIN", (items) => ({ participants: items.map((item, index) => index ? item : { ...item, participantPin: "123456" }) }), {}],
    ["assignment", (items) => ({ participants: items.map((item, index) => index ? item : { ...item, userId: "other" }) }), { waiting: true }],
    ["removal", (items) => ({ participants: items.map((item, index) => index ? item : { ...item, userId: "" }) }), { waiting: true }],
    ["join", (items) => ({ participants: items.map((item, index) => index ? item : { ...item, userId: "joiner" }) }), { waiting: true }],
    ["names", (items) => ({ participants: items.map((item, index) => index ? item : { ...item, name: "Changed" }) }), { waiting: true }],
    ["move", (items) => ({ participants: [items[1], items[0], ...items.slice(2)] }), { reorder: true }],
    ["undo", (items) => ({ participants: items, history: [], currentPickIndex: 0, availableItemIds: ["team-a"] }), { checkTurn: true }],
    ["replacement", (items) => ({ participants: items, history: [{ type: "replace" }], availableItemIds: [] }), { checkTurn: true }],
  ]) {
    const guarded = createStore({
      participants,
      participantCount: 8,
      pickOrder: [0, 1],
      currentPickIndex: 0,
      availableItemIds: ["team-a"],
      history: [],
    });
    const expected = guarded.data;
    const outcomes = await Promise.allSettled([
      drawParticipantOrder({}, guarded.api, "draft", participants, identity),
      commitParticipantUpdate({}, guarded.api, "draft", expected, makeUpdate(expected.participants), identity, options),
    ]);
    assert.equal(outcomes[0].status, "fulfilled", `${label}: draw should succeed`);
    assert.equal(outcomes[1].status, "rejected", `${label}: stale mutation should fail`);
    assert.ok(outcomes[1].reason instanceof ParticipantUpdateConflict);
    const drawn = guarded.data;
    await assert.rejects(
      commitParticipantUpdate({}, guarded.api, "draft", expected, makeUpdate(expected.participants), identity, options),
      ParticipantUpdateConflict,
    );
    assert.deepEqual(guarded.data, drawn, `${label}: stale write must not overwrite draw`);
  }
  console.log("✓ All participant-management, undo and replacement writes reject a concurrent draw");

  const updatedFirst = createStore({ participants });
  const before = updatedFirst.data;
  const revised = before.participants.map((participant, index) => index ? participant : { ...participant, participantPin: "123456" });
  const both = await Promise.allSettled([
    commitParticipantUpdate({}, updatedFirst.api, "draft", before, { participants: revised }, identity),
    drawParticipantOrder({}, updatedFirst.api, "draft", before.participants, identity),
  ]);
  assert.equal(both.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(updatedFirst.data.participantOrderDrawn, true);
  assert.equal(updatedFirst.data.participants.find((participant) => participant.id === "p0").participantPin, "123456");
  const drawnSnapshot = updatedFirst.data;
  await assert.rejects(
    commitParticipantUpdate({}, updatedFirst.api, "draft", drawnSnapshot,
      { participants: [...drawnSnapshot.participants].reverse() }, identity, { reorder: true }),
    ParticipantUpdateConflict,
  );
  assert.deepEqual(updatedFirst.data, drawnSnapshot);
  console.log("✓ A draw keeps earlier participant edits and blocks all later reordering");

  const flagOnly = createStore({ participants, participantOrderDrawn: true });
  await assert.rejects(
    commitParticipantUpdate({}, flagOnly.api, "draft",
      { ...flagOnly.data, participantOrderDrawn: false },
      { participants }, identity),
    ParticipantUpdateConflict,
  );
  const metadataChange = createStore({ participants: revised });
  await assert.rejects(
    commitParticipantUpdate({}, metadataChange.api, "draft",
      { ...metadataChange.data, participants },
      { participants }, identity),
    ParticipantUpdateConflict,
  );
  console.log("✓ An unchanged permutation still locks the draw and stale metadata cannot be overwritten");

  const timestampParticipant = { id: "p0", joinedAt: new Timestamp(100, 123), picks: [] };
  let timestampUpdate;
  const timestampApi = {
    doc: () => "draft",
    serverTimestamp: () => "timestamp",
    runTransaction: async (_db, update) => update({
      get: async () => ({ exists: () => true, data: () => ({
        status: "waiting", participants: [{ ...timestampParticipant, joinedAt: new Timestamp(100, 123) }],
      }) }),
      update: (_ref, values) => { timestampUpdate = values; },
    }),
  };
  await commitParticipantUpdate({}, timestampApi, "draft",
    { status: "waiting", participants: [timestampParticipant] },
    { participants: [timestampParticipant] }, identity);
  assert.ok(timestampUpdate);
  console.log("✓ Equivalent Firestore timestamps do not cause false conflicts");

  const changedTurn = createStore({
    participants, status: "drafting", currentPickIndex: 1, pickOrder: [0, 1],
    availableItemIds: [], history: [{ type: "pick", participantIndex: 0 }],
    participantOrderDrawn: true,
  });
  const staleTurn = { ...changedTurn.data, currentPickIndex: 0, availableItemIds: ["team-a"], history: [] };
  await assert.rejects(
    commitParticipantUpdate({}, changedTurn.api, "draft", staleTurn, { participants }, identity, { checkTurn: true }),
    ParticipantUpdateConflict,
  );
  console.log("✓ Undo and replacement reject a changed turn");

  const source = ts.createSourceFile("page.tsx",
    readFileSync(new URL("../src/app/draft/[code]/page.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Map();
  function collect(node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    ts.forEachChild(node, collect);
  }
  collect(source);
  for (const name of ["handleGenerateParticipantPin", "handleAssignUserToParticipant", "handleRemoveUserFromParticipant",
    "handleJoinDraftFromCode", "handleSaveParticipantNames", "handleUndoLastAction", "handleConfirmTeamReplacement", "moveParticipant"]) {
    const body = functions.get(name)?.getText(source);
    assert.ok(body?.includes("commitParticipantUpdate("), `${name} must use the guarded transaction`);
    assert.ok(!body.includes("firestoreApi.updateDoc("), `${name} must not use a direct update`);
  }
  console.log("✓ Participant-management entry points use guarded transactions");

  const documents = new Map([["OLD", { participantOrderDrawn: true, participants }]]);
  let version = 0;
  const createApi = {
    doc: (_db, _collection, id) => id,
    async runTransaction(_db, update) {
      for (;;) {
        const readVersion = version;
        let write;
        const result = await update({
          get: async (ref) => ({ exists: () => documents.has(ref) }),
          set: (ref, value) => { write = { ref, value }; },
        });
        if (readVersion !== version) continue;
        documents.set(write.ref, write.value);
        version++;
        return result;
      }
    },
  };
  const codes = ["OLD", "NEW"];
  const newCode = await createDraftWithUniqueCode({}, createApi, () => codes.shift(), { title: "New" });
  assert.equal(newCode, "NEW");
  assert.deepEqual(documents.get("OLD"), { participantOrderDrawn: true, participants });
  assert.deepEqual(documents.get("NEW"), { title: "New", code: "NEW" });
  const raceCodesA = ["RACE", "SECOND"];
  const raceCodesB = ["RACE", "THIRD"];
  const created = await Promise.all([
    createDraftWithUniqueCode({}, createApi, () => raceCodesA.shift(), { title: "A" }),
    createDraftWithUniqueCode({}, createApi, () => raceCodesB.shift(), { title: "B" }),
  ]);
  assert.equal(new Set(created).size, 2);
  assert.deepEqual(created.map((code) => documents.get(code).title), ["A", "B"]);
  console.log("✓ Draft creation and duplication cannot overwrite existing or concurrently created drafts");

  const started = createStore();
  const api = {
    ...started.api,
    runTransaction: async (_db, update) => update({
      get: async () => ({ exists: () => true, data: () => ({ ...started.data, status: "drafting" }) }),
      update: () => assert.fail("Cannot draw after the draft starts"),
    }),
  };
  await assert.rejects(
    drawParticipantOrder({}, api, "draft", started.data.participants, (participant) => participant),
    (error) => error instanceof ParticipantDrawError && error.reason === "not-waiting",
  );
  console.log("✓ A draw cannot commit after the draft starts");

  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  try {
    let clock = 0;
    let pending;
    const intervals = [];
    Date.now = () => clock;
    globalThis.setTimeout = (callback, delay) => {
      intervals.push(delay);
      pending = { callback, at: clock + delay };
      return 1;
    };
    globalThis.clearTimeout = () => { pending = undefined; };
    const frames = [];
    let completed = false;
    animateParticipantDraw((frame) => frames.push(frame), () => { completed = true; });
    while (pending) {
      const current = pending;
      pending = undefined;
      clock = current.at;
      current.callback();
    }
    assert.equal(clock, 5000);
    assert.ok(completed && frames.length > 5);
    assert.ok(intervals[3] > intervals[0]);
    console.log("✓ Animation slows down and completes after five seconds");
    const cancel = animateParticipantDraw(() => assert.fail("Cancelled frame"), () => assert.fail("Cancelled completion"));
    cancel();
    assert.equal(pending, undefined);
    console.log("✓ Interrupting animation cancels its pending timer");
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
} finally {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
}
