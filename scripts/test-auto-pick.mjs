import assert from "node:assert/strict";
import { buildAutomaticPickUpdate } from "../src/lib/autoPick.ts";
import { defaultDraftItems } from "../src/lib/snakeDraft.js";
import { calculateCombinedTeamRanking } from "../src/lib/rankings.js";

const teams = [
  { id: "team-a", name: "Team A" },
  { id: "team-b", name: "Team B" },
  { id: "team-c", name: "Team C" },
];

function draftFixture(overrides = {}) {
  return {
    participants: [{ userId: "player-1", name: "Player 1", picks: [] }],
    pickOrder: [0, 0],
    currentPickIndex: 0,
    availableItemIds: ["team-a", "team-b", "team-c"],
    draftItems: teams,
    history: [],
    teamRanking: ["team-c", "team-b", "team-a"],
    playerPriorities: {},
    ...overrides,
  };
}

{
  const update = buildAutomaticPickUpdate(
    draftFixture({ playerPriorities: { "player-1": ["team-b", "team-a", "team-c"] } }),
  );
  assert.equal(update?.history.at(-1)?.itemId, "team-b");
  assert.equal(update?.history.at(-1)?.autoPickReason, "player-priorities");
  assert.equal(update?.history.at(-1)?.automatic, true);
  console.log("✓ Saved player priorities select the player's highest available team");
}

{
  const update = buildAutomaticPickUpdate(draftFixture());
  assert.equal(update?.history.at(-1)?.itemId, "team-c");
  assert.equal(update?.history.at(-1)?.autoPickReason, "organizer-ranking");
  console.log("✓ Missing player priorities use the organizer ranking");
}

{
  const update = buildAutomaticPickUpdate(
    draftFixture({
      playerPriorities: { "player-1": ["team-a", "team-b"] },
      availableItemIds: ["team-b", "team-c"],
    }),
  );
  assert.equal(update?.history.at(-1)?.itemId, "team-b");
  assert.equal(update?.history.at(-1)?.autoPickReason, "player-priorities");
  console.log("✓ An unavailable first-ranked team is skipped in player priorities");
}

{
  const update = buildAutomaticPickUpdate(
    draftFixture({
      playerPriorities: { "player-1": ["team-a"] },
      availableItemIds: ["team-b", "team-c"],
    }),
  );
  assert.equal(update?.history.at(-1)?.itemId, "team-c");
  assert.equal(update?.history.at(-1)?.autoPickReason, "organizer-ranking");
  console.log("✓ When no player priority is available, the organizer ranking is used");
}

{
  const teamIds = defaultDraftItems.map((team) => team.id);
  const boxOneOrder = [...teamIds];
  const boxTwoOrder = [...teamIds].reverse();
  const combinedOrder = calculateCombinedTeamRanking(
    [
      {
        productName: "Box One",
        productSeason: "2026/27",
        boxCount: 1,
        boxPrice: 1,
        teamOrder: boxOneOrder,
      },
      {
        productName: "Box Two",
        productSeason: "2026/27",
        boxCount: 3,
        boxPrice: 1,
        teamOrder: boxTwoOrder,
      },
    ],
    defaultDraftItems,
  ).map((team) => team.teamId);
  const update = buildAutomaticPickUpdate(
    draftFixture({
      draftItems: defaultDraftItems,
      availableItemIds: teamIds,
      teamRanking: combinedOrder,
    }),
  );
  assert.equal(update?.history.at(-1)?.itemId, combinedOrder[0]);
  assert.equal(update?.history.at(-1)?.autoPickReason, "organizer-ranking");
  console.log("✓ Multiple box rankings use the existing weighted-average attractiveness ranking");
}

{
  const update = buildAutomaticPickUpdate(
    draftFixture({
      currentPickIndex: 1,
      availableItemIds: ["team-a"],
      draftItems: [teams[0]],
      teamRanking: ["team-a"],
    }),
  );
  assert.equal(update?.status, "completed");
  assert.equal(update?.currentPickIndex, 2);
  assert.deepEqual(update?.availableItemIds, []);
  assert.equal(update?.history.at(-1)?.itemId, "team-a");
  console.log("✓ The last pick completes the draft and consumes the final available team");
}

console.log("\nALL AUTOMATIC PICK TESTS PASSED SUCCESSFULLY!");
