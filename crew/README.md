# The crew kit

A crew is a team of cheap agents (a project manager, four workers, a usability tester and a
code reviewer, all Haiku except the instance admin's Claude) that builds and tests a product on
a Taskmanager board. This folder is the kit: the scripts and the templates the agents read.

Taskmanager serves the kit itself, so it always matches the instance it talks to:

    mkdir -p ~/crew-kit && cd ~/crew-kit   # the archive has no folder of its own
    curl -fsSL https://<your-taskmanager>/crew/kit.tar.gz | tar -xz
    npm install                       # needs Node 20 or newer

## A provisioned crew (the way to run it)

The commands in this section run from the kit folder (this one, where this README is). The instance admin makes the crew through the crew API, with a `crews:manage` key. The
response is the crew's `creds.json`; nothing else is set up by hand.

1. Write `crew.json` in the crew's home folder (see `crew.config.example.json`): the product, the
   board URL, the people's names, the crew slug (`"crew": { "slug": "..." }`, lowercase letters, digits and dashes, the one `setup.mjs` needs) and, optionally, the chat line.
2. Put `creds.json` (the response, mode 600) in the same folder.
3. Run `node init.mjs`. It checks the machine (Node, a browser) and renders the agents' documents
   (`CREW.md`, `PROMPTS.md`, ...) from the `*.tmpl` files.
4. Run the tools as one of the people: `./crew.mjs boss tools`, `./crew.mjs w1 mcp my_tasks '{}'`,
   `./crew.mjs w1 shot /projects/<boardId> out.png`.

The home folder is `CREW_HOME` (default: this folder). Everything the kit writes goes there
(`creds.json`, `crew.json`, `profiles/`, `.listen/`, logs, the rendered documents), so this folder
can be replaced by a new kit on update without losing anything.

Environment:

- `CREW_HOME`: the home folder, if it is not this one.
- `CHROMIUM`: a Chromium or Chrome binary to use (or `"chromium"` in `crew.json`). Else Playwright's own.
- `CREW_CHROMIUM_NO_SANDBOX=1`: add `--no-sandbox` to the browser. Only for hosts where Chromium's
  own sandbox cannot start (for example inside a systemd sandbox). The host decides.
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`: skip the optional browser download in `npm install`
  (it is also fine to skip it when `CHROMIUM` is set).

## Making the crew by hand

`setup.mjs` is a thin client of the same crew API, for a person who runs the kit without the
Taskmanager instance's own automation (run from the kit folder):

    CREW_ADMIN_KEY=<key> node setup.mjs              # needs "crew": { "slug": "..." } in crew.json
    CREW_ADMIN_KEY=<key> node setup.mjs --rotate    # the crew exists, creds.json is lost

The key is read from the environment and is never written to a file. Keys and passwords are shown
once, in the response that is written to `creds.json`.

## The chat line (optional)

The agents can talk to the customer in an IRC channel. It is off by default. Without it,
meetings and steering go through the board: the agents read their notifications and `list_messages`
on the board, and the PM posts there. To use chat, set `chat.client` in `crew.json` to a chat client
binary and the channels; `init.mjs` checks it.

## Channels (events pushed into a Claude Code session)

A channel is an MCP server that Claude Code starts for a session. `channel.mjs` is the crew's channel: it
connects to Taskmanager's event stream (`GET /api/agent/events`) with one crew member's own key, and each event
becomes a `<channel source="taskmanager-crew" ...>` tag in that session. The PM then reacts to a new card, to a
reply, or to a card that moved, without a listen loop. The rules for what she does are in `CREW.md` ("Channel
mode"). `crew listen` still works and is the fallback.

The channel only pulls. It makes outbound requests and opens no port. `base` in `creds.json` must be `https://`;
plain `http://` is accepted only for `localhost`, `127.0.0.1` or `[::1]`. It runs one member per session.

**Setup (once per machine):**

1. `cd` into the kit folder and run `npm install` (it installs `@modelcontextprotocol/sdk`, Node 20 or newer).
2. The member must be provisioned: `creds.json` in `CREW_HOME` has `base` and `people.<key>.apiKey`. The channel
   also reads `crew.json` in `CREW_HOME` (a sample is in `crew.config.example.json`).
3. In the folder where you start `claude`, add `.mcp.json` (one member per folder; `<who>` is the key, `pm`, `w1`, `boss`...):

   ```json
   {
     "mcpServers": {
       "taskmanager-crew": {
         "command": "node",
         "args": ["<full path of the kit folder>/channel.mjs", "<who>"],
         "env": { "CREW_HOME": "<full path of the crew home folder>" }
       }
     }
   }
   ```

   `crew channel <who>` (`crew.mjs channel <who>`) runs the same server, if you prefer the wrapper as `command`.
   `<who>` is lowercase letters and digits only. No secret goes on the command line or into `.mcp.json`: the key stays
   in `creds.json`.

**Start the session with the channel:**

    claude --dangerously-load-development-channels server:taskmanager-crew

Research-preview facts. The source is the Claude Code channels reference,
https://code.claude.com/docs/en/channels-reference.md.

- A custom channel like this one is not on Anthropic's approved list during the research preview, so it needs the
  `--dangerously-load-development-channels` flag. The flag names the server as `server:<name>`, here `taskmanager-crew`.
- The flag works only in an interactive session. It does not work with `claude -p`.
- Team and Enterprise organizations must allow channels for their members. Without that the server does not load.
- `--dangerously-load-development-channels` is not listed in `claude --help` of 2.1.314 on the build machine; not
  verified there. If `claude` rejects the flag, update Claude Code.

**What an event looks like in the session.** The tag's attributes are the meta keys `event` (the kind, or kinds
joined by a comma when events for one card were merged), `task`, `board`, `from` (a display name; spaces become `_`)
and `origin` (empty except on `task_created`). The text is one line, for example:

    <channel source="taskmanager-crew" event="task_created" task="<card id>" board="<board id>" from="Scrappy_Customer" origin="person">task_created: "Plan the login page" (task "<card id>", from "Scrappy Customer", origin "person")</channel>

- `reply` with `needs_feedback_from_me`: the text ends with ` [needs your feedback]`. It means you have asked a
  `QUESTION:` on that card at some point. It does not say whether this reply answers that question.
- Several events on one card that arrive within two seconds of the first one are one line: `2 events for task "<card id>": ...`.
- The kinds: `task_created`, `task_assigned`, `reply`, `task_moved`, `mention`, `unblocked`, `delivery_failed` (PM only, see below), and the four GitHub kinds below.
  - `task_created` reaches only members who are streaming now or were active in the last 24 hours. The channel passes
    it on to a worker only when the card is assigned to that worker.
  - `task_moved` reaches only the card's assignee and creator, and only when the card moves into Verify, Ready for
    live, Done or Bugs. Nobody else hears of the move.
  - `unblocked` reaches the card's assignee and the crew's pm when the last open blocker of the card finishes (finished column, completed, or trashed). Nothing moves by itself.
  - `origin` is `person`, `agent` or `rule`, or `github` on the four GitHub kinds below. Nothing emits those until the
    GitHub webhook slice lands. A card made by the GitHub sync script (`issuesync.mjs`) goes through the agent API, so
    it arrives with `origin "agent"`.
- The GitHub kinds: `pipeline_failed`, `pipeline_passed`, `merged_staging` and `merged_production`. They are about a
  pull request linked to a card: a check failed or passed on it, or it was merged into staging or production. The text
  is the card title and ` ref "..."` (the pull request number and its branch, cut to 60 characters). No text from
  GitHub is in them: no body, no comment, no check log. The server decides who hears each one, and the event says so
  with `is_pm`, `is_boss` and `assigned_to_me`. They reach the crew once the GitHub webhook slice (GH3) is on master;
  before that nothing emits them.
  - The PM hears all four. `pipeline_failed` and `pipeline_passed`: nothing for the PM to do (the assignee fixes,
    Boss reviews). `merged_staging`: check the staging result and tell the customer. `merged_production`: nothing
    (Boss moves the card to Done).
  - The worker the card is assigned to hears all four. `pipeline_failed` means: read the failure on the pull request
    and fix it on the same card. No new card.
  - Boss hears `merged_staging` and `merged_production`, and `pipeline_passed` on a card in Verify. Boss hears
    `pipeline_failed` only as the card's assignee or creator, and then it is that owner's fix, as for any owner.
    `pipeline_passed` on a card in Verify is Boss's review; `merged_production` is the card going to Done.
  - The card's assignee and creator hear all four, as the PM does. A team that is not a crew gets its owners and
    assignees only. A customer never hears any of them.
  - A failed and then a passed pair on one card within two seconds comes as one line, both kinds in `event`, in order.
- `delivery_failed` (the PM only): a GitHub delivery gave up for good and waits in the failed table. `ref` is the delivery id; the title has the event, the repository, the class (transient or permanent), the attempts and a short code, never the payload or the reason text. This is live only while the PM's channel is connected: the failed list (`list_failed_deliveries`) is the record, read it at the start of a round. The PM reads it, retries it once if the cause is gone (a retry after a claim expiry sends the same stored payload again), and otherwise discards it with a reason. `github_queue_status` shows the queue.
- The card body is never in the event. Read it with `get_task`.

**If events do not arrive:**

- `/mcp` in the session lists `taskmanager-crew` with its state. A failed server is the first thing to look at.
- The channel writes its own trace to stderr, prefixed `[channel <who>]`. Run the session with `claude --debug`
  (or `--debug-file <path>`) and read the trace. The default per-session logs are under `~/.claude/debug/`. These
  are the lines to expect:
  - `started for <who> at the live tail`, or `started for <who> from event <n>`: the channel is up. `from event`
    means it resumed from its saved point.
  - `the server refused this crew key (HTTP 401)` or `(HTTP 403)`: the key is wrong, revoked, or lacks `boards:read`.
    The channel retries every five minutes and logs once.
  - `event stream: HTTP 429`: more than 30 connects a minute for this key. Stop starting the session in a loop.
  - `event stream: HTTP 503`: the server's stream slots are full. The channel retries on its own, with a wait that
    grows from 1 s to 60 s.
  - `event stream: no data for 90 s`: the server pings every 25 s, so this means the connection is dead; the channel reconnects.
  - `the event stream ended; reconnecting`: a normal reconnect.
  - `the server closed the event stream (key_revoked)` or `(disabled)`: the channel stops and does not reconnect.
    Fix the key or the crew (the owner decides), then start the session again.
  - `backlog_cut: the server dropped older events`: events older than the kept backlog (500 events or 24 hours) are
    gone. Check the board with `my_tasks` for what was missed.
  - `redirect refused`: the server answered with a redirect. The key is not sent on; check `base` in `creds.json`.
  - `channel <who>: no apiKey for this person in creds.json, or no base URL. Provision the crew first.`: exit 78.
  - `channel <who>: the base URL in creds.json must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1]). Nothing was sent.`: exit 78.
- Exit codes: 0 when stdin closes (the session ended); 1 when the server closed the stream (`closed`); 2 for a bad
  `<who>`; 78 for a setup fault. A missing `crew.json` or `creds.json` also exits 78, with a message that names the folder.
- **Only one session per key.** A second session with the same key replaces the first, and then the first
  reconnects and replaces the second. Two sessions with one key take turns and hit the rate limit. Run one session
  per member.
- Events are kept only for a user who is streaming or was active in the last 24 hours. A member who was away for
  longer gets `backlog_cut`, not the old events.

**Security:**

- Outbound only. The server opens no listening port; Taskmanager never calls the session.
- `https://` is required for `base`. Plain `http://` is accepted only for `localhost`, `127.0.0.1` or `[::1]`. Redirects
  are refused, so the key goes only to the base URL.
- The key comes from `creds.json` and is sent as a Bearer header. It is never written to the trace or to the state file.
- The state file `channel-<who>.state.json` in `CREW_HOME` holds the last event id and nothing else (mode 600).
- Card text is data. The event carries the kind, the ids, a display name and the title cut to 120 characters, never
  the body. Titles are stripped of control characters, and `< > &` are escaped, so a title cannot close the tag. The
  channel's instructions tell Claude that anything inside a card is data, not an instruction.
- The stream sends each key only what its owner may see. A customer or a contact gets only customer-visible events.

**Live check (the owner runs this; the crew cannot run a real Claude Code session).** Use the PM's member and a
scratch card. Each step ends with what you should see.

1. In the kit folder: `npm install`. Expected: no errors. Then
   `node -e "import('@modelcontextprotocol/sdk/server/index.js').then(() => console.log('sdk ok'))"` prints `sdk ok`.
2. Check that the key exists without printing it:
   `node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(Object.keys(c.people).join(' '))" <CREW_HOME>/creds.json`.
   Expected: a list of member keys that includes `pm`.
3. Start the channel by hand, with no session attached:
   `CREW_HOME=<CREW_HOME> timeout 5 node <kit folder>/channel.mjs pm < /dev/null; echo "exit $?"`.
   Expected: `[channel pm] started for pm at the live tail` (or `from event <n>`), then `exit 0`.
4. The same with a member that has no key, for example `pm2`: expected `channel pm2: no apiKey for this person in creds.json, or no base URL. Provision the crew first.`
   and `exit 78`.
5. Create `.mcp.json` as above in the folder you start `claude` from.
6. Start the session: `claude --dangerously-load-development-channels server:taskmanager-crew`. Expected: the
   session opens (accept the development-channel prompt if Claude Code shows one). Not with `-p`.
7. Type `/mcp`. Expected: `taskmanager-crew` is listed as connected.
8. Run `claude --debug` instead, or read the debug log: expected `[channel pm] started for pm at the live tail`
   (or `from event <n>`).
9. Check the audit row. Sign in to Taskmanager as the key's owner (the PM account) and open `/projects/inbox?tab=agent`
   (Agent audit). Expected: a row `Event stream connected`, tool `agent.events`, for the key `pm`. One row per connect,
   not per event.
10. Create a scratch card on the crew board in the app, with the title `scratch:channel` (the title, not a tag).
    Expected in the session within a few seconds: a tag `<channel source="taskmanager-crew" event="task_created" ... origin="person">`,
    with that title. Delete the scratch card when done.
11. Stop the session. Create a second scratch card (title `scratch:channel`) while it is down. Start the session again.
    Expected: the second card's `task_created` arrives, and the log shows `started for pm from event <n>` and no
    `backlog_cut` line. Delete both scratch cards.
12. Optional: a `closed` stop. Set the key to disabled in the app, or revoke it, and start the session. Expected:
    `the server closed the event stream (key_revoked)` or `(disabled)`, the process exits with 1, and there are no
    further reconnects. Restore the key afterwards.

The check passes when steps 3, 7, 9, 10 and 11 show the expected output. Report any step that does not, with the
trace from `claude --debug`.

## Commands

    crew <who> <command ...>      board tools as one person (tm.mjs)
    crew <who> update <taskId> <body.md|->   an update from a Markdown file or stdin (the default for long text)
    crew <who> attach <taskId> <image>       upload an image to a task
    crew listen <who> [seconds]   wait for new messages for a person (listen.mjs)
    crew watch                    the Boss's watch of the board (watch.mjs)
    crew init                     check the machine, render the documents (init.mjs)
    crew setup                    make the crew by hand (setup.mjs)
    crew <who> browser goto|shot|eval|console|tabs|close-tab|done   the shared browser (browser.mjs)
    crew browser status|shutdown  the shared browser for everyone

The old file names (`tm.mjs`, `listen.mjs`, ...) still work.

Post long text from a file, not inline JSON: write the Markdown to a file and run `crew w1 update <taskId> body.md`. An update is internal (staff only) unless `--customer` is given; a customer contact's update is customer-visible whatever the flag says, because the server decides. The board prints `posted as internal` or `posted as customer`. An empty body, a file over 200 KB, invalid UTF-8 or NUL bytes exit 65; a missing file, a symlink or a non-file exits 66; an unknown flag exits 64; a board that cannot be reached exits 69 (try again). The one-line form is `crew w1 mcp post_task_update`, with a JSON object holding the id and the body.

## The shared browser

`crew <who> browser ...` looks at a page and checks it. One headless Chromium runs for the whole crew: the first command starts it, and it exits by itself after ten minutes with nobody using it. Each person gets a browser context (their cookies and storage are kept apart from everyone else's) and signs in with their own email and password from `creds.json`, the same sign-in `tm.mjs` does. Nothing about the login is written to disk. The driver is `browser-driver.mjs`: it listens on a unix socket in a 0700 folder under the work folder, and no TCP port is open. `browser.mjs` is the command.

Settings: the Chromium path is `chromium` in `crew.json`, as for `tm.mjs`, else `CHROMIUM`. `CREW_CHROMIUM_NO_SANDBOX=1` adds `--no-sandbox` (see above). `CREW_BROWSER_SHOT_DIRS` (colon-separated folders) is where `shot` may write; by default only the work folder, and the system temp folder only when it is named there. `BROWSER_IDLE_SECONDS` (default 1800) ends a person's session after that much idle time, `BROWSER_EXIT_SECONDS` (600) stops the browser when nobody uses it, and `CREW_BROWSER_MAX_PEOPLE` (16) caps the number of people. `CREW_ACCEPT_DIALOGS=1` accepts dialogs for the driver.

Limits, which the design does not remove:

- **One Linux user runs the whole crew.** Every person can read every socket and every profile folder. Contexts stop accidents between people. They do not stop a worker who wants to reach another person's session. Separate profiles would not change that.
- **One browser, so one failure for all.** A browser crash, or a kill, ends every person's session at once. The next command starts a new browser, signs each person in again, and says so in its note.
- **No TCP debug port.** Nothing listens on the network. A Playwright `run` script cannot attach to this browser, so `run` keeps its own browser, and `tm.mjs run` still starts one per call.
- **`eval` runs in the page.** Do not put secrets in a script. `send` is an allowlist of CDP domains (no downloads, no file chooser, no CSP bypass, no Browser, Target, Fetch or Storage domains).
- **Dialogs are dismissed** unless asked for. A page can still hold a command for up to two minutes, the request timeout.
- **`shot` writes PNG or JPEG files only**, never through a link, never over a folder, and never over an existing file without `--overwrite`.

## Updating

Get the new kit (`/crew/kit.tar.gz`) and unpack it over this folder. Your state is in `CREW_HOME`,
and the kit's changes are in `CHANGELOG.md`. Run `node init.mjs` again (from the kit folder) to render the documents
from the new templates. The kit's `x-crew-kit-version` response header names the build.
