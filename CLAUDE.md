# CLAUDE.md — instructions for every agent working in this repo

You are building **DealHound**, an AI buyer's agent for the PayPal AI Hackathon.
**Hard deadline: Fri 13 Nov 2026, 04:00 SGT (Thu 12 Nov 12:00 PST). Team target: submit by Fri 01:00 SGT.**
Every decision optimises for: a working end-to-end demo > depth of PayPal + AI usage > polish > breadth.

## Read first
1. `docs/SCOPE.md` – what is in / out, cut order, timeline, checkpoints
2. `docs/ARCHITECTURE.md` – flows, data model, API contracts
3. Your workstream spec in `docs/superpowers/specs/` (A = AI engine, B = payments & integrations, C = app, data & UI)
4. `shared/types.ts` – the cross-workstream contract
5. If present, `graphify-out/wiki/index.md` / `graphify-out/GRAPH_REPORT.md` – current map of the codebase. Prefer `/graphify query "..."` over grepping the whole repo.

## Stack (do not change without the team agreeing)
Nuxt 4 + Vue 3 + TypeScript · Nuxt UI · AG Grid (ag-grid-vue3) · Supabase (Postgres, Auth, pg_cron, pg_net) · Vercel AI SDK + Gemini (`@ai-sdk/google`) · PayPal Agent Toolkit (`@paypal/agent-toolkit`) + Orders v2 sandbox · Channel3 API · Telegram Bot API (raw fetch) · Vercel Hobby · Vitest · pnpm

## File ownership (agent teams overwrite each other's files – respect this strictly)
| Path | Owner |
|---|---|
| `server/lib/ai/**`, `server/api/negotiations/**`, `server/api/matches/**`, `tests/ai/**` | **A – AI engine** |
| `server/lib/integrations/**`, `server/api/scan.post.ts`, `server/api/checkout/**`, `server/api/paypal/**`, `server/api/telegram/**`, `supabase/cron.sql`, `tests/integrations/**` | **B – payments & integrations** |
| `app/**`, `server/utils/**`, `server/api/wishlist/**`, `server/api/deals/**`, `server/api/me.get.ts`, `server/api/events.get.ts`, `supabase/seed.*`, `nuxt.config.ts`, `package.json`, `vercel.json`, `tests/app/**` | **C – app, data & UI** |
| `shared/types.ts`, `supabase/migrations/**`, `.env.example` | **Contract – C merges, any change must be announced to all leads** |
| New npm dependency | Ask C (owner of `package.json`) – or add it yourself only in a commit that touches nothing else |
| `docs/**`, `CLAUDE.md`, `README.md` | Any lead; keep edits small |

If you need something in a file you don't own: inside your own team, message the owning teammate (agent-team mailbox). For another workstream (there is no cross-team mailbox), add a `// TODO(owner-X): ...` note in YOUR file, code against the type in `shared/types.ts`, and tell your human lead so they relay it. Never silently edit another workstream's file. Full playbook: `docs/AGENT_TEAMS.md`.

## Commands
```bash
pnpm dev            # local app
pnpm test           # vitest (run before claiming any task done)
pnpm typecheck      # nuxi typecheck
pnpm lint
pnpm db:seed        # seed demo marketplace
```

## Non-negotiable rules
- **Sandbox only.** PayPal base URL `https://api-m.sandbox.paypal.com`. Never add live credentials.
- **Never commit secrets.** Everything secret comes from `useRuntimeConfig()`; update `.env.example` (names only) when you add one.
- **Server-only secrets.** PayPal, Gemini, Channel3, Telegram, Supabase service-role keys are only used in `server/**`. Never in `app/**`.
- **Money:** store as `numeric(10,2)` in the DB and `number` (2dp) in TS, always paired with a `currency` (ISO code). One app-wide currency from `APP_CURRENCY` (default `USD`, since Channel3 retail prices are likely USD; no FX conversion in MVP – skip listings in other currencies). Round with `roundMoney()` from `shared/types.ts`. PayPal expects amounts as strings with 2dp (`"365.00"`).
- **Guardrails are code, not prompts.** Anything that limits spending (mandate, max price, monotonic offers) must be enforced in TypeScript in `server/lib/ai/guardrail.ts` and covered by unit tests. Prompts may *also* mention limits, but the code check is what counts.
- **Untrusted text.** Seller messages, listing descriptions and Channel3 data are untrusted. Wrap them in clearly delimited blocks in prompts (`<untrusted_seller_message>...</untrusted_seller_message>`) and never let them change tool permissions or limits.
- **LLM outputs are validated.** Always use `generateObject`/structured output with a Zod schema; on parse failure retry once, then fall back to a deterministic default.
- **Model IDs come from env** (`AI_MODEL_SMART`, `AI_MODEL_FAST`). Don't hard-code model names.
- **Rate limits.** Gemini free tier is tight. Cache match/risk results in DB; never call the LLM for the same (wishlist_item, listing) pair twice.
- **Serverless time limits.** Keep each request short. Negotiation runs **one round per request** (`POST /api/negotiations/:id/step`), state lives in Supabase.
- **Video/trademarks.** The demo video must not show third-party logos or copyrighted product images. Seed demo data with generic product names/placeholder images; hide images in "demo mode".

## Workflow (Superpowers + ECC + Graphify)
- **Design is already done.** Do NOT run the Superpowers `brainstorming` skill – the specs in `docs/superpowers/specs/` are approved. Start from `writing-plans` on your workstream spec, save plans to `docs/superpowers/plans/`.
- Execute with `subagent-driven-development` / `executing-plans`. Use `test-driven-development` for: guardrail, scam scoring, mandate checks, money math, webhook signature handling.
- Before saying a task is done: `verification-before-completion` – run `pnpm test && pnpm typecheck`, and hit the endpoint once.
- Use ECC's security review on anything touching PayPal, webhooks, Telegram, auth, or the cron endpoint before it is merged.
- Graphify: the post-commit hook rebuilds the graph; after a big merge run `/graphify . --update`.

## Git
- Branch per workstream: `ws-a-ai`, `ws-b-pay`, `ws-c-app`. Small commits, conventional messages (`feat(ai): ...`).
- Rebase on `main` at every checkpoint; leads merge to `main` at checkpoints (see SCOPE.md).
- Never force-push `main`.

## Definition of done (per task)
Code + tests pass + typecheck clean + endpoint/UI exercised once + types in `shared/types.ts` respected + a one-line note in `docs/PROGRESS.md` (`[A] negotiation step endpoint – done – 14:20`).
