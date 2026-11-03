#!/usr/bin/env bash
# Installs Taskmanager into workbench: http://taskmanager.localhost, its own PostgreSQL and
# a watcher that deploys every new master. Running it again is safe: the env file, the
# database, uploads and releases stay; the scripts and the two config files are refreshed.
set -euo pipefail

WB=/opt/workbench
TM_HOME=${TM_HOME:-$WB/data/var/lib/taskmanager}
REPO_URL=${TM_REPO_URL:-https://github.com/tschallacka/arnotes.git}
HERE=$(cd "$(dirname "$0")" && pwd)
SUPERVISORCTL=$WB/profile/bin/supervisorctl
NGINX=$WB/profile/bin/nginx
NGINX_ARGS=(-c "$WB/data/etc/nginx/nginx.generated.conf" -g "daemon off;" -e /dev/stderr)
export PATH="$WB/profile/bin:/nix/var/nix/profiles/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

die() { echo "install: $*" >&2; exit 1; }

[ -x "$SUPERVISORCTL" ] || die "workbench is not installed at $WB"
[[ $("$SUPERVISORCTL" pid 2> /dev/null) =~ ^[0-9]+$ ]] || die "supervisord is not running: start workbench first (workbench start)"
for tool in bun nix git curl openssl; do
  command -v "$tool" > /dev/null || die "$tool is not on PATH"
done

mkdir -p "$TM_HOME/bin" "$TM_HOME/releases" "$TM_HOME/backups" "$TM_HOME/state" "$WB/data/run/taskmanager" "$WB/data/var/log"

# The copy that follows master; releases are worktrees of it.
if [ ! -d "$TM_HOME/repo.git" ]; then
  git clone --quiet --bare "$REPO_URL" "$TM_HOME/repo.git"
  echo "cloned $REPO_URL"
fi

# PostgreSQL 16 from the nixpkgs this repo pins; the link keeps it from being garbage-collected.
nix build --inputs-from "$HERE/../.." nixpkgs#postgresql_16 --out-link "$TM_HOME/postgresql"

# initdb looks the user up, which a supervisord that outlived its login session cannot do.
if [ ! -f "$TM_HOME/pgdata/PG_VERSION" ]; then
  "$TM_HOME/postgresql/bin/initdb" -D "$TM_HOME/pgdata" -U taskmanager --auth=trust -E UTF8 > /dev/null
  echo "created the database cluster in $TM_HOME/pgdata"
fi

if [ ! -f "$TM_HOME/env" ]; then
  (
    umask 077
    cat > "$TM_HOME/env" << EOF
# Taskmanager under workbench, read by run-server.sh and update.sh. Keep it private.
# Back up the two secrets apart from the database: without SECRETS_ENCRYPTION_KEY
# no stored project secret can be read again. Never change either.
NODE_ENV=production
HOST=127.0.0.1
PORT=3100
BETTER_AUTH_URL=http://taskmanager.localhost
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
SECRETS_ENCRYPTION_KEY=$(openssl rand -hex 32)
DATABASE_URL=postgresql://taskmanager@127.0.0.1:5435/taskmanager
ALLOW_SIGN_UP=true
NUXT_PUBLIC_ALLOW_SIGN_UP=true
NUXT_PUBLIC_PASSKEYS_ENABLED=true
# Sign-in codes go to workbench's Mailpit: http://mailpit.localhost
NUXT_PUBLIC_EMAIL_CODE_ENABLED=true
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM='Taskmanager <taskmanager@localhost>'
EOF
  )
  echo "wrote $TM_HOME/env with new secrets"
fi
chmod 600 "$TM_HOME/env"

for f in update.sh run-server.sh run-postgres.sh; do
  install -m 755 "$HERE/$f" "$TM_HOME/bin/$f"
done

site="$WB/data/etc/nginx/sites/taskmanager.conf"
install -m 644 "$HERE/nginx.conf" "$site"
if ! test=$("$NGINX" "${NGINX_ARGS[@]}" -t 2>&1); then
  rm -f "$site"
  die "nginx refuses the site, so it was taken out again:
$test"
fi
if pid=$(cat "$WB/data/var/run/nginx.pid" 2> /dev/null) && kill -0 "$pid" 2> /dev/null; then
  "$NGINX" "${NGINX_ARGS[@]}" -s reload
fi

install -m 644 "$HERE/supervisord.conf" "$WB/data/etc/supervisord.d/taskmanager.conf"
"$SUPERVISORCTL" update

echo
echo "Installed. The watcher builds the first release now (a few minutes):"
echo "  tail -f $WB/data/var/log/taskmanager-updater.log"
echo "Then open http://taskmanager.localhost; the first account becomes the instance admin."
