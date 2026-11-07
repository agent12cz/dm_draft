import assert from "node:assert/strict";
import {
  executeFirestoreSecurityOperation,
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
        const alternatives = query.where.compositeFilter.filters.map(
          (filter) => filter.compositeFilter.filters,
        );
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
            return alternatives.some((filters) => filters.every((filter) => {
              const { fieldPath } = filter.fieldFilter.field;
              const value = String(fields[fieldPath] ?? "");
              const boundary = filter.fieldFilter.value.stringValue;
              return filter.fieldFilter.op === "GREATER_THAN_OR_EQUAL"
                ? value >= boundary
                : value <= boundary;
            }));
          });
        return Response.json(results);
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

firestore.seed("drafts/LEGACY", {
  title: "Ownerless legacy draft",
  status: "waiting",
  participantCount: 1,
  participants: [{
    id: "p1",
    name: "Player One",
    userId: "player-1",
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
