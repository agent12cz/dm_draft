import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React, { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { FirestoreHttpError, FirestoreSecurityError } from "../workers/firestore.ts";

const require = createRequire(import.meta.url);
function load(path, mocks, globals = {}, extra = "") {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule, exports: testModule.exports,
    require: (name) => name in mocks ? mocks[name] : require(name),
    console, Error, Response, Request, ...globals,
  });
  return testModule.exports;
}

const logs = [];
let workerError;
const processEnv = { NODE_ENV: "development" };
const route = load("../src/app/api/firestore/route.ts", {
  "@opennextjs/cloudflare": { getCloudflareContext: async () => ({ env: {
    FIREBASE_PROJECT_ID: "local-test", FIREBASE_SERVICE_ACCOUNT_JSON: "not-a-production-secret",
  } }) },
  "../../../../workers/firebaseAuth": { verifyFirebaseIdToken: async () => ({ uid: "owner" }), FirebaseAuthError: class extends Error {} },
  "../../../../workers/firestore": {
    FirestoreHttpError, FirestoreSecurityError,
    executeFirestoreSecurityOperation: async () => {
      if (workerError) throw workerError;
      return { users: [{ uid: "dan", displayName: "Dan" }] };
    },
  },
  "../../../../workers/rateLimit": { consumeRateLimit: () => true },
}, {
  process: { env: processEnv },
  console: { error: (...args) => logs.push(args) },
});
const request = () => new Request("http://localhost/api/firestore", {
  method: "POST",
  headers: { authorization: "Bearer private-test-token", "content-type": "application/json" },
  body: JSON.stringify({ operation: "draft.search-users", draftId: "HM85L", prefix: "private-search" }),
});

workerError = new FirestoreHttpError("Sensitive upstream body", 400, "Firestore user search", "INVALID_ARGUMENT");
const upstreamResponse = await route.POST(request());
assert.equal(upstreamResponse.status, 502);
assert.deepEqual(await upstreamResponse.json(), {
  status: "failed",
  diagnostic: { source: "upstream", operation: "Firestore user search", httpStatus: 400, reason: "INVALID_ARGUMENT" },
});
assert.doesNotMatch(JSON.stringify(logs), /private-test-token|private-search|HM85L|Sensitive upstream body|not-a-production-secret/);
workerError = new FirestoreSecurityError(400, "Invalid search prefix.");
const invalidResponse = await route.POST(request());
assert.equal(invalidResponse.status, 400);
const invalidBody = await invalidResponse.json();
assert.equal(invalidBody.message, "Invalid search prefix.");
processEnv.NODE_ENV = "production";
workerError = new FirestoreHttpError("Sensitive upstream body", 400, "Firestore user search", "INVALID_ARGUMENT");
assert.deepEqual(await (await route.POST(request())).json(), { status: "failed" });
console.log("✓ Validation and upstream errors are distinct; local diagnostics contain no token, profile, draft or search values");

let status = 400;
const client = load("../src/lib/firestoreWorker.ts", {
  "@/lib/firebase": { getFirebaseClient: async () => ({ auth: { currentUser: { getIdToken: async () => "test-token" } } }) },
}, { fetch: async () => Response.json(status === 400 ? invalidBody : { status: "failed" }, { status }) });
await assert.rejects(client.callFirestoreWorker("draft.search-users"), /Invalid search prefix/);
status = 502;
await assert.rejects(client.callFirestoreWorker("draft.search-users"), /serveru/);
console.log("✓ Client preserves safe validation details and distinguishes a server-side failure");

const fixture = {
  id: "HM85L", code: "HM85L", title: "Test room", status: "waiting", sport: "NHL",
  participantCount: 1, participants: [{ id: "slot", name: "", displayName: "", userId: "", uid: "", status: "waiting", picks: [] }],
  draftItems: [{ id: "team-a", name: "Team A", sport: "NHL", logo: "" }],
  availableItemIds: ["team-a"], pickOrder: [0], currentPickIndex: 0, history: [],
  turnDurationSeconds: null, teamRanking: [], participantOrderDrawn: false,
  boxCount: 1, boxPrice: 100, margin: 0, targetBreakPrice: 100, productPrice: 100,
};
const state = [];
let stateIndex = 0;
let effects = [];
let timers = [];
let searchResponse;
let searchFailure;
const calls = [];
let draftSnapshotCallback;
const pendingDraftAccess = [];
const invitationToken = "A".repeat(43);
let copiedInvitationLink;
const container = ({ children }) => React.createElement("div", null, children);
const callWorker = async (operation, payload) => {
  calls.push({ operation, payload });
  if (operation === "draft.search-users") {
    if (searchFailure) throw searchFailure;
    return searchResponse ?? { users: [{ uid: "dan", displayName: "Dan" }] };
  }
  if (operation === "invite.create") return { status: "created", token: invitationToken };
  return {};
};
const participantHelper = load("../src/lib/participantUpdate.ts", {
  "@/lib/firestoreWorker": { callFirestoreWorker: callWorker },
});
const page = load("../src/app/draft/[code]/page.tsx", {
  react: {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
    useEffect: (callback) => effects.push(callback),
    useRef: (initial) => ({ current: initial }),
    useMemo: (callback) => callback(),
    useCallback: (callback) => callback,
  },
  "next/navigation": { useParams: () => ({ code: "HM85L" }) },
  "@/components/AuthProvider": { useAuth: () => ({ user: { uid: "owner" }, profile: { role: "admin" } }) },
  "@/components/Navbar": { Navbar: () => null },
  "@/components/Card": { Card: container },
  "@/components/PageContainer": { PageContainer: container },
  "@/components/DraftChat": { DraftChat: () => null },
  "@/app/auth-guard": { __esModule: true, default: container },
  "@/lib/firestoreWorker": {
    callFirestoreWorker: callWorker,
    getDraftPrivateAccess: () => new Promise((resolve) => pendingDraftAccess.push(resolve)),
  },
  "@/lib/participantUpdate": participantHelper,
  "@/lib/firebase": { getFirebaseClient: async () => ({
    db: {},
    firestoreApi: {
      doc: () => ({}),
      onSnapshot: (_ref, callback) => { draftSnapshotCallback = callback; return () => {}; },
    },
  }) },
  "@/lib/snakeDraft": { normalizeDraftItem: (item) => item },
  "@/lib/participantDraw": {},
  "@/lib/startDraft": {},
  "@/lib/turnCountdown": { getTimeLeftForTurn: () => null, getTurnKey: () => null },
}, {
  console: { error: (...args) => logs.push(args) },
  window: {
    location: { origin: "https://draft.example.test" },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timers = timers.filter((entry) => entry !== timer); },
  },
  navigator: { clipboard: { writeText: async (value) => { copiedInvitationLink = value; } } },
}, "\nexport { DraftDetailPageContent as TestContent };");

function render() {
  stateIndex = 0;
  effects = [];
  return page.TestContent();
}
function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  return predicate(node) ? node : find(node.props.children, predicate);
}
function searchEffect() {
  render();
  timers = [];
  return effects[1]();
}
async function executeSearch() {
  const cleanup = searchEffect();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 250);
  await timers[0].callback();
  return cleanup;
}
state[0] = fixture;
state[1] = false;
state[3] = [""];
state[13] = "da";
state[15] = 0;
let cleanup = await executeSearch();
assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { operation: "draft.search-users", payload: { draftId: "HM85L", prefix: "da" } });
assert.equal(state[14][0].uid, "dan");
const candidate = find(render(), (node) => node.type === "button" && node.key === "dan");
assert.ok(candidate);
candidate.props.onClick();
for (let index = 0; index < 30; index++) await Promise.resolve();
const assignment = calls.find((call) => call.operation === "draft.update");
assert.ok(assignment);
assert.equal(assignment.payload.draftId, "HM85L");
assert.equal(assignment.payload.updates.participants[0].uid, "dan");
assert.equal(assignment.payload.updates.participants[0].userId, "dan");
assert.equal(assignment.payload.updates.participants[0].email, "");
assert.equal(assignment.payload.options.waiting, true);
cleanup();
console.log("✓ Search uses the draft ID and prefix; assigning a UID-only result uses the guarded Worker update");

state[13] = "da";
state[15] = 0;
searchFailure = new Error("K této operaci nemáte oprávnění.");
cleanup = await executeSearch();
const failedMarkup = renderToStaticMarkup(render());
assert.match(failedMarkup, /role="alert"/);
assert.match(failedMarkup, /nemáte oprávnění/);
assert.doesNotMatch(failedMarkup, /Žádní uživatelé nenalezeni/);
cleanup();
console.log("✓ Search failures are shown, not disguised as an empty result");

searchFailure = null;
let resolveOld;
searchResponse = new Promise((resolve) => { resolveOld = resolve; });
cleanup = searchEffect();
const oldSearch = timers[0].callback();
cleanup();
state[13] = "new";
searchResponse = { users: [{ uid: "new", displayName: "New" }] };
const nextCleanup = await executeSearch();
resolveOld({ users: [{ uid: "old", displayName: "Old" }] });
await oldSearch;
assert.equal(state[14][0].uid, "new");
assert.equal(state[21], false);
nextCleanup();
console.log("✓ Late responses cannot overwrite a newer search");

state[0] = {
  ...fixture,
  participants: [{ ...fixture.participants[0], name: "Guest", status: "pending-registration" }],
};
state[17] = ["slot"];
const createInvitation = find(render(), (node) =>
  node.type === "button" && node.props.children === "Vytvořit pozvánku (1)",
);
assert.ok(createInvitation);
createInvitation.props.onClick();
for (let index = 0; index < 30; index++) await Promise.resolve();
assert.equal(state[18], `https://draft.example.test/invite#${invitationToken}`);
assert.equal(copiedInvitationLink, state[18]);
const invitationUrl = new URL(copiedInvitationLink);
assert.equal(invitationUrl.pathname, "/invite");
assert.equal(invitationUrl.search, "");
assert.equal(invitationUrl.hash, `#${invitationToken}`);
assert.deepEqual(JSON.parse(JSON.stringify(calls.find((call) => call.operation === "invite.create"))), {
  operation: "invite.create",
  payload: { draftId: "HM85L", participantIds: ["slot"] },
});
console.log("✓ Generated and copied invitations keep the token only in the URL fragment");

render();
const unsubscribeDraft = effects[0]();
for (let index = 0; index < 30; index++) await Promise.resolve();
const snapshot = { id: fixture.id, exists: () => true, data: () => fixture };
draftSnapshotCallback(snapshot);
draftSnapshotCallback(snapshot);
assert.equal(pendingDraftAccess.length, 2);
const rawParticipants = [{ id: "slot", name: "", picks: [], userId: "", uid: "", email: "", participantId: "slot", participantPin: null, joinedAt: null }];
pendingDraftAccess[1]({ authorized: true, role: "owner", participants: rawParticipants });
for (let index = 0; index < 30; index++) await Promise.resolve();
assert.equal(state[0].participantSnapshot, rawParticipants);
assert.equal(state[0].participants[0].name, "Účastník 1");
assert.equal(state[0].participants[0].pickCount, 0);
pendingDraftAccess[0]({ authorized: true, role: "owner", participants: [{ ...rawParticipants[0], name: "Stale response" }] });
for (let index = 0; index < 30; index++) await Promise.resolve();
assert.equal(state[0].participantSnapshot, rawParticipants);
state[13] = "da";
state[14] = [{ uid: "dan", displayName: "Dan" }];
state[15] = 0;
const snapshotCandidate = find(render(), (node) => node.type === "button" && node.key === "dan");
assert.ok(snapshotCandidate);
snapshotCandidate.props.onClick();
for (let index = 0; index < 30; index++) await Promise.resolve();
const snapshotAssignment = calls.filter((call) => call.operation === "draft.update").at(-1);
assert.deepEqual(snapshotAssignment.payload.expected.participants, rawParticipants);
assert.equal("pickCount" in snapshotAssignment.payload.expected.participants[0], false);
assert.equal(snapshotAssignment.payload.updates.participants[0].userId, "dan");
unsubscribeDraft();
console.log("✓ Realtime loading keeps the exact latest access snapshot for assignment and ignores stale access responses");
