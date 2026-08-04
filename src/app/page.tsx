"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { PrimaryButton } from "@/components/PrimaryButton";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import { buildSnakeOrder, defaultDraftItems } from "@/lib/snakeDraft";
import AuthGuard from "@/app/auth-guard";

type DraftStatus = "waiting" | "drafting" | "paused" | "completed";

type DraftDocument = {
  id: string;
  title: string;
  sport?: string;
  code?: string;
  status?: DraftStatus | string;
  productId?: string;
  productName?: string;
  productSeason?: string;
  productImageUrl?: string;
  participantCount?: number;
  participants?: Array<{ id?: string; name?: string; picks?: string[] }>;
  currentPickIndex?: number;
  pickOrder?: number[];
  createdAt?: unknown;
  updatedAt?: unknown;
  boxCount?: number;
  boxPrice?: number;
  margin?: number;
  targetBreakPrice?: number;
  draftItems?: Array<{ id: string; name: string; sport: string; logo: string }>;
  availableItemIds?: string[];
  turnDurationSeconds?: number | null;
};

const statusLabels: Record<string, string> = {
  waiting: "Čeká na spuštění",
  drafting: "Probíhá",
  paused: "Pozastaven",
  completed: "Dokončen",
};

function getSortValue(value: unknown) {
  if (!value || typeof value !== "object") {
    return 0;
  }

  if ("toDate" in value && typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().getTime();
  }

  if ("seconds" in value && typeof (value as { seconds?: number }).seconds === "number") {
    return (value as { seconds: number }).seconds * 1000;
  }

  return 0;
}

function formatDate(value: unknown) {
  if (!value || typeof value !== "object") {
    return "—";
  }

  if ("toDate" in value && typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toLocaleString("cs-CZ");
  }

  if ("seconds" in value && typeof (value as { seconds?: number }).seconds === "number") {
    return new Date((value as { seconds: number }).seconds * 1000).toLocaleString("cs-CZ");
  }

  return "—";
}

function getStatusLabel(status?: string) {
  if (!status) {
    return "Čeká na spuštění";
  }

  return statusLabels[status] ?? status;
}

function getPrimaryActionLabel(status?: string) {
  if (status === "drafting" || status === "paused") {
    return "Pokračovat v draftu";
  }

  return "Otevřít draft";
}

function getCurrentPickLabel(draft: DraftDocument) {
  if (draft.status === "completed") {
    return "Dokončeno";
  }

  const participantIndex = draft.pickOrder?.[draft.currentPickIndex ?? 0];
  if (participantIndex === undefined || participantIndex === null) {
    return "—";
  }

  const participant = draft.participants?.[participantIndex];
  return participant?.name || `Účastník ${participantIndex + 1}`;
}

function HomeContent() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [duplicatingDraftId, setDuplicatingDraftId] = useState<string | null>(null);
  const [deletingDraftId, setDeletingDraftId] = useState<string | null>(null);
  const [draftToDelete, setDraftToDelete] = useState<DraftDocument | null>(null);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      try {
        const { db, firestoreApi } = await getFirebaseClient();
        if (!isMounted) {
          return;
        }

        unsubscribe = firestoreApi.onSnapshot(
          firestoreApi.collection(db, "drafts"),
          (snapshot) => {
            if (!isMounted) {
              return;
            }

            const nextDrafts = snapshot.docs
              .map((document) => ({
                id: document.id,
                ...(document.data() as Omit<DraftDocument, "id">),
              }))
              .sort((left, right) => getSortValue(right.updatedAt ?? right.createdAt) - getSortValue(left.updatedAt ?? left.createdAt));

            setDrafts(nextDrafts);
            setError(null);
            setIsLoading(false);
          },
          (loadError) => {
            console.error(loadError);
            if (isMounted) {
              setError("Nepodařilo se načíst drafty z Firestore.");
              setIsLoading(false);
            }
          },
        );
      } catch (initError) {
        console.error(initError);
        if (isMounted) {
          setError("Nepodařilo se načíst drafty z Firestore.");
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, []);

  const activeDrafts = useMemo(
    () => drafts.filter((draft) => draft.status === "waiting" || draft.status === "drafting" || draft.status === "paused"),
    [drafts],
  );
  const completedDrafts = useMemo(() => drafts.filter((draft) => draft.status === "completed"), [drafts]);

  async function handleDuplicateDraft(draft: DraftDocument) {
    if (!draft.id) {
      return;
    }

    setDuplicatingDraftId(draft.id);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      let draftCode = generateDraftCode();
      let isCodeTaken = true;

      while (isCodeTaken) {
        const existingDraft = await firestoreApi.getDoc(firestoreApi.doc(db, "drafts", draftCode));
        if (!existingDraft.exists()) {
          isCodeTaken = false;
          break;
        }

        draftCode = generateDraftCode();
      }

      const participantCount = Number(draft.participantCount ?? 0);
      const copiedDraftItems = (draft.draftItems ?? defaultDraftItems).map((item) => ({
        id: item.id,
        name: item.name,
        sport: item.sport ?? "NHL",
        logo: item.logo ?? "",
      }));
      const nextAvailableItemIds = copiedDraftItems.map((item) => item.id);

      const duplicateDraftData = {
        title: `${draft.title || "Draft"} kopie`,
        sport: draft.sport ?? "NHL",
        productId: draft.productId ?? "",
        productName: draft.productName ?? "",
        productSeason: draft.productSeason ?? "",
        productImageUrl: draft.productImageUrl ?? "",
        boxCount: Number(draft.boxCount ?? 0),
        boxPrice: Number(draft.boxPrice ?? 0),
        margin: Number(draft.margin ?? 0),
        targetBreakPrice: Number(draft.targetBreakPrice ?? 0),
        participantCount,
        participants: Array.from({ length: participantCount }, (_, index) => ({
          id: `participant-${index + 1}`,
          name: "",
          picks: [],
        })),
        status: "waiting",
        currentPickIndex: 0,
        pickOrder: buildSnakeOrder(participantCount, copiedDraftItems.length),
        draftItems: copiedDraftItems,
        availableItemIds: nextAvailableItemIds,
        history: [],
        turnDurationSeconds: draft.turnDurationSeconds === null ? null : Number(draft.turnDurationSeconds ?? 15),
        createdAt: firestoreApi.serverTimestamp(),
        updatedAt: firestoreApi.serverTimestamp(),
        code: draftCode,
      };

      await firestoreApi.setDoc(firestoreApi.doc(db, "drafts", draftCode), duplicateDraftData);
      router.push(`/draft/${draftCode}`);
    } catch (duplicateError) {
      console.error(duplicateError);
      setError("Nepodařilo se duplikovat draft.");
    } finally {
      setDuplicatingDraftId(null);
    }
  }

  async function handleConfirmDeleteDraft() {
    if (!draftToDelete?.id || deletingDraftId === draftToDelete.id) {
      return;
    }

    setDeletingDraftId(draftToDelete.id);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.deleteDoc(firestoreApi.doc(db, "drafts", draftToDelete.id));
      setDraftToDelete(null);
    } catch (deleteError) {
      console.error(deleteError);
      setError("Draft se nepodařilo smazat.");
    } finally {
      setDeletingDraftId(null);
    }
  }

  function generateDraftCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl space-y-4">
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-[#18C964]">
              DM Draft
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Vítejte v DM Draft
            </h1>
            <p className="text-lg leading-8 text-slate-400">
              Moderní pracovní plocha pro draftování týmů v hokejových breacích.
            </p>
          </div>

          <PrimaryButton href="/draft/new">+ Nový draft</PrimaryButton>
        </div>

        <div className="mt-8 grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
          <section className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-semibold text-white">Moje drafty</h2>
              <span className="text-sm text-slate-400">{drafts.length} záznamů</span>
            </div>

            {isLoading ? (
              <Card className="p-6 text-sm text-slate-400">Načítám drafty z Firestore...</Card>
            ) : null}

            {error ? (
              <Card className="p-6 text-sm text-red-300">{error}</Card>
            ) : null}

            {!isLoading && !error ? (
              <div className="space-y-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-semibold text-white">Aktivní drafty</h3>
                    <span className="text-sm text-slate-400">{activeDrafts.length} aktivních</span>
                  </div>

                  {activeDrafts.length > 0 ? (
                    <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,520px),1fr))]">
                      {activeDrafts.map((draft) => (
                        <div
                          key={draft.id}
                          className="relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_80px_rgba(2,6,23,0.4)] backdrop-blur-xl transition hover:-translate-y-0.5"
                        >
                          <span className="absolute right-4 top-4 shrink-0 rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1 text-xs font-semibold text-[#8ef0b5]">
                            {getStatusLabel(draft.status)}
                          </span>

                          <Link href={`/draft/${draft.code}`} className="flex flex-1 flex-col gap-4 pr-24 lg:grid lg:grid-cols-[45%_55%] lg:items-start">
                            <div className="flex min-w-0 flex-col">
                              <div className="space-y-2">
                                <p className="text-sm font-medium uppercase tracking-[0.24em] text-slate-500">
                                  {draft.sport || "NHL Draft"}
                                </p>
                                <h4 className="whitespace-nowrap overflow-hidden text-ellipsis text-xl font-semibold text-white">
                                  {draft.title}
                                </h4>
                              </div>

                              <div className="mt-4 grid gap-2 text-sm text-slate-400 md:grid-cols-2">
                                <div>
                                  <span className="text-slate-500">Box:</span> {draft.productName || "—"}
                                </div>
                                <div>
                                  <span className="text-slate-500">Sezóna:</span> {draft.productSeason || "—"}
                                </div>
                                <div>
                                  <span className="text-slate-500">Účastníci:</span> {draft.participantCount ?? 0}
                                </div>
                                <div>
                                  <span className="text-slate-500">Aktuální tah:</span> {getCurrentPickLabel(draft)}
                                </div>
                                <div>
                                  <span className="text-slate-500">Poslední změna:</span> {formatDate(draft.updatedAt ?? draft.createdAt)}
                                </div>
                                <div>
                                  <span className="text-slate-500">Kód:</span> {draft.code}
                                </div>
                              </div>
                            </div>

                            {draft.productImageUrl ? (
                              <div className="flex min-h-[240px] max-h-[300px] items-center justify-center overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                                <img
                                  src={draft.productImageUrl}
                                  alt={draft.productName || draft.title}
                                  className="h-full w-full object-contain"
                                />
                              </div>
                            ) : null}
                          </Link>

                          <div className="mt-5 flex w-full items-center justify-between border-t border-slate-800 pt-4">
                            <div>
                              <p className="text-sm text-slate-400">Kód draftu</p>
                              <p className="mt-1 font-mono text-xs font-semibold tracking-[0.2em] text-[#18C964] sm:text-sm">
                                {draft.code}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setDraftToDelete(draft)}
                                disabled={deletingDraftId === draft.id}
                                className="rounded-2xl border border-slate-700/70 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                              >
                                {deletingDraftId === draft.id ? "Mažu…" : "Smazat"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDuplicateDraft(draft)}
                                disabled={duplicatingDraftId === draft.id}
                                className="rounded-2xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                              >
                                {duplicatingDraftId === draft.id ? "Kopíruji..." : "Duplikovat"}
                              </button>
                              <Link
                                href={`/draft/${draft.code}`}
                                className="inline-flex items-center justify-center rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#13b15a]"
                              >
                                {getPrimaryActionLabel(draft.status)}
                              </Link>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Card className="p-6 text-sm text-slate-400">
                      Žádné aktivní drafty. Vytvořte nový draft a začněte sbírat data.
                    </Card>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-semibold text-white">Dokončené drafty</h3>
                    <span className="text-sm text-slate-400">{completedDrafts.length} dokončených</span>
                  </div>

                  {completedDrafts.length > 0 ? (
                    <div className="grid gap-4 lg:grid-cols-2">
                      {completedDrafts.map((draft) => (
                        <div
                          key={draft.id}
                          className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_80px_rgba(2,6,23,0.4)] backdrop-blur-xl transition hover:-translate-y-0.5"
                        >
                          <Link href={`/draft/${draft.code}`} className="flex flex-1 flex-col gap-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="space-y-2">
                                <p className="text-sm font-medium uppercase tracking-[0.24em] text-slate-500">
                                  {draft.sport || "NHL Draft"}
                                </p>
                                <h4 className="text-xl font-semibold text-white">{draft.title}</h4>
                              </div>
                              <span className="shrink-0 rounded-full border border-slate-500/20 bg-slate-500/10 px-3 py-1 text-xs font-semibold text-slate-300">
                                {getStatusLabel(draft.status)}
                              </span>
                            </div>

                            <div className="grid gap-2 text-sm text-slate-400 sm:grid-cols-2">
                              <div>
                                <span className="text-slate-500">Box:</span> {draft.productName || "—"}
                              </div>
                              <div>
                                <span className="text-slate-500">Sezóna:</span> {draft.productSeason || "—"}
                              </div>
                              <div>
                                <span className="text-slate-500">Účastníci:</span> {draft.participantCount ?? 0}
                              </div>
                              <div>
                                <span className="text-slate-500">Dokončeno:</span> {formatDate(draft.updatedAt ?? draft.createdAt)}
                              </div>
                            </div>

                            {draft.productImageUrl ? (
                              <div className="flex min-h-[180px] items-center justify-center overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                                <img
                                  src={draft.productImageUrl}
                                  alt={draft.productName || draft.title}
                                  className="h-full w-full max-h-[220px] object-contain"
                                />
                              </div>
                            ) : null}
                          </Link>

                          <div className="mt-5 flex w-full items-center justify-between border-t border-slate-800 pt-4">
                            <div>
                              <p className="text-sm text-slate-400">Kód draftu</p>
                              <p className="mt-1 font-mono text-sm font-semibold tracking-[0.24em] text-[#18C964]">
                                {draft.code}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setDraftToDelete(draft)}
                                disabled={deletingDraftId === draft.id}
                                className="rounded-2xl border border-slate-700/70 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                              >
                                {deletingDraftId === draft.id ? "Mažu…" : "Smazat"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDuplicateDraft(draft)}
                                disabled={duplicatingDraftId === draft.id}
                                className="rounded-2xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                              >
                                {duplicatingDraftId === draft.id ? "Kopíruji..." : "Duplikovat"}
                              </button>
                              <Link
                                href={`/draft/${draft.code}`}
                                className="inline-flex items-center justify-center rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#13b15a]"
                              >
                                Otevřít
                              </Link>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Card className="p-6 text-sm text-slate-400">Zatím žádné dokončené drafty.</Card>
                  )}
                </div>
              </div>
            ) : null}
          </section>

          <aside className="space-y-4">
            <Card className="space-y-4">
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.25em] text-slate-500">
                  Zprávy
                </p>
                <h3 className="mt-2 text-xl font-semibold text-white">Přehled draftů</h3>
              </div>

              <div className="space-y-3">
                <div className="rounded-[20px] border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
                  Aktivních draftů: {activeDrafts.length}
                </div>
                <div className="rounded-[20px] border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
                  Dokončených draftů: {completedDrafts.length}
                </div>
                <div className="rounded-[20px] border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
                  Poslední změna: {drafts.length > 0 ? formatDate(drafts[0].updatedAt ?? drafts[0].createdAt) : "—"}
                </div>
              </div>
            </Card>
          </aside>
        </div>
      </PageContainer>

      {draftToDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/95 p-6 shadow-2xl shadow-slate-950/60">
            <p className="text-sm font-medium uppercase tracking-[0.25em] text-slate-500">Potvrzení</p>
            <h3 className="mt-3 text-xl font-semibold text-white">
              Opravdu chcete smazat draft {draftToDelete.title || "bez názvu"}?
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">Tuto akci nelze vrátit.</p>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => setDraftToDelete(null)}
                className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                Zrušit
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDeleteDraft()}
                disabled={deletingDraftId === draftToDelete.id}
                className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {deletingDraftId === draftToDelete.id ? "Mažu…" : "Smazat draft"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Home() {
  return (
    <AuthGuard>
      <HomeContent />
    </AuthGuard>
  );
}
