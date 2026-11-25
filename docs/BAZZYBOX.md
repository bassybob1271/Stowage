# BazzyBox

BazzyBox is Stowage running with `BAZZYBOX=true`: a cheaper, no-lock-in alternative to Dropbox for filmmakers and musicians, sold inside Bazzy TV and stored on IDrive e2.

## Pricing

| | Free | Flex |
|---|---|---|
| Price | $0 | **$9.99 per 30 days** (999 credits) |
| Included storage | 10 GB | **3 TB** |
| Past the included space | Uploads stop | **$9.50 per TB-month**, charged daily |
| Share-link downloads | 2 GB/month | 50 GB/month, then **$0.04/GB** |

**Credits wallet.** 1 credit = $0.01. Packs: $10 → 1,000 · $25 → 2,600 (+4%) · $50 → 5,300 (+6%) · $100 → 11,000 (+10%). Credits don't expire. Plan fees, extra storage and paid sends come out of the wallet.

**The no-lock-in promise (what the code does):**
- Plans change immediately, any day. Moving to Free returns the unused part of the 30 days to the wallet (`proratedRefundMc`).
- Flex renews from the wallet. If the wallet can't pay, the account moves to Free; **files are never deleted**, uploads just pause while over the free space.
- Extra storage is billed by the day, so deleting a finished project lowers the bill the next day.
- Exports are free. IDrive e2 doesn't charge egress up to 3× stored data, and Stowage has no download fees for owners.

### Why these numbers

From the BazzyBox Revenue Model (November 2026 list prices):

- Dropbox charges $11.99/month for 2 TB (Plus) and $19.99–22 for 3 TB (Professional). Plan changes take effect at the end of the billing cycle, with a general no-refund policy.
- IDrive e2 costs $6/TB-month pay-as-you-go ($4.96 on a yearly plan, $4.13 on three years), with free API calls and free egress up to 3× storage.
- A grid search over base price, included space and per-TB rate maximized 36-month gross profit under two rules: every customer type pays at least 15% less than the matching Dropbox plan, and extra storage sells for at least 30% over cost. With medium price sensitivity, the result was $9.99 for 3 TB plus $9.50/TB.
- Heavy users are thin-margin on pay-as-you-go e2: someone storing about 1.8 TB costs about $11/month to host. Margin comes from light users, paid sends and committing to a yearly e2 plan once volume is predictable.
- Credits cut card fees. Stripe takes 2.9% + 30¢ per charge, so one $25 top-up loses 4.1%, while a $9.99 monthly card charge would lose 5.9%.

Sample assumptions (user mix, signups, churn, elasticity) need testing with real Bazzy TV creators before the price is locked.

## Operating it

- **Backing store:** `BOX_MOUNT` must be an `s3` mount (IDrive e2 in production) or `local` (development). Each user gets a scoped adapter rooted at `u/<id>/`. Keep a second copy of the bucket (for example nightly rclone to Backblaze B2 or a Hetzner Storage Box) for irreplaceable masters.
- **Payments:** `STRIPE_SECRET_KEY` enables Checkout for credit packs. The webhook (`/api/box/webhook/stripe`, event `checkout.session.completed`) is signature-verified with `STRIPE_WEBHOOK_SECRET`. Each Checkout session id is stored as a unique ledger reference, so repeated webhooks credit once.
- **Meter:** every `BOX_METER_INTERVAL_SEC` (default hourly) each account is checked. Whole days since the last charge are billed for storage past the included space, Flex renewals are taken, and the 30-day send allowance resets.
- **Usage:** recounted by walking the user's folder a moment after uploads and deletes. e2 charges nothing for listing calls.
- **Refunds:** the policy promises refunds of unused purchased credits on account closure. That is processed manually in Stripe today; an account-closure endpoint is a follow-up.
- **Legal:** prepaid credits may count as customer liabilities and can fall under state gift-card or refund rules. Check with an accountant.

## API

| Route | |
|---|---|
| `POST /api/auth/box/signup` `{email, password}` | Create an account (password ≥ 10 chars) and sign in |
| `POST /api/auth/box/login` `{email, password}` | Sign in (rate-limited per IP) |
| `GET /api/box/me` | Plan, usage, wallet, price list, recent activity |
| `POST /api/box/usage/refresh` | Recount stored bytes now |
| `POST /api/box/plan` `{plan: "free" \| "flex"}` | Switch plan immediately |
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
