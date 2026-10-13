import assert from "node:assert/strict";
import { runExpiredDraftPicks } from "../workers/firestore.ts";

const { privateKey } = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
const privateKeyBase64 = btoa(
  Array.from(privateKeyBytes, (byte) => String.fromCharCode(byte)).join(""),
);
const testPrivateKey = [
  "-----BEGIN PRIVATE KEY-----",
  privateKeyBase64.match(/.{1,64}/g).join("\n"),
  "-----END PRIVATE KEY-----",
].join("\n");

function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return {
    mapValue: {
      fields: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)])),
    },
  };
}

function decode(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("arrayValue" in value) return value.arrayValue.values?.map(decode) ?? [];
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields ?? {}).map(([key, entry]) => [key, decode(entry)]),
    );
  }
  if ("timestampValue" in value) return value.timestampValue;
  return null;
}

function firestoreFields(draft) {
  return Object.fromEntries(
    Object.entries(draft).map(([key, value]) => [
      key,
      key === "turnStartedAt" ? { timestampValue: value } : encode(value),
    ]),
  );
}

function workerFixture({ priorities, availableItemIds = ["team-a", "team-b"], lastPick = false } = {}) {
  const now = Date.now();
  const draft = {
    status: "drafting",
    participants: [
      { id: "participant-1", userId: "player-1", name: "Player 1", picks: [] },
      { id: "participant-2", userId: "player-2", name: "Player 2", picks: [] },
    ],
    currentPickIndex: lastPick ? 0 : 0,
    pickOrder: lastPick ? [0] : [0, 1],
    availableItemIds,
    draftItems: [
      { id: "team-a", name: "Team A" },
      { id: "team-b", name: "Team B" },
    ],
    teamRanking: ["team-b", "team-a"],
    playerPriorities: priorities ? { "player-1": priorities } : {},
    history: [],
    turnDurationSeconds: 30,
    turnStartedAt: new Date(now - 60_000).toISOString(),
  };
  const documentName = "projects/dm-draft-c9a3d/databases/(default)/documents/drafts/ABCDE";

  return { draft, documentName, now };
}

function mockFetch({ draft, documentName, abortFirstCommit = false }) {
  let latestDraft = draft;
  let commitAttempts = 0;
  let transactionCount = 0;
  const calls = [];

  const fetchMock = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(init.body);
      const assertion = form.get("assertion");
      assert.ok(assertion);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const claims = JSON.parse(
        atob(assertion.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      assert.equal(claims.iss.startsWith("cron-test-"), true);
      assert.equal(claims.scope, "https://www.googleapis.com/auth/datastore");
      return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
    }

    if (url.endsWith(":runQuery")) {
      const body = JSON.parse(init.body);
      assert.equal(body.structuredQuery.limit, undefined);
      assert.equal(
        body.structuredQuery.where.compositeFilter.filters[0].fieldFilter.field.fieldPath,
        "status",
      );
      assert.equal(
        body.structuredQuery.where.compositeFilter.filters[1].fieldFilter.field.fieldPath,
        "turnDurationSeconds",
      );
      assert.equal(
        body.structuredQuery.where.compositeFilter.filters[2].fieldFilter.field.fieldPath,
        "turnStartedAt",
      );
      return Response.json([
        {
          document: {
            name: documentName,
            fields: {
              turnDurationSeconds: encode(latestDraft.turnDurationSeconds),
              turnStartedAt: { timestampValue: latestDraft.turnStartedAt },
            },
          },
        },
      ]);
    }

    if (url.endsWith(":beginTransaction")) {
      transactionCount += 1;
      return Response.json({ transaction: `transaction-${transactionCount}` });
    }

    if (url.startsWith("https://firestore.googleapis.com/v1/") && url.includes("?transaction=")) {
      return Response.json({
        name: documentName,
        fields: firestoreFields(latestDraft),
      });
    }

    if (url.endsWith(":commit")) {
      commitAttempts += 1;
      if (abortFirstCommit && commitAttempts === 1) {
        latestDraft = {
          ...latestDraft,
          participants: [
            { ...latestDraft.participants[0], picks: ["team-a"] },
            latestDraft.participants[1],
          ],
          currentPickIndex: 1,
          availableItemIds: latestDraft.availableItemIds.filter((teamId) => teamId !== "team-a"),
          turnStartedAt: new Date().toISOString(),
          history: [{ type: "pick", participantIndex: 0, itemId: "team-a", itemName: "Team A" }],
        };
        return Response.json(
          { error: { status: "ABORTED", message: "Transaction conflict" } },
          { status: 409 },
        );
      }
      return Response.json({ writeResults: [{}] });
    }

    if (url.endsWith(":rollback")) {
      return Response.json({});
    }

    throw new Error(`Unexpected mocked Firestore URL: ${url}`);
  };

  return {
    fetchMock,
    getCommitAttempts: () => commitAttempts,
    getCalls: () => calls,
  };
}

async function runCase(options) {
  const { draft, documentName } = workerFixture(options);
  const mock = mockFetch({ draft, documentName });
  const env = {
    FIREBASE_PROJECT_ID: "dm-draft-c9a3d",
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: "dm-draft-c9a3d",
      client_email: `cron-test-${Math.random()}@dm-draft-c9a3d.iam.gserviceaccount.com`,
      private_key: testPrivateKey,
    }),
  };
  const summary = await runExpiredDraftPicks(env, mock.fetchMock);
  const commitCall = mock.getCalls().find(({ url }) => url.endsWith(":commit"));
  const commitBody = commitCall ? JSON.parse(commitCall.init.body) : null;
  return { summary, commitBody, mock };
}

{
  const { summary, commitBody } = await runCase({ priorities: ["team-a", "team-b"] });
  const write = commitBody.writes[0];
  const latestHistory = decode(write.update.fields.history).at(-1);
  assert.equal(summary.picked, 1);
  assert.equal(latestHistory.itemId, "team-a");
  assert.equal(latestHistory.autoPickReason, "player-priorities");
  assert.equal(latestHistory.automatic, true);
  assert.equal(commitBody.transaction, "transaction-1");
  console.log("✓ Worker authenticates to Firestore and atomically commits a player-priority pick");
}

{
  const { summary, commitBody } = await runCase({});
  const latestHistory = decode(commitBody.writes[0].update.fields.history).at(-1);
  assert.equal(latestHistory.itemId, "team-b");
  assert.equal(latestHistory.autoPickReason, "organizer-ranking");
  assert.equal(summary.picked, 1);
  console.log("✓ Worker uses the organizer ranking when the player has no saved priorities");
}

{
  const { summary, commitBody } = await runCase({ priorities: ["team-a"], availableItemIds: ["team-b"] });
  const latestHistory = decode(commitBody.writes[0].update.fields.history).at(-1);
  assert.equal(latestHistory.itemId, "team-b");
  assert.equal(latestHistory.autoPickReason, "organizer-ranking");
  assert.equal(summary.picked, 1);
  console.log("✓ Worker falls back to the organizer ranking when player priorities are unavailable");
}

{
  const { summary, commitBody } = await runCase({
    lastPick: true,
    availableItemIds: ["team-b"],
  });
  const write = commitBody.writes[0];
  assert.equal(decode(write.update.fields.status), "completed");
  assert.equal(summary.picked, 1);
  assert.equal(write.updateMask.fieldPaths.includes("turnStartedAt"), true);
  assert.equal(write.updateTransforms.some((transform) => transform.fieldPath === "turnStartedAt"), false);
  console.log("✓ Worker completes the last pick and removes the turn timer");
}

{
  const { draft, documentName } = workerFixture({});
  const mock = mockFetch({ draft, documentName, abortFirstCommit: true });
  const env = {
    FIREBASE_PROJECT_ID: "dm-draft-c9a3d",
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: "dm-draft-c9a3d",
      client_email: `cron-test-${Math.random()}@dm-draft-c9a3d.iam.gserviceaccount.com`,
      private_key: testPrivateKey,
    }),
  };
  const summary = await runExpiredDraftPicks(env, mock.fetchMock);
  assert.equal(summary.picked, 0);
  assert.equal(mock.getCommitAttempts(), 1);
  console.log("✓ An aborted transaction does not duplicate a pick made concurrently by a player");
}

console.log("\nALL CLOUDFLARE WORKER/FIRESTORE TESTS PASSED SUCCESSFULLY!");
