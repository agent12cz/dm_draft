import type { DocumentData, DocumentReference, Firestore, Transaction } from "firebase/firestore";

type CreateFirestore = {
  doc: (db: Firestore, collection: string, id: string) => DocumentReference<DocumentData>;
  runTransaction: <T>(db: Firestore, update: (transaction: Transaction) => Promise<T>) => Promise<T>;
};

class DraftCodeTaken extends Error {}

export async function createDraftWithUniqueCode(
  db: Firestore,
  firestoreApi: CreateFirestore,
  generateCode: () => string,
  data: DocumentData,
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateCode();
    const ref = firestoreApi.doc(db, "drafts", code);
    try {
      await firestoreApi.runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists()) throw new DraftCodeTaken();
        transaction.set(ref, { ...data, code });
      });
      return code;
    } catch (error) {
      if (!(error instanceof DraftCodeTaken)) throw error;
    }
  }
  throw new Error("Nepodařilo se vytvořit jedinečný kód draftu.");
}
