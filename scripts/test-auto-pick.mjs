import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  buildAutomaticPickUpdate,
  getDraftStatusAfterPick,
} from "../src/lib/autoPick.ts";
import {
  buildSnakeOrder,
  defaultDraftItems,
  extendSnakeOrderForSkippedPick,
} from "../src/lib/snakeDraft.js";
import { calculateCombinedTeamRanking } from "../src/lib/rankings.js";
import { getTimeLeftForTurn, getTurnKey } from "../src/lib/turnCountdown.ts";

const teams = [
  { id: "team-a", name: "Team A" },
  { id: "team-b", name: "Team B" },
  { id: "team-c", name: "Team C" },
];

{
  const source = ts.createSourceFile(
    "PlayerDraftPage.tsx",
    readFileSync(new URL("../src/components/PlayerDraftPage.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let saveFunction;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "handleSavePriorities") saveFunction = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(saveFunction);
  const workerCalls = [];
  function visitWorkerCalls(node) {
    const isWorkerCall = ts.isCallExpression(node) && (
      ts.isIdentifier(node.expression) && node.expression.text === "callFirestoreWorker" ||
      ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "callFirestoreWorker"
    );
    if (isWorkerCall) {
      workerCalls.push(node.arguments);
    }
    ts.forEachChild(node, visitWorkerCalls);
  }
  visitWorkerCalls(saveFunction);
  assert.equal(workerCalls.length, 1);
  const [operation, payload] = workerCalls[0];
  assert.equal(operation.getText(source), '"draft.priorities"');
  assert.deepEqual(
    payload.properties.map((property) => property.name.getText(source)),
    ["draftId", "priorities"],
  );
  const result = buildAutomaticPickUpdate({
    participants: [
      { userId: "player-2", picks: [] },
      { userId: "player-1", picks: [], priorities: ["team-a"] },
    ],
    pickOrder: [1],
    currentPickIndex: 0,
    availableItemIds: ["team-a", "team-b"],
    draftItems: teams,
    history: [],
    playerPriorities: { "player-1": ["team-b"] },
  });
  assert.equal(result.history[0].itemId, "team-b");
  assert.deepEqual(result.participants.map((participant) => participant.userId), ["player-2", "player-1"]);
  console.log("✓ Priority writes do not replace participants, and saved priorities override legacy data");
}

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
  const fixtures = [
    { teamCount: 14, participantCount: 3 },
    { teamCount: 30, participantCount: 4 },
    { teamCount: 32, participantCount: 5 },
  ];

  for (const { teamCount, participantCount } of fixtures) {
    const items = Array.from({ length: teamCount }, (_, index) => ({
      id: `team-${index + 1}`,
      name: `Team ${index + 1}`,
    }));
    const pickOrder = buildSnakeOrder(participantCount, teamCount);
    const participants = Array.from({ length: participantCount }, (_, index) => ({
      userId: `player-${index + 1}`,
      name: `Player ${index + 1}`,
      picks: [],
    }));
    let draft = draftFixture({
      participants,
      pickOrder,
      currentPickIndex: 0,
      availableItemIds: items.map((item) => item.id),
      draftItems: items,
      history: [],
      teamRanking: items.map((item) => item.id),
      playerPriorities: {},
    });

    for (let index = 0; index < teamCount; index += 1) {
      const update = buildAutomaticPickUpdate(draft);
      assert.ok(update);
      assert.equal(update.history.at(-1)?.participantIndex, pickOrder[index]);
      assert.equal(update.status, index === teamCount - 1 ? "completed" : "drafting");
      draft = { ...draft, ...update };
    }

    assert.equal(draft.currentPickIndex, teamCount);
    assert.deepEqual(draft.availableItemIds, []);
    assert.equal(draft.history.length, teamCount);
    assert.equal(new Set(draft.history.map((entry) => entry.itemId)).size, teamCount);
    assert.equal(
      getDraftStatusAfterPick(items.slice(1).map((item) => item.id)),
      "drafting",
    );
    let remainingItems = items.map((item) => item.id);
    for (let index = 0; index < teamCount; index += 1) {
      remainingItems = remainingItems.slice(1);
      assert.equal(
        getDraftStatusAfterPick(remainingItems),
        index === teamCount - 1 ? "completed" : "drafting",
      );
    }
  }

  assert.deepEqual(buildSnakeOrder(3, 8), [0, 1, 2, 2, 1, 0, 0, 1]);
  const shortOrder = buildSnakeOrder(3, 14);
  const extendedOrder = buildSnakeOrder(3, 15);
  assert.deepEqual(extendedOrder.slice(0, shortOrder.length), shortOrder);
  assert.equal(extendedOrder.at(-1), 2);
  const afterSkippedPick = extendSnakeOrderForSkippedPick(shortOrder, 3, 13, 1);
  assert.deepEqual(afterSkippedPick, extendedOrder);
  assert.equal(
    extendSnakeOrderForSkippedPick(shortOrder, 3, 0, 14).length,
    15,
  );
  console.log("✓ Drafts with 14, 30 and 32 teams keep snake order and finish on the actual last team");
}

{
  const previousTurnKey = getTurnKey("draft-1", 0, 1000);
  const nextTurnKey = getTurnKey("draft-1", 1, 2000);
  const previousTurnCountdown = { turnKey: previousTurnKey, seconds: 0 };
  assert.equal(getTimeLeftForTurn(previousTurnCountdown, nextTurnKey), null);
  assert.equal(getTimeLeftForTurn(previousTurnCountdown, previousTurnKey), 0);
  assert.equal(
    getTimeLeftForTurn({ turnKey: nextTurnKey, seconds: 30 }, nextTurnKey),
    30,
  );
  console.log("✓ An expired countdown cannot trigger the next turn and its timer restarts");
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
  const update = buildAutomaticPickUpdate(
    draftFixture({
      participants: [
        { name: "Unregistered player", picks: [] },
        { userId: "linked-player", name: "Linked player", picks: [] },
        { userId: "linked-player", name: "Linked player", picks: [] },
      ],
      pickOrder: [0, 1, 2],
      playerPriorities: { "linked-player": ["team-b", "team-a"] },
      availableItemIds: ["team-a", "team-b", "team-c"],
    }),
  );
  assert.equal(update?.history.at(-1)?.itemId, "team-c");
  assert.equal(update?.history.at(-1)?.autoPickReason, "organizer-ranking");

  const linkedUpdate = buildAutomaticPickUpdate(
    draftFixture({
      participants: [
        { name: "Unregistered player", picks: [] },
        { userId: "linked-player", name: "Linked player", picks: [] },
        { userId: "linked-player", name: "Linked player", picks: [] },
      ],
      pickOrder: [0, 1, 2],
      currentPickIndex: 1,
      playerPriorities: { "linked-player": ["team-b", "team-a"] },
      availableItemIds: ["team-a", "team-b", "team-c"],
    }),
  );
  assert.equal(linkedUpdate?.history.at(-1)?.itemId, "team-b");
  assert.equal(linkedUpdate?.history.at(-1)?.autoPickReason, "player-priorities");
  console.log("✓ Unclaimed prepared positions use organizer ranking; linked multi-seat players use their saved priorities");
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
