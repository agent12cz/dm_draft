import assert from "node:assert/strict";
import {
  executeFirestoreSecurityOperation,
  runImmediateDraftPick,
  runExpiredDraftPicks,
  runLegacyDraftPrivacyMigration,
} from "../workers/firestore.ts";

const PROJECT_ID = "dm-draft-security-test";
const serviceAccount = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const privateKeyBytes = new Uint8Array(
  await crypto.subtle.exportKey("pkcs8", serviceAccount.privateKey),
);
const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  btoa(Array.from(privateKeyBytes, (byte) => String.fromCharCode(byte)).join(""))
    .match(/.{1,64}/g)
    .join("\n"),
  "-----END PRIVATE KEY-----",
].join("\n");
const env = {
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    project_id: PROJECT_ID,
    client_email: "security-test@dm-draft-security-test.iam.gserviceaccount.com",
    private_key: privateKey,
  }),
};

function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (typeof value === "object" && value.__firestoreTimestamp === true) {
    return { timestampValue: value.value };
  }
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, encode(entry)]),
        ),
      },
    };
  }
  throw new Error(`Unsupported test value: ${typeof value}`);
}

function decode(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) {
    return { __firestoreTimestamp: true, value: value.timestampValue };
  }
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decode);
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields ?? {}).map(([key, entry]) => [key, decode(entry)]),
    );
  }
  return undefined;
}

function documentFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, encode(value)]));
}

function resourcePath(url) {
  const marker = "/documents/";
  const start = url.pathname.indexOf(marker);
  if (start < 0) throw new Error(`Unexpected Firestore URL: ${url}`);
  return url.pathname
    .slice(start + marker.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

function createFirestoreMock(initial = {}) {
  let version = 0;
  let updateSequence = 0;
  const documents = new Map(
    Object.entries(initial).map(([name, fields]) => [
      name,
      {
        name: `projects/${PROJECT_ID}/databases/(default)/documents/${name}`,
        fields: documentFields(fields),
        updateTime: `update-${++updateSequence}`,
      },
    ]),
  );
  const transactions = new Map();
  let nextTransactionId = 0;
  const calls = [];
  let beforeNextCommit;

  function applyWrite(write) {
    if (write.delete) {
      const path = resourcePath(new URL(`https://firestore.googleapis.com/v1/${write.delete}`));
      const existing = documents.get(path);
      if (write.currentDocument?.updateTime && existing?.updateTime !== write.currentDocument.updateTime) {
        return false;
      }
      documents.delete(path);
      return;
    }

    const nameUrl = new URL(`https://firestore.googleapis.com/v1/${write.update.name}`);
    const path = resourcePath(nameUrl);
    const existing = documents.get(path);
    if (write.currentDocument?.exists === false && existing) return false;
    if (write.currentDocument?.updateTime && existing?.updateTime !== write.currentDocument.updateTime) {
      return false;
    }
    const target = existing ?? {
      name: write.update.name,
      fields: {},
    };
    for (const fieldPath of write.updateMask?.fieldPaths ?? Object.keys(write.update.fields ?? {})) {
      if (fieldPath in (write.update.fields ?? {})) {
        target.fields[fieldPath] = write.update.fields[fieldPath];
      } else {
        delete target.fields[fieldPath];
      }
    }
    for (const transform of write.updateTransforms ?? []) {
      if (transform.setToServerValue === "REQUEST_TIME") {
        target.fields[transform.fieldPath] = { timestampValue: new Date().toISOString() };
      }
    }
    target.updateTime = `update-${++updateSequence}`;
    documents.set(path, target);
    return true;
  }

  const fetchMock = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), init });
    if (url.href === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      return Response.json({ access_token: "mock-access-token", expires_in: 3600 });
    }

    if (url.pathname.endsWith(":beginTransaction")) {
      const id = `tx-${++nextTransactionId}`;
      transactions.set(id, { version, documents: structuredClone(documents) });
      return Response.json({ transaction: id });
    }

    if (url.pathname.endsWith(":rollback")) return Response.json({});

    if (url.pathname.endsWith(":commit")) {
      const body = JSON.parse(init.body);
      if (beforeNextCommit) {
        const callback = beforeNextCommit;
        beforeNextCommit = undefined;
        await callback();
      }
      const transaction = body.transaction ? transactions.get(body.transaction) : null;
      if (transaction && transaction.version !== version) {
        return Response.json({ error: { status: "ABORTED" } }, { status: 409 });
      }
      for (const write of body.writes ?? []) {
        if (applyWrite(write) === false) {
          return Response.json({ error: { status: "ALREADY_EXISTS" } }, { status: 409 });
        }
      }
      version += 1;
      return Response.json({ writeResults: [{}] });
    }

    if (url.pathname.endsWith(":runQuery")) {
      const query = JSON.parse(init.body).structuredQuery;
      if (query.from[0].collectionId === "users") {
        assert.equal(query.where.compositeFilter.op, "AND");
        const filters = query.where.compositeFilter.filters;
        assert.equal(new Set(filters.map((filter) => filter.fieldFilter.field.fieldPath)).size, 1);
        assert.equal(query.limit, 20);
        assert.deepEqual(query.select.fields, [{ fieldPath: "displayName" }, { fieldPath: "email" }]);
        const results = [...documents.entries()]
          .filter(([name]) => name.startsWith("users/"))
          .map(([name, document]) => ({
            document: {
              name: `projects/${PROJECT_ID}/databases/(default)/documents/${name}`,
              fields: document.fields,
            },
          }))
          .filter(({ document }) => {
            const fields = Object.fromEntries(
              Object.entries(document.fields).map(([key, value]) => [key, decode(value)]),
            );
            return filters.every((filter) => {
              const { fieldPath } = filter.fieldFilter.field;
              const value = String(fields[fieldPath] ?? "");
              const boundary = filter.fieldFilter.value.stringValue;
              return filter.fieldFilter.op === "GREATER_THAN_OR_EQUAL"
                ? value >= boundary
                : value <= boundary;
            });
          })
          .slice(0, query.limit);
        return Response.json(results);
      }
      if (query.from[0].collectionId === "publicDrafts") {
        return Response.json([...documents.entries()]
          .filter(([path, document]) => {
            if (!path.startsWith("publicDrafts/") || path.split("/").length !== 2) return false;
            const fields = Object.fromEntries(Object.entries(document.fields).map(([key, value]) => [key, decode(value)]));
            return fields.status === "drafting" && Number(fields.turnDurationSeconds) > 0 &&
              Date.parse(fields.turnStartedAt?.value ?? "") + fields.turnDurationSeconds * 1000 <= Date.now();
          })
          .map(([, document]) => ({ document: structuredClone(document) })));
      }
      return Response.json([]);
    }

    if (url.searchParams.has("pageSize")) {
      const collection = resourcePath(url);
      const prefix = `${collection}/`;
      const documentsInCollection = [...documents.entries()]
        .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
        .map(([, document]) => structuredClone(document));
      return Response.json({ documents: documentsInCollection });
    }

    if (init.method === "POST") {
      throw new Error(`Unexpected POST request: ${url}`);
    }

    const path = resourcePath(url);
    const transaction = url.searchParams.get("transaction");
    const source = transaction
      ? transactions.get(transaction)?.documents
      : documents;
    const document = source?.get(path);
    if (!document) return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
    return Response.json(structuredClone(document));
  };

  return {
    fetchMock,
    documents,
    calls,
    get version() { return version; },
    beforeNextCommit(callback) { beforeNextCommit = callback; },
    read(path) {
      const document = documents.get(path);
      if (!document) return null;
      return Object.fromEntries(
        Object.entries(document.fields).map(([key, value]) => [key, decode(value)]),
      );
    },
    seed(path, fields) {
      documents.set(path, {
        name: `projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
        fields: documentFields(fields),
        updateTime: `update-${++updateSequence}`,
      });
      version += 1;
    },
  };
}

const firestore = createFirestoreMock({
  "users/owner": {
    uid: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    role: "participant",
  },
  "users/player-1": {
    uid: "player-1",
    email: "player1@example.test",
    displayName: "Player One",
    role: "participant",
  },
  "users/player-2": {
    uid: "player-2",
    email: "player2@example.test",
    displayName: "Player Two",
    role: "participant",
  },
  "users/stranger": {
    uid: "stranger",
    email: "stranger@example.test",
    displayName: "Stranger",
    role: "participant",
  },
  "users/global-admin": {
    uid: "global-admin",
    email: "admin@example.test",
    displayName: "Global Admin",
    role: "admin",
  },
});

async function operation(actorId, name, payload = {}) {
  const profile = firestore.read(`users/${actorId}`);
  return executeFirestoreSecurityOperation(
    env,
    { uid: actorId, email: profile?.email },
    { operation: name, ...payload },
    firestore.fetchMock,
  );
}

await operation("owner", "draft.create", {
  draftId: "ROOM1",
  data: {
    ownerUserId: "forged-owner",
    title: "Test draft",
    status: "waiting",
    participantCount: 2,
    participants: [
      {
        id: "p1",
        name: "Player One",
        userId: "player-1",
        uid: "player-1",
        email: "forged@example.test",
        participantPin: "123456",
        picks: [],
        status: "ready",
      },
      {
        id: "p2",
        name: "Player Two",
        userId: "player-2",
        email: "player2@example.test",
        participantPin: "654321",
        picks: [],
        status: "ready",
      },
    ],
    playerPriorities: { "player-1": ["team-a"] },
  },
});

const publicDraft = firestore.read("publicDrafts/ROOM1");
const privateDraft = firestore.read("draftPrivate/ROOM1");
assert.equal(publicDraft.ownerUserId, undefined);
assert.equal(publicDraft.playerPriorities, undefined);
assert.equal(publicDraft.privacyVersion, 1);
assert.equal(publicDraft.participants[0].userId, undefined);
assert.equal(publicDraft.participants[0].email, undefined);
assert.equal(publicDraft.participants[0].participantPin, undefined);
assert.equal(privateDraft.ownerUserId, "owner");
assert.equal(privateDraft.participants[0].email, "player1@example.test");
console.log("✓ Draft creation stores ownership and participant credentials outside public documents");

const nameMatches = await operation("owner", "draft.search-users", {
  draftId: "ROOM1",
  prefix: "Player",
});
assert.deepEqual(nameMatches.users.map((user) => user.uid), ["player-1", "player-2"]);
const emailMatches = await operation("owner", "draft.search-users", {
  draftId: "ROOM1",
  prefix: "player2@",
});
assert.deepEqual(emailMatches.users.map((user) => user.uid), ["player-2"]);
await assert.rejects(
  operation("stranger", "draft.search-users", { draftId: "ROOM1", prefix: "Player" }),
  (error) => error.status === 403,
);
console.log("✓ Organizer user search applies bounded name/email prefix queries and requires ownership");

firestore.seed("users/dan", {
  userId: "dan",
  displayName: "Dan",
  email: "registered@example.test",
  role: "participant",
  secret: "must-not-leak",
});
const danSearch = await operation("owner", "draft.search-users", { draftId: "ROOM1", prefix: "da" });
assert.deepEqual(danSearch.users, [{ uid: "dan", displayName: "Dan" }]);
for (const prefix of ["DA", "Da", "da", "reg", "REGISTERED@"]) {
  assert.deepEqual((await operation("owner", "draft.search-users", { draftId: "ROOM1", prefix })).users,
    [{ uid: "dan", displayName: "Dan" }]);
}
firestore.seed("users/legacy-uid", { uid: "legacy-uid", displayName: "DANA", email: "legacy@example.test", role: "participant" });
firestore.seed("users/document-uid", { uid: "forged", userId: "forged", displayName: "Daniel", role: "admin", privateData: "hidden" });
const legacyMatches = await operation("owner", "draft.search-users", { draftId: "ROOM1", prefix: "da" });
assert.deepEqual(legacyMatches.users.map((candidate) => candidate.uid).sort(), ["dan", "document-uid", "legacy-uid"]);
assert.ok(legacyMatches.users.every((candidate) => Object.keys(candidate).sort().join(",") === "displayName,uid"));
firestore.seed("publicDrafts/SEARCH-ASSIGN", {
  title: "Assignment test", status: "waiting", participantCount: 1,
  participants: [{ id: "slot", name: "", picks: [] }],
});
firestore.seed("draftPrivate/SEARCH-ASSIGN", { ownerUserId: "owner", participants: [{}], playerPriorities: {} });
for (const actorId of ["stranger", "player-1", "dan"]) {
  const callsBefore = firestore.calls.length;
  await assert.rejects(
    operation(actorId, "draft.search-users", { draftId: "SEARCH-ASSIGN", prefix: "da" }),
    (error) => error.status === 403,
  );
  assert.equal(firestore.calls.slice(callsBefore).some((call) => call.url.endsWith(":runQuery")), false);
  await assert.rejects(
    operation(actorId, "draft.update", { draftId: "SEARCH-ASSIGN", updates: { participants: [{ id: "slot", userId: "dan" }] } }),
    (error) => error.status === 403,
  );
}
for (const uid of ["dan", "legacy-uid", "document-uid"]) {
  const candidate = legacyMatches.users.find((entry) => entry.uid === uid);
  await operation("owner", "draft.update", {
    draftId: "SEARCH-ASSIGN",
    updates: { participants: [{ id: "slot", name: candidate.displayName, userId: candidate.uid, uid: candidate.uid, email: "forged@example.test", picks: [] }] },
  });
  const assigned = await operation(uid, "draft.access", { draftId: "SEARCH-ASSIGN" });
  assert.equal(assigned.participantIndex, 0);
  assert.equal(assigned.participants[0].userId, uid);
  await operation(uid, "draft.priorities", { draftId: "SEARCH-ASSIGN", priorities: ["team-b", "team-a"] });
  assert.deepEqual(firestore.read("draftPrivate/SEARCH-ASSIGN").playerPriorities[uid], ["team-b", "team-a"]);
  assert.notEqual(firestore.read("draftPrivate/SEARCH-ASSIGN").participants[0].email, "forged@example.test");
}
await operation("owner", "draft.update", { draftId: "SEARCH-ASSIGN", updates: { status: "completed" } });
await assert.rejects(
  operation("owner", "draft.search-users", { draftId: "SEARCH-ASSIGN", prefix: "da" }),
  (error) => error.status === 403,
);
console.log("✓ Legacy uid/userId profiles and mixed-case prefixes are found with only UID/name returned");
console.log("✓ Only the organizer can search/assign before start; assigned players can save their own priorities");

let searchRequestCount = 0;
const brokenSearchRequest = async (input, init) => {
  if (String(input).endsWith(":runQuery")) {
    searchRequestCount++;
    return Response.json({ error: { status: "INVALID_ARGUMENT", message: "private-email@example.test private-token" } }, { status: 400 });
  }
  return firestore.fetchMock(input, init);
};
await assert.rejects(
  executeFirestoreSecurityOperation(
    env, { uid: "owner" }, { operation: "draft.search-users", draftId: "ROOM1", prefix: "da" }, brokenSearchRequest,
  ),
  (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.operation, "Firestore user search");
    assert.equal(error.reason, "INVALID_ARGUMENT");
    assert.doesNotMatch(error.message, /private-email|private-token/);
    return true;
  },
);
assert.ok(searchRequestCount > 0 && searchRequestCount <= 8);
console.log("✓ A rejected upstream query stays an explicit failure and its body never enters diagnostics");

firestore.seed("publicDrafts/PRIVATE-PICK", {
  status: "drafting",
  participants: [{ id: "slot", name: "Dan", picks: [] }],
  pickOrder: [0],
  currentPickIndex: 0,
  availableItemIds: ["team-a", "team-b"],
  draftItems: [{ id: "team-a", name: "Team A" }, { id: "team-b", name: "Team B" }],
  teamRanking: ["team-a", "team-b"],
  history: [],
  turnDurationSeconds: 15,
  turnStartedAt: { __firestoreTimestamp: true, value: new Date(Date.now() - 30_000).toISOString() },
});
firestore.seed("draftPrivate/PRIVATE-PICK", {
  ownerUserId: "owner",
  participants: [{ userId: "", uid: "dan", email: "registered@example.test" }],
  playerPriorities: {},
});
await operation("dan", "draft.priorities", { draftId: "PRIVATE-PICK", priorities: ["team-b", "team-a"] });
const privatePick = await runImmediateDraftPick(
  env, { draftId: "PRIVATE-PICK", userId: "owner", expectedPickIndex: 0 }, firestore.fetchMock,
);
assert.equal(privatePick.status, "picked");
assert.equal(privatePick.itemId, "team-b");
assert.equal(privatePick.reason, "player-priorities");
assert.equal(firestore.read("publicDrafts/PRIVATE-PICK").participants[0].userId, undefined);
console.log("✓ Autopick joins private participant UID to priorities saved through the Worker");

function seedAutoPick(draftId, publicOverrides = {}, privateOverrides = {}) {
  firestore.seed(`publicDrafts/${draftId}`, {
    title: "Autopick test",
    status: "drafting",
    participants: [
      { id: "slot-1", name: "Player One", picks: [], status: "ready" },
      { id: "slot-2", name: "Player Two", picks: [], status: "ready" },
    ],
    pickOrder: [0, 1, 0, 1],
    currentPickIndex: 0,
    availableItemIds: ["team-a", "team-b", "team-c", "team-d"],
    draftItems: ["team-a", "team-b", "team-c", "team-d"].map((id) => ({ id, name: id })),
    teamRanking: ["team-a", "team-b", "team-c", "team-d"],
    history: [],
    turnDurationSeconds: 15,
    turnStartedAt: { __firestoreTimestamp: true, value: new Date(Date.now() - 30_000).toISOString() },
    ...publicOverrides,
  });
  firestore.seed(`draftPrivate/${draftId}`, {
    ownerUserId: "owner",
    participants: [
      { userId: "", uid: "player-1", email: "player1@example.test", participantPin: "112233" },
      { userId: "player-2", uid: "wrong-uid", email: "player2@example.test" },
    ],
    playerPriorities: {},
    ...privateOverrides,
  });
}
function expireAutoPick(draftId) {
  firestore.seed(`publicDrafts/${draftId}`, {
    ...firestore.read(`publicDrafts/${draftId}`),
    turnStartedAt: { __firestoreTimestamp: true, value: new Date(Date.now() - 30_000).toISOString() },
  });
}

const adminPickFixtureTimer = {
  turnDurationSeconds: 15,
  turnStartedAt: { __firestoreTimestamp: true, value: new Date().toISOString() },
};
seedAutoPick("ADMIN-NOT-PLAYER", adminPickFixtureTimer);
await assert.rejects(
  operation("global-admin", "draft.pick", {
    draftId: "ADMIN-NOT-PLAYER",
    itemId: "team-a",
    expectedPickIndex: 0,
  }),
  (error) => error.status === 403,
);
assert.equal(firestore.read("publicDrafts/ADMIN-NOT-PLAYER").history.length, 0);

seedAutoPick("ADMIN-AS-PLAYER", adminPickFixtureTimer, {
  participants: [{ userId: "global-admin" }, { userId: "player-2" }],
});
const adminPlayerPick = await operation("global-admin", "draft.pick", {
  draftId: "ADMIN-AS-PLAYER",
  itemId: "team-a",
  expectedPickIndex: 0,
});
assert.equal(adminPlayerPick.status, "picked");
assert.equal(firestore.read("publicDrafts/ADMIN-AS-PLAYER").history.length, 1);

seedAutoPick("ADMIN-UPDATE-PICK", adminPickFixtureTimer);
const updatePickBefore = firestore.read("publicDrafts/ADMIN-UPDATE-PICK");
await assert.rejects(
  operation("global-admin", "draft.update", {
    draftId: "ADMIN-UPDATE-PICK",
    updates: {
      history: [{ type: "pick", participantIndex: 0, itemId: "team-a" }],
    },
  }),
  (error) => error.status === 400,
);
await assert.rejects(
  operation("global-admin", "draft.update", {
    draftId: "ADMIN-UPDATE-PICK",
    updates: {
      participants: updatePickBefore.participants.map((participant, index) =>
        index === 0 ? { ...participant, picks: ["team-a"] } : participant,
      ),
      availableItemIds: updatePickBefore.availableItemIds.filter((itemId) => itemId !== "team-a"),
    },
  }),
  (error) => error.status === 400,
);
assert.deepEqual(firestore.read("publicDrafts/ADMIN-UPDATE-PICK"), updatePickBefore);
console.log("✓ Admin picks are rejected through draft.pick and draft.update, while assigned admins keep their own turn");

for (const status of ["drafting", "paused", "completed"]) {
  const draftId = `NO-UNDO-${status}`;
  const originalPick = { type: "pick", participantIndex: 0, itemId: "team-a" };
  seedAutoPick(draftId, {
    status,
    turnDurationSeconds: null,
    currentPickIndex: 1,
    history: [originalPick],
    participants: [
      { id: "slot-1", name: "Player One", picks: ["team-a"] },
      { id: "slot-2", name: "Player Two", picks: [] },
    ],
    availableItemIds: ["team-b", "team-c", "team-d"],
  });
  const original = firestore.read(`publicDrafts/${draftId}`);
  const originalPrivate = firestore.read(`draftPrivate/${draftId}`);
  for (const actor of ["owner", "global-admin"]) {
    for (const updates of [
      { currentPickIndex: 0, history: [], availableItemIds: ["team-a", ...original.availableItemIds] },
      { currentPickIndex: 0 },
      { history: [] },
      { history: [{ ...originalPick, itemId: "team-b" }] },
      { participants: original.participants.map((participant) => ({ ...participant, picks: [] })) },
      { participants: [{ ...original.participants[0], id: "renamed-slot", picks: [] }, original.participants[1]] },
      { availableItemIds: ["team-a", ...original.availableItemIds] },
    ]) {
      await assert.rejects(
        operation(actor, "draft.update", { draftId, updates }),
        (error) => error.status === 400 || error.status === 409,
      );
      assert.deepEqual(firestore.read(`publicDrafts/${draftId}`), original);
      assert.deepEqual(firestore.read(`draftPrivate/${draftId}`), originalPrivate);
    }
    await assert.rejects(operation(actor, "draft.undo", { draftId }), (error) => error.status === 400);
  }
  await operation("owner", "draft.update", {
    draftId,
    updates: {
      participants: [{ ...original.participants[0], picks: ["team-b"] }, original.participants[1]],
      availableItemIds: ["team-a", "team-c", "team-d"],
      history: [...original.history, { type: "replace", participantIndex: 0, oldItemId: "team-a", newItemId: "team-b" }],
    },
  });
  const replaced = firestore.read(`publicDrafts/${draftId}`);
  assert.equal(replaced.currentPickIndex, 1);
  assert.deepEqual(replaced.history[0], originalPick);
  assert.equal(replaced.history[1].type, "replace");
  assert.deepEqual(replaced.participants[0].picks, ["team-b"]);
}
console.log("✓ Owner/admin cannot rewind active, paused or completed picks through the Worker; append-only history and team replacement remain functional");

async function triggerAutoPick(path, draftId, index = 0, actorId = "owner") {
  if (path === "cron") {
    const result = await runExpiredDraftPicks(env, firestore.fetchMock);
    assert.equal(result.picked, 1);
  } else {
    const result = await runImmediateDraftPick(
      env, { draftId, userId: actorId, expectedPickIndex: index }, firestore.fetchMock,
    );
    assert.equal(result.status, "picked");
  }
  return firestore.read(`publicDrafts/${draftId}`);
}
function assertPublicPickPrivacy(draftId, privateBefore) {
  const publicFields = firestore.read(`publicDrafts/${draftId}`);
  assert.equal(publicFields.playerPriorities, undefined);
  assert.equal(publicFields.ownerUserId, undefined);
  for (const participant of publicFields.participants) {
    for (const key of ["userId", "uid", "email", "participantPin", "joinedAt"]) {
      assert.equal(participant[key], undefined);
    }
    assert.deepEqual(participant.priorities, []);
  }
  assert.deepEqual(firestore.read(`draftPrivate/${draftId}`), privateBefore);
}

for (const path of ["immediate", "cron"]) {
  const draftId = `RANKS-${path}`;
  seedAutoPick(draftId);
  await operation("player-1", "draft.priorities", { draftId, priorities: ["team-b", "team-c", "team-a", "team-d"] });
  await operation("player-2", "draft.priorities", { draftId, priorities: ["team-b", "team-d", "team-c", "team-a"] });
  const privateBefore = firestore.read(`draftPrivate/${draftId}`);
  const callsBefore = firestore.calls.length;
  for (const [index, expected] of ["team-b", "team-d", "team-c", "team-a"].entries()) {
    expireAutoPick(draftId);
    const result = await triggerAutoPick(path, draftId, index, "player-2");
    assert.equal(result.history.at(-1).itemId, expected);
    assert.equal(result.history.at(-1).autoPickReason, "player-priorities");
    assert.equal(result.history.at(-1).participantIndex, [0, 1, 0, 1][index]);
    assertPublicPickPrivacy(draftId, privateBefore);
  }
  const completed = firestore.read(`publicDrafts/${draftId}`);
  assert.deepEqual(completed.participants.map((participant) => participant.picks), [["team-b", "team-c"], ["team-d", "team-a"]]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.turnStartedAt, undefined);
  const repeated = await runImmediateDraftPick(
    env, { draftId, userId: "player-1", expectedPickIndex: 3 }, firestore.fetchMock,
  );
  assert.equal(repeated.status, "changed");
  assert.equal((await runExpiredDraftPicks(env, firestore.fetchMock)).picked, 0);
  assert.equal(firestore.read(`publicDrafts/${draftId}`).history.length, 4);
  const autoPickReads = firestore.calls.slice(callsBefore)
    .filter((call) => call.url.includes(`/${draftId}?transaction=`));
  for (const call of autoPickReads.filter((entry) => entry.url.includes("/publicDrafts/"))) {
    const transaction = new URL(call.url).searchParams.get("transaction");
    assert.ok(autoPickReads.some((entry) => entry.url.includes("/draftPrivate/") &&
      new URL(entry.url).searchParams.get("transaction") === transaction));
  }
  console.log(`✓ ${path}: separate player rankings, taken-team skipping, repeated turns and no private-data publication`);
}

for (const path of ["immediate", "cron"]) {
  for (const priorities of [undefined, [], ["team-a", "team-b"]]) {
    const draftId = `DEFAULT-${path}-${priorities?.length ?? "none"}`;
    seedAutoPick(draftId, {
      availableItemIds: ["team-c", "team-d"],
      teamRanking: ["team-d", "team-c", "team-b", "team-a"],
      participants: [
        { id: "slot-1", name: "Player One", picks: [], priorities: ["team-c"], userId: "forged-public-id" },
        { id: "slot-2", name: "Player Two", picks: [] },
      ],
      playerPriorities: { "forged-public-id": ["team-c"], "player-1": ["team-c"] },
    });
    if (priorities) await operation("player-1", "draft.priorities", { draftId, priorities });
    const result = await triggerAutoPick(path, draftId);
    assert.equal(result.history.at(-1).itemId, "team-d");
    assert.equal(result.history.at(-1).autoPickReason, "organizer-ranking");
  }
  console.log(`✓ ${path}: missing, empty and exhausted private priorities use draft ranking, not stale public priorities`);
}

for (const path of ["immediate", "cron"]) {
  const draftId = `LATEST-${path}`;
  seedAutoPick(draftId);
  await operation("player-1", "draft.priorities", { draftId, priorities: ["team-b", "team-a"] });
  await operation("player-1", "draft.priorities", { draftId, priorities: ["team-c", "team-b"] });
  assert.equal((await triggerAutoPick(path, draftId)).history.at(-1).itemId, "team-c");
  console.log(`✓ ${path}: a confirmed priority change immediately before autopick is used`);

  const raceId = `RACE-${path}`;
  seedAutoPick(raceId);
  await operation("player-1", "draft.priorities", { draftId: raceId, priorities: ["team-b", "team-a"] });
  const callsBefore = firestore.calls.length;
  firestore.beforeNextCommit(async () => {
    await operation("player-1", "draft.priorities", { draftId: raceId, priorities: ["team-d", "team-c"] });
  });
  const raced = await triggerAutoPick(path, raceId);
  assert.equal(raced.history.at(-1).itemId, "team-d");
  assert.equal(raced.history.length, 1);
  assert.equal(raced.currentPickIndex, 1);
  const commitCalls = firestore.calls.slice(callsBefore).filter((call) => call.url.endsWith(":commit"));
  assert.equal(commitCalls.length, 3);
  const pickTransactions = new Set(commitCalls.map((call) => JSON.parse(call.init.body))
    .filter((body) => body.writes.length === 1).map((body) => body.transaction));
  const privateReads = firestore.calls.slice(callsBefore)
    .filter((call) => call.url.includes(`/draftPrivate/${raceId}?transaction=`) &&
      pickTransactions.has(new URL(call.url).searchParams.get("transaction")));
  assert.equal(privateReads.length, 2);
  assert.notEqual(new URL(privateReads[0].url).searchParams.get("transaction"), new URL(privateReads[1].url).searchParams.get("transaction"));
  console.log(`✓ ${path}: priority changes during the transaction abort the stale pick and retry with latest private data`);
}

seedAutoPick("CONCURRENT-PICKS");
await operation("player-1", "draft.priorities", { draftId: "CONCURRENT-PICKS", priorities: ["team-c", "team-b"] });
const concurrentBefore = firestore.read("draftPrivate/CONCURRENT-PICKS");
const [cronPick, instantPick] = await Promise.all([
  runExpiredDraftPicks(env, firestore.fetchMock),
  runImmediateDraftPick(env, { draftId: "CONCURRENT-PICKS", userId: "player-2", expectedPickIndex: 0 }, firestore.fetchMock),
]);
assert.equal(cronPick.picked + Number(instantPick.status === "picked"), 1);
assert.equal(firestore.read("publicDrafts/CONCURRENT-PICKS").history.length, 1);
assert.equal(firestore.read("publicDrafts/CONCURRENT-PICKS").history[0].itemId, "team-c");
assertPublicPickPrivacy("CONCURRENT-PICKS", concurrentBefore);
console.log("✓ Cron and browser racing the same expired turn commit exactly one player-priority pick");

seedAutoPick("PLAYER-AUTOPICK-RACE");
await operation("player-1", "draft.priorities", {
  draftId: "PLAYER-AUTOPICK-RACE",
  priorities: ["team-b", "team-a"],
});
const manualAutoRace = await Promise.allSettled([
  operation("player-1", "draft.pick", {
    draftId: "PLAYER-AUTOPICK-RACE",
    itemId: "team-a",
    expectedPickIndex: 0,
  }),
  runImmediateDraftPick(
    env,
    { draftId: "PLAYER-AUTOPICK-RACE", userId: "owner", expectedPickIndex: 0 },
    firestore.fetchMock,
  ),
]);
const racedPlayerDraft = firestore.read("publicDrafts/PLAYER-AUTOPICK-RACE");
assert.equal(racedPlayerDraft.history.length, 1);
assert.equal(racedPlayerDraft.currentPickIndex, 1);
assert.equal(new Set(racedPlayerDraft.history.map((entry) => entry.itemId)).size, 1);
if (manualAutoRace[0].status === "rejected") {
  assert.equal(manualAutoRace[0].reason.status, 409);
}
assert.ok(
  manualAutoRace[1].status === "fulfilled" &&
    ["picked", "not-expired", "changed"].includes(manualAutoRace[1].value.status),
);
console.log("✓ A player pick racing autopick commits only one team and never advances the turn twice");

seedAutoPick("UNASSIGNED-PICK", {}, { participants: [{}, { userId: "player-2" }] });
const forbiddenPick = await runImmediateDraftPick(
  env, { draftId: "UNASSIGNED-PICK", userId: "player-1", expectedPickIndex: 0 }, firestore.fetchMock,
);
assert.equal(forbiddenPick.status, "forbidden");
const privateFailure = async (input, init) => {
  if (String(input).includes("/draftPrivate/UNASSIGNED-PICK")) {
    return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
  }
  return firestore.fetchMock(input, init);
};
await assert.rejects(
  runImmediateDraftPick(env, { draftId: "UNASSIGNED-PICK", userId: "owner", expectedPickIndex: 0 }, privateFailure),
  (error) => error.status === 503,
);
assert.equal(firestore.read("publicDrafts/UNASSIGNED-PICK").history.length, 0);
firestore.seed("publicDrafts/UNASSIGNED-PICK", { ...firestore.read("publicDrafts/UNASSIGNED-PICK"), status: "paused" });
console.log("✓ Unassigned callers and private-read failures do not pick or fall back silently");

const playerAccess = await operation("player-1", "draft.access", { draftId: "ROOM1" });
const ownerAccess = await operation("owner", "draft.access", { draftId: "ROOM1" });
assert.equal(playerAccess.role, "participant");
assert.equal(playerAccess.participants[0].userId, "player-1");
assert.equal(playerAccess.participants[0].email, "player1@example.test");
assert.equal(playerAccess.participants[1].userId, undefined);
const strangerAccess = await operation("stranger", "draft.access", { draftId: "ROOM1" });
assert.equal(strangerAccess.authorized, false);
assert.equal(strangerAccess.participants[0].email, undefined);
console.log("✓ Private participant data is returned only to the owner, admin or matching participant");

firestore.seed("publicDrafts/UID-ONLY", {
  title: "Legacy UID participant",
  status: "waiting",
  participants: [{ id: "p1", name: "Player One", picks: [], userId: "", uid: "player-1" }],
});
const uidAccess = await operation("player-1", "draft.access", { draftId: "UID-ONLY" });
assert.equal(uidAccess.authorized, true);
assert.equal(uidAccess.participantIndex, 0);
assert.equal(uidAccess.participants[0].userId, "player-1");
await operation("player-1", "draft.priorities", {
  draftId: "UID-ONLY",
  priorities: ["team-b", "team-a"],
});
assert.deepEqual(firestore.read("draftPrivate/UID-ONLY").playerPriorities["player-1"], ["team-b", "team-a"]);
console.log("✓ A legacy UID is recognized when the canonical userId is empty");

firestore.seed("publicDrafts/PRIVATE-UID", {
  title: "Private UID participant",
  status: "waiting",
  participants: [{ id: "p1", name: "Player One", picks: [], userId: "stranger" }],
});
firestore.seed("draftPrivate/PRIVATE-UID", {
  ownerUserId: "owner",
  participants: [{ userId: "", uid: "player-1" }],
  playerPriorities: {},
});
assert.equal((await operation("player-1", "draft.access", { draftId: "PRIVATE-UID" })).participantIndex, 0);
assert.equal((await operation("stranger", "draft.access", { draftId: "PRIVATE-UID" })).authorized, false);
await operation("player-1", "draft.priorities", { draftId: "PRIVATE-UID", priorities: ["team-a"] });
assert.equal(firestore.read("draftPrivate/PRIVATE-UID").participants[0].userId, "player-1");
console.log("✓ Private UID compatibility never grants access using public participant identifiers");

firestore.seed("draftPrivate/PRIVATE-UID", {
  ownerUserId: "owner",
  participants: [{ userId: "player-2", uid: "player-1" }],
  playerPriorities: {},
});
assert.equal((await operation("player-1", "draft.access", { draftId: "PRIVATE-UID" })).authorized, false);
await assert.rejects(
  operation("player-1", "draft.priorities", { draftId: "PRIVATE-UID", priorities: ["team-a"] }),
  (error) => error.status === 403,
);
assert.equal((await operation("player-2", "draft.access", { draftId: "PRIVATE-UID" })).participantIndex, 0);
console.log("✓ A nonempty canonical userId takes precedence over a conflicting legacy UID");

await operation("owner", "draft.create", {
  draftId: "CREATE-UID",
  data: { title: "UID creation", participants: [{ id: "p1", userId: "", uid: "player-1" }] },
});
assert.equal(firestore.read("draftPrivate/CREATE-UID").participants[0].userId, "player-1");
await operation("owner", "draft.update", {
  draftId: "CREATE-UID",
  updates: { participants: [{ id: "p1", userId: "", uid: "player-2" }] },
});
assert.equal((await operation("player-2", "draft.access", { draftId: "CREATE-UID" })).participantIndex, 0);
assert.equal((await operation("player-1", "draft.access", { draftId: "CREATE-UID" })).authorized, false);
await operation("owner", "draft.update", {
  draftId: "CREATE-UID",
  updates: { participants: [{ id: "p1", userId: "", uid: "" }] },
});
await assert.rejects(
  operation("player-2", "draft.priorities", { draftId: "CREATE-UID", priorities: ["team-a"] }),
  (error) => error.status === 403,
);
console.log("✓ UID assignments survive creation and updates; removing an assignment revokes access");

await assert.rejects(
  operation("stranger", "draft.update", {
    draftId: "ROOM1",
    updates: { title: "Unauthorized edit" },
  }),
  (error) => error.status === 403,
);
await assert.rejects(
  operation("player-1", "draft.update", {
    draftId: "ROOM1",
    updates: { title: "Participant edit" },
  }),
  (error) => error.status === 403,
);
console.log("✓ Draft edits reject unrelated users and participants");

await operation("owner", "draft.update", {
  draftId: "ROOM1",
  updates: {
    participants: [
      { ...playerAccess.participants[0], participantPin: "778899" },
      playerAccess.participants[1],
    ],
  },
  expected: {
    status: "waiting",
    participantOrderDrawn: false,
    participants: ownerAccess.participants,
  },
});
assert.equal(firestore.read("publicDrafts/ROOM1").participants[0].participantPin, undefined);
assert.equal(firestore.read("draftPrivate/ROOM1").participants[0].participantPin, "778899");
console.log("✓ Organizer participant updates keep PINs out of public draft data");

firestore.seed("publicDrafts/DRAW", {
  title: "Draw test",
  status: "waiting",
  participantCount: 2,
  participantOrderDrawn: false,
  participants: [
    { id: "p1", name: "Player One", picks: [] },
    { id: "p2", name: "Player Two", picks: [] },
  ],
});
firestore.seed("draftPrivate/DRAW", {
  ownerUserId: "owner",
  participants: [
    { userId: "player-1", email: "player1@example.test" },
    { userId: "player-2", email: "player2@example.test" },
  ],
  playerPriorities: {},
});
const drawPayload = {
  draftId: "DRAW",
  expectedParticipantIds: ["p1", "p2"],
  participants: [
    { id: "p2", name: "Player Two", userId: "player-2", picks: [] },
    { id: "p1", name: "Player One", userId: "player-1", picks: [] },
  ],
};
const concurrentDraws = await Promise.allSettled([
  operation("owner", "draft.draw", drawPayload),
  operation("owner", "draft.draw", drawPayload),
]);
assert.equal(concurrentDraws.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(firestore.read("publicDrafts/DRAW").participantOrderDrawn, true);
assert.deepEqual(
  firestore.read("publicDrafts/DRAW").participants.map((participant) => participant.id),
  ["p2", "p1"],
);
console.log("✓ Concurrent organizer draws save one immutable participant order");

firestore.seed("publicDrafts/NO-RANKING", {
  title: "Draft without ranking",
  status: "waiting",
  participantCount: 1,
  participants: [{ id: "p1", name: "Player One", picks: [] }],
  pickOrder: [0],
  availableItemIds: ["team-a"],
});
firestore.seed("draftPrivate/NO-RANKING", {
  ownerUserId: "owner",
  participants: [{ userId: "player-1", email: "player1@example.test" }],
  playerPriorities: {},
});
await operation("owner", "draft.start", {
  draftId: "NO-RANKING",
  expectedTeamRanking: [],
  participants: [{ id: "p1", name: "Player One", userId: "player-1", picks: [] }],
  teamRanking: ["team-a"],
});
assert.equal(firestore.read("publicDrafts/NO-RANKING").status, "drafting");
console.log("✓ Starting a draft treats an absent ranking as an empty ranking");

firestore.seed("publicDrafts/ROOM1", {
  ...firestore.read("publicDrafts/ROOM1"),
  status: "drafting",
  currentPickIndex: 0,
  pickOrder: [0, 1],
  availableItemIds: ["team-a", "team-b"],
  draftItems: [{ id: "team-a", name: "Team A" }, { id: "team-b", name: "Team B" }],
  history: [],
});
firestore.seed("draftPrivate/ROOM1", {
  ...firestore.read("draftPrivate/ROOM1"),
  playerPriorities: {},
});
const racingPicks = await Promise.allSettled([
  operation("player-1", "draft.pick", {
    draftId: "ROOM1",
    itemId: "team-a",
    expectedPickIndex: 0,
  }),
  operation("player-1", "draft.pick", {
    draftId: "ROOM1",
    itemId: "team-a",
    expectedPickIndex: 0,
  }),
]);
assert.equal(racingPicks.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(firestore.read("publicDrafts/ROOM1").currentPickIndex, 1);
assert.deepEqual(firestore.read("publicDrafts/ROOM1").participants[0].picks, ["team-a"]);
console.log("✓ Concurrent requests for one pick commit exactly once");

await operation("player-1", "draft.priorities", {
  draftId: "ROOM1",
  priorities: ["team-b", "team-a"],
});
assert.equal(firestore.read("publicDrafts/ROOM1").playerPriorities, undefined);
assert.deepEqual(firestore.read("draftPrivate/ROOM1").playerPriorities["player-1"], ["team-b", "team-a"]);
console.log("✓ Player priorities are written only to private draft data");

await operation("player-2", "draft.priorities", {
  draftId: "ROOM1", priorities: ["team-a", "team-b"],
});
const prioritiesBeforeForgery = firestore.read("draftPrivate/ROOM1");
for (const forgedTarget of [
  { userId: "player-2" },
  { uid: "player-2" },
  { participantIndex: 1 },
  { playerPriorities: { "player-2": ["forged"] } },
]) {
  await assert.rejects(
    operation("player-1", "draft.priorities", {
      draftId: "ROOM1", priorities: ["forged"], ...forgedTarget,
    }),
    (error) => error.status === 400,
  );
  assert.deepEqual(firestore.read("draftPrivate/ROOM1"), prioritiesBeforeForgery);
}
for (const actorId of ["stranger", "owner", "global-admin"]) {
  await assert.rejects(
    operation(actorId, "draft.priorities", { draftId: "ROOM1", priorities: ["forged"] }),
    (error) => error.status === 403,
  );
  assert.deepEqual(firestore.read("draftPrivate/ROOM1"), prioritiesBeforeForgery);
}
const ownAccess = await operation("player-1", "draft.access", { draftId: "ROOM1" });
assert.deepEqual(ownAccess.playerPriorities, ["team-b", "team-a"]);
assert.equal(ownAccess.participants[1].userId, undefined);
console.log("✓ Foreign targets and unassigned accounts are rejected without changing any player's priorities");

firestore.seed("drafts/LEGACY", {
  title: "Ownerless legacy draft",
  status: "waiting",
  participantCount: 1,
  participants: [{
    id: "p1",
    name: "Player One",
    userId: "",
    uid: "player-1",
    email: "player1@example.test",
    participantPin: "112233",
    picks: [],
  }],
});
firestore.seed("drafts/LEGACY/messages/message-1", {
  userId: "player-1",
  displayName: "Player One",
  role: "participant",
  text: "Legacy chat",
});
const migrationProgress = [];
const migrationResult = await runLegacyDraftPrivacyMigration(
  env,
  firestore.fetchMock,
  (completed, draftId) => migrationProgress.push({ completed, draftId }),
);
assert.deepEqual(migrationResult, { scanned: 1, migrated: 1 });
assert.deepEqual(migrationProgress, [{ completed: 1, draftId: "LEGACY" }]);
const migrationDeletes = firestore.calls
  .filter((call) => call.url.endsWith(":commit"))
  .flatMap((call) => JSON.parse(call.init.body).writes ?? [])
  .filter((write) => write.delete?.includes("/documents/drafts/LEGACY"));
assert.equal(migrationDeletes.length, 2);
assert.ok(migrationDeletes.every((write) => typeof write.currentDocument?.updateTime === "string"));
assert.equal(firestore.read("drafts/LEGACY"), null);
assert.equal(firestore.read("drafts/LEGACY/messages/message-1"), null);
assert.equal(firestore.read("publicDrafts/LEGACY").participants[0].email, undefined);
assert.equal(firestore.read("draftPrivate/LEGACY").ownerUserId, null);
assert.equal(firestore.read("draftPrivate/LEGACY").participants[0].participantPin, "112233");
assert.equal(firestore.read("publicDrafts/LEGACY/messages/message-1").text, "Legacy chat");
assert.equal((await operation("player-1", "draft.access", { draftId: "LEGACY" })).role, "participant");
assert.equal(firestore.read("draftPrivate/LEGACY").participants[0].userId, "player-1");
await operation("player-1", "draft.priorities", { draftId: "LEGACY", priorities: ["team-a"] });
await assert.rejects(
  operation("stranger", "draft.priorities", { draftId: "LEGACY", priorities: ["team-b"] }),
  (error) => error.status === 403,
);
await assert.rejects(
  operation("player-1", "draft.update", { draftId: "LEGACY", updates: { title: "Claimed" } }),
  (error) => error.status === 403,
);
await operation("global-admin", "draft.update", {
  draftId: "LEGACY",
  updates: { title: "Admin-managed" },
});
assert.equal(firestore.read("draftPrivate/LEGACY").ownerUserId, null);
assert.equal(firestore.read("publicDrafts/LEGACY").title, "Admin-managed");
console.log("✓ Migration preserves chat and private data; ownerless drafts remain playable but admin-managed");

firestore.seed("drafts/CONFLICT", {
  title: "Legacy source",
  status: "waiting",
  participants: [],
});
firestore.seed("publicDrafts/CONFLICT", {
  title: "Different existing draft",
  privacyVersion: 1,
  participants: [],
});
await assert.rejects(
  runLegacyDraftPrivacyMigration(env, firestore.fetchMock),
  /Refusing to delete legacy data because migrated public draft CONFLICT\.title does not match/,
);
assert.equal(firestore.read("drafts/CONFLICT").title, "Legacy source");
console.log("✓ Migration refuses conflicting destinations without deleting legacy source data");
