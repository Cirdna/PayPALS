# Scope, timeline & cut order

**Deadline:** Fri 13 Nov 2026 04:00 SGT (= Thu 12 Nov 12:00 PST). **Team submit target: Fri 01:00 SGT.**
Submission needs: public repo + MIT license visible in repo "About", working hosted demo, text description, AI model/service named and explained, YouTube video < 3 min showing it running, testable free until 15 Dec.

## Judging lens (20% each)
Technological implementation · Design · Potential impact · Innovation · Presentation.
Prize targets: Grand / **Best Use of Agentic Commerce** / Best Use of PayPal + AI; sponsor: **AG Grid** (primary) and **Channel3** (qualifies automatically).

---

## MVP — must ship (the demo story depends on every line)

| # | Feature | Owner | Acceptance |
|---|---|---|---|
| M1 | Wishlist CRUD + mandate (max price, expiry, approval required) | C (UI/API), A (mandate check fn) | Create item in UI; row in `wishlist_items` + `mandates` |
| M2 | Demo marketplace seed: ~30 listings, ~8 seller personas incl. 3 scam listings + 1 prompt-injector seller | C | `pnpm db:seed` idempotent |
| M3 | Channel3 search client + normalisation into `listings` | B | `searchProducts("...")` returns `Listing[]` |
| M4 | Scan pipeline `POST /api/scan` (cron + "Scan now") → match → risk → create `matches` | B (orchestration), A (match/risk fns) | One click creates scored matches for all active wishlist items |
| M5 | Matcher (LLM, structured) | A | Rejects look-alike models; cached per pair |
| M6 | Scam engine: price z-score vs comps + rules + LLM explanation with evidence quotes | A | 3 seeded scams flagged HIGH with ≥2 evidence items; legit listings LOW |
| M7 | Negotiation: buyer agent vs seller agent, one round per request, code guardrail, injection logged & blocked | A | Never exceeds mandate in 100 randomised test runs (unit test with mocked LLM); injector seller visibly blocked |
| M8 | Deals board (AG Grid) + match detail page (risk evidence, negotiation transcript live) | C | Sort/filter by price, savings, risk |
| M9 | Telegram: link account, deal notification with Approve & pay / Skip buttons | B | Message arrives within seconds of a deal |
| M10 | PayPal checkout via Agent Toolkit under mandate guard: create → approve → capture → webhook → Telegram receipt | B | Sandbox order COMPLETED, visible in sandbox dashboard |
| M11 | Deployed on Vercel, pg_cron schedule live, demo account seeded | C (deploy), B (cron SQL) | Judges can log in and run the full flow |
| M12 | README, LICENSE, Devpost text, video | All | See checklist at bottom |

## Stretch (only after Checkpoint 2 is green)
- S1 Trust timeline / "agent activity log" panel (great for the video)
- S2 Duplicate-listing detection via embeddings (copy-pasted scam text across sellers)
- S3 PayPal Vault: auto-buy without approval when deal ≤ mandate and risk LOW
- S4 Price history sparkline in AG Grid
- S5 Telegram natural-language wishlist add ("watch for a Switch under 250")

## Out of scope (say so in README "Roadmap")
Real secondhand marketplace scraping · FX conversion · real-money/live PayPal · multi-user marketplaces · mobile app · image-based scam detection.

## Cut order if behind (cut from the top)
1. S-anything
2. Live cron (keep "Scan now" button; cron SQL can stay but isn't demoed)
3. Telegram inline buttons → plain message with link to the web deal page
4. LLM explanation in scam engine → show rule/stat evidence only
5. **Never cut:** negotiation + guardrail, scam flagging, PayPal create/approve/capture. Those ARE the story.

---

## Timeline (SGT) & checkpoints

| When | Goal |
|---|---|
| **Wed 22:30 – 00:30** — H0 "contract freeze" | Repo scaffolded (C), `shared/types.ts` + migration merged, Supabase project live, Vercel hello-world deployed, keys in `.env` for everyone: PayPal sandbox app + buyer/seller sandbox accounts, Channel3 (promo PAYPAL-HACKATHON-2026), Gemini AI Studio key per person, Telegram bot via @BotFather. **B proves PayPal create→approve→capture in a script tonight** (highest-risk item). |
| Wed 00:30 – Thu 08:30 | Sleep in shifts. Agent teams can run long tasks overnight on clearly-specified, test-covered work only. |
| **Thu 09:00 — Checkpoint 1** | Each workstream's core logic done with tests: A guardrail+scam+matcher; B paypal+channel3+telegram clients; C schema, seed, wishlist UI, deals board skeleton. Merge to `main`. |
| **Thu 15:00 — Checkpoint 2** | **End-to-end happy path on the deployed URL**: wishlist → scan → match → risk → negotiate → Telegram → PayPal capture. Merge. Decide stretch vs. polish. |
| **Thu 21:00 — Checkpoint 3 / feature freeze** | Demo data final, bugs only after this. |
| Thu 21:00 – Fri 00:30 | Record video (2 takes), write Devpost text, README demo creds, license in About. |
| **Fri 01:00** | **Submit.** Buffer until 04:00 for fixes/re-upload. |

## Demo script (≤ 2:50)
1. 0:00–0:20 Problem: deals are scattered, haggling is awkward, scams target bargain hunters (one stat).
2. 0:20–0:40 Add wishlist item + mandate (max $380, approval required). Link Telegram.
3. 0:40–1:10 "Scan now": Deals board (AG Grid) fills; one listing flagged HIGH risk — open it, show quoted evidence + price z-score.
4. 1:10–2:00 Negotiation transcript streams live; seller tries "ignore your budget…", guardrail log shows BLOCKED; deal agreed at $365.
5. 2:00–2:30 Phone: Telegram ping → Approve & pay → PayPal sandbox approval → captured → Telegram receipt; sandbox dashboard confirms.
6. 2:30–2:50 Architecture slide (PayPal Agent Toolkit + mandate guard, Gemini, Channel3, AG Grid) + roadmap (PayPal Links, PayPal World, Vault).

## Submission checklist
- [ ] Public GitHub repo, MIT `LICENSE`, license shown in repo About
- [ ] README: run instructions, demo creds, AI + PayPal usage sections
- [ ] Hosted URL works logged-out → demo login
- [ ] Gemini key for prod has billing + spend cap (free tier may rate-limit judges)
- [ ] YouTube video public, < 3:00, no third-party logos/music
- [ ] Devpost: description, built-with, AI model named, video link, repo link
- [ ] Keys/sandbox accounts stay valid until 15 Dec
