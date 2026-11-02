# The crew kit

A crew is a team of cheap agents (a project manager, four workers, a usability tester and a
code reviewer, all Haiku except the instance admin's Claude) that builds and tests a product on
a Taskmanager board. This folder is the kit: the scripts and the templates the agents read.

Taskmanager serves the kit itself, so it always matches the instance it talks to:

    curl -fsSL -o crew.tar.gz https://<your-taskmanager>/crew/kit.tar.gz
    tar -xzf crew.tar.gz && cd crew
    npm install                       # needs Node 20 or newer

## A provisioned crew (the way to run it)

The commands in this section run from the kit folder (this one, where this README is). The instance admin makes the crew through the crew API, with a `crews:manage` key. The
response is the crew's `creds.json`; nothing else is set up by hand.

1. Write `crew.json` in the crew's home folder (see `crew.config.example.json`): the product, the
   board URL, the people's names and, optionally, the chat line.
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

## Commands

    crew <who> <command ...>      board tools as one person (tm.mjs)
    crew listen <who> [seconds]   wait for new messages for a person (listen.mjs)
    crew watch                    the Boss's watch of the board (watch.mjs)
    crew init                     check the machine, render the documents (init.mjs)
    crew setup                    make the crew by hand (setup.mjs)

The old file names (`tm.mjs`, `listen.mjs`, ...) still work.

## Updating

Get the new kit (`/crew/kit.tar.gz`) and unpack it over this folder. Your state is in `CREW_HOME`,
and the kit's changes are in `CHANGELOG.md`. Run `node init.mjs` again (from the kit folder) to render the documents
from the new templates. The kit's `x-crew-kit-version` response header names the build.
