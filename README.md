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

## Account navigation

The shared `Navbar` uses the root `AuthProvider` for authentication on every page, including player and organizer draft pages. While authentication loads it shows a loading status, not signed-out links. Signed-in users see their profile name, Firebase display name or email and a sign-out button on both mobile and desktop, regardless of role. Signing out uses the existing Firebase context and returns to the login page; errors are shown without switching to a false signed-out state. `npm test` includes account-menu rendering tests for loading, signed-in, signed-out and logout states.

## Home draft box photos

Both active and completed cards in "Moje drafty" show one photo per physical box, using the catalog image URLs saved in `boxes` and repeating each photo by `boxCount`. Older drafts without a composition use their saved product image and quantity (one photo when quantity is unspecified). Missing photos are identified rather than replaced with another product's image. One box has a large photo, two sit side by side, and larger breaks use a compact grid that adapts to the card width without hiding boxes. Card titles and action buttons wrap on mobile. Run `npx tsx scripts/test-home-draft-boxes.mjs` for rendering and responsive layout checks.

## Player room chat

On `/play/[code]`, a single chat panel stays mounted above My Teams in the secondary column, independently of the participant/history and team-selection tabs. On smaller screens the columns stack and the navigation buttons wrap. The bounded message list scrolls internally and follows new messages while the reader is near the bottom; scrolling up preserves the reading position, and sending a message resumes following. Draft updates do not reset the composer or recreate the chat's access/messages subscriptions. `npm test` includes mocked lifecycle checks for those behaviors and a structural check of the panel placement.

## Administrator draw and print

Before a draft starts, the administrator may draw the participant order once. An authenticated Firestore Worker transaction saves both the shuffled participants and `participantOrderDrawn`; the five-second animation is only a local preview and interrupting it does not undo the saved result. Manual reordering remains available before the start. Older drafts without the flag are treated as not yet drawn because earlier draws were not recorded.

The results print view includes the draft's saved box composition and total quantity, followed by participants and teams, without prices or margin. Legacy drafts without a `boxes` array use their saved product fields. The print layout is designed for A4.

## Firestore privacy and authorization

Drafts are split between the publicly readable `publicDrafts` collection and the Worker-only `draftPrivate` collection. Public draft documents omit owner IDs, participant user IDs, emails, PINs and player priorities. The private document stores those values, and the authenticated Worker returns them only to the owner, a global administrator or the assigned participant. User profiles are also Worker-only. Products, team rankings, public draft data and draft chat remain readable by clients.

All client writes to drafts, chat, user profiles, products and rankings go through `/api/firestore`. The route verifies the Firebase ID token; the Worker checks ownership, role and participant assignment, then commits the authorized changes through the Firestore REST API using the Cloudflare Worker service-account secret. Direct Firestore client writes are denied by `firestore.rules`. The rules contain no date condition or automatic expiry, so the database access policy does not stop working after 1 January 2027. Firebase Functions and Cloud Scheduler are not required; this design remains compatible with Firebase Spark quotas. Cloudflare Worker usage and Firebase Spark quotas are separate.

### Migrating existing drafts

Before publishing `firestore.rules`, migrate legacy documents from `drafts` (including chat messages) to `publicDrafts` and `draftPrivate`. Deploy the application Worker with the new API before publishing the rules; otherwise clients using the old app or old Worker will no longer be able to write. Do not publish restrictive rules until the migration and Worker rollout are complete.

The migration command is a no-op unless `--apply` is passed. Keep the service-account key in a protected file outside the repository:

```bash
FIREBASE_PROJECT_ID=your-project-id \
FIREBASE_SERVICE_ACCOUNT_FILE=/secure/path/service-account.json \
npm run migrate:firestore-privacy

FIREBASE_PROJECT_ID=your-project-id \
FIREBASE_SERVICE_ACCOUNT_FILE=/secure/path/service-account.json \
npm run migrate:firestore-privacy -- --apply
```

The first command makes no changes. The second copies each destination and checks any pre-existing destination fields against the legacy data before deleting its source; conflicts stop the migration without deleting the conflicting legacy document. Source deletes use Firestore `updateTime` preconditions, so changes during migration abort rather than being silently lost. Run it in a maintenance window after stopping legacy-client writes, since new chat messages can otherwise arrive while subcollections are being copied. It is intended to be run by an operator and is not run as part of tests or deployment. Review the migration output and back up the project before applying it. Ownerless legacy drafts stay ownerless: participants can continue playing, but only a global administrator can perform organizer operations. No first-user ownership claim is performed.

Run `npm test` to execute application and Worker tests plus the Firestore Emulator rules tests. The rules tests verify public/private boundaries, deny direct client writes and confirm there is no time-based rule expiry.

### Player priority authorization

Player rankings are saved through the authenticated `draft.priorities` Worker operation, never by a direct client Firestore write. The Worker matches the verified Firebase token UID against the private participant assignment and writes only that UID's entry in `draftPrivate.playerPriorities`. Requests specifying another target or extra update fields are rejected; being an owner or administrator alone does not permit a player-priority write.

Legacy participants with an empty `userId` and a populated `uid` are normalized to the canonical `userId` when reading private assignments, importing legacy fields, creating/updating assignments and migrating drafts. A nonempty `userId` remains authoritative. Private assignments never fall back to public identifiers, names or email addresses. If an earlier migration already discarded the only UID, an organizer must reassign that participant through the existing account-assignment UI; the Worker cannot infer ownership safely.

Failed saves display the Worker error and remain unsaved; a browser cache is updated only after the server confirms persistence. `npx tsx scripts/test-player-priorities-client.mjs` checks the authenticated client request, UID/private-data loading and failure handling. `npx tsx scripts/test-firestore-security-worker.mjs` checks legacy UID compatibility and own/foreign authorization. `npm run test:firestore-rules` additionally runs real Worker transactions against the local emulator with the repository's restrictive rules loaded, using generated test credentials and no production connections.

### Organizer account search

`draft.search-users` requires ownership of the requested waiting draft (or the existing global administrator role) before querying `users`. It uses separate single-field prefix queries for display name and email, with original, lowercase, uppercase and capitalized spellings. Each query is limited to 20 results, at most eight queries are sent, and the merged results are deduplicated and limited to 20. This avoids a full profile scan and multi-field range/index requirements, and works without migrating legacy profiles or deploying new indexes. Unusual mixed-case legacy spellings can also be searched using their original prefix.

Search results contain only the profile document ID as `uid` and `displayName`, not email, roles or other profile fields. Profiles stored at `users/{FirebaseUID}` remain assignable whether their embedded identity field is `uid`, `userId`, missing or stale; the document ID is authoritative. Assignment still uses the guarded `draft.update` operation and resolves email privately on the server. Subsequent priority writes use the assigned Firebase UID.

Search errors are displayed separately from a successful empty result, and late responses cannot replace a newer query or update a closed selector. `npx tsx scripts/test-user-search-client.mjs` covers search/assignment requests, stale responses and safe error diagnostics. Worker and emulator tests cover account lookup, legacy profiles, authorization and assigned-player priorities.

For local diagnosis, restart `npm run dev`, open the organizer's participant selector and enter the failing prefix. In browser DevTools > Network, inspect the **Response** of `POST /api/firestore` (do not copy request headers or tokens). A validation failure returns HTTP 400 with a safe `message`; an upstream Firestore failure returns HTTP 502 and, only in development, a `diagnostic` containing the source, operation, upstream HTTP status and symbolic reason. The local terminal prints the same allowlisted upstream metadata, never the raw upstream body, token, profile, draft ID or search term. Share only `message` or `diagnostic` when troubleshooting. An original generic `invalid` message alone cannot identify whether validation or a backend query failed; the former handler conflated both.

## Organizer draft panels and confirmed pick announcements

The organizer's selected-team and history views share a two-tab panel. Participant rows are collapsed by default; their summary shows position, name, connection status, picked-team count and an expansion arrow. Expanding a row exposes the existing assignment, PIN, name and ordering controls. Existing pre-start editing and post-start locks remain unchanged.

Undoing the last turn is no longer available. The generic `draft.update` Worker operation cannot write the pick index, shorten/overwrite prior history, remove participant picks or increase the available-team count. Existing team replacement still swaps a team and appends a replacement history entry without moving the turn backwards; picks and skips continue using their dedicated transactional operations.

Every authorized player sees new confirmed picks in a nonblocking NHL-style broadcast overlay with the participant, existing team logo/name and an automatic-selection label when applicable. A body portal centers the fixed overlay horizontally and vertically in the viewport regardless of scrolling, with pointer events disabled. All 32 catalog NHL names use the shared `getNhlTeamNameLines` explicit geographic/nickname mapping in both the announcement and selection cards; unknown/custom names are preserved without guessing. Selection cards retain their logo sizes and center two lines with overflow protection. Each announcement appears for exactly 2 seconds, including short entrance/exit fades, with mobile sizing and reduced-motion support. A newly confirmed pick immediately replaces the previous announcement and starts its own 2-second timer; obsolete callbacks cannot dismiss it. The first server snapshot establishes a silent history baseline; cached/pending snapshots do not announce picks. New history entries are observed before asynchronous private-access reads and buffered until access is verified; when several picks arrive together only the newest is displayed. Refreshes/F5 never replay old history. Skip/replacement entries are not new-pick announcements.

`npm test` includes `scripts/test-pick-announcements.mjs` for confirmed-history tracking and display lifecycle, player snapshot tests for racing private reads and replacement events, all 32 selection-card name splits, organizer panel/accordion tests, and Worker regressions rejecting undo while preserving team replacement.

## Player sound alerts

The player page generates a short double turn-start signal and timestamp-aligned beeps at 5, 4, 3, 2 and 1 seconds remaining using Web Audio, without external audio files. Only the signed-in participant currently on turn hears them. Sounds default to enabled, and the single speaker toggle displays the saved preference "Zvuk ZAP" or "Zvuk VYP" even before browser audio unlock. Manual OFF persists in `localStorage` across reloads. Playback still activates only after user interaction when enabled, without a second activation button; the underlying audio scheduling is unchanged.

Audio-clock scheduling is independent of countdown renders. Initial page loads/F5 and repeated snapshots never replay the start signal. Pausing/resuming or correcting the timestamp of the same pick does not replay its start signal or elapsed countdown seconds. Missed beeps after late activation or browser audio suspension are skipped rather than played in a burst. Muting, submitting a manual pick, turn changes, completion and expiry cancel pending tones immediately. Existing timer, autopick and authorization logic are unchanged.

`npx tsx scripts/test-player-sounds.mjs` (also included in `npm test`) covers independent players, turn changes, the first turn after waiting, repeated/F5 data loads, exact 5-1 scheduling, timestamp corrections, mute persistence, activation, suspension/resumption, expiry, manual cancellation and cleanup.

## Automatic draft picks

Expired turns are processed by a Cloudflare Cron Trigger once per minute. The custom Worker entry point in `worker.ts` preserves the OpenNext `fetch` handler and adds the scheduled handler. The Worker uses the Firestore REST API with a service-account OAuth token; its service-account JSON must be set as the `FIREBASE_SERVICE_ACCOUNT_JSON` Cloudflare Worker secret. Never commit that JSON or its private key. The account needs the `roles/datastore.user` IAM role in the Firebase project. The project ID is configured as the non-secret `FIREBASE_PROJECT_ID` Wrangler variable.

To deploy through Cloudflare Workers Builds, connect the `dm-draft` Worker to this Git repository and set its production branch to `main`; use `npm run deploy` as the deploy command (it runs the OpenNext build and then `wrangler deploy`). The repository does not contain a GitHub Actions workflow, so the Cloudflare Dashboard's Workers Builds connection and settings must be configured separately. Add the `FIREBASE_SERVICE_ACCOUNT_JSON` secret to the Worker before enabling the Cron Trigger; it can be added with `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON` or in the Cloudflare Dashboard. Before enabling the new trigger, verify that no previously deployed Firebase scheduled function remains active; deleting its source code does not remove a deployed function. The Firebase project can remain on Spark; no Firebase Functions or Cloud Scheduler are used.

### Immediate automatic picks

Because the Cron runs in UTC once per minute, it alone would delay an auto-pick by up to a minute. The `POST /api/draft/auto-pick` route handler therefore lets a connected client ask the server to process the turn as soon as its countdown reaches zero. The Cron Trigger stays enabled as the fallback for drafts where nobody has the app open or the immediate request fails.

The player client scopes both the countdown and request lifecycle to the draft ID, pick index and `turnStartedAt`. Each expired turn gets its own request loop, independent of responses still arriving for older turns. Token acquisition, HTTP requests and recovery reads have a 10-second timeout. Network errors, HTTP 409/429/5xx and invalid responses are retried with exponential backoff capped at 10 seconds; `not-expired` is retried after one second without weakening the server clock check. HTTP 401 forces one token refresh; persistent 401, 403 and invalid/missing draft errors stop with an explicit message instead of showing endless progress. Cleanup cancels retries and ignores late responses when the turn changes, the draft pauses/completes, or the page unmounts.

An accepted response is not treated as a Firestore update. If the listener has not advanced after three seconds, the client explicitly re-reads the draft from the server, then retries if it is still on the same expired turn. These recovery reads occur only while an accepted request has not been reflected in the snapshot; normal turns rely on the existing listener. They use the Firebase client SDK and existing permissions, with no paid Firebase services.

Browser console diagnostics prefixed with `[autopick]` contain the turn key and request attempt number, never ID tokens or account details. `snapshot-observed` identifies listener progress and cache/pending-write metadata; `countdown-started` confirms a new timer; `turn-expired` / `token-request` without `request-sent` identifies a request not yet dispatched; `request-rejected` includes HTTP status; `response-received` includes the server outcome (including `not-expired`); `awaiting-snapshot` followed by `snapshot-missing` identifies an accepted response without a corresponding state update. `request-timeout`, `request-failed`, `retry-scheduled`, `snapshot-refresh-failed` and `request-stopped` describe recovery or terminal failures. Client lifecycle tests simulate ten consecutive turns, late responses, failures and listener recovery using fake timers.

The client only sends the draft ID and the pick index it believes expired; it never chooses a team and never writes the pick. The endpoint requires a Firebase ID token in the `Authorization: Bearer` header, which `workers/firebaseAuth.ts` verifies against the Google JWKS using WebCrypto, checking the signature, `alg`, `aud`, `iss`, `sub` and expiry. The Worker then re-reads the draft inside the Firestore transaction and refuses the request unless the caller's Firebase UID matches the draft's `ownerUserId` or one of its participants, the draft is still `drafting`, the pick index still matches, and `turnStartedAt` plus the time limit has genuinely passed. New drafts persist `ownerUserId` when they are created; older drafts without it remain restricted to their participants. A draft ID on its own therefore grants nothing. Each user is additionally limited to 12 requests per 10 seconds per Worker isolate; because isolates are not shared, this only smooths accidental loops, and the authentication, ownership or participant check, server-side expiry check and transaction are the real protection.

Both the Cron and the endpoint call the same `processExpiredDraft` function in `workers/firestore.ts`, so the selection logic exists only once. The Firestore read-write transaction, the `expectedPickIndex` guard and the HTTP 409 retry together guarantee that a turn is picked exactly once even when the Cron, several browsers and a manual pick race each other. The service-account JSON is only ever read from the Worker environment and is never sent to the browser.

For selection, the Worker reads both `publicDrafts/{id}` and `draftPrivate/{id}` in the same transaction. It resolves the participant at `pickOrder[currentPickIndex]` using the private assignment (including legacy `uid` compatibility), not the caller's UID or public identity fields. It then chooses the first available team from that UID's saved private priorities, skipping taken teams; missing, empty or exhausted priorities fall back to `teamRanking` followed by the existing draft item order. With a private document present, stale public or inline priorities are ignored. Legacy drafts without a private document retain their saved-priority behavior.

The effective private UID and priority data are used only for calculating the pick. The public write retains the public participants and updates their picks, history, available teams and turn state, without publishing private UIDs or priorities. A failed private read is an error, not a reason to use default rankings. If a priority save commits after the transaction reads but before the pick commits, Firestore aborts the stale transaction and the retry re-reads the current public/private data. Rankings are never taken from browser memory, the initial Cron query or an earlier turn.

The split-data regression tests save priorities through `draft.priorities` and exercise both triggers for multiple players, taken teams, repeated picks, fallback, concurrent triggers and priority changes before/during a pick. The rules emulator tests additionally run real alternating immediate/Cron transactions using private rankings and verify that public results do not expose private data. Earlier autopick fixtures kept participant UIDs and priorities together in public data, which did not exercise the privacy split.

The Cron query scans all active timed drafts so an early, not-yet-expired turn cannot block later expired turns. Its composite index is defined in `firestore.indexes.json` and must be deployed once using `firebase deploy --only firestore:indexes`. Spark includes 50,000 Firestore reads and 20,000 writes per day. A continuously active timed draft accounts for about 1,440 query reads per day, before app traffic and the transaction read/write for a completed pick; monitor the shared quota. Cloudflare's Free Workers plan allows 10 ms CPU per Cron invocation; if the Worker exceeds that limit, the task can fail and a paid Workers plan may be needed (currently from $5/month). The one-minute Cron runs in UTC, so a fallback auto-pick can be delayed by up to about one minute after expiration when no client is connected; trigger changes can take up to 15 minutes to propagate.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
