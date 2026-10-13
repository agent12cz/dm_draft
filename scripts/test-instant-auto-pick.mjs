import assert from "node:assert/strict";

import {
  FirebaseAuthError,
  resetFirebaseSigningKeyCache,
  verifyFirebaseIdToken,
} from "../workers/firebaseAuth.ts";
import { runExpiredDraftPicks, runImmediateDraftPick } from "../workers/firestore.ts";
import { consumeRateLimit, resetRateLimits } from "../workers/rateLimit.ts";

const PROJECT_ID = "dm-draft-c9a3d";
const DOCUMENT_NAME = `projects/${PROJECT_ID}/databases/(default)/documents/drafts/ABCDE`;

const signingKeyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

const serviceAccountKeyBytes = new Uint8Array(
  await crypto.subtle.exportKey("pkcs8", signingKeyPair.privateKey),
);
const serviceAccountPem = [
  "-----BEGIN PRIVATE KEY-----",
  btoa(Array.from(serviceAccountKeyBytes, (byte) => String.fromCharCode(byte)).join("")).match(
    /.{1,64}/g,
  ).join("\n"),
  "-----END PRIVATE KEY-----",
].join("\n");

const workerEnv = {
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    project_id: PROJECT_ID,
    client_email: `cron@${PROJECT_ID}.iam.gserviceaccount.com`,
    private_key: serviceAccountPem,
  }),
};

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

function expiredDraftFixture(overrides = {}) {
  return {
    status: "drafting",
    participants: [
      { id: "participant-1", userId: "player-1", name: "Player 1", picks: [] },
      { id: "participant-2", userId: "player-2", name: "Player 2", picks: [] },
    ],
    currentPickIndex: 0,
    pickOrder: [0, 1],
    availableItemIds: ["team-a", "team-b"],
    draftItems: [
      { id: "team-a", name: "Team A" },
      { id: "team-b", name: "Team B" },
    ],
    teamRanking: ["team-b", "team-a"],
    playerPriorities: {},
    history: [],
    turnDurationSeconds: 30,
    turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function lastTeamDraftFixture() {
  const draftItems = Array.from({ length: 32 }, (_, index) => ({
    id: `team-${index + 1}`,
    name: `Team ${index + 1}`,
  }));

  return {
    status: "drafting",
    participants: [
      { id: "participant-1", userId: "player-1", name: "Player 1", picks: [] },
      { id: "participant-2", userId: "player-2", name: "Player 2", picks: [] },
    ],
    currentPickIndex: 31,
    pickOrder: Array.from({ length: 32 }, (_, index) => index % 2),
    availableItemIds: ["team-32"],
    draftItems,
    teamRanking: draftItems.map((item) => item.id),
    playerPriorities: {},
    history: [],
    turnDurationSeconds: 30,
    turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

/**
 * Models Firestore read-write transactions: a commit only succeeds when the draft
 * has not changed since the transactional read, otherwise it aborts with HTTP 409.
 */
function createFirestoreMock(initialDraft) {
  let current = { ...initialDraft };
  const transactionReads = new Map();
  const appliedCommits = [];
  let transactionCount = 0;
  let commitAttempts = 0;
  let callCount = 0;

  function isExpired() {
    const startedAt = Date.parse(current.turnStartedAt ?? "");
    return (
      current.status === "drafting" &&
      Number.isFinite(startedAt) &&
      startedAt + Number(current.turnDurationSeconds) * 1000 <= Date.now()
    );
  }

  const fetchMock = async (input, init = {}) => {
    const url = String(input);
    callCount += 1;

    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
    }

    if (url.endsWith(":beginTransaction")) {
      transactionCount += 1;
      return Response.json({ transaction: `transaction-${transactionCount}` });
    }

    if (url.endsWith(":rollback")) {
      return Response.json({});
    }

    if (url.endsWith(":runQuery")) {
      return Response.json(
        isExpired() ? [{ document: { name: DOCUMENT_NAME, fields: firestoreFields(current) } }] : [],
      );
    }

    if (url.endsWith(":commit")) {
      commitAttempts += 1;
      const body = JSON.parse(init.body);
      if (transactionReads.get(body.transaction) !== current.currentPickIndex) {
        return new Response("aborted", { status: 409 });
      }

      const write = body.writes[0];
      current = {
        ...current,
        ...Object.fromEntries(
          Object.entries(write.update.fields).map(([key, value]) => [key, decode(value)]),
        ),
      };

      const transforms = write.updateTransforms ?? [];
      if (transforms.some((transform) => transform.fieldPath === "turnStartedAt")) {
        current.turnStartedAt = new Date().toISOString();
      } else if ((write.updateMask?.fieldPaths ?? []).includes("turnStartedAt")) {
        delete current.turnStartedAt;
      }

      appliedCommits.push(write);
      return Response.json({ writeResults: [] });
    }

    if (url.includes("/documents/drafts/")) {
      const transaction = new URL(url).searchParams.get("transaction");
      if (transaction) {
        transactionReads.set(transaction, current.currentPickIndex);
      }
      return Response.json({ name: DOCUMENT_NAME, fields: firestoreFields(current) });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  return {
    fetchMock,
    getDraft: () => current,
    getCommits: () => appliedCommits,
    getCommitAttempts: () => commitAttempts,
    getCallCount: () => callCount,
  };
}

console.log("Running instant automatic pick tests...");

{
  const mock = createFirestoreMock(expiredDraftFixture());
  const result = await runImmediateDraftPick(
    workerEnv,
    { draftId: "ABCDE", userId: "player-2", expectedPickIndex: 0 },
    mock.fetchMock,
  );

  assert.equal(result.status, "picked");
  assert.equal(result.completed, false);
  assert.equal(mock.getCommits().length, 1);
  assert.equal(mock.getDraft().currentPickIndex, 1);
  assert.equal(mock.getDraft().history.at(-1).automatic, true);
  assert.equal(mock.getDraft().history.at(-1).itemId, "team-b");
  console.log("✓ Čas vyprší mezi spuštěními Cronu a výběr proběhne okamžitě");
}

{
  const mock = createFirestoreMock(expiredDraftFixture());
  const [first, second] = await Promise.all([
    runImmediateDraftPick(
      workerEnv,
      { draftId: "ABCDE", userId: "player-1", expectedPickIndex: 0 },
      mock.fetchMock,
    ),
    runImmediateDraftPick(
      workerEnv,
      { draftId: "ABCDE", userId: "player-2", expectedPickIndex: 0 },
      mock.fetchMock,
    ),
  ]);

  const outcomes = [first.status, second.status].sort();
  assert.deepEqual(outcomes, ["changed", "picked"]);
  assert.equal(mock.getCommits().length, 1);
  assert.equal(mock.getDraft().currentPickIndex, 1);
  assert.equal(mock.getDraft().history.length, 1);
  console.log("✓ Dva účastníci se stejným draftem vyvolají pouze jeden výběr");
}

{
  const mock = createFirestoreMock(expiredDraftFixture());
  const [cronSummary, immediate] = await Promise.all([
    runExpiredDraftPicks(workerEnv, mock.fetchMock),
    runImmediateDraftPick(
      workerEnv,
      { draftId: "ABCDE", userId: "player-2", expectedPickIndex: 0 },
      mock.fetchMock,
    ),
  ]);

  assert.equal(mock.getCommits().length, 1);
  assert.equal(mock.getDraft().currentPickIndex, 1);
  assert.equal(mock.getDraft().history.length, 1);
  assert.equal(cronSummary.picked + (immediate.status === "picked" ? 1 : 0), 1);
  console.log("✓ Cron a okamžitý požadavek současně provedou jen jeden výběr");
}

{
  const manuallyPicked = expiredDraftFixture({
    currentPickIndex: 1,
    availableItemIds: ["team-b"],
    turnStartedAt: new Date().toISOString(),
    history: [{ type: "pick", participantIndex: 0, itemId: "team-a", itemName: "Team A" }],
  });
  const mock = createFirestoreMock(manuallyPicked);
  const result = await runImmediateDraftPick(
    workerEnv,
    { draftId: "ABCDE", userId: "player-1", expectedPickIndex: 0 },
    mock.fetchMock,
  );

  assert.equal(result.status, "changed");
  assert.equal(mock.getCommits().length, 0);
  assert.equal(mock.getDraft().history.length, 1);
  console.log("✓ Ruční výběr těsně před vypršením času nepřepíše automatický výběr");
}

{
  const mock = createFirestoreMock(expiredDraftFixture());
  const first = await runImmediateDraftPick(
    workerEnv,
    { draftId: "ABCDE", userId: "player-1", expectedPickIndex: 0 },
    mock.fetchMock,
  );
  const afterReload = await runImmediateDraftPick(
    workerEnv,
    { draftId: "ABCDE", userId: "player-1", expectedPickIndex: 0 },
    mock.fetchMock,
  );

  assert.equal(first.status, "picked");
  assert.equal(afterReload.status, "changed");
  assert.equal(mock.getCommits().length, 1);
  assert.equal(mock.getDraft().history.length, 1);
  console.log("✓ Obnovení stránky během automatického výběru nevyvolá druhý výběr");
}

{
  const mock = createFirestoreMock(lastTeamDraftFixture());
  const result = await runImmediateDraftPick(
    workerEnv,
    { draftId: "ABCDE", userId: "player-1", expectedPickIndex: 31 },
    mock.fetchMock,
  );

  const write = mock.getCommits()[0];
  assert.equal(result.status, "picked");
  assert.equal(result.completed, true);
  assert.equal(decode(write.update.fields.status), "completed");
  assert.equal(write.updateMask.fieldPaths.includes("turnStartedAt"), true);
  assert.equal(
    write.updateTransforms.some((transform) => transform.fieldPath === "turnStartedAt"),
    false,
  );
  assert.equal(mock.getDraft().status, "completed");
  assert.equal(mock.getDraft().turnStartedAt, undefined);

  const cronSummary = await runExpiredDraftPicks(workerEnv, mock.fetchMock);
  const afterCompletion = await runImmediateDraftPick(
    workerEnv,
    { draftId: "ABCDE", userId: "player-1", expectedPickIndex: 31 },
    mock.fetchMock,
  );

  assert.equal(cronSummary.candidates, 0);
  assert.equal(afterCompletion.status, "changed");
  assert.equal(mock.getCommits().length, 1);
  console.log("✓ Poslední 32. tým ukončí draft bez dalšího odpočtu a autopicku");
}

{
  const mock = createFirestoreMock(expiredDraftFixture());
  const summary = await runExpiredDraftPicks(workerEnv, mock.fetchMock);

  assert.equal(summary.picked, 1);
  assert.equal(mock.getCommits().length, 1);
  assert.equal(mock.getDraft().currentPickIndex, 1);
  console.log("✓ Bez otevřené aplikace provede výběr záložní Cron");
}

{
  const mock = createFirestoreMock(expiredDraftFixture());
  const result = await runImmediateDraftPick(
    workerEnv,
    { draftId: "ABCDE", userId: "outsider", expectedPickIndex: 0 },
    mock.fetchMock,
  );

  assert.equal(result.status, "forbidden");
  assert.equal(mock.getCommits().length, 0);
  console.log("✓ Uživatel mimo draft nemůže vyvolat automatický výběr");
}

{
  const mock = createFirestoreMock(expiredDraftFixture());
  const result = await runImmediateDraftPick(
    workerEnv,
    { draftId: "../../../other", userId: "player-1" },
    mock.fetchMock,
  );

  assert.equal(result.status, "invalid");
  assert.equal(mock.getCallCount(), 0);
  console.log("✓ Neplatný identifikátor draftu je odmítnut bez dotazu na Firestore");
}

{
  const notExpired = expiredDraftFixture({ turnStartedAt: new Date().toISOString() });
  const mock = createFirestoreMock(notExpired);
  const result = await runImmediateDraftPick(
    workerEnv,
    { draftId: "ABCDE", userId: "player-1", expectedPickIndex: 0 },
    mock.fetchMock,
  );

  assert.equal(result.status, "not-expired");
  assert.equal(mock.getCommits().length, 0);
  console.log("✓ Dosud nevypršený tah server nevybere ani na žádost klienta");
}

const publicJwk = await crypto.subtle.exportKey("jwk", signingKeyPair.publicKey);

function jwksMock({ kid = "test-kid" } = {}) {
  return async () =>
    Response.json(
      { keys: [{ kid, kty: "RSA", alg: "RS256", use: "sig", n: publicJwk.n, e: publicJwk.e }] },
      { headers: { "cache-control": "public, max-age=3600" } },
    );
}

function base64UrlText(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createIdToken(claims = {}, header = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const encodedHeader = base64UrlText(
    JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT", ...header }),
  );
  const encodedPayload = base64UrlText(
    JSON.stringify({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: "player-1",
      iat: nowSeconds - 10,
      exp: nowSeconds + 3600,
      auth_time: nowSeconds - 10,
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKeyPair.privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  const encodedSignature = btoa(
    Array.from(new Uint8Array(signature), (byte) => String.fromCharCode(byte)).join(""),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

{
  resetFirebaseSigningKeyCache();
  const token = await createIdToken();
  const verified = await verifyFirebaseIdToken(token, PROJECT_ID, jwksMock());
  assert.equal(verified.uid, "player-1");
  console.log("✓ Platný Firebase ID token je ověřen proti Google JWKS");
}

{
  resetFirebaseSigningKeyCache();
  const token = await createIdToken({ aud: "other-project" });
  await assert.rejects(
    () => verifyFirebaseIdToken(token, PROJECT_ID, jwksMock()),
    FirebaseAuthError,
  );
  console.log("✓ Token vydaný pro jiný projekt je odmítnut");
}

{
  resetFirebaseSigningKeyCache();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await createIdToken({ iat: nowSeconds - 7200, exp: nowSeconds - 3600 });
  await assert.rejects(
    () => verifyFirebaseIdToken(token, PROJECT_ID, jwksMock()),
    FirebaseAuthError,
  );
  console.log("✓ Expirovaný token je odmítnut");
}

{
  resetFirebaseSigningKeyCache();
  const token = await createIdToken();
  const tampered = `${token.slice(0, -4)}AAAA`;
  await assert.rejects(
    () => verifyFirebaseIdToken(tampered, PROJECT_ID, jwksMock()),
    FirebaseAuthError,
  );
  console.log("✓ Token s pozměněným podpisem je odmítnut");
}

{
  resetFirebaseSigningKeyCache();
  const token = await createIdToken({}, { alg: "none" });
  await assert.rejects(
    () => verifyFirebaseIdToken(token, PROJECT_ID, jwksMock()),
    FirebaseAuthError,
  );
  console.log("✓ Token bez podpisového algoritmu RS256 je odmítnut");
}

{
  resetFirebaseSigningKeyCache();
  const token = await createIdToken();
  await assert.rejects(
    () => verifyFirebaseIdToken(token, PROJECT_ID, jwksMock({ kid: "other-kid" })),
    FirebaseAuthError,
  );
  console.log("✓ Token podepsaný neznámým klíčem je odmítnut");
}

{
  resetRateLimits();
  const start = Date.now();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.equal(consumeRateLimit("auto-pick:player-1", 12, 10_000, start), true);
  }

  assert.equal(consumeRateLimit("auto-pick:player-1", 12, 10_000, start), false);
  assert.equal(consumeRateLimit("auto-pick:player-2", 12, 10_000, start), true);
  assert.equal(consumeRateLimit("auto-pick:player-1", 12, 10_000, start + 10_001), true);
  console.log("✓ Nadměrné volání endpointu je omezeno pro konkrétního uživatele");
}

console.log("\nALL INSTANT AUTOMATIC PICK TESTS PASSED SUCCESSFULLY!");
