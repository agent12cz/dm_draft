"use client";

import { useState } from "react";
import type { DraftItem } from "@/lib/snakeDraft";
import { getTeamsForSport, type SportTeam } from "@/lib/sportsTeams";
import { isProductSport } from "@/lib/products";

type TeamLogoProps = {
  team: DraftItem | SportTeam;
  className: string;
  width?: number;
  height?: number;
};

function getFallbackLabel(team: DraftItem | SportTeam) {
  if (typeof team.abbreviation === "string") return team.abbreviation;
  if (isProductSport(team.sport)) {
    const catalogTeam = getTeamsForSport(team.sport).find((candidate) => candidate.id === team.id);
    if (typeof catalogTeam?.abbreviation === "string") return catalogTeam.abbreviation;
  }
  return team.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

export function TeamLogo({ team, className, width, height }: TeamLogoProps) {
  const [failedLogo, setFailedLogo] = useState<string | null>(null);

  if (team.logo && failedLogo !== team.logo) {
    return (
      <img
        src={team.logo}
        alt={team.name}
        width={width}
        height={height}
        className={className}
        loading="lazy"
        onError={() => setFailedLogo(team.logo)}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={`${team.name} (${getFallbackLabel(team)})`}
      className={`${className} inline-flex items-center justify-center rounded-full bg-slate-800 font-bold text-slate-300`}
    >
      {getFallbackLabel(team)}
    </span>
  );
}
