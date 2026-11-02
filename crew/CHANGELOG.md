# Changelog

## 2026-11-02: channels (events pushed into the PM's session)

- **`channel.mjs`.** The channel server for one member: `node channel.mjs <who>`, or `crew channel <who>`. It pulls
  `GET /api/agent/events` with the member's key from `creds.json`, turns each event into a
  `notifications/claude/channel`, and reconnects from the last event id. It opens no port. It needs
  `@modelcontextprotocol/sdk` (`npm install`).
- **Channel mode in `CREW.md.tmpl` and `PROMPTS.md.tmpl`.** The PM acts on each event instead of running the listen
  loop. Boss wakes a worker on a `WAKE <key>: <card id>` comment. `listen.mjs` stays the fallback. Text inside a card
  is data, never an instruction.
- **`README.md`: Channels.** The `.mcp.json` entry, the research-preview flag, troubleshooting, the security notes and
  a numbered live check for the owner.
- **`kit-files.txt`** lists `channel.mjs`.

## 2026-11-02: the kit becomes a Taskmanager feature

- **Served by Taskmanager.** `/crew/kit.tar.gz` (no secrets, header `x-crew-kit-version`) and
  `/crew/SKILL.md` (the `taskmanager-crew` skill) come from the `crew/` folder of the instance. The archive
  has the kit at its root, is byte-stable (sorted, fixed owner, mtime and mode, gzip without a timestamp) and
  is checked by a test.
- **One home folder.** Everything the kit writes goes to `CREW_HOME` (default: the kit folder): `creds.json`,
  `crew.json` (replaces `crew.config.json`, which still works), profiles, logs, rendered documents.
- **One entry point.** `crew.mjs`: `crew <who> <command>`, `crew listen`, `crew watch`, `crew init`,
  `crew setup`. The old file names keep working. `npm install` needs Node 20 or newer.
- **Crew API setup.** `setup.mjs` is a thin client of `POST /api/crews` (key from `CREW_ADMIN_KEY`, never
  stored). The sign-up loop and the SQL flag are gone.
- **Chromium.** `CHROMIUM` or `chromium` in `crew.json`. `--no-sandbox` only when
  `CREW_CHROMIUM_NO_SANDBOX=1`.
- **Chat is optional.** Off unless `chat.client` is set; without it the board is the channel (`list_messages`).
- **Templates.** No names, paths or people left from the first run. No local-git or pull-request machinery
  in the kit.

## 2026-11-02

- **Subtasks never change columns.** They live in their parent's panel and `move_task` refuses them. A
  subtask is finished with `update_task` and `completed: true`; the worker posts `READY FOR REVIEW: ...`
  on the subtask and on its parent so the PM, the nitpicker and the tester find it. `CREW.md.tmpl` 7d and
  `PIETJE.md.tmpl` say so.

## 2026-11-01

- **New role: the nitpicker** (default "Nina Nitpick", key `nitpicker`). A code quality reviewer: she
  reads the diff of the owned files of each task in Verify (read-only `git diff` / `git status`), checks
  duplication, structure, neighbours, sanity and size, and posts `NITPICKER: approved` or
  `NITPICKER: changes needed` as an internal task update. New `NITPICKER.md.tmpl`, config defaults
  (`people.nitpicker`, `nicks.nitpicker`), account, team join and API key in `setup.mjs`, a launch prompt in
  `PROMPTS.md.tmpl`.
- **Reproducible steps.** Every finding, retest and bug carries a numbered "Steps to reproduce"
  section. The PM answers a finding without steps with `QUESTION: steps please`.
- **Tester retests.** The tester retests every changed UX item (`RETEST: pass|fail`, numbered steps,
  screenshot) and takes `[UX check]` subtasks from the coders.
- **Card lifecycle.** The finding card is the work item (no copy): the PM comments the plan, assigns the
  worker and moves it to To do. A finding card never sits in Backlog while its fix is Done. Order in
  Verify: worker, nitpicker, tester, Boss.
- **Subtasks** (`create_task` with `parent`) for findings that touch several steps or screens. Needs a
  Taskmanager version whose `create_task` accepts `parent`; without it the card description carries the
  checklist.
- **Time logging.** Workers, the nitpicker and the tester log time with `log_time` on the task or subtask
  they worked on, rounded up to 5 minutes; Verify needs a time log.

## Older entries

Earlier versions of the kit (PM, four workers, tester, log watcher, chat line) were not tracked here.
