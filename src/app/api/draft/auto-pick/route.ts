import { getCloudflareContext } from "@opennextjs/cloudflare";

import { FirebaseAuthError, verifyFirebaseIdToken } from "../../../../../workers/firebaseAuth";
import { runImmediateDraftPick, type DraftWorkerEnv } from "../../../../../workers/firestore";
import { consumeRateLimit } from "../../../../../workers/rateLimit";

export const dynamic = "force-dynamic";

const RATE_LIMIT_REQUESTS = 12;
const RATE_LIMIT_WINDOW_MS = 10_000;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const { env } = await getCloudflareContext({ async: true });
  const projectId = env.FIREBASE_PROJECT_ID;
  const serviceAccountJson = env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!projectId || !serviceAccountJson) {
    console.error(
      "The automatic pick endpoint needs the FIREBASE_PROJECT_ID variable and the FIREBASE_SERVICE_ACCOUNT_JSON secret.",
    );
    return jsonResponse(503, { status: "unavailable" });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const idToken = /^bearer /i.test(authorization) ? authorization.slice(7).trim() : "";
  if (!idToken) {
    return jsonResponse(401, { status: "unauthorized" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { status: "invalid-request" });
  }

  if (typeof body !== "object" || body === null) {
    return jsonResponse(400, { status: "invalid-request" });
  }

  const { draftId, currentPickIndex } = body as { draftId?: unknown; currentPickIndex?: unknown };
  if (typeof draftId !== "string" || draftId.length === 0) {
    return jsonResponse(400, { status: "invalid-request" });
  }
  if (
    currentPickIndex !== undefined &&
    (typeof currentPickIndex !== "number" ||
      !Number.isInteger(currentPickIndex) ||
      currentPickIndex < 0)
  ) {
    return jsonResponse(400, { status: "invalid-request" });
  }

  let userId: string;
  try {
    ({ uid: userId } = await verifyFirebaseIdToken(idToken, projectId));
  } catch (authError) {
    if (authError instanceof FirebaseAuthError) {
      return jsonResponse(401, { status: "unauthorized" });
    }

    console.error("Could not verify the Firebase ID token.", authError);
    return jsonResponse(503, { status: "unavailable" });
  }

  if (!consumeRateLimit(`auto-pick:${userId}`, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    return jsonResponse(429, { status: "rate-limited" });
  }

  const workerEnv: DraftWorkerEnv = {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
  };

  try {
    const result = await runImmediateDraftPick(workerEnv, {
      draftId,
      userId,
      expectedPickIndex: currentPickIndex,
    });

    switch (result.status) {
      case "picked":
        return jsonResponse(200, { status: "picked", completed: result.completed });
      case "completed":
      case "changed":
      case "not-expired":
        return jsonResponse(200, { status: result.status });
      case "forbidden":
        return jsonResponse(403, { status: "forbidden" });
      case "missing":
        return jsonResponse(404, { status: "missing" });
      case "conflict":
        return jsonResponse(409, { status: "conflict" });
      default:
        return jsonResponse(422, { status: "invalid" });
    }
  } catch (pickError) {
    console.error("The immediate automatic pick failed.", pickError);
    return jsonResponse(502, { status: "failed" });
  }
}
