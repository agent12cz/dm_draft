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
} from "firebase/firestore";

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
    await setDoc(doc(db, "draftPrivate", "room"), { ownerUserId: "private-owner" });
    await setDoc(doc(db, "users", "owner"), { email: "private@example.test" });
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
