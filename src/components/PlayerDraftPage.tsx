"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Timestamp } from "firebase/firestore";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import { normalizeDraftItem } from "@/lib/snakeDraft";
import { useAuth } from "@/components/AuthProvider";
import { DraftChat } from "@/components/DraftChat";

type DraftParticipant = {
  id: string;
  userId?: string;
  name: string;
  email?: string;
  picks: string[];
  participantPin?: string;
  participantId?: string;
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
  productPrice: number;
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
  turnDurationSeconds: number | null;
  turnStartedAt?: { toDate: () => Date } | null;
};

function formatTurnDurationLabel(turnDurationSeconds: number | null) {
  if (turnDurationSeconds === null) {
    return "bez limitu";
  }

  return `${turnDurationSeconds} s`;
}

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

const INVALID_PICK_MESSAGE = "Výběr už není platný. Stav draftu byl aktualizován.";
const PICK_CONFLICT_ERROR = "PICK_CONFLICT";

function resolveHistoryItem(draftItems: DraftItem[], itemId?: string, itemName?: string) {
  if (itemId) {
    const itemById = draftItems.find((candidate) => candidate.id === itemId);
    if (itemById) {
      return itemById;
    }
  }

  if (itemName) {
    const itemByName = draftItems.find((candidate) => candidate.name.toLowerCase() === itemName.toLowerCase());
    if (itemByName) {
      return itemByName;
    }

    return normalizeDraftItem(itemName);
  }

  return null;
}

export default function PlayerDraftPage() {
  const params = useParams();
  const router = useRouter();
  const code = Array.isArray(params.code) ? params.code[0] : params.code;
  const { user, profile, loading: authLoading } = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(code));
  const [error, setError] = useState<string | null>(null);
  const [isSubmittingPick, setIsSubmittingPick] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }

    return window.localStorage.getItem("dm-draft-sound-enabled") !== "false";
  });
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [isHistoryDialogOpen, setIsHistoryDialogOpen] = useState(false);
  const lastTurnHandledRef = useRef<string | null>(null);
  const hasInitializedTurnNotificationRef = useRef(false);
  const notificationPermissionRequestedRef = useRef(false);

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
              const turnStartedAtValue = data.turnStartedAt;
              const hasToDate = typeof turnStartedAtValue === "object"
                && turnStartedAtValue !== null
                && "toDate" in turnStartedAtValue
                && typeof (turnStartedAtValue as { toDate?: unknown }).toDate === "function";

              setDraft({
                id: snapshot.id,
                title: data.title ?? "Bez názvu",
                sport: data.sport ?? "NHL",
                code: data.code ?? code,
                status: data.status ?? "waiting",
                productName: data.productName ?? "",
                productSeason: data.productSeason ?? "",
                productPrice: Number(data.productPrice ?? 0),
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
                turnDurationSeconds: data.turnDurationSeconds === null ? null : Number(data.turnDurationSeconds ?? 15),
                turnStartedAt: hasToDate ? (turnStartedAtValue as Timestamp) : null,
              });
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

  useEffect(() => {
    if (!draft) {
      return;
    }

    if (draft.turnDurationSeconds === null) {
      return;
    }

    const startedAt = draft.turnStartedAt?.toDate ? draft.turnStartedAt.toDate().getTime() : null;
    const totalSeconds = draft.turnDurationSeconds;
    const updateCountdown = () => {
      if (!startedAt) {
        setTimeLeft(totalSeconds);
        return;
      }

      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setTimeLeft(Math.max(0, totalSeconds - elapsed));
    };

    updateCountdown();

    const intervalId = window.setInterval(updateCountdown, 1000);

    return () => window.clearInterval(intervalId);
  }, [draft]);

  const closeHistoryDialog = useCallback(() => {
    setIsHistoryDialogOpen(false);
  }, []);

  useEffect(() => {
    if (!isHistoryDialogOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeHistoryDialog();
      }
    };

    const bodyElement = document.body;
    const previousPosition = bodyElement.style.position;
    const previousTop = bodyElement.style.top;
    const previousWidth = bodyElement.style.width;
    const previousOverflow = bodyElement.style.overflow;
    const scrollY = window.scrollY;

    bodyElement.style.position = "fixed";
    bodyElement.style.top = `-${scrollY}px`;
    bodyElement.style.width = "100%";
    bodyElement.style.overflow = "hidden";

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
      bodyElement.style.position = previousPosition;
      bodyElement.style.top = previousTop;
      bodyElement.style.width = previousWidth;
      bodyElement.style.overflow = previousOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [closeHistoryDialog, isHistoryDialogOpen]);

  useEffect(() => {
    if (!user || typeof window === "undefined" || !("Notification" in window) || notificationPermissionRequestedRef.current) {
      return;
    }

    notificationPermissionRequestedRef.current = true;

    const storedNotificationPreference = window.localStorage.getItem("dm-draft-notifications-state");
    if (storedNotificationPreference === "granted" || storedNotificationPreference === "denied") {
      return;
    }

    void Notification.requestPermission()
      .then((permission) => {
        if (permission === "granted") {
          window.localStorage.setItem("dm-draft-notifications-state", "granted");
        } else {
          window.localStorage.setItem("dm-draft-notifications-state", permission);
        }
      })
      .catch(() => {
        window.localStorage.setItem("dm-draft-notifications-state", "unsupported");
      });
  }, [user]);

  useEffect(() => {
    if (!draft || !user || draft.status !== "drafting") {
      return;
    }

    const currentParticipantIndex = draft.pickOrder[draft.currentPickIndex] ?? null;
    const currentParticipant = draft.participants[currentParticipantIndex as number] ?? null;
    const isCurrentUserTurn = Boolean(currentParticipant?.userId && currentParticipant.userId === user.uid);
    const turnKey = `${draft.id}-${draft.currentPickIndex}-${draft.turnStartedAt?.toDate ? draft.turnStartedAt.toDate().getTime() : ""}`;

    if (!hasInitializedTurnNotificationRef.current) {
      const storedTurnKey = typeof window !== "undefined"
        ? window.sessionStorage.getItem(`dm-last-notified-turn:${draft.id}:${user.uid}`)
        : null;
      lastTurnHandledRef.current = storedTurnKey ?? turnKey;
      hasInitializedTurnNotificationRef.current = true;
      return;
    }

    if (!isCurrentUserTurn || turnKey === lastTurnHandledRef.current) {
      return;
    }

    lastTurnHandledRef.current = turnKey;
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(`dm-last-notified-turn:${draft.id}:${user.uid}`, turnKey);
    }

    if (typeof window !== "undefined" && "Notification" in window) {
      const notificationPreference = window.localStorage.getItem("dm-draft-notifications-state");
      if (notificationPreference === "granted" && Notification.permission === "granted") {
        const notification = new Notification("Jsi na tahu!", {
          body: "Vyber si svůj tým.",
          tag: turnKey,
        });

        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      }
    }

    if (soundEnabled) {
      const playSound = async () => {
        try {
          const audio = new Audio("/sounds/your-turn.mp3");
          await audio.play();
        } catch {
          // Zvuk není dostupný, přeskakujeme bez rozbití UI.
        }
      };

      void playSound();
    }
  }, [draft, soundEnabled, user]);

  const availableItems = useMemo(() => {
    if (!draft) {
      return [] as DraftItem[];
    }

    return draft.draftItems.filter((item) => draft.availableItemIds.includes(item.id));
  }, [draft]);

  const historyEntries = useMemo(() => {
    if (!draft) {
      return [] as Array<{
        entry: DraftHistoryItem;
        historyIndex: number;
        turnNumber: number;
        participantName: string;
        selectedItem: DraftItem | null;
        oldItem: DraftItem | null;
        newItem: DraftItem | null;
      }>;
    }

    return draft.history
      .map((entry, historyIndex) => {
        const participant = draft.participants[entry.participantIndex];
        const participantName = participant?.name || `Účastník ${entry.participantIndex + 1}`;
        const selectedItem = resolveHistoryItem(draft.draftItems, entry.itemId, entry.itemName);
        const oldItem = resolveHistoryItem(draft.draftItems, entry.oldItemId, entry.oldItemName);
        const newItem = resolveHistoryItem(draft.draftItems, entry.newItemId, entry.newItemName);

        return {
          entry,
          historyIndex,
          turnNumber: historyIndex + 1,
          participantName,
          selectedItem,
          oldItem,
          newItem,
        };
      })
      .reverse();
  }, [draft]);

  const recentHistoryEntries = useMemo(() => historyEntries.slice(0, 10), [historyEntries]);

  const currentParticipantIndex = draft?.pickOrder[draft.currentPickIndex] ?? null;
  const currentParticipant = draft && currentParticipantIndex !== null ? draft.participants[currentParticipantIndex] : null;
  const isAdmin = profile?.role === "admin";
  const participantAssigned = Boolean(user && draft && draft.participants.some((participant) => participant.userId === user.uid));
  const hasPlayAccess = Boolean(isAdmin || participantAssigned);
  const currentUserParticipant = draft?.participants.find((participant) => participant.userId === user?.uid) ?? null;
  const accessMessage = user && draft && !hasPlayAccess ? "Nejste účastníkem tohoto draftu." : null;
  const isCurrentUserTurn = Boolean(
    user &&
      draft &&
      draft.status === "drafting" &&
      currentParticipant?.userId &&
      currentParticipant.userId === user.uid,
  );
  const isTurnExpired = Boolean(
    draft &&
      draft.status === "drafting" &&
      draft.turnDurationSeconds !== null &&
      timeLeft !== null &&
      timeLeft <= 0,
  );
  const canPickTeam = Boolean(
    user &&
      draft &&
      draft.status === "drafting" &&
      currentParticipant?.userId === user.uid &&
      !isSubmittingPick &&
      !isTurnExpired,
  );

  async function handleSelectItem(item: DraftItem) {
    if (!draft || !user || !canPickTeam || !currentParticipant) {
      return;
    }

    if (isSubmittingPick) {
      return;
    }

    setIsSubmittingPick(true);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.runTransaction(db, async (transaction) => {
        const draftRef = firestoreApi.doc(db, "drafts", draft.id);
        const latestSnapshot = await transaction.get(draftRef);

        if (!latestSnapshot.exists()) {
          throw new Error("Draft nebyl nalezen.");
        }

        const latestData = latestSnapshot.data();
        const latestParticipants = (latestData.participants ?? []) as DraftParticipant[];
        const latestPickOrder = (latestData.pickOrder ?? []) as number[];
        const latestCurrentPickIndex = Number(latestData.currentPickIndex ?? 0);
        const latestStatus = latestData.status ?? "waiting";
        const latestAvailableItemIds = (latestData.availableItemIds ?? []) as string[];
        const latestHistory = (latestData.history ?? []) as DraftHistoryItem[];
        const latestCurrentParticipantIndex = latestPickOrder[latestCurrentPickIndex];
        const latestCurrentParticipant = latestParticipants[latestCurrentParticipantIndex];
        const expectedCurrentPickIndex = draft.currentPickIndex;
        const expectedParticipantIndex = draft.pickOrder[expectedCurrentPickIndex];
        const expectedParticipantUserId = currentParticipant.userId ?? "";

        if (latestStatus !== "drafting") {
          throw new Error(PICK_CONFLICT_ERROR);
        }

        if (latestCurrentPickIndex !== expectedCurrentPickIndex) {
          throw new Error(PICK_CONFLICT_ERROR);
        }

        if (latestCurrentParticipantIndex !== expectedParticipantIndex) {
          throw new Error(PICK_CONFLICT_ERROR);
        }

        if (!latestCurrentParticipant?.userId || latestCurrentParticipant.userId !== expectedParticipantUserId) {
          throw new Error(PICK_CONFLICT_ERROR);
        }

        if (latestCurrentParticipant.userId !== user.uid) {
          throw new Error(PICK_CONFLICT_ERROR);
        }

        if (!latestAvailableItemIds.includes(item.id)) {
          throw new Error(PICK_CONFLICT_ERROR);
        }

        const nextPickIndex = latestCurrentPickIndex + 1;
        const nextStatus = nextPickIndex >= latestPickOrder.length ? "completed" : "drafting";
        const nextParticipants = latestParticipants.map((participant, index) =>
          index === latestCurrentParticipantIndex ? { ...participant, picks: [...participant.picks, item.id] } : participant,
        );
        const nextAvailableItemIds = latestAvailableItemIds.filter((availableItemId) => availableItemId !== item.id);
        const nextHistory = [
          ...latestHistory,
          {
            type: "pick" as const,
            participantIndex: latestCurrentParticipantIndex,
            itemId: item.id,
            itemName: item.name,
          },
        ];

        const nextDraftUpdate = {
          status: nextStatus,
          participants: nextParticipants,
          currentPickIndex: nextPickIndex,
          availableItemIds: nextAvailableItemIds,
          history: nextHistory,
          turnDurationSeconds: latestData.turnDurationSeconds === null ? null : Number(latestData.turnDurationSeconds ?? 15),
          updatedAt: firestoreApi.serverTimestamp(),
        } as Record<string, unknown>;

        if (nextStatus === "drafting") {
          nextDraftUpdate.turnStartedAt = firestoreApi.serverTimestamp();
        }

        transaction.update(draftRef, nextDraftUpdate);
      });
    } catch (pickError) {
      console.error(pickError);
      if (pickError instanceof Error && pickError.message === PICK_CONFLICT_ERROR) {
        setError(INVALID_PICK_MESSAGE);
      } else {
        setError("Nepodařilo se uložit výběr.");
      }
    } finally {
      setIsSubmittingPick(false);
    }
  }

  function toggleSound() {
    const nextEnabled = !soundEnabled;
    setSoundEnabled(nextEnabled);

    if (typeof window !== "undefined") {
      window.localStorage.setItem("dm-draft-sound-enabled", String(nextEnabled));
    }
  }

  function renderHistoryText(historyEntry: (typeof historyEntries)[number]) {
    if (historyEntry.entry.type === "skip") {
      return `${historyEntry.participantName} byl přeskočen.`;
    }

    if (historyEntry.entry.type === "replace") {
      const oldTeamName = historyEntry.oldItem?.name ?? historyEntry.entry.oldItemName ?? "původní tým";
      const newTeamName = historyEntry.newItem?.name ?? historyEntry.entry.newItemName ?? "nový tým";
      return `${historyEntry.participantName} změnil ${oldTeamName} za ${newTeamName}.`;
    }

    const pickedTeamName = historyEntry.selectedItem?.name ?? historyEntry.entry.itemName ?? "tým";
    return `${historyEntry.participantName} vybral ${pickedTeamName}.`;
  }

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Navbar />
        <PageContainer className="py-8 lg:py-10">
          <Card className="mx-auto max-w-6xl p-6">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Hráčský režim</p>
            <h1 className="mt-3 text-3xl font-semibold text-white">Načítám draft...</h1>
          </Card>
        </PageContainer>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Navbar />
        <PageContainer className="py-8 lg:py-10">
          <Card className="mx-auto max-w-6xl p-6">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Hráčský režim</p>
            <h1 className="mt-3 text-3xl font-semibold text-white">Přihlaste se, abyste mohli vybrat tým.</h1>
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="mt-5 rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a]"
            >
              Přihlásit se
            </button>
          </Card>
        </PageContainer>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Navbar />
        <PageContainer className="py-8 lg:py-10">
          <Card className="mx-auto max-w-6xl p-6">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Hráčský režim</p>
            <h1 className="mt-3 text-3xl font-semibold text-white">Draft nebyl nalezen.</h1>
          </Card>
        </PageContainer>
      </div>
    );
  }

  if (!hasPlayAccess) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Navbar />
        <PageContainer className="py-8 lg:py-10">
          <Card className="mx-auto max-w-6xl p-6">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Hráčský režim</p>
            <h1 className="mt-3 text-3xl font-semibold text-white">Nejste účastníkem tohoto draftu.</h1>
            <p className="mt-3 text-sm text-slate-400">Požádejte admina o přiřazení k draftu nebo zadejte jiný kód v přihlašovací stránce.</p>
            <button
              type="button"
              onClick={() => router.push("/join")}
              className="mt-5 rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a]"
            >
              Zpět na join
            </button>
          </Card>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <Card className="space-y-4 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Hráčský režim</p>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{draft.title}</h1>
                <p className="mt-2 text-slate-400">{draft.sport}</p>
                <p className="mt-2 text-sm text-slate-400">Čas na výběr: {formatTurnDurationLabel(draft.turnDurationSeconds)}</p>
                <p className="mt-2 text-sm text-slate-500">Přihlášený účastník: {currentUserParticipant?.name || user.email}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-300">
                  <p className="font-semibold text-white">Stav</p>
                  <p className="mt-1 uppercase tracking-[0.22em] text-[#8ef0b5]">{draft.status}</p>
                </div>
                <button
                  type="button"
                  onClick={toggleSound}
                  className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  {soundEnabled ? "🔊 Zvuk zapnutý" : "🔇 Zvuk vypnutý"}
                </button>
              </div>
            </div>
          </Card>

          {error || accessMessage ? (
            <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error ?? accessMessage}
            </div>
          ) : null}

          {draft.status === "completed" ? (
            <div className="rounded-2xl border border-[#18C964]/40 bg-[#18C964]/10 px-4 py-3 text-sm font-semibold text-[#8ef0b5]">
              Draft dokončen
            </div>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
            <Card className="space-y-5 p-6">
              <div className={`rounded-3xl border p-5 ${isCurrentUserTurn ? "border-[#18C964]/40 bg-[#18C964]/10" : "border-slate-700 bg-slate-950/70"}`}>
                <p className={`text-sm font-semibold uppercase tracking-[0.3em] ${isCurrentUserTurn ? "text-[#8ef0b5]" : "text-slate-300"}`}>
                  {isCurrentUserTurn ? "👉 JSTE NA TAHU" : "Na tahu je:"}
                </p>
                {!isCurrentUserTurn ? <p className="mt-2 text-lg font-semibold text-white">{currentParticipant?.name || "—"}</p> : null}
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">
                  {currentParticipant?.name || "Čeká se na účastníka"}
                </h2>
                <div className="mt-4 flex flex-wrap gap-3 text-sm text-slate-300">
                  <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">Kolo {draft.currentPickIndex ? Math.floor(draft.currentPickIndex / Math.max(1, draft.participantCount)) + 1 : 1}</span>
                  <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">Tah {draft.currentPickIndex + 1} z {Math.max(1, draft.pickOrder.length)}</span>
                  {draft.turnDurationSeconds === null ? (
                    <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1 text-slate-300">
                      Čas: bez limitu
                    </span>
                  ) : (
                    <span
                      className={`rounded-full border px-3 py-1 ${
                        timeLeft !== null && timeLeft <= 1
                          ? "animate-pulse border-red-500/40 bg-red-500/10 text-red-300"
                          : timeLeft !== null && timeLeft <= 3
                            ? "border-red-500/40 bg-red-500/10 text-red-300"
                            : timeLeft !== null && timeLeft <= 5
                              ? "border-orange-500/30 bg-orange-500/10 text-orange-300"
                              : "border-slate-700/80 bg-slate-900/70 text-slate-300"
                      }`}
                    >
                      Čas: {timeLeft ?? draft.turnDurationSeconds}
                    </span>
                  )}
                </div>
                {isTurnExpired ? (
                  <div className="mt-4 rounded-2xl border border-orange-500/30 bg-orange-500/10 px-4 py-3 text-sm text-orange-300">
                    ⏰ Čas vypršel – čeká se na rozhodnutí admina.
                  </div>
                ) : null}
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70">
                <div className="border-b border-slate-800 bg-slate-900/80 p-4">
                  <p className="text-sm text-slate-400">Box a produkt</p>
                  <p className="mt-2 text-lg font-semibold text-white">{draft.productName}</p>
                  <p className="text-sm text-slate-400">{draft.productSeason}</p>
                </div>
                {draft.productImageUrl ? (
                  <img src={draft.productImageUrl} alt={draft.productName} className="h-56 w-full object-cover" />
                ) : null}
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-sm text-slate-400">Dostupné týmy</p>
                {isSubmittingPick ? <p className="mt-2 text-sm text-[#8ef0b5]">Ukládám výběr…</p> : null}
                <div className="mt-3 grid gap-2">
                  {availableItems.length > 0 ? (
                    availableItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => void handleSelectItem(item)}
                        disabled={!canPickTeam}
                        className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition ${canPickTeam ? "border-slate-800 bg-slate-900/80 text-slate-200 hover:border-[#18C964]/40 hover:bg-slate-800" : "cursor-not-allowed border-slate-800 bg-slate-900/60 text-slate-500"}`}
                      >
                        <span className="flex items-center gap-3">
                          <TeamLogo item={item} className="h-8 w-8" />
                          <span>{item.name}</span>
                        </span>
                        <span className="text-slate-400">{isSubmittingPick ? "Ukládám výběr…" : canPickTeam ? "Vybrat" : "Nedostupné"}</span>
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-slate-400">Žádné dostupné položky.</p>
                  )}
                </div>
              </div>
            </Card>

            <Card className="space-y-4 p-6">
              <div>
                <h2 className="text-2xl font-semibold text-white">Účastníci draftu</h2>
                <p className="mt-2 text-sm text-slate-400">Všechny výběry se zobrazují v reálném čase a přímo v draftu.</p>
              </div>
              <div className="space-y-3">
                {draft.participants.map((participant, index) => {
                  const isCurrent = currentParticipant?.id === participant.id;
                  const pickedTeams = participant.picks
                    .map((pickedItemId) => draft.draftItems.find((currentItem) => currentItem.id === pickedItemId))
                    .filter((item): item is DraftItem => Boolean(item));

                  return (
                    <div key={participant.id} className={`rounded-2xl border p-4 ${isCurrent ? "border-[#18C964]/40 bg-[#18C964]/10" : "border-slate-800 bg-slate-950/70"}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-white">{participant.name || `Účastník ${index + 1}`}</p>
                          <p className="mt-1 text-sm text-slate-400">{participant.email || "Bez e-mailu"}</p>
                        </div>
                        {isCurrent ? <span className="rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-[#8ef0b5]">Na tahu</span> : null}
                      </div>
                      <p className="mt-3 text-sm text-slate-500">Vybrané týmy: {participant.picks.length}</p>
                      {pickedTeams.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {pickedTeams.map((item, pickedIndex) => (
                            <div
                              key={`${participant.id}-${item.id}-${pickedIndex}`}
                              className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-sm text-slate-200"
                            >
                              <TeamLogo item={item} className="h-5 w-5" />
                              <span>{item.name}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-slate-500">Zatím bez výběru.</p>
                      )}
                    </div>
                  );
                })}
              </div>

              <DraftChat draftId={draft.id} draftCode={draft.code} currentUser={user} currentUserRole={profile?.role ?? null} />

              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold text-white">Historie draftu</h3>
                  <button
                    type="button"
                    onClick={() => setIsHistoryDialogOpen(true)}
                    disabled={historyEntries.length === 0}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition ${
                      historyEntries.length > 0
                        ? "border-slate-700 bg-slate-900/80 text-slate-200 hover:border-[#18C964]/40 hover:bg-slate-800"
                        : "cursor-not-allowed border-slate-800 bg-slate-900/60 text-slate-500"
                    }`}
                  >
                    Zobrazit celou historii
                  </button>
                </div>

                {recentHistoryEntries.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-400">Draft zatím nemá žádný výběr.</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {recentHistoryEntries.map((historyEntry, index) => {
                      const isLatest = index === 0;

                      return (
                        <div
                          key={`${historyEntry.entry.type}-${historyEntry.historyIndex}`}
                          className={`rounded-2xl border p-3 ${
                            isLatest
                              ? "border-[#18C964]/50 bg-[#18C964]/10"
                              : "border-slate-800 bg-slate-900/70"
                          }`}
                        >
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Tah {historyEntry.turnNumber}</p>
                          <p className="mt-2 text-sm font-semibold text-white">{historyEntry.participantName}</p>
                          <p className="mt-1 text-sm text-slate-300">{renderHistoryText(historyEntry)}</p>

                          {historyEntry.entry.type === "pick" && historyEntry.selectedItem ? (
                            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-sm text-slate-200">
                              <TeamLogo item={historyEntry.selectedItem} className="h-5 w-5" />
                              <span>{historyEntry.selectedItem.name}</span>
                            </div>
                          ) : null}

                          {historyEntry.entry.type === "replace" ? (
                            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-200">
                              <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1">
                                <TeamLogo item={historyEntry.oldItem} className="h-5 w-5" />
                                <span>{historyEntry.oldItem?.name ?? historyEntry.entry.oldItemName ?? "Původní tým"}</span>
                              </span>
                              <span className="text-slate-500">→</span>
                              <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1">
                                <TeamLogo item={historyEntry.newItem} className="h-5 w-5" />
                                <span>{historyEntry.newItem?.name ?? historyEntry.entry.newItemName ?? "Nový tým"}</span>
                              </span>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </PageContainer>

      {isHistoryDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeHistoryDialog();
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Historie draftu"
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-700 bg-slate-900"
          >
            <div className="border-b border-slate-800 px-5 py-4">
              <h3 className="text-xl font-semibold text-white">Historie draftu</h3>
              <p className="mt-1 text-sm text-slate-400">Všechny záznamy od nejnovějšího po nejstarší.</p>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {historyEntries.length === 0 ? (
                <p className="text-sm text-slate-400">Draft zatím nemá žádný výběr.</p>
              ) : (
                <div className="space-y-3">
                  {historyEntries.map((historyEntry, index) => {
                    const isLatest = index === 0;

                    return (
                      <div
                        key={`modal-${historyEntry.entry.type}-${historyEntry.historyIndex}`}
                        className={`rounded-2xl border p-4 ${
                          isLatest
                            ? "border-[#18C964]/50 bg-[#18C964]/10"
                            : "border-slate-800 bg-slate-950/60"
                        }`}
                      >
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Tah {historyEntry.turnNumber}</p>
                        <p className="mt-2 text-sm font-semibold text-white">{historyEntry.participantName}</p>
                        <p className="mt-1 text-sm text-slate-300">{renderHistoryText(historyEntry)}</p>

                        {historyEntry.entry.type === "pick" && historyEntry.selectedItem ? (
                          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-sm text-slate-200">
                            <TeamLogo item={historyEntry.selectedItem} className="h-5 w-5" />
                            <span>{historyEntry.selectedItem.name}</span>
                          </div>
                        ) : null}

                        {historyEntry.entry.type === "replace" ? (
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-200">
                            <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1">
                              <TeamLogo item={historyEntry.oldItem} className="h-5 w-5" />
                              <span>{historyEntry.oldItem?.name ?? historyEntry.entry.oldItemName ?? "Původní tým"}</span>
                            </span>
                            <span className="text-slate-500">→</span>
                            <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1">
                              <TeamLogo item={historyEntry.newItem} className="h-5 w-5" />
                              <span>{historyEntry.newItem?.name ?? historyEntry.entry.newItemName ?? "Nový tým"}</span>
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="sticky bottom-0 border-t border-slate-800 bg-slate-900/95 px-5 py-4">
              <button
                type="button"
                onClick={closeHistoryDialog}
                className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-800"
              >
                Zavřít
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
