"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { getTeamNameLines } from "@/lib/nhlTeamNames";
import { PICK_ANNOUNCEMENT_DURATION_MS, type PickAnnouncement as PickEvent } from "@/lib/pickAnnouncements";
import { TeamLogo } from "@/components/TeamLogo";

export function PickAnnouncement({ event, onComplete }: {
  event: PickEvent;
  onComplete: (id: string) => void;
}) {
  useEffect(() => {
    const timeout = window.setTimeout(() => onComplete(event.id), PICK_ANNOUNCEMENT_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [event.id, onComplete]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center p-3">
      <aside
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pick-announcement w-full max-w-lg overflow-hidden rounded-2xl border border-[#18C964]/60 bg-slate-950/95 text-center shadow-[0_0_50px_rgba(24,201,100,0.2)]"
      >
        <div className="border-b border-[#18C964]/30 bg-gradient-to-r from-[#18C964]/25 to-transparent px-5 py-2">
          <p className="text-xs font-black uppercase tracking-[0.3em] text-[#8ef0b5]">PRÁVĚ VYBRÁNO</p>
        </div>
        <div className="flex min-w-0 flex-col items-center gap-3 px-5 py-4 sm:py-5">
          <TeamLogo team={event.item} width={112} height={112} className="h-24 w-24 shrink-0 object-contain sm:h-28 sm:w-28" />
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold text-slate-300">{event.participantName} vybral</p>
            <p className="mt-1 break-words text-xl font-black leading-tight text-white sm:text-3xl">
              {getTeamNameLines(event.item).map((line, index) => <span key={index} className="block">{line}</span>)}
            </p>
            {event.automatic ? <p className="mt-2 text-xs text-slate-400">Automatický výběr</p> : null}
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
