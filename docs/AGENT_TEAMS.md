# Agent-team playbook (3 humans × 1 Claude Code agent team each)

## 0. How this is organised
- **3 workstreams → 3 humans → 3 agent teams**, each on its own laptop and branch: A `ws-a-ai`, B `ws-b-pay`, C `ws-c-app`.
- **Models: the lead (orchestrator) runs on Opus; every teammate (coder) runs on Sonnet.** The lead plans, assigns tasks and reviews; the teammates implement. Teammates share a task list and can message each other.
- **There is no messaging between the three teams.** Coordination across workstreams = the contract files (`shared/types`, the migration, `seed/data.json`), the stub entry points (`ai`, `integrations`), `docs/progress/*.md`, your group chat, and the three checkpoint merges.
- Facts about agent teams that shape the rules below (from the Claude Code docs):
  - teammates load `CLAUDE.md`, skills and project settings themselves, but **not the lead's conversation** — everything they need must be in the spawn prompt or the repo;
  - two teammates editing the same file overwrite each other → every teammate gets its own file list;
  - a teammate's permission prompts appear in the **lead's** terminal → common commands are pre-approved in `.claude/settings.json`, anything else waits for you;
  - in-process teammates are **not restored** by `/resume` → the plan file and `docs/progress/<X>.md` are how a fresh lead picks up;
  - teammates cannot spawn their own teammates; the lead sometimes starts coding itself instead of delegating — tell it to wait.

## 1. One-time setup (each human, ~10 min)
```bash
claude --version          # agent teams need v2.1.32 or later — update if older
git clone <repo> && cd <repo> && git checkout -b ws-<a-ai|b-pay|c-app>
pnpm install && pnpm test # must be green before you start
cp .env.example .env      # fill from the team vault
claude plugin install superpowers@claude-plugins-official --scope project
git config core.hooksPath .githooks   # strips any Claude co-author / "Generated with" lines from commits
```
**No AI attribution on GitHub:** Claude must never show up as a co-author. This is enforced three ways: the rule in `CLAUDE.md`,
`"attribution": { "commit": "", "pr": "" }` in `.claude/settings.json`, and the `.githooks/commit-msg` hook above (needed
because the setting has not always been honoured). Run the `git config` line once per clone — git does not enable hooks
automatically. Before each push, `git log --format=%B origin/main..HEAD | grep -i "co-authored-by\|claude"` should print nothing.
What the committed `.claude/settings.json` already does: turns agent teams on, enables Superpowers, sets edit mode to
auto-accept, pre-approves `pnpm test / typecheck / build / dev`, the seed/eval/spike scripts and `git add <files>` /
all `git` and `gh` commands, and **blocks** `git add -A` / `git add .` (stage named files only), installing packages,
reading `.env`, and the interactive Superpowers brainstorming skill. The only GitHub rules: no "Claude" in anything sent to GitHub, and never Claude as a co-author.

Optional:
- **Split panes:** run Claude inside tmux and start it with `claude --teammate-mode tmux`.
- **Security review:** Claude Code's built-in `/security-review` is enough. If you want ECC's version, add only that one skill (`npx skills add affaan-m/ECC --skill security-review --agent claude-code`) — do not install the whole ECC plugin for this sprint (hundreds of skills and hooks that overlap Superpowers).
- **Graphify:** `pipx install graphifyy && graphify install --project`, then `/graphify . --wiki` on your own machine after Checkpoint 1 when the codebase is big enough to be worth mapping. `graphify-out/` is git-ignored on purpose (committing it from three branches guarantees merge conflicts), and do not install the post-commit hook.

## 2. Start your team — paste into the lead session
**Set the lead to Opus first** — the committed `.claude/settings.json` already makes Opus the default for this repo; confirm with `/model` (switch with `/model opus` if it shows anything else). Then paste the block for your workstream. Each block tells the lead to spawn its teammates on Sonnet; after the team is created, check the teammate list shows Sonnet and, if not, tell the lead: "Shut down the teammates and re-create them on Sonnet."
The plans already exist in `docs/superpowers/plans/` — the leads execute them, they do not write new ones.
Because workstream A's library is finished, the human lead of A should spend spare time helping B (the scan pipeline is the largest remaining piece).

### Workstream A — AI engine
The AI library is already implemented and tested, so this team is small: the lead plus one teammate.
```
You are the lead (orchestrator) of workstream A, running on Opus. Every teammate you spawn must run on Sonnet —
state the model explicitly when you spawn it. Read CLAUDE.md, docs/STACK_NOTES.md, docs/ARCHITECTURE.md (§5–§7) and the plan
docs/superpowers/plans/A.md. The design is approved and the plan is written — do not redesign, brainstorm or
rewrite the plan. The library under server/lib/ai is already implemented and tested; your work is review, an eval
script and prompt tuning against the real model.

1. Do task A1 yourself (review, no code).
2. Create an agent team with ONE teammate on Sonnet named "eval", scoped to scripts/eval-negotiation.ts only, for
   task A3. Put in its spawn prompt: the full text of task A3 from the plan, the instruction to read CLAUDE.md and
   docs/STACK_NOTES.md first, to touch no other file, to never spawn subagents, and to report the script's full
   output to you.
3. When the human confirms the database is seeded and keys are set, guide them through task A2, then run task A4
   (prompt tuning) together with "eval": one change at a time, eval after each, keep or revert.
4. You alone edit server/lib/ai/prompts/**, server/lib/ai/matcher.ts (prompt only), server/lib/ai/index.ts and
   docs/progress/A.md. Never weaken a rule in guardrail.ts to make a negotiation succeed.
Checkpoint 1 is Thu 09:00 SGT: A1–A3 done and a first eval table recorded.
```

### Workstream B — Payments & integrations
```
You are the lead (orchestrator) of workstream B, running on Opus. Every teammate you spawn must run on Sonnet —
state the model explicitly when you spawn it. Read CLAUDE.md, docs/STACK_NOTES.md, docs/ARCHITECTURE.md (§2–§4, §8–§10) and the
plan docs/superpowers/plans/B.md. The design is approved and the plan is written — do not redesign, brainstorm or
rewrite the plan. Task B0 (spikes) is done by the human; its results are in docs/progress/B.md — read them.

1. Create an agent team with three teammates, each on Sonnet, named and scoped exactly as in the plan's teammate
   table: "scan" (tasks B1, B2), "comms" (task B3), "paypal" (task B4).
   Put in each spawn prompt: its file list, the FULL TEXT of its tasks copied from the plan including "Ground rules
   for every task", the instruction to read CLAUDE.md and docs/STACK_NOTES.md first, to work test-first, to use the
   existing test helpers (tests/helpers/fake-db.ts, seed-fixture.ts, mock-model.ts) instead of writing mocks, to
   touch no other files, to never spawn subagents, and to report to you after each task with the test output.
2. You alone edit server/lib/integrations/index.ts (task B5) and docs/progress/B.md.
3. Do not implement tasks yourself. Wait for teammates; review each finished task: run pnpm test && pnpm typecheck,
   read the diff against the plan and docs/ARCHITECTURE.md, send it back if it deviates.
The AI engine (import { ai } from '~~/server/lib/ai') is real and complete — build against it.
Checkpoint 1 is Thu 09:00 SGT: B1–B3 done, scan verified locally against the seeded database.
```

### Workstream C — App, data & UI
```
You are the lead (orchestrator) of workstream C, running on Opus. Every teammate you spawn must run on Sonnet —
state the model explicitly when you spawn it. Read CLAUDE.md, docs/STACK_NOTES.md, docs/ARCHITECTURE.md (§2, §3, §11, §12) and
the plan docs/superpowers/plans/C.md. The design is approved and the plan is written — do not redesign, brainstorm
or rewrite the plan. Task C0 (Supabase + Vercel) is done by the human.

1. Create an agent team with three teammates, each on Sonnet, named and scoped exactly as in the plan's teammate
   table: "data" (C1 then C2), "grid" (C3), "pages" (C5 then C4).
   Put in each spawn prompt: its file list, the FULL TEXT of its tasks copied from the plan including "Ground rules
   for every task", the instruction to read CLAUDE.md and docs/STACK_NOTES.md first, to touch no other files, to
   never spawn subagents, to run pnpm typecheck after every component, and to report to you after each task.
   "grid" must commit task C3 step 1 (labels, RiskBadge, StatusChip) before "pages" starts C4.
   Until GET /api/deals exists, "grid" develops against a local array of DealRow fixtures.
2. You alone edit contract files (shared/**, migrations, seed/data.json, .env.example, docs/ARCHITECTURE.md,
   docs/STACK_NOTES.md) and docs/progress/C.md — contract files only when the human says the three leads agreed.
3. Do not implement tasks yourself. Wait for teammates; review each finished task and send it back if it deviates.
Design quality is 20 % of the judging: the Deals board and the deal page must look finished.
Checkpoint 1 is Thu 09:00 SGT: C1 and C2 done, the board shows rows.
```

## 3. Rhythm for the humans
| When | What you do |
|---|---|
| Every 1–2 h | Open the lead: answer permission prompts, skim the task list (Ctrl+T), read `docs/progress/<X>.md`, `git push` your branch, post 3 lines in the group chat |
| A teammate failed twice on the same thing | Take that one problem to the Opus lead or fix it by hand; restart only that Sonnet teammate with a sharper prompt |
| Checkpoints Thu 09:00 / 15:00 / 21:00 | 20-minute call. Merge order **C → A → B** into `main`; after each merge run `pnpm install && pnpm test && pnpm typecheck && pnpm build`; fix breaks together; redeploy; run the demo path |
| Contract change needed | Agree in chat first → C commits it straight to `main` → A and B merge `main` into their branch immediately |
| Overnight | Leave agents only on `server/lib` tasks that have tests and clear acceptance. Nothing that needs a browser, an account or a decision. Expect to find them idle on a permission prompt — that is fine |
| Session died | New lead session: "Read CLAUDE.md, docs/superpowers/plans/<X>.md and docs/progress/<X>.md, then continue from the first unfinished task and re-create the team." |

## 4. What the Opus lead does itself, and what goes to Sonnet
**Opus (lead):** orchestration, review of every finished task, hard debugging · the guardrail rules and property test · negotiation and risk prompt
tuning with `pnpm eval:negotiation` · the PayPal spike and any payment bug · integration review at each checkpoint ·
the security review · README and Devpost text.
**Sonnet (teammates):** all implementation from the plans — routes, the scan pipeline, checkout, Telegram, the seed
script, pages and components, the eval script. Teammates do not review their own work; the Opus lead does.

## 5. Troubleshooting
- **Claude spawned subagents instead of a team** → say "create an agent team" explicitly.
- **Lead is coding instead of delegating** → "Wait for your teammates to complete their tasks."
- **Task stuck as in-progress** → check whether the work is done; tell the lead to update the task or nudge the teammate.
- **Two teammates touched the same file** → stop both, `git diff`, keep one version, restate the file lists.
- **Gemini 429 errors** → use your own AI Studio key/project; calls are sequential by design; wait a minute.
- **`pnpm typecheck` fails after a merge** → almost always a contract drift: compare with `shared/types/index.ts`, never patch with `any`.
