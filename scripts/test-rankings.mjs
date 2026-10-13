import assert from "node:assert/strict";
import { defaultDraftItems } from "../src/lib/snakeDraft.js";
import {
  createProductKey,
  ensureAllTeamsInOrder,
  calculateCombinedTeamRanking,
} from "../src/lib/rankings.js";

console.log("Running rankings logic unit tests...");

// Test 1: createProductKey
{
  assert.equal(createProductKey("Series One", "2026/27"), "series-one__2026-27");
  assert.equal(createProductKey("Ultimate Collection", "2025/26"), "ultimate-collection__2025-26");
  assert.equal(createProductKey("O-Pee-Chee", "2024-25"), "o-pee-chee__2024-25");
  assert.equal(createProductKey("  SP Game Used  ", "  2023/24  "), "sp-game-used__2023-24");
  console.log("✓ Test 1: createProductKey passed");
}

// Test 2: ensureAllTeamsInOrder
{
  const partial = ["edmonton-oilers", "colorado-avalanche"];
  const full = ensureAllTeamsInOrder(partial);
  assert.equal(full.length, 32);
  assert.equal(full[0], "edmonton-oilers");
  assert.equal(full[1], "colorado-avalanche");
  const set = new Set(full);
  assert.equal(set.size, 32);
  console.log("✓ Test 2: ensureAllTeamsInOrder passed");
}

// Test 3: User's exact prompt example
// 3× Series One 2026/27 + 1× Ultimate 2025/26
// Formula: (3 * r_series_one + 1 * r_ultimate) / 4
{
  const oilersId = "edmonton-oilers";
  const avalancheId = "colorado-avalanche";

  const customSeriesOne = [oilersId, avalancheId, ...defaultDraftItems.map((t) => t.id).filter((id) => id !== oilersId && id !== avalancheId)];
  // In customSeriesOne: oilers = 1, avalanche = 2

  const otherTeams = defaultDraftItems.map((t) => t.id).filter((id) => id !== oilersId && id !== avalancheId);
  const customUltimate = [
    otherTeams[0], // rank 1
    avalancheId,   // rank 2
    otherTeams[1], // rank 3
    otherTeams[2], // rank 4
    oilersId,      // rank 5
    ...otherTeams.slice(3),
  ];

  const boxes = [
    {
      productName: "Series One",
      productSeason: "2026/27",
      boxCount: 3,
      boxPrice: 2000,
      teamOrder: customSeriesOne,
    },
    {
      productName: "Ultimate",
      productSeason: "2025/26",
      boxCount: 1,
      boxPrice: 5000,
      teamOrder: customUltimate,
    },
  ];

  const results = calculateCombinedTeamRanking(boxes, defaultDraftItems);

  const oilersResult = results.find((r) => r.teamId === oilersId);
  const avalancheResult = results.find((r) => r.teamId === avalancheId);

  // Oilers: (3*1 + 1*5)/4 = 2.0
  assert.equal(oilersResult.score, 2.0);
  assert.equal(oilersResult.bestIndividualRank, 1);

  // Avalanche: (3*2 + 1*2)/4 = 2.0
  assert.equal(avalancheResult.score, 2.0);
  assert.equal(avalancheResult.bestIndividualRank, 2);

  // Tie-breaker check: Oilers (bestRank 1) must be ranked above Avalanche (bestRank 2)
  assert.equal(oilersResult.finalRank < avalancheResult.finalRank, true);
  assert.equal(oilersResult.finalRank, 1);
  assert.equal(avalancheResult.finalRank, 2);
  console.log("✓ Test 3: Prompt example weighted calculation & best individual rank tie-breaker passed");
}

// Test 4: Equal score AND equal best individual rank -> Alphabetical tie-breaker
{
  const teamBoston = "boston-bruins";
  const teamChicago = "chicago-blackhawks";

  const otherTeams = defaultDraftItems
    .map((t) => t.id)
    .filter((id) => id !== teamBoston && id !== teamChicago);

  // Team Boston: rank 1 in Box 1, rank 2 in Box 2. (score = (1+2)/2 = 1.5, best = 1)
  // Team Chicago: rank 2 in Box 1, rank 1 in Box 2. (score = (2+1)/2 = 1.5, best = 1)
  const box1Order = [teamBoston, teamChicago, ...otherTeams];
  const box2Order = [teamChicago, teamBoston, ...otherTeams];

  const boxes = [
    {
      productName: "Box A",
      productSeason: "2026/27",
      boxCount: 1,
      boxPrice: 1000,
      teamOrder: box1Order,
    },
    {
      productName: "Box B",
      productSeason: "2026/27",
      boxCount: 1,
      boxPrice: 1000,
      teamOrder: box2Order,
    },
  ];

  const results = calculateCombinedTeamRanking(boxes, defaultDraftItems);
  const bostonResult = results.find((r) => r.teamId === teamBoston);
  const chicagoResult = results.find((r) => r.teamId === teamChicago);

  assert.equal(bostonResult.score, 1.5);
  assert.equal(chicagoResult.score, 1.5);
  assert.equal(bostonResult.bestIndividualRank, 1);
  assert.equal(chicagoResult.bestIndividualRank, 1);

  // Boston Bruins ("B") comes before Chicago Blackhawks ("C") alphabetically
  assert.equal(bostonResult.finalRank, 1);
  assert.equal(chicagoResult.finalRank, 2);
  console.log("✓ Test 4: Alphabetical tie-breaker passed");
}

// Test 5: Fallback lookup from customRankingsByProductKey
{
  const productKey = createProductKey("Series One", "2026/27");
  const reversedOrder = [...defaultDraftItems.map((t) => t.id)].reverse();
  const customMap = {
    [productKey]: reversedOrder,
  };

  const boxes = [
    {
      productName: "Series One",
      productSeason: "2026/27",
      boxCount: 1,
      boxPrice: 1000,
    },
  ];

  const results = calculateCombinedTeamRanking(boxes, defaultDraftItems, customMap);
  assert.equal(results[0].teamId, reversedOrder[0]);
  assert.equal(results[31].teamId, reversedOrder[31]);
  console.log("✓ Test 5: customRankingsByProductKey resolution passed");
}

console.log("\nALL RANKINGS TESTS PASSED SUCCESSFULLY! ✨");
