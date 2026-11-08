import type { DraftItem } from "@/lib/snakeDraft";

export type PickAnnouncement = {
  id: string;
  scope: string;
  participantName: string;
  item: DraftItem;
  automatic: boolean;
};

type PickHistorySnapshot = {
  history: readonly {
    type: string;
    participantIndex: number;
    itemId?: string;
    itemName?: string;
    automatic?: boolean;
  }[];
  participants: readonly { name?: string; displayName?: string }[];
  draftItems: readonly DraftItem[];
};

export class PickHistoryTracker {
  private scope: string | null = null;
  private observedLength = 0;

  observe(
    scope: string,
    draft: PickHistorySnapshot,
    metadata: { fromCache: boolean; hasPendingWrites: boolean },
  ): PickAnnouncement[] {
    if (metadata.fromCache || metadata.hasPendingWrites) return [];
    if (this.scope !== scope) {
      this.scope = scope;
      this.observedLength = draft.history.length;
      return [];
    }
    const start = this.observedLength;
    this.observedLength = Math.max(start, draft.history.length);
    return draft.history.slice(start).flatMap((entry, offset) => {
      if (entry.type !== "pick" || !entry.itemId) return [];
      const participant = draft.participants[entry.participantIndex];
      const item = draft.draftItems.find((team) => team.id === entry.itemId);
      return [{
        id: `${scope}:${start + offset}`,
        scope,
        participantName: participant?.displayName || participant?.name || `Účastník ${entry.participantIndex + 1}`,
        item: item ?? { id: entry.itemId, name: entry.itemName || entry.itemId, logo: "", sport: "NHL" },
        automatic: entry.automatic === true,
      }];
    });
  }
}

export const PICK_ANNOUNCEMENT_DURATION_MS = 2000;
