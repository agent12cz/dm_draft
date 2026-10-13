import { defaultDraftItems, type DraftItem } from "./snakeDraft";

export type TeamRankingRecord = {
  id: string; // Document ID, equal to productKey
  series: string; // e.g. "Series One"
  season: string; // e.g. "2026/27"
  productKey: string; // Unique key combining series and season
  teamOrder: string[]; // Exactly 32 team IDs in order of attractiveness (index 0 = rank 1)
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type BoxSelection = {
  id?: string;
  productId?: string;
  productName: string;
  productSeason: string;
  boxCount: number;
  boxPrice: number;
  productImageUrl?: string;
  teamOrder?: string[];
};

export type CalculatedTeamRank = {
  teamId: string;
  teamName: string;
  sport: string;
  logo: string;
  score: number; // Weighted average rank
  bestIndividualRank: number; // Best (lowest number) rank across all included boxes
  individualRanks: Array<{
    boxName: string;
    boxSeason: string;
    boxCount: number;
    rank: number;
  }>;
  finalRank: number; // 1 to 32
};

/**
 * Creates a deterministic, URL-safe and Firestore-safe unique key for a product series and season.
 * E.g. ("Series One", "2026/27") -> "series-one__2026-27"
 */
export function createProductKey(series: string, season: string): string {
  const cleanSeries = series
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const cleanSeason = season
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return `${cleanSeries || "unnamed"}__${cleanSeason || "general"}`;
}

/**
 * Ensures that a given team order contains all 32 teams without duplicates.
 * Any missing teams are appended at the end in their default order.
 */
export function ensureAllTeamsInOrder(
  teamOrder: string[] | undefined | null,
  allTeams: DraftItem[] = defaultDraftItems,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  if (Array.isArray(teamOrder)) {
    for (const teamId of teamOrder) {
      const exists = allTeams.some((team) => team.id === teamId);
      if (exists && !seen.has(teamId)) {
        seen.add(teamId);
        result.push(teamId);
      }
    }
  }

  for (const team of allTeams) {
    if (!seen.has(team.id)) {
      seen.add(team.id);
      result.push(team.id);
    }
  }

  return result;
}

/**
 * Calculates a combined, weighted attractiveness ranking for all 32 NHL teams across multiple boxes.
 *
 * Formula:
 *   score = sum(boxCount_i * rankInBox_i) / totalBoxCount
 *
 * Ranking criteria (lower score is better):
 *   1. score ascending
 *   2. bestIndividualRank ascending (min(rankInBox_i))
 *   3. teamName alphabetical order (Czech locale)
 *   4. teamId ascending (fallback deterministic)
 */
export function calculateCombinedTeamRanking(
  boxes: BoxSelection[],
  allTeams: DraftItem[] = defaultDraftItems,
  customRankingsByProductKey: Record<string, string[]> = {},
): CalculatedTeamRank[] {
  // Filter boxes that have positive count
  const validBoxes = boxes.filter((box) => box.boxCount > 0);

  // If no valid boxes, return default ranking based on allTeams order
  if (validBoxes.length === 0) {
    return allTeams.map((team, index) => ({
      teamId: team.id,
      teamName: team.name,
      sport: team.sport,
      logo: team.logo,
      score: index + 1,
      bestIndividualRank: index + 1,
      individualRanks: [],
      finalRank: index + 1,
    }));
  }

  const totalBoxCount = validBoxes.reduce((sum, box) => sum + box.boxCount, 0);

  // Resolve team order (1..32) for each box
  const boxRankings = validBoxes.map((box) => {
    const productKey = createProductKey(box.productName, box.productSeason);
    const order =
      box.teamOrder && box.teamOrder.length > 0
        ? ensureAllTeamsInOrder(box.teamOrder, allTeams)
        : customRankingsByProductKey[productKey]
          ? ensureAllTeamsInOrder(customRankingsByProductKey[productKey], allTeams)
          : allTeams.map((t) => t.id);

    const rankMap = new Map<string, number>();
    order.forEach((teamId, index) => {
      rankMap.set(teamId, index + 1);
    });

    return {
      box,
      rankMap,
    };
  });

  // Calculate scores for each team
  const calculatedTeams = allTeams.map((team) => {
    let weightedRankSum = 0;
    let bestIndividualRank = Number.POSITIVE_INFINITY;
    const individualRanks: CalculatedTeamRank["individualRanks"] = [];

    for (const { box, rankMap } of boxRankings) {
      const rankInBox = rankMap.get(team.id) ?? allTeams.length;
      weightedRankSum += box.boxCount * rankInBox;
      if (rankInBox < bestIndividualRank) {
        bestIndividualRank = rankInBox;
      }

      individualRanks.push({
        boxName: box.productName,
        boxSeason: box.productSeason,
        boxCount: box.boxCount,
        rank: rankInBox,
      });
    }

    const rawScore = weightedRankSum / totalBoxCount;
    // Round to 4 decimal places to avoid floating point precision noise during comparisons
    const score = Math.round(rawScore * 10000) / 10000;

    return {
      teamId: team.id,
      teamName: team.name,
      sport: team.sport,
      logo: team.logo,
      score,
      bestIndividualRank: Number.isFinite(bestIndividualRank) ? bestIndividualRank : allTeams.length,
      individualRanks,
      finalRank: 0,
    };
  });

  // Sort by criteria
  calculatedTeams.sort((a, b) => {
    // 1. Lower score is better
    if (a.score !== b.score) {
      return a.score - b.score;
    }

    // 2. Tie-break 1: Better (lower number) individual rank
    if (a.bestIndividualRank !== b.bestIndividualRank) {
      return a.bestIndividualRank - b.bestIndividualRank;
    }

    // 3. Tie-break 2: Alphabetical by team name (Czech locale)
    const nameCompare = a.teamName.localeCompare(b.teamName, "cs", { sensitivity: "base" });
    if (nameCompare !== 0) {
      return nameCompare;
    }

    // 4. Deterministic fallback
    return a.teamId.localeCompare(b.teamId);
  });

  // Assign final ranks 1..N
  return calculatedTeams.map((team, index) => ({
    ...team,
    finalRank: index + 1,
  }));
}
