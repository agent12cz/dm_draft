export {};

declare global {
  interface CloudflareEnv {
    /** Non-secret Wrangler variable with the Firebase project ID. */
    FIREBASE_PROJECT_ID?: string;
    /** Cloudflare Worker secret with the Firebase service account JSON. */
    FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  }
}
