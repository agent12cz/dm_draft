import { getCloudflareContext } from "@opennextjs/cloudflare";
import { FirebaseAuthError, verifyFirebaseIdToken } from "../../../../workers/firebaseAuth";
import {
  executeFirestoreSecurityOperation,
  type DraftWorkerEnv,
} from "../../../../workers/firestore";
import { consumeRateLimit } from "../../../../workers/rateLimit";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000_000;

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
      "The Firestore API needs the FIREBASE_PROJECT_ID variable and the FIREBASE_SERVICE_ACCOUNT_JSON secret.",
    );
    return jsonResponse(503, { status: "unavailable" });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const idToken = /^bearer /i.test(authorization) ? authorization.slice(7).trim() : "";
  if (!idToken) {
    return jsonResponse(401, { status: "unauthorized" });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { status: "request-too-large" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { status: "invalid-request" });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).operation !== "string"
  ) {
    return jsonResponse(400, { status: "invalid-request" });
  }

  let actor: Awaited<ReturnType<typeof verifyFirebaseIdToken>>;
  try {
    actor = await verifyFirebaseIdToken(idToken, projectId);
  } catch (authError) {
    if (authError instanceof FirebaseAuthError) {
      return jsonResponse(401, { status: "unauthorized" });
    }

    console.error("Could not verify the Firebase ID token.", authError);
    return jsonResponse(503, { status: "unavailable" });
  }

  if (!consumeRateLimit(`firestore:${actor.uid}`, 60, 10_000)) {
    return jsonResponse(429, { status: "rate-limited" });
  }

  try {
    const result = await executeFirestoreSecurityOperation(
      {
        FIREBASE_PROJECT_ID: projectId,
        FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
      } satisfies DraftWorkerEnv,
      actor,
      body as Record<string, unknown>,
    );
    return jsonResponse(200, result);
  } catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      if (error.status === 403) return jsonResponse(403, { status: "forbidden" });
      if (error.status === 404) return jsonResponse(404, { status: "missing" });
      if (error.status === 409) return jsonResponse(409, { status: "conflict" });
      if (error.status === 400) {
        return jsonResponse(400, { status: "invalid", message: error.message });
      }
    }

    console.error("The Firestore Worker operation failed.", error);
    return jsonResponse(502, { status: "failed" });
  }
}
