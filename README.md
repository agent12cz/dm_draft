This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Automatic draft picks

Expired turns are processed by a Cloudflare Cron Trigger once per minute. The custom Worker entry point in `worker.ts` preserves the OpenNext `fetch` handler and adds the scheduled handler. The Worker uses the Firestore REST API with a service-account OAuth token; its service-account JSON must be set as the `FIREBASE_SERVICE_ACCOUNT_JSON` Cloudflare Worker secret. Never commit that JSON or its private key. The account needs the `roles/datastore.user` IAM role in the Firebase project. The project ID is configured as the non-secret `FIREBASE_PROJECT_ID` Wrangler variable.

To deploy through Cloudflare Workers Builds, connect the `dm-draft` Worker to this Git repository and set its production branch to `main`; use `npm run deploy` as the deploy command (it runs the OpenNext build and then `wrangler deploy`). The repository does not contain a GitHub Actions workflow, so the Cloudflare Dashboard's Workers Builds connection and settings must be configured separately. Add the `FIREBASE_SERVICE_ACCOUNT_JSON` secret to the Worker before enabling the Cron Trigger; it can be added with `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON` or in the Cloudflare Dashboard. Before enabling the new trigger, verify that no previously deployed Firebase scheduled function remains active; deleting its source code does not remove a deployed function. The Firebase project can remain on Spark; no Firebase Functions or Cloud Scheduler are used.

### Immediate automatic picks

Because the Cron runs in UTC once per minute, it alone would delay an auto-pick by up to a minute. The `POST /api/draft/auto-pick` route handler therefore lets a connected client ask the server to process the turn as soon as its countdown reaches zero. The Cron Trigger stays enabled as the fallback for drafts where nobody has the app open or the immediate request fails.

The client only sends the draft ID and the pick index it believes expired; it never chooses a team and never writes the pick. The endpoint requires a Firebase ID token in the `Authorization: Bearer` header, which `workers/firebaseAuth.ts` verifies against the Google JWKS using WebCrypto, checking the signature, `alg`, `aud`, `iss`, `sub` and expiry. The Worker then re-reads the draft inside the Firestore transaction and refuses the request unless the caller is a participant of that draft, the draft is still `drafting`, the pick index still matches, and `turnStartedAt` plus the time limit has genuinely passed. A draft ID on its own therefore grants nothing. Each user is additionally limited to 12 requests per 10 seconds per Worker isolate; because isolates are not shared, this only smooths accidental loops, and the authentication, participant check, server-side expiry check and transaction are the real protection.

Both the Cron and the endpoint call the same `processExpiredDraft` function in `workers/firestore.ts`, so the selection logic exists only once. The Firestore read-write transaction, the `expectedPickIndex` guard and the HTTP 409 retry together guarantee that a turn is picked exactly once even when the Cron, several browsers and a manual pick race each other. The service-account JSON is only ever read from the Worker environment and is never sent to the browser.

The Cron query scans all active timed drafts so an early, not-yet-expired turn cannot block later expired turns. Its composite index is defined in `firestore.indexes.json` and must be deployed once using `firebase deploy --only firestore:indexes`. Spark includes 50,000 Firestore reads and 20,000 writes per day. A continuously active timed draft accounts for about 1,440 query reads per day, before app traffic and the transaction read/write for a completed pick; monitor the shared quota. Cloudflare's Free Workers plan allows 10 ms CPU per Cron invocation; if the Worker exceeds that limit, the task can fail and a paid Workers plan may be needed (currently from $5/month). The one-minute Cron runs in UTC, so a fallback auto-pick can be delayed by up to about one minute after expiration when no client is connected; trigger changes can take up to 15 minutes to propagate.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
