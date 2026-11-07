import type { DocumentData, DocumentReference, Firestore, Transaction } from "firebase/firestore";
import { callFirestoreWorker } from "@/lib/firestoreWorker";

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

export async function commitParticipantUpdate<T>(
  db: Firestore,
  firestoreApi: ParticipantFirestore,
  draftId: string,
  expected: ExpectedState<T>,
  updates: Record<string, unknown>,
  normalize: (participant: T, index: number) => T,
  options: { waiting?: boolean; reorder?: boolean; checkTurn?: boolean } = {},
): Promise<void> {
  const expectedState: Record<string, unknown> = {
    status: expected.status,
    participantOrderDrawn: Boolean(expected.participantOrderDrawn),
    participants: expected.participants.map(normalize),
  };
  if (options.checkTurn) {
    expectedState.currentPickIndex = expected.currentPickIndex ?? 0;
    expectedState.availableItemIds = expected.availableItemIds ?? [];
    expectedState.history = expected.history ?? [];
    expectedState.pickOrder = expected.pickOrder ?? [];
  }
  try {
    await callFirestoreWorker("draft.update", {
      draftId,
      expected: expectedState,
      updates,
      options,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("mezitím změnil")) {
      throw new ParticipantUpdateConflict();
    }
    throw error;
  }
}
