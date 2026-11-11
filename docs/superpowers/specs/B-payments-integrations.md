# Spec B — Payments & integrations (PayPal, Channel3, Telegram, scan, cron)

**Status: approved design. The step-by-step plan is written: `docs/superpowers/plans/B.md` — execute the plan; this spec is background.**
Read first: `CLAUDE.md`, `docs/STACK_NOTES.md` §2, §3, §5, §7, `docs/ARCHITECTURE.md` §2–§4, §8–§10, `shared/types/index.ts`.

## Goal
Connect the agent to the outside world: find products (Channel3), run the watcher pipeline, alert the user (Telegram)
and take payment through the PayPal Agent Toolkit behind a code-enforced mandate guard.

## Files (create unless marked ✔ = exists, extend it)
```
server/lib/integrations/
  paypal-toolkit.ts      ✔ guardedPayPalTools, callPayPalTool, makeCheckoutGuard, buildCreateOrderInput, findApproveUrl (tested)
  channel3-normalise.ts  ✔ normaliseProduct (tested)
  channel3.ts              searchProducts(query, { limit }) → ListingDraft[]
  checkout.ts              createCheckout(matchId, userId), captureOrder(paypalOrderId)
  telegram.ts              tg(method, body), escapeHtml, dealMessage(...), handleUpdate(update)
  notify.ts                notifyDeal(matchId)
  scan.ts                  runScan(opts) → ScanResponse, keywordMatch(query, title)
  index.ts               ✔ stub — the LEAD replaces each stub body with the real import as it lands
server/api/scan.post.ts
server/api/checkout/index.post.ts   server/api/checkout/return.get.ts   server/api/checkout/cancel.get.ts
server/api/paypal/webhook.post.ts   (stretch)
server/api/telegram/webhook.post.ts
scripts/paypal-spike.ts   scripts/channel3-spike.ts
supabase/cron.sql        ✔ (stretch: fill the two placeholders and run it)
tests/integrations/*.test.ts   ✔ paypal-toolkit.test.ts and channel3-normalise.test.ts exist
```
Suggested teammates: **paypal** (`checkout.ts`, `server/api/checkout/**`, `server/api/paypal/**`, `scripts/paypal-spike.ts`, tests) · **comms** (`telegram.ts`, `notify.ts`, `server/api/telegram/**`, tests) · **scan** (`channel3.ts`, `scan.ts`, `server/api/scan.post.ts`, `scripts/channel3-spike.ts`, tests). `index.ts` is edited by the **lead** only.

## H0 — the human lead does these first (they need accounts and a browser)
1. developer.paypal.com → create a **sandbox app** (client id + secret) and note one sandbox **personal** (buyer) account's email/password. Put the keys in `.env`.
2. `scripts/paypal-spike.ts` (`pnpm spike:paypal`): with `callPayPalTool('create_order', buildCreateOrderInput({ title: 'Spike', amount: 1, returnUrl: 'https://example.com/return', cancelUrl: 'https://example.com/cancel' }), () => {})` → print the **full raw result** and `findApproveUrl(result)` → open the link, approve with the sandbox buyer → run again with the order id to call `pay_order` → print the raw result. **Paste both raw results into `docs/progress/B.md`** (they define how `checkout.ts` parses ids/status). If the toolkit call fails for a reason you cannot fix in 30 minutes, implement the REST fallback from STACK_NOTES §2 behind the same function names and note it in the progress file.
3. trychannel3.com/developers → key with promo code `PAYPAL-HACKATHON-2026`. `pnpm spike:channel3`: search the keyboard query from `seed/data.json` and "wireless noise cancelling headphones"; save both raw responses to `tests/integrations/fixtures/channel3-*.json`; print how many products survive `normaliseProduct`.
4. Telegram: @BotFather → `/newbot` → token + username into `.env`.

## Tasks

### B1 — `channel3.ts`
`searchProducts` per STACK_NOTES §3 using `normaliseProduct`; drop nulls; one retry on network/5xx/429 after 1 s; in-memory cache per query for 10 minutes; never throws to the caller of scan — on failure log and return `[]`. Tests with a fake client injected (`setChannel3ClientForTests`).

### B2 — `scan.ts` + route
Implement ARCHITECTURE §4 exactly (numbered steps). `keywordMatch` is a pure exported function with tests (cases from the seed data: headphones query matches every `wl-headphones` listing title and no `wl-handheld` title, and vice versa).
`runScan({ wishlistItemId?, userId?, isCron, budgetMs = 45_000 })`. Handle `MatcherUnavailableError` by skipping the batch.
Tests with `setDbForTests` and a fake `ai`: status decisions for fixed-price vs negotiable, `over_budget`, prefilter, one auto-negotiation per item, notify-best-only.
✅ Works against the **stub** `ai` first (everything matches, low risk) — do not wait for A.

### B3 — `notify.ts` + `telegram.ts` + webhook route
ARCHITECTURE §8 and §10. `tg()` = plain `fetch`; all Telegram errors are caught and logged. `escapeHtml` on every interpolated string. Tests with mocked `fetch`: claim lost → no message; no chat id → claimed but no message; marketplace vs channel3 keyboards; `/start <token>` linking; bad secret header → 200 and nothing done.
After the first deploy, register the webhook once:
`curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=$APP_URL/api/telegram/webhook&secret_token=$TELEGRAM_WEBHOOK_SECRET"`

### B4 — `checkout.ts` + routes
ARCHITECTURE §9 exactly. Parse ids/status according to the raw results recorded in H0 step 2.
Tests (`setRawPayPalToolsForTests`, `setDbForTests`, `mockToolCallModel`): happy path via LLM tool call; LLM returns no tool call → direct fallback still creates the order; guard block → 409 and **no** fallback; channel3 listing → `not_payable`; existing `created` order is reused; capture is idempotent.

### B5 — Wire the entry point
Lead replaces the stubs in `server/lib/integrations/index.ts`. Run `pnpm test && pnpm typecheck`.

### B6 (stretch) — cron + PayPal webhook
`supabase/cron.sql` (replace `<CRON_SECRET>` and `<APP_URL>`, run in the SQL editor, check `cron.job_run_details`). Webhook per ARCHITECTURE §9.

## Checkpoints
- **Thu 09:00:** H0 results recorded; B1–B3 done with tests; scan runs locally against the seeded DB with the stub `ai`.
- **Thu 15:00:** on the deployed URL: scan → Telegram message → Approve & pay → sandbox approval → captured → receipt.

## Pitfalls
- `returnUrl` / `cancelUrl` must use `env.appUrl` (the deployed URL in production), never a hard-coded localhost.
- The checkout return and cancel routes are opened by PayPal's redirect — do not call `requireUser` there; look the order up by `paypal_order_id`.
- Telegram webhooks need public HTTPS: test them on the Vercel deployment (or a tunnel), not localhost.
- Log order ids, never secrets or full tokens.
- Before Checkpoint 2 have the lead run a security review (`/security-review`) over `server/api/{scan,checkout,paypal,telegram}/**`.
