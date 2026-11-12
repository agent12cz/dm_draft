import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React, { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { getNhlTeamNameLines, getTeamNameLines } from "../src/lib/nhlTeamNames.ts";
import { getTeamsForSport } from "../src/lib/sportsTeams.ts";
import { defaultDraftItems } from "../src/lib/snakeDraft.ts";

const require = createRequire(import.meta.url);
function load(path, mocks, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule, exports: testModule.exports,
    require: (name) => name in mocks ? mocks[name] : require(name),
    console, Error, ...globals,
  });
  return testModule.exports;
}

const requests = [];
const logs = [];
const cache = new Map();
let responseStatus = 200;
let cacheFails = false;
let pendingRequest;
const user = { uid: "player-1", email: "player1@example.test", getIdToken: async () => "player-token" };
const worker = load("../src/lib/firestoreWorker.ts", {
  "@/lib/firebase": { getFirebaseClient: async () => ({ auth: { currentUser: user } }) },
}, {
  fetch: async (url, init) => {
    requests.push({ url, init });
    if (pendingRequest) await pendingRequest;
    return Response.json({
      status: responseStatus === 200
        ? "saved"
        : responseStatus === 403
          ? "forbidden"
          : responseStatus === 409
            ? "conflict"
            : "failed",
    }, { status: responseStatus });
  },
});
const draft = {
  id: "ROOM1", title: "Test draft", code: "ROOM1", sport: "NHL", status: "waiting",
  participantCount: 2, participants: [
    { id: "p1", name: "Player One", userId: "player-1", picks: [] },
    { id: "p2", name: "Player Two", picks: [] },
  ],
  currentPickIndex: 0, pickOrder: [0, 1], availableItemIds: ["team-a", "team-b"],
  draftItems: [
    { id: "team-a", name: "Team A", logo: "", sport: "NHL" },
    { id: "team-b", name: "Team B", logo: "", sport: "NHL" },
  ],
  history: [], turnDurationSeconds: null,
  playerPriorities: { "player-1": ["team-a", "team-b"] },
};
const state = [];
const refs = [];
let stateIndex;
let refIndex;
let effects = [];
const container = ({ children }) => React.createElement("div", null, children);
const announcement = () => null;
let soundsReady = false;
let activationCount = 0;
let toggleCount = 0;
let snapshotListener;
let snapshotData = draft;
let accessDelay;
function snapshot(data = snapshotData, metadata = { fromCache: false, hasPendingWrites: false }) {
  return { id: "ROOM1", exists: () => true, data: () => data, metadata };
}
const firebase = {
  getFirebaseClient: async () => ({ db: {}, firestoreApi: {
    doc: (_db, collection, id) => {
      assert.equal(collection, "publicDrafts");
      assert.equal(id, "ROOM1");
      return "public-reference";
    },
    getDocFromServer: async () => snapshot(snapshotData),
    onSnapshot: (_ref, options, callback) => {
      assert.equal(options.includeMetadataChanges, true);
      snapshotListener = callback;
      callback(snapshot({
        ...snapshotData,
        participants: snapshotData.participants.map((participant) => ({
          id: participant.id, name: participant.name, picks: participant.picks,
        })),
      }));
      return () => {};
    },
    updateDoc: () => { throw new Error("Direct Firestore writes must not be used."); },
  } }),
};
const component = load("../src/components/PlayerDraftPage.tsx", {
  react: {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
    useEffect: (callback) => effects.push(callback),
    useRef(initial) {
      const index = refIndex++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useMemo: (callback) => callback(),
    useCallback: (callback) => callback,
  },
  "next/navigation": { useParams: () => ({ code: "ROOM1" }), useRouter: () => ({}) },
  "@/components/AuthProvider": { useAuth: () => ({ user, profile: { role: "participant" }, loading: false }) },
  "@/components/Navbar": { Navbar: () => null },
  "@/components/PageContainer": { PageContainer: container },
  "@/components/Card": { Card: container },
  "@/components/DraftChat": { DraftChat: () => null },
  "@/components/PickAnnouncement": { PickAnnouncement: announcement },
  "@/components/TeamLogo": { TeamLogo: ({ team, className }) => React.createElement("span", { className }, team.name) },
  "@/lib/pickAnnouncements": load("../src/lib/pickAnnouncements.ts", {}),
  "@/lib/nhlTeamNames": { getNhlTeamNameLines, getTeamNameLines },
  "@/lib/firebase": firebase,
  "@/lib/firestoreWorker": {
    ...worker,
    getDraftPrivateAccess: async (id) => {
      assert.equal(id, draft.id);
      if (accessDelay) await accessDelay;
      return { authorized: true, role: "participant", participantIndex: 0,
        participants: draft.participants, playerPriorities: ["team-b", "team-a"] };
    },
  },
  "@/lib/snakeDraft": { defaultDraftItems: draft.draftItems, normalizeDraftItem: (item) => item },
  "@/lib/rankings": { ensureAllTeamsInOrder: (order) => [...order] },
  "@/lib/turnCountdown": { getTurnKey: () => null, getTimeLeftForTurn: () => null },
  "@/lib/instantAutoPick": { startInstantAutoPick: () => () => {} },
  "@/lib/playerSounds": { usePlayerSounds: () => ({ ready: soundsReady, error: null, stop: () => {}, activate: () => { activationCount++; }, toggle: () => { toggleCount++; } }) },
}, {
  AbortController,
  console: { info: () => {}, error: (...args) => logs.push(args) },
  window: { localStorage: {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => {
      if (cacheFails) throw new Error("Cache unavailable");
      cache.set(key, value);
    },
  } },
});

function render() {
  stateIndex = 0;
  refIndex = 0;
  effects = [];
  return component.default();
}
function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  return predicate(node) ? node : find(node.props.children, predicate);
}
function findAll(node, predicate, matches = []) {
  if (Array.isArray(node)) node.forEach((child) => findAll(child, predicate, matches));
  else if (isValidElement(node)) {
    if (predicate(node)) matches.push(node);
    findAll(node.props.children, predicate, matches);
  }
  return matches;
}
function saveButton() {
  const button = find(render(), (node) => node.type === "button" && String(node.props.children).includes("Uložit priority"));
  assert.ok(button);
  return button;
}
function reset() {
  state.length = 0;
  state[0] = draft;
  state[1] = false;
  state[8] = "priorities";
  state[9] = "priorities";
  state[11] = ["team-b", "team-a"];
  state[12] = ["team-a", "team-b"];
  responseStatus = 200;
  cacheFails = false;
  cache.clear();
  requests.length = 0;
}
async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

reset();
let finish;
pendingRequest = new Promise((resolve) => { finish = resolve; });
saveButton().props.onClick();
await flush();
assert.equal(state[13], true);
assert.deepEqual(state[12], ["team-a", "team-b"]);
finish();
pendingRequest = null;
await flush();
assert.equal(requests.length, 1);
assert.equal(requests[0].url, "/api/firestore");
assert.equal(requests[0].init.headers.authorization, "Bearer player-token");
assert.deepEqual(JSON.parse(requests[0].init.body), {
  operation: "draft.priorities", draftId: "ROOM1", priorities: ["team-b", "team-a"],
});
assert.deepEqual([...state[12]], ["team-b", "team-a"]);
assert.deepEqual(JSON.parse(cache.get("dm-draft-priorities:ROOM1:player-1")), ["team-b", "team-a"]);
assert.equal(state[13], false);
assert.match(state[14], /úspěšně uloženy/);
console.log("✓ Player saves through the authenticated Worker API, without a client-selected UID or direct write");

reset();
responseStatus = 403;
saveButton().props.onClick();
await flush();
assert.deepEqual(state[12], ["team-a", "team-b"]);
assert.deepEqual(state[11], ["team-b", "team-a"]);
assert.equal(state[13], false);
assert.match(state[14], /Nepodařilo se uložit priority do draftu/);
assert.match(state[14], /nemáte oprávnění/);
assert.doesNotMatch(state[14], /úspěšně|uloženy v tomto prohlížeči/);
assert.equal(cache.size, 0);
assert.ok(logs.length > 0);
console.log("✓ Rejected writes remain unsaved and show the authorization failure");

reset();
cacheFails = true;
saveButton().props.onClick();
await flush();
assert.deepEqual([...state[12]], ["team-b", "team-a"]);
assert.match(state[14], /uloženy do draftu.*kopii v prohlížeči/);
console.log("✓ Browser cache failure does not undo a successful server save");

reset();
render();
const cleanup = effects[0]();
await flush();
assert.equal(state[0].participants[0].userId, user.uid);
assert.equal(state[0].participants[1].userId, undefined);
assert.deepEqual([...state[0].playerPriorities[user.uid]], ["team-b", "team-a"]);
cleanup();
console.log("✓ Public snapshots obtain the participant UID and own priorities from authorized private access");

reset();
render();
const stopAnnouncements = effects[0]();
await flush();
let releaseAccess;
accessDelay = new Promise((resolve) => { releaseAccess = resolve; });
const firstPick = { type: "pick", participantIndex: 0, itemId: "team-a" };
const secondPick = { type: "pick", participantIndex: 1, itemId: "team-b", automatic: true };
snapshotData = { ...draft, status: "drafting", history: [firstPick] };
snapshotListener(snapshot());
snapshotData = { ...snapshotData, status: "completed", history: [firstPick, secondPick] };
snapshotListener(snapshot());
assert.equal(find(render(), (node) => node.type === announcement), undefined);
releaseAccess();
accessDelay = null;
await flush();
let notice = find(render(), (node) => node.type === announcement);
assert.ok(notice);
assert.equal(notice.props.event.participantName, "Player Two");
assert.equal(notice.props.event.automatic, true);
const previousNotice = notice;
const thirdPick = { type: "pick", participantIndex: 0, itemId: "team-a" };
snapshotData = { ...snapshotData, history: [firstPick, secondPick, thirdPick] };
snapshotListener(snapshot());
await flush();
notice = find(render(), (node) => node.type === announcement);
assert.equal(notice.props.event.participantName, "Player One");
assert.notEqual(notice.props.event.id, previousNotice.props.event.id);
previousNotice.props.onComplete(previousNotice.props.event.id);
assert.equal(find(render(), (node) => node.type === announcement).props.event.id, notice.props.event.id);
snapshotListener(snapshot());
await flush();
notice.props.onComplete(notice.props.event.id);
assert.equal(find(render(), (node) => node.type === announcement), undefined);
stopAnnouncements();
render();
const reloadCleanup = effects[0]();
await flush();
assert.equal(find(render(), (node) => node.type === announcement), undefined);
reloadCleanup();
console.log("✓ Latest confirmed pick replaces the previous notice despite racing private reads; stale completion, duplicate snapshots and reopening never replay or dismiss the latest pick");

reset();
function soundButton() {
  return find(render(), (node) => node.type === "button" && String(node.props.children).includes("Zvuk"));
}
let soundControl = soundButton();
assert.match(soundControl.props.children, /Zvuk ZAP/);
assert.equal(soundControl.props["aria-pressed"], true);
assert.equal(find(render(), (node) => node.type === "button" && node.props.children === "Zapnout zvuk"), undefined);
let propagationStops = 0;
soundControl.props.onPointerDown({ stopPropagation: () => propagationStops++ });
soundControl.props.onKeyDown({ stopPropagation: () => propagationStops++ });
assert.equal(propagationStops, 2);
soundControl.props.onClick();
assert.equal(activationCount, 0);
assert.equal(toggleCount, 1);
soundsReady = true;
soundControl = soundButton();
assert.match(soundControl.props.children, /Zvuk ZAP/);
assert.equal(soundControl.props["aria-pressed"], true);
soundControl.props.onClick();
assert.equal(toggleCount, 2);
state[4] = false;
soundControl = soundButton();
assert.match(soundControl.props.children, /Zvuk VYP/);
soundControl.props.onClick();
assert.equal(toggleCount, 3);
console.log("✓ A single sound toggle defaults to ON before audio unlock and shows the user's saved preference without duplicate buttons");

reset();
draft.draftItems = defaultDraftItems;
draft.availableItemIds = defaultDraftItems.map((item) => item.id);
state[8] = "teams";
state[9] = "teams";
for (const sport of ["NHL", "NBA", "NFL", "MLB"]) {
  const teams = sport === "NHL" ? defaultDraftItems : getTeamsForSport(sport);
  draft.sport = sport;
  draft.draftItems = teams;
  draft.availableItemIds = teams.map((item) => item.id);
  const teamView = render();
  for (const item of teams) {
    const lines = getTeamNameLines(item);
    const name = findAll(teamView, (node) => node.type === "p" && Array.isArray(node.props.children))
      .find((paragraph) => paragraph.props.children.length === lines.length &&
        paragraph.props.children.every((child, index) => child.props?.children === lines[index]));
    assert.ok(name, `${sport} ${item.name}`);
    assert.match(name.props.className, /min-h-\[2\.5em\] w-full min-w-0/);
    assert.ok(name.props.children.every((line) => line.props.className === "block truncate"));
  }
}
draft.sport = "NHL";
draft.draftItems = defaultDraftItems;
draft.availableItemIds = defaultDraftItems.map((item) => item.id);
console.log("✓ Selection cards in all four leagues use explicit compact name lines without changing logo sizes");

reset();
draft.status = "drafting";
state[8] = "teams";
state[9] = "teams";
snapshotData = draft;
responseStatus = 409;
render();
const stopDraftListener = effects[0]();
await flush();
const currentTeamPick = find(render(), (node) =>
  node.type === "button" && node.props.onClick && String(node.props.children).trim() === "Vybrat");
assert.ok(currentTeamPick);
currentTeamPick.props.onClick();
await flush();
assert.equal(state[2], null, String(logs.at(-1)?.[1]));
assert.equal(state[3], false);
assert.equal(requests.at(-1).init.body.includes('"operation":"draft.pick"'), true);

responseStatus = 500;
const retryTeamPick = find(render(), (node) =>
  node.type === "button" && node.props.onClick && String(node.props.children).trim() === "Vybrat");
retryTeamPick.props.onClick();
await flush();
assert.equal(state[2], "Nepodařilo se uložit výběr.");
assert.equal(state[3], false);
stopDraftListener();
draft.status = "waiting";
snapshotData = draft;
console.log("✓ A lost pick race refreshes state without a red error; a server failure remains visible");

draft.status = "completed";
draft.currentPickIndex = 32;
draft.history = Array.from({ length: 32 }, (_, historyIndex) => ({
  type: "pick",
  participantIndex: historyIndex % 2,
  itemId: historyIndex % 2 === 0 ? "team-a" : "team-b",
}));
state[0] = draft;
state[6] = true;
const playerHistoryMarkup = renderToStaticMarkup(render());
assert.match(playerHistoryMarkup, /Tah #32<\/span>/);
assert.match(playerHistoryMarkup, /Tah #1<\/span>/);
assert.ok(
  playerHistoryMarkup.indexOf("Tah #32</span>") < playerHistoryMarkup.indexOf("Tah #31</span>") &&
    playerHistoryMarkup.indexOf("Tah #31</span>") < playerHistoryMarkup.indexOf("Tah #1</span>"),
);
state[6] = false;
draft.status = "waiting";
draft.currentPickIndex = 0;
draft.history = [];
console.log("✓ Player history displays picks 1–32 with the newest pick first");
