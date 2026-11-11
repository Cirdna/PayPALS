# Spec B — Payments & integrations (PayPal, Channel3, Telegram, scan pipeline, cron)

**Status:** approved design — go straight to `writing-plans`. **Owner:** Lead B + agent team.
**Read with:** `CLAUDE.md`, `docs/ARCHITECTURE.md` §2.1, §2.3, §2.4, §8, `shared/types.ts` (`Integrations`, `Order`, `ScanResponse`, `CheckoutCreate*`).

## Goal
Connect the agent to the outside world: find products (Channel3), run the watcher pipeline, alert the user (Telegram) and take payment safely (PayPal Agent Toolkit / Orders v2 under a mandate guard).

## You own
```
server/lib/integrations/
  paypal-auth.ts     # OAuth client-credentials token cache
  paypal-rest.ts     # createOrder, getOrder, captureOrder, verifyWebhookSignature (REST, sandbox)
  paypal-agent.ts    # checkoutAgent: AI SDK generateText + PayPal Agent Toolkit tools wrapped by guardTools(mandate)
  checkout.ts        # createCheckout(matchId, userId), captureOrder(paypalOrderId) – used by routes + Telegram
  channel3.ts        # searchProducts(query, {maxPrice, limit}) → normalised Listing fields
  telegram.ts        # tg(method, body), sendDealNotification(userId, matchId), handleUpdate(update)
  scan.ts            # runScan({ wishlistItemId?, userId?, timeBudgetMs }) → ScanResponse
server/api/scan.post.ts
server/api/checkout/index.post.ts, return.get.ts, cancel.get.ts
server/api/paypal/webhook.post.ts
server/api/telegram/webhook.post.ts
supabase/cron.sql
scripts/paypal-spike.ts, scripts/channel3-spike.ts
tests/integrations/**
```

## Depends on
- A: `ai.matchListing`, `ai.assessRisk`, `ai.startNegotiation`, `ai.stepNegotiation`, `ai.checkMandate` (from `server/lib/ai`). Stub them until A merges (stub: match = true, risk = low, checkMandate = real simple compare).
- C: `useServiceClient()`, `requireUser(event)`, db mappers, seeded marketplace listings.

## H0 spikes (tonight, before anything else) — report results in `docs/PROGRESS.md`
1. **PayPal spike** `pnpm tsx scripts/paypal-spike.ts`: token → create order (USD 1.00, return/cancel URLs to localhost) → print approve link → approve manually with sandbox *personal* account → capture → print status COMPLETED. Then try the same create via **Agent Toolkit** (`new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } } })` — verify option names against the toolkit README), list `Object.keys(toolkit.getTools())`, and check the AI SDK version it expects. **Decide by 00:30: toolkit-create vs REST-create** (see ARCHITECTURE §2.3).
2. **Channel3 spike**: sign up at trychannel3.com/developers, promo code `PAYPAL-HACKATHON-2026`, run 3 searches for the demo themes, save sample JSON to `tests/integrations/fixtures/channel3-*.json`, write the normaliser against it. Note currency + whether prices are numbers/strings.
3. **Telegram**: create bot with @BotFather, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`.

## Tasks
1. `paypal-auth.ts`, `paypal-rest.ts` with tests (mock fetch). Use `PayPal-Request-Id` = matchId for idempotent create. Approve link: find `links` rel `payer-action` or `approve`.
2. `paypal-agent.ts` — `guardTools(tools, mandate)`: wrap the create-order tool's `execute`, parse the amount from its args, call `ai.checkMandate`; throw `MandateViolation` before PayPal is called. Unit test the wrapper with a fake tool. If toolkit-create was rejected in the spike, the agent uses toolkit for `get order` only and creation goes through REST + `checkMandate`.
3. `checkout.ts` + routes:
   - `POST /api/checkout`: load match (status `agreed` or `notified`), mandate, best price → `checkMandate` → create order → insert `orders` row → match `checkout_pending` → event `order_created` → return `approveUrl`.
   - `GET /api/checkout/return?token=`: look up order by `paypal_order_id`, capture, mark `completed`, match `purchased`, wishlist item `fulfilled`, event `order_captured`, Telegram receipt, redirect to `/deals/:matchId?paid=1`. Safe to call twice.
   - `GET /api/checkout/cancel`: mark `cancelled`, match back to `notified`.
4. `POST /api/paypal/webhook`: verify signature (`PAYPAL_WEBHOOK_ID`), dedupe via `webhook_events`, handle `PAYMENT.CAPTURE.COMPLETED` (and `CHECKOUT.ORDER.APPROVED` → capture if return URL never hit). Register the webhook URL in the PayPal developer dashboard after first deploy.
5. `channel3.ts` — normalise to `Listing` fields: `source 'channel3'`, `condition 'new'`, `negotiable false`, `retailer`, skip non-`APP_CURRENCY` prices. Handle 429/5xx with one retry; cache results per query for 10 min (in-memory Map is fine).
6. `telegram.ts` + webhook route: secret header check; `/start <token>` linking; `/help`; callback `pay:<matchId>` → `createCheckout` → send URL button; `skip:<matchId>` → match `skipped`. `sendDealNotification` message format per ARCHITECTURE §2.4 (escape HTML!).
7. `scan.ts` + `POST /api/scan`: auth = `Authorization: Bearer CRON_SECRET` (all users) or logged-in user (own items). Time budget 20 s: first advance active negotiations (≤2 steps each), then scan ≤5 active items per call, oldest-scanned first. Emit `scan_started/finished` events. Returns `ScanResponse`.
8. `supabase/cron.sql` — fill URL after first Vercel deploy; run in SQL editor; verify `cron.job_run_details`.

## Acceptance
- Checkpoint 1 (Thu 09:00): spikes done; REST/agent checkout works from a script; Channel3 normaliser tested on fixtures; Telegram linking + a test message works locally via ngrok or on the Vercel preview.
- Checkpoint 2 (Thu 15:00): on the deployed URL — "Scan now" creates matches; Telegram deal message arrives; Approve & pay → sandbox approval → captured → receipt; sandbox dashboard shows the payment.

## Pitfalls
- Return URL must be the deployed `APP_URL` (env), not localhost, in prod.
- Telegram webhooks need HTTPS → test against Vercel preview deployments (or ngrok locally).
- Never log full PayPal/Telegram secrets; log order ids only.
- Run ECC security review on checkout/webhook/telegram/scan routes before Checkpoint 2.
