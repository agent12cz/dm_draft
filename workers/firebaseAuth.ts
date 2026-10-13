const SECURE_TOKEN_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8192;
const MAX_JWKS_CACHE_SECONDS = 86_400;

export class FirebaseAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirebaseAuthError";
  }
}

export type VerifiedFirebaseUser = {
  uid: string;
};

type SigningKeyEntry = {
  kid?: unknown;
  kty?: unknown;
  n?: unknown;
  e?: unknown;
};

let cachedSigningKeys: { keys: Map<string, CryptoKey>; expiresAt: number } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function base64UrlToText(value: string) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function cacheSeconds(response: Response) {
  const directive = /max-age=(\d+)/i.exec(response.headers.get("cache-control") ?? "");
  const parsed = directive ? Number(directive[1]) : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_JWKS_CACHE_SECONDS) : 3600;
}

async function loadSigningKeys(request: typeof fetch, forceRefresh: boolean) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!forceRefresh && cachedSigningKeys && cachedSigningKeys.expiresAt > nowSeconds) {
    return cachedSigningKeys.keys;
  }

  const response = await request(SECURE_TOKEN_JWKS_URL);
  if (!response.ok) {
    throw new FirebaseAuthError(
      `Could not download the Firebase signing keys (HTTP ${response.status}).`,
    );
  }

  const body = (await response.json()) as { keys?: SigningKeyEntry[] };
  if (!Array.isArray(body.keys)) {
    throw new FirebaseAuthError("The Firebase signing key response had an unexpected shape.");
  }

  const keys = new Map<string, CryptoKey>();
  for (const entry of body.keys) {
    if (
      !isRecord(entry) ||
      typeof entry.kid !== "string" ||
      entry.kty !== "RSA" ||
      typeof entry.n !== "string" ||
      typeof entry.e !== "string"
    ) {
      continue;
    }

    keys.set(
      entry.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: entry.n, e: entry.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }

  if (keys.size === 0) {
    throw new FirebaseAuthError("The Firebase signing key response contained no usable keys.");
  }

  cachedSigningKeys = { keys, expiresAt: nowSeconds + cacheSeconds(response) };
  return keys;
}

export function resetFirebaseSigningKeyCache() {
  cachedSigningKeys = null;
}

/**
 * Verifies a Firebase Authentication ID token against Google's published signing keys.
 * Only the token subject is returned; the caller still has to authorize the request.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
  request: typeof fetch = fetch,
): Promise<VerifiedFirebaseUser> {
  if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > MAX_TOKEN_LENGTH) {
    throw new FirebaseAuthError("The Firebase ID token is missing or too long.");
  }
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new FirebaseAuthError("The Firebase project ID is not configured.");
  }

  const segments = idToken.split(".");
  if (segments.length !== 3) {
    throw new FirebaseAuthError("The Firebase ID token is malformed.");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(base64UrlToText(encodedHeader));
    payload = JSON.parse(base64UrlToText(encodedPayload));
  } catch {
    throw new FirebaseAuthError("The Firebase ID token is malformed.");
  }

  if (!isRecord(header) || header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new FirebaseAuthError("The Firebase ID token uses an unsupported signing algorithm.");
  }
  if (!isRecord(payload)) {
    throw new FirebaseAuthError("The Firebase ID token is malformed.");
  }

  let signingKeys = await loadSigningKeys(request, false);
  let signingKey = signingKeys.get(header.kid);
  if (!signingKey) {
    signingKeys = await loadSigningKeys(request, true);
    signingKey = signingKeys.get(header.kid);
  }
  if (!signingKey) {
    throw new FirebaseAuthError("The Firebase ID token was signed with an unknown key.");
  }

  let signature: ReturnType<typeof base64UrlToBytes>;
  try {
    signature = base64UrlToBytes(encodedSignature);
  } catch {
    throw new FirebaseAuthError("The Firebase ID token is malformed.");
  }

  const isValidSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    signature,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!isValidSignature) {
    throw new FirebaseAuthError("The Firebase ID token signature is invalid.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) {
    throw new FirebaseAuthError("The Firebase ID token was issued for a different project.");
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new FirebaseAuthError("The Firebase ID token has an unexpected issuer.");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new FirebaseAuthError("The Firebase ID token has no usable subject.");
  }
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    throw new FirebaseAuthError("The Firebase ID token expired.");
  }
  if (typeof payload.iat !== "number" || payload.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new FirebaseAuthError("The Firebase ID token was issued in the future.");
  }
  if (typeof payload.auth_time === "number" && payload.auth_time - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new FirebaseAuthError("The Firebase ID token reports a future authentication time.");
  }

  return { uid: payload.sub };
}
