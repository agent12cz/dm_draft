import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/app/draft/[code]/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(`${source}\nexport { DraftDetailPageContent as TestContent };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

const now = Date.now();
let fixture;
let stateIndex = 0;
let captureEffects = false;
let snapshotListener;
let snapshotDraft;
let resultsTab = "teams";
const effects = [];
const hooks = {
  useState(initial) {
    const index = stateIndex++;
    const overrides = [fixture, false, now, fixture.participants.map((participant) => participant.name)];
    const isResultsTab = initial === "teams";
    return [isResultsTab ? resultsTab : index < overrides.length ? overrides[index] : typeof initial === "function" ? initial() : initial,
      (value) => { if (index === 0) snapshotDraft = value; if (isResultsTab) resultsTab = value; }];
  },
  useEffect(callback) { if (captureEffects) effects.push(callback); },
  useRef: (initial) => ({ current: initial }),
  useMemo: (callback) => callback(),
  useCallback: (callback) => callback,
};
const container = ({ children, className }) => React.createElement("div", { className }, children);
const chat = () => React.createElement("div", { "data-test": "chat" }, "Chat placeholder");
const testModule = { exports: {} };
runInNewContext(compiled, {
  module: testModule,
  exports: testModule.exports,
  require(name) {
    if (name === "react") return hooks;
    if (name === "next/link") return { __esModule: true, default: container };
    if (name === "next/navigation") return { useParams: () => ({ code: "TEST" }) };
    if (name === "@/components/AuthProvider") return { useAuth: () => ({ user: { uid: "admin" }, profile: { role: "admin" } }) };
    if (name === "@/components/DraftChat") return { DraftChat: chat };
    if (name === "@/components/Navbar") return { Navbar: () => null };
    if (name === "@/components/PageContainer") return { PageContainer: container };
    if (name === "@/components/Card") return { Card: container };
    if (name === "@/app/auth-guard") return { __esModule: true, default: container };
    if (name === "@/lib/firebase") return { getFirebaseClient: async () => ({ db: {}, firestoreApi: {
      doc: () => "draft",
      onSnapshot: (_ref, callback) => { snapshotListener = callback; return () => {}; },
    } }) };
    if (name === "@/lib/firestoreWorker") return {
      callFirestoreWorker: async () => ({}),
      getDraftPrivateAccess: async () => ({
        authorized: true,
        role: "owner",
        participants: fixture?.participants ?? [],
      }),
    };
    if (name === "@/lib/snakeDraft") return { normalizeDraftItem: (item) => item };
    if (name.startsWith("@/lib/")) return {};
    return require(name);
  },
  console,
  Date,
  Intl,
  Map,
  Set,
});

function createDraft(picks) {
  const teams = Array.from({ length: 32 }, (_, index) => ({
    id: `team-${index + 1}`, name: `Tým ${index + 1}`, sport: "NHL", logo: "",
  }));
  const pickOrder = Array.from({ length: 32 }, (_, index) => {
    const round = Math.floor(index / 8);
    return round % 2 === 0 ? index % 8 : 7 - index % 8;
  });
  const participants = Array.from({ length: 8 }, (_, index) => ({
    id: `participant-${index}`, name: `Hráč ${index + 1}`, status: "ready", picks: [],
  }));
  const history = teams.slice(0, picks).map((team, index) => {
    const participantIndex = pickOrder[index];
    participants[participantIndex].picks.push(team.id);
    return { type: "pick", participantIndex, itemId: team.id };
  });
  return {
    id: "TEST", code: "TEST", title: "Testovací draft", sport: "NHL",
    status: picks === 32 ? "completed" : "drafting",
    participantCount: 8, participants, currentPickIndex: picks, pickOrder,
    draftItems: teams, availableItemIds: teams.slice(picks).map((team) => team.id),
    history, turnDurationSeconds: 30, turnStartedAt: { toDate: () => new Date(now) },
    productName: "Box A", productSeason: "2025/26", productPrice: 100,
    boxCount: 2, boxPrice: 100, margin: 20, targetBreakPrice: 220,
    boxes: [
      { productName: "Box A", productSeason: "2025/26", boxCount: 1, boxPrice: 100, productImageUrl: "/box-a.png" },
      { productName: "Box B", productSeason: "2024/25", boxCount: 1, boxPrice: 100, productImageUrl: "/box-b.png" },
    ],
  };
}

function render(picks, boxes, status) {
  fixture = createDraft(picks);
  if (boxes !== undefined) fixture.boxes = boxes;
  if (status !== undefined) fixture.status = status;
  stateIndex = 0;
  return renderToStaticMarkup(React.createElement(testModule.exports.TestContent));
}

const active = render(10);
assert.match(active, /NA TAHU/);
assert.match(active, /Hráč 6/);
assert.match(active, /Tah 11 z 32/);
assert.match(active, /30 s/);
assert.match(active, /Tým 10/);
assert.equal((active.match(/data-test="chat"/g) ?? []).length, 1);
assert.ok(active.indexOf("data-test=\"chat\"") < active.indexOf("Účastníci</h2>"));
assert.doesNotMatch(active, /Vrátit poslední tah/);
assert.match(active, /Přeskočit účastníka/);
assert.match(active, /Vybrat tým za aktuálního účastníka/);
for (let index = 1; index <= 8; index += 1) assert.match(active, new RegExp(`Hráč ${index}`));
assert.match(active, /src="\/box-a\.png"[^>]*object-contain/);
assert.match(active, /src="\/box-b\.png"[^>]*object-contain/);
assert.match(active, /Box A/);
assert.match(active, /Box B/);
console.log("✓ Eight-player active draft shows the current turn, timer, last pick, chat, controls and full box images");

assert.match(active, /role="tablist" aria-label="Přehled výběrů"/);
assert.match(active, /id="admin-teams-panel" aria-labelledby="admin-teams-tab"(?! hidden)/);
assert.match(active, /id="admin-history-panel" aria-labelledby="admin-history-tab" hidden/);
resultsTab = "history";
const historyTab = render(10);
assert.match(historyTab, /id="admin-history-panel" aria-labelledby="admin-history-tab"(?! hidden)/);
assert.match(historyTab, /id="admin-teams-panel" aria-labelledby="admin-teams-tab" hidden/);
const historyPanel = historyTab.slice(historyTab.indexOf('id="admin-history-panel"'));
assert.ok(historyPanel.indexOf("Tým 10") < historyPanel.indexOf("Tým 9"));
resultsTab = "teams";
assert.equal((active.match(/data-participant-accordion="true"/g) ?? []).length, 8);
assert.doesNotMatch(active, /<details[^>]*data-participant-accordion[^>]* open/);
const accordion = active.match(/<details[^>]*data-participant-accordion[^>]*>([\s\S]*?)<\/details>/)?.[1];
assert.match(accordion, /<summary[\s\S]*?Hráč 1[\s\S]*?Připojen[\s\S]*?1 týmů[\s\S]*?<\/summary>/);
assert.doesNotMatch(accordion.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? "", /Posunout|Přiřadit|Vygenerovat/);
assert.match(accordion, /aria-label="Posunout účastníka 1 nahoru"[^>]*disabled=""/);
assert.match(accordion, /placeholder="Jméno účastníka 1" disabled=""/);
assert.match(accordion, /Vygenerovat PIN/);
assert.doesNotMatch(source, /handleUndoLastAction|Vrátit poslední tah/);
const waiting = render(0, undefined, "waiting");
assert.match(waiting, /placeholder="Jméno účastníka 1"(?! disabled="")/);
assert.doesNotMatch(waiting, /aria-label="Posunout účastníka 1 dolů"[^>]*disabled=""/);
assert.doesNotMatch(waiting, /<button[^>]*disabled=""[^>]*>\s*Přiřadit uživatele/);
console.log("✓ Results share two switchable panels; participant accordions start closed and retain controls with post-start locks");

const completed = render(32);
assert.match(completed, /Draft dokončen/);
assert.match(completed, /Dokončené výběry: 32 z 32/);
assert.match(completed, /Tým 32/);
assert.doesNotMatch(completed, /Vrátit poslední tah/);
assert.doesNotMatch(completed, /Přeskočit účastníka|Vybrat tým za aktuálního účastníka|Dostupné týmy|>Změnit<\/button>/);
assert.doesNotMatch(completed, /Tah 33 z 32|Kolo 5/);
assert.equal((completed.match(/data-test="chat"/g) ?? []).length, 1);
console.log("✓ Completed 32-pick draft keeps chat without undo or unavailable pick and replacement actions");

for (const [boxes, expected] of [
  [[{ productName: "Jeden box", productSeason: "2025/26", boxCount: 1, boxPrice: 999 }], ["Celkem: 1 box", "1× Jeden box", "2025/26"]],
  [[{ productName: "Stejné boxy", productSeason: "2024/25", boxCount: 3, boxPrice: 999 }], ["Celkem: 3 boxy", "3× Stejné boxy", "2024/25"]],
  [[{ productName: "Box A", productSeason: "2025/26", boxCount: 2, boxPrice: 999 }, { productName: "Box B", productSeason: "2023/24", boxCount: 3, boxPrice: 888 }], ["Celkem: 5 boxů", "2× Box A", "2025/26", "3× Box B", "2023/24"]],
  [[], ["Celkem: 2 boxy", "2× Box A", "2025/26"]],
]) {
  const print = render(10, boxes).match(/<section class="print-break">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(print);
  for (const text of expected) assert.ok(print.includes(text), text);
  assert.doesNotMatch(print, /Kč|Marže|999|888/);
}
console.log("✓ Print composition uses saved quantities and products, including legacy drafts, without prices");

fixture = createDraft(10);
fixture.turnStartedAt = { toDate: () => new Date(now - 10000) };
stateIndex = 0;
captureEffects = true;
renderToStaticMarkup(React.createElement(testModule.exports.TestContent));
captureEffects = false;
const cleanup = effects[0]();
for (let index = 0; index < 8; index += 1) await Promise.resolve();
assert.ok(snapshotListener);
snapshotListener({ id: "TEST", exists: () => true, data: () => fixture });
for (let index = 0; index < 8; index += 1) await Promise.resolve();
assert.ok(snapshotDraft);
fixture = snapshotDraft;
stateIndex = 0;
const snapshotMarkup = renderToStaticMarkup(React.createElement(testModule.exports.TestContent));
assert.match(snapshotMarkup, /20 s/);
cleanup();
console.log("✓ Admin countdown reads the turn start timestamp from the Firestore snapshot");
