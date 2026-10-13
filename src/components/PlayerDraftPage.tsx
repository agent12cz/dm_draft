"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Timestamp } from "firebase/firestore";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import { defaultDraftItems, normalizeDraftItem } from "@/lib/snakeDraft";
import { ensureAllTeamsInOrder } from "@/lib/rankings";
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
  priorities?: string[];
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

type DraftBox = {
  productId?: string;
  productName: string;
  productSeason: string;
  boxCount: number;
  boxPrice: number;
  productImageUrl?: string;
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
  boxes?: DraftBox[];
  teamRanking?: string[];
  teamRankingLocked?: boolean;
  playerPriorities?: Record<string, string[]>;
};

function formatTurnDurationLabel(turnDurationSeconds: number | null) {
  if (turnDurationSeconds === null) {
    return "bez limitu";
  }

  return `${turnDurationSeconds} s`;
}

function getStatusLabel(status?: string) {
  switch (status) {
    case "drafting":
      return { label: "Probíhá", class: "border-[#18C964]/40 bg-[#18C964]/15 text-[#8ef0b5]" };
    case "paused":
      return { label: "Pozastaveno", class: "border-amber-500/40 bg-amber-500/15 text-amber-300" };
    case "completed":
      return { label: "Dokončeno", class: "border-blue-500/40 bg-blue-500/15 text-blue-300" };
    default:
      return { label: "Čeká se", class: "border-slate-700 bg-slate-800 text-slate-300" };
  }
}

function TeamLogo({
  item,
  className = "h-8 w-8",
  width,
  height,
}: {
  item?: DraftItem | null;
  className?: string;
  width?: number;
  height?: number;
}) {
  const teamName = item?.name ?? "";
  const slug = teamName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const logoSrc = item?.logo || (slug ? `/logos/nhl/${slug}.png` : "");

  if (!teamName || !logoSrc) {
    return (
      <div className={`flex items-center justify-center rounded-lg bg-slate-800 text-[10px] font-bold text-slate-300 ${className}`}>
        {teamName ? teamName.slice(0, 3).toUpperCase() : "—"}
      </div>
    );
  }

  return (
    <img
      src={logoSrc}
      alt={teamName}
      width={width ?? 32}
      height={height ?? 32}
      className={`${className} object-contain`}
      loading="lazy"
    />
  );
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
  const [teamSearch, setTeamSearch] = useState("");
  const [mainTab, setMainTab] = useState<"teams" | "priorities" | "ranking">("teams");
  const [mobileTab, setMobileTab] = useState<
    "teams" | "priorities" | "ranking" | "my-teams" | "participants" | "chat" | "history"
  >("teams");
  const [sidebarTab, setSidebarTab] = useState<"participants" | "chat" | "history">("participants");

  // Player priorities state
  const [myPrioritiesOrder, setMyPrioritiesOrder] = useState<string[]>([]);
  const [savedPrioritiesOrder, setSavedPrioritiesOrder] = useState<string[]>([]);
  const [isSavingPriorities, setIsSavingPriorities] = useState(false);
  const [prioritiesFeedback, setPrioritiesFeedback] = useState<string | null>(null);
  const [draggedPriorityIndex, setDraggedPriorityIndex] = useState<number | null>(null);
  const [dragOverPriorityIndex, setDragOverPriorityIndex] = useState<number | null>(null);
  const loadedDraftIdRef = useRef<string | null>(null);
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
                boxes: (data.boxes ?? []) as DraftBox[],
                teamRanking: Array.isArray(data.teamRanking) ? (data.teamRanking as string[]) : undefined,
                teamRankingLocked: Boolean(data.teamRankingLocked || (data.status && data.status !== "waiting")),
                playerPriorities: (data.playerPriorities ?? {}) as Record<string, string[]>,
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
    if (!draft || draft.status !== "drafting" || draft.turnDurationSeconds === null) {
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

    return () => {
      window.clearInterval(intervalId);
      setTimeLeft(null);
    };
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
  const isCompleted = Boolean(
    draft && (draft.status === "completed" || availableItems.length === 0),
  );
  const isTurnExpired = Boolean(
    draft &&
      draft.status === "drafting" &&
      !isCompleted &&
      draft.turnDurationSeconds !== null &&
      timeLeft !== null &&
      timeLeft <= 0,
  );
  const canPickTeam = Boolean(
    user &&
      draft &&
      draft.status === "drafting" &&
      !isCompleted &&
      currentParticipant?.userId === user.uid &&
      !isSubmittingPick &&
      !isTurnExpired,
  );

  const filteredAvailableItems = useMemo(() => {
    const query = teamSearch.trim().toLowerCase();
    if (!query) {
      return availableItems;
    }
    return availableItems.filter((item) => item.name.toLowerCase().includes(query));
  }, [availableItems, teamSearch]);

  const myPickedTeams = useMemo(() => {
    if (!draft || !currentUserParticipant) {
      return [] as DraftItem[];
    }
    return currentUserParticipant.picks
      .map((pickedItemId) => draft.draftItems.find((item) => item.id === pickedItemId))
      .filter((item): item is DraftItem => Boolean(item));
  }, [draft, currentUserParticipant]);

  const currentRound = draft
    ? Math.floor(draft.currentPickIndex / Math.max(1, draft.participantCount)) + 1
    : 1;
  const totalPicks = draft ? Math.max(1, draft.pickOrder.length) : 0;
  const currentPickNumber = draft ? Math.min(draft.currentPickIndex + 1, totalPicks) : 0;

  // Výpočet ceny za pozici pro hráčské rozhraní
  const paidSlots = draft
    ? draft.participantCount > 0
      ? draft.participantCount
      : draft.participants.length
    : 0;
  const pricePerSlot =
    draft && paidSlots > 0 && draft.targetBreakPrice > 0
      ? Math.round(draft.targetBreakPrice / paidSlots)
      : null;

  const percentRemaining = useMemo(() => {
    if (!draft || draft.turnDurationSeconds === null) {
      return 100;
    }
    const current = timeLeft ?? draft.turnDurationSeconds;
    return Math.max(0, Math.min(100, Math.round((current / draft.turnDurationSeconds) * 100)));
  }, [draft, timeLeft]);

  const getTeamPickMeta = useCallback(
    (teamId: string) => {
      if (!draft) return null;
      const historyIndex = draft.history.findIndex((h) => h.itemId === teamId || h.newItemId === teamId);
      if (historyIndex !== -1) {
        const pickNum = historyIndex + 1;
        const roundNum = Math.floor(historyIndex / Math.max(1, draft.participantCount)) + 1;
        return { pickNumber: pickNum, round: roundNum };
      }
      return null;
    },
    [draft],
  );

  const allTeamsLookup = useMemo(() => {
    const map = new Map<string, DraftItem>();
    for (const item of defaultDraftItems) {
      map.set(item.id, item);
    }
    if (draft) {
      for (const item of draft.draftItems) {
        map.set(item.id, item);
      }
    }
    return map;
  }, [draft]);

  const draftRankingOrder = useMemo(() => {
    if (!draft) return defaultDraftItems.map((item) => item.id);
    if (draft.teamRanking && draft.teamRanking.length > 0) {
      return ensureAllTeamsInOrder(draft.teamRanking);
    }
    return draft.draftItems.map((item) => item.id);
  }, [draft]);

  const getPickedByInfo = useCallback(
    (teamId: string) => {
      if (!draft) return null;
      for (const p of draft.participants) {
        if (p.picks && p.picks.includes(teamId)) {
          const meta = getTeamPickMeta(teamId);
          return {
            participantName: p.name || `Účastník ${draft.participants.indexOf(p) + 1}`,
            round: meta?.round,
            pickNumber: meta?.pickNumber,
          };
        }
      }
      return null;
    },
    [draft, getTeamPickMeta],
  );

  useEffect(() => {
    if (!draft || !user) return;
    if (loadedDraftIdRef.current === draft.id) return;
    loadedDraftIdRef.current = draft.id;

    let initialOrder: string[] | null = null;

    if (draft.playerPriorities?.[user.uid] && draft.playerPriorities[user.uid].length > 0) {
      initialOrder = draft.playerPriorities[user.uid];
    } else if (currentUserParticipant?.priorities && currentUserParticipant.priorities.length > 0) {
      initialOrder = currentUserParticipant.priorities;
    } else if (typeof window !== "undefined") {
      const cached = window.localStorage.getItem(`dm-draft-priorities:${draft.id}:${user.uid}`);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            initialOrder = parsed;
          }
        } catch {
          // ignore
        }
      }
    }

    if (!initialOrder) {
      initialOrder = draft.teamRanking && draft.teamRanking.length > 0
        ? draft.teamRanking
        : defaultDraftItems.map((item) => item.id);
    }

    const valid = ensureAllTeamsInOrder(initialOrder);
    setMyPrioritiesOrder(valid);
    setSavedPrioritiesOrder(valid);
  }, [draft, user, currentUserParticipant]);

  const hasUnsavedPriorities = useMemo(() => {
    if (myPrioritiesOrder.length !== savedPrioritiesOrder.length) return false;
    return myPrioritiesOrder.some((id, idx) => id !== savedPrioritiesOrder[idx]);
  }, [myPrioritiesOrder, savedPrioritiesOrder]);

  const nextPriorityTeamId = useMemo(() => {
    if (!draft) return null;
    return myPrioritiesOrder.find((teamId) => draft.availableItemIds.includes(teamId)) ?? null;
  }, [draft, myPrioritiesOrder]);

  function handleMovePriority(fromIndex: number, direction: "up" | "down") {
    const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= myPrioritiesOrder.length) return;

    const nextOrder = [...myPrioritiesOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setMyPrioritiesOrder(nextOrder);
    setPrioritiesFeedback(null);
  }

  function handleDropPriority(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= myPrioritiesOrder.length || toIndex >= myPrioritiesOrder.length) {
      return;
    }
    const nextOrder = [...myPrioritiesOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setMyPrioritiesOrder(nextOrder);
    setPrioritiesFeedback(null);
  }

  function handleResetPrioritiesToDraftRanking() {
    setMyPrioritiesOrder([...draftRankingOrder]);
    setPrioritiesFeedback("Pořadí bylo nastaveno podle společného žebříčku draftu. Nezapomeňte ho uložit.");
  }

  function handleSortPrioritiesAlphabetically() {
    const sorted = [...myPrioritiesOrder].sort((a, b) => {
      const nameA = allTeamsLookup.get(a)?.name ?? a;
      const nameB = allTeamsLookup.get(b)?.name ?? b;
      return nameA.localeCompare(nameB, "cs", { sensitivity: "base" });
    });
    setMyPrioritiesOrder(sorted);
    setPrioritiesFeedback("Pořadí bylo seřazeno abecedně. Nezapomeňte ho uložit.");
  }

  function handleRevertPrioritiesToSaved() {
    setMyPrioritiesOrder([...savedPrioritiesOrder]);
    setPrioritiesFeedback("Změny byly vráceny k naposledy uloženému pořadí.");
  }

  async function handleSavePriorities(orderToSave?: string[]) {
    if (!draft || !user) return;
    const order = ensureAllTeamsInOrder(orderToSave ?? myPrioritiesOrder);
    setIsSavingPriorities(true);
    setPrioritiesFeedback(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();

      const nextParticipants = draft.participants.map((p) =>
        p.userId === user.uid ? { ...p, priorities: order } : p
      );

      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        participants: nextParticipants,
        [`playerPriorities.${user.uid}`]: order,
        updatedAt: firestoreApi.serverTimestamp(),
      });

      if (typeof window !== "undefined") {
        window.localStorage.setItem(`dm-draft-priorities:${draft.id}:${user.uid}`, JSON.stringify(order));
      }

      setSavedPrioritiesOrder(order);
      setMyPrioritiesOrder(order);
      setPrioritiesFeedback("✓ Vaše priority byly úspěšně uloženy.");
    } catch (err) {
      console.error("Error saving priorities:", err);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(`dm-draft-priorities:${draft.id}:${user.uid}`, JSON.stringify(order));
      }
      setPrioritiesFeedback("Priority byly uloženy v tomto prohlížeči.");
    } finally {
      setIsSavingPriorities(false);
    }
  }

  function handleCopyDraftRankingToMyPriorities() {
    setMyPrioritiesOrder([...draftRankingOrder]);
    setMainTab("priorities");
    setMobileTab("priorities");
    setPrioritiesFeedback("Žebříček draftu byl zkopírován do vašich priorit. Můžete ho upravit a uložit.");
  }

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
        const nextAvailableItemIds = latestAvailableItemIds.filter((availableItemId) => availableItemId !== item.id);
        const nextStatus =
          nextPickIndex >= latestPickOrder.length || nextAvailableItemIds.length === 0
            ? "completed"
            : "drafting";
        const nextParticipants = latestParticipants.map((participant, index) =>
          index === latestCurrentParticipantIndex ? { ...participant, picks: [...participant.picks, item.id] } : participant,
        );
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
      <div className="min-h-screen text-slate-100">
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
      <div className="min-h-screen text-slate-100">
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
      <div className="min-h-screen text-slate-100">
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
      <div className="min-h-screen text-slate-100">
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

  const isUrgent = timeLeft !== null && timeLeft <= 5;
  const isCritical = timeLeft !== null && timeLeft <= 3;
  const timerTextColor = isCritical
    ? "text-red-400"
    : isUrgent
      ? "text-amber-400"
      : "text-[#8ef0b5]";
  const progressBgColor = isCritical
    ? "bg-gradient-to-r from-red-600 via-rose-500 to-red-500"
    : isUrgent
      ? "bg-gradient-to-r from-amber-500 via-orange-500 to-amber-400"
      : "bg-gradient-to-r from-emerald-500 via-[#18C964] to-emerald-400";

  const statusLabel = getStatusLabel(draft.status);

  return (
    <div className="min-h-screen text-slate-100">
      <Navbar />

      <PageContainer className="py-6 lg:py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 sm:gap-6">
          {/* Sticky Alert for Mobile when Current User is on turn */}
          {isCurrentUserTurn ? (
            <div className="sticky top-16 z-30 -mt-2 flex items-center justify-between gap-3 rounded-2xl border-2 border-[#18C964] bg-emerald-950/95 px-4 py-3 text-white shadow-[0_0_30px_rgba(24,201,100,0.4)] backdrop-blur-md lg:hidden">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#18C964] opacity-75"></span>
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-[#18C964]"></span>
                </span>
                <span className="text-sm font-black tracking-wide text-[#8ef0b5]">JSTE NA TAHU!</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileTab("teams")}
                className="rounded-xl bg-[#18C964] px-3.5 py-1.5 text-xs font-black uppercase tracking-wider text-slate-950 shadow-md transition hover:bg-[#13b15a]"
              >
                Vybrat tým
              </button>
            </div>
          ) : null}

          {/* Top Panel & Scoreboard */}
          <div className="rounded-[32px] border border-slate-800/90 bg-slate-900/85 p-5 shadow-2xl shadow-slate-950/70 backdrop-blur-md sm:p-7">
            {/* Header sub-row */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/70 pb-5">
              <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#18C964]/30 bg-[#18C964]/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.25em] text-[#8ef0b5]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#18C964]"></span>
                  {draft.sport || "NHL"} Draft Room
                </span>
                <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] ${statusLabel.class}`}>
                  {statusLabel.label}
                </span>
                <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">{draft.title}</h1>
              </div>

              <div className="flex items-center gap-2.5">
                <div className="hidden items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/60 px-3.5 py-2 text-xs sm:flex">
                  <span className="text-slate-400">Přihlášen:</span>
                  <span className="font-bold text-white">{currentUserParticipant?.name || user.email}</span>
                </div>
                <button
                  type="button"
                  onClick={toggleSound}
                  className="rounded-2xl border border-slate-700/80 bg-slate-950/80 px-3.5 py-2 text-xs font-bold text-slate-200 transition hover:border-[#18C964]/40 hover:bg-slate-800"
                  title={soundEnabled ? "Vypnout zvuk" : "Zapnout zvuk"}
                >
                  {soundEnabled ? "🔊 Zvuk ZAP" : "🔇 Zvuk VYP"}
                </button>
              </div>
            </div>

            {/* Waiting Notice for Players */}
            {draft.status === "waiting" ? (
              <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="text-xl">⏳</span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-[#8ef0b5]">
                      Draft zatím nebyl zahájen
                    </p>
                    <p className="mt-0.5 text-xs text-slate-300">
                      Máte dostatek času na přípravu. V záložce <strong className="text-white">Moje priority</strong> si můžete seřadit všech 32 týmů a v záložce <strong className="text-white">Žebříček draftu</strong> prohlédnout oficiální pořadí.
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMainTab("priorities");
                      setMobileTab("priorities");
                    }}
                    className="rounded-xl border border-[#18C964]/40 bg-[#18C964]/10 px-3 py-1.5 text-xs font-bold text-[#8ef0b5] hover:bg-[#18C964]/20"
                  >
                    ⭐ Nastavit Moje priority →
                  </button>
                </div>
              </div>
            ) : null}

            {/* Scoreboard Content */}
            <div className="mt-6 grid gap-6 lg:grid-cols-[1.5fr_1fr] lg:items-center">
              {/* Active Player Card / Completed Card */}
              {isCompleted ? (
                <div className="relative overflow-hidden rounded-3xl border border-[#18C964]/50 bg-gradient-to-br from-[#18C964]/15 via-emerald-950/30 to-slate-900/90 p-5 shadow-[0_0_35px_rgba(24,201,100,0.2)] sm:p-6">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-black uppercase tracking-[0.25em] text-[#8ef0b5]">
                      STAV DRAFTU
                    </span>
                    <span className="rounded-full bg-[#18C964] px-3 py-1 text-[11px] font-black uppercase tracking-wider text-slate-950 shadow">
                      UKONČENO
                    </span>
                  </div>

                  <h2 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-4xl">
                    DRAFT DOKONČEN
                  </h2>

                  <p className="mt-1 text-xs font-semibold text-[#8ef0b5] sm:text-sm">
                    Všech 32 týmů bylo rozebráno. Děkujeme za účast!
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/80 px-3 py-1.5 font-bold text-slate-200">
                      <span className="text-slate-400">Celkem kol</span>
                      <span className="text-white">{currentRound}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/80 px-3 py-1.5 font-bold text-slate-200">
                      <span className="text-slate-400">Výběrů</span>
                      <span className="text-[#8ef0b5]">{draft.history.length}</span>
                      <span className="text-slate-500">/ {totalPicks}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-950/60 px-3 py-1.5 font-bold text-[#8ef0b5]">
                      <span>✓ Všechny týmy vybrány</span>
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className={`relative overflow-hidden rounded-3xl border p-5 sm:p-6 transition-all ${
                    isCurrentUserTurn
                      ? "border-[#18C964] bg-gradient-to-br from-[#18C964]/15 via-emerald-950/40 to-slate-900/90 shadow-[0_0_40px_rgba(24,201,100,0.25)]"
                      : "border-slate-800 bg-slate-950/70"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {isCurrentUserTurn ? (
                        <span className="relative flex h-3 w-3">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#18C964] opacity-75"></span>
                          <span className="relative inline-flex h-3 w-3 rounded-full bg-[#18C964]"></span>
                        </span>
                      ) : null}
                      <span
                        className={`text-xs font-black uppercase tracking-[0.25em] ${
                          isCurrentUserTurn ? "text-[#8ef0b5]" : "text-slate-400"
                        }`}
                      >
                        {isCurrentUserTurn ? "👉 JSTE NA TAHU!" : "AKTUÁLNĚ NA TAHU"}
                      </span>
                    </div>
                    {isCurrentUserTurn ? (
                      <span className="rounded-full bg-[#18C964] px-3 py-1 text-[11px] font-black uppercase tracking-wider text-slate-950 shadow">
                        VÁŠ VÝBĚR
                      </span>
                    ) : (
                      <span className="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-0.5 text-[11px] font-medium text-slate-400">
                        Čeká se na výběr
                      </span>
                    )}
                  </div>

                  <h2 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-4xl">
                    {currentParticipant?.name || "Čeká se na účastníka"}
                  </h2>

                  {isCurrentUserTurn ? (
                    <p className="mt-1 text-xs font-semibold text-[#8ef0b5] sm:text-sm">
                      Vyberte si svůj tým z nabídky dostupných týmů níže.
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-slate-400">
                      {currentParticipant?.email ? `(${currentParticipant.email})` : "Sledujte průběh draftu v reálném čase."}
                    </p>
                  )}

                  <div className="mt-4 flex flex-wrap gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/80 px-3 py-1.5 font-bold text-slate-200">
                      <span className="text-slate-400">Kolo</span>
                      <span className="text-white">{currentRound}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/80 px-3 py-1.5 font-bold text-slate-200">
                      <span className="text-slate-400">Tah</span>
                      <span className="text-[#8ef0b5]">{currentPickNumber}</span>
                      <span className="text-slate-500">/ {totalPicks}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/80 px-3 py-1.5 font-bold text-slate-200">
                      <span className="text-slate-400">Dostupných týmů</span>
                      <span className="text-white">{availableItems.length}</span>
                    </span>
                  </div>
                </div>
              )}

              {/* Countdown Scoreboard Clock / Completed Status Box */}
              {isCompleted ? (
                <div className="relative flex flex-col justify-between rounded-3xl border border-slate-800 bg-slate-950/70 p-5 sm:p-6">
                  <div className="flex items-center justify-between text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                    <span>Časovač</span>
                    <span className="text-[11px] text-[#8ef0b5]">Zastaven</span>
                  </div>

                  <div className="my-3 text-center sm:text-left">
                    <p className="text-xl font-bold text-white sm:text-2xl">
                      Všech 32 týmů bylo rozebráno
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Výsledky a týmy účastníků naleznete níže v přehledu.
                    </p>
                  </div>

                  <div className="mt-2 space-y-1.5">
                    <div className="h-3 w-full overflow-hidden rounded-full bg-slate-800/90 p-0.5">
                      <div className="h-full w-full rounded-full bg-gradient-to-r from-emerald-500 via-[#18C964] to-emerald-400" />
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className={`relative flex flex-col justify-between rounded-3xl border p-5 sm:p-6 transition-all ${
                    isCritical
                      ? "animate-pulse border-red-500/60 bg-red-950/40 shadow-[0_0_35px_rgba(239,68,68,0.35)]"
                      : isUrgent
                        ? "border-amber-500/50 bg-amber-950/30 shadow-[0_0_25px_rgba(245,158,11,0.25)]"
                        : "border-slate-800 bg-slate-950/70"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                    <span>Zbývající čas</span>
                    <span className="text-[11px] text-slate-500">
                      Limit: {formatTurnDurationLabel(draft.turnDurationSeconds)}
                    </span>
                  </div>

                  <div className="my-2 flex items-baseline justify-between gap-4">
                    <div className="flex items-baseline gap-2">
                      <span className={`font-mono text-5xl font-black tracking-tight sm:text-6xl ${timerTextColor}`}>
                        {draft.turnDurationSeconds === null ? "∞" : (timeLeft ?? draft.turnDurationSeconds)}
                      </span>
                      {draft.turnDurationSeconds !== null ? (
                        <span className="text-sm font-bold uppercase tracking-widest text-slate-400">sekund</span>
                      ) : (
                        <span className="text-xs font-bold uppercase tracking-widest text-slate-400">bez limitu</span>
                      )}
                    </div>
                    {draft.turnDurationSeconds !== null ? (
                      <span className="font-mono text-sm font-semibold text-slate-400">
                        {percentRemaining}%
                      </span>
                    ) : null}
                  </div>

                  {/* Progress Bar */}
                  <div className="mt-2 space-y-1.5">
                    <div className="h-3 w-full overflow-hidden rounded-full bg-slate-800/90 p-0.5">
                      <div
                        className={`h-full rounded-full transition-all duration-1000 ease-linear ${progressBgColor}`}
                        style={{ width: `${percentRemaining}%` }}
                      />
                    </div>
                  </div>

                  {isTurnExpired ? (
                    <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/15 px-3 py-2 text-center text-xs font-bold text-red-300">
                      ⏰ Čas vypršel – čeká se na rozhodnutí admina.
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          {/* Product / Box Info sub-banner */}
          {draft.productName ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800/80 bg-slate-900/60 px-5 py-3.5 backdrop-blur-sm">
              <div className="flex items-center gap-3.5">
                {draft.productImageUrl ? (
                  <img
                    src={draft.productImageUrl}
                    alt={draft.productName}
                    className="h-12 w-12 rounded-xl border border-slate-800 object-cover"
                  />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-xl">
                    📦
                  </div>
                )}
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">Box / Produkt</p>
                  <p className="text-base font-bold text-white">{draft.productName}</p>
                  {draft.productSeason ? <p className="text-xs text-slate-400">{draft.productSeason}</p> : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {draft.boxCount ? (
                  <span className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-1.5 font-semibold text-slate-300">
                    Počet boxů: <span className="font-bold text-white">{draft.boxCount}</span>
                  </span>
                ) : null}
                {pricePerSlot !== null ? (
                  <span className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-1.5 font-semibold text-slate-300">
                    Cena za pozici: <span className="font-bold text-[#8ef0b5]">{pricePerSlot.toLocaleString("cs-CZ")} Kč</span>
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Messages & Alerts */}
          {error || accessMessage ? (
            <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error ?? accessMessage}
            </div>
          ) : null}

          {draft.status === "completed" ? (
            <div className="rounded-2xl border border-[#18C964]/40 bg-[#18C964]/10 px-5 py-4 text-center font-bold text-[#8ef0b5]">
              🎉 Draft byl úspěšně dokončen! Všechny týmy byly vybrány.
            </div>
          ) : null}

          {/* Mobile Navigation Tabs */}
          <div className="flex gap-2 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/80 p-1.5 lg:hidden">
            <button
              type="button"
              onClick={() => {
                setMobileTab("teams");
                setMainTab("teams");
              }}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                mobileTab === "teams"
                  ? "bg-[#18C964] text-slate-950 shadow"
                  : "text-slate-300 hover:bg-slate-900"
              }`}
            >
              <span>🏒 Týmy</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${mobileTab === "teams" ? "bg-slate-950/20 text-slate-950" : "bg-slate-800 text-slate-300"}`}>
                {availableItems.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMobileTab("priorities");
                setMainTab("priorities");
              }}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                mobileTab === "priorities"
                  ? "bg-[#18C964] text-slate-950 shadow"
                  : "text-slate-300 hover:bg-slate-900"
              }`}
            >
              <span>⭐ Moje priority</span>
              {hasUnsavedPriorities ? (
                <span className="h-2 w-2 rounded-full bg-amber-400"></span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => {
                setMobileTab("ranking");
                setMainTab("ranking");
              }}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                mobileTab === "ranking"
                  ? "bg-[#18C964] text-slate-950 shadow"
                  : "text-slate-300 hover:bg-slate-900"
              }`}
            >
              <span>📊 Žebříček draftu</span>
            </button>
            <button
              type="button"
              onClick={() => setMobileTab("my-teams")}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                mobileTab === "my-teams"
                  ? "bg-[#18C964] text-slate-950 shadow"
                  : "text-slate-300 hover:bg-slate-900"
              }`}
            >
              <span>⭐ Moje týmy</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${mobileTab === "my-teams" ? "bg-slate-950/20 text-slate-950" : "bg-slate-800 text-slate-300"}`}>
                {myPickedTeams.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMobileTab("participants")}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                mobileTab === "participants"
                  ? "bg-[#18C964] text-slate-950 shadow"
                  : "text-slate-300 hover:bg-slate-900"
              }`}
            >
              <span>👥 Účastníci</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${mobileTab === "participants" ? "bg-slate-950/20 text-slate-950" : "bg-slate-800 text-slate-300"}`}>
                {draft.participants.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMobileTab("chat")}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                mobileTab === "chat"
                  ? "bg-[#18C964] text-slate-950 shadow"
                  : "text-slate-300 hover:bg-slate-900"
              }`}
            >
              <span>💬 Chat</span>
            </button>
            <button
              type="button"
              onClick={() => setMobileTab("history")}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
                mobileTab === "history"
                  ? "bg-[#18C964] text-slate-950 shadow"
                  : "text-slate-300 hover:bg-slate-900"
              }`}
            >
              <span>📜 Historie</span>
            </button>
          </div>

          {/* Main Layout Grid */}
          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr] xl:grid-cols-[1.8fr_1fr]">
            {/* Primary Column: Tabs (Týmy k výběru, Moje priority, Žebříček draftu) */}
            {(() => {
              const activePrimaryTab =
                mobileTab === "priorities" || mobileTab === "ranking" ? mobileTab : mainTab;

              return (
                <div
                  className={`space-y-4 ${
                    mobileTab !== "teams" && mobileTab !== "priorities" && mobileTab !== "ranking"
                      ? "hidden lg:block"
                      : ""
                  }`}
                >
                  <div className="rounded-[32px] border border-slate-800/90 bg-slate-900/85 p-5 shadow-2xl backdrop-blur-md sm:p-7">
                    {/* Desktop View Switcher */}
                    <div className="hidden items-center justify-between gap-4 border-b border-slate-800/80 pb-5 sm:flex">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setMainTab("teams");
                            setMobileTab("teams");
                          }}
                          className={`flex items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-bold transition ${
                            activePrimaryTab === "teams"
                              ? "bg-[#18C964] text-slate-950 shadow"
                              : "border border-slate-800 bg-slate-950/70 text-slate-300 hover:bg-slate-900 hover:text-white"
                          }`}
                        >
                          <span>🏒 Týmy k výběru</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              activePrimaryTab === "teams"
                                ? "bg-slate-950/20 text-slate-950"
                                : "bg-slate-800 text-slate-300"
                            }`}
                          >
                            {availableItems.length}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setMainTab("priorities");
                            setMobileTab("priorities");
                          }}
                          className={`flex items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-bold transition ${
                            activePrimaryTab === "priorities"
                              ? "bg-[#18C964] text-slate-950 shadow"
                              : "border border-slate-800 bg-slate-950/70 text-slate-300 hover:bg-slate-900 hover:text-white"
                          }`}
                        >
                          <span>⭐ Moje priority</span>
                          {hasUnsavedPriorities ? (
                            <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-black uppercase text-slate-950">
                              Neuloženo
                            </span>
                          ) : (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                activePrimaryTab === "priorities"
                                  ? "bg-slate-950/20 text-slate-950"
                                  : "bg-slate-800 text-slate-300"
                              }`}
                            >
                              32
                            </span>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setMainTab("ranking");
                            setMobileTab("ranking");
                          }}
                          className={`flex items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-bold transition ${
                            activePrimaryTab === "ranking"
                              ? "bg-[#18C964] text-slate-950 shadow"
                              : "border border-slate-800 bg-slate-950/70 text-slate-300 hover:bg-slate-900 hover:text-white"
                          }`}
                        >
                          <span>📊 Žebříček draftu</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              activePrimaryTab === "ranking"
                                ? "bg-slate-950/20 text-slate-950"
                                : "bg-slate-800 text-slate-300"
                            }`}
                          >
                            32
                          </span>
                        </button>
                      </div>

                      {activePrimaryTab === "priorities" && hasUnsavedPriorities ? (
                        <span className="text-xs font-semibold text-amber-300">
                          ⚠️ Máte neuložené změny v prioritách
                        </span>
                      ) : null}
                    </div>

                    {/* 1. TEAMS GRID VIEW */}
                    {activePrimaryTab === "teams" && (
                      <div className="space-y-4 pt-2 sm:pt-4">
                        {/* Search & Counter header */}
                        <div className="flex flex-col gap-4 border-b border-slate-800/80 pb-5 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-xl font-black tracking-tight text-white sm:text-2xl">
                                Dostupné NHL týmy
                              </h3>
                              <span className="rounded-full border border-[#18C964]/30 bg-[#18C964]/10 px-2.5 py-0.5 text-xs font-bold text-[#8ef0b5]">
                                {availableItems.length}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-slate-400">
                              {isCompleted
                                ? "Všech 32 týmů bylo rozebráno. Draft je u konce."
                                : canPickTeam
                                  ? "👉 Jste na tahu! Klikněte na tlačítko „Vybrat“ u vašeho vybraného týmu."
                                  : "Výběr týmu je aktivní pouze tehdy, když jste na tahu."}
                            </p>
                          </div>

                          {/* Team Search Input */}
                          <div className="relative w-full sm:w-64">
                            <input
                              type="text"
                              value={teamSearch}
                              onChange={(event) => setTeamSearch(event.target.value)}
                              placeholder="Hledat tým (např. Bruins)..."
                              className="w-full rounded-2xl border border-slate-800 bg-slate-950/80 px-4 py-2.5 text-xs text-white placeholder-slate-500 outline-none transition focus:border-[#18C964]/60 focus:ring-1 focus:ring-[#18C964]/40"
                            />
                            {teamSearch ? (
                              <button
                                type="button"
                                onClick={() => setTeamSearch("")}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-white"
                                title="Vymazat filtr"
                              >
                                ✕
                              </button>
                            ) : null}
                          </div>
                        </div>

                        {/* Submit state alert */}
                        {isSubmittingPick ? (
                          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-[#18C964]/40 bg-[#18C964]/10 px-4 py-3 text-xs font-bold text-[#8ef0b5]">
                            <span className="h-2 w-2 rounded-full bg-[#18C964] animate-ping"></span>
                            Ukládám váš výběr do databáze draftu...
                          </div>
                        ) : null}

                        {/* Teams Grid */}
                        <div className="mt-6">
                          {filteredAvailableItems.length > 0 ? (
                            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-3 xl:grid-cols-4">
                              {filteredAvailableItems.map((item) => (
                                <div
                                  key={item.id}
                                  className={`group relative flex flex-col items-center justify-between rounded-2xl border p-4 text-center transition-all ${
                                    canPickTeam
                                      ? "border-slate-800/90 bg-slate-950/70 hover:border-[#18C964] hover:bg-slate-900/90 hover:shadow-[0_0_25px_rgba(24,201,100,0.25)] hover:-translate-y-1"
                                      : "border-slate-800/50 bg-slate-950/40 opacity-70"
                                  }`}
                                >
                                  <div className="flex h-20 w-full items-center justify-center p-1">
                                    <TeamLogo
                                      item={item}
                                      width={72}
                                      height={72}
                                      className="h-16 w-16 drop-shadow-[0_4px_10px_rgba(0,0,0,0.8)] transition-transform duration-200 group-hover:scale-110 sm:h-18 sm:w-18"
                                    />
                                  </div>

                                  <p className="mt-2.5 line-clamp-2 text-xs font-bold leading-tight text-white transition group-hover:text-[#8ef0b5] sm:text-sm">
                                    {item.name}
                                  </p>

                                  <div className="mt-3.5 w-full">
                                    {canPickTeam ? (
                                      <button
                                        type="button"
                                        onClick={() => void handleSelectItem(item)}
                                        disabled={isSubmittingPick}
                                        className="w-full rounded-xl bg-gradient-to-r from-[#18C964] to-[#13b15a] py-2 text-center text-xs font-black uppercase tracking-wider text-slate-950 shadow-md transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        {isSubmittingPick ? "Ukládám…" : "Vybrat"}
                                      </button>
                                    ) : (
                                      <span className="block w-full rounded-xl border border-slate-800/80 bg-slate-900/60 py-1.5 text-center text-[11px] font-semibold text-slate-500">
                                        {isTurnExpired ? "Čas vypršel" : "Čeká na tah"}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 p-8 text-center">
                              <p className="text-3xl">🏒</p>
                              <p className="mt-2 text-sm font-bold text-slate-300">Žádné dostupné týmy</p>
                              <p className="mt-1 text-xs text-slate-500">
                                {teamSearch
                                  ? `Žádný dostupný tým neodpovídá hledání „${teamSearch}“.`
                                  : "Všechny týmy z tohoto draftu už byly vybrány."}
                              </p>
                              {teamSearch ? (
                                <button
                                  type="button"
                                  onClick={() => setTeamSearch("")}
                                  className="mt-3 rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                                >
                                  Zrušit filtr
                                </button>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 2. MOJE PRIORITY VIEW */}
                    {activePrimaryTab === "priorities" && (
                      <div className="space-y-5 pt-2 sm:pt-4">
                        {/* Header info & action buttons */}
                        <div className="flex flex-col gap-4 border-b border-slate-800/80 pb-5 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-xl font-black tracking-tight text-white sm:text-2xl">
                                Moje priority výběru
                              </h3>
                              <span className="rounded-full border border-[#18C964]/30 bg-[#18C964]/10 px-2.5 py-0.5 text-xs font-bold text-[#8ef0b5]">
                                32 týmů
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-slate-400">
                              Seřaďte si všech 32 týmů přetažením myší nebo tlačítky ▲ / ▼. Již vybrané týmy budou automaticky přeskočeny.
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleResetPrioritiesToDraftRanking()}
                              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-white"
                              title="Nastavit pořadí podle společného žebříčku draftu"
                            >
                              📊 Dle žebříčku draftu
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSortPrioritiesAlphabetically()}
                              className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-white"
                              title="Seřadit týmy abecedně"
                            >
                              🔤 Abecedně
                            </button>
                            {hasUnsavedPriorities ? (
                              <button
                                type="button"
                                onClick={() => handleRevertPrioritiesToSaved()}
                                className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-400 transition hover:bg-slate-800 hover:text-white"
                              >
                                ↩ Zrušit změny
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void handleSavePriorities()}
                              disabled={isSavingPriorities}
                              className="rounded-xl bg-gradient-to-r from-[#18C964] to-[#13b15a] px-4 py-2 text-xs font-black uppercase tracking-wider text-slate-950 shadow-md transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {isSavingPriorities ? "Ukládám..." : "💾 Uložit priority"}
                            </button>
                          </div>
                        </div>

                        {/* Feedback alert */}
                        {prioritiesFeedback ? (
                          <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/40 bg-emerald-950/40 px-4 py-3 text-xs font-bold text-[#8ef0b5]">
                            <span>✓</span>
                            <span>{prioritiesFeedback}</span>
                          </div>
                        ) : null}

                        {/* Next in line callout */}
                        {nextPriorityTeamId ? (
                          (() => {
                            const nextTeam = allTeamsLookup.get(nextPriorityTeamId);
                            return (
                              <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#18C964]/50 bg-gradient-to-r from-[#18C964]/15 via-emerald-950/30 to-slate-950/60 p-4 shadow-sm">
                                <div className="flex items-center gap-3">
                                  {nextTeam ? (
                                    <TeamLogo item={nextTeam} width={36} height={36} className="h-9 w-9 shrink-0" />
                                  ) : null}
                                  <div>
                                    <p className="text-[11px] font-black uppercase tracking-wider text-[#8ef0b5]">
                                      🎯 Vaše 1. volba na řadě pro výběr:
                                    </p>
                                    <p className="text-sm font-bold text-white">
                                      {nextTeam?.name ?? nextPriorityTeamId}
                                    </p>
                                  </div>
                                </div>
                                <span className="hidden sm:inline-block rounded-full bg-[#18C964]/20 px-3 py-1 text-[11px] font-bold text-[#8ef0b5]">
                                  Bude vybrán jako první
                                </span>
                              </div>
                            );
                          })()
                        ) : null}

                        {/* Priorities list */}
                        <div className="space-y-2 max-h-[640px] overflow-y-auto pr-1">
                          {myPrioritiesOrder.map((teamId, index) => {
                            const team = allTeamsLookup.get(teamId);
                            const isAvailable = draft.availableItemIds.includes(teamId);
                            const isNext = teamId === nextPriorityTeamId;
                            const pickedInfo = getPickedByInfo(teamId);
                            const isDragging = draggedPriorityIndex === index;
                            const isTarget = dragOverPriorityIndex === index;

                            return (
                              <div
                                key={teamId}
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData("text/plain", String(index));
                                  setDraggedPriorityIndex(index);
                                }}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  if (dragOverPriorityIndex !== index) setDragOverPriorityIndex(index);
                                }}
                                onDragLeave={() => {
                                  if (dragOverPriorityIndex === index) setDragOverPriorityIndex(null);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const fromIdx = Number(e.dataTransfer.getData("text/plain"));
                                  if (!Number.isNaN(fromIdx)) {
                                    handleDropPriority(fromIdx, index);
                                  }
                                  setDraggedPriorityIndex(null);
                                  setDragOverPriorityIndex(null);
                                }}
                                onDragEnd={() => {
                                  setDraggedPriorityIndex(null);
                                  setDragOverPriorityIndex(null);
                                }}
                                className={`flex items-center justify-between gap-3 rounded-2xl border p-3 transition-all select-none cursor-grab active:cursor-grabbing ${
                                  isDragging
                                    ? "opacity-30 border-dashed border-[#18C964]"
                                    : isTarget
                                      ? "border-2 border-[#18C964] bg-emerald-950/40"
                                      : isNext
                                        ? "border-[#18C964]/70 bg-[#18C964]/10 shadow-[0_0_15px_rgba(24,201,100,0.15)]"
                                        : !isAvailable
                                          ? "border-slate-900 bg-slate-950/40 opacity-60"
                                          : "border-slate-800 bg-slate-950/70 hover:border-slate-700"
                                }`}
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className="text-slate-600 font-mono text-xs">⋮⋮</span>
                                  <span
                                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs font-black ${
                                      index === 0
                                        ? "bg-amber-400 text-slate-950"
                                        : index === 1
                                          ? "bg-slate-300 text-slate-950"
                                          : index === 2
                                            ? "bg-amber-700 text-white"
                                            : "bg-slate-800 text-slate-300"
                                    }`}
                                  >
                                    {index + 1}
                                  </span>
                                  {team ? (
                                    <TeamLogo item={team} width={28} height={28} className="h-7 w-7 shrink-0" />
                                  ) : null}
                                  <div className="min-w-0">
                                    <p
                                      className={`truncate text-sm font-bold ${
                                        !isAvailable ? "line-through text-slate-400" : "text-white"
                                      }`}
                                    >
                                      {team?.name || teamId}
                                    </p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                      {isNext ? (
                                        <span className="text-[10px] font-black uppercase text-[#8ef0b5]">
                                          🎯 1. na řadě pro výběr
                                        </span>
                                      ) : isAvailable ? (
                                        <span className="text-[10px] font-semibold text-slate-400">
                                          ✓ Volný k výběru
                                        </span>
                                      ) : (
                                        <span className="text-[10px] font-semibold text-red-400">
                                          ❌ Vybráno ({pickedInfo?.participantName ?? "v draftu"}) · Přeskočí se
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0">
                                  {canPickTeam && isAvailable && team ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleSelectItem(team)}
                                      disabled={isSubmittingPick}
                                      className="rounded-xl bg-[#18C964] px-3 py-1.5 text-xs font-black uppercase text-slate-950 hover:bg-[#13b15a]"
                                    >
                                      Vybrat
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => handleMovePriority(index, "up")}
                                    disabled={index === 0}
                                    className="h-7 w-7 rounded-lg border border-slate-800 bg-slate-900 text-xs text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-20"
                                    title="Posunout nahoru"
                                  >
                                    ▲
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleMovePriority(index, "down")}
                                    disabled={index === myPrioritiesOrder.length - 1}
                                    className="h-7 w-7 rounded-lg border border-slate-800 bg-slate-900 text-xs text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-20"
                                    title="Posunout dolů"
                                  >
                                    ▼
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* 3. DRAFT RANKING VIEW */}
                    {activePrimaryTab === "ranking" && (
                      <div className="space-y-5 pt-2 sm:pt-4">
                        {/* Header info & action buttons */}
                        <div className="flex flex-col gap-4 border-b border-slate-800/80 pb-5 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-xl font-black tracking-tight text-white sm:text-2xl">
                                Žebříček draftu (společné pořadí)
                              </h3>
                              <span className="rounded-full border border-[#18C964]/30 bg-[#18C964]/10 px-2.5 py-0.5 text-xs font-bold text-[#8ef0b5]">
                                32 týmů
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-slate-400">
                              Společné pořadí atraktivity všech 32 týmů NHL vypočtené ze zvolených boxů a nastavené organizátorem pro tento draft.
                            </p>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleCopyDraftRankingToMyPriorities()}
                            className="rounded-xl border border-[#18C964]/40 bg-[#18C964]/10 px-3.5 py-2 text-xs font-bold text-[#8ef0b5] transition hover:bg-[#18C964]/20"
                          >
                            📋 Použít jako moje priority
                          </button>
                        </div>

                        {/* Ranking list */}
                        <div className="space-y-2 max-h-[640px] overflow-y-auto pr-1">
                          {draftRankingOrder.map((teamId, index) => {
                            const team = allTeamsLookup.get(teamId);
                            const isAvailable = draft.availableItemIds.includes(teamId);
                            const pickedInfo = getPickedByInfo(teamId);

                            return (
                              <div
                                key={teamId}
                                className={`flex items-center justify-between gap-3 rounded-2xl border p-3 transition-all ${
                                  !isAvailable
                                    ? "border-slate-900 bg-slate-950/40 opacity-60"
                                    : "border-slate-800 bg-slate-950/70 hover:border-slate-700"
                                }`}
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <span
                                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs font-black ${
                                      index === 0
                                        ? "bg-amber-400 text-slate-950"
                                        : index === 1
                                          ? "bg-slate-300 text-slate-950"
                                          : index === 2
                                            ? "bg-amber-700 text-white"
                                            : "bg-slate-800 text-slate-300"
                                    }`}
                                  >
                                    {index + 1}
                                  </span>
                                  {team ? (
                                    <TeamLogo item={team} width={28} height={28} className="h-7 w-7 shrink-0" />
                                  ) : null}
                                  <div className="min-w-0">
                                    <p
                                      className={`truncate text-sm font-bold ${
                                        !isAvailable ? "line-through text-slate-400" : "text-white"
                                      }`}
                                    >
                                      {team?.name || teamId}
                                    </p>
                                    <p className="text-[10px] text-slate-400">
                                      {isAvailable ? (
                                        <span className="font-semibold text-[#8ef0b5]">✓ Volný k výběru</span>
                                      ) : (
                                        <span className="font-semibold text-slate-400">
                                          ❌ Vybral: {pickedInfo?.participantName ?? "Účastník"}
                                          {pickedInfo?.round
                                            ? ` (Kolo ${pickedInfo.round}, Tah #${pickedInfo.pickNumber})`
                                            : ""}
                                        </span>
                                      )}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                  {canPickTeam && isAvailable && team ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleSelectItem(team)}
                                      disabled={isSubmittingPick}
                                      className="rounded-xl bg-[#18C964] px-3 py-1.5 text-xs font-black uppercase text-slate-950 hover:bg-[#13b15a]"
                                    >
                                      Vybrat
                                    </button>
                                  ) : null}
                                  <span
                                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                      isAvailable
                                        ? "border border-emerald-500/30 bg-emerald-950/40 text-[#8ef0b5]"
                                        : "border border-slate-800 bg-slate-900 text-slate-500"
                                    }`}
                                  >
                                    {isAvailable ? "Dostupný" : "Vybrán"}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Secondary Column: "Moje týmy", Tabs (Účastníci, Chat, Historie) */}
            <div className="space-y-6">
              {/* "Moje týmy" Card - visible on desktop always, on mobile when active tab */}
              <div
                className={`rounded-[32px] border border-slate-800/90 bg-slate-900/85 p-5 shadow-2xl backdrop-blur-md sm:p-6 ${
                  mobileTab !== "my-teams" ? "hidden lg:block" : ""
                }`}
              >
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xl">⭐</span>
                    <div>
                      <h3 className="text-base font-bold text-white sm:text-lg">Moje týmy</h3>
                      <p className="text-[11px] text-slate-400">Přehled vašich dosavadních výběrů</p>
                    </div>
                  </div>
                  <span className="rounded-full border border-[#18C964]/30 bg-[#18C964]/10 px-2.5 py-0.5 text-xs font-bold text-[#8ef0b5]">
                    {myPickedTeams.length} {myPickedTeams.length === 1 ? "tým" : myPickedTeams.length >= 2 && myPickedTeams.length <= 4 ? "týmy" : "týmů"}
                  </span>
                </div>

                {myPickedTeams.length > 0 ? (
                  <div className="mt-4 grid gap-2.5">
                    {myPickedTeams.map((item) => {
                      const meta = getTeamPickMeta(item.id);
                      return (
                        <div
                          key={item.id}
                          className="flex items-center gap-3.5 rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-sm transition hover:border-[#18C964]/30"
                        >
                          <TeamLogo item={item} width={44} height={44} className="h-11 w-11 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-white">{item.name}</p>
                            {meta ? (
                              <p className="text-[11px] font-semibold text-[#8ef0b5]">
                                Kolo {meta.round} · Celkový výběr #{meta.pickNumber}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center">
                    <p className="text-3xl">🏒</p>
                    <p className="mt-2 text-xs font-bold text-slate-300">Zatím jste nevybrali žádný tým</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Jakmile na vás přijde řada, klikněte na tlačítko „Vybrat“ u vašeho preferovaného týmu.
                    </p>
                  </div>
                )}
              </div>

              {/* Sidebar Panel for Participants / Chat / History */}
              <div
                className={`rounded-[32px] border border-slate-800/90 bg-slate-900/85 p-5 shadow-2xl backdrop-blur-md sm:p-6 ${
                  mobileTab === "teams" || mobileTab === "my-teams" ? "hidden lg:block" : ""
                }`}
              >
                {/* Desktop Tabs Header (on mobile, tabs are chosen via mobile tab bar) */}
                <div className="hidden border-b border-slate-800/80 pb-3 gap-2 lg:flex">
                  <button
                    type="button"
                    onClick={() => setSidebarTab("participants")}
                    className={`flex-1 rounded-xl py-2 text-center text-xs font-bold transition ${
                      sidebarTab === "participants"
                        ? "bg-[#18C964] text-slate-950 shadow"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    Účastníci ({draft.participants.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSidebarTab("chat")}
                    className={`flex-1 rounded-xl py-2 text-center text-xs font-bold transition ${
                      sidebarTab === "chat"
                        ? "bg-[#18C964] text-slate-950 shadow"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => setSidebarTab("history")}
                    className={`flex-1 rounded-xl py-2 text-center text-xs font-bold transition ${
                      sidebarTab === "history"
                        ? "bg-[#18C964] text-slate-950 shadow"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    Historie
                  </button>
                </div>

                {/* 1. PARTICIPANTS LIST */}
                {(sidebarTab === "participants" || mobileTab === "participants") && (
                  <div className="space-y-3 pt-2 lg:pt-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold text-white">Přehled účastníků</h4>
                      <span className="text-[11px] text-slate-500">V pořadí podle rozpisu</span>
                    </div>

                    <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
                      {draft.participants.map((participant, index) => {
                        const isCurrent = currentParticipant?.id === participant.id;
                        const isMe = user?.uid && participant.userId === user.uid;
                        const pickedTeams = participant.picks
                          .map((pickedItemId) => draft.draftItems.find((currentItem) => currentItem.id === pickedItemId))
                          .filter((item): item is DraftItem => Boolean(item));

                        return (
                          <div
                            key={participant.id}
                            className={`rounded-2xl border p-3.5 transition-all ${
                              isCurrent
                                ? "border-[#18C964] bg-emerald-950/30 shadow-[0_0_15px_rgba(24,201,100,0.15)]"
                                : "border-slate-800 bg-slate-950/70"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-[11px] font-bold text-slate-300">
                                  {index + 1}
                                </span>
                                <p className="truncate text-sm font-bold text-white">
                                  {participant.name || `Účastník ${index + 1}`}
                                </p>
                                {isMe ? (
                                  <span className="rounded-md bg-[#18C964]/20 px-1.5 py-0.5 text-[10px] font-black uppercase text-[#8ef0b5]">
                                    Vy
                                  </span>
                                ) : null}
                              </div>

                              {!isCompleted && isCurrent ? (
                                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#18C964]/40 bg-[#18C964]/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#8ef0b5]">
                                  <span className="h-1.5 w-1.5 rounded-full bg-[#18C964] animate-ping"></span>
                                  Na tahu
                                </span>
                              ) : (
                                <span className="rounded-md border border-slate-800 bg-slate-900/80 px-2 py-0.5 text-[11px] font-semibold text-slate-400">
                                  {participant.picks.length} {participant.picks.length === 1 ? "tým" : participant.picks.length >= 2 && participant.picks.length <= 4 ? "týmy" : "týmů"}
                                </span>
                              )}
                            </div>

                            {pickedTeams.length > 0 ? (
                              <div className="mt-2.5 flex flex-wrap gap-1.5">
                                {pickedTeams.map((item, pickedIndex) => (
                                  <div
                                    key={`${participant.id}-${item.id}-${pickedIndex}`}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-200"
                                    title={item.name}
                                  >
                                    <TeamLogo item={item} width={18} height={18} className="h-4.5 w-4.5 shrink-0" />
                                    <span className="max-w-[120px] truncate">{item.name}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 2. CHAT */}
                {(sidebarTab === "chat" || mobileTab === "chat") && (
                  <div className="pt-2 lg:pt-4">
                    <DraftChat
                      draftId={draft.id}
                      draftCode={draft.code}
                      currentUser={user}
                      currentUserRole={profile?.role ?? null}
                      isEmbedded={true}
                    />
                  </div>
                )}

                {/* 3. HISTORY */}
                {(sidebarTab === "history" || mobileTab === "history") && (
                  <div className="space-y-3 pt-2 lg:pt-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="text-sm font-bold text-white">Historie výběrů</h4>
                        <p className="text-[11px] text-slate-400">Poslední provedené tahy</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsHistoryDialogOpen(true)}
                        disabled={historyEntries.length === 0}
                        className="rounded-xl border border-slate-700/80 bg-slate-950/80 px-3 py-1.5 text-xs font-bold text-slate-200 transition hover:border-[#18C964]/40 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Zobrazit vše ({historyEntries.length})
                      </button>
                    </div>

                    {recentHistoryEntries.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center text-xs text-slate-400">
                        Draft zatím nemá žádný výběr.
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
                        {recentHistoryEntries.slice(0, 6).map((historyEntry, index) => {
                          const isLatest = index === 0;

                          return (
                            <div
                              key={`${historyEntry.entry.type}-${historyEntry.historyIndex}`}
                              className={`rounded-2xl border p-3 transition ${
                                isLatest
                                  ? "border-[#18C964]/50 bg-[#18C964]/10 shadow-sm"
                                  : "border-slate-800 bg-slate-950/70"
                              }`}
                            >
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="font-bold text-slate-400">Tah #{historyEntry.turnNumber}</span>
                                <span className="font-semibold text-white">{historyEntry.participantName}</span>
                              </div>
                              <p className="mt-1 text-xs text-slate-300">{renderHistoryText(historyEntry)}</p>

                              {historyEntry.entry.type === "pick" && historyEntry.selectedItem ? (
                                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-200">
                                  <TeamLogo item={historyEntry.selectedItem} width={20} height={20} className="h-5 w-5" />
                                  <span className="font-semibold">{historyEntry.selectedItem.name}</span>
                                </div>
                              ) : null}

                              {historyEntry.entry.type === "replace" ? (
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-200">
                                  <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1">
                                    <TeamLogo item={historyEntry.oldItem} width={20} height={20} className="h-5 w-5" />
                                    <span>{historyEntry.oldItem?.name ?? historyEntry.entry.oldItemName ?? "Původní"}</span>
                                  </span>
                                  <span className="text-slate-500">→</span>
                                  <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1">
                                    <TeamLogo item={historyEntry.newItem} width={20} height={20} className="h-5 w-5" />
                                    <span>{historyEntry.newItem?.name ?? historyEntry.entry.newItemName ?? "Nový"}</span>
                                  </span>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </PageContainer>

      {/* Full History Modal Dialog */}
      {isHistoryDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
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
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-[32px] border border-slate-700 bg-slate-900 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
              <div>
                <h3 className="text-xl font-bold text-white">Kompletní historie draftu</h3>
                <p className="mt-0.5 text-xs text-slate-400">Všechny záznamy od nejnovějšího po nejstarší ({historyEntries.length})</p>
              </div>
              <button
                type="button"
                onClick={closeHistoryDialog}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-800 text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {historyEntries.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">Draft zatím nemá žádný výběr.</p>
              ) : (
                <div className="space-y-3">
                  {historyEntries.map((historyEntry, index) => {
                    const isLatest = index === 0;

                    return (
                      <div
                        key={`modal-${historyEntry.entry.type}-${historyEntry.historyIndex}`}
                        className={`rounded-2xl border p-4 ${
                          isLatest
                            ? "border-[#18C964]/50 bg-[#18C964]/10 shadow-sm"
                            : "border-slate-800 bg-slate-950/60"
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold uppercase tracking-wider text-slate-400">
                            Tah #{historyEntry.turnNumber}
                          </span>
                          <span className="font-bold text-white">{historyEntry.participantName}</span>
                        </div>
                        <p className="mt-1 text-sm text-slate-200">{renderHistoryText(historyEntry)}</p>

                        {historyEntry.entry.type === "pick" && historyEntry.selectedItem ? (
                          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-sm text-slate-200">
                            <TeamLogo item={historyEntry.selectedItem} width={24} height={24} className="h-6 w-6" />
                            <span className="font-semibold">{historyEntry.selectedItem.name}</span>
                          </div>
                        ) : null}

                        {historyEntry.entry.type === "replace" ? (
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-200">
                            <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1">
                              <TeamLogo item={historyEntry.oldItem} width={24} height={24} className="h-6 w-6" />
                              <span>{historyEntry.oldItem?.name ?? historyEntry.entry.oldItemName ?? "Původní"}</span>
                            </span>
                            <span className="text-slate-500">→</span>
                            <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1">
                              <TeamLogo item={historyEntry.newItem} width={24} height={24} className="h-6 w-6" />
                              <span>{historyEntry.newItem?.name ?? historyEntry.entry.newItemName ?? "Nový"}</span>
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="sticky bottom-0 border-t border-slate-800 bg-slate-900/95 px-6 py-4">
              <button
                type="button"
                onClick={closeHistoryDialog}
                className="w-full rounded-2xl border border-slate-700 bg-slate-950 py-2.5 text-sm font-bold text-slate-100 transition hover:bg-slate-800 sm:w-auto sm:px-6"
              >
                Zavřít historii
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
