# Taskmanager

[![CI](https://github.com/AVMG20/arnotes/actions/workflows/ci.yml/badge.svg)](https://github.com/AVMG20/arnotes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-34d399.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-34d399.svg)](https://github.com/AVMG20/arnotes/releases)

Taskmanager is a self-hosted project manager for an agency and its customers: organisations, customers with their own logins, and kanban boards with assignees, due dates and nested subtasks. It started as a fork of [Arnotes](https://github.com/AVMG20/arnotes-old), and its install names (`services.arnotes`, the `arnotes` database and Docker volumes) are kept from there so upgrades stay in place. It includes a rich-text editor, full-text search, attachments, expiring public links to boards, an installable PWA, optional AI writing tools through OpenRouter, and an MCP server for connecting AI agents.

![Taskmanager editor](public/screenshot.png)

> Taskmanager is at version 0.1.0. Back up your data before upgrading and review the [changelog](CHANGELOG.md) for upgrade instructions.

## Features

- Rich editing with headings, tables, tasks, code blocks, highlighting, and images
- Search across boards, tasks, and labels
- Markdown import and export
- Soft deletion and trash recovery
- Private boards, each with an optional expiring public link
- Email/password accounts with optional Discord, GitHub and Google OAuth, or your own OpenID Connect server
- Passkeys, authenticator-app two-factor, and optional sign-in codes by email
- Bring-your-own-key OpenRouter integration; AI is entirely optional
- Customers inside your organisation, each with projects and logins of their own: a customer sees the tasks and updates you mark as visible to them, and never the internal ones
- Kanban boards for projects: columns, drag-and-drop tasks, labels, rich-text descriptions, and a log of updates per task, written in a narrow inline Markdown (bold, italic, code, strike, highlight, links)
- Project Settings for the team: General (owner, archive and delete), Repositories (several linked GitHub repositories, one default), Rules and Custom fields
- Automation rules per project: a trigger, conditions and actions, with a run log, and loop protection
- Live updates, so a change made by an AI agent, a teammate, or another tab shows up without a reload — on shared links too
- Built-in MCP server so Claude Code and other AI agents can read and manage your boards, using API keys you scope yourself
- Crews: agent teams made through the crew API, with an instance-admin Crews page; see [Crew API](#crew-api)
- Installable Progressive Web App
- Docker- and Nix-based self-hosting with persistent PostgreSQL and attachment storage

## Quick Start

Requirements: [Git](https://git-scm.com/) and Docker with the Compose plugin.

```bash
git clone https://github.com/AVMG20/arnotes.git
cd arnotes
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000) and create an account.

That is the entire local self-hosting setup. Compose builds Taskmanager, starts PostgreSQL, waits for it to become healthy, pushes the Drizzle schema, and generates a persistent authentication secret.

Check status and logs with:

```bash
docker compose ps
docker compose logs -f app
```

Stop the stack without deleting data:

```bash
docker compose down
```

## Self-Host With Docker

The defaults are intended to work immediately on a trusted local machine. For an internet-facing server, create a `.env` file first:

```bash
cp .env.example .env
```

At minimum, change these values:

```dotenv
BETTER_AUTH_URL=https://taskmanager.example.com
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters
ALLOW_SIGN_UP=true
```

Generate an authentication secret with `openssl rand -base64 32`. The default `DATABASE_URL` connects to the bundled PostgreSQL service; replace the complete URL only when using an external PostgreSQL database.

Start the production stack:

```bash
docker compose up -d --build
```

Create your owner account, then set `ALLOW_SIGN_UP=false` in `.env` and apply the change:

```bash
docker compose up -d
```

### HTTPS And Reverse Proxy

Taskmanager listens on port `3000`. Put it behind a TLS-terminating reverse proxy for internet access. `BETTER_AUTH_URL` must exactly match the public origin, including `https://` and any non-standard port.

Example Caddy configuration:

```caddyfile
taskmanager.example.com {
  reverse_proxy localhost:3000
}
```

Only expose the application through the reverse proxy. PostgreSQL is bound to `127.0.0.1` by default and should not be made publicly reachable.

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public application origin used by authentication |
| `BETTER_AUTH_TRUSTED_ORIGINS` | empty | Extra origins, comma separated, that may sign in besides `BETTER_AUTH_URL` |
| `APP_PORT` | `3000` | Host port mapped to the application |
| `DATABASE_URL` | bundled PostgreSQL | Complete PostgreSQL connection URL |
| `BETTER_AUTH_SECRET` | generated | Stable 32+ character authentication secret; generated into the data volume when empty |
| `SECRETS_ENCRYPTION_KEY` | generated | Encrypts project secrets: 32 random bytes as 64 hex characters, generated into the data volume when empty. Back it up apart from the database and never change it; without it every stored secret is unreadable |
| `ALLOW_SIGN_UP` | `true` | Whether visitors may create accounts, by any sign-in method |
| `NUXT_PUBLIC_DISCORD_ENABLED` | `false` | Show and enable Discord OAuth sign-in |
| `DISCORD_CLIENT_ID` | empty | Discord application client ID |
| `DISCORD_CLIENT_SECRET` | empty | Discord application client secret |
| `NUXT_PUBLIC_GITHUB_ENABLED` | `false` | Show and enable GitHub OAuth sign-in |
| `GITHUB_CLIENT_ID` | empty | GitHub application client ID |
| `GITHUB_CLIENT_SECRET` | empty | GitHub application client secret |
| `NUXT_PUBLIC_GOOGLE_ENABLED` | `false` | Show and enable Google OAuth sign-in |
| `GOOGLE_CLIENT_ID` | empty | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | empty | Google OAuth client secret |
| `NUXT_PUBLIC_OIDC_ENABLED` | `false` | Show and enable sign-in through your own OpenID Connect server |
| `NUXT_PUBLIC_OIDC_NAME` | `Single sign-on` | Label on that button, e.g. `Authentik` |
| `OIDC_DISCOVERY_URL` | empty | The server's `.well-known/openid-configuration` URL |
| `OIDC_CLIENT_ID` | empty | OIDC client ID |
| `OIDC_CLIENT_SECRET` | empty | OIDC client secret |
| `NUXT_PUBLIC_PASSKEYS_ENABLED` | `true` | Allow signing in with passkeys |
| `NUXT_PUBLIC_EMAIL_CODE_ENABLED` | `false` | Show and enable "Email me a code" sign-in; needs SMTP |
| `SMTP_HOST` | empty | SMTP server for outgoing mail |
| `SMTP_PORT` | `587`, or `465` when secure | SMTP port |
| `SMTP_SECURE` | `false` | `true` for TLS from the first byte; otherwise STARTTLS is used when offered |
| `SMTP_USER` / `SMTP_PASSWORD` | empty | SMTP credentials, if the server needs them |
| `SMTP_FROM` | empty | Sender address, e.g. `Taskmanager <taskmanager@example.com>` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | empty | Key pair for Web Push (notifications when no tab is open); both must be set, and the site needs HTTPS. `.env.example` has a one-line command that makes a pair |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | How push services can reach you: a `mailto:` or `https:` URL |
| `GITHUB_TOKEN` | empty | Optional GitHub token for reading issues, pull requests and workflow runs; public repositories work without it, at GitHub's lower rate limit. Only ever sent to GitHub |
| `GITHUB_WEBHOOK_SECRET` | empty | Secret GitHub signs webhook deliveries with, checked on `POST /api/github/webhook`. The receiver answers 503 until it is set |
| `GITHUB_ALLOWED_OWNERS` | empty | Comma-separated GitHub owners and orgs that links may point at. Empty allows any owner the token can see; set it in production, since the token can read every repository it has access to |
| `RABBITMQ_URL` | empty | Broker for the GitHub delivery queue, `amqp://user:password@host:5672/vhost`. The webhook publishes to it with confirms; without it GitHub events are answered 503 (development and test use an in-memory queue). Compose builds it from `RABBITMQ_PASSWORD` instead (required there). The server starts without it. See [GitHub deliveries and the queue](#github-deliveries-and-the-queue) |
| `DUE_RULES_INTERVAL_MS` | `900000` | How often the due-date rules are checked, in milliseconds (15 minutes). Testing only: ignored when `NODE_ENV` is `production` |
| `MAINTENANCE_MODE` | empty | Set to `1`, `true`, `yes` or `on` to put the app in maintenance mode: every request is answered 503 with `Retry-After` (a small page for the browser, JSON for `/api` and the agent endpoint), except `/api/health`. Due-date rules pause too |
| `MAINTENANCE_FILE` | `maintenance.on` | A file whose existence turns maintenance mode on with no restart: `touch maintenance.on` before a deploy, `rm maintenance.on` after. Relative to the working directory |
| `GITHUB_API_URL` | empty | Testing only: call a local stub instead of `api.github.com`. Ignored when `NODE_ENV` is `production` |

To enable Discord, set all three Discord variables and register this redirect URL in the Discord developer portal:

```text
https://taskmanager.example.com/api/auth/callback/discord
```

To enable GitHub, set all three GitHub variables and register this authorization callback URL in a GitHub OAuth app:

```text
https://taskmanager.example.com/api/auth/callback/github
```

To enable Google, set all three Google variables and create a *Web application* OAuth client under Google Auth Platform → Clients in the Google Cloud Console, with this authorized redirect URI:

```text
https://taskmanager.example.com/api/auth/callback/google
```

Google accepts plain `http` redirect URIs only for `localhost`, so `http://localhost:3000/api/auth/callback/google` works for local development. Other hosts, including `*.localhost` names and LAN IP addresses, need HTTPS on a public domain. While the consent screen is in *Testing*, only the Google accounts listed as test users can sign in.

To use your own OpenID Connect server (Authentik, Authelia, Keycloak, Pocket ID, Kanidm), create a confidential client there with this redirect URI, set the three `OIDC_*` variables, and name the button with `NUXT_PUBLIC_OIDC_NAME`:

```text
https://taskmanager.example.com/api/auth/oauth2/callback/oidc
```

Taskmanager can link GitHub issues, pull requests, branches and workflow runs to a task and show what GitHub says about them without leaving the app. On a task, paste an issue, pull request, branch or run link, or `owner/repo#123` (`#123` alone once the project has a default repo, set under the project's Overview). The server reads the data from `api.github.com` with the token kept on the server, caches it, and shows a rate limit or an outage in words. Each link is internal or visible to the customer, and a customer's contact sees only the ones marked for customers. Agents get `link_github`, `unlink_github` and `get_task_github`. The webhook receiver refreshes links when GitHub reports a change: in the repository or organisation settings on GitHub, add a webhook with this payload URL, content type `application/json`, the same secret as `GITHUB_WEBHOOK_SECRET`, and the events `issues`, `issue_comment`, `pull_request`, `check_run` and `workflow_run`. Until the secret is set on the server, the receiver answers 503:

```text
https://taskmanager.example.com/api/github/webhook
```

The same webhook runs the **card syncer**, when sync is switched on for a linked repository (Settings > Repositories): issues by the accepted logins of that repository become cards in the chosen column, and their comments become card updates. Issues by anyone else are only counted, and the setting shows the last one. A comment that starts with `Claude (Taskmanager crew session)`, or whose id is listed in `GITHUB_ECHO_COMMENT_IDS` (comma separated), is dropped silently; so is a comment from a login that is not accepted, and those are not counted. A repository may send `GITHUB_DELIVERY_PER_MINUTE` deliveries a minute: a whole number from 1 to 100000, and anything else (0, a negative, not a number, a huge value) means the default of 120, with one log line. Above the limit, the webhook answers 429 with `Retry-After: 60`. A delivery the server cannot queue is answered 503. Both show as failed on GitHub. Once a delivery is queued, a failure while it is applied is retried (after 30 s, then 2 min; three attempts in all). After the last attempt, or at once for a permanent failure, it is recorded in the failed table (with its reason and payload) and copied to the failed queue. The PM retries or discards it from the table; the tools come with GH6c. GitHub still records the delivery as delivered.

What a redelivery leaves alone: a redelivered `opened` for a card that exists changes nothing, so a rename made on the board stays. A redelivered `edited`, `closed` or `reopened` writes once: each of those updates carries the delivery id, and the write is skipped when an update with that id already ends a comment on the card. A comment copy carries its GitHub comment id and is written once per comment. Each marker ends with a short digest that only the server can make, from `BETTER_AUTH_SECRET` (or the webhook secret when that is unset), so a board member who pastes a comment id cannot stop a copy. A board member who copies a whole syncer update, digest included, could. A delivery with no GitHub delivery header is given a derived id from its event, issue or comment, action and time. An edit replaces the card's title or text only while the card still holds what was synced from the old text; otherwise the edit is posted as an update. Logins are matched by name, so when an account is renamed its old login can be taken by someone else, and that person's issues would then pass the accepted-login check. Check the accepted logins after a rename. The ordering of one issue's work is kept in memory, so run one app instance.
### Passkeys, Two-Factor And Email Codes

**Passkeys** work without any configuration. A signed-in user adds one under **Settings → Security**, then signs in with the passkey button, or by picking it from the email field's autofill. A passkey is bound to the hostname in `BETTER_AUTH_URL`: changing that hostname, or moving from `localhost` to a real domain, leaves existing passkeys unusable, and they have to be added again.

**Two-factor authentication** is also always available, under **Settings → Security**: scan the QR code with an authenticator app, confirm one code, and keep the backup codes. It protects password sign-in, so it is only offered to accounts that have a password. An account with two-factor turned on cannot sign in with an email code, since that would let the inbox stand in for the second factor; passkeys and OAuth still work.

**Email codes** need an SMTP server. Set `NUXT_PUBLIC_EMAIL_CODE_ENABLED=true` with at least `SMTP_HOST` and `SMTP_FROM`. A code is valid for 10 minutes and allows three attempts. When sign-up is allowed, a code for an unknown address creates the account. For local development, [Mailpit](https://mailpit.axllent.org/) catches the mail without sending it:

```bash
docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit
# .env: SMTP_HOST=localhost, SMTP_PORT=1025, SMTP_FROM=Taskmanager <taskmanager@localhost>
# read the mail at http://localhost:8025
```

The `NUXT_PUBLIC_*_ENABLED` switches are used by both the server and client, so the same configuration works with native development and Docker Compose.

OpenRouter credentials are entered per user under Settings and are not server environment variables.

### Organisations And Customers

The first account to sign up runs the instance. It gets an organisation of its own and is the only account that may hand out the right to create organisations, under **Accounts on this instance** in the workspace menu. An instance that already had users is upgraded the same way on startup: its oldest account becomes the admin.

Inside an organisation, **Customers** in the workspace menu adds customers, files projects under them (the customer button next to a board's name), and creates invitation links. A link works once, for 14 days, and is shown only when it is created. Whoever opens it signs in or creates an account, even where `ALLOW_SIGN_UP=false`, and becomes a contact of that customer: the customer's boards appear in their personal workspace.

Contacts see what is marked as visible to the customer and nothing else:

- A task is visible to the customer unless it is switched to **Internal** in its panel. Internal tasks are also left off a board's public link.
- An update starts out internal. The lock next to the update box shares the next one, and **Show to customer** in an update's menu shares one already posted.
- Contacts can file tasks and post updates, which are always visible to the team and the customer. They cannot move, edit, or delete tasks, change columns, or share the board.

Agents over MCP and the in-app assistant work with staff access only. They never reach a customer's board through a contact's key.

### Persistent Data

Compose creates two named volumes:

- `arnotes_postgres_data` stores accounts, boards, settings, and metadata.
- `arnotes_app_data` stores uploaded attachments, the auto-generated auth secret and the secrets encryption key.

`docker compose down` keeps both volumes. `docker compose down -v` permanently deletes them.

### Backups

Back up both PostgreSQL and the application data volume:

```bash
docker compose exec -T postgres pg_dump -U arnotes -d arnotes > arnotes.sql
docker run --rm -v arnotes_app_data:/data:ro -v "$PWD":/backup alpine tar czf /backup/arnotes-data.tar.gz -C /data .
```

When using an external database, use its matching connection details instead. Store the backup files somewhere separate from the host running Taskmanager. The data volume also holds `.secrets-key`, which encrypts project secrets: keep a copy of it apart from the database dump, in a password manager or a secret store, since the database holds the encrypted secrets and the key is what opens them. Never change the key; a new one cannot read the old secrets.

### Updates

Pull the new source, rebuild the image, and let Compose push the current schema before starting Taskmanager:

```bash
git pull --ff-only
docker compose up -d --build
docker image prune -f
```

Take a backup first. Watch startup with `docker compose logs -f app` and verify `http://localhost:3000/api/health` returns a healthy response.

## Self-Host With Nix

The same stack runs natively on Nix: a `flake.nix` builds the app and the schema tooling as hermetic packages, and a NixOS module turns them into the same three services Compose runs — PostgreSQL, a one-shot schema push, and the app.

Requirements: [Nix with flakes](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix.html).

### NixOS module

The module manages everything itself. By default it creates a dedicated `arnotes` PostgreSQL role and database on the system PostgreSQL, generates a stable auth secret and a secrets encryption key into `/var/lib/arnotes` on first start, and runs the Drizzle schema push before launching the app.

```nix
# flake.nix of your system
{
  inputs.arnotes.url = "github:AVMG20/arnotes";
  outputs = { self, nixpkgs, arnotes, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [
        arnotes.nixosModules.default
        {
          services.arnotes = {
            enable = true;
            betterAuth.url = "https://taskmanager.example.com";
            openFirewall = true;
            # allowSignUp defaults to true; set to false once the owner account exists
          };
        }
      ];
    };
  };
}
```

Build the configuration and apply it with `nixos-rebuild switch --flake .#host`, then open `http://localhost:3000`. Attachments and the generated secrets live under `/var/lib/arnotes`; back that directory up alongside PostgreSQL (`pg_dump`). The `.secrets-key` file there encrypts project secrets: keep a copy apart from the database dump.

Key options (`services.arnotes.*`):

| Option | Default | Description |
| --- | --- | --- |
| `port` / `host` | `3000` / `0.0.0.0` | Listen address |
| `stateDir` | `/var/lib/arnotes` | Attachments and generated auth and secrets keys |
| `database.createLocally` | `true` | Manage a local PostgreSQL role and database |
| `database.url` | derived | Use an external database instead of the local one |
| `betterAuth.url` | `http://localhost:3000` | Public origin used by authentication |
| `betterAuth.secretFile` | generated | Read a stable 32+ char secret from a file |
| `secrets.keyFile` | generated | Read the project secrets key (64 hex characters) from a file. Read at evaluation, so it ends up in the Nix store, like `betterAuth.secretFile` |
| `allowSignUp` | `true` | Allow new accounts, by any sign-in method |
| `discord.enable` / `github.enable` / `google.enable` | `false` | Enable OAuth sign-in; set `clientId`/`clientSecret` |
| `oidc.enable` | `false` | Enable your own OIDC server; set `name`, `discoveryUrl`, `clientId`, `clientSecret` |
| `passkeys.enable` | `true` | Allow passkey sign-in |
| `emailCode.enable` | `false` | Enable email-code sign-in; set `smtp.host`, `smtp.from` and, if needed, `smtp.port`/`secure`/`user`/`password` |
| `queue.enable` | `false` | Run RabbitMQ on this host for the GitHub delivery queue and set `RABBITMQ_URL` to it. Its password is generated into the state directory and read by the broker, never on a command line. The user is created whenever this is set, also with `queue.urlFile` |
| `queue.urlFile` | `null` | Absolute runtime path of a file holding the `RABBITMQ_URL` of an external broker. Read at service start into the environment file. Never a store path; see [GitHub deliveries and the queue](#github-deliveries-and-the-queue) |
| `environment` | `{}` | Extra environment variables |
| `openFirewall` | `false` | Open the app port in the firewall |

### Packages

Without a NixOS system, build and run the packages directly:

```bash
nix build .#default   # the app  (result/bin/arnotes)
nix build .#schema    # schema tooling (result/bin/arnotes-db-push)
```

Run the app against a PostgreSQL of your choice:

```bash
DATABASE_URL=postgresql://arnotes:arnotes@localhost:5432/arnotes \
BETTER_AUTH_URL=http://localhost:3000 \
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters \
./result/bin/arnotes
```

### Development shell

`nix develop` provides bun, node, PostgreSQL and RabbitMQ, and helpers that replace `docker compose up -d postgres` and the broker of the GitHub queue:

```bash
nix develop
db-start            # init and start a local PostgreSQL on port 5432
mq-start            # start a local RabbitMQ on 127.0.0.1:5672 and print its RABBITMQ_URL
bun install
bun run db:push     # push server/db/schema.ts to PostgreSQL
bun run dev         # run the dev server with hot reload
```

`db-stop` stops the local PostgreSQL. Its data lives under `.nix-data/` in the repo. `mq-stop` stops RabbitMQ, whose data is under `.nix-data/rabbitmq/`.

> Building the packages runs `bun install` against the npm registry inside a fixed-output derivation, so builds need network access on first run. Native dependencies differ per platform, so each one has its own hash in `nix/hashes.json` (linux × x86_64/arm64 and Apple Silicon macOS). The `nix-hashes` workflow recomputes and commits them whenever `bun.lock`/`package.json` change, so dependency bumps don't break the flake. Intel macOS (`x86_64-darwin`) was retired from nixpkgs and is not supported.

## Project Settings And Rules

Each project has a **Settings** page for its team; a customer's contacts have none. It has six sections:

- **General**: the name, description and status; the owner, who alone may hand the project to someone else; **Archive**, which hides the project from the lists and stops its rules until it is unarchived; and **Delete**, which asks for the project name first.
- **Repositories**: the GitHub repositories the project links issues and pull requests from. Several can be linked and one is the default, so a bare `#123` means its issue. The default visibility for new links is set here. Any repository can be made the default, have its visibility changed, or be removed; task links to it stay on their tasks.
- **Rules**: the automation rules described below.
- **Members**: who is on the project and in which vault role, see Project secrets below.
- **Secrets**: the environment variables the project keeps, see Project secrets below.
- **Custom fields**.

### Rules

A rule says what happens on a board: when its trigger happens and every condition holds, its actions run. Rules are built in **Settings → Rules**. Each one shows its plain sentence, an on/off switch, and its run log, which says for each run whether it ran, failed or was stopped.

| Part | Choices |
| --- | --- |
| Triggers | a task is added, moved to a column, completed, reopened, assigned, given a due date, or its due date passes; a comment is added; a linked pull request is merged, closed, or has failing checks |
| Conditions (up to 10) | the task is in a column, is assigned to someone or to nobody, has a label, has or has no due date, or has a visibility |
| Actions (up to 20) | move to a column, assign, unassign, set the due date to a number of days from now, complete, reopen, add a label, add a comment, create a subtask, set the visibility |

- A project holds up to 50 rules. Only the project owner can use the set-visibility action.
- The due-date trigger fires once per task and due date, once that date is behind us. The check runs every 15 minutes (`DUE_RULES_INTERVAL_MS` changes that for tests).
- Rules run for changes made in the app and through the agent tools.
- Loop protection: a chain of rule steps stops after five steps, and a rule never runs twice on the same task within one chain. A stopped run is logged with the steps that would have repeated.
- Deleting a rule asks first and deletes its run log with it.

Agents get `list_rules`, `create_rule`, `update_rule` and `list_rule_runs`. A rule is checked the same way in Settings and by the agent tools, and a refused rule comes back with the reasons.

### Project secrets

A project keeps its environment variables in **Settings → Secrets**: API keys, tokens and connection strings, each with a name, a value and an optional description. Values are encrypted with AES-256-GCM before they reach the database, under the key in `SECRETS_ENCRYPTION_KEY`. That key lives in the environment, not in the database, so a copy of the database alone reads as noise. The list never shows values. **Reveal** shows one on the page until it is hidden again or thirty seconds pass, and every reveal is logged.

Who can read what depends on the vault role a person has on the project:

| Who | Vault role | Reads | Changes |
| --- | --- | --- | --- |
| The project owner, and the team's owners and admins | Manager | every secret | secrets, and who is on the project |
| A team member given the Manager role under **Settings → Members** | Manager | every secret | secrets, and who is on the project |
| A team member given the Member role | Member | secrets set to **All members** | nothing |
| Anyone else on the team | none | nothing | nothing |

A personal project has only its owner, as manager. Board access does not change: everyone on the team still sees the board. A customer's contacts see no secrets and no members.

Each secret is either **Managers only**, the default, or **All members**. Team owners and admins already manage every project, so they need no row under **Settings → Members**. Removing someone's row takes away what it gave them; their team role still stands.

**Import .env** pastes `NAME=value` lines, reads comments and quotes, and adds or updates each name, reporting how many of each. **Download .env** writes the secrets you may read as a `.env` file. A name uses letters, digits and underscores, at most 100 characters; a value holds up to 16,384 characters; a project holds 200 secrets. An archived project's secrets are read-only.

Managers see an **Activity** list: secrets created, changed, deleted, revealed or exported, and members added, changed or removed, with who did it and whether it came from the app or an agent. The trail records names, never values.

Agents get two API key permissions, **Read project secrets** and **Write project secrets**. Both are off by default, so turn them on for a key on purpose. With read, `list_project_secrets` lists names, access and the caller's role, and `get_project_env` returns the `.env` text for what the key's person may read, or only the names asked for. The server cannot write files on the agent's machine, so the agent saves that text as the project's `.env` itself, and keeps `.env` out of git. With write, `set_project_secrets` adds or updates secrets by name, one or many, and `delete_project_secret` removes one for good. A write never returns a value. Keep values out of task updates, messages and chat; they belong in `.env`.

**Back up `SECRETS_ENCRYPTION_KEY` now, apart from the database.** Without it every stored secret is unreadable, for good. Docker and the Nix module generate the key on first start into the data directory (`/app/data/.secrets-key` in Docker, `/var/lib/arnotes/data/.secrets-key` under Nix). Copy it out into a password manager or a secret store rather than keeping it only beside the database dump. Do not change it: a different key cannot read the secrets stored under the old one. While the key is missing, the secrets list still shows the names with the reason they cannot be read, and every reveal, export and change is refused until the key is back.

## Connect An AI Agent

Taskmanager ships an [MCP](https://modelcontextprotocol.io) server, so Claude Code, Claude Desktop, and any other MCP client can search, read, and manage your kanban boards.

Open **Settings → API keys & MCP** to create a key, then follow the in-app setup guide at `/mcp`, which shows the endpoint for your install along with ready-made configuration snippets.

### API Keys

Keys are created per workspace: a key made inside a team reaches that team's boards, and a key made in your personal workspace reaches only your own. Each key carries the permissions you give it — read, write, or both.

| Permission | Tools it unlocks |
| --- | --- |
| Read boards | `list_boards`, `get_board`, `get_task`, `search_tasks`, `list_task_labels` |
| Write boards | `create_board`, `update_board`, `create_column`, `update_column`, `delete_column`, `restore_column`, `create_task`, `update_task`, `move_task`, `delete_task`, `restore_task` |
| Read project secrets | `list_project_secrets`, `get_project_env` |
| Write project secrets | `set_project_secrets`, `delete_project_secret` |

A key is displayed once, at creation. Only its SHA-256 hash is stored, so it can never be shown again — copy it then, or create a new one. Keys can be given an expiry date and can be revoked at any time, which disconnects anything using them immediately.

A read-only key does not merely refuse to write: the writing tools are never advertised to it.

### What the tools return

The list-shaped tools answer with what the screen shows, not with everything behind it. `get_board` returns each task the way its kanban card renders — title, labels, update count and the first 160 characters of the description — and `search_tasks` returns an excerpt around the match. The full description and the thread of updates come from `get_task`, one task at a time, so reading a busy board costs a board and not a stack of documents.

A large board can be narrowed further: `columns` restricts the read to the stages you care about, `detail: "titles"` drops the excerpts, and `limit` caps the tasks per column, reporting the rest as `omitted`.

Anything addressable in the app is also addressable by its link. Paste the URL of a board, or a board with a task open (`/projects/<id>?task=<id>`), into `get_board` or `get_task` and it resolves to that one resource — there is no title to describe and no id to retype.

### Connecting

The endpoint is `https://taskmanager.example.com/api/mcp`, spoken over streamable HTTP and authenticated with an `Authorization: Bearer` header.

```bash
claude mcp add --transport http taskmanager https://taskmanager.example.com/api/mcp \
  --header "Authorization: Bearer arn_your_key_here"
```

For clients configured with JSON:

```json
{
  "mcpServers": {
    "taskmanager": {
      "type": "http",
      "url": "https://taskmanager.example.com/api/mcp",
      "headers": { "Authorization": "Bearer arn_your_key_here" }
    }
  }
}
```

Anything an agent writes shows up in an open browser immediately — the app listens on a WebSocket at `/_ws` and refetches what changed, so a board list never sits there stale. Public pages listen on the same socket for the one board they were given a link to, so a shared board follows the work as it moves. Behind a reverse proxy, that path needs the usual `Upgrade`/`Connection` headers forwarded; a single app instance holds the connections in memory, so running several would need a shared bus between them.

Agents work with task descriptions as Markdown; Taskmanager converts to and from the editor's format on both sides.

Nothing reachable over MCP deletes anything permanently. `delete_column` and `delete_task` put the column or card in the board's trash, undone by `restore_column` and `restore_task` or by the user under **Show trashed** on the board. A board's trash is emptied automatically after 7 days. There is no `delete_board` tool at all — deleting a board takes every column, task and update with it, so it stays in the app behind a confirmation, where an agent cannot reach it.

The setup guide also offers a copyable skill file that teaches an agent the conventions of the app, such as matching your existing labels and reading a task before editing it.

### Crew API

`/api/crews` creates and manages crews for the crew kit. It answers only a request that really comes from this machine: the socket peer is loopback and the request carries no `X-Forwarded-For`, `X-Real-IP` or `Forwarded` header, whatever its value or casing. Behind a reverse proxy every request counts as remote, and while the window is closed a remote request gets a plain `404` with no hint.

To call it from elsewhere, an instance admin opens the window on the Crews page (linked from Settings) for 10 minutes (`POST /api/settings/crew-api-window`). Opening mints a temporary `crews:manage` key, shown once. While the window is open, remote callers may use only that key. The window closes at its end time, when the admin closes it, or at the first failed key on `/api/crews`: a bad, expired, wrong-scope or non-admin key closes it, whether the caller is local or remote. A failed key also revokes the temporary key and records the reason and the caller's address. The window row is cached for at most two seconds. The process that closes the window clears its cache at once; another process reads the close within those two seconds.

Operator notes:

- The proxy overwrites only `X-Real-IP` and `X-Forwarded-For`. The gate also refuses `Forwarded`, so a client cannot pass as local by sending it.
- A unix-socket peer counts as local only when `CREW_API_TRUST_SOCKET=true`. The app user and root can reach that socket, so the `crews:manage` key stays the real check, not the socket.
- The window state is kept in the database, so a restart neither leaves it open nor loses the reason it closed.
- Refused calls are audited (peer, method, path, outcome, never the key text). A call that closes the window is written at once; the others are written in batches once a second. Rows are kept 90 days. If more than 1000 rows wait within one second the extra rows are dropped and counted (`auditQueue.dropped` in the window status). The waiting rows are written on shutdown, with a two-second limit, only where the server's graceful shutdown runs them. The node preset runs it; the Bun preset's runtime does not register it (checked in the nitropack source, not on a running server), so under Bun a stop can lose the rows of its last second. The window status (`GET /api/settings/crew-api-window`) counts the failed writes (`auditQueue.failedRows`, `auditQueue.closingFailed`) and the prune runs and failures (`auditQueue.pruneRuns`, `auditQueue.pruneFailures`).

Rate limits are kept in buckets, one per caller, for ten refusals a minute. A local caller is counted under its peer; a remote caller under the client address nginx passed on in `X-Real-IP` (cleaned, and falling back to the peer when absent). A local bucket past its limit gets `429`. A remote bucket past its limit keeps getting the plain `404` and is not counted further, so traffic from the internet cannot lock out the local caller.

Checking the gate on a server, one curl each (replace the host and socket path):

- The production check, over the unix socket the app listens on: `curl -s -o /dev/null -w "%{http_code}\n" --unix-socket /path/to/taskmanager.sock http://localhost/api/crews`. Expect `401`: the switch is on, a socket path (`SOCKET` or `NITRO_UNIX_SOCKET`, non-blank) or the marker `BLAZE_UNIX_LISTENER=1` is set, and the curl sends no forwarding header, so the call counts as local and the key check ran. Without the switch, or without a socket path or the marker, expect `404`.
- Through the reverse proxy, with no forwarding header at all: `curl -s -o /dev/null -w "%{http_code}\n" https://taskmanager.example.com/api/crews`. Expect `404`: the proxy lines add the headers, so the call is remote and the window is closed. A `401` means that location does not set the lines, so its callers count as local there. Fix the location before the switch stays on.
- Straight to a TCP port, only on a deployment that has one (a node preset or a dev server): `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/crews`. `401` means the loopback peer counted as local.

Deploy note for nginx. Every location that reaches the app needs these two lines (the public vhost, each per-agent loopback vhost, and each tunnel):

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
```

Use `$remote_addr`, not `$proxy_add_x_forwarded_for`. The latter keeps whatever `X-Forwarded-For` the client sent and appends to it, so a client could choose the address the limiter sees. With `$remote_addr` nginx sends the address of the socket it accepted, which the client cannot change.

These two lines are mandatory, not a given. With the switch on and a socket path or the marker set, a request that carries no forwarding header is local, and the gate does not look at the client address. A location that does not set both lines lets internet callers in as local: they skip the closed-window `404` and share the local rate bucket, where they can cause `429`s for the real local caller. Set both lines in every location that reaches the app.

Verify with one curl, through the public address, sending a made-up address:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Real-IP: 192.0.2.99" https://taskmanager.example.com/api/crews
```

It must print `404`. Then open the Crews status as the instance admin (`GET /api/settings/crew-api-window`): the newest audit row's peer must read `unix (client <your public address>)`, not `192.0.2.99`. If it shows `192.0.2.99`, the `X-Real-IP` line is not in that location.

Two more facts for this deploy:

- Requests that reach the app through a loopback vhost, such as a per-agent vhost, carry `X-Real-IP 127.0.0.1`. All of them therefore share the remote bucket `127.0.0.1`. That is intended: they carry a forwarding header, so they are always treated as remote and never pass the gate on their own, and they cannot touch the local bucket.
- The app must listen only through `Bun.serve`. A second listener opened outside it, for example with `node:http` `listen(port)`, opens a TCP path that the gate treats as loopback. Do not add one. Where the hosting platform replaces the TCP port with a unix socket, the gate reads that socket as a unix peer, and counts it as local only with `CREW_API_TRUST_SOCKET=true`.

Under the Bun preset the app is not handed the socket a request came in on, so its peer is read as `unseen`. Bun gives the app a socket object with an empty address and a numeric port (often 0). That object says nothing about the caller, so such a request is `unseen` whatever the port. The peer kinds are: `tcp` (a real address: loopback is local, any other address is remote), `unix` (a node socket with neither address nor port), `unseen` (the Bun case above), and `unknown` (a node socket with a port but no address). `unknown` stays remote always. The peer label appears in the audit rows, so a refused call shows which kind it was. An unseen request counts as local only when three things hold. First, `CREW_API_TRUST_SOCKET` is the literal `true`. Second, the listener is one the operator has named as the socket: either the marker `BLAZE_UNIX_LISTENER=1` is set, or a socket path is set in the environment (`SOCKET` or `NITRO_UNIX_SOCKET`, non-blank). Third, the request carries no forwarding header. A socket path is the operator's statement that this process listens on that unix socket only. The marker is an environment signal: the Blaze preload sets `BLAZE_UNIX_LISTENER=1` once it has wrapped `Bun.serve` onto the socket. Nothing verifies it, and it covers `Bun.serve` only, not any other listener. Then the only callers able to reach the process are processes that can open that socket (root, the app user, nginx). The proxy lines in the deploy note keep internet traffic out of this path, and the `crews:manage` key stays the real check either way.

If the switch is on but neither a socket path nor the marker is set, unseen requests stay remote (the `404`), and the process logs one error line at startup saying so. The process is not stopped. That is the case for the packaged Nix build, which listens on TCP (`HOST`, `PORT`) and has no socket variable. If the switch is on and a socket path or the marker is set, but the marker is not `1`, the process logs one info line: the marker is absent, and the socket path is taken on trust. Other hosts have no marker, so this is information, not an error.

The switch does not judge TCP peers. A loopback TCP peer is local and any other TCP peer is remote, with or without the switch. The switch matters for an unseen peer under Bun: such a process hands its TCP requests to the app as unseen. So on a process that also listens on TCP, with the switch on and a socket path or the marker set, a TCP request that carries no forwarding header counts as local and skips the closed-window `404`. It still needs a `crews:manage` key. Do not set `CREW_API_TRUST_SOCKET=true` on a process that also listens on TCP. If the switch is on, a socket path or the marker is set, and `PORT`, `NITRO_PORT`, `HOST` or `NITRO_HOST` is also set (non-blank), the process logs one warning line. The warning reads only the environment; it cannot see a TCP listener.

The automated tests cover the peer rules with faked requests, not a live Bun server behind nginx, so run these checks once after installing.

## Development

Requirements, either path:

- [Bun 1.3.10 or newer](https://bun.sh/) and Docker with Compose
- Or [Nix with flakes](https://nixos.org/manual/nix/stable/command-ref/new-cli/nix.html) and run `nix develop` instead of the steps below

Install dependencies and prepare local configuration:

```bash
bun install
cp .env.example .env
```

For native development, change `postgres` to `localhost` in `DATABASE_URL` inside `.env`.

Start only PostgreSQL, then run Nuxt with hot reload:

```bash
docker compose up -d postgres
bun run db:push
bun run dev
```

With Nix, `docker compose up -d postgres` becomes `db-start` inside `nix develop`, and `mq-start` starts the broker of the GitHub queue when you need it; the rest is identical.

Open [http://localhost:3000](http://localhost:3000). Run `bun run db:push` again after changing `server/db/schema.ts`.

Useful commands:

```bash
bun run lint          # ESLint
bun run typecheck     # Vue and TypeScript checks
bun run build         # Production build
bun run db:push       # Push server/db/schema.ts to PostgreSQL
```

Database structure is defined only in `server/db/schema.ts`. After changing it, run `bun run db:push`; do not commit generated SQL, snapshots, or migration metadata.

## GitHub deliveries and the queue

**Current state (GH6b).** The webhook publishes each synced GitHub delivery (`issues`, `issue_comment`) to the broker with a publisher confirm, and answers `202` only after the confirm. A consumer in the server applies the queued deliveries, one at a time. The other events (pull requests, checks, workflow runs) still only refresh the linked items in the request. The PM's tools and the `delivery_failed` agent event come with GH6c.
- **Configuration (today)**: `RABBITMQ_URL` (`amqp://user:password@host:5672/vhost`) is read by the queue module when something calls it. The health view shows the queue's state. The webhook's publish and the consumer depend on it.
- **Secrets**: the URL carries the broker password. Logs, events and errors show only the scheme, host, port and vhost, as `amqp://***@host:5672/vhost`. Keep the URL in the environment or an environment file, never in a committed file and never on a command line. The password must be URL-safe (letters and digits, as `openssl rand -hex` gives), or the URL breaks; percent-encode anything else.
- **Topology (declared when the queue first connects, and again after every reconnect; repeating it changes nothing)**: one direct exchange `github.deliveries`; quorum queues `github.deliveries` (the work), `github.deliveries.retry.30s` and `github.deliveries.retry.2m` (a delivery waits there 30 s or 2 min, then returns to the work queue), and `github.deliveries.failed` (no expiry, no limit). `github.deliveries` has a delivery limit of 5, dead-lettering to `failed` with reason `delivery_limit`: a message a dying consumer keeps handing back ends there, not in a loop.
- **Changed since round 1 (the first GH6a commit)**: `github.deliveries` gained `x-delivery-limit` 5 and a dead-letter target `github.deliveries.failed`. Round 1 had neither. A broker that already holds the round-1 queue refuses the new declaration with `PRECONDITION_FAILED`.
- **If the declaration fails**: the health view shows `unavailable` with the failing step, the queue name and the error class and code (for example `github.deliveries: Error PRECONDITION_FAILED`). The log has one line per distinct failure, with no URL and no message text. Requests fail fast and the declaration is retried with backoff (1 s, doubling, up to 30 s). The HTTP 503 that GH6b will answer for GitHub events is the symptom; the log line and the health view name the cause. **Operator fix**: when the arguments changed, delete the old queue and let the server declare it again. Only the queue is lost, and only if it still holds messages, so check the depth first: `rabbitmqctl -p arnotes delete_queue github.deliveries` (dev: `mq-start` does not delete it; run the command by hand). Delete the retry queues the same way when their arguments changed.
- **Reconnects**: the client retries with exponential backoff, from 1 s up to 30 s, with jitter, and resumes its consumers. The log has one line per change of state (connecting, connected, unreachable, reconnected), not one per attempt.
- **Secrets on the broker side**: the image's default guest user is refused from any address but the container's own loopback; mq-start deletes it; the NixOS module deletes it.

*What the webhook and the consumer do (GH6b):*

- The webhook: the body is capped at 2 MB (`413` when larger) and the signature is checked before anything is read. A handled event with no delivery id, or with one that is not letters, digits and dashes of at most 100 characters, is `400`. Over the per-minute limit it is `429`. The publish waits for the broker's confirm: `202` after it; `503` when the broker is unreachable, the confirm does not come, or the server is shutting down; `413` when the queue refuses the size. A synced event with no repository is `202` with nothing queued, logged once a minute.
- The consumer takes one delivery at a time (prefetch 1, one consumer), so deliveries are applied in the order the broker hands them out. On success the applied delivery is recorded in `github_deliveries` and then acked; a redelivery of an applied delivery is acked without work.
- Time limits. One delivery's run (its database calls and its work) has a budget of 60 s. The queue gives the handler 120 s, so the consumer always answers first. Each database call has 30 s. Both can be set with `GITHUB_DELIVERY_BUDGET_MS` and `GITHUB_DELIVERY_ADAPTER_TIMEOUT_MS` (milliseconds); the budget must be the shorter one, or the defaults are used.
- Retries. A failure of the work, of a database call, or a timeout (the budget or the queue's) is transient and takes the same ladder: after the first attempt it waits in `retry30s`, after the second in `retry2m`, each with one more attempt. After the third attempt the delivery is recorded and copied to `failed`. A permanent failure (a body that is not JSON, a board without the column it needs) is recorded and copied at once. A failure that cannot be recorded is retried, never copied without its record.
- The record comes first. `github_delivery_failures` gets a row: state `failed`, the reason cut to 300 characters with no payload text, the attempts, the class, and the raw signed body as `payload`. Then the copy to `failed` is published with confirm, and the original is acked. A crash between these steps is redelivered and ends in the same place.
- Row states: `failed` (waiting for the PM), `retried` (sent again by the PM), `resolved` (applied, after a PM retry or a late success), `discarded` (dropped by the PM with a reason). The row keeps the latest PM action (`handled_by`, `handled_at`, `handled_reason`) and counts the PM's retries in `retried_count`. Every PM action, with its actor and time, is written to the agent audit by the GH6c tools, which is the full trail; there is no history column, by decision. A row left in `retried` (the republish crashed, or never concluded) can be claimed again, or discarded, once its claim is 10 minutes old; the result then says 'claim expired'. A PM retry whose publish is not confirmed gives its count back once; when the broker had taken the publish, the retry may still run, and `retried_count` is then one short. When the record write fails on the last attempt, the row says 'the attempts are used up': the earlier reason is not carried between attempts.
- Given-up attempts and late answers. When an attempt is given up (the queue's timeout, or the budget), the run stops at its next step and writes nothing more. The card syncer stops at its next store call: a call already waiting is left behind, and a store write already running may still finish on its own (the card writes are idempotent); nothing after that call runs. An answer that comes later is decided by the attempt number: before the last attempt, a late success or failure is discarded (the retry copy runs the work again); on the last attempt, a late success is recorded and its row goes to `resolved`, and a late failure is discarded. Each one is one log line with the delivery id.
- A repository whose earlier apply is still running (an orphan of a given-up attempt) is not overlapped: the delivery waits in `retry30s` with the same attempt count, at most 20 times in a row. After that, or once the orphan is older than the hold's maximum age (10 minutes), the attempt counts, so the ladder always ends. A hung orphan costs its repository at most the ladder, not an unbounded wait.
- Order: while a delivery of a repository waits in a retry queue, its later deliveries wait behind it (they are published into the same delay queue and acked). The hold lasts at most 10 minutes. It lives in the server process: after a restart it is forgotten, so a delivery that arrives after the restart can be applied before an older retried one, and the older one can then overwrite the newer content. A timed-out attempt sets no hold either, so the same window applies to it. Idempotence prevents duplicate cards and updates, not that order. Two consumers would not share the hold, so run one server instance.
- Payload retention (the customer's answer, GH6, Q2 and Q3): failed deliveries are kept 30 days, then the stored payload is removed and the metadata row stays; discarded ones follow the same rule. The janitor runs at start and then hourly, and clears the payload once the later of `failed_at` and `handled_at` is 30 days old, in batches of 500. An expired row shows as "payload expired" and cannot be retried.
- Dead-lettered messages without a row (the one known loss). The broker's delivery limit is 5 (`github.deliveries`). From the fourth hand-out on, the consumer writes the row itself and fails the delivery. The row is missing only when the row write fails at the fourth hand-out and again at the fifth, and the retry publish fails each time: the message is requeued both times, and the broker dead-letters it on the next hand-out after the fifth. It then sits in `github.deliveries.failed` with its payload and no row, and the PM's list does not show it. This numbering is the one the code assumes; the broker's count is to be confirmed on the broker run. Operator steps, in this order: check the depth first with `rabbitmqctl -p arnotes list_queues name messages`; read the messages by hand with `rabbitmqadmin -V arnotes get queue=github.deliveries.failed count=5 ackmode=reject_requeue_true` and write their rows by hand; only then purge with `rabbitmqctl -p arnotes purge_queue github.deliveries.failed`. The `-p arnotes` matters: without it the command acts on the default vhost.
- Known at-least-once windows: a crash between a retry publish and the ack leaves a second copy of the retry; a crash between the copy to `failed` and the ack leaves a second copy there.
- Shutdown: the webhook answers `503` as soon as shutdown starts; the consumer stops taking work, waits up to 20 s for the delivery in hand, requeues it if it is unfinished, and then the queue is closed.
- Schema: `github_delivery_failures` is part of `server/db/schema.ts`. This repository has no SQL migration files; the schema reaches the database with `db:push`.

*Next (GH6c):* the PM's tools (list, retry, discard, each audited), the `delivery_failed` agent event to the PM, and a view of the failed queue. Until then the table is the record.

**Development and NixOS (today)**

- `mq-start` in `nix develop` starts a local broker on `127.0.0.1:5672` with a dev user and vhost and prints a dev `RABBITMQ_URL`; `mq-stop` stops it. `services.arnotes.queue.enable = true` runs RabbitMQ on the host: the broker user `arnotes` and its vhost are created by `arnotes-rabbitmq-setup` from a password generated into the state directory. The password is read by the broker from a credential file through `rabbitmqctl eval_file`, so no command line carries it. The setup runs whenever `queue.enable` is set, also with `queue.urlFile`.
- `services.arnotes.queue.urlFile` points at an external broker's URL, as an absolute runtime path, never a store path. Create it so only root can read it (the service reads it as root at start):

  ```bash
  printf 'amqp://arnotes:%s@broker.example.com:5672/arnotes\n' "$(openssl rand -hex 24)" | sudo install -m 0600 /dev/stdin /var/lib/secrets/arnotes-rabbitmq-url
  ```

  Create the same user with the same password on the external broker first.
- Compose: `docker compose` starts a `rabbitmq` service on `127.0.0.1` (AMQP only; the management listener runs inside the container on the compose network and is not published). It needs `RABBITMQ_PASSWORD` in `.env`, with no default; `RABBITMQ_USER`, `RABBITMQ_VHOST` and `RABBITMQ_PORT` are optional. The app's `RABBITMQ_URL` is built from them. The app connects to the broker when the server starts, and keeps retrying while it is down.

**Tests and CI**

- `node --import tsx --test tests/github-delivery-consumer.test.ts` runs the consumer, the failed table and the PM functions on the in-memory queue, with fake rows and a fake ledger. It needs neither a broker nor a database.

- `node --import tsx --test tests/github-delivery-queue.test.ts` (and `bun test tests/github-delivery-queue.test.ts`) runs the queue suite. The RabbitMQ part runs only when `RABBITMQ_URL` is set. It creates its own vhost `arnotes-test-*` through the management API (`RABBITMQ_MANAGEMENT_URL`, default `http://host:15672`) and deletes it at the end, so it never touches the shared vhost. The user in the URL needs the administrator tag. Without a reachable broker and management API the RabbitMQ part is skipped with a message.
- A run that is killed (Ctrl-C, a CI timeout) leaks its `arnotes-test-*` vhosts. Delete them by hand: `rabbitmqctl list_vhosts` and `rabbitmqctl delete_vhost <name>`.
- CI: run the same suite against a broker service container, `rabbitmq:4.3.1-management-alpine`, with `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS` and `RABBITMQ_DEFAULT_VHOST` set from CI secrets. Publish its port, export `RABBITMQ_URL` for that user (the path part is replaced by the test), and run the command under Node and under Bun.

## Architecture

- Nuxt 4 and Vue 3 provide the client and Nitro API server.
- Nuxt UI and Tailwind CSS provide the interface.
- Better Auth handles email/password sessions, passkeys, two-factor, email codes, and optional Discord, GitHub, Google and generic OIDC sign-in.
- Drizzle ORM and PostgreSQL store application data.
- Uploaded files are stored under `data/attachments` and mounted as a Docker volume.
- OpenRouter powers optional user-configured AI actions.
- An MCP server at `/api/mcp` exposes boards to AI agents, authenticated with scoped API keys.

## Marketing Site

The standalone [`index.html`](index.html) is the project marketing page. To publish it with GitHub Pages, set Pages **Source** to **Deploy from a branch**, then select the `main` branch and `/(root)` folder.

## Contributing

Bug reports and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Please report security issues privately according to [SECURITY.md](SECURITY.md).

## License

Taskmanager is available under the [MIT License](LICENSE).
