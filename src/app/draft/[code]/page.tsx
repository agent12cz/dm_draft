"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Timestamp } from "firebase/firestore";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import { normalizeDraftItem } from "@/lib/snakeDraft";
import AuthGuard from "@/app/auth-guard";
import { useAuth } from "@/components/AuthProvider";
import { DraftChat } from "@/components/DraftChat";

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
  turnStartedAt?: unknown;
};

type TurnDurationOption = "none" | "10" | "15" | "20" | "30" | "45" | "60" | "custom";

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
  const [participantNames, setParticipantNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSavingNames, setIsSavingNames] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isSubmittingTurnAction, setIsSubmittingTurnAction] = useState(false);
  const [isHistoryHidden, setIsHistoryHidden] = useState(false);
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
              };

              setDraft(draftData);
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

  async function updateDraft(updates: Partial<Draft>) {
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
      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        participants: nextParticipants,
        updatedAt: firestoreApi.serverTimestamp(),
      });
    } catch (generateError) {
      console.error(generateError);
      setError("Nepodařilo se vygenerovat PIN.");
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

    console.log("ASSIGN PARTICIPANTS PAYLOAD", nextParticipants);
    console.log("ASSIGN PARTICIPANTS HAS UNDEFINED", nextParticipants.some((participant) => Object.values(participant).some((value) => value === undefined)));

    const draftDocumentId = draft.id || code || "";
    if (!draftDocumentId) {
      setError("Přiřazení selhalo: chybí identifikátor draftu.");
      return;
    }

    const { db, firestoreApi } = await getFirebaseClient();
    const draftDocRef = firestoreApi.doc(db, "drafts", draftDocumentId);
    console.log("ASSIGN DRAFT DOC", draftDocRef.path);

    try {
      await firestoreApi.updateDoc(draftDocRef, {
        participants: nextParticipants,
        updatedAt: firestoreApi.serverTimestamp(),
      });
      setParticipantNames(nextParticipants.map((participant) => participant.name || participant.displayName || ""));
      setSelectedParticipantIndex(null);
      setUserSearch("");
      setMatchingUsers([]);
    } catch (assignError) {
      const errorCode = typeof assignError === "object" && assignError && "code" in assignError ? String((assignError as { code?: unknown }).code ?? "unknown") : "unknown";
      const errorMessage = typeof assignError === "object" && assignError && "message" in assignError ? String((assignError as { message?: unknown }).message ?? "") : "";
      console.error("ASSIGN USER ERROR", assignError);
      setError(`Přiřazení selhalo: ${errorCode}${errorMessage ? ` – ${errorMessage}` : ""}`);
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
      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        participants: nextParticipants,
        updatedAt: firestoreApi.serverTimestamp(),
      });
      setParticipantNames(nextParticipants.map((participant) => participant.name || participant.displayName || ""));
      setSelectedParticipantIndex(null);
      setUserSearch("");
      setMatchingUsers([]);
    } catch (removeError) {
      const errorCode = typeof removeError === "object" && removeError && "code" in removeError ? String((removeError as { code?: unknown }).code ?? "unknown") : "unknown";
      const errorMessage = typeof removeError === "object" && removeError && "message" in removeError ? String((removeError as { message?: unknown }).message ?? "") : "";
      console.error("ASSIGN USER ERROR", removeError);
      setError(`Odebrání uživatele selhalo: ${errorCode}${errorMessage ? ` – ${errorMessage}` : ""}`);
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
          joinedAt: firestoreApi.serverTimestamp(),
          pickCount: participant.pickCount ?? participant.picks?.length ?? 0,
          status: "ready" as const,
        };
      });

      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draftDocument.id), {
        participants: nextParticipants,
        updatedAt: firestoreApi.serverTimestamp(),
      });

      setJoinMessage("Připojili jste se k draftu.");
      setJoinDraftCode("");
      setJoinModalOpen(false);
    } catch (joinError) {
      console.error(joinError);
      setJoinMessage("Nepodařilo se připojit k draftu.");
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

      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        participants: nextParticipants,
        updatedAt: firestoreApi.serverTimestamp(),
      });
    } catch (saveError) {
      console.error(saveError);
      setError("Nepodařilo se uložit jména účastníků.");
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
      await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
        participants: nextParticipants,
        status: "drafting",
        turnDurationSeconds: draft.turnDurationSeconds,
        turnStartedAt: firestoreApi.serverTimestamp(),
        updatedAt: firestoreApi.serverTimestamp(),
      });
    } catch (startError) {
      console.error(startError);
      setError("Nepodařilo se spustit draft.");
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
        const latestPickOrder = (latestData.pickOrder ?? []) as number[];
        const latestCurrentPickIndex = Number(latestData.currentPickIndex ?? 0);
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
        const nextStatus = nextPickIndex >= latestPickOrder.length ? "completed" : "drafting";
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
          history: nextHistory,
          updatedAt: firestoreApi.serverTimestamp(),
        } as Record<string, unknown>;

        if (nextStatus === "drafting") {
          nextDraftUpdate.turnStartedAt = firestoreApi.serverTimestamp();
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
          updatedAt: firestoreApi.serverTimestamp(),
        } as Record<string, unknown>;

        if (nextStatus === "drafting") {
          nextDraftUpdate.turnStartedAt = firestoreApi.serverTimestamp();
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

    await updateDraft({
      status: "drafting",
      participants: nextParticipants,
      currentPickIndex: previousPickIndex,
      availableItemIds: nextAvailableItemIds,
      history: updatedHistory,
    });
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

      await updateDraft({
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
      });

      setReplaceSelection(null);
      setReplacementItemId(null);
    } catch (replaceError) {
      console.error(replaceError);
      setReplaceError("Nepodařilo se změnit tým.");
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

    setParticipantNames(nextParticipants.map((participant) => participant.name));
    void (async () => {
      try {
        const { db, firestoreApi } = await getFirebaseClient();
        await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
          participants: nextParticipants,
          updatedAt: firestoreApi.serverTimestamp(),
        });
      } catch (moveError) {
        console.error(moveError);
        setError("Nepodařilo se změnit pořadí účastníků.");
      }
    })();
  }

  function shuffleParticipants() {
    if (!draft) {
      return;
    }

    const nextParticipants = [...draft.participants];
    for (let index = nextParticipants.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [nextParticipants[index], nextParticipants[randomIndex]] = [nextParticipants[randomIndex], nextParticipants[index]];
    }

    setParticipantNames(nextParticipants.map((participant) => participant.name));
    void (async () => {
      try {
        const { db, firestoreApi } = await getFirebaseClient();
        await firestoreApi.updateDoc(firestoreApi.doc(db, "drafts", draft.id), {
          participants: nextParticipants,
          updatedAt: firestoreApi.serverTimestamp(),
        });
      } catch (shuffleError) {
        console.error(shuffleError);
        setError("Nepodařilo se náhodně vylosovat pořadí účastníků.");
      }
    })();
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
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
      <div className="min-h-screen bg-slate-950 text-slate-100">
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <Card className="space-y-6">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-3">
                <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
                  Snake draft
                </p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  {draft.title}
                </h1>
                <p className="text-lg text-slate-400">{draft.sport}</p>
                <p className="text-sm font-medium uppercase tracking-[0.25em] text-slate-400">
                  Stav: {draft.status}
                </p>
              </div>

              <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
                <div>
                  <p className="text-sm text-slate-400">Kód draftu</p>
                  <p className="text-2xl font-semibold tracking-[0.3em] text-[#18C964]">{draft.code}</p>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Čas na výběr</p>
                  <p className="mt-1 text-sm font-semibold text-white">Čas na výběr: {formatTurnDurationLabel(draft.turnDurationSeconds)}</p>

                  <div className="mt-3 grid gap-2">
                    <select
                      value={turnDurationOption}
                      onChange={(event) => void handleTurnDurationOptionChange(event.target.value as TurnDurationOption)}
                      disabled={isSettingsLocked}
                      className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-[#18C964]/50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {TURN_DURATION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>

                    {turnDurationOption === "custom" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="number"
                          min="5"
                          max="300"
                          value={customTurnDurationSeconds}
                          onChange={(event) => setCustomTurnDurationSeconds(event.target.value)}
                          disabled={isSettingsLocked}
                          className="w-32 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-[#18C964]/50 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveCustomTurnDuration()}
                          disabled={isSettingsLocked}
                          className="rounded-xl border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Uložit
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/view/${draft.code}`}
                    className="inline-flex items-center justify-center rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20"
                  >
                    Otevřít viewer
                  </Link>
                  <button
                    type="button"
                    onClick={() => void handleCopyDraftCode()}
                    className="inline-flex items-center justify-center rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                  >
                    Kopírovat kód
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyViewerLink()}
                    className="inline-flex items-center justify-center rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                  >
                    Kopírovat viewer odkaz
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyPlayerLink()}
                    className="inline-flex items-center justify-center rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                  >
                    Kopírovat hráčský odkaz
                  </button>
                </div>
                {draftCodeCopyFeedback ? (
                  <p className={`text-sm ${draftCodeCopyFeedback.includes("nepodařilo") ? "text-red-300" : "text-[#8ef0b5]"}`}>
                    {draftCodeCopyFeedback}
                  </p>
                ) : null}
                {viewerLinkCopyFeedback ? (
                  <p className={`text-sm ${viewerLinkCopyFeedback.includes("nepodařilo") ? "text-red-300" : "text-[#8ef0b5]"}`}>
                    {viewerLinkCopyFeedback}
                  </p>
                ) : null}
                {playerLinkCopyFeedback ? (
                  <p className={`text-sm ${playerLinkCopyFeedback.includes("nepodařilo") ? "text-red-300" : "text-[#8ef0b5]"}`}>
                    {playerLinkCopyFeedback}
                  </p>
                ) : null}
              </div>
            </div>
          </Card>

          <Card className="space-y-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-white">Účastníci</h2>
                <p className="text-sm text-slate-400">Admin je vyjmutý z pořadí a nedostává žádný tým.</p>
                {isSettingsLocked ? (
                  <p className="mt-2 text-sm text-slate-500">Nastavení je po spuštění draftu uzamčeno.</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setJoinDraftCode(draft.code);
                    setJoinMessage(null);
                    setJoinModalOpen(true);
                  }}
                  className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20"
                >
                  Připojit se k draftu
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartDraft()}
                  disabled={isUpdating || !canStartDraft}
                  className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Spustit draft
                </button>
                <button
                  type="button"
                  onClick={() => void handlePauseDraft()}
                  disabled={isUpdating}
                  className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Pozastavit draft
                </button>
                <button
                  type="button"
                  onClick={() => void handleContinueDraft()}
                  disabled={isUpdating}
                  className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Pokračovat
                </button>
              </div>
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            ) : null}

            {startDraftMessage ? (
              <div className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-3 text-sm text-[#8ef0b5]">
                {startDraftMessage}
              </div>
            ) : null}

            {joinMessage ? (
              <div className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-3 text-sm text-[#8ef0b5]">
                {joinMessage}
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              {draft.participants.map((participant, index) => {
                const isCurrentTurn = currentParticipant?.id === participant.id;
                const participantStatusLabel = participant.status === "ready" ? "Připojen" : isCurrentTurn ? "Na tahu" : "Rezervováno";
                const participantStatusClass = participant.status === "ready"
                  ? "border-[#18C964]/20 bg-[#18C964]/10 text-[#8ef0b5]"
                  : isCurrentTurn
                    ? "border-orange-500/20 bg-orange-500/10 text-orange-300"
                    : "border-slate-700 bg-slate-900/70 text-slate-300";

                return (
                <div key={participant.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Účastník {index + 1}</p>
                      <p className="mt-1 text-lg font-semibold text-white">{participant.displayName || participant.name || `Účastník ${index + 1}`}</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => moveParticipant(index, -1)}
                        disabled={isSettingsLocked}
                        className="rounded-xl border border-slate-700 px-2 py-1 text-sm text-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveParticipant(index, 1)}
                        disabled={isSettingsLocked}
                        className="rounded-xl border border-slate-700 px-2 py-1 text-sm text-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        ↓
                      </button>
                    </div>
                  </div>
                  <div className={`mt-3 inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] ${participantStatusClass}`}>
                    {participantStatusLabel}
                  </div>
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
                  <p className="mt-2 text-sm text-slate-500">Počet týmů: {participant.picks.length}</p>
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
                disabled={isUpdating || isSettingsLocked}
                className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
              >
                Náhodně vylosovat pořadí
              </button>
              <button
                type="button"
                onClick={() => void handleCopyResults()}
                className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20"
              >
                Zkopírovat výsledky
              </button>
            </div>

            {copyFeedback ? (
              <p className={`text-sm ${copyFeedback.includes("nepodařilo") ? "text-red-300" : "text-[#8ef0b5]"}`}>
                {copyFeedback}
              </p>
            ) : null}
          </Card>

          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <Card className="space-y-5">
              <div
                className={`rounded-3xl border p-5 sm:p-6 ${
                  draft.status === "paused"
                    ? "border-orange-500/40 bg-orange-500/10"
                    : draft.status === "completed"
                      ? "border-slate-700 bg-slate-950/70"
                      : "border-[#18C964]/40 bg-[#18C964]/10"
                }`}
              >
                <div className="space-y-4">
                  <p
                    className={`text-sm font-semibold uppercase tracking-[0.3em] ${
                      draft.status === "paused"
                        ? "text-orange-300"
                        : draft.status === "completed"
                          ? "text-slate-300"
                          : "text-[#8ef0b5]"
                    }`}
                  >
                    {draft.status === "paused" ? "DRAFT JE POZASTAVEN" : draft.status === "completed" ? "DRAFT DOKONČEN" : "NA TAHU"}
                  </p>
                  <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                    {currentParticipant?.name || "Čeká se na účastníka"}
                  </h2>
                  <div className="flex flex-wrap gap-3 text-sm text-slate-300">
                    <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">Kolo {currentRound}</span>
                    <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">Tah {currentPickNumber} z {Math.max(1, draft.pickOrder.length)}</span>
                    <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1">Zbývá týmů: {availableItems.length}</span>
                  </div>

                  <div className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Poslední výběr</p>
                    {lastPickEntry && lastPickParticipant ? (
                      <div className="mt-3 flex items-center gap-3">
                        {lastPickItem ? <TeamLogo item={lastPickItem} className="h-8 w-8" /> : null}
                        <div>
                          <p className="text-sm font-semibold text-white">
                            {lastPickParticipant.name} vybral
                          </p>
                          <p className="text-sm text-slate-300">{lastPickItem?.name ?? lastPickEntry.itemName ?? "Neznámý tým"}</p>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-slate-400">Draft zatím nemá žádný výběr.</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-sm text-slate-400">Dostupné draftItems</p>
                {isSubmittingTurnAction ? <p className="mt-2 text-sm text-[#8ef0b5]">Ukládám výběr…</p> : null}
                <div className="mt-3 grid gap-2">
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

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleSkipCurrentParticipant()}
                  disabled={!canManageTurnAction}
                  className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Přeskočit účastníka
                </button>
                <button
                  type="button"
                  onClick={() => void handleUndoLastAction()}
                  disabled={isUpdating}
                  className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Vrátit poslední tah
                </button>
                <button
                  type="button"
                  onClick={() => void handleSelectItemForCurrentParticipant()}
                  disabled={!canManageTurnAction}
                  className="rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Vybrat tým za aktuálního účastníka
                </button>
              </div>
            </Card>

            <div className="space-y-6">
              <Card className="space-y-4">
                <div>
                  <h2 className="text-2xl font-semibold text-white">Přehled draftu</h2>
                  <p className="text-sm text-slate-400">Průběžný přehled týmů, ceny a stavu breaku.</p>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                    <p className="text-sm text-slate-400">Box</p>
                    <p className="mt-2 text-lg font-semibold text-white">{draft.productName}</p>
                    <p className="text-sm text-slate-400">{draft.productSeason}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                    <p className="text-sm text-slate-400">Cena za box</p>
                    <p className="mt-2 text-lg font-semibold text-white">{draft.boxPrice} Kč</p>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                    <p className="text-sm text-slate-400">Počet boxů</p>
                    <p className="mt-2 text-lg font-semibold text-white">{draft.boxCount}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                    <p className="text-sm text-slate-400">Marže</p>
                    <p className="mt-2 text-lg font-semibold text-white">{draft.margin} Kč</p>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-sm text-slate-400">Cílová cena breaku</p>
                  <p className="mt-2 text-2xl font-semibold text-[#18C964]">{draft.targetBreakPrice} Kč</p>
                </div>

                {draft.productImageUrl ? (
                  <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70">
                    <img src={draft.productImageUrl} alt={draft.productName} className="h-56 w-full object-cover" />
                  </div>
                ) : null}
              </Card>

              <Card className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-2xl font-semibold text-white">Vybrané týmy</h2>
                  <button
                    type="button"
                    onClick={() => setIsHistoryHidden((current) => !current)}
                    className="rounded-2xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                  >
                    {isHistoryHidden ? "Zobrazit historii" : "Skrýt historii"}
                  </button>
                </div>
                <div className="space-y-2">
                  {draft.participants.some((participant) => participant.picks.length > 0) ? (
                    draft.participants.map((participant) => (
                      <div key={participant.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-sm font-semibold text-white">{participant.name || `Účastník ${draft.participants.indexOf(participant) + 1}`}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {participant.picks.length > 0 ? (
                            participant.picks.map((pickedItemId, pickedIndex) => {
                              const item = draft.draftItems.find((currentItem) => currentItem.id === pickedItemId);
                              return (
                                <div key={`${pickedItemId}-${pickedIndex}`} className="inline-flex items-center gap-2 rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1 text-sm text-[#8ef0b5]">
                                  <span className="inline-flex items-center gap-2">
                                    <TeamLogo item={item ?? null} className="h-5 w-5" />
                                    {item?.name ?? pickedItemId}
                                  </span>
                                  {canReplaceSelection ? (
                                    <button
                                      type="button"
                                      onClick={() => openReplaceDialog(draft.participants.indexOf(participant), participant.name || `Účastník ${draft.participants.indexOf(participant) + 1}`, pickedItemId, item?.name ?? pickedItemId, pickedIndex)}
                                      className="rounded-full border border-slate-700/70 bg-slate-900/80 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300 transition hover:bg-slate-800"
                                    >
                                      Změnit
                                    </button>
                                  ) : null}
                                </div>
                              );
                            })
                          ) : (
                            <span className="text-sm text-slate-500">Zatím žádné výběry.</span>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-400">Zatím nebyl vybrán žádný tým.</p>
                  )}
                </div>
              </Card>

              <DraftChat draftId={draft.id} draftCode={draft.code} currentUser={user} currentUserRole={profile?.role ?? null} />

              {!isHistoryHidden ? (
                <Card className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-2xl font-semibold text-white">Historie draftu</h2>
                      <p className="text-sm text-slate-400">Nejnovější akce jsou zobrazeny nahoře.</p>
                    </div>
                  </div>
                  <div className="space-y-3">
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
                                  <p className="text-sm text-slate-400">vybral</p>
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
                </Card>
              ) : null}

              {draft.status === "completed" ? (
                <Card className="space-y-4">
                  <h2 className="text-2xl font-semibold text-white">Konečný přehled</h2>
                  <div className="space-y-2">
                    {draft.participants.map((participant) => (
                      <div key={participant.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="font-semibold text-white">{participant.name || `Účastník ${draft.participants.indexOf(participant) + 1}`}</p>
                        <p className="text-sm text-slate-400">Počet týmů: {participant.picks.length}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {participant.picks.map((pickedItemId) => {
                            const item = draft.draftItems.find((currentItem) => currentItem.id === pickedItemId);
                            return (
                              <span key={pickedItemId} className="inline-flex items-center gap-2 rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1 text-sm text-[#8ef0b5]">
                                <TeamLogo item={item ?? null} className="h-5 w-5" />
                                {item?.name ?? pickedItemId}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}
            </div>
          </div>
        </div>
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
