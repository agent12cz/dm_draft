import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PlayerSoundController } from "../src/lib/playerSounds.ts";

function fixture(sharedStorage = new Map()) {
  let now = 0;
  let running = true;
  const tones = [];
  const storage = {
    getItem: (key) => sharedStorage.get(key) ?? null,
    setItem: (key, value) => sharedStorage.set(key, value),
  };
  const audio = {
    running: () => running,
    tone: (delay, frequency, length) => {
      const tone = { at: now + delay * 1000, frequency, length, stopped: false };
      tones.push(tone);
      return () => { tone.stopped = true; };
    },
  };
  const controller = new PlayerSoundController(audio, storage, () => now);
  const turn = {
    scope: "draft:player", key: "draft-0-0", ownTurn: false, enabled: true,
    startedAt: 0, durationSeconds: 15, secondsLeft: 15,
  };
  return { controller, turn, tones, storage: sharedStorage,
    setNow: (value) => { now = value; }, setRunning: (value) => { running = value; } };
}

{
  const test = fixture();
  test.controller.update(test.turn);
  const next = { ...test.turn, key: "draft-1-0", ownTurn: true };
  test.controller.update(next);
  assert.deepEqual(test.tones.slice(0, 2).map((tone) => tone.at), [0, 180]);
  test.setNow(9000);
  test.controller.update({ ...next, secondsLeft: 6 });
  assert.equal(test.tones.length, 2);
  for (const second of [5, 4, 3, 2, 1]) {
    test.setNow((15 - second) * 1000);
    test.controller.update({ ...next, secondsLeft: second });
    test.controller.update({ ...next, secondsLeft: second });
  }
  test.setNow(15_000);
  test.controller.update({ ...next, secondsLeft: 0 });
  assert.equal(test.tones.length, 7);
  assert.deepEqual(test.tones.slice(2).map((tone) => tone.at), [10_000, 11_000, 12_000, 13_000, 14_000]);
  assert.ok(test.tones.at(-1).frequency > test.tones.at(-2).frequency);
  test.setNow(15_000);
  test.controller.update(next);
  assert.ok(test.tones.every((tone) => tone.stopped));
  console.log("✓ A new own turn beeps once at displayed 5/4/3/2/1, never at 6 or 0");
}

{
  const test = fixture();
  const own = { ...test.turn, ownTurn: true };
  test.controller.update(test.turn);
  test.controller.update(own);
  assert.equal(test.tones.length, 2);
  test.controller.update({ ...own });
  assert.equal(test.tones.length, 2);
  for (const second of [5, 4, 3, 2, 1]) {
    test.controller.update({ ...own, secondsLeft: second });
  }
  assert.equal(test.tones.length, 7);
  test.controller.stop();
  const reload = fixture(test.storage);
  reload.controller.update(own);
  assert.equal(reload.tones.length, 0);
  const delayedTimestamp = fixture();
  delayedTimestamp.controller.update({ ...own, startedAt: null });
  delayedTimestamp.controller.update({ ...own, secondsLeft: 3 });
  assert.equal(delayedTimestamp.tones.length, 1);
  console.log("✓ Repeated snapshots do not duplicate countdown signals; late timestamps ring only the displayed second");
}

{
  const test = fixture();
  test.controller.update(test.turn);
  test.controller.update({ ...test.turn, key: "other-turn" });
  assert.equal(test.tones.length, 0);
  test.setRunning(false);
  const own = { ...test.turn, key: "own", ownTurn: true, secondsLeft: 3 };
  test.controller.update(own);
  assert.equal(test.tones.length, 0);
  test.setRunning(true);
  test.controller.update(own);
  assert.deepEqual(test.tones.map((tone) => tone.at), [0]);
  assert.equal(test.tones.length, 1);
  console.log("✓ Other players/viewers stay silent; activation beeps only for the currently displayed second");
}

{
  const test = fixture();
  test.controller.update(test.turn);
  const lateOwnTurn = { ...test.turn, key: "late-own-turn", ownTurn: true, secondsLeft: 6 };
  test.controller.update(lateOwnTurn);
  assert.equal(test.tones.length, 0);
  test.controller.update({ ...lateOwnTurn, secondsLeft: 5 });
  assert.equal(test.tones.length, 1);
  test.controller.stop();
  test.controller.update({ ...lateOwnTurn, ownTurn: false, key: "after-manual-pick" });
  const nextOwnTurn = { ...lateOwnTurn, key: "after-auto-pick", secondsLeft: 15 };
  test.controller.update(nextOwnTurn);
  assert.equal(test.tones.length, 3);
  test.controller.update({ ...nextOwnTurn, secondsLeft: 6 });
  assert.equal(test.tones.length, 3);
  test.controller.update({ ...nextOwnTurn, secondsLeft: 5 });
  assert.equal(test.tones.length, 4);
  console.log("✓ Late/manual/automatic turn changes never sound at 6, and the next own turn starts a fresh count");
}

{
  const test = fixture();
  const own = { ...test.turn, ownTurn: true };
  test.controller.update(own);
  test.controller.update({ ...own, secondsLeft: 5 });
  test.controller.update({ ...own, enabled: false });
  assert.ok(test.tones.every((tone) => tone.stopped));
  test.controller.update({ ...own, secondsLeft: 4 });
  test.controller.update({ ...own, secondsLeft: 4 });
  for (const second of [3, 2, 1]) test.controller.update({ ...own, secondsLeft: second });
  assert.equal(test.tones.length, 5);
  test.controller.stop();
  assert.ok(test.tones.every((tone) => tone.stopped));
  console.log("✓ Muting cancels audio immediately; unmuting plays only future displayed seconds, without duplicates");
}

{
  const test = fixture();
  test.controller.update({ ...test.turn, ownTurn: true });
  test.setNow(2000);
  test.controller.update({ ...test.turn, key: "next", ownTurn: false });
  assert.ok(test.tones.every((tone) => tone.stopped));
  const noLimit = { ...test.turn, key: "unlimited", ownTurn: true, durationSeconds: null };
  test.controller.update(noLimit);
  assert.equal(test.tones.length, 2);
  assert.deepEqual(test.tones.map((tone) => tone.at), [2000, 2180]);
  test.controller.update({ ...noLimit, ownTurn: false });
  assert.ok(test.tones.every((tone) => tone.stopped));
  console.log("✓ Turn end, pause, completion and manual stop cancel all tones; untimed turns have no countdown");
}

{
  const test = fixture();
  test.controller.update(test.turn);
  test.controller.update({ ...test.turn, key: "player-1", ownTurn: true });
  test.controller.update({ ...test.turn, scope: "draft:other-account", key: "player-1", ownTurn: false });
  assert.ok(test.tones.every((tone) => tone.stopped));
  console.log("✓ Account changes cancel audio and reset initial-observation suppression");
}

{
  const test = fixture();
  const lobby = { ...test.turn, startedAt: null };
  test.controller.update(lobby);
  const started = { ...test.turn, ownTurn: true };
  test.controller.update(started);
  assert.equal(test.tones.length, 2);
  test.setNow(11_200);
  test.controller.update({ ...started, ownTurn: false });
  test.controller.update({ ...started, startedAt: 2000 });
  assert.equal(test.tones.filter((tone) => tone.frequency === 660 || tone.frequency === 880).length, 2);
  assert.equal(test.tones.length, 2);
  test.controller.update({ ...started, startedAt: 2000 });
  assert.equal(test.tones.length, 2);
  console.log("✓ The first turn after waiting is announced; clock corrections never replay countdown beeps");
}

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/playerSounds.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const slots = [];
let cursor = 0;
const pendingEffects = [];
const listeners = new Map();
const contexts = [];
const stored = new Map();
const timeouts = new Map();
let wallTime = 0;
let storageFails = false;
const reports = [];
class FakeAudioContext {
  constructor() {
    this.state = "suspended";
    this.currentTime = 0;
    this.destination = {};
    this.oscillators = [];
    this.gains = [];
    contexts.push(this);
  }
  async resume() { this.state = "running"; this.onstatechange?.(); }
  async close() { this.state = "closed"; }
  createOscillator() {
    const oscillator = {
      frequency: { setValueAtTime: (frequency, at) => { oscillator.frequencyValue = frequency; oscillator.at = at; } },
      connect: () => {}, disconnect: () => {},
      start: (at) => { oscillator.startAt = at; },
      stop: (at) => { oscillator.stopAt = at; oscillator.stops = (oscillator.stops ?? 0) + 1; },
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createGain() {
    const events = [];
    const gain = {
      gain: {
        setValueAtTime: (...args) => events.push(["set", ...args]),
        linearRampToValueAtTime: (...args) => events.push(["ramp", ...args]),
        cancelScheduledValues: (...args) => events.push(["cancel", ...args]),
      },
      connect: () => {}, disconnect: () => {}, events,
    };
    this.gains.push(gain);
    return gain;
  }
}
function useSlot(initial) {
  const index = cursor++;
  if (!(index in slots)) slots[index] = initial();
  return slots[index];
}
const testModule = { exports: {} };
runInNewContext(compiled, {
  module: testModule, exports: testModule.exports,
  require: (name) => name === "react" ? {
    useRef: (initial) => useSlot(() => ({ current: initial })),
    useState: (initial) => {
      const index = cursor;
      const value = useSlot(() => initial);
      return [value, (next) => { slots[index] = next; }];
    },
    useCallback: (callback, deps) => {
      const slot = useSlot(() => ({ callback, deps }));
      if (deps.some((dep, index) => dep !== slot.deps[index])) {
        slot.callback = callback;
        slot.deps = deps;
      }
      return slot.callback;
    },
    useEffect: (callback, deps) => {
      const effect = useSlot(() => ({ deps: null, cleanup: null }));
      if (!effect.deps || deps.some((dep, index) => dep !== effect.deps[index])) {
        effect.deps = deps;
        pendingEffects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); });
      }
    },
  } : require(name),
  AudioContext: FakeAudioContext,
  Date: { now: () => wallTime },
  console: { error: (...args) => reports.push(args) },
  window: {
    sessionStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => {
        if (storageFails) throw new Error("Storage unavailable");
        stored.set(key, value);
      },
    },
    addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: (event, callback) => { if (listeners.get(event) === callback) listeners.delete(event); },
    setTimeout: (callback, delay) => { const id = {}; timeouts.set(id, { callback, at: wallTime + delay }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
  },
});
let enabled = true;
let currentTurn = { scope: "draft:player", key: "initial", ownTurn: false, startedAt: 0, durationSeconds: 15, secondsLeft: 15 };
const setEnabled = (value) => { enabled = value; };
function renderHook() {
  cursor = 0;
  const value = testModule.exports.usePlayerSounds({ ...currentTurn, enabled }, setEnabled);
  while (pendingEffects.length) pendingEffects.shift()();
  return value;
}
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

let sounds = renderHook();
assert.equal(contexts.length, 0);
assert.equal(sounds.ready, false);
assert.ok(listeners.has("pointerdown") && listeners.has("keydown"));
listeners.get("pointerdown")();
await flush();
sounds = renderHook();
assert.equal(contexts.length, 1);
assert.equal(sounds.ready, true);
currentTurn = { ...currentTurn, key: "next", ownTurn: true };
sounds = renderHook();
assert.equal(contexts[0].oscillators.length, 2);
for (const secondsLeft of [6, 5, 4, 3, 2, 1, 0]) {
  currentTurn = { ...currentTurn, secondsLeft };
  sounds = renderHook();
}
assert.equal(contexts[0].oscillators.length, 7);
assert.deepEqual(contexts[0].oscillators.slice(0, 2).map((tone) => tone.startAt), [0, 0.18]);
assert.deepEqual(contexts[0].oscillators.slice(2).map((tone) => tone.frequencyValue), [780, 780, 780, 780, 1040]);
assert.ok(contexts[0].gains.every((gain) => gain.events.some((event) => event[0] === "ramp")));
renderHook();
assert.equal(contexts[0].oscillators.length, 7);
sounds.toggle();
assert.equal(enabled, false);
assert.equal(stored.get("dm-draft-sound-enabled"), "false");
assert.ok(contexts[0].oscillators.every((oscillator) => oscillator.stops === 2));
renderHook();
wallTime = 11_500;
sounds = renderHook();
sounds.toggle();
await flush();
sounds = renderHook();
assert.equal(enabled, true);
assert.equal(stored.get("dm-draft-sound-enabled"), "true");
assert.equal(contexts[0].oscillators.length, 7);
storageFails = true;
sounds.toggle();
sounds = renderHook();
assert.ok(sounds.error);
assert.ok(reports.length);
storageFails = false;
sounds.toggle();
await flush();
sounds = renderHook();
const beforeSuspension = contexts[0].oscillators.length;
contexts[0].state = "suspended";
contexts[0].onstatechange();
assert.ok(contexts[0].oscillators.every((oscillator) => oscillator.stops >= 1));
wallTime = 12_500;
sounds = renderHook();
assert.equal(sounds.ready, false);
listeners.get("keydown")();
await flush();
sounds = renderHook();
assert.equal(sounds.ready, true);
assert.equal(contexts[0].oscillators.length, beforeSuspension);
assert.equal(timeouts.size, 1);
const expiry = [...timeouts.values()][0];
assert.equal(expiry.at, 15_000);
wallTime = 15_000;
expiry.callback();
assert.ok(contexts[0].oscillators.every((oscillator) => oscillator.stops >= 2));
const afterExpiryOscillators = contexts[0].oscillators.length;
currentTurn = { ...currentTurn, key: "after-expiry", startedAt: 15_000 };
sounds = renderHook();
assert.equal(contexts[0].oscillators.length, afterExpiryOscillators);
sounds.stop();
assert.ok(contexts[0].oscillators.every((oscillator) => oscillator.stops >= 2));
currentTurn = { ...currentTurn, ownTurn: false };
renderHook();
for (const slot of slots) slot?.cleanup?.();
await flush();
assert.equal(contexts[0].state, "closed");
assert.equal(listeners.size, 0);
assert.equal(timeouts.size, 0);
console.log("✓ Web Audio activates on interaction, persists mute, resumes future-only after suspension, stops at expiry and cleans up");

slots.length = 0;
stored.set("dm-draft-sound-enabled", "false");
enabled = true;
renderHook();
assert.equal(enabled, false);
renderHook();
assert.equal(listeners.size, 0);
assert.equal(contexts.length, 1);
for (const slot of slots) slot?.cleanup?.();
await flush();
slots.length = 0;
stored.delete("dm-draft-sound-enabled");
enabled = false;
renderHook();
assert.equal(enabled, true);
renderHook();
assert.ok(listeners.has("pointerdown") && listeners.has("keydown"));
assert.equal(contexts.length, 1);
for (const slot of slots) slot?.cleanup?.();
await flush();
console.log("✓ Saved OFF survives reopening; first visits default to ON without creating audio before user interaction");

const playerSource = readFileSync(new URL("../src/components/PlayerDraftPage.tsx", import.meta.url), "utf8");
assert.doesNotMatch(playerSource, /new Audio\(|your-turn\.mp3/);
assert.match(playerSource, /ownTurn: isCurrentUserTurn && !isCompleted && !isSubmittingPick && !isTurnExpired/);
assert.match(playerSource, /sounds\.stop\(\);\s*setIsSubmittingPick\(true\)/);
assert.match(playerSource, /Zapnout zvuk/);
console.log("✓ Player UI gates sounds to the current player and stops before a manual pick, without audio files");
