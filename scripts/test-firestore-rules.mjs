import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { executeFirestoreSecurityOperation, runExpiredDraftPicks, runImmediateDraftPick } from "../workers/firestore.ts";

const projectId = "dm-draft-rules-test";
const rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
const environment = await initializeTestEnvironment({
  projectId,
  firestore: { rules },
});

try {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "publicDrafts", "room"), {
      privacyVersion: 1,
      status: "waiting",
      participants: [
        { id: "p1", name: "Player One", picks: [] },
        { id: "p2", name: "Player Two", picks: [] },
      ],
      accessExpiresAt: Timestamp.fromDate(new Date("2027-01-02T00:00:00Z")),
    });
    await setDoc(doc(db, "publicDrafts", "room", "messages", "message"), {
      text: "Public chat message",
    });
    await setDoc(doc(db, "publicDrafts", "deleted", "messages", "orphan"), {
      text: "Should not be readable",
    });
    await setDoc(doc(db, "products", "product"), { name: "Product" });
    await setDoc(doc(db, "teamRankings", "ranking"), { teamOrder: ["team-a"] });
    await setDoc(doc(db, "drafts", "legacy"), { ownerUserId: "private-owner" });
    await setDoc(doc(db, "draftPrivate", "room"), {
      ownerUserId: "private-owner",
      participants: [
        { userId: "", uid: "player-1" },
        { userId: "player-2" },
      ],
      playerPriorities: { "player-2": ["team-a", "team-b"] },
    });
    await setDoc(doc(db, "users", "player-1"), { role: "participant" });
    await setDoc(doc(db, "users", "player-2"), { role: "participant" });
    await setDoc(doc(db, "users", "owner"), { email: "private@example.test" });
    await setDoc(doc(db, "users", "private-owner"), { userId: "private-owner", displayName: "Dan", email: "registered@example.test" });
  });

  const anonymousDb = environment.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(anonymousDb, "publicDrafts", "room")));
  await assertSucceeds(getDocs(collection(anonymousDb, "publicDrafts")));
  await assertSucceeds(getDoc(doc(anonymousDb, "products", "product")));
  await assertSucceeds(getDoc(doc(anonymousDb, "teamRankings", "ranking")));
  await assertSucceeds(getDoc(doc(anonymousDb, "publicDrafts", "room", "messages", "message")));
  await assertFails(getDoc(doc(anonymousDb, "publicDrafts", "deleted", "messages", "orphan")));
  await assertFails(getDoc(doc(anonymousDb, "drafts", "legacy")));
  await assertFails(getDoc(doc(anonymousDb, "draftPrivate", "room")));
  await assertFails(getDoc(doc(anonymousDb, "users", "owner")));
  console.log("✓ Public reads are separated from legacy drafts, profiles and private draft records");

  const ownerDb = environment.authenticatedContext("owner").firestore();
  await assertSucceeds(getDoc(doc(ownerDb, "publicDrafts", "room")));
  for (const reference of [
    doc(ownerDb, "publicDrafts", "room"),
    doc(ownerDb, "publicDrafts", "room", "messages", "message"),
    doc(ownerDb, "products", "product"),
    doc(ownerDb, "teamRankings", "ranking"),
    doc(ownerDb, "draftPrivate", "room"),
    doc(ownerDb, "users", "owner"),
  ]) {
    await assertFails(setDoc(reference, { clientWrite: true }));
  }
  console.log("✓ Authenticated clients cannot write drafts, chat, products, rankings or private data");

  const playerDb = environment.authenticatedContext("player-1").firestore();
  await assertFails(updateDoc(doc(playerDb, "publicDrafts", "room"), {
    "playerPriorities.player-1": ["team-b", "team-a"],
  }));
  await assertFails(updateDoc(doc(playerDb, "draftPrivate", "room"), {
    "playerPriorities.player-1": ["team-b", "team-a"],
  }));
  await assertFails(updateDoc(doc(playerDb, "draftPrivate", "room"), {
    "playerPriorities.player-2": ["forged"],
  }));
  console.log("✓ Rules deny direct priority writes for both the player's own and another player's UID");

  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(emulatorHost, "Worker integration tests require the local Firestore emulator.");
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const keyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(keyBytes).toString("base64")}\n-----END PRIVATE KEY-----`;
  const workerEnv = {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: projectId,
      client_email: "emulator-only@example.test",
      private_key: pem,
    }),
  };
  const emulatorRequest = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "owner", expires_in: 3600 });
    }
    assert.equal(url.hostname, "firestore.googleapis.com");
    const localUrl = new URL(`${url.pathname}${url.search}`, `http://${emulatorHost}`);
    // The emulator REST adapter cannot parse the bytes-valued GET transaction query.
    if (url.searchParams.has("transaction")) {
      const documentName = url.pathname.slice("/v1/".length);
      const batchUrl = new URL(
        `${url.pathname.slice(0, url.pathname.indexOf("/documents/"))}/documents:batchGet`,
        `http://${emulatorHost}`,
      );
      const response = await fetch(batchUrl, {
        method: "POST",
        headers: { ...init.headers, "content-type": "application/json" },
        body: JSON.stringify({ documents: [documentName], transaction: url.searchParams.get("transaction") }),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.ok, true, await response.clone().text());
      const results = await response.json();
      return results[0]?.found
        ? Response.json(results[0].found)
        : Response.json({}, { status: 404 });
    }
    return fetch(localUrl, { ...init, signal: AbortSignal.timeout(15_000) });
  };
  const runWorker = (uid, payload) => executeFirestoreSecurityOperation(
    workerEnv, { uid }, { operation: "draft.priorities", draftId: "room", ...payload }, emulatorRequest,
  );
  const searched = await executeFirestoreSecurityOperation(
    workerEnv, { uid: "private-owner" },
    { operation: "draft.search-users", draftId: "room", prefix: "da" },
    emulatorRequest,
  );
  assert.equal(searched.users.some((candidate) => candidate.uid === "private-owner"), true);
  assert.ok(searched.users.every((candidate) => !("email" in candidate) && !("role" in candidate)));
  console.log("✓ Real indexed searches find Dan for da without leaking profile data");
  assert.equal((await runWorker("player-1", { priorities: ["team-b", "team-a"] })).status, "saved");
  const access = await executeFirestoreSecurityOperation(
    workerEnv, { uid: "player-1" }, { operation: "draft.access", draftId: "room" }, emulatorRequest,
  );
  assert.equal(access.participantIndex, 0);
  assert.equal(access.participants[0].userId, "player-1");
  assert.deepEqual(access.playerPriorities, ["team-b", "team-a"]);
  await assert.rejects(
    runWorker("player-1", { userId: "player-2", priorities: ["forged"] }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    runWorker("stranger", { priorities: ["forged"] }),
    (error) => error.status === 403,
  );
  await environment.withSecurityRulesDisabled(async (context) => {
    const saved = (await getDoc(doc(context.firestore(), "draftPrivate", "room"))).data();
    assert.deepEqual(saved.playerPriorities, {
      "player-1": ["team-b", "team-a"],
      "player-2": ["team-a", "team-b"],
    });
    const publicData = (await getDoc(doc(context.firestore(), "publicDrafts", "room"))).data();
    assert.equal(publicData.playerPriorities, undefined);
  });
  console.log("✓ Real Worker transactions save only own priorities with restrictive rules loaded in the emulator");

  await environment.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), "publicDrafts", "room"), {
      status: "drafting",
      pickOrder: [0, 1, 0, 1],
      currentPickIndex: 0,
      availableItemIds: ["team-a", "team-b", "team-c", "team-d"],
      draftItems: ["team-a", "team-b", "team-c", "team-d"].map((id) => ({ id, name: id })),
      teamRanking: ["team-a", "team-b", "team-c", "team-d"],
      history: [],
      turnDurationSeconds: 15,
      turnStartedAt: Timestamp.fromMillis(Date.now() - 30_000),
    });
  });
  await runWorker("player-1", { priorities: ["team-b", "team-c", "team-a"] });
  await runWorker("player-2", { priorities: ["team-b", "team-d", "team-c", "team-a"] });
  for (const [index, team] of ["team-b", "team-d", "team-c", "team-a"].entries()) {
    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "publicDrafts", "room"), {
        turnStartedAt: Timestamp.fromMillis(Date.now() - 30_000),
      });
    });
    if (index % 2 === 0) {
      const result = await runImmediateDraftPick(workerEnv, {
        draftId: "room", userId: "player-2", expectedPickIndex: index,
      }, emulatorRequest);
      assert.equal(result.status, "picked");
      assert.equal(result.itemId, team);
    } else {
      assert.equal((await runExpiredDraftPicks(workerEnv, emulatorRequest)).picked, 1);
    }
    await environment.withSecurityRulesDisabled(async (context) => {
      const publicFields = (await getDoc(doc(context.firestore(), "publicDrafts", "room"))).data();
      assert.equal(publicFields.history.at(-1).itemId, team);
      assert.equal(publicFields.history.at(-1).autoPickReason, "player-priorities");
      assert.equal(publicFields.currentPickIndex, index + 1);
      assert.equal(publicFields.playerPriorities, undefined);
      for (const participant of publicFields.participants) {
        assert.equal(participant.userId, undefined);
        assert.equal(participant.uid, undefined);
        assert.equal(participant.email, undefined);
      }
      const privateFields = (await getDoc(doc(context.firestore(), "draftPrivate", "room"))).data();
      assert.deepEqual(privateFields.playerPriorities, {
        "player-1": ["team-b", "team-c", "team-a"],
        "player-2": ["team-b", "team-d", "team-c", "team-a"],
      });
      if (index === 3) {
        assert.equal(publicFields.status, "completed");
        assert.equal(publicFields.turnStartedAt, undefined);
      }
    });
  }
  assert.equal((await runExpiredDraftPicks(workerEnv, emulatorRequest)).picked, 0);
  console.log("✓ Real browser-triggered and Cron autopicks share independent private priorities and never publish UIDs");

  const adminDb = environment.authenticatedContext("admin", { role: "admin" }).firestore();
  await assertFails(setDoc(doc(adminDb, "publicDrafts", "room"), { changed: true }));
  await assertFails(getDoc(doc(adminDb, "draftPrivate", "room")));
  await assertSucceeds(getDoc(doc(adminDb, "publicDrafts", "room")));
  console.log("✓ Firebase Auth claims do not bypass the Worker-only write boundary");

  assert.doesNotMatch(rules, /request\.time|timestamp|2027|expire/i);
  await assertSucceeds(getDoc(doc(anonymousDb, "publicDrafts", "room")));
  console.log("✓ Access has no time-based expiry and remains readable after the 2027 boundary");
} finally {
  await environment.cleanup();
}
