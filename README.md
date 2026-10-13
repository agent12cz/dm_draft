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

The Cron query scans all active timed drafts so an early, not-yet-expired turn cannot block later expired turns. Its composite index is defined in `firestore.indexes.json` and must be deployed once using `firebase deploy --only firestore:indexes`. Spark includes 50,000 Firestore reads and 20,000 writes per day. A continuously active timed draft accounts for about 1,440 query reads per day, before app traffic and the transaction read/write for a completed pick; monitor the shared quota. Cloudflare's Free Workers plan allows 10 ms CPU per Cron invocation; if the Worker exceeds that limit, the task can fail and a paid Workers plan may be needed (currently from $5/month). The one-minute Cron runs in UTC, so auto-picks can be delayed by up to about one minute after expiration; trigger changes can take up to 15 minutes to propagate.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
