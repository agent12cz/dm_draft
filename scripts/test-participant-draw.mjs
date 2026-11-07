import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { animateParticipantDraw } from "../src/lib/participantDraw.ts";

function parseSource(path, kind = ts.ScriptKind.TS) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

function findFunction(source, name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, `Expected function ${name}`);
  return found;
}

function findWorkerCall(source, node) {
  const calls = [];
  function visit(current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "callFirestoreWorker"
    ) {
      calls.push(current);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  assert.equal(calls.length, 1, "Each helper should make exactly one Worker call");
  return calls[0];
}

function propertyNames(node) {
  assert.ok(ts.isObjectLiteralExpression(node));
  return node.properties.map((property) => {
    assert.ok(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property));
    return property.name.getText();
  });
}

const drawSource = parseSource("../src/lib/participantDraw.ts");
const drawCall = findWorkerCall(drawSource, findFunction(drawSource, "drawParticipantOrder"));
assert.equal(drawCall.arguments[0].getText(drawSource), '"draft.draw"');
assert.deepEqual(propertyNames(drawCall.arguments[1]), [
  "draftId",
  "expectedParticipantIds",
  "participants",
]);
assert.match(drawCall.arguments[1].getText(drawSource), /order\.map/);

const startSource = parseSource("../src/lib/startDraft.ts");
const startCall = findWorkerCall(startSource, findFunction(startSource, "startDraft"));
assert.equal(startCall.arguments[0].getText(startSource), '"draft.start"');
assert.deepEqual(propertyNames(startCall.arguments[1]), [
  "draftId",
  "expectedParticipants",
  "expectedTeamRanking",
  "participants",
  "teamRanking",
]);

const updateSource = parseSource("../src/lib/participantUpdate.ts");
const updateCall = findWorkerCall(updateSource, findFunction(updateSource, "commitParticipantUpdate"));
assert.equal(updateCall.arguments[0].getText(updateSource), '"draft.update"');
assert.deepEqual(propertyNames(updateCall.arguments[1]), [
  "draftId",
  "expected",
  "updates",
  "options",
]);

const createSource = parseSource("../src/lib/createDraft.ts");
const createCall = findWorkerCall(createSource, findFunction(createSource, "createDraftWithUniqueCode"));
assert.equal(createCall.arguments[0].getText(createSource), '"draft.create"');
assert.match(findFunction(createSource, "createDraftWithUniqueCode").getText(createSource), /attempt < 10/);
assert.match(findFunction(createSource, "createDraftWithUniqueCode").getText(createSource), /error\.status !== 409/);
console.log("✓ Draft creation, participant draw, start and organizer updates use guarded Worker operations");

const pageSource = parseSource("../src/app/draft/[code]/page.tsx", ts.ScriptKind.TSX);
for (const name of [
  "handleGenerateParticipantPin",
  "handleAssignUserToParticipant",
  "handleRemoveUserFromParticipant",
  "handleJoinDraftFromCode",
  "handleSaveParticipantNames",
  "handleUndoLastAction",
  "handleConfirmTeamReplacement",
  "moveParticipant",
]) {
  const body = findFunction(pageSource, name).getText(pageSource);
  assert.ok(
    name === "handleJoinDraftFromCode"
      ? body.includes('callFirestoreWorker("draft.join"')
      : body.includes("commitParticipantUpdate("),
    `${name} must use the guarded Worker helper`,
  );
  assert.ok(!body.includes("firestoreApi.updateDoc("), `${name} must not write directly to Firestore`);
}
assert.ok(findFunction(pageSource, "shuffleParticipants").getText(pageSource).includes("drawParticipantOrder("));
assert.ok(pageSource.text.includes("await startDraft("));
console.log("✓ Organizer page mutations route through guarded helpers instead of direct client writes");

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
  const cancel = animateParticipantDraw(() => assert.fail("Cancelled frame"), () => assert.fail("Cancelled completion"));
  cancel();
  assert.equal(pending, undefined);
  console.log("✓ Participant draw animation slows down, completes after five seconds and cancels cleanly");
} finally {
  Date.now = originalNow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
