import type { DocumentData, Firestore } from "firebase/firestore";
import { callFirestoreWorker, FirestoreWorkerError } from "@/lib/firestoreWorker";

type CreateFirestore = object;

export async function createDraftWithUniqueCode(
  _db: Firestore,
  _firestoreApi: CreateFirestore,
  generateCode: () => string,
  data: DocumentData,
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateCode();
    try {
      await callFirestoreWorker("draft.create", { draftId: code, data });
      return code;
    } catch (error) {
      if (!(error instanceof FirestoreWorkerError) || error.status !== 409) throw error;
    }
  }
  throw new Error("Nepodařilo se vytvořit jedinečný kód draftu.");
}
