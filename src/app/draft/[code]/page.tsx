"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import { getDraftStatusAfterPick } from "@/lib/autoPick";
import {
  extendSnakeOrderForSkippedPick,
  normalizeDraftItem,
} from "@/lib/snakeDraft";
import { ensureAllTeamsInOrder } from "@/lib/rankings";
import AuthGuard from "@/app/auth-guard";
import { useAuth } from "@/components/AuthProvider";
import { DraftChat } from "@/components/DraftChat";
import { animateParticipantDraw, drawParticipantOrder, ParticipantDrawError } from "@/lib/participantDraw";
import { startDraft, StartDraftError } from "@/lib/startDraft";
import { commitParticipantUpdate, ParticipantUpdateConflict } from "@/lib/participantUpdate";

type DraftParticipant = {
  id: string;
  name: string;
  displayName?: string;
  uid?: string;
  userId?: string;
  email?: string;
  joinedAt?: unknown;
  pickCount?: number;
  status?: "waiting" | "ready";
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
  automatic?: boolean;
  autoPickReason?: "player-priorities" | "organizer-ranking";
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
  createdAt?: unknown;
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
  turnStartedAt?: unknown;
  boxes?: DraftBox[];
  teamRanking?: string[];
  teamRankingLocked?: boolean;
  participantOrderDrawn?: boolean;
};

type TurnDurationOption = "none" | "10" | "15" | "20" | "30" | "45" | "60" | "custom";

function participantUpdateMessage(error: unknown, fallback: string) {
  return error instanceof ParticipantUpdateConflict ? error.message : fallback;
}

const TURN_DURATION_OPTIONS: Array<{ value: TurnDurationOption; label: string }> = [
  { value: "none", label: "Bez limitu" },
  { value: "10", label: "10 sekund" },
  { value: "15", label: "15 sekund" },
  { value: "20", label: "20 sekund" },
  { value: "30", label: "30 sekund" },
  { value: "45", label: "45 sekund" },
  { value: "60", label: "60 sekund" },
  { value: "custom", label: "Vlastní" },
];

function formatTurnDurationLabel(turnDurationSeconds: number | null) {
  if (turnDurationSeconds === null) {
    return "bez limitu";
  }

  return `${turnDurationSeconds} s`;
}

function formatDraftDate(value: unknown) {
  let date: Date;
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    date = value.toDate();
  } else if (typeof value === "string" || typeof value === "number") {
    date = new Date(value);
  } else {
    date = new Date();
  }

  return new Intl.DateTimeFormat("cs-CZ", { dateStyle: "long" }).format(
    Number.isNaN(date.getTime()) ? new Date() : date,
  );
}

function getTimestampDate(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate();
  }
  if (value instanceof Date) return value;
  return null;
}

function getTurnDurationOption(value: number | null): TurnDurationOption {
  if (value === null) {
    return "none";
  }

  if (value === 10 || value === 15 || value === 20 || value === 30 || value === 45 || value === 60) {
    return String(value) as TurnDurationOption;
  }

  return "custom";
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
const TURN_CONFLICT_ERROR = "TURN_CONFLICT";

function DraftDetailPageContent() {
  const params = useParams();
  const code = Array.isArray(params.code) ? params.code[0] : params.code;
  const { user, profile } = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(code));
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [participantNames, setParticipantNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSavingNames, setIsSavingNames] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isSubmittingTurnAction, setIsSubmittingTurnAction] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [draftCodeCopyFeedback, setDraftCodeCopyFeedback] = useState<string | null>(null);
  const [viewerLinkCopyFeedback, setViewerLinkCopyFeedback] = useState<string | null>(null);
  const [playerLinkCopyFeedback, setPlayerLinkCopyFeedback] = useState<string | null>(null);
  const [startDraftMessage, setStartDraftMessage] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [matchingUsers, setMatchingUsers] = useState<Array<{ uid: string; displayName: string; email: string }>>([]);
  const [selectedParticipantIndex, setSelectedParticipantIndex] = useState<number | null>(null);
  const [isSearchingUsers, setIsSearchingUsers] = useState(false);
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [joinDraftCode, setJoinDraftCode] = useState("");
  const [joinMessage, setJoinMessage] = useState<string | null>(null);
  const [isJoiningDraft, setIsJoiningDraft] = useState(false);
  const [replaceSelection, setReplaceSelection] = useState<{
    participantIndex: number;
    participantName: string;
    currentItemId: string;
    currentItemName: string;
    currentPickIndex: number;
  } | null>(null);
  const [replacementItemId, setReplacementItemId] = useState<string | null>(null);
  const [isReplacingItem, setIsReplacingItem] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [turnDurationOption, setTurnDurationOption] = useState<TurnDurationOption>("15");
  const [customTurnDurationSeconds, setCustomTurnDurationSeconds] = useState("15");
  const [rankingOrder, setRankingOrder] = useState<string[]>([]);
  const [isSavingRanking, setIsSavingRanking] = useState(false);
  const [rankingFeedback, setRankingFeedback] = useState<string | null>(null);
  const [isRankingExpanded, setIsRankingExpanded] = useState(false);
  const [draggedRankIndex, setDraggedRankIndex] = useState<number | null>(null);
  const [dragOverRankIndex, setDragOverRankIndex] = useState<number | null>(null);
  const [drawAnimation, setDrawAnimation] = useState<{
    participants: DraftParticipant[];
    startedAt: number | null;
    offset: number;
  } | null>(null);
  const drawingRef = useRef(false);

  const closeReplaceDialog = useCallback(() => {
    setReplaceSelection(null);
    setReplacementItemId(null);
    setReplaceError(null);
  }, []);

  function normalizeParticipant(participant: DraftParticipant, index: number): DraftParticipant {
    const displayName = participant.displayName ?? participant.name ?? `Účastník ${index + 1}`;
    const resolvedName = displayName.trim() || `Účastník ${index + 1}`;

    return {
      ...participant,
      id: participant.id ?? `participant-${index + 1}`,
      uid: participant.uid ?? participant.userId ?? "",
      userId: participant.userId ?? participant.uid ?? "",
      displayName: resolvedName,
      name: resolvedName,
      email: participant.email ?? "",
      joinedAt: participant.joinedAt ?? null,
      pickCount: Number(participant.pickCount ?? participant.picks?.length ?? 0),
      status: participant.status === "ready" ? "ready" : "waiting",
      picks: participant.picks ?? [],
    };
  }

  function sanitizeParticipantForWrite(participant: DraftParticipant, index: number): DraftParticipant {
    const rawParticipant = participant as Record<string, unknown>;
    const resolvedName = typeof participant.name === "string" ? participant.name : "";
    const resolvedDisplayName = typeof participant.displayName === "string" ? participant.displayName : resolvedName;
    const resolvedEmail = typeof participant.email === "string" ? participant.email : "";
    const resolvedUserId = typeof participant.userId === "string" ? participant.userId : "";
    const resolvedUid = typeof participant.uid === "string" ? participant.uid : resolvedUserId;
    const resolvedStatus = participant.status === "ready" ? "ready" : "waiting";
    const resolvedPicks = Array.isArray(participant.picks) ? participant.picks : [];

    const nextParticipant = {
      ...rawParticipant,
      id: participant.id ?? `participant-${index + 1}`,
      name: resolvedName,
      displayName: resolvedDisplayName,
      userId: resolvedUserId,
      uid: resolvedUid,
      email: resolvedEmail,
      status: resolvedStatus,
      picks: resolvedPicks,
      joinedAt: participant.joinedAt ?? null,
      pickCount: Number(participant.pickCount ?? resolvedPicks.length ?? 0),
      participantId: participant.participantId ?? participant.id ?? `participant-${index + 1}`,
      participantPin: participant.participantPin ?? null,
    };

    const withoutUndefined = Object.fromEntries(
      Object.entries(nextParticipant).filter(([, value]) => value !== undefined),
    );

    return withoutUndefined as DraftParticipant;
  }

  function getResolvedParticipantUserId(participant: DraftParticipant) {
    return (participant.userId ?? participant.uid ?? "").trim();
  }

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
              const resolvedTurnDurationSeconds = data.turnDurationSeconds === null
                ? null
                : Number(data.turnDurationSeconds ?? 15);
              const draftData = {
                id: snapshot.id,
                title: data.title ?? "Bez názvu",
                sport: data.sport ?? "NHL",
                code: data.code ?? code,
                status: data.status ?? "waiting",
                createdAt: data.createdAt,
                productName: data.productName ?? "",
                productSeason: data.productSeason ?? "",
                productPrice: Number(data.productPrice ?? 0),
                productImageUrl: data.productImageUrl ?? "",
                boxCount: Number(data.boxCount ?? 0),
                boxPrice: Number(data.boxPrice ?? 0),
                margin: Number(data.margin ?? 0),
                targetBreakPrice: Number(data.targetBreakPrice ?? 0),
                participantCount: Number(data.participantCount ?? 0),
                participants: ((data.participants ?? []) as DraftParticipant[]).map((participant, index) => normalizeParticipant(participant, index)),
                currentPickIndex: Number(data.currentPickIndex ?? 0),
                pickOrder: (data.pickOrder ?? []) as number[],
                draftItems: ((data.draftItems ?? []) as Array<DraftItem | string>).map((item) => normalizeDraftItem(item)),
                availableItemIds: (data.availableItemIds ?? []) as string[],
                history: (data.history ?? []) as DraftHistoryItem[],
                turnDurationSeconds: resolvedTurnDurationSeconds,
                turnStartedAt: data.turnStartedAt,
                boxes: (data.boxes ?? []) as DraftBox[],
                teamRanking: Array.isArray(data.teamRanking) ? (data.teamRanking as string[]) : undefined,
                teamRankingLocked: Boolean(data.teamRankingLocked || (data.status && data.status !== "waiting")),
                participantOrderDrawn: data.participantOrderDrawn === true,
              };

              setDraft(draftData);
              if (Array.isArray(data.teamRanking) && data.teamRanking.length > 0) {
                setRankingOrder(ensureAllTeamsInOrder(data.teamRanking as string[]));
              } else {
                setRankingOrder(draftData.draftItems.map((item) => item.id));
              }
              setParticipantNames(draftData.participants.map((participant) => participant.name));
              const nextOption = getTurnDurationOption(resolvedTurnDurationSeconds);
              setTurnDurationOption(nextOption);
              if (resolvedTurnDurationSeconds !== null && nextOption === "custom") {
                setCustomTurnDurationSeconds(String(resolvedTurnDurationSeconds));
              } else {
                setCustomTurnDurationSeconds("15");
              }
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
    if (!draft || draft.status !== "waiting") {
      return;
    }

    if (!userSearch.trim()) {
      const clearTimeoutId = window.setTimeout(() => {
        setMatchingUsers([]);
      }, 0);
      return () => window.clearTimeout(clearTimeoutId);
    }

    const searchTimeout = window.setTimeout(async () => {
      setIsSearchingUsers(true);
      try {
        const { db, firestoreApi } = await getFirebaseClient();
        const usersRef = firestoreApi.collection(db, "users");
        const searchQuery = firestoreApi.query(
          usersRef,
          firestoreApi.where("displayName", ">=", userSearch.trim()),
          firestoreApi.where("displayName", "<=", `${userSearch.trim()}\uf8ff`),
        );
        const snapshot = await firestoreApi.getDocs(searchQuery);
        const foundUsers = snapshot.docs
          .map((document) => document.data())
          .filter((candidate) => candidate.displayName || candidate.email)
          .map((candidate) => ({
            uid: candidate.uid as string,
            displayName: (candidate.displayName as string) || "",
            email: (candidate.email as string) || "",
          }));

        setMatchingUsers(foundUsers);
      } catch (searchError) {
        console.error(searchError);
        setMatchingUsers([]);
      } finally {
        setIsSearchingUsers(false);
      }
    }, 250);

    return () => window.clearTimeout(searchTimeout);
  }, [draft, userSearch]);

  useEffect(() => {
    if (!replaceSelection) {
      return;
    }

    const scrollY = window.scrollY;
    const originalStyle = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };

    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.position = originalStyle.position;
      document.body.style.top = originalStyle.top;
      document.body.style.width = originalStyle.width;
      document.body.style.overflow = originalStyle.overflow;
      window.scrollTo({ top: scrollY });
    };
  }, [replaceSelection]);

  useEffect(() => {
    if (!replaceSelection) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeReplaceDialog();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeReplaceDialog, replaceSelection]);

  const currentParticipantIndex = draft?.pickOrder[draft.currentPickIndex] ?? null;
  const currentParticipant = draft && currentParticipantIndex !== null ? draft.participants[currentParticipantIndex] : null;
  const currentRound = draft ? Math.floor(draft.currentPickIndex / Math.max(1, draft.participantCount)) + 1 : 1;
  const currentPickNumber = draft ? draft.currentPickIndex + 1 : 1;
  const completedPickCount = draft?.history.filter((entry) => entry.type === "pick").length ?? 0;
  const turnStartedAtDate = getTimestampDate(draft?.turnStartedAt);
  const remainingTurnSeconds = draft?.status === "drafting" && draft.turnDurationSeconds !== null && turnStartedAtDate
    ? Math.max(0, Math.ceil((turnStartedAtDate.getTime() + draft.turnDurationSeconds * 1000 - clockNow) / 1000))
    : null;
  const availableItems = useMemo(() => {
    if (!draft) {
      return [] as DraftItem[];
    }

    return draft.draftItems.filter((item) => draft.availableItemIds.includes(item.id));
  }, [draft]);
  const isSettingsLocked = draft?.status !== "waiting";
  const canReplaceSelection = Boolean(draft && (draft.status === "drafting" || draft.status === "paused" || draft.status === "completed"));
  const startDraftValidationMessage = useMemo(() => {
    if (!draft) {
      return null;
    }

    if (draft.status !== "waiting") {
      return "Draft je již spuštěný.";
    }

    const hasAllNames = draft.participants.every((participant, index) => {
      const currentName = (participantNames[index] ?? participant.name ?? "").trim();
      return currentName.length > 0;
    });

    if (!hasAllNames) {
      return "Vyplňte jména všech účastníků.";
    }

    if (draft.participants.some((participant) => !getResolvedParticipantUserId(participant))) {
      return "Přiřaďte ke každé pozici konkrétního registrovaného uživatele.";
    }

    const assignedUserIds = draft.participants
      .map((participant) => getResolvedParticipantUserId(participant))
      .filter((userId) => userId.length > 0);
    if (new Set(assignedUserIds).size !== assignedUserIds.length) {
      return "Každý uživatel může být v draftu přiřazen pouze jednou.";
    }

    if (draft.participantCount !== draft.participants.length) {
      return "Počet účastníků neodpovídá nastavenému počtu.";
    }

    if (draft.pickOrder.length === 0) {
      return "Nejprve nastavte pořadí účastníků.";
    }

    if (availableItems.length === 0) {
      return "Draft neobsahuje žádné dostupné týmy.";
    }

    return null;
  }, [availableItems.length, draft, participantNames]);
  const canStartDraft = Boolean(draft && draft.status === "waiting" && startDraftValidationMessage === null);
  const canManageTurnAction = Boolean(draft && draft.status === "drafting" && !isSubmittingTurnAction && !isUpdating);

  useEffect(() => {
    if (drawAnimation?.startedAt == null) return;
    return animateParticipantDraw(
      (offset) => setDrawAnimation((current) => current ? { ...current, offset } : null),
      () => {
        drawingRef.current = false;
        setDrawAnimation(null);
      },
    );
  }, [drawAnimation?.startedAt]);

  useEffect(() => {
    if (draft?.status !== "drafting" || draft.turnDurationSeconds === null) {
      return;
    }

    const intervalId = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [draft?.status, draft?.turnDurationSeconds, draft?.turnStartedAt]);

  const historyEntries = useMemo(() => {
    if (!draft) {
      return [] as DraftHistoryItem[];
    }

    return [...draft.history].reverse();
  }, [draft]);

  const lastPickEntry = useMemo(() => {
    if (!draft) {
      return null as DraftHistoryItem | null;
    }

    for (let index = draft.history.length - 1; index >= 0; index -= 1) {
      const entry = draft.history[index];
      if (entry?.type === "pick") {
        return entry;
      }
    }

    return null;
  }, [draft]);

  const lastPickParticipant = useMemo(() => {
    if (!draft || !lastPickEntry) {
      return null as DraftParticipant | null;
    }

    return draft.participants[lastPickEntry.participantIndex] ?? null;
  }, [draft, lastPickEntry]);

  const lastPickItem = useMemo(() => {
    if (!draft || !lastPickEntry?.itemId) {
      return null as DraftItem | null;
    }

    return draft.draftItems.find((item) => item.id === lastPickEntry.itemId) ?? null;
  }, [draft, lastPickEntry]);

  const isRankingLocked = Boolean(!draft || draft.teamRankingLocked || draft.status !== "waiting");

  const rankingTeamLookup = useMemo(() => {
    const map = new Map<string, DraftItem>();
    if (!draft) return map;
    for (const item of draft.draftItems) {
      map.set(item.id, item);
    }
    return map;
  }, [draft]);

  function handleMoveRankingTeam(fromIndex: number, direction: "up" | "down") {
    if (isRankingLocked) return;
    const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= rankingOrder.length) return;

    const nextOrder = [...rankingOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setRankingOrder(nextOrder);
    setRankingFeedback("Změny v pořadí nejsou uloženy. Klikněte na 'Uložit pořadí'.");
  }

  function handleDropRankingTeam(fromIndex: number, toIndex: number) {
    if (isRankingLocked || fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= rankingOrder.length || toIndex >= rankingOrder.length) return;

    const nextOrder = [...rankingOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setRankingOrder(nextOrder);
    setRankingFeedback("Změny v pořadí nejsou uloženy. Klikněte na 'Uložit pořadí'.");
  }

  async function handleSaveTeamRanking() {
    if (!draft || draft.status !== "waiting" || isRankingLocked) return;
    setIsSavingRanking(true);
    setRankingFeedback(null);
    try {
      const { db, firestoreApi } = await getFirebaseClient();
      const validOrder = ensureAllTeamsInOrder(rankingOrder);
      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        teamRanking: validOrder,
        updatedAt: firestoreApi.serverTimestamp(),
      });
      setRankingFeedback("Žebříček byl úspěšně uložen do tohoto draftu.");
    } catch (err) {
      console.error(err);
      setRankingFeedback("Nepodařilo se uložit žebříček.");
    } finally {
      setIsSavingRanking(false);
    }
  }

  async function updateDraft(updates: Pick<Draft, "status">) {
    if (!draft) {
      return;
    }

    setIsUpdating(true);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        ...updates,
        updatedAt: firestoreApi.serverTimestamp(),
      });
    } catch (updateError) {
      console.error(updateError);
      setError("Nepodařilo se uložit změny draftu.");
    } finally {
      setIsUpdating(false);
    }
  }

  async function handleTurnDurationOptionChange(nextOption: TurnDurationOption) {
    if (!draft) {
      return;
    }

    if (draft.status !== "waiting") {
      return;
    }

    setTurnDurationOption(nextOption);

    if (nextOption === "custom") {
      if (draft.turnDurationSeconds !== null && getTurnDurationOption(draft.turnDurationSeconds) === "custom") {
        setCustomTurnDurationSeconds(String(draft.turnDurationSeconds));
      }
      return;
    }

    const nextTurnDurationSeconds = nextOption === "none" ? null : Number(nextOption);
    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        turnDurationSeconds: nextTurnDurationSeconds,
        updatedAt: firestoreApi.serverTimestamp(),
      });
    } catch (durationError) {
      console.error(durationError);
      setError("Nepodařilo se uložit čas na výběr.");
    }
  }

  async function handleSaveCustomTurnDuration() {
    if (!draft || draft.status !== "waiting") {
      return;
    }

    const parsedCustomValue = Number(customTurnDurationSeconds);
    if (!Number.isInteger(parsedCustomValue) || parsedCustomValue < 5 || parsedCustomValue > 300) {
      setError("Vlastní čas na výběr musí být celé číslo v rozmezí 5 až 300 sekund.");
      return;
    }

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        turnDurationSeconds: parsedCustomValue,
        updatedAt: firestoreApi.serverTimestamp(),
      });
    } catch (durationError) {
      console.error(durationError);
      setError("Nepodařilo se uložit čas na výběr.");
    }
  }

  function buildDraftExportText(currentDraft: Draft) {
    const lines: string[] = [];
    lines.push(currentDraft.title || "Snake draft");

    const productLine = [currentDraft.productName, currentDraft.productSeason].filter(Boolean).join(" ");
    if (productLine) {
      lines.push(productLine);
    }

    lines.push("");

    currentDraft.participants.forEach((participant) => {
      lines.push(participant.name || "Účastník");

      const pickedTeams = participant.picks
        .map((pickedItemId) => currentDraft.draftItems.find((item) => item.id === pickedItemId))
        .filter((item): item is DraftItem => Boolean(item))
        .map((item) => item.name);

      if (pickedTeams.length > 0) {
        pickedTeams.forEach((teamName) => {
          lines.push(`- ${teamName}`);
        });
      } else {
        lines.push("- zatím bez výběru");
      }

      lines.push("");
    });

    return lines.join("\n").trim();
  }

  async function handleCopyResults() {
    if (!draft) {
      return;
    }

    const exportText = buildDraftExportText(draft);

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(exportText);
        setCopyFeedback("Výsledky byly zkopírovány.");
      } else {
        setCopyFeedback("Výsledky se nepodařilo zkopírovat.");
      }
    } catch {
      setCopyFeedback("Výsledky se nepodařilo zkopírovat.");
    }
  }

  async function handleCopyDraftCode() {
    if (!draft) {
      return;
    }

    const draftCode = draft.code;

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(draftCode);
        setDraftCodeCopyFeedback("Kód draftu byl zkopírován.");
      } else {
        setDraftCodeCopyFeedback("Kód draftu se nepodařilo zkopírovat.");
      }
    } catch {
      setDraftCodeCopyFeedback("Kód draftu se nepodařilo zkopírovat.");
    }
  }

  async function handleCopyViewerLink() {
    if (!draft) {
      return;
    }

    const viewerLink = `${window.location.origin}/view/${draft.code}`;

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(viewerLink);
        setViewerLinkCopyFeedback("Viewer odkaz byl zkopírován.");
      } else {
        setViewerLinkCopyFeedback("Viewer odkaz se nepodařilo zkopírovat.");
      }
    } catch {
      setViewerLinkCopyFeedback("Viewer odkaz se nepodařilo zkopírovat.");
    }
  }

  async function handleCopyPlayerLink() {
    if (!draft) {
      return;
    }

    const playerLink = `${window.location.origin}/play/${draft.code}`;

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(playerLink);
        setPlayerLinkCopyFeedback("Hráčský odkaz byl zkopírován.");
      } else {
        setPlayerLinkCopyFeedback("Hráčský odkaz se nepodařilo zkopírovat.");
      }
    } catch {
      setPlayerLinkCopyFeedback("Hráčský odkaz se nepodařilo zkopírovat.");
    }
  }

  async function handleGenerateParticipantPin(participantIndex: number) {
    if (!draft) {
      return;
    }

    const generatedPin = String(Math.floor(100000 + Math.random() * 900000));
    const nextParticipants = draft.participants.map((participant, index) =>
      index === participantIndex ? { ...participant, participantPin: generatedPin } : participant,
    );

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await commitParticipantUpdate(db, firestoreApi, draft.id, draft, {
        participants: nextParticipants,
      }, normalizeParticipant);
    } catch (generateError) {
      console.error(generateError);
      setError(participantUpdateMessage(generateError, "Nepodařilo se vygenerovat PIN."));
    }
  }

  async function handleAssignUserToParticipant(participantIndex: number, userId: string, displayName: string, email: string) {
    if (!draft) {
      return;
    }

    if (draft.status !== "waiting") {
      setError("Po spuštění draftu je přiřazení uzamčené.");
      return;
    }

    const selectedUserId = (userId ?? "").trim();
    const alreadyAssigned = draft.participants.some((participant, index) => index !== participantIndex && getResolvedParticipantUserId(participant) === selectedUserId);
    if (alreadyAssigned) {
      setError("Tento uživatel je již v draftu přiřazen.");
      return;
    }

    const currentParticipant = draft.participants[participantIndex];
    const resolvedDisplayName = displayName?.trim() || "";
    const resolvedEmail = email?.trim() || "";
    const resolvedPicks = Array.isArray(currentParticipant?.picks) ? currentParticipant.picks : [];

    const nextParticipants = draft.participants.map((participant, index) => {
      if (index !== participantIndex) {
        return sanitizeParticipantForWrite(participant, index);
      }

      return sanitizeParticipantForWrite(
        {
          ...participant,
          id: participant.id ?? `participant-${index + 1}`,
          participantId: participant.participantId ?? participant.id ?? `participant-${index + 1}`,
          name: resolvedDisplayName,
          displayName: resolvedDisplayName,
          userId: selectedUserId,
          uid: selectedUserId,
          email: resolvedEmail,
          picks: resolvedPicks,
          status: "ready",
          joinedAt: new Date(),
          pickCount: Number(participant.pickCount ?? resolvedPicks.length),
        },
        index,
      );
    });

    const draftDocumentId = draft.id || code || "";
    if (!draftDocumentId) {
      setError("Přiřazení selhalo: chybí identifikátor draftu.");
      return;
    }

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await commitParticipantUpdate(db, firestoreApi, draftDocumentId, draft, {
        participants: nextParticipants,
      }, normalizeParticipant, { waiting: true });
      setParticipantNames(nextParticipants.map((participant) => participant.name || participant.displayName || ""));
      setSelectedParticipantIndex(null);
      setUserSearch("");
      setMatchingUsers([]);
    } catch (assignError) {
      const errorCode = typeof assignError === "object" && assignError && "code" in assignError ? String((assignError as { code?: unknown }).code ?? "unknown") : "unknown";
      const errorMessage = typeof assignError === "object" && assignError && "message" in assignError ? String((assignError as { message?: unknown }).message ?? "") : "";
      console.error("ASSIGN USER ERROR", assignError);
      setError(participantUpdateMessage(assignError, `Přiřazení selhalo: ${errorCode}${errorMessage ? ` – ${errorMessage}` : ""}`));
    }
  }

  async function handleRemoveUserFromParticipant(participantIndex: number) {
    if (!draft) {
      return;
    }

    if (draft.status !== "waiting") {
      setError("Po spuštění draftu je přiřazení uzamčené.");
      return;
    }

    const nextParticipants = draft.participants.map((participant, index) => {
      if (index !== participantIndex) {
        return sanitizeParticipantForWrite(participant, index);
      }

      const reservedName = (participant.displayName ?? participant.name ?? "").trim();
      const preservedPicks = Array.isArray(participant.picks) ? participant.picks : [];

      return sanitizeParticipantForWrite(
        {
          ...participant,
          id: participant.id ?? `participant-${index + 1}`,
          participantId: participant.participantId ?? participant.id ?? `participant-${index + 1}`,
          name: reservedName,
          displayName: reservedName,
          userId: "",
          uid: "",
          email: "",
          status: "waiting",
          joinedAt: null,
          picks: preservedPicks,
          pickCount: Number(participant.pickCount ?? preservedPicks.length),
        },
        index,
      );
    });

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await commitParticipantUpdate(db, firestoreApi, draft.id, draft, {
        participants: nextParticipants,
      }, normalizeParticipant, { waiting: true });
      setParticipantNames(nextParticipants.map((participant) => participant.name || participant.displayName || ""));
      setSelectedParticipantIndex(null);
      setUserSearch("");
      setMatchingUsers([]);
    } catch (removeError) {
      const errorCode = typeof removeError === "object" && removeError && "code" in removeError ? String((removeError as { code?: unknown }).code ?? "unknown") : "unknown";
      const errorMessage = typeof removeError === "object" && removeError && "message" in removeError ? String((removeError as { message?: unknown }).message ?? "") : "";
      console.error("ASSIGN USER ERROR", removeError);
      setError(participantUpdateMessage(removeError, `Odebrání uživatele selhalo: ${errorCode}${errorMessage ? ` – ${errorMessage}` : ""}`));
    }
  }

  async function handleJoinDraftFromCode() {
    if (!user) {
      setJoinMessage("Nejprve se přihlaste.");
      return;
    }

    const normalizedCode = joinDraftCode.trim().toUpperCase();
    if (!normalizedCode) {
      setJoinMessage("Zadejte kód draftu.");
      return;
    }

    setIsJoiningDraft(true);
    setJoinMessage(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      const draftRef = await firestoreApi.getDocs(firestoreApi.query(firestoreApi.collection(db, "drafts"), firestoreApi.where("code", "==", normalizedCode)));
      const draftDocument = draftRef.docs[0];

      if (!draftDocument) {
        setJoinMessage("Draft s tímto kódem nebyl nalezen.");
        return;
      }

      const draftData = draftDocument.data() as Partial<Draft> & { participants?: DraftParticipant[] };
      const participants = (draftData.participants ?? []).map((participant, index) => normalizeParticipant(participant, index));
      const nextDisplayName = user.displayName?.trim() || user.email?.split("@", 1)[0] || "Uživatel";
      const matchingSlotIndex = participants.findIndex((participant) => {
        const participantName = (participant.displayName ?? participant.name ?? "").trim().toLowerCase();
        const candidateName = nextDisplayName.trim().toLowerCase();
        return participant.status !== "ready" && participantName === candidateName && !(participant.uid || participant.userId);
      });

      if (matchingSlotIndex === -1) {
        setJoinMessage("Tvé jméno není mezi účastníky.");
        return;
      }

      const nextParticipants = participants.map((participant, index) => {
        if (index !== matchingSlotIndex) {
          return participant;
        }

        return {
          ...participant,
          uid: user.uid,
          userId: user.uid,
          displayName: participant.displayName ?? participant.name ?? nextDisplayName,
          name: participant.name || participant.displayName || nextDisplayName,
          email: user.email ?? participant.email ?? "",
          joinedAt: new Date(),
          pickCount: participant.pickCount ?? participant.picks?.length ?? 0,
          status: "ready" as const,
        };
      });

      await commitParticipantUpdate(db, firestoreApi, draftDocument.id, {
        participants,
        status: draftData.status ?? "waiting",
        participantOrderDrawn: draftData.participantOrderDrawn,
      }, {
        participants: nextParticipants,
      }, normalizeParticipant, { waiting: true });

      setJoinMessage("Připojili jste se k draftu.");
      setJoinDraftCode("");
      setJoinModalOpen(false);
    } catch (joinError) {
      console.error(joinError);
      setJoinMessage(participantUpdateMessage(joinError, "Nepodařilo se připojit k draftu."));
    } finally {
      setIsJoiningDraft(false);
    }
  }

  async function handleSaveParticipantNames() {
    if (!draft) {
      return;
    }

    setIsSavingNames(true);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      const nextParticipants = draft.participants.map((participant, index) => ({
        ...participant,
        name: participantNames[index]?.trim() ?? "",
      }));

      await commitParticipantUpdate(db, firestoreApi, draft.id, draft, {
        participants: nextParticipants,
      }, normalizeParticipant, { waiting: true });
    } catch (saveError) {
      console.error(saveError);
      setError(participantUpdateMessage(saveError, "Nepodařilo se uložit jména účastníků."));
    } finally {
      setIsSavingNames(false);
    }
  }

  async function handleStartDraft() {
    if (!draft) {
      return;
    }

    if (draft.status !== "waiting") {
      setStartDraftMessage("Draft je již spuštěný.");
      return;
    }

    const nextParticipants = draft.participants.map((participant, index) => ({
      ...participant,
      name: (participantNames[index] ?? participant.name ?? "").trim(),
    }));

    const hasAllNames = nextParticipants.every((participant) => participant.name.length > 0);
    if (!hasAllNames) {
      setStartDraftMessage("Vyplňte jména všech účastníků.");
      return;
    }

    if (nextParticipants.some((participant) => !getResolvedParticipantUserId(participant))) {
      setStartDraftMessage("Přiřaďte ke každé pozici konkrétního registrovaného uživatele.");
      return;
    }

    const nextUserIds = nextParticipants
      .map((participant) => getResolvedParticipantUserId(participant))
      .filter((participantUserId) => participantUserId.length > 0);
    if (new Set(nextUserIds).size !== nextUserIds.length) {
      setStartDraftMessage("Každý uživatel může být v draftu přiřazen pouze jednou.");
      return;
    }

    if (draft.participantCount !== draft.participants.length) {
      setStartDraftMessage("Počet účastníků neodpovídá nastavenému počtu.");
      return;
    }

    if (draft.pickOrder.length === 0) {
      setStartDraftMessage("Nejprve nastavte pořadí účastníků.");
      return;
    }

    if (availableItems.length === 0) {
      setStartDraftMessage("Draft neobsahuje žádné dostupné týmy.");
      return;
    }

    setStartDraftMessage(null);
    setIsUpdating(true);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      const finalTeamRanking =
        rankingOrder.length > 0
          ? ensureAllTeamsInOrder(rankingOrder)
          : draft.teamRanking && draft.teamRanking.length > 0
            ? ensureAllTeamsInOrder(draft.teamRanking)
            : draft.draftItems.map((item) => item.id);

      await startDraft(
        db, firestoreApi, draft.id, draft.participants, participantNames,
        finalTeamRanking, draft.teamRanking, normalizeParticipant,
      );
    } catch (startError) {
      console.error(startError);
      setError(startError instanceof StartDraftError ? startError.message : "Nepodařilo se spustit draft.");
    } finally {
      setIsUpdating(false);
    }
  }

  async function handlePauseDraft() {
    if (!draft) {
      return;
    }

    await updateDraft({ status: "paused" });
  }

  async function handleContinueDraft() {
    if (!draft) {
      return;
    }

    await updateDraft({ status: "drafting" });
  }

  async function handleSkipCurrentParticipant() {
    if (!draft || isSubmittingTurnAction) {
      return;
    }

    setIsSubmittingTurnAction(true);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.runTransaction(db, async (transaction) => {
        const draftRef = firestoreApi.doc(db, "drafts", draft.id);
        const latestSnapshot = await transaction.get(draftRef);

        if (!latestSnapshot.exists()) {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        const latestData = latestSnapshot.data();
        const latestStatus = latestData.status ?? "waiting";
        const latestParticipants = (latestData.participants ?? []) as DraftParticipant[];
        const latestPickOrder = (latestData.pickOrder ?? []) as number[];
        const latestCurrentPickIndex = Number(latestData.currentPickIndex ?? 0);
        const latestAvailableItemIds = (latestData.availableItemIds ?? []) as string[];
        const latestHistory = (latestData.history ?? []) as DraftHistoryItem[];
        const latestCurrentParticipantIndex = latestPickOrder[latestCurrentPickIndex];
        const expectedCurrentPickIndex = draft.currentPickIndex;
        const expectedParticipantIndex = draft.pickOrder[expectedCurrentPickIndex];

        if (latestStatus !== "drafting") {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        if (latestCurrentPickIndex !== expectedCurrentPickIndex) {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        if (latestCurrentParticipantIndex !== expectedParticipantIndex) {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        const nextPickIndex = latestCurrentPickIndex + 1;
        const nextPickOrder = extendSnakeOrderForSkippedPick(
          latestPickOrder,
          latestParticipants.length,
          latestCurrentPickIndex,
          latestAvailableItemIds.length,
        );
        const nextStatus = getDraftStatusAfterPick(latestAvailableItemIds);
        const nextHistory = [
          ...latestHistory,
          {
            type: "skip" as const,
            participantIndex: latestCurrentParticipantIndex,
          },
        ];

        const nextDraftUpdate = {
          status: nextStatus,
          currentPickIndex: nextPickIndex,
          pickOrder: nextPickOrder,
          history: nextHistory,
          updatedAt: firestoreApi.serverTimestamp(),
        } as Record<string, unknown>;

        if (nextStatus === "drafting") {
          nextDraftUpdate.turnStartedAt = firestoreApi.serverTimestamp();
        } else {
          nextDraftUpdate.turnStartedAt = firestoreApi.deleteField();
        }

        transaction.update(draftRef, nextDraftUpdate);
      });
    } catch (skipError) {
      console.error(skipError);
      if (skipError instanceof Error && skipError.message === TURN_CONFLICT_ERROR) {
        setError(INVALID_PICK_MESSAGE);
      } else {
        setError("Nepodařilo se přeskočit účastníka.");
      }
    } finally {
      setIsSubmittingTurnAction(false);
    }
  }

  async function handleSelectItem(item: DraftItem) {
    if (!draft || draft.status !== "drafting" || isSubmittingTurnAction) {
      return;
    }

    setIsSubmittingTurnAction(true);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.runTransaction(db, async (transaction) => {
        const draftRef = firestoreApi.doc(db, "drafts", draft.id);
        const latestSnapshot = await transaction.get(draftRef);

        if (!latestSnapshot.exists()) {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        const latestData = latestSnapshot.data();
        const latestStatus = latestData.status ?? "waiting";
        const latestParticipants = (latestData.participants ?? []) as DraftParticipant[];
        const latestPickOrder = (latestData.pickOrder ?? []) as number[];
        const latestCurrentPickIndex = Number(latestData.currentPickIndex ?? 0);
        const latestAvailableItemIds = (latestData.availableItemIds ?? []) as string[];
        const latestHistory = (latestData.history ?? []) as DraftHistoryItem[];
        const latestCurrentParticipantIndex = latestPickOrder[latestCurrentPickIndex];
        const expectedCurrentPickIndex = draft.currentPickIndex;
        const expectedParticipantIndex = draft.pickOrder[expectedCurrentPickIndex];

        if (latestStatus !== "drafting") {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        if (latestCurrentPickIndex !== expectedCurrentPickIndex) {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        if (latestCurrentParticipantIndex !== expectedParticipantIndex) {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        if (!latestAvailableItemIds.includes(item.id)) {
          throw new Error(TURN_CONFLICT_ERROR);
        }

        const nextPickIndex = latestCurrentPickIndex + 1;
        const nextAvailableItemIds = latestAvailableItemIds.filter((availableItemId) => availableItemId !== item.id);
        const nextStatus = getDraftStatusAfterPick(nextAvailableItemIds);
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
          updatedAt: firestoreApi.serverTimestamp(),
        } as Record<string, unknown>;

        if (nextStatus === "drafting") {
          nextDraftUpdate.turnStartedAt = firestoreApi.serverTimestamp();
        } else {
          nextDraftUpdate.turnStartedAt = firestoreApi.deleteField();
        }

        transaction.update(draftRef, nextDraftUpdate);
      });
    } catch (pickError) {
      console.error(pickError);
      if (pickError instanceof Error && pickError.message === TURN_CONFLICT_ERROR) {
        setError(INVALID_PICK_MESSAGE);
      } else {
        setError("Nepodařilo se uložit výběr.");
      }
    } finally {
      setIsSubmittingTurnAction(false);
    }
  }

  async function handleSelectItemForCurrentParticipant() {
    if (!draft || availableItems.length === 0) {
      return;
    }

    await handleSelectItem(availableItems[0]);
  }

  async function handleUndoLastAction() {
    if (!draft || draft.history.length === 0) {
      return;
    }

    const lastAction = draft.history[draft.history.length - 1];
    const previousPickIndex = Math.max(0, draft.currentPickIndex - 1);
    const updatedHistory = draft.history.slice(0, -1);

    let nextParticipants = draft.participants;
    let nextAvailableItemIds = draft.availableItemIds;

    if (lastAction.type === "pick" && lastAction.itemId) {
      nextParticipants = draft.participants.map((participant, index) => {
        if (index !== lastAction.participantIndex) {
          return participant;
        }

        return {
          ...participant,
          picks: participant.picks.filter((pickedItemId) => pickedItemId !== lastAction.itemId),
        };
      });
      nextAvailableItemIds = [...draft.availableItemIds, lastAction.itemId];
    }

    setIsUpdating(true);
    setError(null);
    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await commitParticipantUpdate(db, firestoreApi, draft.id, draft, {
        status: "drafting",
        participants: nextParticipants,
        currentPickIndex: previousPickIndex,
        availableItemIds: nextAvailableItemIds,
        history: updatedHistory,
      }, normalizeParticipant, { checkTurn: true });
    } catch (undoError) {
      console.error(undoError);
      setError(participantUpdateMessage(undoError, "Nepodařilo se vrátit poslední tah."));
    } finally {
      setIsUpdating(false);
    }
  }

  function openReplaceDialog(participantIndex: number, participantName: string, currentItemId: string, currentItemName: string, currentPickIndex: number) {
    setReplaceSelection({
      participantIndex,
      participantName,
      currentItemId,
      currentItemName,
      currentPickIndex,
    });
    setReplacementItemId(null);
    setReplaceError(null);
  }

  async function handleConfirmTeamReplacement() {
    if (!draft || !replaceSelection) {
      return;
    }

    if (!replacementItemId || replacementItemId === replaceSelection.currentItemId) {
      setReplaceError("Vyberte nový tým.");
      return;
    }

    setIsReplacingItem(true);
    setReplaceError(null);

    try {
      const nextParticipants = draft.participants.map((participant, index) => {
        if (index !== replaceSelection.participantIndex) {
          return participant;
        }

        const nextPicks = participant.picks.map((pickedItemId, pickIndex) =>
          pickIndex === replaceSelection.currentPickIndex ? replacementItemId : pickedItemId,
        );

        return {
          ...participant,
          picks: nextPicks,
        };
      });

      const replacementItem = draft.draftItems.find((item) => item.id === replacementItemId);
      const nextAvailableItemIds = [...draft.availableItemIds.filter((id) => id !== replacementItemId)];
      if (!nextAvailableItemIds.includes(replaceSelection.currentItemId)) {
        nextAvailableItemIds.push(replaceSelection.currentItemId);
      }

      const { db, firestoreApi } = await getFirebaseClient();
      await commitParticipantUpdate(db, firestoreApi, draft.id, draft, {
        participants: nextParticipants,
        availableItemIds: nextAvailableItemIds,
        history: [
          ...draft.history,
          {
            type: "replace" as const,
            participantIndex: replaceSelection.participantIndex,
            oldItemId: replaceSelection.currentItemId,
            oldItemName: replaceSelection.currentItemName,
            newItemId: replacementItemId,
            newItemName: replacementItem?.name ?? replacementItemId,
          },
        ],
      }, normalizeParticipant, { checkTurn: true });

      setReplaceSelection(null);
      setReplacementItemId(null);
    } catch (replaceError) {
      console.error(replaceError);
      setReplaceError(participantUpdateMessage(replaceError, "Nepodařilo se změnit tým."));
    } finally {
      setIsReplacingItem(false);
    }
  }

  function updateParticipantName(index: number, value: string) {
    setParticipantNames((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });
  }

  function moveParticipant(index: number, direction: -1 | 1) {
    if (!draft) {
      return;
    }

    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draft.participants.length) {
      return;
    }

    const nextParticipants = [...draft.participants];
    const [participant] = nextParticipants.splice(index, 1);
    nextParticipants.splice(nextIndex, 0, participant);

    void (async () => {
      try {
        const { db, firestoreApi } = await getFirebaseClient();
        await commitParticipantUpdate(db, firestoreApi, draft.id, draft, {
          participants: nextParticipants,
        }, normalizeParticipant, { reorder: true });
        setParticipantNames(nextParticipants.map((participant) => participant.name));
      } catch (moveError) {
        console.error(moveError);
        setError(participantUpdateMessage(moveError, "Nepodařilo se změnit pořadí účastníků."));
      }
    })();
  }

  async function shuffleParticipants() {
    if (!draft || draft.status !== "waiting" || draft.participantOrderDrawn || drawingRef.current || isUpdating || isSavingNames) return;
    if (participantNames.some((name, index) => name.trim() !== draft.participants[index]?.name)) {
      setError("Před losováním uložte změněná jména účastníků.");
      return;
    }

    drawingRef.current = true;
    setError(null);
    setSelectedParticipantIndex(null);
    setDrawAnimation({ participants: draft.participants, startedAt: null, offset: 0 });
    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await drawParticipantOrder(db, firestoreApi, draft.id, draft.participants, normalizeParticipant);
      setDrawAnimation((current) => current ? { ...current, startedAt: Date.now() } : null);
    } catch (shuffleError) {
      console.error("Participant draw failed", shuffleError);
      const message = shuffleError instanceof ParticipantDrawError
        ? {
            "already-drawn": "Pořadí již bylo vylosováno.",
            "not-waiting": "Draft již byl spuštěn; pořadí nelze losovat.",
            "participants-changed": "Účastníci se mezitím změnili. Zkontrolujte jejich pořadí a zkuste to znovu.",
            "not-found": "Draft nebyl nalezen.",
          }[shuffleError.reason]
        : "Nepodařilo se náhodně vylosovat pořadí účastníků.";
      setError(message);
      drawingRef.current = false;
      setDrawAnimation(null);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen text-slate-100">
        <Navbar />
        <PageContainer className="py-8 lg:py-10">
          <div className="mx-auto flex max-w-6xl flex-col gap-6">
            <Card className="space-y-4">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
                Snake draft
              </p>
              <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Načítám draft...
              </h1>
            </Card>
          </div>
        </PageContainer>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="print-draft-page min-h-screen text-slate-100">
        <Navbar />
        <PageContainer className="py-8 lg:py-10">
          <div className="mx-auto flex max-w-6xl flex-col gap-6">
            <Card className="space-y-4">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
                Snake draft
              </p>
              <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Draft nebyl nalezen.
              </h1>
            </Card>
          </div>
        </PageContainer>
      </div>
    );
  }

  const isDraftWaiting = draft.status === "waiting";
  const breakComposition = draft.boxes?.length
    ? draft.boxes
    : [{
        productName: draft.productName,
        productSeason: draft.productSeason,
        boxCount: draft.boxCount,
        boxPrice: draft.boxPrice,
        productImageUrl: draft.productImageUrl,
      }];
  const totalBreakBoxCount = breakComposition.reduce((total, box) => total + box.boxCount, 0);
  const breakBoxCountLabel = totalBreakBoxCount === 1
    ? "box"
    : totalBreakBoxCount % 10 >= 2 && totalBreakBoxCount % 10 <= 4 && (totalBreakBoxCount % 100 < 12 || totalBreakBoxCount % 100 > 14)
      ? "boxy"
      : "boxů";

  return (
    <div className="min-h-screen text-slate-100">
      <Navbar />
      <PageContainer className={isDraftWaiting ? "py-4 lg:py-6" : "py-8 lg:py-10"}>
        <div className="mx-auto flex max-w-7xl flex-col gap-3 print:hidden">
          <div className="grid items-start gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="min-w-0 space-y-3 !p-4 sm:!p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#18C964]">
                  {draft.sport} · Administrace draftu
                </p>
                <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  {draft.title}
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-slate-300">
                  Kód <strong className="ml-1 font-mono tracking-widest text-[#8ef0b5]">{draft.code}</strong>
                </span>
                <span className={`rounded-full border px-3 py-1.5 font-semibold ${
                  draft.status === "drafting"
                    ? "border-[#18C964]/30 bg-[#18C964]/10 text-[#8ef0b5]"
                    : draft.status === "paused"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                      : draft.status === "completed"
                        ? "border-slate-600 bg-slate-800 text-slate-200"
                        : "border-slate-700 bg-slate-900 text-slate-300"
                }`}>
                  {draft.status === "drafting" ? "Probíhá" : draft.status === "paused" ? "Pozastaven" : draft.status === "completed" ? "Dokončen" : "Čeká na start"}
                </span>
                <span className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-slate-300">
                  {draft.status === "completed"
                    ? `Výběry ${completedPickCount}/${draft.draftItems.length}`
                    : `Tah ${currentPickNumber}/${draft.pickOrder.length}`}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
              <div className="flex flex-wrap items-center gap-2">
                {draft.status === "waiting" ? (
                  <button
                    type="button"
                    onClick={() => void handleStartDraft()}
                    disabled={isUpdating || Boolean(drawAnimation) || !canStartDraft}
                    className="rounded-xl bg-[#18C964] px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Spustit draft
                  </button>
                ) : null}
                {draft.status === "drafting" ? (
                  <button
                    type="button"
                    onClick={() => void handlePauseDraft()}
                    disabled={isUpdating}
                    className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-60"
                  >
                    Pozastavit
                  </button>
                ) : null}
                {draft.status === "paused" ? (
                  <button
                    type="button"
                    onClick={() => void handleContinueDraft()}
                    disabled={isUpdating}
                    className="rounded-xl bg-[#18C964] px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:opacity-60"
                  >
                    Pokračovat
                  </button>
                ) : null}
                {draft.status === "waiting" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setJoinDraftCode(draft.code);
                      setJoinMessage(null);
                      setJoinModalOpen(true);
                    }}
                    className="rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                  >
                    Připojit se k draftu
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="rounded-xl border border-[#18C964]/30 bg-[#18C964]/10 px-3 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20"
                >
                  Tisk
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyResults()}
                  className="rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  Kopírovat výsledky
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
                  Čas na výběr
                  <select
                    value={turnDurationOption}
                    onChange={(event) => void handleTurnDurationOptionChange(event.target.value as TurnDurationOption)}
                    disabled={isSettingsLocked}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-white disabled:opacity-60"
                  >
                    {TURN_DURATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {turnDurationOption === "custom" ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="5"
                      max="300"
                      value={customTurnDurationSeconds}
                      onChange={(event) => setCustomTurnDurationSeconds(event.target.value)}
                      disabled={isSettingsLocked}
                      aria-label="Vlastní čas na výběr v sekundách"
                      className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-white disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveCustomTurnDuration()}
                      disabled={isSettingsLocked}
                      className="rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-200 disabled:opacity-60"
                    >
                      Uložit
                    </button>
                  </div>
                ) : null}
                <span className="text-xs text-slate-400">Aktuálně: {formatTurnDurationLabel(draft.turnDurationSeconds)}</span>
                <Link
                  href={`/view/${draft.code}`}
                  className="rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  Viewer
                </Link>
                <button type="button" onClick={() => void handleCopyDraftCode()} className="rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Kopírovat kód</button>
                <button type="button" onClick={() => void handleCopyViewerLink()} className="rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Viewer odkaz</button>
                <button type="button" onClick={() => void handleCopyPlayerLink()} className="rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Hráčský odkaz</button>
              </div>
            </div>

            {error || startDraftMessage || joinMessage || copyFeedback || draftCodeCopyFeedback || viewerLinkCopyFeedback || playerLinkCopyFeedback ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {[error, startDraftMessage, joinMessage, copyFeedback, draftCodeCopyFeedback, viewerLinkCopyFeedback, playerLinkCopyFeedback]
                  .filter((message): message is string => Boolean(message))
                  .map((message) => (
                    <p key={message} className={message.includes("nepodařilo") || message.includes("Nepodařilo") ? "text-red-300" : "text-[#8ef0b5]"}>{message}</p>
                  ))}
              </div>
            ) : null}
          </Card>

          <Card className="min-w-0 !p-4 sm:!p-5">
            <div
              className={`rounded-2xl border ${draft.status === "waiting" ? "p-3" : "p-4"} ${
                draft.status === "paused"
                  ? "border-orange-500/40 bg-orange-500/10"
                  : draft.status === "completed"
                    ? "border-slate-700 bg-slate-950/70"
                    : "border-[#18C964]/40 bg-[#18C964]/10"
              }`}
            >
              <div className={draft.status === "waiting" ? "space-y-1.5" : "space-y-3"}>
                <p
                  className={`text-sm font-semibold uppercase tracking-[0.3em] ${
                    draft.status === "paused"
                      ? "text-orange-300"
                      : draft.status === "completed"
                        ? "text-slate-300"
                        : "text-[#8ef0b5]"
                  }`}
                >
                  {draft.status === "waiting" ? "PŘED ZAHÁJENÍM" : draft.status === "paused" ? "DRAFT JE POZASTAVEN" : draft.status === "completed" ? "DRAFT DOKONČEN" : "NA TAHU"}
                </p>
                {draft.status === "completed" ? (
                  <>
                    <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                      Draft dokončen
                    </h2>
                    <p className="text-sm text-slate-300">Všechny týmy byly rozděleny.</p>
                    <div className="flex flex-wrap gap-3 text-sm text-slate-300">
                      <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">
                        Dokončené výběry: {completedPickCount} z {draft.draftItems.length}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                      {draft.status === "waiting" ? "Draft ještě nezačal" : currentParticipant?.name || "Čeká se na účastníka"}
                    </h2>
                    {draft.status === "waiting" ? (
                      <p className="text-sm text-slate-300">Draft čeká na spuštění administrátorem.</p>
                    ) : null}
                    {draft.status !== "waiting" ? (
                      <div className="flex flex-wrap gap-3 text-sm text-slate-300">
                        <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">Kolo {currentRound}</span>
                        <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">Tah {currentPickNumber} z {draft.pickOrder.length}</span>
                        <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">Zbývá týmů: {availableItems.length}</span>
                      </div>
                    ) : null}
                  </>
                )}

                {draft.status !== "waiting" ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Časomíra</span>
                  <span className={`font-mono text-lg font-bold ${
                    draft.status === "drafting" && remainingTurnSeconds === 0
                      ? "text-amber-300"
                      : "text-[#8ef0b5]"
                  }`}>
                    {draft.status === "completed"
                      ? "Zastavena"
                      : draft.status === "paused"
                        ? "Pozastavena"
                        : draft.status !== "drafting"
                          ? "Čeká na start"
                          : draft.turnDurationSeconds === null
                            ? "Bez limitu"
                            : `${remainingTurnSeconds ?? draft.turnDurationSeconds} s`}
                  </span>
                  {draft.status === "completed" ? (
                    <span className="text-xs text-slate-400">{completedPickCount} z {draft.draftItems.length} výběrů</span>
                  ) : null}
                </div> : null}

                {draft.status !== "waiting" ? (
                  <div className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">
                      {draft.status === "completed" ? "Poslední vybraný tým" : "Poslední výběr"}
                    </p>
                    {lastPickEntry && lastPickParticipant ? (
                      <div className="mt-3 flex items-center gap-3">
                        {lastPickItem ? <TeamLogo item={lastPickItem} className="h-8 w-8" /> : null}
                        <div>
                          <p className="text-sm font-semibold text-white">{lastPickParticipant.name} vybral</p>
                          <p className="text-sm text-slate-300">{lastPickItem?.name ?? lastPickEntry.itemName ?? "Neznámý tým"}</p>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-slate-400">Draft zatím nemá žádný výběr.</p>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </Card>
          <Card className="min-w-0 space-y-3 !p-4 sm:!p-5 lg:col-span-2 xl:col-span-1">
            <h2 className="text-lg font-semibold text-white">Chat draftu</h2>
            <DraftChat
              draftId={draft.id}
              draftCode={draft.code}
              currentUser={user}
              currentUserRole={profile?.role ?? null}
              isEmbedded
              className="h-80 min-h-0 min-w-0 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70"
            />
          </Card>
          </div>

          <Card className="space-y-4 !p-4 sm:!p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-white">Účastníci</h2>
                <p className="text-sm text-slate-400">Admin je vyjmutý z pořadí a nedostává žádný tým.</p>
                {isSettingsLocked ? (
                  <p className="mt-2 text-sm text-slate-500">Nastavení je po spuštění draftu uzamčeno.</p>
                ) : null}
              </div>
              <p className="text-sm text-slate-400">
                {draft.participants.length} účastnických pozic · {completedPickCount} provedených výběrů
              </p>
            </div>

            {drawAnimation ? (
              <div aria-live="polite" className="text-sm font-semibold text-[#8ef0b5]">
                {drawAnimation.startedAt === null ? "Ukládám vylosované pořadí…" : "Losování pořadí probíhá…"}
              </div>
            ) : draft.participantOrderDrawn ? (
              <p className="text-sm font-semibold text-[#8ef0b5]">Pořadí vylosováno</p>
            ) : null}
            <fieldset disabled={Boolean(drawAnimation)} className="min-w-0 space-y-4">
            <div className="grid items-start gap-2 md:grid-cols-2">
              {(drawAnimation
                ? drawAnimation.participants.map((_, index, participants) => participants[(index + drawAnimation.offset) % participants.length])
                : draft.participants).map((participant, index) => {
                const isCurrentTurn = currentParticipant?.id === participant.id;
                const participantStatusLabel = participant.status === "ready"
                  ? "Připojen"
                  : isCurrentTurn && !isDraftWaiting
                    ? "Na tahu"
                    : isDraftWaiting
                      ? "Čeká na připojení"
                      : "Rezervováno";
                const participantStatusClass = participant.status === "ready"
                  ? "border-[#18C964]/20 bg-[#18C964]/10 text-[#8ef0b5]"
                  : isCurrentTurn && !isDraftWaiting
                    ? "border-orange-500/20 bg-orange-500/10 text-orange-300"
                    : "border-slate-700 bg-slate-900/70 text-slate-300";

                return (
                <div key={participant.id} className={`rounded-xl border p-3 ${isCurrentTurn ? "border-[#18C964]/40 bg-[#18C964]/5" : "border-slate-800 bg-slate-950/70"}`}>
                  <div className="flex items-start gap-2">
                    <details className="min-w-0 flex-1">
                      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 [&::-webkit-details-marker]:hidden">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-xs font-bold text-slate-300">{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate font-semibold text-white">{participant.displayName || participant.name || `Účastník ${index + 1}`}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${participantStatusClass}`}>
                          {participantStatusLabel}
                        </span>
                        <span className="whitespace-nowrap text-xs text-slate-400">{participant.picks.length} týmů</span>
                      </summary>
                      <div className="mt-3 space-y-3 border-t border-slate-800 pt-3">
                  <input
                    value={participantNames[index] ?? ""}
                    onChange={(event) => updateParticipantName(index, event.target.value)}
                    placeholder={`Jméno účastníka ${index + 1}`}
                    disabled={isSettingsLocked}
                    className="mt-3 w-full rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-[#18C964]/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Přiřazený uživatel</p>
                      <p className="mt-1 text-sm text-slate-200">{participant.userId || participant.uid ? participant.name || "Přiřazený uživatel" : "—"}</p>
                      {participant.email ? <p className="text-xs text-slate-500">{participant.email}</p> : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedParticipantIndex(index);
                        setUserSearch("");
                        setMatchingUsers([]);
                      }}
                      disabled={isSettingsLocked}
                      className="rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {participant.userId || participant.uid ? "Změnit uživatele" : "Přiřadit uživatele"}
                    </button>
                    {participant.userId || participant.uid ? (
                      <button
                        type="button"
                        onClick={() => void handleRemoveUserFromParticipant(index)}
                        disabled={isSettingsLocked}
                        className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Odebrat uživatele
                      </button>
                    ) : null}
                  </div>
                  {selectedParticipantIndex === index ? (
                    <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-3">
                      <label className="grid gap-2 text-sm font-medium text-slate-300">
                        Najít registrovaného uživatele
                        <input
                          value={userSearch}
                          onChange={(event) => setUserSearch(event.target.value)}
                          placeholder="Jméno nebo e-mail"
                          className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-[#18C964]/50"
                        />
                      </label>
                      <div className="mt-3 space-y-2">
                        {isSearchingUsers ? (
                          <p className="text-sm text-slate-400">Vyhledávám uživatele...</p>
                        ) : matchingUsers.length > 0 ? (
                          matchingUsers.map((candidate) => (
                            <button
                              key={candidate.uid}
                              type="button"
                              onClick={() => void handleAssignUserToParticipant(index, candidate.uid, candidate.displayName, candidate.email)}
                              className="flex w-full items-center justify-between rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-left text-sm text-slate-200 transition hover:border-[#18C964]/40 hover:bg-slate-800"
                            >
                              <span>
                                <span className="font-semibold text-white">{candidate.displayName}</span>
                                {candidate.email ? <span className="ml-2 text-slate-400">{candidate.email}</span> : null}
                              </span>
                              <span className="text-xs uppercase tracking-[0.2em] text-slate-500">Přiřadit</span>
                            </button>
                          ))
                        ) : userSearch.trim() ? (
                          <p className="text-sm text-slate-400">Žádní uživatelé nenalezeni.</p>
                        ) : (
                          <p className="text-sm text-slate-400">Začněte psát jméno nebo e-mail uživatele.</p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedParticipantIndex(null);
                          setUserSearch("");
                          setMatchingUsers([]);
                        }}
                        className="mt-3 text-sm font-semibold text-[#8ef0b5] transition hover:text-[#18C964]"
                      >
                        Zavřít
                      </button>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">PIN účastníka</p>
                      <p className="mt-1 font-mono text-sm text-slate-200">{participant.participantPin ?? "—"}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleGenerateParticipantPin(index)}
                      className="rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                    >
                      Vygenerovat PIN
                    </button>
                  </div>
                      </div>
                    </details>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        aria-label={`Posunout účastníka ${index + 1} nahoru`}
                        onClick={() => moveParticipant(index, -1)}
                        disabled={isSettingsLocked || draft.participantOrderDrawn || index === 0}
                        className="rounded-lg border border-slate-700 px-2 py-1 text-sm text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Posunout účastníka ${index + 1} dolů`}
                        onClick={() => moveParticipant(index, 1)}
                        disabled={isSettingsLocked || draft.participantOrderDrawn || index === draft.participants.length - 1}
                        className="rounded-lg border border-slate-700 px-2 py-1 text-sm text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ↓
                      </button>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleSaveParticipantNames()}
                disabled={isSavingNames || isUpdating || isSettingsLocked}
                className="rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSavingNames ? "Ukládám jména..." : "Uložit jména účastníků"}
              </button>
              <button
                type="button"
                onClick={() => shuffleParticipants()}
                disabled={isUpdating || isSavingNames || isSettingsLocked || draft.participantOrderDrawn}
                className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {draft.participantOrderDrawn ? "Pořadí vylosováno" : "Náhodně vylosovat pořadí"}
              </button>
            </div>
            </fieldset>
          </Card>

          {/* ŽEBŘÍČEK ATRAKTIVITY TÝMŮ CARD */}
          <Card className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-2xl font-semibold text-white">Žebříček atraktivity týmů NHL</h2>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider ${
                      isRankingLocked
                        ? "border border-amber-500/40 bg-amber-950/40 text-amber-300"
                        : "border border-emerald-500/40 bg-emerald-950/40 text-[#8ef0b5]"
                    }`}
                  >
                    {isRankingLocked ? "Uzamčeno pro tento draft" : "K úpravě před startem"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-400">
                  {isRankingLocked
                    ? "Žebříček je uzamčen pro tento konkrétní draft. Změny v administraci žebříčků produktů tento draft neovlivní."
                    : "Společný žebříček vypočtený ze zvolených boxů. Pořadí můžete ručně upravit a uložit ještě před zahájením draftu."}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!isRankingLocked && (
                  <button
                    type="button"
                    onClick={() => void handleSaveTeamRanking()}
                    disabled={isSavingRanking || isUpdating}
                    className="rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:opacity-50"
                  >
                    {isSavingRanking ? "Ukládám..." : "Uložit pořadí žebříčku"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setIsRankingExpanded((prev) => !prev)}
                  className="rounded-2xl border border-slate-700 bg-slate-900/80 px-3.5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  {isRankingExpanded
                    ? `Skrýt všech ${draft.draftItems.length} týmů ▲`
                    : `Zobrazit a upravit ${draft.draftItems.length} týmů ▼`}
                </button>
              </div>
            </div>

            {rankingFeedback && (
              <p className={`text-sm ${rankingFeedback.includes("Nepodařilo") ? "text-red-300" : "text-[#8ef0b5]"}`}>
                {rankingFeedback}
              </p>
            )}

            {/* Quick preview of top 8 teams */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-slate-500">Nejatraktivnější týmy:</span>
              {rankingOrder.slice(0, 8).map((teamId, idx) => {
                const team = rankingTeamLookup.get(teamId);
                return (
                  <div
                    key={teamId}
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-200"
                  >
                    <span className="font-bold text-[#8ef0b5]">#{idx + 1}</span>
                    {team && <TeamLogo item={team} className="h-4 w-4" />}
                    <span className="truncate max-w-[90px]">{team?.name.split(" ").pop() ?? teamId}</span>
                  </div>
                );
              })}
              {rankingOrder.length > 8 && (
                <span className="text-xs text-slate-500">+ dalších {rankingOrder.length - 8} týmů</span>
              )}
            </div>

            {/* Full team list */}
            {isRankingExpanded && (
              <div className="mt-4 space-y-3 border-t border-slate-800 pt-4">
                <p className="text-xs text-slate-400">
                  {isRankingLocked
                    ? `Pořadí všech ${draft.draftItems.length} týmů (po spuštění draftu již nelze měnit):`
                    : "Pořadí můžete upravit přetažením myší nebo pomocí šipek ▲ / ▼. Nezapomeňte změny uložit."}
                </p>

                <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 max-h-[460px] overflow-y-auto pr-1">
                  {rankingOrder.map((teamId, index) => {
                    const team = rankingTeamLookup.get(teamId);
                    const isDragging = draggedRankIndex === index;
                    const isTarget = dragOverRankIndex === index;

                    return (
                      <div
                        key={teamId}
                        draggable={!isRankingLocked}
                        onDragStart={(e) => {
                          if (isRankingLocked) return;
                          e.dataTransfer.setData("text/plain", String(index));
                          setDraggedRankIndex(index);
                        }}
                        onDragOver={(e) => {
                          if (isRankingLocked) return;
                          e.preventDefault();
                          if (dragOverRankIndex !== index) setDragOverRankIndex(index);
                        }}
                        onDragLeave={() => {
                          if (dragOverRankIndex === index) setDragOverRankIndex(null);
                        }}
                        onDrop={(e) => {
                          if (isRankingLocked) return;
                          e.preventDefault();
                          const fromIdx = Number(e.dataTransfer.getData("text/plain"));
                          if (!Number.isNaN(fromIdx)) {
                            handleDropRankingTeam(fromIdx, index);
                          }
                          setDraggedRankIndex(null);
                          setDragOverRankIndex(null);
                        }}
                        onDragEnd={() => {
                          setDraggedRankIndex(null);
                          setDragOverRankIndex(null);
                        }}
                        className={`flex items-center justify-between gap-2 rounded-xl border p-2 text-xs transition-all select-none ${
                          !isRankingLocked ? "cursor-grab active:cursor-grabbing" : ""
                        } ${
                          isDragging
                            ? "opacity-30 border-dashed border-[#18C964]"
                            : isTarget
                              ? "border-2 border-[#18C964] bg-emerald-950/40"
                              : "border-slate-800 bg-slate-900/80 hover:border-slate-700"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {!isRankingLocked && <span className="text-slate-600 font-mono text-[10px]">⋮⋮</span>}
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-black ${
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
                          {team && <TeamLogo item={team} className="h-5 w-5" />}
                          <span className="truncate font-semibold text-white">{team?.name || teamId}</span>
                        </div>

                        {!isRankingLocked && (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleMoveRankingTeam(index, "up")}
                              disabled={index === 0}
                              className="h-5 w-5 rounded border border-slate-800 bg-slate-950 text-[10px] text-slate-400 hover:text-white disabled:opacity-20"
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMoveRankingTeam(index, "down")}
                              disabled={index === rankingOrder.length - 1}
                              className="h-5 w-5 rounded border border-slate-800 bg-slate-950 text-[10px] text-slate-400 hover:text-white disabled:opacity-20"
                            >
                              ▼
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          <div className={`grid items-start gap-4 ${isDraftWaiting ? "" : "xl:grid-cols-[1.1fr_0.9fr]"}`}>
            {draft.status !== "waiting" ? (
            <Card className="min-w-0 space-y-3 !p-4 sm:!p-5">
              <div className="flex flex-wrap gap-2">
                {draft.status !== "completed" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleSelectItemForCurrentParticipant()}
                      disabled={!canManageTurnAction}
                      className="rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      Vybrat tým za aktuálního účastníka
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSkipCurrentParticipant()}
                      disabled={!canManageTurnAction}
                      className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      Přeskočit účastníka
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleUndoLastAction()}
                  disabled={isUpdating || draft.history.length === 0}
                  className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Vrátit poslední tah
                </button>
              </div>
              {draft.status !== "completed" ? (
              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-sm text-slate-400">Dostupné týmy</p>
                {isSubmittingTurnAction ? <p className="mt-2 text-sm text-[#8ef0b5]">Ukládám výběr…</p> : null}
                <div className="mt-3 grid max-h-80 gap-2 overflow-y-auto overscroll-contain pr-1">
                  {availableItems.length > 0 ? (
                    availableItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => void handleSelectItem(item)}
                        disabled={!canManageTurnAction}
                        className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition ${canManageTurnAction ? "border-slate-800 bg-slate-900/80 text-slate-200 hover:border-[#18C964]/40 hover:bg-slate-800" : "cursor-not-allowed border-slate-800 bg-slate-900/60 text-slate-500"}`}
                      >
                        <span className="flex items-center gap-3">
                          <TeamLogo item={item} className="h-8 w-8" />
                          <span>{item.name}</span>
                        </span>
                        <span className="text-slate-400">{isSubmittingTurnAction ? "Ukládám výběr…" : canManageTurnAction ? "Vybrat" : "Nedostupné"}</span>
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-slate-400">Žádné dostupné položky.</p>
                  )}
                </div>
              </div>
              ) : null}
            </Card>
            ) : null}

            <div className="min-w-0 space-y-3 self-start">
              <Card className="space-y-3 !p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold text-white">Přehled breaku</h2>
                  <span className="text-xs text-slate-400">{totalBreakBoxCount} {breakBoxCountLabel} celkem</span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <p className="text-[11px] text-slate-400">Počet boxů</p>
                    <p className="mt-0.5 text-sm font-semibold text-white">{totalBreakBoxCount}</p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <p className="text-[11px] text-slate-400">Cena za box</p>
                    <p className="mt-0.5 text-sm font-semibold text-white">{draft.boxPrice.toLocaleString("cs-CZ")} Kč</p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <p className="text-[11px] text-slate-400">Marže</p>
                    <p className="mt-0.5 text-sm font-semibold text-white">{draft.margin.toLocaleString("cs-CZ")} Kč</p>
                  </div>
                  <div className="rounded-lg border border-[#18C964]/20 bg-[#18C964]/5 px-3 py-2">
                    <p className="text-[11px] text-slate-400">Cena breaku</p>
                    <p className="mt-0.5 text-sm font-semibold text-[#8ef0b5]">{draft.targetBreakPrice.toLocaleString("cs-CZ")} Kč</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Složení breaku ({totalBreakBoxCount} {breakBoxCountLabel})
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {breakComposition.map((box, index) => (
                      <div
                        key={`${box.productId ?? box.productName}-${index}`}
                        className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-800/80 bg-slate-950/70 p-2"
                      >
                        {box.productImageUrl ? (
                          <div className="flex h-24 w-20 shrink-0 items-center justify-center rounded border border-slate-800 bg-slate-900 p-0.5">
                            <img
                              src={box.productImageUrl}
                              alt={box.productName}
                              className="h-full w-full object-contain"
                            />
                          </div>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-white">{box.boxCount}× {box.productName}</p>
                          <p className="truncate text-[11px] text-slate-400">{box.productSeason}</p>
                          <p className="text-[11px] font-medium text-[#8ef0b5]">{box.boxPrice.toLocaleString("cs-CZ")} Kč / ks</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              <Card className="min-w-0 space-y-3">
                <div>
                  <h2 className="text-xl font-semibold text-white">Vybrané týmy</h2>
                  <p className="text-xs text-slate-400">Rozbalte účastníka pro zobrazení a úpravu týmů.</p>
                </div>
                <div className="max-h-[28rem] space-y-2 overflow-y-auto overscroll-contain pr-1">
                  {draft.participants.some((participant) => participant.picks.length > 0) ? (
                    draft.participants.map((participant, participantIndex) => participant.picks.length > 0 ? (
                      <details key={participant.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                          <span className="min-w-0 truncate text-sm font-semibold text-white">
                            {participant.name || `Účastník ${participantIndex + 1}`}
                          </span>
                          <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                            {participant.picks.length} týmů
                          </span>
                        </summary>
                        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-800 pt-3">
                          {participant.picks.map((pickedItemId, pickedIndex) => {
                            const item = draft.draftItems.find((currentItem) => currentItem.id === pickedItemId);
                            return (
                              <div key={`${pickedItemId}-${pickedIndex}`} className="inline-flex max-w-full items-center gap-2 rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1 text-sm text-[#8ef0b5]">
                                <span className="inline-flex min-w-0 items-center gap-2">
                                  <TeamLogo item={item ?? null} className="h-5 w-5 shrink-0" />
                                  <span className="truncate">{item?.name ?? pickedItemId}</span>
                                </span>
                                {canReplaceSelection && availableItems.length > 0 ? (
                                  <button
                                    type="button"
                                    onClick={() => openReplaceDialog(participantIndex, participant.name || `Účastník ${participantIndex + 1}`, pickedItemId, item?.name ?? pickedItemId, pickedIndex)}
                                    className="shrink-0 rounded-full border border-slate-700/70 bg-slate-900/80 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300 transition hover:bg-slate-800"
                                  >
                                    Změnit
                                  </button>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    ) : null)
                  ) : (
                    <p className="text-sm text-slate-400">Zatím nebyl vybrán žádný tým.</p>
                  )}
                </div>
              </Card>

              <Card className="!p-0">
                <details>
                  <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
                    <span className="font-semibold text-white">Historie draftu</span>
                    <span className="ml-2 text-xs text-slate-400">{historyEntries.length} akcí · nejnovější nahoře</span>
                  </summary>
                  <div className="max-h-96 space-y-3 overflow-y-auto overscroll-contain px-4 pb-4">
                    {historyEntries.length > 0 ? (
                      historyEntries.map((entry, index) => {
                        const participant = draft.participants[entry.participantIndex];
                        const participantName = participant?.name || `Účastník ${entry.participantIndex + 1}`;
                        const pickedItem = entry.itemId
                          ? draft.draftItems.find((currentItem) => currentItem.id === entry.itemId)
                          : null;

                        if (entry.type === "replace") {
                          return (
                            <div
                              key={`${entry.type}-${entry.participantIndex}-${entry.oldItemId ?? "unknown"}-${entry.newItemId ?? "unknown"}-${index}`}
                              className={`rounded-2xl border p-4 ${index === 0 ? "border-[#18C964]/60 bg-[#18C964]/10" : "border-slate-800 bg-slate-950/70"}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="space-y-2">
                                  <p className="text-sm font-semibold text-white">{participantName}</p>
                                  <p className="text-sm text-slate-400">
                                    změnil {entry.oldItemName ?? "neznámý tým"} za {entry.newItemName ?? "neznámý tým"}
                                  </p>
                                </div>
                                <div className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                                  Tah {index + 1}
                                </div>
                              </div>
                            </div>
                          );
                        }

                        if (entry.type === "pick") {
                          return (
                            <div
                              key={`${entry.type}-${entry.participantIndex}-${entry.itemId ?? "unknown"}-${index}`}
                              className={`rounded-2xl border p-4 ${index === 0 ? "border-[#18C964]/60 bg-[#18C964]/10" : "border-slate-800 bg-slate-950/70"}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="space-y-2">
                                  <p className="text-sm font-semibold text-white">{participantName}</p>
                                  <p className="text-sm text-slate-400">
                                    {entry.automatic ? "automaticky vybral" : "vybral"}
                                    {entry.autoPickReason === "player-priorities"
                                      ? " podle vlastních priorit"
                                      : entry.autoPickReason === "organizer-ranking"
                                        ? " podle žebříčku organizátora"
                                        : ""}
                                  </p>
                                </div>
                                <div className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                                  Tah {index + 1}
                                </div>
                              </div>
                              <div className="mt-3 flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-3">
                                {pickedItem ? <TeamLogo item={pickedItem} className="h-7 w-7" /> : null}
                                <div>
                                  <p className="text-sm font-semibold text-slate-100">{pickedItem?.name ?? entry.itemName ?? "Neznámý tým"}</p>
                                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Výběr</p>
                                </div>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={`${entry.type}-${entry.participantIndex}-${index}`}
                            className={`rounded-2xl border p-4 ${index === 0 ? "border-[#18C964]/60 bg-[#18C964]/10" : "border-slate-800 bg-slate-950/70"}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="space-y-2">
                                <p className="text-sm font-semibold text-white">{participantName}</p>
                                <p className="text-sm text-slate-400">byl přeskočen</p>
                              </div>
                              <div className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                                Tah {index + 1}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-sm text-slate-400">Zatím žádná historie.</p>
                    )}
                  </div>
                </details>
              </Card>

            </div>
          </div>
        </div>
        <section className="print-results hidden" aria-hidden="true">
          <header className="print-results-header">
            <p>{draft.sport} · DM Draft</p>
            <h1>{draft.title}</h1>
            <p>Kód: {draft.code} · Datum: {formatDraftDate(draft.createdAt)}</p>
            <p>Stav: {draft.status === "completed" ? "Dokončeno" : "Průběžné výsledky"}</p>
          </header>
          <section className="print-break">
            <h2>Složení breaku</h2>
            <p>Celkem: {totalBreakBoxCount} {breakBoxCountLabel}</p>
            <ul>
              {breakComposition.map((box, index) => (
                <li key={`${box.productId ?? box.productName}-${index}`}>
                  {box.boxCount}× {box.productName} · {box.productSeason}
                </li>
              ))}
            </ul>
          </section>
          <h2>Účastníci a jejich týmy</h2>
          <div className="print-participants">
            {draft.participants.map((participant, index) => (
              <section key={participant.id} className="print-participant">
                <h3>{index + 1}. {participant.displayName || participant.name || `Účastník ${index + 1}`} <span>({participant.picks.length} týmů)</span></h3>
                {participant.picks.length > 0 ? (
                  <ul>
                    {participant.picks.map((pickedItemId) => {
                      const item = draft.draftItems.find((draftItem) => draftItem.id === pickedItemId);
                      return <li key={pickedItemId}>{item?.name ?? pickedItemId}</li>;
                    })}
                  </ul>
                ) : (
                  <p>Zatím bez výběru.</p>
                )}
              </section>
            ))}
          </div>
        </section>
      </PageContainer>

      {joinModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-3xl border border-slate-800 bg-slate-900/95 p-6 shadow-2xl shadow-slate-950/70">
            <p className="text-sm font-medium uppercase tracking-[0.25em] text-slate-500">Připojit se k draftu</p>
            <h3 className="mt-3 text-xl font-semibold text-white">Zadejte kód draftu</h3>
            <p className="mt-2 text-sm text-slate-400">Pokud je vaše jméno mezi rezervovanými účastníky, obsadí se vaše místo.</p>
            <label className="mt-5 grid gap-2 text-sm font-medium text-slate-300">
              Kód draftu
              <input
                value={joinDraftCode}
                onChange={(event) => setJoinDraftCode(event.target.value.toUpperCase())}
                placeholder="ABC123"
                className="rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
              />
            </label>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setJoinModalOpen(false);
                  setJoinDraftCode("");
                  setJoinMessage(null);
                }}
                className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                Zrušit
              </button>
              <button
                type="button"
                onClick={() => void handleJoinDraftFromCode()}
                disabled={isJoiningDraft || !user}
                className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isJoiningDraft ? "Připojuji..." : "Připojit se"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {replaceSelection ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeReplaceDialog();
            }
          }}
        >
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/95 shadow-2xl shadow-slate-950/70">
            <div className="shrink-0 border-b border-slate-800 px-6 pb-4 pt-6">
              <p className="text-sm font-medium uppercase tracking-[0.25em] text-slate-500">Změna výběru</p>
              <h3 className="mt-3 text-xl font-semibold text-white">Změnit tým pro {replaceSelection.participantName}</h3>
              <p className="mt-2 text-sm text-slate-400">
                Současný tým: <span className="font-semibold text-slate-100">{replaceSelection.currentItemName}</span>
              </p>

              {replaceError ? (
                <div className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {replaceError}
                </div>
              ) : null}
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-sm font-semibold text-white">Dostupné týmy</p>
                <div className="mt-3 grid gap-2">
                  {draft.draftItems.filter((item) => draft.availableItemIds.includes(item.id) && item.id !== replaceSelection.currentItemId).length > 0 ? (
                    draft.draftItems
                      .filter((item) => draft.availableItemIds.includes(item.id) && item.id !== replaceSelection.currentItemId)
                      .map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setReplacementItemId(item.id)}
                          className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition ${replacementItemId === item.id ? "border-[#18C964]/50 bg-[#18C964]/10 text-[#8ef0b5]" : "border-slate-800 bg-slate-900/80 text-slate-200 hover:border-[#18C964]/40 hover:bg-slate-800"}`}
                        >
                          <span className="flex items-center gap-3">
                            <TeamLogo item={item} className="h-7 w-7" />
                            <span>{item.name}</span>
                          </span>
                          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">
                            {replacementItemId === item.id ? "Vybráno" : "Vybrat"}
                          </span>
                        </button>
                      ))
                  ) : (
                    <p className="text-sm text-slate-400">Žádné dostupné týmy.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="sticky bottom-0 shrink-0 border-t border-slate-800 bg-slate-900/95 px-6 py-4">
              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  onClick={closeReplaceDialog}
                  disabled={isReplacingItem}
                  className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Zrušit
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmTeamReplacement()}
                  disabled={isReplacingItem || !replacementItemId || replacementItemId === replaceSelection.currentItemId}
                  className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isReplacingItem ? "Ukládám…" : "Potvrdit změnu"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function DraftDetailPage() {
  return (
    <AuthGuard>
      <DraftDetailPageContent />
    </AuthGuard>
  );
}
