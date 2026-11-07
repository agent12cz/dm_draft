import type { Firestore, DocumentReference, DocumentData, Transaction } from "firebase/firestore";

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
  db: Firestore,
  firestoreApi: DrawFirestore,
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
  const draftRef = firestoreApi.doc(db, "drafts", draftId);

  await firestoreApi.runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(draftRef);
    if (!snapshot.exists()) throw new ParticipantDrawError("not-found");
    const data = snapshot.data();
    if (data.participantOrderDrawn === true) throw new ParticipantDrawError("already-drawn");
    if ((data.status ?? "waiting") !== "waiting") throw new ParticipantDrawError("not-waiting");
    const current = ((data.participants ?? []) as T[]).map(normalize);
    if (current.length !== initialIds.length || current.some((participant, index) => participant.id !== initialIds[index])) {
      throw new ParticipantDrawError("participants-changed");
    }
    if (new Set(current.map((participant) => participant.id)).size !== current.length) {
      throw new ParticipantDrawError("participants-changed");
    }
    transaction.update(draftRef, {
      participants: order.map((index) => current[index]),
      participantOrderDrawn: true,
      updatedAt: firestoreApi.serverTimestamp(),
    });
  });
}
