---
name: taskmanager-crew
description: Run a crew of cheap Haiku agents (a project manager, four workers, a usability tester, a code quality reviewer, each with its own browser profile) that build and test ANY product on a Taskmanager board, with Claude as the customer and code reviewer, an optional log watcher, and a chat line for meetings. Use when asked to "set up the crew", "have the haiku workers build X", "start a UX review", or to continue a crew run.
---

# Taskmanager crew

Haiku does the cheap work; Claude (you, "Boss") spends its budget only where judgement is needed: the
customer's request, answers to the PM, the code review, and the publish. The kit is project
agnostic: everything that belongs to one product lives in `crew.json` and
`PROJECT-RULES.md`. The kit is served by Taskmanager (`/crew/kit.tar.gz`, `/crew/SKILL.md`). Board tool details are in the `taskmanager` skill (`/api/settings/skill`); do not repeat them here. Run the kit with `crew <who> <command>`, `crew listen`, `crew watch`.

If the crew home (`$CREW_HOME`, or the kit folder when it is unset) is not set up yet, follow its `README.md` from step 1 and take the user through it.
Each crew has a home folder of its own, such as `~/crew-home/<crew slug>`. When your session was not
started with `CREW_HOME` set, prefix kit commands with it, as the commands in `PROMPTS.md` do.
If it is, run `crew watch` to see where the run stands.

## Cast

| key | who | job |
| --- | --- | --- |
| `boss` | the owner's login (you act through it, the crew never does) | applies schema changes, reviews code, publishes, reads reports |
| `customer` | the customer (you, in a second role) | asks for things, answers the PM, only sees customer-visible tasks |
| `pm` | the project manager (Haiku) | the customer's contact: plans tasks, assigns, pre-checks Verify, triages UX findings |
| `w1` `w2` `w3` `w4` | the workers (Haiku) | build, test in their own browser profile, report |
| `pietje` | the usability tester (Haiku) | tries every feature, files `[UX]` findings for the PM |
| `nitpicker` | the code quality reviewer (Haiku) | reads the diff of each task in Verify before you, posts `NITPICKER: approved` / `changes needed`, logs her time |
| `contact` | a read-only customer contact | lets anyone check what a customer sees |
| log watcher (Haiku) | no login | reads the dev log, crew transcripts and new bugs; flags problems to you |

## The board and who moves what

Columns: Backlog, To do, In progress, **Verify**, **Ready for live**, **Done**, Bugs.

1. The PM puts ready tasks in To do, the rest in Backlog. A worker moves a task to In progress,
   builds it, tests it in the browser, attaches a screenshot, posts an update and moves it to **Verify**.
2. The PM pre-checks Verify (diff, lint, screenshot, time log) and sends clearly wrong work back to
   To do. Then the nitpicker reviews the diff (`NITPICKER:` verdict), and the tester retests anything
   a person sees (`RETEST: pass|fail`). Only then do you look: worker -> nitpicker -> tester -> you.
3. **You review the code in Verify**: read the diff of the owned files (do not trust the summary),
   run lint and the typecheck, look at the screenshot, **try it yourself** in a browser. Approved:
   move to **Ready for live**. Not approved: post written feedback on the task and move it to
   **To do**. Be critical: send work back when it is not up to standard.
4. **Only you publish**, and only tasks in Ready for live, following the release steps in
   `PROJECT-RULES.md` (backup, schema change, typecheck and lint, commit, push). Then move the
   tasks to **Done**.
5. Workers and the PM never commit, push, or touch the database.
6. Bugs: anyone files a `[BUG]` task in the Bugs column; the PM assigns it, a worker fixes it and
   moves it through Verify like anything else.
7. UX review: the tester files `[UX]` tasks to the PM; unclear ones become a chat meeting with you.

## Running it

- **Launch** the agents with the prompts in `$CREW_HOME/PROMPTS.md` (`Agent`, `subagent_type` from
  the table at its top, `model: haiku`, `run_in_background: true`). Order: PM first (plans), workers,
  then the code reviewer, then the tester when there is a dev copy to browse. Each member is its own
  agent type (`init.mjs` writes them), so you can tell them apart when you resume or stop one. On
  "Agent type not found", restart Claude Code (`claude --continue`): never launch a member without
  its `subagent_type`.
- **Wake on hand-backs.** A background agent ends its turn after some minutes even when told to
  loop. Each hand-back wakes you: read the board (`crew watch`), then resume the agent
  (`SendMessage`) or move on. Do not read transcripts.
- **Chat line.** Start the chat server, join the customer channel as the customer nick, keep a
  presence tail running and arm `guard.sh` as a tracked background task; its exit is the wake for
  an `@<customer nick>` mention. Re-arm it every time. The chat line is optional (off unless `chat.client` is set): without it, meetings and steering go through the board. See `README.md`.
  Ring, then talk: wake the PM with a short session message, and the PM picks up in the channel.
- **Schema changes:** a worker posts `SCHEMA CHANGED:`; you back up, apply it (additive only),
  and tell the PM it is applied.
- **The customer's decisions are the user's.** Product questions go to the customer (chat or a
  customer-visible task update), never to Boss; an internal note is invisible to the customer.

## Rules for you

- Read the diff, not the summary. Run the checks yourself. Try the feature in a browser at desktop
  and at phone width (390x740).
- Never put the board's credentials, API keys, passwords or `creds.json` in a commit, a gist or a chat.
- Do not mark a task Done before the push.
- When the user has said who does what ("the crew builds, you review"), do not do the crew's work
  yourself; if you fix something small, say so and still have it reviewed.

## Pitfalls seen

- The dev server hot-reloads whenever anyone saves, and answers 503 for seconds; a blank page is
  not a bug until it repeats a minute later.
- A fresh worker's first `listen.mjs` run reads the whole channel history, and an old "standing
  down" line makes it stop at once. The launch prompts say history is old; if one stops anyway,
  post a correction in the work channel and resume it.
- A stale script re-run by an agent creates duplicate tasks. Check the board before re-running
  anything.
- A review that only reads the PM's summary misses things: read the diff.
- Two modules exporting the same name make some bundlers warn on every rebuild; the log watcher finds these.
