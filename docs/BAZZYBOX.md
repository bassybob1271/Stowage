# BazzyBox

BazzyBox is Stowage running with `BAZZYBOX=true`: a cheaper, no-lock-in alternative to Dropbox for filmmakers and musicians, sold inside Bazzy TV and stored on Backblaze B2, the storage planned for all three Bazzy companies (each in its own bucket).

## Pricing

| | Free | Lite | Flex | Studio |
|---|---|---|---|---|
| Price | $0 | **$4.99 per 30 days** (499 credits) | **$14.99 per 30 days** (1,499 credits) | **$79.99 per 30 days** (7,999 credits) |
| Included storage | 10 GB | **1 TB** | **3 TB** | **15 TB** |
| Past the included space | Uploads stop | **$9.50 per TB-month**, charged daily | **$9.50 per TB-month**, charged daily | **$9.50 per TB-month**, charged daily |
| Share-link downloads | 2 GB/month | 10 GB/month, then **$0.04/GB** | 50 GB/month, then **$0.04/GB** | 250 GB/month, then **$0.04/GB** |
| Pays for its own B2 storage until members average | — | 71.8% full | 71.9% full | 76.7% full |

**The "balanced" price set (Nov 27 2026).** Every plan covers its Backblaze B2 storage ($6.95/TB-month) until its members fill about three quarters of it on average, and extra space at $9.50/TB always earns $2.55/TB over B2. BazzyBox stays cheaper than Dropbox at 1 TB (Dropbox's smallest is Plus, 2 TB for $11.99), 3 TB (Professional, $19.99) and 15 TB (Advanced, 3 seats, $90); at 2 TB Dropbox Plus is cheaper. The pitch isn't the lowest price at every size: it's that Dropbox never lets anyone downgrade or leave cheaply, and BazzyBox does (change plans any day with unused days refunded, free exports, and a Dropbox importer to get in). Earlier prices were Flex $9.99 for 3 TB and Studio extra at $6/TB, which lost money on members past about half full. The working numbers are in the "BazzyBox plans vs Backblaze B2 cost" sheet. Switching between paid plans credits the unused days of the old plan first, and a switch the wallet can't cover changes nothing.

**Credits wallet.** 1 credit = $0.01. Packs: $10 → 1,000 · $25 → 2,600 (+4%) · $50 → 5,300 (+6%) · $100 → 11,000 (+10%). Credits don't expire. Plan fees, extra storage and paid sends come out of the wallet.

**The no-lock-in promise (what the code does):**
- Plans change immediately, any day. Moving to Free returns the unused part of the 30 days to the wallet (`proratedRefundMc`).
- Flex renews from the wallet. If the wallet can't pay, the account moves to Free; **files are never deleted**, uploads just pause while over the free space.
- Extra storage is billed by the day, so deleting a finished project lowers the bill the next day.
- Exports are free. B2 doesn't charge for downloads up to 3× stored data, and Stowage has no download fees for owners.

### Why these numbers

From the BazzyBox Revenue Model (November 2026 list prices):

- Dropbox charges $11.99/month for 2 TB (Plus) and $19.99–22 for 3 TB (Professional). Plan changes take effect at the end of the billing cycle, with a general no-refund policy.
- Backblaze B2 costs $6.95/TB-month pay-as-you-go, with free uploads, free class A/B/C API calls, egress free up to 3× storage (then $0.01/GB) and free egress to CDN partners (Bunny, Fastly, Cloudflare). The prices below were first worked out on IDrive e2 ($6/TB); B2 costs about $1/TB more, in exchange for one vendor across all three Bazzy companies.
- A grid search over base price, included space and per-TB rate maximized 36-month gross profit under two rules: every customer type pays at least 15% less than the matching Dropbox plan, and extra storage sells for at least 30% over cost. With medium price sensitivity, the result was $9.99 for 3 TB plus $9.50/TB.
- Heavy users are thin-margin: on B2, someone storing about 1.8 TB costs about $13.80/month to host against Flex's $9.99. Margin comes from light users and paid sends. Flex's extra storage at $9.50/TB keeps about 20% over B2's cost.
- Credits cut card fees. Stripe takes 2.9% + 30¢ per charge, so one $25 top-up loses 4.1%, while a $9.99 monthly card charge would lose 5.9%.

Sample assumptions (user mix, signups, churn, elasticity) need testing with real Bazzy TV creators before the price is locked.

## Website: box.bazzy.io

The BazzyBox server is also its public website. On `/`, visitors without a session get the marketing page (`apps/server/src/box/site.ts`): the pitch, a live Dropbox-vs-BazzyBox price calculator, the no-lock-in promise, plans, credit packs and an FAQ. Prices on the page are read from `pricing.ts`, so they always match what the wallet charges. Signed-in users get the file app at the same URL. "Start free" goes to `/signup` (the create-account tab) and "Sign in" to `/login`. Logging out returns to the website.

The Bazzy TV video page (`apps/live`, live.bazzy.io) links to it from its header (`LIVE_BOX_URL`, default `https://box.bazzy.io`), and the website links back (`BAZZY_TV_URL`, default `https://live.bazzy.io`).

**Going live on the subdomain** (same Cloudflare Tunnel as live.bazzy.io):

1. Root `.env`: `BAZZYBOX=true`, `APP_ORIGIN=https://box.bazzy.io`, `NODE_ENV=production`, the B2 (`BOX_B2_*`) and Stripe keys, and `SESSION_SECRET`/`MASTER_KEY`. Add the B2 `box` mount to `mounts.yaml` (see `deploy/mounts.example.yaml`).
2. Build: `pnpm --filter @stowage/web build && pnpm --filter @stowage/server build`.
3. Add the `box.bazzy.io` ingress rule to `deploy/cloudflared/native.yml`, using `deploy/cloudflared.example.yml` as the template, and route DNS once: `cloudflared tunnel route dns <tunnel-name> box.bazzy.io`.
4. Start everything with `sh apps/live/scripts/run-native.sh`. It runs the BazzyBox server when the root `.env` has `BAZZYBOX=true`.
5. In Stripe, set the webhook to `https://box.bazzy.io/api/box/webhook/stripe`.

Uploads go in 8 MB resumable chunks, under Cloudflare's 100 MB request limit. Large downloads and share links through a free or Pro Cloudflare plan carry the same caveat as live video: fine for a modest audience, but heavy public traffic may need a paid plan or direct presigned B2 links (`DIRECT_TRANSFER=true`).

## Playlist Maker

The **Playlist Maker** button sits in the BazzyBox header and at the top of the sidebar. A playlist is an ordered list of audio and video files from the owner's own folder (any audio, plus video browsers play: MP4, M4V, WebM, MOV, OGV), with a name, an optional description and a cover picture. Pictures are resized in the browser to 1200 px JPEG, and the server accepts only real JPEG, PNG or WebP up to 1.5 MB.

**Create share link** makes one public page at `/p/<token>`:
- **The page:** cover, title, track list, Play and Shuffle, audio in a bottom bar and video inline. It carries Open Graph tags, so links unfurl with the cover in Messages, Slack and social apps.
- **Streaming:** with Range support. Streamed bytes count against the owner's monthly share-link allowance, the same as single-file share links.
- **Privacy:** the page shows no owner details and asks search engines not to index it.
- **Turning sharing off:** **Stop sharing** kills the link at once. Sharing again makes a new link.

Files must exist in the owner's folder and be playable when the playlist is saved. A track deleted later simply stops playing on the shared page. Code: `apps/server/src/box/playlists.ts` and `apps/web/src/components/PlaylistMaker.tsx`; tests in `apps/server/test/playlists.test.ts`.

## Sign in with Bazzy TV

BazzyBox can sign people in with their Bazzy TV account, so whatever Bazzy TV accepts (email and password, Sign in with Apple, Sign in with Google) works here too. Bazzy TV is the OAuth 2.0 provider (`bassybob1271/bazzy-video`, branch `sign-in-apple-google`); BazzyBox is a confidential client using the authorization code flow with PKCE.

1. "Sign in with Bazzy TV" calls `GET /api/auth/bazzy/start`. That keeps state and the PKCE verifier in a signed cookie, then redirects to `{BAZZY_AUTH_URL}/oauth/authorize`.
2. Bazzy TV signs the person in if needed. BazzyBox is registered as trusted, so there's no consent click. Bazzy TV then sends the browser back to `/api/auth/bazzy/callback?code=…`.
3. The server swaps the code at `/api/v1/oauth/token` (client secret + verifier) and reads `/api/v1/oauth/userinfo`. Then it links or creates the BazzyBox account and starts the usual session.

**Account matching.** Links live in the `account_links` table (`bazzy:<user id>`), so a later email change on Bazzy TV doesn't matter. On a first sign-in:
- If Bazzy TV has **verified** the email (true for Apple and Google accounts), it joins the BazzyBox account with that email.
- If the email is **unverified** and already belongs to a BazzyBox account, it's refused, so nobody can claim someone else's files by registering their address on Bazzy TV.
- Otherwise a new Free account is made. Its password is unusable; that person signs in through Bazzy TV.

**Setup.**
- **BazzyBox `.env`:** `BAZZY_AUTH_URL` (the Bazzy TV website), `BAZZY_CLIENT_ID=bazzybox`, `BAZZY_CLIENT_SECRET`, and `APP_ORIGIN=https://box.bazzy.io`.
- **Bazzy TV `.env`:** add the same client to `OAUTH_CLIENTS` with redirect URI `https://box.bazzy.io/api/auth/bazzy/callback`.

The button appears on the BazzyBox sign-in page once these are set. Failed sign-ins come back to `/login?error=…`.

## Operating it

- **Backing store:** `BOX_MOUNT` must be an `s3` mount (Backblaze B2 in production) or `local` (development). Each user gets a scoped adapter rooted at `u/<id>/`. Use a private bucket of its own and an application key limited to it.
- **Backup:** keep a second copy off Backblaze, since all three Bazzy companies are meant to store there. A nightly `rclone sync` to IDrive e2 or a Hetzner Storage Box (about €2/TB) is enough, and B2-to-anywhere copies are free within the 3× egress allowance.
- **Payments:** `STRIPE_SECRET_KEY` enables Checkout for credit packs. The webhook (`/api/box/webhook/stripe`, event `checkout.session.completed`) is signature-verified with `STRIPE_WEBHOOK_SECRET`. Each Checkout session id is stored as a unique ledger reference, so repeated webhooks credit once.
- **Meter:** every `BOX_METER_INTERVAL_SEC` (default hourly) each account is checked. Whole days since the last charge are billed for storage past the included space, Flex renewals are taken, and the 30-day send allowance resets.
- **Usage:** recounted by walking the user's folder a moment after uploads and deletes. B2 charges nothing for listing calls.
- **Refunds:** the policy promises refunds of unused purchased credits on account closure. That is processed manually in Stripe today; an account-closure endpoint is a follow-up.
- **Legal:** prepaid credits may count as customer liabilities and can fall under state gift-card or refund rules. Check with an accountant.

## API

| Route | |
|---|---|
| `POST /api/auth/box/signup` `{email, password}` | Create an account (password ≥ 10 chars) and sign in |
| `POST /api/auth/box/login` `{email, password}` | Sign in (rate-limited per IP) |
| `GET /api/box/me` | Plan, usage, wallet, price list, recent activity |
| `POST /api/box/usage/refresh` | Recount stored bytes now |
| `POST /api/box/plan` `{plan: "free" \| "flex" \| "studio"}` | Switch plan immediately |
| `POST /api/box/credits` `{pack}` | Returns `{checkoutUrl}` (Stripe), or grants instantly with `BOX_DEV_CREDITS` |
| `GET/POST /api/box/shares`, `DELETE /api/box/shares/:token` | Share links |
| `GET /s/:token/:name` | Public download (Range supported, metered) |
| `POST /api/box/webhook/stripe` | Stripe webhook |

## Follow-ups

- Account closure with automatic refund of unused purchased credits.
- Auto top-up (saved card, refill below a threshold) via Stripe Customer + off-session payments.
- "Publish to Bazzy TV": hand a file to the Bazzy TV channel pipeline (`apps/live` handles live streams today; a VOD ingest endpoint is needed).
- Team seats sharing one wallet, for crews and studios.
- Password reset by email.
