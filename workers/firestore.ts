import {
  buildAutomaticPickUpdate,
  type AutoPickDraft,
  type AutoPickHistoryItem,
  type AutoPickParticipant,
  type AutoPickUpdate,
} from "../src/lib/autoPick";

export type DraftWorkerEnv = {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT_JSON: string;
};

/** Extra server-side checks applied inside the Firestore transaction. */
export type DraftPickGuard = {
  /** The turn is only picked when this user is a participant of the draft. */
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

type ServiceAccount = {
  project_id?: string;
  client_email: string;
  private_key: string;
};

type FirestoreValue = Record<string, unknown>;
type FirestoreDocument = {
  name?: string;
  fields?: Record<string, unknown>;
};
type GoogleAccessToken = {
  access_token: string;
  expires_in?: number;
};

type FirestoreTimestamp = {
  __firestoreTimestamp: true;
  value: string;
};

class FirestoreHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
    const responseText = await response.text();
    throw new FirestoreHttpError(
      `${operation} failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

async function readJsonStream(response: Response, operation: string) {
  if (!response.ok) {
    const responseText = await response.text();
    throw new FirestoreHttpError(
      `${operation} failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`,
      response.status,
    );
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
  const participants = Array.isArray(fields.participants)
    ? fields.participants.flatMap((participant) => {
        const decoded = decodeParticipant(participant);
        return decoded ? [decoded] : [];
      })
    : [];
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

function participantUserIds(fields: Record<string, unknown>) {
  return Array.isArray(fields.participants)
    ? fields.participants.flatMap((participant) =>
        isRecord(participant) && typeof participant.userId === "string" ? [participant.userId] : [],
      )
    : [];
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
        from: [{ collectionId: "drafts" }],
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
      if (guard?.userId && !participantUserIds(fields).includes(guard.userId)) {
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
      const pickUpdate = buildAutomaticPickUpdate(draft);
      if (!pickUpdate) {
        const noRemainingPicks = draft.currentPickIndex >= draft.pickOrder.length;
        if (draft.availableItemIds.length > 0 && !noRemainingPicks) {
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
 * Runs the automatic pick for a single draft on behalf of a signed-in participant.
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
  const documentName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/drafts/${params.draftId}`;

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
