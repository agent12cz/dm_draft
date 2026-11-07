import type { DocumentData, DocumentReference, Firestore, Transaction } from "firebase/firestore";

type ParticipantFirestore = {
  doc: (db: Firestore, collection: string, id: string) => DocumentReference<DocumentData>;
  runTransaction: <T>(db: Firestore, update: (transaction: Transaction) => Promise<T>) => Promise<T>;
  serverTimestamp: () => unknown;
};

type ExpectedState<T> = {
  participants: T[];
  status: string;
  participantOrderDrawn?: boolean;
  currentPickIndex?: number;
  availableItemIds?: string[];
  history?: unknown[];
  pickOrder?: number[];
};

export class ParticipantUpdateConflict extends Error {
  constructor() {
    super("Draft se mezitím změnil. Zkontrolujte aktuální údaje a opakujte akci.");
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if ("isEqual" in left && typeof left.isEqual === "function") return left.isEqual(right);
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return sameValue(leftKeys, rightKeys) && leftKeys.every((key) =>
    sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

export async function commitParticipantUpdate<T>(
  db: Firestore,
  firestoreApi: ParticipantFirestore,
  draftId: string,
  expected: ExpectedState<T>,
  updates: Record<string, unknown>,
  normalize: (participant: T, index: number) => T,
  options: { waiting?: boolean; reorder?: boolean; checkTurn?: boolean } = {},
): Promise<void> {
  const ref = firestoreApi.doc(db, "drafts", draftId);
  await firestoreApi.runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new ParticipantUpdateConflict();
    const data = snapshot.data();
    const participants = ((data.participants ?? []) as T[]).map(normalize);
    const status = data.status ?? "waiting";
    if (
      status !== expected.status ||
      Boolean(data.participantOrderDrawn) !== Boolean(expected.participantOrderDrawn) ||
      !sameValue(participants, expected.participants) ||
      (options.waiting && status !== "waiting") ||
      (options.reorder && (status !== "waiting" || data.participantOrderDrawn === true)) ||
      (options.checkTurn && (
        Number(data.currentPickIndex ?? 0) !== expected.currentPickIndex ||
        !sameValue(data.availableItemIds ?? [], expected.availableItemIds) ||
        !sameValue(data.history ?? [], expected.history) ||
        !sameValue(data.pickOrder ?? [], expected.pickOrder)
      ))
    ) {
      throw new ParticipantUpdateConflict();
    }
    transaction.update(ref, { ...updates, updatedAt: firestoreApi.serverTimestamp() });
  });
}
