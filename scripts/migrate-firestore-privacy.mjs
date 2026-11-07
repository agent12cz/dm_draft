import { readFile } from "node:fs/promises";
import { runLegacyDraftPrivacyMigration } from "../workers/firestore.ts";

if (!process.argv.includes("--apply")) {
  console.info("No changes made. Add --apply to migrate legacy Firestore drafts.");
  process.exit(0);
}

const projectId = process.env.FIREBASE_PROJECT_ID;
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ??
  (process.env.FIREBASE_SERVICE_ACCOUNT_FILE
    ? await readFile(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, "utf8")
    : undefined);

if (!projectId || !serviceAccountJson) {
  throw new Error(
    "Set FIREBASE_PROJECT_ID and either FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_FILE.",
  );
}

const result = await runLegacyDraftPrivacyMigration(
  {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
  },
  fetch,
  (completed, draftId) => {
    console.info(`Migrated legacy draft ${draftId} (${completed}).`);
  },
);
console.info(`Privacy migration completed: ${result.migrated}/${result.scanned} legacy drafts migrated.`);
