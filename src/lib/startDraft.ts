import type { DocumentData, DocumentReference, Firestore, Transaction } from "firebase/firestore";
import { callFirestoreWorker } from "@/lib/firestoreWorker";

type Participant = {
  id: string;
  name: string;
  userId?: string;
  uid?: string;
};

type StartFirestore = {
  doc: (db: Firestore, collection: string, id: string) => DocumentReference<DocumentData>;
  runTransaction: <T>(db: Firestore, update: (transaction: Transaction) => Promise<T>) => Promise<T>;
  serverTimestamp: () => unknown;
};

export class StartDraftError extends Error {}

export async function startDraft<T extends Participant>(
  _db: Firestore,
  _firestoreApi: StartFirestore,
  draftId: string,
  expectedParticipants: T[],
  participantNames: string[],
  finalTeamRanking: string[],
  expectedTeamRanking: string[] | undefined,
  normalize: (participant: T, index: number) => T,
  participantSnapshot?: Array<Record<string, unknown>>,
): Promise<void> {
  const current = expectedParticipants.map(normalize);
  const nextParticipants = current.map((participant, index) => ({
    ...participant,
    name: (participantNames[index] ?? participant.name).trim(),
  }));
  await callFirestoreWorker("draft.start", {
    draftId,
    expectedParticipants: participantSnapshot ?? current,
    expectedTeamRanking: expectedTeamRanking ?? [],
    participants: nextParticipants,
    teamRanking: finalTeamRanking,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("mezitím změnil")) {
      throw new StartDraftError("Draft se mezitím změnil. Zkontrolujte aktuální údaje a spusťte jej znovu.");
    }
    throw error;
  });
}
