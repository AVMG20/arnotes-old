#!/usr/bin/env bash
# Keeps the workbench copy of Taskmanager on the newest master. A new commit is
# built as a release next to the running one; then the database is backed up,
# the schema pushed, `current` switched and the server restarted. A release that
# does not answer is rolled back and not tried again until master moves on.
#
#   update.sh           check once, deploy when master moved
#   update.sh --watch   check every TM_UPDATE_INTERVAL seconds (300), as supervisord runs it
#   update.sh --force   deploy master even when it runs already or failed before
set -uo pipefail

WB=/opt/workbench
TM_HOME=${TM_HOME:-$WB/data/var/lib/taskmanager}
REPO_URL=${TM_REPO_URL:-https://github.com/tschallacka/arnotes.git}
BRANCH=${TM_BRANCH:-master}
INTERVAL=${TM_UPDATE_INTERVAL:-300}
KEEP_BACKUPS=10
SUPERVISORCTL=$WB/profile/bin/supervisorctl
PG=$TM_HOME/postgresql/bin
PGSOCK=$WB/data/run/taskmanager
PGPORT=5435
export PATH="$WB/profile/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_OPTIONS=--max-old-space-size=6144

WATCH=
FORCE=
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 64 ;;
  esac
done

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

running_sha() {
  [ -L "$TM_HOME/current" ] && basename "$(readlink "$TM_HOME/current")"
}

program_known() {
  "$SUPERVISORCTL" status taskmanager > /dev/null 2>&1
  [ $? -ne 4 ] # 4: no such process
}

restart_server() {
  program_known || return 0
  "$SUPERVISORCTL" restart taskmanager > /dev/null
}

healthy() {
  local port
  port=$(sed -n 's/^PORT=//p' "$TM_HOME/env")
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:${port:-3100}/login" && return 0
    sleep 2
  done
  return 1
}

ensure_database() {
  for _ in $(seq 1 30); do
    "$PG/pg_isready" -q -h "$PGSOCK" -p "$PGPORT" && break
    sleep 2
  done
  "$PG/pg_isready" -q -h "$PGSOCK" -p "$PGPORT" || { log "PostgreSQL is not answering on $PGSOCK"; return 1; }
  if [ "$("$PG/psql" -h "$PGSOCK" -p "$PGPORT" -U taskmanager -d postgres -tAc "select 1 from pg_database where datname='taskmanager'")" != 1 ]; then
    "$PG/createdb" -h "$PGSOCK" -p "$PGPORT" -U taskmanager taskmanager || return 1
    log "created the taskmanager database"
  fi
}

backup_database() {
  local sha=$1 file
  mkdir -p "$TM_HOME/backups"
  file="$TM_HOME/backups/$(date +%Y%m%d-%H%M%S)-before-${sha:0:12}.dump"
  "$PG/pg_dump" -h "$PGSOCK" -p "$PGPORT" -U taskmanager -Fc taskmanager > "$file" || { rm -f "$file"; return 1; }
  ls -1t "$TM_HOME"/backups/*.dump | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -f "$old"; done
  log "backed up the database to $file"
}

# drizzle-kit exits 0 when it stops at a question it cannot ask, so read what it said.
push_schema() {
  local rel=$1 out
  out=$(cd "$rel" && set -a && . "$TM_HOME/env" && set +a && bunx drizzle-kit push --force < /dev/null 2>&1)
  printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | tail -n 5
  case "$out" in
    *"Changes applied"*|*"No changes detected"*) return 0 ;;
    *) log "the schema push did not finish (a rename or a drop needs an answer?): push it by hand from $rel"; return 1 ;;
  esac
}

# A release that changed these scripts installs them; the watcher then restarts itself.
install_scripts() {
  local rel=$1 changed=
  for f in update.sh run-server.sh run-postgres.sh; do
    if ! cmp -s "$rel/deploy/workbench/$f" "$TM_HOME/bin/$f"; then
      cp "$rel/deploy/workbench/$f" "$TM_HOME/bin/$f" && chmod 755 "$TM_HOME/bin/$f" && changed=1
    fi
  done
  [ -n "$changed" ]
}

remove_release() {
  git -C "$TM_HOME/repo.git" worktree remove --force "$1" 2> /dev/null || rm -rf "$1"
  git -C "$TM_HOME/repo.git" worktree prune
}

prune_releases() {
  local keep=("$(readlink "$TM_HOME/current")" "$1")
  for rel in "$TM_HOME"/releases/*/; do
    rel=${rel%/}
    [[ " ${keep[*]} " == *" $rel "* ]] || remove_release "$rel"
  done
}

deploy() {
  git -C "$TM_HOME/repo.git" fetch --quiet origin "+refs/heads/$BRANCH:refs/heads/$BRANCH" || { log "could not fetch $BRANCH from $REPO_URL"; return 1; }
  local sha running rel previous
  sha=$(git -C "$TM_HOME/repo.git" rev-parse "refs/heads/$BRANCH")
  running=$(running_sha)
  rel="$TM_HOME/releases/$sha"
  if [ -z "$FORCE" ]; then
    [ "$sha" = "$running" ] && return 0
    [ -e "$rel.failed" ] && return 0
  fi

  log "$BRANCH is at ${sha:0:12}, running ${running:-nothing}; building it"
  [ -d "$rel" ] && remove_release "$rel"
  git -C "$TM_HOME/repo.git" worktree add --quiet --detach "$rel" "$sha" || return 1
  if ! (cd "$rel" && bun install --frozen-lockfile && bun run build); then
    log "the build of ${sha:0:12} failed; staying on ${running:-nothing}"
    touch "$rel.failed"; remove_release "$rel"; return 1
  fi

  ensure_database || return 1
  backup_database "$sha" || { log "the backup failed; not deploying"; return 1; }
  push_schema "$rel" || { touch "$rel.failed"; return 1; }

  local scripts_changed=
  install_scripts "$rel" && scripts_changed=1

  previous=$(readlink "$TM_HOME/current" 2> /dev/null)
  ln -sfn "$rel" "$TM_HOME/current"
  restart_server
  if program_known && ! healthy; then
    log "${sha:0:12} does not answer; going back to ${running:-nothing}"
    touch "$rel.failed"
    if [ -n "$previous" ]; then ln -sfn "$previous" "$TM_HOME/current"; restart_server; fi
    return 1
  fi
  rm -f "$rel.failed"
  log "running ${sha:0:12}"
  prune_releases "$previous"

  if [ -n "$scripts_changed" ] && [ -n "$WATCH" ]; then
    log "the deploy scripts changed; restarting the watcher"
    exec "$TM_HOME/bin/update.sh" --watch
  fi
}

once() {
  mkdir "$TM_HOME/run.update.lock" 2> /dev/null || { log "another update is running"; return 0; }
  deploy
  local status=$?
  rmdir "$TM_HOME/run.update.lock"
  return $status
}

if [ -n "$WATCH" ]; then
  rmdir "$TM_HOME/run.update.lock" 2> /dev/null # left by a watcher that was stopped mid-deploy
  log "watching $BRANCH of $REPO_URL every ${INTERVAL}s"
  while true; do
    once
    FORCE=
    sleep "$INTERVAL"
  done
fi
once
