import type { DocumentData, DocumentReference, Firestore, Transaction } from "firebase/firestore";

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
  db: Firestore,
  firestoreApi: StartFirestore,
  draftId: string,
  expectedParticipants: T[],
  participantNames: string[],
  finalTeamRanking: string[],
  expectedTeamRanking: string[] | undefined,
  normalize: (participant: T, index: number) => T,
): Promise<void> {
  const ref = firestoreApi.doc(db, "drafts", draftId);
  await firestoreApi.runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new StartDraftError("Draft nebyl nalezen.");
    const data = snapshot.data();
    const current = ((data.participants ?? []) as T[]).map(normalize);
    const sameParticipants = current.length === expectedParticipants.length &&
      current.every((participant, index) => {
        const expected = expectedParticipants[index];
        return participant.id === expected.id &&
          participant.name === expected.name &&
          (participant.userId ?? participant.uid ?? "").trim() === (expected.userId ?? expected.uid ?? "").trim();
      });
    const currentRanking = (data.teamRanking ?? []) as string[];
    const expectedRanking = expectedTeamRanking ?? [];
    const sameRanking = currentRanking.length === expectedRanking.length &&
      currentRanking.every((id, index) => id === expectedRanking[index]);

    if ((data.status ?? "waiting") !== "waiting" || !sameParticipants || !sameRanking) {
      throw new StartDraftError("Draft se mezitím změnil. Zkontrolujte aktuální údaje a spusťte jej znovu.");
    }

    const nextParticipants = current.map((participant, index) => ({
      ...participant,
      name: (participantNames[index] ?? participant.name).trim(),
    }));
    const userIds = nextParticipants.map((participant) => (participant.userId ?? participant.uid ?? "").trim());
    if (
      Number(data.participantCount ?? 0) !== nextParticipants.length ||
      nextParticipants.some((participant) => !participant.name) ||
      userIds.some((id) => !id) ||
      new Set(userIds).size !== userIds.length ||
      !Array.isArray(data.pickOrder) || data.pickOrder.length === 0 ||
      !Array.isArray(data.availableItemIds) || data.availableItemIds.length === 0
    ) {
      throw new StartDraftError("Aktuální údaje draftu neumožňují jeho spuštění.");
    }

    transaction.update(ref, {
      participants: nextParticipants,
      status: "drafting",
      turnStartedAt: firestoreApi.serverTimestamp(),
      updatedAt: firestoreApi.serverTimestamp(),
      teamRanking: finalTeamRanking,
      teamRankingLocked: true,
    });
  });
}
