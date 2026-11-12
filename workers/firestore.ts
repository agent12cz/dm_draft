import {
  buildAutomaticPickUpdate,
  getDraftStatusAfterPick,
  type AutoPickDraft,
  type AutoPickHistoryItem,
  type AutoPickParticipant,
  type AutoPickUpdate,
} from "../src/lib/autoPick";
import { getProductSport, isProductSport, type ProductSport } from "../src/lib/products";
import { createSportRankingKey } from "../src/lib/rankings";
import { getTeamsForSport } from "../src/lib/sportsTeams";
import { extendSnakeOrderForSkippedPick } from "../src/lib/snakeDraft";

export type DraftWorkerEnv = {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT_JSON: string;
};

/** Extra server-side checks applied inside the Firestore transaction. */
export type DraftPickGuard = {
  /** The turn is only picked when this user owns or participates in the draft. */
  userId?: string;
  /** The turn is only picked when the draft still waits for this pick index. */
  expectedPickIndex?: number;
};

export type DraftPickOutcome =
  | { status: "picked"; itemId?: string; reason?: string; completed: boolean }
  | {
      status: "completed" | "changed" | "not-expired" | "missing" | "invalid" | "conflict" | "forbidden";
    };

const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function canonicalTeamIds(sport: ProductSport) {
  return getTeamsForSport(sport).map((team) => team.id);
}

function isCompleteTeamOrder(value: unknown, sport: ProductSport) {
  const expectedIds = canonicalTeamIds(sport);
  if (!Array.isArray(value) || value.length !== expectedIds.length || value.some((id) => typeof id !== "string")) {
    return false;
  }
  const actualIds = value as string[];
  return new Set(actualIds).size === expectedIds.length &&
    expectedIds.every((id) => actualIds.includes(id));
}

function hasCanonicalDraftRoster(fields: Record<string, unknown>) {
  return fields.sport !== undefined ||
    (Array.isArray(fields.draftItems) && fields.draftItems.length === canonicalTeamIds("NHL").length);
}

function validateDraftRoster(fields: Record<string, unknown>, sport: ProductSport) {
  const expectedIds = canonicalTeamIds(sport);
  const draftItems = fields.draftItems;
  if (
    !Array.isArray(draftItems) ||
    draftItems.length !== expectedIds.length ||
    draftItems.some((item) =>
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !expectedIds.includes(item.id) ||
      (typeof item.sport === "string" && item.sport !== sport)
    ) ||
    new Set(draftItems.filter(isRecord).map((item) => item.id)).size !== expectedIds.length
  ) {
    throw new FirestoreSecurityError(400, `The draft roster does not match ${sport}.`);
  }
}

type ServiceAccount = {
  project_id?: string;
  client_email: string;
  private_key: string;
};

type FirestoreValue = Record<string, unknown>;
type FirestoreDocument = {
  name?: string;
  fields?: Record<string, unknown>;
  updateTime?: string;
};
type GoogleAccessToken = {
  access_token: string;
  expires_in?: number;
};

type FirestoreTimestamp = {
  __firestoreTimestamp: true;
  value: string;
};

export class FirestoreHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operation?: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

async function upstreamError(response: Response, operation: string) {
  const responseText = await response.text();
  let reason = "UNKNOWN";
  try {
    const parsed: unknown = JSON.parse(responseText);
    const status = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.status : undefined;
    if (typeof status === "string" && /^[A-Z_]{1,64}$/.test(status)) reason = status;
  } catch {
    // Upstream errors need not be JSON; never include their raw bodies in diagnostics.
  }
  return new FirestoreHttpError(
    `${operation} failed with HTTP ${response.status} (${reason}).`,
    response.status,
    operation,
    reason,
  );
}

let cachedAccessToken: { email: string; token: string; expiresAt: number } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeBase64UrlText(value: string) {
  return base64UrlEncode(new TextEncoder().encode(value));
}

function decodePrivateKey(privateKey: string) {
  const encodedKey = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");

  return Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0));
}

async function getAccessToken(env: DraftWorkerEnv, request: typeof fetch) {
  let serviceAccount: ServiceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service account JSON.");
  }

  if (
    typeof serviceAccount.client_email !== "string" ||
    typeof serviceAccount.private_key !== "string"
  ) {
    throw new Error("Service account JSON is missing client_email or private_key.");
  }
  if (serviceAccount.project_id && serviceAccount.project_id !== env.FIREBASE_PROJECT_ID) {
    throw new Error("Service account project_id does not match FIREBASE_PROJECT_ID.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    cachedAccessToken?.email === serviceAccount.client_email &&
    cachedAccessToken.expiresAt > nowSeconds + 60
  ) {
    return cachedAccessToken.token;
  }

  const tokenUrl = "https://oauth2.googleapis.com/token";
  const encodedHeader = encodeBase64UrlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedClaims = encodeBase64UrlText(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: tokenUrl,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const unsignedAssertion = `${encodedHeader}.${encodedClaims}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    decodePrivateKey(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedAssertion),
  );
  const assertion = `${unsignedAssertion}.${base64UrlEncode(new Uint8Array(signature))}`;
  const response = await request(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const responseBody = await readJsonResponse<GoogleAccessToken>(response, "Google OAuth");

  if (typeof responseBody.access_token !== "string") {
    throw new Error("Google OAuth response did not contain an access token.");
  }

  const expiresIn = Number(responseBody.expires_in ?? 3600);
  cachedAccessToken = {
    email: serviceAccount.client_email,
    token: responseBody.access_token,
    expiresAt: nowSeconds + expiresIn,
  };
  return responseBody.access_token;
}

async function readJsonResponse<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    throw await upstreamError(response, operation);
  }

  return (await response.json()) as T;
}

async function readJsonStream(response: Response, operation: string) {
  if (!response.ok) {
    throw await upstreamError(response, operation);
  }

  const responseText = await response.text();
  if (!responseText.trim()) {
    return [] as unknown[];
  }

  try {
    const parsed: unknown = JSON.parse(responseText);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return responseText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }
}

function decodeFirestoreValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value && typeof value.timestampValue === "string") {
    return { __firestoreTimestamp: true, value: value.timestampValue } satisfies FirestoreTimestamp;
  }
  if ("nullValue" in value) return null;
  if (isRecord(value.mapValue) && isRecord(value.mapValue.fields)) {
    return decodeFirestoreFields(value.mapValue.fields);
  }
  if (isRecord(value.arrayValue)) {
    const values = Array.isArray(value.arrayValue.values) ? value.arrayValue.values : [];
    return values.map((entry) => decodeFirestoreValue(entry));
  }

  return undefined;
}

function decodeFirestoreFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [field, decodeFirestoreValue(value)]),
  );
}

function encodeFirestoreValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((entry) => encodeFirestoreValue(entry)) } };
  }
  if (isRecord(value)) {
    if (
      value.__firestoreTimestamp === true &&
      typeof value.value === "string"
    ) {
      return { timestampValue: value.value };
    }

    const fields = Object.fromEntries(
      Object.entries(value)
        .filter(([, fieldValue]) => fieldValue !== undefined)
        .map(([field, fieldValue]) => [field, encodeFirestoreValue(fieldValue)]),
    );
    return { mapValue: { fields } };
  }

  throw new Error(`Unsupported Firestore value type: ${typeof value}`);
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function numberArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry))
    : [];
}

function decodeParticipant(value: unknown): AutoPickParticipant | null {
  if (!isRecord(value)) return null;

  return {
    ...value,
    userId: typeof value.userId === "string" ? value.userId : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    picks: stringArray(value.picks),
    priorities: stringArray(value.priorities),
  };
}

function decodeHistory(value: unknown): AutoPickHistoryItem[] {
  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is AutoPickHistoryItem =>
    isRecord(entry) &&
    (entry.type === "pick" || entry.type === "skip" || entry.type === "replace") &&
    typeof entry.participantIndex === "number",
  );
}

function decodeDraftItems(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ id: entry, name: entry }];
    if (!isRecord(entry) || typeof entry.id !== "string") return [];
    return [{ id: entry.id, name: typeof entry.name === "string" ? entry.name : undefined }];
  });
}

function decodePriorities(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([userId, priorities]) => [userId, stringArray(priorities)]),
  );
}

function decodeDraft(fields: Record<string, unknown>): AutoPickDraft | null {
  if (!Array.isArray(fields.participants)) return null;
  const participants: AutoPickParticipant[] = [];
  for (const rawParticipant of fields.participants) {
    const participant = decodeParticipant(rawParticipant);
    if (!participant) return null;
    participants.push(participant);
  }
  const history = decodeHistory(fields.history);
  const draftItems = decodeDraftItems(fields.draftItems);
  const currentPickIndex = Number(fields.currentPickIndex ?? 0);

  if (!Number.isInteger(currentPickIndex) || currentPickIndex < 0) return null;

  return {
    participants,
    pickOrder: numberArray(fields.pickOrder),
    currentPickIndex,
    availableItemIds: stringArray(fields.availableItemIds),
    draftItems,
    history,
    teamRanking: stringArray(fields.teamRanking),
    playerPriorities: decodePriorities(fields.playerPriorities),
  };
}

function participantUserIds(fields: Record<string, unknown>, privateFields?: DraftPrivateFields) {
  if (privateFields?.participants) {
    return privateFields.participants.flatMap((participant) =>
      typeof participant.userId === "string" ? [participant.userId] : [],
    );
  }
  return Array.isArray(fields.participants)
    ? fields.participants.flatMap((participant) =>
        isRecord(participant) && typeof participant.userId === "string" ? [participant.userId] : [],
      )
    : [];
}

function canRequestImmediatePick(
  fields: Record<string, unknown>,
  userId: string,
  privateFields?: DraftPrivateFields,
) {
  return (
    privateFields?.ownerUserId === userId ||
    fields.ownerUserId === userId ||
    participantUserIds(fields, privateFields).includes(userId)
  );
}

function asDocument(value: unknown): FirestoreDocument | null {
  return isRecord(value) && isRecord(value.document)
    ? (value.document as FirestoreDocument)
    : null;
}

function timestampMillis(value: unknown) {
  if (
    !isRecord(value) ||
    value.__firestoreTimestamp !== true ||
    typeof value.value !== "string"
  ) {
    return null;
  }

  const milliseconds = Date.parse(value.value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function encodedResourceName(name: string) {
  return name.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

async function postJson<T>(
  request: typeof fetch,
  url: string,
  accessToken: string,
  body: unknown,
  operation: string,
): Promise<T> {
  const response = await request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readJsonResponse<T>(response, operation);
}

async function listExpiredDrafts(
  request: typeof fetch,
  accessToken: string,
  projectId: string,
  now: number,
) {
  const endpoint = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`;
  const response = await request(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "publicDrafts" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "status" },
                  op: "EQUAL",
                  value: { stringValue: "drafting" },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: "turnDurationSeconds" },
                  op: "GREATER_THAN",
                  value: { integerValue: "0" },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: "turnStartedAt" },
                  op: "LESS_THAN_OR_EQUAL",
                  value: { timestampValue: new Date(now).toISOString() },
                },
              },
            ],
          },
        },
        orderBy: [
          { field: { fieldPath: "turnStartedAt" }, direction: "ASCENDING" },
          { field: { fieldPath: "turnDurationSeconds" }, direction: "ASCENDING" },
        ],
        select: {
          fields: [
            { fieldPath: "turnDurationSeconds" },
            { fieldPath: "turnStartedAt" },
          ],
        },
      },
    }),
  });
  const results = await readJsonStream(response, "Firestore expired-draft query");

  return results.flatMap((result) => {
    const document = asDocument(result);
    if (!document?.name || !isRecord(document.fields)) return [];

    const fields = decodeFirestoreFields(document.fields);
    const durationSeconds = Number(fields.turnDurationSeconds);
    const startedAt = timestampMillis(fields.turnStartedAt);
    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      startedAt === null ||
      startedAt + durationSeconds * 1000 > now
    ) {
      return [];
    }

    return [{ name: document.name }];
  });
}

async function rollbackTransaction(
  request: typeof fetch,
  baseUrl: string,
  accessToken: string,
  transaction: string,
) {
  try {
    await postJson(
      request,
      `${baseUrl}:rollback`,
      accessToken,
      { transaction },
      "Firestore transaction rollback",
    );
  } catch (error) {
    console.warn("Could not close a Firestore read transaction.", error);
  }
}

function buildPickWrite(documentName: string, draft: AutoPickUpdate, nextStatus: string) {
  const fields: Record<string, FirestoreValue> = {
    participants: encodeFirestoreValue(draft.participants),
    currentPickIndex: encodeFirestoreValue(draft.currentPickIndex),
    availableItemIds: encodeFirestoreValue(draft.availableItemIds),
    history: encodeFirestoreValue(draft.history),
    status: encodeFirestoreValue(nextStatus),
  };
  const fieldPaths = Object.keys(fields);
  if (nextStatus === "completed") {
    fieldPaths.push("turnStartedAt");
  }

  return {
    update: {
      name: documentName,
      fields,
    },
    updateMask: { fieldPaths },
    updateTransforms: [
      { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
      ...(nextStatus === "drafting"
        ? [{ fieldPath: "turnStartedAt", setToServerValue: "REQUEST_TIME" }]
        : []),
    ],
  };
}

async function processExpiredDraft(
  request: typeof fetch,
  baseUrl: string,
  accessToken: string,
  documentName: string,
  guard?: DraftPickGuard,
): Promise<DraftPickOutcome> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transactionResponse = await postJson<{ transaction?: string }>(
      request,
      `${baseUrl}:beginTransaction`,
      accessToken,
      { options: { readWrite: {} } },
      "Firestore begin transaction",
    );
    const transaction = transactionResponse.transaction;
    if (!transaction) {
      throw new Error("Firestore did not return a transaction ID.");
    }

    let transactionCommitted = false;
    let transactionAborted = false;
    try {
      const readResponse = await request(
        `https://firestore.googleapis.com/v1/${encodedResourceName(documentName)}?transaction=${encodeURIComponent(transaction)}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (readResponse.status === 404) {
        return { status: "missing" };
      }

      const document = await readJsonResponse<FirestoreDocument>(
        readResponse,
        "Firestore transactional document read",
      );
      if (!isRecord(document.fields)) {
        return { status: "invalid" };
      }

      const fields = decodeFirestoreFields(document.fields);
      const privateDocumentName = documentName.replace("/publicDrafts/", "/draftPrivate/");
      const privateDocument = await getFirestoreDocument(
        request,
        accessToken,
        privateDocumentName,
        transaction,
      );
      const privateFields = privateFieldsForDraft(fields, privateDocument);
      if (guard?.userId && !canRequestImmediatePick(fields, guard.userId, privateFields)) {
        return { status: "forbidden" };
      }
      if (fields.status !== "drafting") {
        return { status: "changed" };
      }
      if (
        guard?.expectedPickIndex !== undefined &&
        Number(fields.currentPickIndex ?? 0) !== guard.expectedPickIndex
      ) {
        return { status: "changed" };
      }

      const durationSeconds = Number(fields.turnDurationSeconds);
      const startedAt = timestampMillis(fields.turnStartedAt);
      if (
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        startedAt === null ||
        startedAt + durationSeconds * 1000 > Date.now()
      ) {
        return { status: "not-expired" };
      }

      const draft = decodeDraft(fields);
      if (!draft) {
        return { status: "invalid" };
      }
      const pickUpdate = buildAutomaticPickUpdate({
        ...draft,
        participants: draft.participants.map((participant, index) => ({
          ...participant,
          userId: privateFields.participants?.[index]?.userId ?? "",
          priorities: privateDocument ? undefined : participant.priorities,
        })),
        playerPriorities: privateFields.playerPriorities,
      });
      if (!pickUpdate) {
        if (getDraftStatusAfterPick(draft.availableItemIds) !== "completed") {
          return { status: "invalid" };
        }

        const completionFields = {
          status: encodeFirestoreValue("completed"),
          updatedAt: encodeFirestoreValue(new Date().toISOString()),
        };
        const completionResponse = await request(`${baseUrl}:commit`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            transaction,
            writes: [
              {
                update: { name: documentName, fields: { status: completionFields.status } },
                updateMask: { fieldPaths: ["status", "turnStartedAt"] },
                updateTransforms: [
                  { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
                ],
              },
            ],
          }),
        });
        if (completionResponse.status === 409) {
          transactionAborted = true;
          continue;
        }
        await readJsonResponse(completionResponse, "Firestore draft completion");
        transactionCommitted = true;
        return { status: "completed" };
      }

      pickUpdate.participants = draft.participants.map((participant, index) => ({
        ...participant,
        picks: pickUpdate.participants[index].picks,
      }));
      const commitResponse = await request(`${baseUrl}:commit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          transaction,
          writes: [buildPickWrite(documentName, pickUpdate, pickUpdate.status)],
        }),
      });
      if (commitResponse.status === 409) {
        transactionAborted = true;
        continue;
      }
      await readJsonResponse(commitResponse, "Firestore automatic pick commit");
      transactionCommitted = true;
      return {
        status: "picked",
        itemId: pickUpdate.history.at(-1)?.itemId,
        reason: pickUpdate.history.at(-1)?.autoPickReason,
        completed: pickUpdate.status === "completed",
      };
    } finally {
      if (!transactionCommitted && !transactionAborted) {
        await rollbackTransaction(request, baseUrl, accessToken, transaction);
      }
    }
  }

  return { status: "conflict" };
}

/**
 * Runs the automatic pick for a single draft on behalf of its signed-in owner or participant.
 * It reuses the same transactional logic as the Cron Trigger, so a turn can never
 * be picked twice even when both paths run at the same time.
 */
export async function runImmediateDraftPick(
  env: DraftWorkerEnv,
  params: { draftId: string; userId: string; expectedPickIndex?: number },
  request: typeof fetch = fetch,
): Promise<DraftPickOutcome> {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error("FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be configured.");
  }
  if (!params.userId) {
    return { status: "forbidden" };
  }
  if (!DRAFT_ID_PATTERN.test(params.draftId)) {
    return { status: "invalid" };
  }

  const accessToken = await getAccessToken(env, request);
  const documentsBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;
  const documentName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/publicDrafts/${params.draftId}`;

  return processExpiredDraft(request, documentsBaseUrl, accessToken, documentName, {
    userId: params.userId,
    expectedPickIndex: params.expectedPickIndex,
  });
}

export async function runExpiredDraftPicks(
  env: DraftWorkerEnv,
  request: typeof fetch = fetch,
): Promise<{ candidates: number; picked: number; completed: number; conflicts: number }> {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error("FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be configured.");
  }

  const now = Date.now();
  const accessToken = await getAccessToken(env, request);
  const documentsBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;
  const expiredDrafts = await listExpiredDrafts(request, accessToken, env.FIREBASE_PROJECT_ID, now);
  let picked = 0;
  let completed = 0;
  let conflicts = 0;

  for (const draft of expiredDrafts) {
    try {
      const result = await processExpiredDraft(
        request,
        documentsBaseUrl,
        accessToken,
        draft.name,
      );
      if (result.status === "picked") {
        picked += 1;
        console.info("Automatic draft pick committed.", {
          draft: draft.name,
          itemId: result.itemId,
          reason: result.reason,
          completed: result.completed,
        });
      } else if (result.status === "completed") {
        completed += 1;
      } else if (result.status === "conflict") {
        conflicts += 1;
        console.warn("Automatic pick conflicted with another draft update.", { draft: draft.name });
      } else if (result.status === "invalid") {
        console.error("Expired draft has invalid pick data and was not changed.", { draft: draft.name });
      }
    } catch (error) {
      console.error("Could not process an expired draft.", { draft: draft.name, error });
    }
  }

  return { candidates: expiredDrafts.length, picked, completed, conflicts };
}

export class FirestoreSecurityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type DraftPrivateParticipant = {
  userId?: string;
  email?: string;
  participantId?: string;
  participantPin?: string | null;
  joinedAt?: unknown;
  inviteHash?: string;
  invitationStatus?: "active" | "consumed" | "revoked";
};

type DraftPrivateFields = {
  ownerUserId?: string | null;
  participants?: DraftPrivateParticipant[];
  playerPriorities?: Record<string, string[]>;
};

type DraftTransactionContext = {
  accessToken: string;
  baseUrl: string;
  transaction: string;
  draftId: string;
  documentName: string;
  privateDocumentName: string;
  fields: Record<string, unknown>;
  privateFields: DraftPrivateFields;
};

type DraftTransactionResult = {
  writes?: unknown[];
  result: Record<string, unknown>;
};

type FirestoreDocumentWrite = {
  update: { name: string; fields: Record<string, FirestoreValue> };
  updateMask: { fieldPaths: string[] };
  updateTransforms?: Array<Record<string, unknown>>;
  currentDocument?: { exists: boolean };
};

const PRIVATE_PARTICIPANT_FIELDS = [
  "userId",
  "uid",
  "email",
  "participantId",
  "participantPin",
  "joinedAt",
  "inviteHash",
  "invitationStatus",
] as const;
const DRAFT_PUBLIC_UPDATE_FIELDS = new Set([
  "title",
  "sport",
  "code",
  "productId",
  "productName",
  "productSeason",
  "productPrice",
  "productImageUrl",
  "boxCount",
  "boxPrice",
  "boxes",
  "margin",
  "targetBreakPrice",
  "participantCount",
  "participants",
  "status",
  "currentPickIndex",
  "pickOrder",
  "draftItems",
  "availableItemIds",
  "history",
  "turnDurationSeconds",
  "teamRanking",
  "teamRankingLocked",
  "participantOrderDrawn",
]);
function documentResource(projectId: string, collection: string, id: string) {
  return `projects/${projectId}/databases/(default)/documents/${collection}/${id}`;
}

function firestoreDocumentsUrl(projectId: string) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

async function getFirestoreDocument(
  request: typeof fetch,
  accessToken: string,
  documentName: string,
  transaction?: string,
): Promise<FirestoreDocument | null> {
  const query = transaction ? `?transaction=${encodeURIComponent(transaction)}` : "";
  const response = await request(
    `https://firestore.googleapis.com/v1/${encodedResourceName(documentName)}${query}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (response.status === 404) return null;
  return readJsonResponse<FirestoreDocument>(response, "Firestore document read");
}

function plainValue(value: unknown): unknown {
  if (
    isRecord(value) &&
    value.__firestoreTimestamp === true &&
    typeof value.value === "string"
  ) {
    return value.value;
  }
  if (Array.isArray(value)) return value.map(plainValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, plainValue(entry)]),
    );
  }
  return value;
}

function participantUserId(participant: Record<string, unknown>): string {
  if (typeof participant.userId === "string" && participant.userId.trim()) {
    return participant.userId.trim();
  }
  return typeof participant.uid === "string" ? participant.uid.trim() : "";
}

function privateFromLegacyFields(fields: Record<string, unknown>): DraftPrivateFields {
  const participants = Array.isArray(fields.participants) ? fields.participants : [];
  return {
    ownerUserId: typeof fields.ownerUserId === "string" ? fields.ownerUserId : null,
    participants: participants.map((participant) => {
      if (!isRecord(participant)) return {};
      return {
        userId: participantUserId(participant),
        email: typeof participant.email === "string" ? participant.email : "",
        participantId: typeof participant.participantId === "string" ? participant.participantId : "",
        participantPin: typeof participant.participantPin === "string" ? participant.participantPin : null,
        joinedAt: participant.joinedAt,
      };
    }),
    playerPriorities: isRecord(fields.playerPriorities)
      ? decodePriorities(fields.playerPriorities)
      : {},
  };
}

function privateFieldsForDraft(
  documentFields: Record<string, unknown>,
  privateDocument: FirestoreDocument | null,
): DraftPrivateFields {
  if (privateDocument && isRecord(privateDocument.fields)) {
    const stored = decodeFirestoreFields(privateDocument.fields);
    return {
      ownerUserId: typeof stored.ownerUserId === "string" ? stored.ownerUserId : null,
      participants: Array.isArray(stored.participants)
        ? stored.participants.filter(isRecord).map((participant) => ({
            ...participant,
            userId: participantUserId(participant),
          }))
        : [],
      playerPriorities: decodePriorities(stored.playerPriorities),
    };
  }
  return privateFromLegacyFields(documentFields);
}

function stripPrivateParticipantFields(participant: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(participant).filter(([key]) =>
      !(PRIVATE_PARTICIPANT_FIELDS as readonly string[]).includes(key),
    ),
  );
}

function visibleDraftParticipants(
  fields: Record<string, unknown>,
  privateFields: DraftPrivateFields,
  userId: string,
  role: "owner" | "admin" | "participant" | "none",
) {
  const publicParticipants = Array.isArray(fields.participants) ? fields.participants : [];
  const privateParticipants = privateFields.participants ?? [];
  return publicParticipants.map((participant, index) => {
    const publicValue = isRecord(participant) ? participant : {};
    const privateValue = privateParticipants[index] ?? {};
    if (role === "owner" || role === "admin" || privateValue.userId === userId) {
      const visiblePrivateValue = Object.fromEntries(
        Object.entries(privateValue).filter(([key]) => key !== "inviteHash"),
      );
      return plainValue({
        ...publicValue,
        ...visiblePrivateValue,
        userId: privateValue.userId ?? "",
        uid: privateValue.userId ?? "",
        email: privateValue.email ?? "",
        participantId: privateValue.participantId ?? "",
        participantPin: privateValue.participantPin ?? null,
        joinedAt: privateValue.joinedAt ?? null,
        invitationStatus: privateValue.invitationStatus,
      });
    }
    return plainValue(stripPrivateParticipantFields(publicValue));
  });
}

function sameSecurityValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date) return sameSecurityValue(left.toISOString(), right);
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameSecurityValue(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  if (
    left.__firestoreTimestamp === true &&
    typeof left.value === "string" &&
    typeof right.seconds === "number"
  ) {
    const leftMillis = Date.parse(left.value);
    const rightMillis = right.seconds * 1000 + Number(right.nanoseconds ?? 0) / 1_000_000;
    return leftMillis === rightMillis;
  }
  if (
    right.__firestoreTimestamp === true &&
    typeof right.value === "string" &&
    typeof left.seconds === "number"
  ) {
    return sameSecurityValue(right, left);
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return sameSecurityValue(leftKeys, rightKeys) &&
    leftKeys.every((key) => sameSecurityValue(left[key], right[key]));
}

function requireRecord(value: unknown, message = "Invalid request.") {
  if (!isRecord(value)) throw new FirestoreSecurityError(400, message);
  return value;
}

function requireString(value: unknown, field: string, maxLength = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new FirestoreSecurityError(400, `Invalid ${field}.`);
  }
  return value;
}

async function getUserProfile(
  request: typeof fetch,
  accessToken: string,
  projectId: string,
  uid: string,
) {
  const document = await getFirestoreDocument(
    request,
    accessToken,
    documentResource(projectId, "users", uid),
  );
  return document?.fields ? decodeFirestoreFields(document.fields) : null;
}

function isAdminProfile(profile: Record<string, unknown> | null) {
  return profile?.role === "admin";
}

async function getDraftTransactionContext(
  request: typeof fetch,
  projectId: string,
  accessToken: string,
  draftId: string,
  transaction: string,
): Promise<DraftTransactionContext | null> {
  const documentName = documentResource(projectId, "publicDrafts", draftId);
  const privateDocumentName = documentResource(projectId, "draftPrivate", draftId);
  const [document, privateDocument] = await Promise.all([
    getFirestoreDocument(request, accessToken, documentName, transaction),
    getFirestoreDocument(request, accessToken, privateDocumentName, transaction),
  ]);
  if (!document?.fields || !isRecord(document.fields)) return null;
  const fields = decodeFirestoreFields(document.fields);
  return {
    accessToken,
    baseUrl: firestoreDocumentsUrl(projectId),
    transaction,
    draftId,
    documentName,
    privateDocumentName,
    fields,
    privateFields: privateFieldsForDraft(fields, privateDocument),
  };
}

async function runDraftTransaction(
  request: typeof fetch,
  projectId: string,
  accessToken: string,
  draftId: string,
  operation: (context: DraftTransactionContext) => Promise<DraftTransactionResult>,
) {
  const baseUrl = firestoreDocumentsUrl(projectId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = await postJson<{ transaction?: string }>(
      request,
      `${baseUrl}:beginTransaction`,
      accessToken,
      { options: { readWrite: {} } },
      "Firestore begin transaction",
    );
    if (!started.transaction) throw new Error("Firestore did not return a transaction ID.");
    const transaction = started.transaction;
    let committed = false;
    let aborted = false;
    try {
      const context = await getDraftTransactionContext(
        request,
        projectId,
        accessToken,
        draftId,
        transaction,
      );
      if (!context) throw new FirestoreSecurityError(404, "Draft not found.");
      const outcome = await operation(context);
      if (!outcome.writes?.length) {
        return outcome.result;
      }

      const response = await request(`${baseUrl}:commit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ transaction, writes: outcome.writes }),
      });
      if (response.status === 409) {
        aborted = true;
        continue;
      }
      await readJsonResponse(response, "Firestore secure operation commit");
      committed = true;
      return outcome.result;
    } finally {
      if (!committed && !aborted) {
        await rollbackTransaction(request, baseUrl, accessToken, transaction);
      }
    }
  }
  throw new FirestoreSecurityError(409, "The draft changed during the operation.");
}

function documentUpdateWrite(
  name: string,
  fields: Record<string, unknown>,
  fieldPaths = Object.keys(fields),
  transforms: Array<Record<string, unknown>> = [],
): FirestoreDocumentWrite {
  return {
    update: {
      name,
      fields: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, encodeFirestoreValue(value)]),
      ),
    },
    updateMask: { fieldPaths },
    ...(transforms.length ? { updateTransforms: transforms } : {}),
  };
}

function serverTimestampTransform(fieldPath: string) {
  return { fieldPath, setToServerValue: "REQUEST_TIME" };
}

function participantParts(
  incoming: unknown,
  previous: DraftPrivateParticipant[] = [],
) {
  if (!Array.isArray(incoming) || incoming.length > 100) {
    throw new FirestoreSecurityError(400, "Invalid participant list.");
  }

  const publicParticipants: Record<string, unknown>[] = [];
  const privateParticipants: DraftPrivateParticipant[] = [];
  const previousById = new Map(
    previous
      .filter((participant) => typeof participant.participantId === "string")
      .map((participant) => [participant.participantId as string, participant]),
  );
  for (let index = 0; index < incoming.length; index += 1) {
    const participant = requireRecord(incoming[index], "Invalid participant.");
    const participantId = typeof participant.participantId === "string"
      ? participant.participantId
      : typeof participant.id === "string"
        ? participant.id
        : "";
    const oldPrivate = previousById.get(participantId) ?? previous[index] ?? {};
    const userIdValue = participant.userId === ""
      ? participant.uid ?? ""
      : participant.userId ?? participant.uid ?? oldPrivate.userId ?? "";
    if (typeof userIdValue !== "string" || userIdValue.length > 128) {
      throw new FirestoreSecurityError(400, "Invalid participant user ID.");
    }

    const userId = participantUserId({ ...participant, userId: userIdValue });
    const privateParticipant: DraftPrivateParticipant = {
      userId,
      email: typeof participant.email === "string" ? participant.email : oldPrivate.email ?? "",
      participantId: typeof participant.participantId === "string"
        ? participant.participantId
        : oldPrivate.participantId ?? (typeof participant.id === "string" ? participant.id : ""),
      participantPin: typeof participant.participantPin === "string"
        ? participant.participantPin
        : oldPrivate.participantPin ?? null,
      joinedAt: participant.joinedAt ?? oldPrivate.joinedAt ?? null,
      ...(oldPrivate.inviteHash ? { inviteHash: oldPrivate.inviteHash } : {}),
      ...(oldPrivate.invitationStatus ? { invitationStatus: oldPrivate.invitationStatus } : {}),
    };
    publicParticipants.push(stripPrivateParticipantFields(participant));
    privateParticipants.push(privateParticipant);
  }
  return { publicParticipants, privateParticipants };
}

async function resolveParticipantEmails(
  request: typeof fetch,
  accessToken: string,
  projectId: string,
  incoming: DraftPrivateParticipant[],
  previous: DraftPrivateParticipant[],
) {
  const resolved: DraftPrivateParticipant[] = [];
  for (let index = 0; index < incoming.length; index += 1) {
    const participant = incoming[index];
    const userId = participant.userId?.trim() ?? "";
    if (!userId) {
      resolved.push({ ...participant, email: "", joinedAt: participant.joinedAt ?? null });
      continue;
    }
    const oldUserId = previous[index]?.userId?.trim() ?? "";
    if (userId === oldUserId) {
      // The slot keeps the email stored when the player joined, claimed an
      // invitation, or was assigned with the exact address already known.
      resolved.push({ ...participant, email: previous[index]?.email ?? "" });
      continue;
    }
    const profile = await getUserProfile(request, accessToken, projectId, userId);
    if (!profile) {
      throw new FirestoreSecurityError(400, "Participant must be an existing user.");
    }
    // Never resolve a profile email through an owner-side assignment: keep it
    // only when the caller already supplied the exact matching address, so an
    // assignment cannot be used as a uid-to-email oracle.
    const profileEmail = typeof profile.email === "string" ? profile.email.trim() : "";
    const claimedEmail = typeof participant.email === "string" ? participant.email.trim() : "";
    resolved.push({
      ...participant,
      email: profileEmail && claimedEmail.toLowerCase() === profileEmail.toLowerCase()
        ? profileEmail
        : "",
    });
  }
  return resolved;
}

function ownerOrAdmin(
  context: Pick<DraftTransactionContext, "privateFields">,
  actorId: string,
  isGlobalAdmin: boolean,
) {
  const ownerId = context.privateFields.ownerUserId;
  if (ownerId === actorId) return "owner";
  if (isGlobalAdmin) return "admin";
  return null;
}

function participantIndexForUser(context: Pick<DraftTransactionContext, "privateFields">, actorId: string) {
  const privateParticipants = context.privateFields.participants ?? [];
  return privateParticipants.findIndex((participant) => participant.userId === actorId);
}

function draftPrivateWrite(
  context: DraftTransactionContext,
  privateFields: DraftPrivateFields,
) {
  return documentUpdateWrite(
    context.privateDocumentName,
    {
      ownerUserId: privateFields.ownerUserId ?? null,
      participants: privateFields.participants ?? [],
      playerPriorities: privateFields.playerPriorities ?? {},
    },
    ["ownerUserId", "participants", "playerPriorities"],
  );
}

function validateExpectedDraftState(
  context: DraftTransactionContext,
  expected: unknown,
) {
  if (expected === undefined) return;
  const expectedFields = requireRecord(expected, "Invalid expected draft state.");
  const current: Record<string, unknown> = {
    ...context.fields,
    participants: visibleDraftParticipants(
      context.fields,
      context.privateFields,
      "",
      "owner",
    ),
  };
  if (current.teamRanking === undefined) current.teamRanking = [];
  if (current.participantOrderDrawn === undefined) current.participantOrderDrawn = false;
  for (const [field, value] of Object.entries(expectedFields)) {
    if (!DRAFT_PUBLIC_UPDATE_FIELDS.has(field) || !sameSecurityValue(current[field], value)) {
      throw new FirestoreSecurityError(409, "The draft changed during the operation.");
    }
  }
}

async function createDraft(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    if (!DRAFT_ID_PATTERN.test(draftId)) throw new FirestoreSecurityError(400, "Invalid draft ID.");
    const source = requireRecord(body.data, "Invalid draft data.");
    const draftSport = getProductSport(source.sport);
    if (!draftSport) throw new FirestoreSecurityError(400, "Unsupported draft sport.");
    const validateRoster = source.sport !== undefined ||
      (Array.isArray(source.draftItems) && source.draftItems.length === canonicalTeamIds("NHL").length);
    if (validateRoster) {
      validateDraftRoster(source, draftSport);
      if (source.teamRanking !== undefined && !isCompleteTeamOrder(source.teamRanking, draftSport)) {
        throw new FirestoreSecurityError(400, "The team ranking does not match the draft sport.");
      }
      if (source.availableItemIds !== undefined && !isCompleteTeamOrder(source.availableItemIds, draftSport)) {
        throw new FirestoreSecurityError(400, "The available teams do not match the draft sport.");
      }
      if (source.pickOrder !== undefined && (
        !Array.isArray(source.pickOrder) ||
        source.pickOrder.length !== canonicalTeamIds(draftSport).length ||
        source.pickOrder.some((index) =>
          !Number.isInteger(index) ||
          Number(index) < 0 ||
          (Array.isArray(source.participants) && Number(index) >= source.participants.length)
        )
      )) {
        throw new FirestoreSecurityError(400, "The pick order does not match the draft roster.");
      }
    }
    if (source.sport !== undefined && (!Array.isArray(source.boxes) || source.boxes.length === 0)) {
      throw new FirestoreSecurityError(400, "At least one box is required for a new draft.");
    }
    const profile = await getUserProfile(request, accessToken, projectId, actorId);
    if (!profile) throw new FirestoreSecurityError(403, "A user profile is required.");

    const participants = Array.isArray(source.participants) ? source.participants : [];
    const { publicParticipants, privateParticipants } = participantParts(participants);
    const resolvedPrivateParticipants = await resolveParticipantEmails(
      request,
      accessToken,
      projectId,
      privateParticipants,
      [],
    );
    const publicFields = Object.fromEntries(
      Object.entries(source).filter(([key]) =>
        key !== "ownerUserId" &&
        key !== "playerPriorities" &&
        key !== "createdAt" &&
        key !== "updatedAt" &&
        key !== "participants",
      ),
    );
    Object.assign(publicFields, {
      code: draftId,
      participants: publicParticipants,
      privacyVersion: 1,
    });
    const privateFields: DraftPrivateFields = {
      ownerUserId: actorId,
      participants: resolvedPrivateParticipants,
      playerPriorities: {},
    };
    const baseUrl = firestoreDocumentsUrl(projectId);
    const publicName = documentResource(projectId, "publicDrafts", draftId);
    const privateName = documentResource(projectId, "draftPrivate", draftId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = await postJson<{ transaction?: string }>(
        request,
        `${baseUrl}:beginTransaction`,
        accessToken,
        { options: { readWrite: {} } },
        "Firestore begin transaction",
      );
      if (!started.transaction) throw new Error("Firestore did not return a transaction ID.");
      const transaction = started.transaction;
      let committed = false;
      let aborted = false;
      try {
        const [existingPublic, existingPrivate] = await Promise.all([
          getFirestoreDocument(request, accessToken, publicName, transaction),
          getFirestoreDocument(request, accessToken, privateName, transaction),
        ]);
        if (existingPublic || existingPrivate) {
          throw new FirestoreSecurityError(409, "Draft ID is already in use.");
        }
        if (source.sport !== undefined && Array.isArray(source.boxes)) {
          const boxProductIds = source.boxes.map((box) =>
            isRecord(box) && typeof box.productId === "string" ? box.productId : "",
          );
          if (boxProductIds.some((productId) => !productId)) {
            throw new FirestoreSecurityError(400, "Every draft box must reference a product.");
          }
          await Promise.all([...new Set(boxProductIds)].map(async (productId) => {
            const product = await getFirestoreDocument(
              request,
              accessToken,
              documentResource(projectId, "products", productId),
              transaction,
            );
            if (!product?.fields || !isRecord(product.fields)) {
              throw new FirestoreSecurityError(400, "A selected box no longer exists.");
            }
            const fields = decodeFirestoreFields(product.fields);
            if (fields.active !== true || getProductSport(fields.sport) !== draftSport) {
              throw new FirestoreSecurityError(400, "Every selected box must be active and match the draft sport.");
            }
          }));
          if (source.boxes.some((box) => isRecord(box) && box.sport !== undefined && box.sport !== draftSport)) {
            throw new FirestoreSecurityError(400, "Draft boxes cannot mix sports.");
          }
        }

        const writes = [
          {
            ...documentUpdateWrite(
              publicName,
              publicFields,
              Object.keys(publicFields).concat(["createdAt", "updatedAt"]),
              [serverTimestampTransform("createdAt"), serverTimestampTransform("updatedAt")],
            ),
            currentDocument: { exists: false },
          },
          {
            ...documentUpdateWrite(
              privateName,
              privateFields as unknown as Record<string, unknown>,
              ["ownerUserId", "participants", "playerPriorities"],
            ),
            currentDocument: { exists: false },
          },
        ];
        const response = await request(`${baseUrl}:commit`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ transaction, writes }),
        });
        if (response.status === 409) {
          aborted = true;
          continue;
        }
        await readJsonResponse(response, "Firestore draft creation");
        committed = true;
        return { draftId };
      } finally {
        if (!committed && !aborted) {
          await rollbackTransaction(request, baseUrl, accessToken, transaction);
        }
      }
    }
    throw new FirestoreSecurityError(409, "Could not reserve a unique draft ID.");
  }

let chatAuthorKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

/**
 * Derives an opaque, per-draft author identifier for public chat messages so
 * the raw Firebase UID never appears in publicly readable documents. The HMAC
 * secret keeps the identifier unlinkable to a uid without server access.
 */
async function chatAuthorId(env: DraftWorkerEnv, draftId: string, userId: string) {
  const secret = env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "";
  if (!chatAuthorKeyCache || chatAuthorKeyCache.secret !== secret) {
    chatAuthorKeyCache = {
      secret,
      key: crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    };
  }
  const signature = await crypto.subtle.sign(
    "HMAC",
    await chatAuthorKeyCache.key,
    new TextEncoder().encode(`chat-author:${draftId}:${userId}`),
  );
  return base64UrlEncode(new Uint8Array(signature)).slice(0, 22);
}

  async function loadDraftForAccess(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    draftId: string,
  ) {
    const [document, privateDocument] = await Promise.all([
      getFirestoreDocument(request, accessToken, documentResource(projectId, "publicDrafts", draftId)),
      getFirestoreDocument(request, accessToken, documentResource(projectId, "draftPrivate", draftId)),
    ]);
    if (!document?.fields || !isRecord(document.fields)) {
      throw new FirestoreSecurityError(404, "Draft not found.");
    }
    const fields = decodeFirestoreFields(document.fields);
    return { fields, privateFields: privateFieldsForDraft(fields, privateDocument) };
  }

  async function getDraftAccess(
    request: typeof fetch,
    env: DraftWorkerEnv,
    projectId: string,
    accessToken: string,
    actorId: string,
    draftId: string,
  ) {
    const [{ fields, privateFields }, profile] = await Promise.all([
      loadDraftForAccess(request, projectId, accessToken, draftId),
      getUserProfile(request, accessToken, projectId, actorId),
    ]);
    const admin = isAdminProfile(profile);
    const ownerId = privateFields.ownerUserId;
    const index = participantIndexForUser(
      { fields, privateFields } as DraftTransactionContext,
      actorId,
    );
    const role = ownerId === actorId
      ? "owner"
      : admin
        ? "admin"
        : index >= 0
          ? "participant"
          : "none";
    return {
      role,
      authorized: role !== "none",
      participantIndex: index >= 0 ? index : null,
      participants: visibleDraftParticipants(fields, privateFields, actorId, role),
      playerPriorities: index >= 0
        ? privateFields.playerPriorities?.[actorId] ?? []
        : [],
      chatAuthorId: await chatAuthorId(env, draftId, actorId),
    };
  }

  const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

  async function hashInviteToken(value: unknown) {
    const token = requireString(value, "invitation token", 128);
    if (!INVITE_TOKEN_PATTERN.test(token)) {
      throw new FirestoreSecurityError(400, "Invalid invitation token.");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return base64UrlEncode(new Uint8Array(digest));
  }

  function invitationParticipantIds(value: unknown) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > 100 ||
      value.some((participantId) =>
        typeof participantId !== "string" || participantId.length === 0 || participantId.length > 128,
      )
    ) {
      return null;
    }
    const participantIds = value as string[];
    return new Set(participantIds).size === participantIds.length ? participantIds : null;
  }

  function getInvitationParticipantIndexes(
    invitation: Record<string, unknown>,
    draftId: string,
    participants: unknown[],
  ) {
    if (invitation.draftId !== draftId) return null;
    const participantIds = invitationParticipantIds(invitation.participantIds);
    if (!participantIds) return null;
    const indexes = participantIds.map((participantId) =>
      participants.findIndex((participant) => isRecord(participant) && participant.id === participantId),
    );
    return indexes.every((index) => index >= 0) ? indexes : null;
  }

  async function previewDraftInvitation(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    body: Record<string, unknown>,
  ) {
    const inviteHash = await hashInviteToken(body.token);
    const document = await getFirestoreDocument(
      request,
      accessToken,
      documentResource(projectId, "draftInvites", inviteHash),
    );
    const invitation = document?.fields ? decodeFirestoreFields(document.fields) : null;
    if (!invitation) return { status: "invalid" };
    if (invitation.status === "consumed") return { status: "used" };
    if (
      invitation.status !== "active" ||
      typeof invitation.draftId !== "string" ||
      !DRAFT_ID_PATTERN.test(invitation.draftId)
    ) {
      return { status: "invalid" };
    }

    let loaded: Awaited<ReturnType<typeof loadDraftForAccess>>;
    try {
      loaded = await loadDraftForAccess(request, projectId, accessToken, invitation.draftId);
    } catch (error) {
      if (error instanceof FirestoreSecurityError && error.status === 404) {
        return { status: "invalid" };
      }
      throw error;
    }
    const participants = Array.isArray(loaded.fields.participants) ? loaded.fields.participants : [];
    if (loaded.fields.status === "completed") return { status: "invalid" };
    const indexes = getInvitationParticipantIndexes(invitation, invitation.draftId, participants);
    if (!indexes) return { status: "invalid" };
    const publicParticipants = participants.filter(isRecord);
    if (indexes.some((index) => {
      const participant = publicParticipants[index];
      const privateParticipant = loaded.privateFields.participants?.[index];
      return (
        privateParticipant?.inviteHash !== inviteHash ||
        privateParticipant?.userId ||
        participant.status !== "pending-registration"
      );
    })) {
      return { status: "invalid" };
    }

    return {
      status: "active",
      draftId: invitation.draftId,
      draftTitle: typeof loaded.fields.title === "string" ? loaded.fields.title : "Draft",
      participants: indexes.map((index) => {
        const participant = publicParticipants[index];
        return {
          id: String(participant.id),
          name: String(participant.displayName ?? participant.name ?? "Účastník"),
        };
      }),
    };
  }

  async function createDraftInvitation(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    if (!DRAFT_ID_PATTERN.test(draftId)) throw new FirestoreSecurityError(400, "Invalid draft ID.");
    const participantIds = invitationParticipantIds(body.participantIds);
    if (!participantIds) throw new FirestoreSecurityError(400, "Select one or more valid participant positions.");

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = base64UrlEncode(tokenBytes);
    const inviteHash = await hashInviteToken(token);
    const inviteDocumentName = documentResource(projectId, "draftInvites", inviteHash);

    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      if (!ownerOrAdmin(context, actorId, isGlobalAdmin)) {
        throw new FirestoreSecurityError(403, "Only the owner or a global administrator may create invitations.");
      }
      if (context.fields.status === "completed") {
        throw new FirestoreSecurityError(409, "This draft is already completed.");
      }

      const participants = Array.isArray(context.fields.participants)
        ? context.fields.participants.filter(isRecord)
        : [];
      const indexes = participantIds.map((participantId) =>
        participants.findIndex((participant) => participant.id === participantId),
      );
      if (indexes.some((index) => index < 0)) {
        throw new FirestoreSecurityError(409, "A selected participant position no longer exists.");
      }
      const privateParticipants = context.privateFields.participants ?? [];
      if (indexes.some((index) =>
        participants[index].status !== "pending-registration" ||
        Boolean(privateParticipants[index]?.userId),
      )) {
        throw new FirestoreSecurityError(409, "Only unclaimed registration positions can be invited.");
      }

      const oldHashes = new Set(
        indexes
          .map((index) => privateParticipants[index]?.inviteHash)
          .filter((hash): hash is string => typeof hash === "string" && hash.length > 0),
      );
      const oldInvitations = await Promise.all([...oldHashes].map(async (hash) => ({
        hash,
        document: await getFirestoreDocument(
          request,
          accessToken,
          documentResource(projectId, "draftInvites", hash),
          context.transaction,
        ),
      })));
      const nextPrivateParticipants = privateParticipants.map((participant) =>
        participant.inviteHash && oldHashes.has(participant.inviteHash)
          ? {
              ...participant,
              inviteHash: "",
              invitationStatus: "revoked" as const,
            }
          : { ...participant },
      );
      for (const index of indexes) {
        nextPrivateParticipants[index] = {
          ...nextPrivateParticipants[index],
          inviteHash,
          invitationStatus: "active",
        };
      }

      const writes: unknown[] = oldInvitations
        .filter(({ document }) => document?.fields)
        .map(({ hash, document }) => {
          const oldInvitation = decodeFirestoreFields(document?.fields ?? {});
          return oldInvitation.status === "active"
            ? documentUpdateWrite(
                documentResource(projectId, "draftInvites", hash),
                { status: "revoked" },
                ["status", "updatedAt"],
                [serverTimestampTransform("updatedAt")],
              )
            : null;
        })
        .filter((write): write is NonNullable<typeof write> => write !== null);
      writes.push(
        draftPrivateWrite(context, {
          ...context.privateFields,
          participants: nextPrivateParticipants,
        }),
        documentUpdateWrite(
          context.documentName,
          { privacyVersion: 1 },
          ["privacyVersion", "updatedAt"],
          [serverTimestampTransform("updatedAt")],
        ),
        {
          ...documentUpdateWrite(
            inviteDocumentName,
            {
              draftId,
              participantIds,
              status: "active",
              createdBy: actorId,
            },
            ["draftId", "participantIds", "status", "createdBy", "createdAt"],
            [serverTimestampTransform("createdAt")],
          ),
          currentDocument: { exists: false },
        },
      );
      return {
        writes,
        result: { status: "created", token },
      };
    });
  }

  async function revokeDraftInvitation(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    const participantId = requireString(body.participantId, "participant ID", 128);
    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      if (!ownerOrAdmin(context, actorId, isGlobalAdmin)) {
        throw new FirestoreSecurityError(403, "Only the owner or a global administrator may revoke invitations.");
      }
      const targetIndex = (context.privateFields.participants ?? []).findIndex(
        (participant) => participant.participantId === participantId,
      );
      const inviteHash = context.privateFields.participants?.[targetIndex]?.inviteHash;
      if (targetIndex < 0 || !inviteHash) return { result: { status: "missing" } };

      const inviteDocument = await getFirestoreDocument(
        request,
        accessToken,
        documentResource(projectId, "draftInvites", inviteHash),
        context.transaction,
      );
      const invitation = inviteDocument?.fields
        ? decodeFirestoreFields(inviteDocument.fields)
        : null;
      if (invitation?.status === "consumed") return { result: { status: "used" } };

      const nextPrivateParticipants = (context.privateFields.participants ?? []).map((participant) =>
        participant.inviteHash === inviteHash
          ? {
              ...participant,
              inviteHash: "",
              invitationStatus: "revoked" as const,
            }
          : { ...participant },
      );
      const writes: unknown[] = [
        draftPrivateWrite(context, {
          ...context.privateFields,
          participants: nextPrivateParticipants,
        }),
        documentUpdateWrite(
          context.documentName,
          { privacyVersion: 1 },
          ["privacyVersion", "updatedAt"],
          [serverTimestampTransform("updatedAt")],
        ),
      ];
      if (invitation?.status === "active") {
        writes.push(
          documentUpdateWrite(
            documentResource(projectId, "draftInvites", inviteHash),
            { status: "revoked" },
            ["status", "updatedAt"],
            [serverTimestampTransform("updatedAt")],
          ),
        );
      }
      return { writes, result: { status: "revoked" } };
    });
  }

  async function claimDraftInvitation(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actor: { uid: string; email?: string },
    body: Record<string, unknown>,
  ) {
    const profile = await getUserProfile(request, accessToken, projectId, actor.uid);
    if (!profile) throw new FirestoreSecurityError(403, "A user profile is required.");
    const inviteHash = await hashInviteToken(body.token);
    const inviteDocumentName = documentResource(projectId, "draftInvites", inviteHash);
    const initialDocument = await getFirestoreDocument(request, accessToken, inviteDocumentName);
    const initialInvitation = initialDocument?.fields
      ? decodeFirestoreFields(initialDocument.fields)
      : null;
    if (!initialInvitation) return { status: "invalid" };
    if (initialInvitation.status === "consumed") return { status: "used" };
    if (
      initialInvitation.status !== "active" ||
      typeof initialInvitation.draftId !== "string" ||
      !DRAFT_ID_PATTERN.test(initialInvitation.draftId)
    ) {
      return { status: "invalid" };
    }

    return runDraftTransaction(
      request,
      projectId,
      accessToken,
      initialInvitation.draftId,
      async (context) => {
        const inviteDocument = await getFirestoreDocument(
          request,
          accessToken,
          inviteDocumentName,
          context.transaction,
        );
        const invitation = inviteDocument?.fields
          ? decodeFirestoreFields(inviteDocument.fields)
          : null;
        if (!invitation) return { result: { status: "invalid" } };
        if (invitation.status === "consumed") return { result: { status: "used" } };
        if (
          invitation.status !== "active" ||
          invitation.draftId !== context.draftId ||
          context.fields.status === "completed"
        ) {
          return { result: { status: "invalid" } };
        }

        const participants = Array.isArray(context.fields.participants)
          ? context.fields.participants.filter(isRecord)
          : [];
        const indexes = getInvitationParticipantIndexes(invitation, invitation.draftId as string, participants);
        const privateParticipants = context.privateFields.participants ?? [];
        if (!indexes || indexes.some((index) =>
          privateParticipants[index]?.inviteHash !== inviteHash ||
          Boolean(privateParticipants[index]?.userId) ||
          participants[index].status !== "pending-registration",
        )) {
          return { result: { status: "invalid" } };
        }

        const nextParticipants = participants.map((participant, index) =>
          indexes.includes(index)
            ? { ...participant, status: "ready" }
            : participant,
        );
        const nextPrivateParticipants = privateParticipants.map((participant, index) =>
          indexes.includes(index)
            ? {
                ...participant,
                userId: actor.uid,
                email: actor.email ?? "",
                joinedAt: new Date().toISOString(),
                invitationStatus: "consumed" as const,
              }
            : { ...participant },
        );
        return {
          writes: [
            documentUpdateWrite(
              context.documentName,
              { participants: nextParticipants, privacyVersion: 1 },
              ["participants", "privacyVersion", "updatedAt"],
              [serverTimestampTransform("updatedAt")],
            ),
            draftPrivateWrite(context, {
              ...context.privateFields,
              participants: nextPrivateParticipants,
            }),
            documentUpdateWrite(
              inviteDocumentName,
              { status: "consumed", usedBy: actor.uid },
              ["status", "usedBy", "usedAt"],
              [serverTimestampTransform("usedAt")],
            ),
          ],
          result: {
            status: "claimed",
            draftId: context.draftId,
            participantIds: indexes.map((index) => participants[index].id),
          },
        };
      },
    );
  }

  async function joinDraft(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actor: { uid: string; email?: string },
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    const profile = await getUserProfile(request, accessToken, projectId, actor.uid);
    if (!profile) throw new FirestoreSecurityError(403, "A user profile is required.");
    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      const alreadyAssigned = participantIndexForUser(context, actor.uid);
      if (alreadyAssigned >= 0) return { result: { status: "joined" } };
      if (context.fields.status !== "waiting") {
        throw new FirestoreSecurityError(409, "This draft is no longer accepting participants.");
      }

      const displayName = typeof profile.displayName === "string" ? profile.displayName.trim() : "";
      const participants = Array.isArray(context.fields.participants)
        ? context.fields.participants.filter(isRecord)
        : [];
      const privateParticipants = context.privateFields.participants ?? [];
      const slotIndex = participants.findIndex((participant, index) =>
        (participant.status ?? "waiting") === "waiting" &&
        !(privateParticipants[index]?.userId ?? ""),
      );
      if (slotIndex < 0) {
        throw new FirestoreSecurityError(403, "No open participant position is available.");
      }

      const nextParticipants = participants.map((participant, index) =>
        index === slotIndex
          ? {
              ...participant,
              name: String(participant.name || displayName || `Účastník ${slotIndex + 1}`),
              displayName: String(participant.displayName || participant.name || displayName || `Účastník ${slotIndex + 1}`),
              status: "ready",
            }
          : participant,
      );
      const nextPrivateParticipants = [...privateParticipants];
      nextPrivateParticipants[slotIndex] = {
        ...nextPrivateParticipants[slotIndex],
        userId: actor.uid,
        email: actor.email ?? "",
        joinedAt: new Date().toISOString(),
      };
      return {
        writes: [
          documentUpdateWrite(
            context.documentName,
            { participants: nextParticipants, privacyVersion: 1 },
            ["participants", "privacyVersion", "updatedAt"],
            [serverTimestampTransform("updatedAt")],
          ),
          draftPrivateWrite(context, {
            ...context.privateFields,
            participants: nextPrivateParticipants,
          }),
        ],
        result: { status: "joined", participantIndex: slotIndex },
      };
    });
  }

  async function updateDraft(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    if (!DRAFT_ID_PATTERN.test(draftId)) throw new FirestoreSecurityError(400, "Invalid draft ID.");
    const updates = requireRecord(body.updates, "Invalid draft update.");

    for (const key of Object.keys(updates)) {
      if (!DRAFT_PUBLIC_UPDATE_FIELDS.has(key) || key === "participantOrderDrawn" || key === "currentPickIndex") {
        throw new FirestoreSecurityError(400, `Draft field cannot be changed: ${key}.`);
      }
    }

    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      if (!ownerOrAdmin(context, actorId, isGlobalAdmin)) {
        throw new FirestoreSecurityError(403, "Only the owner or a global administrator may edit this draft.");
      }
      validateExpectedDraftState(context, body.expected);
      if (updates.teamRanking !== undefined && hasCanonicalDraftRoster(context.fields)) {
        const sport = getProductSport(context.fields.sport);
        if (!sport || !isCompleteTeamOrder(updates.teamRanking, sport)) {
          throw new FirestoreSecurityError(400, "The team ranking does not match the draft sport.");
        }
      }

      const options = isRecord(body.options) ? body.options : {};
      const currentStatus = typeof context.fields.status === "string" ? context.fields.status : "waiting";
      const currentHistory = Array.isArray(context.fields.history) ? context.fields.history : [];
      if (updates.history !== undefined && (
        !Array.isArray(updates.history) ||
        updates.history.length < currentHistory.length ||
        !sameSecurityValue(updates.history.slice(0, currentHistory.length), currentHistory)
      )) {
        throw new FirestoreSecurityError(409, "Draft history cannot be rewound or overwritten.");
      }
      if (
        Array.isArray(updates.history) &&
        updates.history.slice(currentHistory.length).some((entry) => isRecord(entry) && entry.type === "pick")
      ) {
        throw new FirestoreSecurityError(400, "Draft picks must use the authenticated participant pick operation.");
      }
      if (updates.availableItemIds !== undefined && (
        !Array.isArray(updates.availableItemIds) ||
        updates.availableItemIds.length > (Array.isArray(context.fields.availableItemIds) ? context.fields.availableItemIds.length : 0)
      )) {
        throw new FirestoreSecurityError(409, "Picked teams cannot be returned by undoing a turn.");
      }
      if (options.waiting === true && currentStatus !== "waiting") {
        throw new FirestoreSecurityError(409, "This operation is only allowed before the draft starts.");
      }
      if (options.checkTurn === true) {
        for (const field of ["currentPickIndex", "availableItemIds", "history", "pickOrder"]) {
          const expected = isRecord(body.expected) ? body.expected[field] : undefined;
          if (expected !== undefined && !sameSecurityValue(context.fields[field] ?? (field === "currentPickIndex" ? 0 : []), expected)) {
            throw new FirestoreSecurityError(409, "The current draft turn has changed.");
          }
        }
      }
      if (options.reorder === true) {
        if (currentStatus !== "waiting" || context.fields.participantOrderDrawn === true) {
          throw new FirestoreSecurityError(409, "Participant order is locked.");
        }
      }
      if (
        updates.status === "drafting" &&
        currentStatus !== "paused"
      ) {
        throw new FirestoreSecurityError(409, "Use the start operation to begin a draft.");
      }
      if (
        updates.status !== undefined &&
        !["waiting", "drafting", "paused", "completed"].includes(String(updates.status))
      ) {
        throw new FirestoreSecurityError(400, "Invalid draft status.");
      }
      if (
        updates.turnDurationSeconds !== undefined &&
        updates.turnDurationSeconds !== null &&
        (!Number.isInteger(updates.turnDurationSeconds) ||
          Number(updates.turnDurationSeconds) < 5 ||
          Number(updates.turnDurationSeconds) > 300)
      ) {
        throw new FirestoreSecurityError(400, "Invalid turn duration.");
      }

      const publicUpdates: Record<string, unknown> = { ...updates };
      const writes: unknown[] = [];
      if (updates.participants !== undefined) {
        const previousPublicParticipants = Array.isArray(context.fields.participants)
          ? context.fields.participants.filter(isRecord)
          : [];
        const { publicParticipants, privateParticipants } = participantParts(
          updates.participants,
          context.privateFields.participants,
        );
        const currentParticipants = previousPublicParticipants;
        if (currentParticipants.some((previous) => {
          if (!isRecord(previous) || !Array.isArray(previous.picks) || previous.picks.length === 0) return false;
          const participant = publicParticipants.find((entry) => entry.id === previous.id);
          return !participant || !Array.isArray(participant.picks) || participant.picks.length < previous.picks.length;
        })) {
          throw new FirestoreSecurityError(409, "Participant picks cannot be removed by undoing a turn.");
        }
        if (currentStatus !== "waiting" && currentParticipants.some((previous) => {
          if (!isRecord(previous) || !Array.isArray(previous.picks)) return false;
          const participant = publicParticipants.find((entry) => entry.id === previous.id);
          return Boolean(
            participant &&
            Array.isArray(participant.picks) &&
            participant.picks.length > previous.picks.length,
          );
        })) {
          throw new FirestoreSecurityError(400, "Draft picks must use the authenticated participant pick operation.");
        }
        if (publicParticipants.length !== Number(context.fields.participantCount ?? publicParticipants.length)) {
          throw new FirestoreSecurityError(400, "Participant count does not match the draft.");
        }
        const idsChanged = privateParticipants.some(
          (participant, index) =>
            participant.userId !== (context.privateFields.participants?.[index]?.userId ?? ""),
        );
        if (idsChanged && currentStatus !== "waiting") {
          throw new FirestoreSecurityError(409, "Participant assignments are locked.");
        }
        if (options.reorder === true) {
          const oldIds = (Array.isArray(context.fields.participants) ? context.fields.participants : [])
            .map((participant) => isRecord(participant) ? participant.id : undefined);
          const newIds = publicParticipants.map((participant) => participant.id);
          if (
            oldIds.length !== newIds.length ||
            new Set(newIds).size !== newIds.length ||
            oldIds.some((id) => !newIds.includes(id))
          ) {
            throw new FirestoreSecurityError(409, "Participant order changed.");
          }
        }
        const resolvedPrivateParticipants = await resolveParticipantEmails(
          request,
          accessToken,
          projectId,
          privateParticipants,
          context.privateFields.participants ?? [],
        );
        const publicParticipantsById = new Map(
          publicParticipants
            .filter((participant) => typeof participant.id === "string")
            .map((participant) => [participant.id as string, participant]),
        );
        const previousStatusById = new Map(
          previousPublicParticipants
            .filter((participant) => typeof participant.id === "string")
            .map((participant) => [participant.id as string, participant.status]),
        );
        const previousPrivateParticipants = context.privateFields.participants ?? [];
        const invalidatedInviteHashes = new Set<string>();
        for (const previousParticipant of previousPrivateParticipants) {
          const inviteHash = previousParticipant.inviteHash;
          if (!inviteHash) continue;
          const currentParticipant = publicParticipantsById.get(previousParticipant.participantId ?? "");
          const currentPrivateParticipant = resolvedPrivateParticipants.find(
            (participant) => participant.participantId === previousParticipant.participantId,
          );
          if (
            !currentParticipant ||
            !currentPrivateParticipant ||
            currentPrivateParticipant.userId !== (previousParticipant.userId ?? "") ||
            currentParticipant.status !== previousStatusById.get(previousParticipant.participantId ?? "")
          ) {
            invalidatedInviteHashes.add(inviteHash);
          }
        }
        if (invalidatedInviteHashes.size > 0) {
          for (let index = 0; index < resolvedPrivateParticipants.length; index += 1) {
            const participant = resolvedPrivateParticipants[index];
            if (participant.inviteHash && invalidatedInviteHashes.has(participant.inviteHash)) {
              resolvedPrivateParticipants[index] = {
                ...participant,
                inviteHash: "",
                invitationStatus: "revoked",
              };
            }
          }
          const inviteDocuments = await Promise.all([...invalidatedInviteHashes].map(async (hash) => ({
            hash,
            document: await getFirestoreDocument(
              request,
              accessToken,
              documentResource(projectId, "draftInvites", hash),
              context.transaction,
            ),
          })));
          for (const { hash, document } of inviteDocuments) {
            if (document?.fields && decodeFirestoreFields(document.fields).status === "active") {
              writes.push(
                documentUpdateWrite(
                  documentResource(projectId, "draftInvites", hash),
                  { status: "revoked" },
                  ["status", "updatedAt"],
                  [serverTimestampTransform("updatedAt")],
                ),
              );
            }
          }
        }
        publicUpdates.participants = publicParticipants;
        writes.push(
          draftPrivateWrite(context, {
            ...context.privateFields,
            participants: resolvedPrivateParticipants,
          }),
        );
      }

      const publicWrite = documentUpdateWrite(
        context.documentName,
        publicUpdates,
        Object.keys(publicUpdates).concat(["privacyVersion", "updatedAt"]),
        [serverTimestampTransform("updatedAt")],
      );
      publicWrite.update.fields.privacyVersion = encodeFirestoreValue(1);
      writes.unshift(publicWrite);
      return { writes, result: { status: "updated" } };
    });
  }

  async function drawDraftParticipants(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      if (!ownerOrAdmin(context, actorId, isGlobalAdmin)) {
        throw new FirestoreSecurityError(403, "Only the owner or a global administrator may draw participants.");
      }
      if (context.fields.status !== "waiting") {
        throw new FirestoreSecurityError(409, "The draft has already started.");
      }
      if (context.fields.participantOrderDrawn === true) {
        throw new FirestoreSecurityError(409, "Participant order has already been drawn.");
      }
      const incoming = body.participants;
      const { publicParticipants, privateParticipants } = participantParts(
        incoming,
        context.privateFields.participants,
      );
      const oldIds = (Array.isArray(context.fields.participants) ? context.fields.participants : [])
        .map((participant) => isRecord(participant) ? participant.id : undefined);
      const newIds = publicParticipants.map((participant) => participant.id);
      const expectedIds = Array.isArray(body.expectedParticipantIds)
        ? body.expectedParticipantIds
        : [];
      if (
        oldIds.length !== newIds.length ||
        oldIds.length === 0 ||
        new Set(newIds).size !== newIds.length ||
        oldIds.some((id, index) => id !== expectedIds[index]) ||
        oldIds.some((id) => !newIds.includes(id))
      ) {
        throw new FirestoreSecurityError(409, "Participant order changed.");
      }
      const resolved = await resolveParticipantEmails(
        request,
        accessToken,
        projectId,
        privateParticipants,
        context.privateFields.participants ?? [],
      );
      return {
        writes: [
          documentUpdateWrite(
            context.documentName,
            { participants: publicParticipants, participantOrderDrawn: true, privacyVersion: 1 },
            ["participants", "participantOrderDrawn", "privacyVersion", "updatedAt"],
            [serverTimestampTransform("updatedAt")],
          ),
          draftPrivateWrite(context, { ...context.privateFields, participants: resolved }),
        ],
        result: { status: "drawn" },
      };
    });
  }

  async function startDraftSecurely(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      if (!ownerOrAdmin(context, actorId, isGlobalAdmin)) {
        throw new FirestoreSecurityError(403, "Only the owner or a global administrator may start this draft.");
      }
      if (context.fields.status !== "waiting") {
        throw new FirestoreSecurityError(409, "The draft has already started.");
      }
      const expectedState: Record<string, unknown> = { status: "waiting" };
      if (body.expectedParticipants !== undefined) {
        expectedState.participants = body.expectedParticipants;
      }
      if (body.expectedTeamRanking !== undefined) {
        expectedState.teamRanking = body.expectedTeamRanking;
      }
      validateExpectedDraftState(context, expectedState);
      const sport = getProductSport(context.fields.sport);
      if (!sport) throw new FirestoreSecurityError(400, "The draft has an unsupported sport.");
      const validateRoster = hasCanonicalDraftRoster(context.fields);
      if (validateRoster) {
        validateDraftRoster(context.fields, sport);
        if (
          !isCompleteTeamOrder(context.fields.availableItemIds, sport) ||
          !Array.isArray(context.fields.pickOrder) ||
          context.fields.pickOrder.length !== canonicalTeamIds(sport).length
        ) {
          throw new FirestoreSecurityError(400, "The draft is not ready to start with this roster.");
        }
      }

      const { publicParticipants, privateParticipants } = participantParts(
        body.participants,
        context.privateFields.participants,
      );
      const participantIds = privateParticipants.map((participant) => participant.userId?.trim() ?? "");
      if (
        Number(context.fields.participantCount ?? 0) !== publicParticipants.length ||
        publicParticipants.some((participant) => typeof participant.name !== "string" || !participant.name.trim()) ||
        participantIds.some((id, index) => !id && publicParticipants[index].status !== "pending-registration") ||
        !Array.isArray(context.fields.pickOrder) ||
        context.fields.pickOrder.length === 0 ||
        (validateRoster && context.fields.pickOrder.some((index) =>
          !Number.isInteger(index) || Number(index) < 0 || Number(index) >= publicParticipants.length
        )) ||
        !Array.isArray(context.fields.availableItemIds) ||
        context.fields.availableItemIds.length === 0
      ) {
        throw new FirestoreSecurityError(400, "The draft is not ready to start.");
      }
      const ranking = body.teamRanking;
      if (
        !Array.isArray(ranking) ||
        ranking.length === 0 ||
        ranking.some((team) => typeof team !== "string")
      ) {
        throw new FirestoreSecurityError(400, "Invalid team ranking.");
      }
      if (validateRoster && !isCompleteTeamOrder(ranking, sport)) {
        throw new FirestoreSecurityError(400, "The team ranking does not match the draft sport.");
      }
      const resolved = await resolveParticipantEmails(
        request,
        accessToken,
        projectId,
        privateParticipants,
        context.privateFields.participants ?? [],
      );
      return {
        writes: [
          documentUpdateWrite(
            context.documentName,
            {
              participants: publicParticipants,
              status: "drafting",
              teamRanking: ranking,
              teamRankingLocked: true,
              privacyVersion: 1,
            },
            ["participants", "status", "teamRanking", "teamRankingLocked", "privacyVersion", "turnStartedAt", "updatedAt"],
            [serverTimestampTransform("turnStartedAt"), serverTimestampTransform("updatedAt")],
          ),
          draftPrivateWrite(context, { ...context.privateFields, participants: resolved }),
        ],
        result: { status: "started" },
      };
    });
  }

  async function pickDraftItem(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    const itemId = requireString(body.itemId, "item ID", 128);
    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      const participants = Array.isArray(context.fields.participants)
        ? context.fields.participants.filter(isRecord)
        : [];
      const pickOrder = numberArray(context.fields.pickOrder);
      const currentPickIndex = Number(context.fields.currentPickIndex ?? 0);
      const participantIndex = pickOrder[currentPickIndex];
      if (
        context.fields.status !== "drafting" ||
        (body.expectedPickIndex !== undefined && body.expectedPickIndex !== currentPickIndex) ||
        !Number.isInteger(participantIndex) ||
        participantIndex < 0 ||
        participantIndex >= participants.length
      ) {
        throw new FirestoreSecurityError(409, "The current draft turn has changed.");
      }
      if (context.privateFields.participants?.[participantIndex]?.userId !== actorId) {
        throw new FirestoreSecurityError(403, "Only the participant whose turn it is may make this pick.");
      }

      const availableItemIds = stringArray(context.fields.availableItemIds);
      if (!availableItemIds.includes(itemId)) {
        throw new FirestoreSecurityError(409, "The selected team is no longer available.");
      }
      const rawItems = Array.isArray(context.fields.draftItems) ? context.fields.draftItems : [];
      const selectedItem = rawItems.find((item) =>
        typeof item === "string" ? item === itemId : isRecord(item) && item.id === itemId,
      );
      if (!selectedItem) throw new FirestoreSecurityError(400, "The selected team is invalid.");
      const itemName = typeof selectedItem === "string"
        ? selectedItem
        : isRecord(selectedItem) && typeof selectedItem.name === "string"
          ? selectedItem.name
          : itemId;

      const nextAvailableItemIds = availableItemIds.filter((id) => id !== itemId);
      const nextStatus = getDraftStatusAfterPick(nextAvailableItemIds);
      const nextParticipants = participants.map((participant, index) =>
        index === participantIndex
          ? { ...participant, picks: [...stringArray(participant.picks), itemId] }
          : participant,
      );
      const nextHistory = [
        ...(Array.isArray(context.fields.history) ? context.fields.history : []),
        { type: "pick", participantIndex, itemId, itemName },
      ];
      const update: AutoPickUpdate = {
        participants: nextParticipants as AutoPickParticipant[],
        currentPickIndex: currentPickIndex + 1,
        availableItemIds: nextAvailableItemIds,
        history: nextHistory as AutoPickHistoryItem[],
        status: nextStatus,
      };
      return {
        writes: [buildPickWrite(context.documentName, update, nextStatus)],
        result: { status: "picked", completed: nextStatus === "completed" },
      };
    });
  }

  async function skipDraftTurn(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      if (!ownerOrAdmin(context, actorId, isGlobalAdmin)) {
        throw new FirestoreSecurityError(403, "Only the owner or a global administrator may skip a turn.");
      }
      const participants = Array.isArray(context.fields.participants)
        ? context.fields.participants
        : [];
      const pickOrder = numberArray(context.fields.pickOrder);
      const currentPickIndex = Number(context.fields.currentPickIndex ?? 0);
      const currentParticipantIndex = pickOrder[currentPickIndex];
      if (
        context.fields.status !== "drafting" ||
        (body.expectedPickIndex !== undefined && body.expectedPickIndex !== currentPickIndex) ||
        !Number.isInteger(currentParticipantIndex)
      ) {
        throw new FirestoreSecurityError(409, "The current draft turn has changed.");
      }

      const availableItemIds = stringArray(context.fields.availableItemIds);
      const nextStatus = getDraftStatusAfterPick(availableItemIds);
      const nextPickOrder = extendSnakeOrderForSkippedPick(
        pickOrder,
        participants.length,
        currentPickIndex,
        availableItemIds.length,
      );
      const fields: Record<string, unknown> = {
        status: nextStatus,
        currentPickIndex: currentPickIndex + 1,
        pickOrder: nextPickOrder,
        history: [
          ...(Array.isArray(context.fields.history) ? context.fields.history : []),
          { type: "skip", participantIndex: currentParticipantIndex },
        ],
        privacyVersion: 1,
      };
      const fieldPaths = Object.keys(fields).concat(["turnStartedAt", "updatedAt"]);
      const transforms = [serverTimestampTransform("updatedAt")];
      if (nextStatus === "drafting") {
        transforms.push(serverTimestampTransform("turnStartedAt"));
      }
      return {
        writes: [documentUpdateWrite(context.documentName, fields, fieldPaths, transforms)],
        result: { status: "skipped" },
      };
    });
  }

  async function savePlayerPriorities(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    if (Object.keys(body).some((key) => !["operation", "draftId", "priorities"].includes(key))) {
      throw new FirestoreSecurityError(400, "Player priorities may only target the authenticated user.");
    }
    const priorities = stringArray(body.priorities);
    if (!Array.isArray(body.priorities) || priorities.length > 100 || priorities.some((id) => id.length > 128)) {
      throw new FirestoreSecurityError(400, "Invalid player priorities.");
    }
    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      if (participantIndexForUser(context, actorId) < 0) {
        throw new FirestoreSecurityError(403, "Only a draft participant may save priorities.");
      }
      if (hasCanonicalDraftRoster(context.fields)) {
        const sport = getProductSport(context.fields.sport);
        const validIds = new Set(sport ? canonicalTeamIds(sport) : []);
        if (
          !sport ||
          priorities.length > validIds.size ||
          priorities.some((id) => !validIds.has(id)) ||
          new Set(priorities).size !== priorities.length
        ) {
          throw new FirestoreSecurityError(400, "Player priorities must use unique teams from this draft.");
        }
      }
      const playerPriorities = { ...(context.privateFields.playerPriorities ?? {}), [actorId]: priorities };
      return {
        writes: [
          draftPrivateWrite(context, { ...context.privateFields, playerPriorities }),
          documentUpdateWrite(
            context.documentName,
            { privacyVersion: 1 },
            ["privacyVersion", "updatedAt"],
            [serverTimestampTransform("updatedAt")],
          ),
        ],
        result: { status: "saved" },
      };
    });
  }

  async function sendDraftMessage(
    request: typeof fetch,
    env: DraftWorkerEnv,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    const text = requireString(body.text, "message", 500).trim();
    if (!text) throw new FirestoreSecurityError(400, "Message cannot be empty.");

    const message = await runDraftTransaction(
      request,
      projectId,
      accessToken,
      draftId,
      async (context) => {
        const owner = ownerOrAdmin(context, actorId, isGlobalAdmin);
        if (!owner && participantIndexForUser(context, actorId) < 0) {
          throw new FirestoreSecurityError(403, "Only a draft participant may send messages.");
        }
        const profile = await getUserProfile(request, accessToken, projectId, actorId);
        if (!profile) throw new FirestoreSecurityError(403, "A user profile is required.");
        const messageId = crypto.randomUUID();
        const name = documentResource(projectId, `publicDrafts/${draftId}/messages`, messageId);
        const role = owner ? "admin" : "participant";
        const fields = {
          // Public chat documents carry only an opaque author identifier;
          // the sender's uid stays out of world-readable data.
          authorId: await chatAuthorId(env, draftId, actorId),
          displayName: typeof profile.displayName === "string" ? profile.displayName : "Uživatel",
          role,
          text,
        };
        return {
          writes: [
            {
              ...documentUpdateWrite(
                name,
                fields,
                Object.keys(fields).concat(["createdAt"]),
                [serverTimestampTransform("createdAt")],
              ),
              currentDocument: { exists: false },
            },
          ],
          result: { status: "sent", messageId },
        };
      },
    );
    return message;
  }

  async function searchDraftUsers(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    const prefix = requireString(body.prefix, "search prefix", 100).trim();
    if (prefix.length < 1) return { users: [] };
    const draft = await loadDraftForAccess(request, projectId, accessToken, draftId);
    if (!ownerOrAdmin(draft, actorId, isGlobalAdmin) || draft.fields.status !== "waiting") {
      throw new FirestoreSecurityError(403, "Only the draft owner may search users.");
    }
    const lowerPrefix = prefix.toLowerCase();
    // Email lookups require the exact full address: prefix ranges over the
    // email field would let a draft owner reconstruct every registered email
    // character by character by watching when a uid enters the result set.
    const emailQuery = lowerPrefix.includes("@");
    const variants = emailQuery
      ? [...new Set([prefix, lowerPrefix])]
      : [...new Set([
          prefix,
          lowerPrefix,
          prefix.toUpperCase(),
          lowerPrefix.charAt(0).toUpperCase() + lowerPrefix.slice(1),
        ])];
    const prefixRange = (fieldPath: string, value: string) => ({
      compositeFilter: {
        op: "AND",
        filters: [
          {
            fieldFilter: {
              field: { fieldPath },
              op: "GREATER_THAN_OR_EQUAL",
              value: { stringValue: value },
            },
          },
          {
            fieldFilter: {
              field: { fieldPath },
              op: "LESS_THAN_OR_EQUAL",
              value: { stringValue: `${value}\uf8ff` },
            },
          },
        ],
      },
    });
    const exactMatch = (fieldPath: string, value: string) => ({
      fieldFilter: {
        field: { fieldPath },
        op: "EQUAL",
        value: { stringValue: value },
      },
    });
    const results = (await Promise.all(
      variants.map(async (value) => {
        const response = await request(`${firestoreDocumentsUrl(projectId)}:runQuery`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            structuredQuery: {
              from: [{ collectionId: "users" }],
              select: { fields: [{ fieldPath: "displayName" }, { fieldPath: "email" }] },
              where: emailQuery ? exactMatch("email", value) : prefixRange("displayName", value),
              ...(emailQuery
                ? {}
                : { orderBy: [{ field: { fieldPath: "displayName" }, direction: "ASCENDING" }] }),
              limit: 20,
            },
          }),
        });
        return readJsonStream(response, "Firestore user search");
      }),
    )).flat();
    const seen = new Set<string>();
    const users = results.flatMap((result) => {
      const document = asDocument(result);
      if (!document?.name || !isRecord(document.fields)) return [];
      const user = decodeFirestoreFields(document.fields);
      const uid = document.name.split("/").at(-1) ?? "";
      const matchesQuery = emailQuery
        ? String(user.email ?? "").toLowerCase() === lowerPrefix
        : String(user.displayName ?? "").toLowerCase().startsWith(lowerPrefix);
      if (!uid || seen.has(uid) || !matchesQuery) {
        return [];
      }
      seen.add(uid);
      return [{
        uid,
        displayName: typeof user.displayName === "string" ? user.displayName : "",
        // An exact-match search only echoes the address the caller typed.
        ...(emailQuery && typeof user.email === "string" ? { email: user.email } : {}),
      }];
    });
    return { users: users.slice(0, 20) };
  }

  async function deleteDraft(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    isGlobalAdmin: boolean,
    body: Record<string, unknown>,
  ) {
    const draftId = requireString(body.draftId, "draft ID", 128);
    return runDraftTransaction(request, projectId, accessToken, draftId, async (context) => {
      if (!ownerOrAdmin(context, actorId, isGlobalAdmin)) {
        throw new FirestoreSecurityError(403, "Only the owner or a global administrator may delete this draft.");
      }
      return {
        writes: [
          { delete: context.documentName },
          { delete: context.privateDocumentName },
        ],
        result: { status: "deleted" },
      };
    });
  }

  async function requireGlobalAdmin(
    request: typeof fetch,
    accessToken: string,
    projectId: string,
    actorId: string,
  ) {
    if (!isAdminProfile(await getUserProfile(request, accessToken, projectId, actorId))) {
      throw new FirestoreSecurityError(403, "Administrator access is required.");
    }
  }

  async function writeProduct(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    body: Record<string, unknown>,
    isUpdate: boolean,
  ) {
    await requireGlobalAdmin(request, accessToken, projectId, actorId);
    const product = requireRecord(body.product, "Invalid product.");
    const name = requireString(product.name, "product name", 160).trim();
    const season = requireString(product.season, "product season", 80).trim();
    const price = Number(product.defaultPrice);
    if (!Number.isFinite(price) || price < 0) {
      throw new FirestoreSecurityError(400, "Invalid product price.");
    }
    const active = product.active !== false;
    const id = isUpdate ? requireString(body.productId, "product ID", 128) : crypto.randomUUID();
    const existing = isUpdate
      ? await getFirestoreDocument(request, accessToken, documentResource(projectId, "products", id))
      : null;
    const previousSport = decodeFirestoreValue(existing?.fields?.sport);
    let sport: ProductSport;
    if (product.sport === undefined) {
      sport = isProductSport(previousSport) ? previousSport : "NHL";
    } else if (isProductSport(product.sport)) {
      sport = product.sport;
    } else {
      throw new FirestoreSecurityError(400, "Invalid product sport.");
    }
    const fields = {
      name,
      season,
      defaultPrice: price,
      currency: "CZK",
      active,
      sport,
      imageUrl: typeof product.imageUrl === "string" ? product.imageUrl.slice(0, 2048) : null,
    };
    const baseUrl = firestoreDocumentsUrl(projectId);
    const documentName = documentResource(projectId, "products", id);
    const response = await request(`${baseUrl}:commit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        writes: [
          {
            ...documentUpdateWrite(
              documentName,
              fields,
              Object.keys(fields).concat(isUpdate ? ["updatedAt"] : ["createdAt", "updatedAt"]),
              [
                ...(!isUpdate ? [serverTimestampTransform("createdAt")] : []),
                serverTimestampTransform("updatedAt"),
              ],
            ),
            ...(isUpdate ? {} : { currentDocument: { exists: false } }),
          },
        ],
      }),
    });
    await readJsonResponse(response, "Firestore product write");
    return { status: "saved", productId: id };
  }

  async function writeRanking(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    body: Record<string, unknown>,
  ) {
    await requireGlobalAdmin(request, accessToken, projectId, actorId);
    const productKey = requireString(body.productKey, "ranking ID", 200);
    if (productKey.includes("/")) throw new FirestoreSecurityError(400, "Invalid ranking ID.");
    const series = requireString(body.series, "series", 160).trim();
    const season = requireString(body.season, "season", 80).trim();
    const sportValue = body.sport === undefined ? "NHL" : body.sport;
    if (!isProductSport(sportValue)) {
      throw new FirestoreSecurityError(400, "Invalid ranking sport.");
    }
    const sport: ProductSport = sportValue;
    if (productKey !== createSportRankingKey(sport, series, season)) {
      throw new FirestoreSecurityError(400, "Invalid ranking ID.");
    }
    const teamOrder = body.teamOrder;
    if (
      !Array.isArray(teamOrder) ||
      teamOrder.length === 0 ||
      teamOrder.length > 100 ||
      teamOrder.some((team) => typeof team !== "string" || team.length > 128)
    ) {
      throw new FirestoreSecurityError(400, "Invalid team ranking.");
    }
    const fields = {
      series,
      season,
      productKey,
      sport,
      teamOrder,
    };
    const documentName = documentResource(projectId, "teamRankings", productKey);
    const existing = await getFirestoreDocument(request, accessToken, documentName);
    if (existing && body.rankingId !== productKey) {
      throw new FirestoreSecurityError(409, "Ranking already exists.");
    }
    if (!existing && body.rankingId !== undefined) {
      throw new FirestoreSecurityError(404, "Ranking does not exist.");
    }
    const hasCreatedAt = Boolean(existing?.fields?.createdAt);
    const fieldPaths = Object.keys(fields).concat(hasCreatedAt ? [] : ["createdAt"], ["updatedAt"]);
    const transforms = [
      ...(!hasCreatedAt ? [serverTimestampTransform("createdAt")] : []),
      serverTimestampTransform("updatedAt"),
    ];
    const response = await request(`${firestoreDocumentsUrl(projectId)}:commit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        writes: [
          {
            ...documentUpdateWrite(documentName, fields, fieldPaths, transforms),
            currentDocument: existing?.updateTime
              ? { updateTime: existing.updateTime }
              : { exists: false },
          },
        ],
      }),
    });
    await readJsonResponse(response, "Firestore ranking write");
    return { status: "saved" };
  }

  async function deleteRanking(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actorId: string,
    body: Record<string, unknown>,
  ) {
    await requireGlobalAdmin(request, accessToken, projectId, actorId);
    const rankingId = requireString(body.rankingId, "ranking ID", 200);
    if (rankingId.includes("/")) throw new FirestoreSecurityError(400, "Invalid ranking ID.");
    const response = await request(`${firestoreDocumentsUrl(projectId)}:commit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        writes: [{ delete: documentResource(projectId, "teamRankings", rankingId) }],
      }),
    });
    await readJsonResponse(response, "Firestore ranking deletion");
    return { status: "deleted" };
  }

  async function upsertUserProfile(
    request: typeof fetch,
    projectId: string,
    accessToken: string,
    actor: { uid: string; email?: string },
    body: Record<string, unknown>,
  ) {
    const displayName = requireString(body.displayName, "display name", 100).trim();
    const email = actor.email?.trim();
    if (!email || email.length > 254) {
      throw new FirestoreSecurityError(400, "The authenticated Firebase account has no usable email.");
    }
    const baseUrl = firestoreDocumentsUrl(projectId);
    const name = documentResource(projectId, "users", actor.uid);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = await postJson<{ transaction?: string }>(
        request,
        `${baseUrl}:beginTransaction`,
        accessToken,
        { options: { readWrite: {} } },
        "Firestore begin transaction",
      );
      if (!started.transaction) throw new Error("Firestore did not return a transaction ID.");
      const transaction = started.transaction;
      let committed = false;
      let aborted = false;
      try {
        const existing = await getFirestoreDocument(request, accessToken, name, transaction);
        const profile = existing?.fields ? decodeFirestoreFields(existing.fields) : null;
        const fields = {
          uid: actor.uid,
          displayName,
          email,
          role: profile?.role === "admin" ? "admin" : "participant",
        };
        const write = documentUpdateWrite(
          name,
          fields,
          Object.keys(fields).concat(existing ? ["updatedAt"] : ["createdAt", "updatedAt"]),
          [
            ...(!existing ? [serverTimestampTransform("createdAt")] : []),
            serverTimestampTransform("updatedAt"),
          ],
        );
        const response = await request(`${baseUrl}:commit`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ transaction, writes: [write] }),
        });
        if (response.status === 409) {
          aborted = true;
          continue;
        }
        await readJsonResponse(response, "Firestore profile write");
        committed = true;
        return { status: "saved" };
      } finally {
        if (!committed && !aborted) {
          await rollbackTransaction(request, baseUrl, accessToken, transaction);
        }
      }
    }
    throw new FirestoreSecurityError(409, "Could not save the user profile.");
  }

  export async function executeFirestoreSecurityOperation(
    env: DraftWorkerEnv,
    actor: { uid: string; email?: string },
    body: Record<string, unknown>,
    request: typeof fetch = fetch,
  ): Promise<Record<string, unknown>> {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      throw new Error("FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be configured.");
    }
    const operation = requireString(body.operation, "operation", 80);
    const projectId = env.FIREBASE_PROJECT_ID;
    const accessToken = await getAccessToken(env, request);
    const profile = await getUserProfile(request, accessToken, projectId, actor.uid);
    const globalAdmin = isAdminProfile(profile);

    switch (operation) {
      case "profile.get":
        if (!profile) throw new FirestoreSecurityError(404, "User profile not found.");
        return { profile: plainValue(profile) as Record<string, unknown> };
      case "profile.save":
        return upsertUserProfile(request, projectId, accessToken, actor, body);
      case "draft.create":
        return createDraft(request, projectId, accessToken, actor.uid, body);
      case "draft.access":
        return getDraftAccess(
          request,
          env,
          projectId,
          accessToken,
          actor.uid,
          requireString(body.draftId, "draft ID", 128),
        );
      case "draft.join":
        return joinDraft(request, projectId, accessToken, actor, body);
      case "invite.create":
        return createDraftInvitation(request, projectId, accessToken, actor.uid, globalAdmin, body);
      case "invite.revoke":
        return revokeDraftInvitation(request, projectId, accessToken, actor.uid, globalAdmin, body);
      case "invite.preview":
        return previewDraftInvitation(request, projectId, accessToken, body);
      case "invite.claim":
        return claimDraftInvitation(request, projectId, accessToken, actor, body);
      case "draft.update":
        return updateDraft(request, projectId, accessToken, actor.uid, globalAdmin, body);
      case "draft.draw":
        return drawDraftParticipants(request, projectId, accessToken, actor.uid, globalAdmin, body);
      case "draft.start":
        return startDraftSecurely(request, projectId, accessToken, actor.uid, globalAdmin, body);
      case "draft.pick":
        return pickDraftItem(request, projectId, accessToken, actor.uid, body);
      case "draft.skip":
        return skipDraftTurn(request, projectId, accessToken, actor.uid, globalAdmin, body);
      case "draft.priorities":
        return savePlayerPriorities(request, projectId, accessToken, actor.uid, body);
      case "draft.message":
        return sendDraftMessage(request, env, projectId, accessToken, actor.uid, globalAdmin, body);
      case "draft.search-users":
        return searchDraftUsers(request, projectId, accessToken, actor.uid, globalAdmin, body);
      case "draft.delete":
        return deleteDraft(request, projectId, accessToken, actor.uid, globalAdmin, body);
      case "product.create":
        return writeProduct(request, projectId, accessToken, actor.uid, body, false);
      case "product.update":
        return writeProduct(request, projectId, accessToken, actor.uid, body, true);
      case "ranking.save":
        return writeRanking(request, projectId, accessToken, actor.uid, body);
      case "ranking.delete":
        return deleteRanking(request, projectId, accessToken, actor.uid, body);
      default:
        throw new FirestoreSecurityError(400, "Unsupported Firestore operation.");
    }
}

async function listCollectionDocuments(
    request: typeof fetch,
    accessToken: string,
    collectionPath: string,
) {
    const documents: FirestoreDocument[] = [];
    let pageToken = "";
    do {
      const url = new URL(
        `https://firestore.googleapis.com/v1/${encodedResourceName(collectionPath)}`,
      );
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await request(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const page = await readJsonResponse<{ documents?: FirestoreDocument[]; nextPageToken?: string }>(
        response,
        "Firestore migration document list",
      );
      if (Array.isArray(page.documents)) documents.push(...page.documents);
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return documents;
}

async function commitMigrationWrites(
    request: typeof fetch,
    baseUrl: string,
    accessToken: string,
    writes: unknown[],
) {
    for (let offset = 0; offset < writes.length; offset += 400) {
      const response = await request(`${baseUrl}:commit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ writes: writes.slice(offset, offset + 400) }),
      });
      await readJsonResponse(response, "Firestore privacy migration commit");
    }
}

function verifyMigrationFields(
    existing: Record<string, unknown>,
    expected: Record<string, unknown>,
    label: string,
) {
    for (const [field, value] of Object.entries(expected)) {
      if (!sameSecurityValue(existing[field], value)) {
        throw new Error(`Refusing to delete legacy data because migrated ${label}.${field} does not match.`);
      }
    }
}

export async function runLegacyDraftPrivacyMigration(
    env: DraftWorkerEnv,
    request: typeof fetch = fetch,
    onProgress: (completed: number, draftId: string) => void = () => {},
) {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      throw new Error("FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be configured.");
    }

    const projectId = env.FIREBASE_PROJECT_ID;
    const accessToken = await getAccessToken(env, request);
    const baseUrl = firestoreDocumentsUrl(projectId);
    const legacyCollection = documentResource(projectId, "drafts", "placeholder")
      .replace(/\/placeholder$/, "");
    const legacyDocuments = await listCollectionDocuments(request, accessToken, legacyCollection);
    let migrated = 0;

    for (const legacyDocument of legacyDocuments) {
      if (!legacyDocument.name || !isRecord(legacyDocument.fields)) continue;
      const draftId = legacyDocument.name.split("/").at(-1) ?? "";
      if (!DRAFT_ID_PATTERN.test(draftId)) {
        throw new Error(`Legacy draft has an invalid document ID: ${draftId}`);
      }
      if (!legacyDocument.updateTime) {
        throw new Error(`Legacy draft has no update timestamp; refusing to migrate it: ${draftId}`);
      }

      const publicName = documentResource(projectId, "publicDrafts", draftId);
      const privateName = documentResource(projectId, "draftPrivate", draftId);
      const [existingPublic, existingPrivate, legacyMessages] = await Promise.all([
        getFirestoreDocument(request, accessToken, publicName),
        getFirestoreDocument(request, accessToken, privateName),
        listCollectionDocuments(
          request,
          accessToken,
          `${legacyDocument.name}/messages`,
        ),
      ]);
      const legacyMessagesWithUpdateTime = legacyMessages.map((message) => {
        const updateTime = message.updateTime;
        if (!updateTime) {
          throw new Error(`Legacy chat message has no update timestamp; refusing to migrate it: ${draftId}`);
        }
        return { message, updateTime };
      });

      const legacyFields = decodeFirestoreFields(legacyDocument.fields);
      const privateFields = privateFromLegacyFields(legacyFields);
      const rawParticipants = Array.isArray(legacyFields.participants)
        ? legacyFields.participants
        : [];
      const publicFields = Object.fromEntries(
        Object.entries(legacyFields).filter(([key]) =>
          key !== "ownerUserId" &&
          key !== "playerPriorities" &&
        key !== "privacyVersion",
        ),
      );
      publicFields.participants = rawParticipants.map((participant) =>
        isRecord(participant) ? stripPrivateParticipantFields(participant) : {},
      );
      publicFields.privacyVersion = 1;

      if (existingPublic) {
        if (!isRecord(existingPublic.fields)) {
          throw new Error(`Refusing to overwrite an invalid public draft: ${draftId}`);
        }
        const currentPublic = decodeFirestoreFields(existingPublic.fields);
        if (currentPublic.privacyVersion !== 1) {
          throw new Error(`Refusing to overwrite an unverified public draft: ${draftId}`);
        }
        verifyMigrationFields(currentPublic, publicFields, `public draft ${draftId}`);
      }
      if (existingPrivate) {
        if (!isRecord(existingPrivate.fields)) {
          throw new Error(`Refusing to overwrite an invalid private draft: ${draftId}`);
        }
        const currentPrivate = decodeFirestoreFields(existingPrivate.fields);
        verifyMigrationFields(
          currentPrivate,
          privateFields as unknown as Record<string, unknown>,
          `private draft ${draftId}`,
        );
      }

      const destinationMessageDeletes: Array<{ name: string; updateTime: string }> = [];
      for (const { message: legacyMessage, updateTime } of legacyMessagesWithUpdateTime) {
        if (!legacyMessage.name || !isRecord(legacyMessage.fields)) continue;
        const messageId = legacyMessage.name.split("/").at(-1) ?? "";
        if (!DRAFT_ID_PATTERN.test(messageId)) {
          throw new Error(`Legacy message has an invalid document ID: ${messageId}`);
        }
        const publicMessageName = documentResource(
          projectId,
          `publicDrafts/${draftId}/messages`,
          messageId,
        );
        const existingMessage = await getFirestoreDocument(request, accessToken, publicMessageName);
        const messageFields = decodeFirestoreFields(legacyMessage.fields);
        if (!existingMessage) {
          const messageWrite = documentUpdateWrite(
            publicMessageName,
            messageFields,
            Object.keys(messageFields),
          );
          messageWrite.currentDocument = { exists: false };
          await commitMigrationWrites(request, baseUrl, accessToken, [messageWrite]);
        } else if (existingMessage.fields) {
          verifyMigrationFields(
            decodeFirestoreFields(existingMessage.fields),
            messageFields,
            `chat message ${draftId}/${messageId}`,
          );
        } else {
          throw new Error(`Refusing to delete a legacy chat message with an invalid destination: ${draftId}/${messageId}`);
        }
        destinationMessageDeletes.push({
          name: legacyMessage.name,
          updateTime,
        });
      }

      const writes: unknown[] = [];
      if (!existingPublic) {
        const publicWrite = documentUpdateWrite(
          publicName,
          publicFields,
          Object.keys(publicFields),
        );
        publicWrite.currentDocument = { exists: false };
        writes.push(publicWrite);
      }
      if (!existingPrivate) {
        const privateWrite = documentUpdateWrite(
          privateName,
          privateFields as unknown as Record<string, unknown>,
          ["ownerUserId", "participants", "playerPriorities"],
        );
        privateWrite.currentDocument = { exists: false };
        writes.push(privateWrite);
      }
      await commitMigrationWrites(request, baseUrl, accessToken, writes);

      await commitMigrationWrites(
        request,
        baseUrl,
        accessToken,
        destinationMessageDeletes.map(({ name, updateTime }) => ({
          delete: name,
          currentDocument: { updateTime },
        })),
      );
      await commitMigrationWrites(request, baseUrl, accessToken, [
        {
          delete: legacyDocument.name,
          currentDocument: { updateTime: legacyDocument.updateTime },
        },
      ]);
      migrated += 1;
      onProgress(migrated, draftId);
    }

    return { scanned: legacyDocuments.length, migrated };
}
