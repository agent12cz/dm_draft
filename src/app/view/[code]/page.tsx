"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getFirebaseClient } from "@/lib/firebase";
import { normalizeDraftItem } from "@/lib/snakeDraft";

type DraftParticipant = {
  id: string;
  name: string;
  picks: string[];
};

type DraftHistoryItem = {
  type: "pick" | "skip" | "replace";
  participantIndex: number;
  itemId?: string;
  itemName?: string;
  oldItemId?: string;
  oldItemName?: string;
  newItemId?: string;
  newItemName?: string;
};

type DraftItem = {
  id: string;
  name: string;
  sport: string;
  logo: string;
};

type Draft = {
  id: string;
  title: string;
  sport: string;
  code: string;
  status: string;
  productName: string;
  productSeason: string;
  productImageUrl?: string;
  boxCount: number;
  boxPrice: number;
  margin: number;
  targetBreakPrice: number;
  participantCount: number;
  participants: DraftParticipant[];
  currentPickIndex: number;
  pickOrder: number[];
  draftItems: DraftItem[];
  availableItemIds: string[];
  history: DraftHistoryItem[];
};

function TeamLogo({ item, className = "h-8 w-8" }: { item?: DraftItem | null; className?: string }) {
  const teamName = item?.name ?? "";
  const slug = teamName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const logoSrc = slug ? `/logos/nhl/${slug}.png` : "";

  if (!teamName || !logoSrc) {
    return null;
  }

  return <img src={logoSrc} alt={teamName} width={32} height={32} className={className} />;
}

export default function ViewerPage() {
  const params = useParams();
  const code = Array.isArray(params.code) ? params.code[0] : params.code;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(code));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      return;
    }

    let isMounted = true;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      try {
        const { db, firestoreApi } = await getFirebaseClient();

        if (!isMounted) {
          return;
        }

        const draftRef = firestoreApi.doc(db, "drafts", code);
        unsubscribe = firestoreApi.onSnapshot(
          draftRef,
          (snapshot) => {
            if (snapshot.exists()) {
              const data = snapshot.data();
              const draftData = {
                id: snapshot.id,
                title: data.title ?? "Bez názvu",
                sport: data.sport ?? "NHL",
                code: data.code ?? code,
                status: data.status ?? "waiting",
                productName: data.productName ?? "",
                productSeason: data.productSeason ?? "",
                productImageUrl: data.productImageUrl ?? "",
                boxCount: Number(data.boxCount ?? 0),
                boxPrice: Number(data.boxPrice ?? 0),
                margin: Number(data.margin ?? 0),
                targetBreakPrice: Number(data.targetBreakPrice ?? 0),
                participantCount: Number(data.participantCount ?? 0),
                participants: (data.participants ?? []) as DraftParticipant[],
                currentPickIndex: Number(data.currentPickIndex ?? 0),
                pickOrder: (data.pickOrder ?? []) as number[],
                draftItems: ((data.draftItems ?? []) as Array<DraftItem | string>).map((item) => normalizeDraftItem(item)),
                availableItemIds: (data.availableItemIds ?? []) as string[],
                history: (data.history ?? []) as DraftHistoryItem[],
              };

              setDraft(draftData);
            } else {
              setDraft(null);
            }

            setIsLoading(false);
          },
          (loadError) => {
            console.error(loadError);
            setError("Nepodařilo se načíst draft z Firestore.");
            setIsLoading(false);
          },
        );
      } catch (initError) {
        console.error(initError);
        setError("Nepodařilo se načíst draft z Firestore.");
        setIsLoading(false);
      }
    })();

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [code]);

  const currentParticipantIndex = draft?.pickOrder[draft.currentPickIndex] ?? null;
  const currentParticipant = draft && currentParticipantIndex !== null ? draft.participants[currentParticipantIndex] : null;
  const currentRound = draft ? Math.floor(draft.currentPickIndex / Math.max(1, draft.participantCount)) + 1 : 1;
  const currentPickNumber = draft ? draft.currentPickIndex + 1 : 1;
  const availableItems = useMemo(() => {
    if (!draft) {
      return [] as DraftItem[];
    }

    return draft.draftItems.filter((item) => draft.availableItemIds.includes(item.id));
  }, [draft]);

  const recentHistory = useMemo(() => {
    if (!draft) {
      return [] as DraftHistoryItem[];
    }

    return [...draft.history].slice(-5).reverse();
  }, [draft]);

  const statusLabel = draft?.status === "paused" ? "Pozastaven" : draft?.status === "completed" ? "Dokončen" : "Probíhá";

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 shadow-2xl shadow-slate-950/60">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-[#18C964]">Viewer</p>
          <h1 className="text-4xl font-semibold tracking-tight text-white">Načítám draft...</h1>
          <p className="text-lg text-slate-400">Čekám na data z Firestore.</p>
        </div>
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 shadow-2xl shadow-slate-950/60">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-[#18C964]">Viewer</p>
          <h1 className="text-4xl font-semibold tracking-tight text-white">Draft nebyl nalezen.</h1>
          <p className="text-lg text-slate-400">{error ?? "Zkontrolujte, zda je kód správný."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-1920 flex-col gap-6">
        <section className="rounded-[32px] border border-slate-800 bg-slate-900/90 p-6 shadow-2xl shadow-slate-950/60 sm:p-8 lg:p-10">
          <div className="flex flex-col gap-8 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#18C964]">Viewer režim</p>
              <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
                {draft.title}
              </h1>
              <p className="text-xl text-slate-400">{draft.sport}</p>
              <div className="flex flex-wrap gap-3">
                <span className="rounded-full border border-slate-700/80 bg-slate-800/80 px-4 py-2 text-sm font-semibold text-slate-200">
                  Stav: {statusLabel}
                </span>
              </div>
              {draft.status === "paused" ? (
                <div className="rounded-3xl border border-orange-500/40 bg-orange-500/10 px-5 py-4 text-xl font-semibold text-orange-300">
                  Draft je pozastaven.
                </div>
              ) : null}
              {draft.status === "completed" ? (
                <div className="rounded-3xl border border-[#18C964]/30 bg-[#18C964]/10 px-5 py-4 text-xl font-semibold text-[#8ef0b5]">
                  Draft dokončen
                </div>
              ) : null}
            </div>

            <div className="w-full max-w-md rounded-[28px] border border-slate-800 bg-slate-950/70 p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-slate-500">Box</p>
              <p className="mt-3 text-3xl font-semibold text-white">{draft.productName || "—"}</p>
              <p className="mt-2 text-lg text-slate-400">{draft.productSeason || "—"}</p>
              {draft.productImageUrl ? (
                <div className="mt-5 overflow-hidden rounded-[24px] border border-slate-800 bg-slate-900/70 p-4">
                  <img src={draft.productImageUrl} alt={draft.productName} className="h-56 w-full object-contain" />
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="grid gap-6 2xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6">
            <div className="rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 shadow-2xl shadow-slate-950/60">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-500">Aktuální tah</p>
                  <h2 className="mt-3 text-4xl font-semibold text-white sm:text-5xl">
                    {currentParticipant?.name || "Čeká se na účastníka"}
                  </h2>
                </div>
                <div className="rounded-3xl border border-slate-800 bg-slate-950/70 px-5 py-4 text-center">
                  <p className="text-sm font-semibold uppercase tracking-[0.25em] text-slate-500">Tah</p>
                  <p className="mt-2 text-3xl font-semibold text-[#18C964]">{currentPickNumber} / {Math.max(1, draft.pickOrder.length)}</p>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3 text-sm text-slate-300">
                <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-4 py-2">Kolo {currentRound}</span>
                <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-4 py-2">Zbývá týmů: {availableItems.length}</span>
                <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-4 py-2">Účastníků: {draft.participants.length}</span>
              </div>
            </div>

            <div className="rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 shadow-2xl shadow-slate-950/60">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-500">Dostupné týmy</p>
                  <h3 className="mt-2 text-2xl font-semibold text-white">Aktuálně k dispozici</h3>
                </div>
              </div>
              <div className="mt-6 grid gap-3 lg:grid-cols-2">
                {availableItems.length > 0 ? (
                  availableItems.map((item) => (
                    <div key={item.id} className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <TeamLogo item={item} className="h-9 w-9" />
                      <span className="text-lg font-medium text-slate-100">{item.name}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-lg text-slate-400">Žádné dostupné týmy.</p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 shadow-2xl shadow-slate-950/60">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-500">Vybrané týmy</p>
                  <h3 className="mt-2 text-2xl font-semibold text-white">Výsledky podle účastníků</h3>
                </div>
              </div>

              <div className="mt-6 space-y-4">
                {draft.participants.map((participant, index) => (
                  <div key={participant.id} className="rounded-3xl border border-slate-800 bg-slate-950/70 p-4">
                    <p className="text-lg font-semibold text-white">{participant.name || `Účastník ${index + 1}`}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {participant.picks.length > 0 ? (
                        participant.picks.map((pickedItemId) => {
                          const item = draft.draftItems.find((currentItem) => currentItem.id === pickedItemId);
                          return (
                            <span key={pickedItemId} className="inline-flex items-center gap-2 rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-2 text-sm text-[#8ef0b5]">
                              <TeamLogo item={item ?? null} className="h-5 w-5" />
                              {item?.name ?? pickedItemId}
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-sm text-slate-500">Zatím žádné výběry.</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 shadow-2xl shadow-slate-950/60">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-500">Historie</p>
                  <h3 className="mt-2 text-2xl font-semibold text-white">Posledních 5 záznamů</h3>
                </div>
              </div>

              <div className="mt-6 space-y-3">
                {recentHistory.length > 0 ? (
                  recentHistory.map((entry, index) => {
                    const participant = draft.participants[entry.participantIndex];
                    const participantName = participant?.name || `Účastník ${entry.participantIndex + 1}`;
                    const pickedItem = entry.itemId ? draft.draftItems.find((item) => item.id === entry.itemId) : null;

                    if (entry.type === "replace") {
                      return (
                        <div key={`${entry.type}-${entry.participantIndex}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                          <p className="text-sm font-semibold text-white">{participantName}</p>
                          <p className="mt-1 text-sm text-slate-400">
                            změnil {entry.oldItemName ?? "neznámý tým"} za {entry.newItemName ?? "neznámý tým"}
                          </p>
                        </div>
                      );
                    }

                    if (entry.type === "pick") {
                      return (
                        <div key={`${entry.type}-${entry.participantIndex}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                          <p className="text-sm font-semibold text-white">{participantName}</p>
                          <p className="mt-1 text-sm text-slate-400">vybral {pickedItem?.name ?? entry.itemName ?? "neznámý tým"}</p>
                        </div>
                      );
                    }

                    return (
                      <div key={`${entry.type}-${entry.participantIndex}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                        <p className="text-sm font-semibold text-white">{participantName}</p>
                        <p className="mt-1 text-sm text-slate-400">byl přeskočen</p>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-lg text-slate-400">Zatím žádná historie.</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {draft.status === "completed" ? (
          <section className="rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 shadow-2xl shadow-slate-950/60">
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-500">Konečné výsledky</p>
            <h3 className="mt-2 text-3xl font-semibold text-white">Dokončený draft</h3>
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {draft.participants.map((participant, index) => (
                <div key={participant.id} className="rounded-3xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-lg font-semibold text-white">{participant.name || `Účastník ${index + 1}`}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {participant.picks.map((pickedItemId) => {
                      const item = draft.draftItems.find((currentItem) => currentItem.id === pickedItemId);
                      return (
                        <span key={pickedItemId} className="inline-flex items-center gap-2 rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-2 text-sm text-[#8ef0b5]">
                          <TeamLogo item={item ?? null} className="h-5 w-5" />
                          {item?.name ?? pickedItemId}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
