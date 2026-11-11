import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { PickHistoryTracker, PICK_ANNOUNCEMENT_DURATION_MS } from "../src/lib/pickAnnouncements.ts";
import { getNhlTeamNameLines, getTeamNameLines } from "../src/lib/nhlTeamNames.ts";
import { defaultDraftItems } from "../src/lib/snakeDraft.ts";
import { getTeamsForSport } from "../src/lib/sportsTeams.ts";

assert.equal(defaultDraftItems.length, 32);
for (const team of defaultDraftItems) {
  const lines = getNhlTeamNameLines(team);
  assert.equal(lines.length, 2, team.name);
  assert.equal(lines.join(" "), team.name);
  assert.deepEqual(getNhlTeamNameLines({ ...team, id: "legacy-id" }), lines);
}
for (const [id, expected] of [
  ["toronto-maple-leafs", ["Toronto", "Maple Leafs"]],
  ["new-york-rangers", ["New York", "Rangers"]],
  ["vegas-golden-knights", ["Vegas", "Golden Knights"]],
  ["los-angeles-kings", ["Los Angeles", "Kings"]],
  ["utah-mammoth", ["Utah", "Mammoth"]],
  ["seattle-kraken", ["Seattle", "Kraken"]],
  ["montreal-canadiens", ["Montreal", "Canadiens"]],
]) assert.deepEqual(getNhlTeamNameLines(defaultDraftItems.find((team) => team.id === id)), expected);
assert.deepEqual(getNhlTeamNameLines({ id: "custom", name: "Custom multi word team", sport: "NHL", logo: "" }), ["Custom multi word team"]);
for (const sport of ["NBA", "NFL", "MLB"]) {
  for (const team of getTeamsForSport(sport)) {
    const lines = getTeamNameLines(team);
    assert.equal(lines.join(" "), team.name, team.name);
    if (team.name.length > 14) assert.equal(lines.length, 2, team.name);
    else assert.deepEqual(lines, [team.name], team.name);
  }
}
for (const [sport, id, expected] of [
  ["NBA", "nba-golden-state-warriors", ["Golden State", "Warriors"]],
  ["NBA", "nba-new-york-knicks", ["New York", "Knicks"]],
  ["NBA", "nba-portland-trail-blazers", ["Portland", "Trail Blazers"]],
  ["NFL", "nfl-san-francisco-49ers", ["San Francisco", "49ers"]],
  ["NFL", "nfl-tampa-bay-buccaneers", ["Tampa Bay", "Buccaneers"]],
  ["MLB", "mlb-los-angeles-dodgers", ["Los Angeles", "Dodgers"]],
]) {
  assert.deepEqual(getTeamNameLines(getTeamsForSport(sport).find((team) => team.id === id)), expected);
}
console.log("✓ All league names use explicit geographic/nickname lines when long; NHL output remains unchanged");

const require = createRequire(import.meta.url);
const confirmed = { fromCache: false, hasPendingWrites: false };
const draft = {
  participants: [{ name: "Dan" }, { name: "Eva" }],
  draftItems: [
    { id: "boston", name: "Boston Bruins", sport: "NHL", logo: "/logos/nhl/boston-bruins.png" },
    { id: "dallas", name: "Dallas Stars", sport: "NHL", logo: "/logos/nhl/dallas-stars.png" },
    { id: "anaheim", name: "Anaheim Ducks", sport: "NHL", logo: "/logos/nhl/anaheim-ducks.png" },
  ],
  history: [{ type: "pick", participantIndex: 0, itemId: "boston" }],
};
const tracker = new PickHistoryTracker();
assert.deepEqual(tracker.observe("draft:dan", draft, { ...confirmed, fromCache: true }), []);
assert.deepEqual(tracker.observe("draft:dan", draft, confirmed), []);
assert.deepEqual(tracker.observe("draft:dan", draft, confirmed), []);
draft.history.push({ type: "pick", participantIndex: 1, itemId: "dallas", automatic: true });
assert.deepEqual(tracker.observe("draft:dan", draft, { ...confirmed, hasPendingWrites: true }), []);
assert.deepEqual(tracker.observe("draft:dan", draft, { ...confirmed, fromCache: true }), []);
let queue = tracker.observe("draft:dan", draft, confirmed);
assert.equal(queue.length, 1);
assert.equal(queue[0].participantName, "Eva");
assert.equal(queue[0].item.logo, "/logos/nhl/dallas-stars.png");
assert.equal(queue[0].automatic, true);
assert.deepEqual(tracker.observe("draft:dan", draft, confirmed), []);
console.log("✓ Only confirmed server history produces events; cached/pending snapshots, initial history and duplicates stay silent");

draft.history.push(
  { type: "skip", participantIndex: 0 },
  { type: "replace", participantIndex: 1, newItemId: "boston" },
  { type: "pick", participantIndex: 0, itemId: "anaheim" },
  { type: "pick", participantIndex: 1, itemId: "missing", itemName: "Legacy team", automatic: true },
);
queue.push(...tracker.observe("draft:dan", draft, confirmed));
assert.deepEqual(queue.map((event) => event.participantName), ["Eva", "Dan", "Eva"]);
assert.deepEqual(queue.map((event) => event.automatic), [true, false, true]);
assert.deepEqual(queue.map((event) => event.id), ["draft:dan:1", "draft:dan:4", "draft:dan:5"]);
assert.equal(queue[2].item.name, "Legacy team");
assert.deepEqual(tracker.observe("draft:dan", { ...draft, history: draft.history.slice(0, 2) }, confirmed), []);
assert.deepEqual(tracker.observe("draft:dan", draft, confirmed), []);
assert.deepEqual(new PickHistoryTracker().observe("draft:dan", draft, confirmed), []);
assert.deepEqual(tracker.observe("other:dan", draft, confirmed), []);
assert.deepEqual(tracker.observe("other:eva", draft, confirmed), []);
console.log("✓ Manual/immediate/Cron picks queue in order, including batched picks; skip/replacement, F5, stale data and scope changes never replay history");

const compiled = ts.transpileModule(readFileSync(new URL("../src/components/PickAnnouncement.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
let now = 0;
let effectDeps;
let effectCleanup;
let timeout;
let timerCount = 0;
const testModule = { exports: {} };
const portalTarget = {};
runInNewContext(compiled, {
  module: testModule, exports: testModule.exports,
  require: (name) => {
    if (name === "react") return {
      useEffect: (callback, deps) => {
        if (!effectDeps || deps.some((value, index) => value !== effectDeps[index])) {
          effectCleanup?.();
          effectDeps = deps;
          effectCleanup = callback();
        }
      },
    };
    if (name === "next/image") return { __esModule: true, default: (props) => React.createElement("img", Object.fromEntries(Object.entries(props).filter(([key]) => key !== "unoptimized"))) };
    if (name === "react-dom") return { createPortal: (node, target) => { assert.equal(target, portalTarget); return node; } };
    if (name === "@/lib/nhlTeamNames") return { getNhlTeamNameLines, getTeamNameLines };
    if (name === "@/components/TeamLogo") {
      return { TeamLogo: ({ team, className }) => React.createElement("span", { className }, team.name) };
    }
    if (name === "@/lib/pickAnnouncements") return { PICK_ANNOUNCEMENT_DURATION_MS };
    return require(name);
  },
  window: {
    setTimeout: (callback, delay) => { timeout = { callback, at: now + delay, id: ++timerCount }; return timeout.id; },
    clearTimeout: (id) => { if (timeout?.id === id) timeout = null; },
  },
  document: { body: portalTarget },
});
const complete = (id) => { queue = queue.filter((event) => event.id !== id); };
function render() {
  return renderToStaticMarkup(React.createElement(testModule.exports.PickAnnouncement, { event: { ...queue[0] }, onComplete: complete }));
}
const html = render();
assert.match(html, /PRÁVĚ VYBRÁNO/);
assert.match(html, /Eva vybral/);
assert.match(html, /class="block">Dallas<\/span><span class="block">Stars<\/span>/);
assert.match(html, /Automatický výběr/);
assert.match(html, /role="status"/);
assert.match(html, /pointer-events-none fixed inset-0 z-\[100\] flex items-center justify-center/);
assert.match(html, /h-24 w-24/);
assert.match(html, /text-center/);
assert.equal(timeout.at, 2000);
now = 500;
render();
assert.equal(timerCount, 1);
for (const [sport, id, first, second] of [
  ["NBA", "nba-golden-state-warriors", "Golden State", "Warriors"],
  ["NBA", "nba-new-york-knicks", "New York", "Knicks"],
  ["NFL", "nfl-san-francisco-49ers", "San Francisco", "49ers"],
  ["NFL", "nfl-tampa-bay-buccaneers", "Tampa Bay", "Buccaneers"],
  ["MLB", "mlb-los-angeles-dodgers", "Los Angeles", "Dodgers"],
]) {
  queue[0] = { ...queue[0], item: getTeamsForSport(sport).find((team) => team.id === id) };
  const announcement = render();
  assert.match(announcement, new RegExp(`class="block">${first}<\\/span><span class="block">${second}<\\/span>`));
}
console.log("✓ Pick announcements keep geography and team names together for long NBA, NFL and MLB names");
assert.equal(timeout.at, 2000);
const staleTimeout = timeout;
queue = queue.slice(1);
now = 1000;
const manual = render();
assert.match(manual, /Dan vybral/);
assert.match(manual, /class="block">Anaheim<\/span><span class="block">Ducks<\/span>/);
assert.doesNotMatch(manual, /Automatický výběr/);
assert.equal(timeout.at, 3000);
staleTimeout.callback();
assert.equal(queue[0].participantName, "Dan");
queue = queue.slice(1);
now = 1500;
assert.match(render(), /Legacy team/);
assert.equal(timeout.at, 3500);
now = 3500;
timeout.callback();
effectCleanup();
assert.equal(queue.length, 0);
assert.equal(timeout, null);
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
assert.match(css, /animation: pick-broadcast 2s/);
assert.match(css, /prefers-reduced-motion: reduce/);
console.log("✓ Broadcast keeps its centered portal and content; each replacement gets exactly 2s and stale callbacks cannot dismiss a newer pick");
