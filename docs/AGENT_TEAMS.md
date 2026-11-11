# Agent-team playbook (3 humans × 1 Claude Code agent team each)

## 0. Mental model
- **3 workstreams → 3 humans → 3 agent teams**, one per laptop/branch: A `ws-a-ai`, B `ws-b-pay`, C `ws-c-app`.
- Inside a team, the **lead** session splits work and teammates coordinate through the team's shared task list + mailbox.
- **Across teams there is no mailbox.** Coordination = `shared/types.ts` (contract) + `docs/PROGRESS.md` + your human group chat + checkpoint merges. If your agents need something from another workstream, they write a `TODO(owner-X)` and tell you; you relay it.
- Agent teams are experimental: sessions don't resume well, and two teammates editing one file overwrite each other. Hence the strict file ownership in `CLAUDE.md` and the per-teammate file lists below.
- Cost: each teammate is a full Claude session. Keep teams to **lead + 3 teammates**.

## 1. One-time setup (each human, ~15 min)
```bash
claude --version                      # needs ≥ 2.1.32 for agent teams
git clone <repo> && cd dealhound && git checkout -b ws-<a|b|c>-...
cp .env.example .env                  # fill from the team vault
```
The repo's `.claude/settings.json` already sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Optional split panes: install tmux and add `"teammateMode": "tmux"` to your **user** `~/.claude/settings.json`, then start Claude inside `tmux`.

### Which skills the team uses (and how that's enforced)
| Skill source | How it's shared | Used for |
|---|---|---|
| **Superpowers** plugin | `enabledPlugins` in the committed `.claude/settings.json` | `writing-plans`, `executing-plans`, `subagent-driven-development`, `test-driven-development`, `verification-before-completion`, `systematic-debugging` |
| **ECC** – only selected skills | copied into `.claude/skills/` and committed | security review of payment/webhook code |
| **Graphify** | `graphify install --project` → `.claude/skills/graphify/` committed | codebase map / queries |

The committed `.claude/settings.json` also **pre-approves** `Skill(superpowers:*)` and `Skill(graphify)` (no approval prompts for agents) and **denies** `Skill(superpowers:brainstorming)` so agents can't start the interactive design Q&A (the design is done). Deny rules stop Claude from calling a skill itself; a human can still type the slash command.

**Superpowers** — each person, once, from the repo root:
```bash
claude plugin install superpowers@claude-plugins-official --scope project
```
(If Claude says *"enabled in project settings but isn't installed"*, that's the command to run.)

**ECC — Everything Claude Code: install selectively, not the whole kit.** The full plugin ships ~300 skills plus hooks that overlap Superpowers' workflow; for a 30-hour build that's noise and token cost. One person adds just the skills we want to the repo and commits them:
```bash
npx skills add affaan-m/ECC --skill security-review --agent claude-code   # → .claude/skills/security-review/
```
Browse the repo's `skills/` folder for any other single skill worth adding (e.g. a TypeScript or Vue reviewer), same command. Optional TS rules (personal, not committed):
```bash
git clone https://github.com/affaan-m/ECC.git /tmp/ecc
mkdir -p ~/.claude/rules/ecc && cp -R /tmp/ecc/rules/common /tmp/ecc/rules/typescript ~/.claude/rules/ecc/
```
Want the full ECC plugin anyway? `/plugin marketplace add affaan-m/everything-claude-code` then `/plugin install ecc@ecc` — but do it in your *user* scope and disable it if hooks get noisy. A personal opt-out of any team plugin goes in `.claude/settings.local.json` (not committed).

**Check what's loaded:** run `/skills` in Claude Code. **Force a specific skill:** type it as a slash command (e.g. `/superpowers:writing-plans`) or name it in the prompt ("use the security-review skill on server/api/checkout/").

**Graphify** (codebase knowledge graph shared by all agents):
```bash
pipx install graphifyy          # or: pip install graphifyy
graphify install --project      # installs the /graphify skill into this repo's .claude/skills
graphify hook install           # rebuilds the graph on every commit
```
After C's H0 scaffold lands, one person runs `/graphify . --wiki` and commits `graphify-out/` (wiki + GRAPH_REPORT.md). Agents read `graphify-out/wiki/index.md` instead of crawling the repo. Re-run `/graphify . --update` after each checkpoint merge. (Value grows with repo size — early on it's mostly a map; don't block on it.)

## 2. Starting your team — paste into Claude Code (lead session)

### Workstream A — AI engine
```
Read CLAUDE.md, docs/SCOPE.md, docs/ARCHITECTURE.md and docs/superpowers/specs/A-ai-engine.md.
The design is approved: skip brainstorming. Use the Superpowers writing-plans skill to write
docs/superpowers/plans/A-ai-engine.md, then create an agent team to execute it:
- teammate "guard": server/lib/ai/guardrail.ts + tests/ai/guardrail*.test.ts (TDD, property test first)
- teammate "risk": server/lib/ai/risk/** + tests/ai/risk*.test.ts (TDD with seed fixtures)
- teammate "nego": server/lib/ai/model.ts, structured.ts, prompts/**, matcher.ts, negotiation.ts,
  server/api/matches/**, server/api/negotiations/** (starts after guard's API is committed; mock it until then)
Only touch files listed for each teammate. Code against shared/types.ts; stub C/B dependencies behind the
names in the spec. Every task ends with pnpm test && pnpm typecheck and a line in docs/PROGRESS.md.
Checkpoint 1 is Thu 09:00 SGT — prioritise guardrail, risk, matcher in that order.
```

### Workstream B — Payments & integrations
```
Read CLAUDE.md, docs/SCOPE.md, docs/ARCHITECTURE.md and docs/superpowers/specs/B-payments-integrations.md.
The design is approved: skip brainstorming. FIRST, yourself (no team yet): run the PayPal and Channel3 spikes
in the spec and record the toolkit-vs-REST decision in docs/PROGRESS.md. Then use writing-plans to write
docs/superpowers/plans/B-payments-integrations.md and create an agent team:
- teammate "paypal": server/lib/integrations/paypal-*.ts, checkout.ts, server/api/checkout/**,
  server/api/paypal/**, tests/integrations/paypal*.test.ts
- teammate "comms": server/lib/integrations/telegram.ts, server/api/telegram/**, tests/integrations/telegram*.test.ts
- teammate "scan": server/lib/integrations/channel3.ts, scan.ts, server/api/scan.post.ts, supabase/cron.sql,
  tests/integrations/{channel3,scan}*.test.ts
Only touch files listed for each teammate. Stub the AI engine (server/lib/ai) until A merges.
Before Checkpoint 2, run the ECC security review on checkout, webhook, telegram and scan routes.
```

### Workstream C — App, data & UI
```
Read CLAUDE.md, docs/SCOPE.md, docs/ARCHITECTURE.md and docs/superpowers/specs/C-app-data-ui.md.
The design is approved: skip brainstorming. FIRST, yourself (no team yet): do the H0 scaffold in the spec
(Nuxt 4, modules, deps, runtimeConfig, server/utils, migration applied, Vercel hello-world). Commit and push
to main immediately — the other two workstreams are blocked on it. Then use writing-plans to write
docs/superpowers/plans/C-app-data-ui.md and create an agent team:
- teammate "data": supabase/seed.ts + seed JSON, server/utils/**, server/api/{me,events}.get.ts,
  server/api/wishlist/**, server/api/deals/**, tests/app/api*.test.ts
- teammate "grid": app/pages/deals/index.vue, AG Grid setup, ActivityFeed.vue, useDeals.ts, useRealtime.ts
- teammate "pages": app/pages/{index,login,wishlist,settings}.vue, app/pages/deals/[matchId].vue,
  remaining components (RiskBadge, RiskEvidence, NegotiationTranscript, MandateCard, PriceDelta)
Only touch files listed for each teammate. The demo video is judged on Design — polish matters.
```

## 3. Rhythm
| Time (SGT) | What humans do |
|---|---|
| Every ~2h | Skim your team's task list; unblock; push branch; post a 3-line status in group chat |
| Checkpoints Thu 09:00 / 15:00 / 21:00 | 20-min call. Each lead rebases on `main`, runs `pnpm test && pnpm typecheck`, merges (order: C → A → B). Fix integration breaks together. `/graphify . --update`. |
| Contract change | Post in chat **before** editing `shared/types.ts` or migrations; C merges it; others rebase |
| Overnight | Only leave agents running on test-covered tasks with clear acceptance; never on deploy/payment config |

## 4. When things go wrong
- Teammate stuck/looping → stop it, write the failing case into the plan, restart that teammate only.
- Session lost → start a fresh lead, point it at the plan file + `docs/PROGRESS.md` (that's why we log progress).
- Two teams need the same new type → C adds it to `shared/types.ts` in a tiny PR within 15 min.
- Gemini 429s → switch to your own key/project, lower concurrency, rely on cached matches.
