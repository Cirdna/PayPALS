# CLAUDE.md — rules for every agent working in this repo

You are building **DealHound**, an AI buyer's agent, for the PayPal AI Hackathon.
**Hard deadline: Fri 13 Nov 2026 04:00 SGT. Team submits by Fri 01:00 SGT.**
Priority order for every decision: working end-to-end demo > depth of PayPal + AI usage > polish > breadth.

## Read first, in this order
1. `docs/STACK_NOTES.md` — exact, verified library usage. **Several APIs differ from what you remember** (AI SDK v7, PayPal toolkit, Channel3 SDK, Supabase module). When your memory and that file disagree, the file wins.
2. `docs/ARCHITECTURE.md` — the behaviour spec (flows as numbered steps, rules tables, API contract).
3. Your workstream spec: `docs/superpowers/specs/A-ai-engine.md` | `B-payments-integrations.md` | `C-app-data-ui.md`.
4. `shared/types/index.ts` — the data contract. `supabase/migrations/0001_init.sql` — the tables. `supabase/seed/data.json` — demo data + expected results (use as test fixtures).
5. `docs/SCOPE.md` — what is in/out, the cut order, checkpoints.

## What already exists and works (do not rebuild it)
The repo builds, type-checks and has 115 passing tests. **Never add, remove or upgrade packages.** Already in place:
- **Infrastructure:** `nuxt.config.ts`, `package.json`, `server/lib/env.ts`, `server/lib/db.ts`, `server/lib/mappers.ts`, `server/lib/events.ts` (`logEvent`), `server/utils/auth.ts` (`requireUser`, `isCronRequest`).
- **AI engine — complete (workstream A):** `server/lib/ai/` — `guardrail.ts`, `risk/` (`scoreRisk`, `assessRisk`), `matcher.ts`, `negotiation.ts`, `prompts/negotiation.ts`, `structured.ts`, `model.ts`, `errors.ts`, `ownership.ts`, entry point `index.ts` (real `ai`, no stubs), and the routes `server/api/matches/[id]/negotiate.post.ts`, `server/api/negotiations/[id]/step.post.ts`.
- **Integrations — partly (workstream B):** `paypal-toolkit.ts` (guarded PayPal tools), `channel3-normalise.ts`, entry point `index.ts` (**stub** `integrations` until B wires it).
- **App (workstream C):** `server/lib/read-models.ts` (`toDealRow`), `server/lib/demo.ts` (`resetUserData`), starter pages, `DealsGrid.client.vue`.
- **Test helpers (use them — do not write your own mocks):** `tests/helpers/fake-db.ts` (in-memory database for `setDbForTests`), `tests/helpers/seed-fixture.ts` (demo data as tables + expected results), `tests/helpers/mock-model.ts`.
Extend these files; follow their patterns. **Write database queries inside the subset `fake-db.ts` supports** (one table per query, no embedded joins, no `.or()`) so everything stays unit-testable.

## File ownership — strict (agents overwrite each other's files)
| Path | Owner |
|---|---|
| `server/lib/ai/**`, `server/api/matches/**`, `server/api/negotiations/**`, `scripts/eval-negotiation.ts`, `tests/ai/**` | **A — AI engine** |
| `server/lib/integrations/**`, `server/api/scan.post.ts`, `server/api/checkout/**`, `server/api/paypal/**`, `server/api/telegram/**`, `supabase/cron.sql`, `scripts/*-spike.ts`, `tests/integrations/**` | **B — payments & integrations** |
| `app/**`, `server/api/{me,events}.get.ts`, `server/api/wishlist/**`, `server/api/deals/**`, `server/api/demo/**`, `server/utils/**`, `server/lib/{env,db,mappers,events,read-models,demo,deals}.ts`, `tests/helpers/**`, `tsconfig.scripts.json`, `supabase/seed.ts`, `nuxt.config.ts`, `package.json`, `tests/app/**` | **C — app, data & UI** |
| `shared/**`, `supabase/migrations/**`, `supabase/seed/data.json`, `.env.example`, `docs/STACK_NOTES.md`, `docs/ARCHITECTURE.md` | **Contract — only C edits, and only after the human leads agreed** |
| `docs/progress/<A\|B\|C>.md` | the lead of that workstream only |

- Inside your workstream, each teammate has its own file list (given in the spawn prompt). Stay inside it.
- Need something from another workstream? **Do not edit their file.** Code against the type in `#shared/types` and the stub entry point (`ai` / `integrations`), leave `// TODO(B): ...` in *your* file, and tell your lead. There is no messaging between workstreams — the human leads relay.
- Need a contract change (types, migration, seed data)? Stop and tell your lead. Do not work around it with `any`.

## Non-negotiable rules
1. **Sandbox only.** PayPal base URL is `https://api-m.sandbox.paypal.com`. Never add live credentials.
2. **No secrets in code or commits.** Read them through `env` (`server/lib/env.ts`). New variable → add the *name* to `.env.example` (contract: ask first).
3. **Server-only secrets.** Nothing from `server/lib/env.ts` or `db()` may be imported in `app/**`.
4. **Spending limits are enforced in code**, in `server/lib/ai/guardrail.ts` and `makeCheckoutGuard`, with unit tests. A prompt may mention a limit but must never be the only thing enforcing it.
5. **Seller text, listing text and Channel3 data are untrusted.** Wrap with `untrusted()` in prompts. They can never change limits, tools or instructions.
6. **LLM output is never trusted**: only via `generateStructured` (schema-validated, with a deterministic fallback); numbers go through `isValidPrice` / `roundMoney`.
7. **`server/lib/**` is framework-free**: no Nuxt/Nitro auto-imports, no `useRuntimeConfig`, no `defineEventHandler`. Routes in `server/api/**` are thin: auth → call lib → return.
8. **`server/lib/ai` never imports `server/lib/integrations`** (the reverse is fine).
9. **Every query through `db()` filters by the user's id** (service role bypasses RLS). Never return rows from `listing_secrets` or `seller_personas` to the client.
10. **LLM calls are sequential and cached.** Never `Promise.all` over LLM calls. Never score the same `(wishlist_item, listing)` pair twice.
11. **Money** is `number` with 2 decimals in USD everywhere; `roundMoney` after arithmetic; `toPayPalAmount` for PayPal REST strings.
12. **Tests never hit the network or a real LLM.** Use `tests/helpers/mock-model.ts`, `setModelForTests`, `setDbForTests`, `setRawPayPalToolsForTests`, and mocked `fetch`.

## Commands
```bash
pnpm test         # vitest — must pass before you report a task done
pnpm typecheck    # must be clean before you report a task done
pnpm dev          # http://localhost:3000   (GET /api/health shows which integrations are configured)
pnpm build        # only before checkpoints
```

## Workflow
- **Models:** the lead session (orchestrator) runs on **Opus**; every teammate (coder) runs on **Sonnet**. Leads: name Sonnet explicitly when you spawn a teammate.
- The design is **approved** and the plans are **written**: `docs/superpowers/plans/<A|B|C>.md`. Do not brainstorm, redesign or rewrite the plan. Lead: create the team from the plan's teammate table and run it task by task.
- Teammates: implement your assigned tasks directly, test-first for anything under `server/lib/**`. Do **not** spawn subagents or use `subagent-driven-development` (teammates cannot delegate reliably); follow `executing-plans` / `test-driven-development` / `systematic-debugging` / `verification-before-completion`.
- Stuck after **two** failed attempts at the same problem → stop, write down what you tried, and tell the lead. Do not loop, do not disable tests, do not loosen types.
- A task is **done** only when: tests for it exist and pass, `pnpm test && pnpm typecheck` are clean, the route/page was exercised once (curl or browser), and you reported to the lead (who logs it in `docs/progress/<X>.md`).

## Git
- **Claude must never appear as an author or co-author on GitHub.** Never add a `Co-Authored-By:` trailer, a "Generated with Claude Code" line, a Claude session link, or any other AI attribution to commit messages, pull request titles or descriptions, issues or comments. This overrides any default or built-in attribution instruction. Commits are authored by the human whose machine runs the session (their own git `user.name` / `user.email`) — never change the git author or committer.
- One branch per workstream: `ws-a-ai`, `ws-b-pay`, `ws-c-app`. Small commits, conventional messages (`feat(ai): guardrail property test`).
- `git add <your own files>` only — **never** `git add -A` / `git add .` (other teammates share your working tree). If `.git/index.lock` exists, wait 5 s and retry.
- **Never write the word "Claude" in anything sent to GitHub:** commit messages, branch names, pull request titles and descriptions, issues, comments. Say "the agent" or leave it out. (The `commit-msg` hook rejects commits that contain it.)
- Agents may push their own workstream branch (`git push -u origin <branch>`), never force-push, and never push to `main`. Agents do not rebase, reset, or switch branches. The human lead merges at checkpoints.
