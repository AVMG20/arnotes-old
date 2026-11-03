#!/usr/bin/env bash
# Taskmanager's own PostgreSQL, run by supervisord as taskmanager-postgres. It listens on
# 127.0.0.1:5435 and a socket in /opt/workbench/data/run/taskmanager, with trust auth for
# this machine only. The first start creates the cluster; update.sh creates the database.
set -euo pipefail

TM_HOME=${TM_HOME:-/opt/workbench/data/var/lib/taskmanager}
PG=$TM_HOME/postgresql/bin
PGDATA=$TM_HOME/pgdata
SOCKET=/opt/workbench/data/run/taskmanager

mkdir -p "$SOCKET"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  "$PG/initdb" -D "$PGDATA" -U taskmanager --auth=trust -E UTF8 > /dev/null
fi
exec "$PG/postgres" -D "$PGDATA" -p 5435 -k "$SOCKET" -c listen_addresses=127.0.0.1
