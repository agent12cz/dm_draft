import { getFirebaseClient } from "@/lib/firebase";

export type DraftPrivateAccess = {
  role: "owner" | "admin" | "participant" | "none";
  authorized: boolean;
  participantIndex: number | null;
  participants: Array<Record<string, unknown>>;
  playerPriorities: string[];
};

export class FirestoreWorkerError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export async function callFirestoreWorker<T>(
  operation: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const { auth } = await getFirebaseClient();
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Pro tuto operaci se přihlaste.");
  }

  const token = await user.getIdToken();
  const response = await fetch("/api/firestore", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operation, ...payload }),
    cache: "no-store",
  });
  const result = await response.json().catch(() => null) as
    | { status?: string; message?: string }
    | null;

  if (!response.ok) {
    const reason = result?.status ?? result?.message ?? "worker-error";
    const messages: Record<string, string> = {
      forbidden: "K této operaci nemáte oprávnění.",
      conflict: "Draft se mezitím změnil. Zkontrolujte aktuální údaje a opakujte akci.",
      missing: "Požadovaný záznam nebyl nalezen.",
      "already-exists": "Záznam již existuje.",
    };
    throw new FirestoreWorkerError(
      response.status,
      reason,
      messages[reason] ?? `Operace Firestore selhala (${reason}).`,
    );
  }

  return result as T;
}

export async function getDraftPrivateAccess(draftId: string) {
  return callFirestoreWorker<DraftPrivateAccess>("draft.access", { draftId });
}
