# Stack notes — verified facts (read before writing code)

Everything here was checked against the **installed package versions** on 11 Nov 2026. Several APIs changed
recently and differ from older tutorials and from what a model remembers. **When this file and your memory
disagree, this file wins.** If you find something here is wrong, fix this file in the same commit.

Installed: nuxt 4.6 · vue 3.5 · vue-router 5 · @nuxt/ui 4.12 · @nuxtjs/supabase 2.1 · ai 7.0 · @ai-sdk/groq 4.0 · @ai-sdk/google 4.0 ·
zod **3.25** · @paypal/agent-toolkit 1.11 · @channel3/sdk 4.9 · ag-grid-community / ag-grid-vue3 36.3 · vitest 3 · pnpm 10.

**Do not upgrade or add dependencies.** In particular keep `zod` on v3 (the PayPal toolkit's schemas are zod 3).

---

## 1. AI SDK v7 (`ai`)

| Old habit (wrong here) | Correct in this repo |
|---|---|
| `generateObject({ schema })` | **deprecated.** Use `generateStructured()` from `server/lib/ai/structured.ts` (wraps `generateText({ output: Output.object({ schema }) })`, result on `.output`) |
| `tool({ parameters })` | `tool({ inputSchema })` |
| `maxSteps: 5` | `stopWhen: stepCountIs(5)` |
| `toolChoice: 'required'` with several steps | throws `ToolChoiceViolationError` on the step without a tool call → use `stopWhen: stepCountIs(1)` |
| reading `result.toolResults[0].result` | read `result.steps.flatMap(s => s.content)`; parts have `type: 'tool-result'` (`.output`) or `type: 'tool-error'` (`.error`) |
| hard-coded model id | `getModel('smart' \| 'fast')` from `server/lib/ai/model.ts` (provider from `AI_PROVIDER`, default `groq`; ids from env, defaults `openai/gpt-oss-20b` (smart) / `openai/gpt-oss-120b` (fast); with `google`: `gemini-flash-latest` / `gemini-flash-lite-latest`) |
| `MockLanguageModelV1/V2` in tests | `tests/helpers/mock-model.ts` (`mockJsonModel`, `mockToolCallModel`, `mockFailingModel`) + `setModelForTests()` |

- Never call the LLM directly from a route. JSON → `generateStructured` (never throws; returns your `fallback` after 2 failed attempts).
- Wrap all seller/listing text with `untrusted('seller_message', text)` before it goes into a prompt.
- Groq free tier is rate-limited (~8k tokens/min per model): run LLM calls **sequentially** (no `Promise.all` over LLM calls). `generateStructured` waits out a short advertised limit once, otherwise falls back and cools the model down for 60 s.

## 2. PayPal Agent Toolkit 1.11 (`@paypal/agent-toolkit/ai-sdk`)

- With `actions: { orders: { create: true, get: true, capture: true } }` it exposes exactly **`create_order`, `get_order`, `pay_order`** (`pay_order` = capture an approved order).
- `create_order` input: `{ currencyCode: 'USD', items: [{ name, quantity, itemCost, itemTotal, description?, taxPercent? }], shippingCost?, discount?, returnUrl?, cancelUrl? }`. **`currencyCode` only accepts `'USD'`** → the whole app is USD.
- `get_order` / `pay_order` input: `{ id }` where id matches `^[A-Z0-9]{17,32}$`.
- The toolkit bundles **AI SDK v4** internally; its tools are `{ description, parameters, execute }`. **Never pass `toolkit.getTools()` to our `generateText`.** Use `server/lib/integrations/paypal-toolkit.ts`:
  - `guardedPayPalTools(guard)` → tools re-wrapped for AI SDK v7, guard runs before every call
  - `callPayPalTool(name, input, guard)` → deterministic call without an LLM (capture, and the fallback path)
  - `makeCheckoutGuard({ expectedAmount, mandateCheck })` → one item, qty 1, no tax/shipping/discount, USD, **amount must equal the agreed price** and pass the mandate
  - `buildCreateOrderInput(...)`, `findApproveUrl(order)`, `parseToolResult(x)`
- Not yet verified against the live sandbox (needs credentials): the exact JSON the tools return. B's first task is `pnpm spike:paypal` to confirm the result contains `id` and a link with `rel: 'payer-action'` or `'approve'`.
- REST fallback (sandbox base `https://api-m.sandbox.paypal.com`): `POST /v1/oauth2/token` (basic auth, `grant_type=client_credentials`) → `POST /v2/checkout/orders` (`intent: 'CAPTURE'`, `purchase_units[0].amount { currency_code, value: toPayPalAmount(x) }`, `payment_source.paypal.experience_context { return_url, cancel_url, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' }`) → `POST /v2/checkout/orders/{id}/capture`.
- After approval PayPal redirects to `returnUrl?token=<ORDER_ID>&PayerID=...`. The order id is the **`token`** query parameter.

## 3. Channel3 SDK 4.9 (`@channel3/sdk`)

```ts
import { Channel3 } from '@channel3/sdk'            // NAMED export. Not default. Not `Channel3Client`.
const client = new Channel3({ apiKey: env.channel3ApiKey, currency: 'USD', country: 'US' })
const page = await client.products.search({ query, limit: 10, filters: { availability: ['InStock'] } })
const products = page.data                           // NOT page.products
```
- `Product`: `{ id, title, description?, key_features?, images?: [{ url, is_main_image? }], offers?: [{ url, domain, price: { price, currency }, availability: 'InStock' | 'OutOfStock', condition?: 'new' | 'used' }] }`.
- Use `normaliseProduct()` from `server/lib/integrations/channel3-normalise.ts` (tested) to turn a product into a `ListingDraft`.
- Auth header is `x-api-key`. 20,000 free credits with promo code `PAYPAL-HACKATHON-2026` at trychannel3.com/developers.
- Not verified live (needs a key): rate limits and typical latency. B runs `pnpm spike:channel3` and saves 2 real responses as fixtures.

## 4. Nuxt 4

- Folders: `app/` (Vue), `server/` (Nitro), `shared/` (both). Only `shared/types/` and `shared/utils/` exist; **always import explicitly**:
  `import type { Match } from '#shared/types'` · `import { roundMoney } from '#shared/utils/money'`.
- Server routes: `server/api/foo.get.ts`, `server/api/foo/[id].post.ts`; `defineEventHandler`, `readBody`, `getQuery`, `getRouterParam`, `getHeader`, `createError`, `sendRedirect` are auto-imported **in routes**.
- **`server/lib/**` must be framework-free** (it is unit-tested with plain vitest and reused by tsx scripts): no `useRuntimeConfig`, no auto-imports, no `defineEventHandler`. Use `env` from `server/lib/env.ts` and `db()` from `server/lib/db.ts`. Inside `server/lib` import with relative paths or `~~/server/lib/...`.
- Secrets never go in `runtimeConfig.public` and never in `app/**`.
- Errors from routes: `throw createError({ statusCode: 409, statusMessage: 'Blocked by mandate', data: { code: 'exceeds_mandate' } })`.
- Vercel: `maxDuration` is 60 s (set in `nuxt.config.ts`). Keep every request well under that.

## 5. Supabase

- **Auth in routes:** `const user = await requireUser(event)` (auto-imported from `server/utils/auth.ts`) → `{ id, email }`. `@nuxtjs/supabase` v2's `serverSupabaseUser` returns **JWT claims**: the id is `claims.sub`, there is no `.id`.
- **DB in server code:** `db()` from `server/lib/db.ts` = service-role client, **bypasses RLS** → always filter by `user_id` yourself. Wrap results with `unwrap(await db().from(...)..., 'what')`.
- Rows are snake_case; convert with `toCamel<T>(row)` / `toSnake(obj)` from `server/lib/mappers.ts` (shallow; jsonb columns hold camelCase objects as-is; money columns come back as numbers).
- Atomic claims are SQL functions: `db().rpc('claim_negotiation', { p_id, p_lock_seconds: 45 })` and `db().rpc('claim_deal_notification', { p_match_id })` — both return `[]` when you did not get the claim.
- **Browser:** `useSupabaseClient()` / `useSupabaseUser()` (auto-imported). The browser may only *read* (RLS) and subscribe to Realtime on `matches`, `negotiation_messages`, `agent_events`. All writes go through `/api/**`.
- Env names: `SUPABASE_URL`, `SUPABASE_KEY` (publishable/anon), `SUPABASE_SECRET_KEY` *or* `SUPABASE_SERVICE_KEY` (secret/service_role).
- The login redirect of `@nuxtjs/supabase` only guards **pages**; `/api/**` is never redirected. Public pages are listed in `nuxt.config.ts → supabase.redirectOptions.exclude`.
- Scheduled scan: Vercel Hobby allows cron only once per day → `supabase/cron.sql` (pg_cron + pg_net) calls `/api/scan` every 15 min.

## 6. AG Grid 36 + Vue

- Working example: `app/components/DealsGrid.client.vue` (keep `ModuleRegistry.registerModules([AllCommunityModule])`, the `:theme="themeQuartz"` prop and the `.client.vue` suffix). Do **not** import the old `ag-grid.css` / `ag-theme-*.css` files — v36 themes are JS objects.

## 7. Telegram Bot API (plain `fetch`, no SDK)

- `POST https://api.telegram.org/bot<TOKEN>/<method>` with JSON. Methods used: `sendMessage` (`parse_mode: 'HTML'`, `reply_markup.inline_keyboard`), `answerCallbackQuery`, `setWebhook`.
- Webhook requests carry header `X-Telegram-Bot-Api-Secret-Token` — must equal `TELEGRAM_WEBHOOK_SECRET`.
- `callback_data` max 64 bytes: `pay:<uuid>` / `skip:<uuid>` fit. Escape `<`, `>`, `&` in any text you interpolate into HTML messages.
- Always answer the webhook with HTTP 200 (even on errors) or Telegram keeps retrying.

## 8. Tooling

- `pnpm test` (vitest, no network, no real LLM) · `pnpm typecheck` (covers `app/`, `server/`, `shared/`) · `pnpm build`.
- Scripts (`supabase/seed.ts`, `scripts/*.ts`) run with `tsx --tsconfig tsconfig.scripts.json --env-file=.env` (see `package.json`); that tsconfig makes the `~~/` and `#shared/` aliases work outside Nuxt. Type-check them with `pnpm exec tsc -p tsconfig.scripts.json`.
- Unit tests use `tests/helpers/fake-db.ts` (in-memory database: `setDbForTests(createFakeDb(tables))`), `tests/helpers/seed-fixture.ts` (demo data as tables) and `tests/helpers/mock-model.ts`. Keep production queries inside the subset the fake supports: one table per query, `.eq .neq .in .is .not(col,'is',null) .lt .lte .gt .gte .order .limit .single .maybeSingle`, `insert / update / upsert / delete` (+ `.select()` to get rows back), and the two `rpc` claims. No embedded joins, no `.or()`.
- pnpm 10 only runs install scripts for packages listed under `pnpm.onlyBuiltDependencies` in `package.json`.
