import assert from "node:assert/strict";
import { buildAutomaticPickUpdate } from "../functions/src/autoPick.ts";

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
      playerPriorities: { "player-1": ["team-a", "team-b", "team-c"] },
      availableItemIds: ["team-b", "team-c"],
    }),
  );
  assert.equal(update?.history.at(-1)?.itemId, "team-b");
  console.log("✓ An unavailable first-ranked team is skipped");
}

{
  const update = buildAutomaticPickUpdate(
    draftFixture({
      currentPickIndex: 1,
      availableItemIds: ["team-a"],
      draftItems: [teams[0]],
    }),
  );
  assert.equal(update?.status, "completed");
  assert.equal(update?.currentPickIndex, 2);
  assert.deepEqual(update?.availableItemIds, []);
  assert.equal(update?.history.at(-1)?.itemId, "team-a");
  console.log("✓ The last automatic pick completes the draft and consumes the final team");
}

console.log("\nALL AUTOMATIC PICK TESTS PASSED SUCCESSFULLY!");
