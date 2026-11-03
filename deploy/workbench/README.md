# Taskmanager under workbench

Runs Taskmanager on a BigBridge workbench machine the way workbench runs its other
services: supervisord keeps it up and nginx serves it at **http://taskmanager.localhost**.
A watcher follows `master` on GitHub and deploys every new commit by itself.

    deploy/workbench/install.sh

Workbench must be running (`workbench start`). The script needs `bun`, `nix`, `git`,
`curl` and `openssl` on the PATH. It can be run again at any time: it keeps the
settings, the database, uploads and releases.

## What runs

| supervisord program | what |
| --- | --- |
| `taskmanager-postgres` | PostgreSQL 16 on `127.0.0.1:5435`, data in `pgdata/` |
| `taskmanager` | the server on `127.0.0.1:3100`, from the release `current` points at |
| `taskmanager-updater` | checks `master` every 5 minutes and deploys it |

Both config files are hand-written, so workbench leaves them alone (it only rewrites
`*.generated.conf`): `data/etc/supervisord.d/taskmanager.conf` and
`data/etc/nginx/sites/taskmanager.conf`. The site answers only this machine.

Everything else lives in `/opt/workbench/data/var/lib/taskmanager`:

| path | what |
| --- | --- |
| `env` | the settings and the two secrets (mode 600). Back the secrets up apart from the database |
| `repo.git` | a bare clone that follows `master` |
| `releases/<commit>` | built releases: the running one and the one before it |
| `current` | link to the running release |
| `state/` | the server's working directory; uploads are in `state/data/` |
| `backups/` | a database dump before every deploy, the last ten |
| `bin/` | the scripts below, copied from this folder |

## A deploy

When `master` moves, `update.sh` builds the new commit in its own release folder, while the
old release keeps serving. If the build works, it backs up the database, pushes the schema,
switches `current` and restarts the server. If the server then does not answer within
two minutes, it switches back. A commit that failed is not tried again until `master`
moves on; `update.sh --force` tries it anyway.

The schema push is `drizzle-kit push`. A change it would have to ask about (a rename, or
a dropped column or table) stops the deploy with a message in the log, and the old release
keeps running. Push that one by hand from the release folder, then run `update.sh --force`.

A release that changes the scripts in this folder installs them, and the watcher restarts
itself. A change to `supervisord.conf`, `nginx.conf` or `install.sh` needs `install.sh` to be
run again.

## Using it

- Sign in at http://taskmanager.localhost with an emailed code. The mail lands in Mailpit,
  http://mailpit.localhost. The first account becomes the instance admin.
- Agents: create a key under **Settings → API keys**. The app shows the full `claude mcp add`
  command for `http://taskmanager.localhost/api/mcp`.
- The crew API only answers a local caller with no proxy in between, so provision crews at
  `http://127.0.0.1:3100` directly, not through nginx.

## Commands

    supervisorctl status | grep taskmanager
    supervisorctl restart taskmanager
    /opt/workbench/data/var/lib/taskmanager/bin/update.sh            # check now
    /opt/workbench/data/var/lib/taskmanager/bin/update.sh --force    # redeploy master

Logs: `/opt/workbench/data/var/log/taskmanager.log`, `taskmanager-updater.log` and
`taskmanager-postgres.log`.

## When the watcher says `Could not resolve host: github.com`

supervisord was started from a terminal or session that has since closed. On macOS its
programs then lose the system's DNS and user lookups: the watcher cannot fetch or run
`bun install`, and `initdb` reports `could not look up effective user ID`. Every other
workbench program under that supervisord is cut off the same way. Restart it from a terminal
of your own, not from an agent's shell, which ends with the agent's session:

    supervisord-stop && workbench start

Until then, `bin/update.sh` run by hand from a terminal deploys as usual.
