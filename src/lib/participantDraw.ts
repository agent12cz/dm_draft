import type { Firestore, DocumentReference, DocumentData, Transaction } from "firebase/firestore";
import { callFirestoreWorker } from "@/lib/firestoreWorker";

type Participant = { id: string };

type DrawFirestore = {
  doc: (db: Firestore, collection: string, id: string) => DocumentReference<DocumentData>;
  runTransaction: <T>(db: Firestore, update: (transaction: Transaction) => Promise<T>) => Promise<T>;
  serverTimestamp: () => unknown;
};

export class ParticipantDrawError extends Error {
  constructor(public readonly reason: "already-drawn" | "not-waiting" | "participants-changed" | "not-found") {
    super(reason);
  }
}

export function animateParticipantDraw(onFrame: (frame: number) => void, onComplete: () => void): () => void {
  const startedAt = Date.now();
  let step = 0;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 5000) {
      onComplete();
      return;
    }
    onFrame(++step);
    timer = setTimeout(tick, Math.min(80 + elapsed / 10, 5000 - elapsed));
  };
  timer = setTimeout(tick, 80);
  return () => clearTimeout(timer);
}

function randomIndex(max: number): number {
  const range = 0x100000000;
  const limit = range - (range % max);
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % max;
}

export async function drawParticipantOrder<T extends Participant>(
  _db: Firestore,
  _firestoreApi: DrawFirestore,
  draftId: string,
  participants: T[],
  normalize: (participant: T, index: number) => T,
): Promise<void> {
  const order = participants.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const selected = randomIndex(index + 1);
    [order[index], order[selected]] = [order[selected], order[index]];
  }
  const initialIds = participants.map((participant) => participant.id);
  const normalized = participants.map(normalize);
  await callFirestoreWorker("draft.draw", {
    draftId,
    expectedParticipantIds: initialIds,
    participants: order.map((index) => normalized[index]),
  });
}
