#!/usr/bin/env bash
# Starts the release `current` points at; supervisord runs it as the program taskmanager.
# The working directory is state/, so uploads (data/) outlive every release.
set -euo pipefail

TM_HOME=${TM_HOME:-/opt/workbench/data/var/lib/taskmanager}
export PATH="/opt/workbench/profile/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

server="$TM_HOME/current/.output/server/index.mjs"
if [ ! -f "$server" ]; then
  echo "no release is built yet; taskmanager-updater builds the first one and starts this program" >&2
  exit 1
fi

set -a
. "$TM_HOME/env"
set +a
# the crew kit (/crew/kit.tar.gz) is served from the release, not from the working directory
CREW_KIT_DIR=$(readlink "$TM_HOME/current")/crew
export CREW_KIT_DIR
mkdir -p "$TM_HOME/state"
cd "$TM_HOME/state"
exec bun "$server"
