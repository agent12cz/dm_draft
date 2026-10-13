export type AutoPickReason = "player-priorities" | "organizer-ranking";

export type AutoPickParticipant = {
  userId?: string;
  name?: string;
  picks?: string[];
  priorities?: string[];
  [key: string]: unknown;
};

export type AutoPickHistoryItem = {
  type: "pick" | "skip" | "replace";
  participantIndex: number;
  itemId?: string;
  itemName?: string;
  oldItemId?: string;
  oldItemName?: string;
  newItemId?: string;
  newItemName?: string;
  automatic?: boolean;
  autoPickReason?: AutoPickReason;
  [key: string]: unknown;
};

export type AutoPickDraft = {
  participants: AutoPickParticipant[];
  pickOrder: number[];
  currentPickIndex: number;
  availableItemIds: string[];
  draftItems: Array<{ id: string; name?: string }>;
  history: AutoPickHistoryItem[];
  teamRanking?: string[];
  playerPriorities?: Record<string, string[]>;
};

export type AutoPickUpdate = {
  participants: AutoPickParticipant[];
  currentPickIndex: number;
  availableItemIds: string[];
  history: AutoPickHistoryItem[];
  status: "drafting" | "completed";
};

export function buildAutomaticPickUpdate(draft: AutoPickDraft): AutoPickUpdate | null {
  const participantIndex = draft.pickOrder[draft.currentPickIndex];
  const participant = draft.participants[participantIndex];
  if (!participant) {
    return null;
  }

  const participantPriorities = participant.userId
    ? draft.playerPriorities?.[participant.userId] ?? participant.priorities
    : participant.priorities;
  const playerPriorityTeamId = participantPriorities?.find((teamId) =>
    draft.availableItemIds.includes(teamId),
  );
  const organizerTeamId = [
    ...(draft.teamRanking ?? []),
    ...draft.draftItems.map((item) => item.id),
  ].find((teamId) => draft.availableItemIds.includes(teamId));
  const selectedItemId = playerPriorityTeamId ?? organizerTeamId;

  if (!selectedItemId) {
    return null;
  }

  const selectedItem = draft.draftItems.find((item) => item.id === selectedItemId);
  const nextPickIndex = draft.currentPickIndex + 1;
  const nextAvailableItemIds = draft.availableItemIds.filter((teamId) => teamId !== selectedItemId);
  const nextStatus =
    nextPickIndex >= draft.pickOrder.length || nextAvailableItemIds.length === 0
      ? "completed"
      : "drafting";
  const nextParticipants = draft.participants.map((currentParticipant, index) =>
    index === participantIndex
      ? { ...currentParticipant, picks: [...(currentParticipant.picks ?? []), selectedItemId] }
      : currentParticipant,
  );

  return {
    participants: nextParticipants,
    currentPickIndex: nextPickIndex,
    availableItemIds: nextAvailableItemIds,
    history: [
      ...draft.history,
      {
        type: "pick",
        participantIndex,
        itemId: selectedItemId,
        itemName: selectedItem?.name ?? selectedItemId,
        automatic: true,
        autoPickReason: playerPriorityTeamId ? "player-priorities" : "organizer-ranking",
      },
    ],
    status: nextStatus,
  };
}
