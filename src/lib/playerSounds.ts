"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SoundTurn = {
  scope: string;
  key: string;
  ownTurn: boolean;
  enabled: boolean;
  startedAt: number | null;
  durationSeconds: number | null;
  secondsLeft: number | null;
};

type Tone = { stop: () => void };
type SoundAudio = {
  running: () => boolean;
  tone: (delaySeconds: number, frequency: number, length: number) => () => void;
};

export class PlayerSoundController {
  private turn: SoundTurn | null = null;
  private observedScope: string | null = null;
  private tones: Tone[] = [];
  private countdownBeeps = new Set<number>();

  constructor(
    private readonly audio: SoundAudio,
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly now: () => number = Date.now,
  ) {}

  stop() {
    for (const tone of this.tones) tone.stop();
    this.tones = [];
  }

  update(turn: SoundTurn) {
    if (turn.ownTurn && turn.durationSeconds !== null && turn.startedAt === null) {
      this.stop();
      return;
    }
    const changed = this.turn?.key !== turn.key || this.turn.scope !== turn.scope;
    const rescheduled = changed || this.turn?.startedAt !== turn.startedAt ||
      this.turn?.durationSeconds !== turn.durationSeconds;
    const initial = this.observedScope !== turn.scope;
    if (rescheduled) {
      this.stop();
      if (changed) this.countdownBeeps.clear();
    }
    const storageKey = `dm-sound-turn:${turn.scope}`;
    const alreadyObserved = this.storage.getItem(storageKey) === turn.key;
    const atTurnStart = turn.durationSeconds === null ||
      (turn.secondsLeft !== null && turn.secondsLeft === turn.durationSeconds);
    const announce = atTurnStart && !initial && !alreadyObserved && (changed || !this.turn?.ownTurn);
    this.observedScope = turn.scope;
    this.turn = turn;
    if (turn.ownTurn && atTurnStart) this.storage.setItem(storageKey, turn.key);

    const deadline = turn.startedAt !== null && turn.durationSeconds !== null
      ? turn.startedAt + turn.durationSeconds * 1000
      : null;
    if (!turn.ownTurn || !turn.enabled || !this.audio.running() ||
      (deadline !== null && deadline <= this.now())) {
      this.stop();
      return;
    }
    if (announce) {
      for (const delay of [0, 0.18]) {
        if (deadline === null || this.now() + (delay + 0.12) * 1000 < deadline) {
          this.tones.push({
            stop: this.audio.tone(delay, delay === 0 ? 660 : 880, 0.12),
          });
        }
      }
    }
    const second = turn.secondsLeft;
    if (second !== null && second >= 1 && second <= 5 && !this.countdownBeeps.has(second)) {
      this.countdownBeeps.add(second);
      this.tones.push({
        stop: this.audio.tone(0, second === 1 ? 1040 : 780, second === 1 ? 0.15 : 0.09),
      });
    }
  }
}

function playTone(context: AudioContext, delay: number, frequency: number, length: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const at = context.currentTime + Math.max(0, delay);
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.08, at + 0.008);
  gain.gain.linearRampToValueAtTime(0, at + length);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
  oscillator.start(at);
  oscillator.stop(at + length);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setValueAtTime(0, context.currentTime);
    oscillator.stop();
  };
}

export function usePlayerSounds(turn: SoundTurn | null, setEnabled: (enabled: boolean) => void) {
  const controller = useRef<PlayerSoundController | null>(null);
  const context = useRef<AudioContext | null>(null);
  const activating = useRef(false);
  const mounted = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = turn?.enabled ?? false;

  const reportError = useCallback((failure: unknown) => {
    console.error("Player sound notification failed.", failure);
    if (mounted.current) setError("Zvuk se nepodařilo aktivovat nebo uložit jeho nastavení.");
  }, []);
  const stop = useCallback(() => controller.current?.stop(), []);
  const activate = useCallback(async () => {
    if (!mounted.current || activating.current) return;
    activating.current = true;
    try {
      if (!context.current) {
        context.current = new AudioContext();
        context.current.onstatechange = () => {
          const running = context.current?.state === "running";
          if (!running) controller.current?.stop();
          if (mounted.current) setReady(running);
        };
      }
      const audio = context.current;
      await audio.resume();
      if (!mounted.current || context.current !== audio) return;
      if (audio.state !== "running") throw new Error("Audio context is suspended.");
      setReady(true);
      setError(null);
    } catch (failure) {
      reportError(failure);
    } finally {
      activating.current = false;
    }
  }, [reportError]);

  useEffect(() => {
    mounted.current = true;
    try {
      controller.current = new PlayerSoundController({
        running: () => context.current?.state === "running",
        tone: (delay, frequency, length) => {
          if (!context.current) throw new Error("Audio context is not activated.");
          return playTone(context.current, delay, frequency, length);
        },
      }, window.sessionStorage);
      setEnabled(window.localStorage.getItem("dm-draft-sound-enabled") !== "false");
    } catch (failure) {
      reportError(failure);
    }
    return () => {
      mounted.current = false;
      controller.current?.stop();
      controller.current = null;
      const audio = context.current;
      context.current = null;
      if (audio) {
        audio.onstatechange = null;
        void audio.close().catch(reportError);
      }
    };
  }, [reportError, setEnabled]);

  useEffect(() => {
    if (!enabled || ready) return;
    const handleInteraction = () => { void activate(); };
    window.addEventListener("pointerdown", handleInteraction);
    window.addEventListener("keydown", handleInteraction);
    return () => {
      window.removeEventListener("pointerdown", handleInteraction);
      window.removeEventListener("keydown", handleInteraction);
    };
  }, [activate, enabled, ready]);

  const scope = turn?.scope;
  const key = turn?.key;
  const ownTurn = turn?.ownTurn;
  const startedAt = turn?.startedAt;
  const durationSeconds = turn?.durationSeconds;
  const secondsLeft = turn?.secondsLeft;
  useEffect(() => {
    if (scope === undefined || key === undefined || ownTurn === undefined ||
      startedAt === undefined || durationSeconds === undefined || secondsLeft === undefined) {
      stop();
      return;
    }
    try {
      controller.current?.update({ scope, key, ownTurn, enabled, startedAt, durationSeconds, secondsLeft });
    } catch (failure) {
      stop();
      reportError(failure);
    }
    if (!ownTurn || startedAt === null || durationSeconds === null) return;
    const timeout = window.setTimeout(stop, Math.max(0, startedAt + durationSeconds * 1000 - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [scope, key, ownTurn, enabled, startedAt, durationSeconds, secondsLeft, ready, reportError, stop]);

  const toggle = useCallback(() => {
    const nextEnabled = !enabled;
    if (!nextEnabled) stop();
    setEnabled(nextEnabled);
    try {
      window.localStorage.setItem("dm-draft-sound-enabled", String(nextEnabled));
    } catch (failure) {
      reportError(failure);
    }
    if (nextEnabled) void activate();
  }, [activate, enabled, reportError, setEnabled, stop]);

  return { ready, error, activate, toggle, stop };
}
