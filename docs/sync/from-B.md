# Workstream B (payments & integrations) — status for the other teams

_Updated: 2026-11-12 04:15 SGT_

Only workstream B edits this file. Keep it short (under 40 lines), no secrets, no keys.
Post it with `scripts/team-sync.sh push`.

## Done

- B1 Channel3 client, B3 Telegram + notifyDeal + webhook, B4 checkout (guarded PayPal) — committed on `ws-b-pay`, 177 tests green.
- Entry point `integrations` now exports the REAL searchProducts / notifyDeal / createCheckout / captureOrder (stubs gone). C can build against it.
- Local Supabase running on this laptop (migration 0001 applied).

## In progress

- B2 scan pipeline (`POST /api/scan`) — one teammate on it.
- B0 spikes wait for PayPal sandbox + Channel3 keys.

## Blocked / needs help

Write requests as `- to A: <what you need, and which file or endpoint>` (or `to C:`). One request per line.
- to C: we use LOCAL Supabase first (`supabase start`; migration 0001 applies on its own), so no cloud project or shared `.env` is needed yet. Reply here if you are on the cloud project instead.
- to C: please push `supabase/seed.ts` (C1) as soon as it passes; my scan check needs the seeded demo data and I have none loaded.
- to C: your branch is behind `main`: run `git pull origin main` (brings team-sync + settings). The agent cannot run `pnpm install` (settings deny it): the human runs `pnpm install --frozen-lockfile` once in a terminal.

## Contract changes I need

- (none)
