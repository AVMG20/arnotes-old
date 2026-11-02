{
  pkgs,
}:
let
  inherit (pkgs) bun nodejs postgresql_16 rabbitmq-server;
  pg = "${postgresql_16}/bin";
  rmq = "${rabbitmq-server}/sbin";
  dataDir = "$PWD/.nix-data";

  db-start = pkgs.writeShellScriptBin "db-start" ''
    set -euo pipefail
    root="${dataDir}"
    pgdata="$root/pgdata"
    socket="$root/socket"
    port="''${POSTGRES_PORT:-5432}"
    mkdir -p "$root" "$socket"
    if [ ! -f "$pgdata/PG_VERSION" ]; then
      ${pg}/initdb -D "$pgdata" -U arnotes --auth=trust >/dev/null
    fi
    if ! ${pg}/pg_ctl -D "$pgdata" status >/dev/null 2>&1; then
      ${pg}/pg_ctl -D "$pgdata" -l "$root/postgres.log" -o "-p $port -k $socket -c listen_addresses=localhost" start >/dev/null
    fi
    if ! ${pg}/psql -h "$socket" -p "$port" -U arnotes -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='arnotes'" | grep -q 1; then
      ${pg}/createdb -h "$socket" -p "$port" -U arnotes arnotes
    fi
    echo "PostgreSQL ready on 127.0.0.1:$port (DATABASE_URL=postgresql://arnotes:arnotes@localhost:$port/arnotes)"
  '';

  db-stop = pkgs.writeShellScriptBin "db-stop" ''
    set -euo pipefail
    pgdata="${dataDir}/pgdata"
    if [ -f "$pgdata/PG_VERSION" ]; then
      ${pg}/pg_ctl -D "$pgdata" stop -m fast >/dev/null 2>&1 || true
    fi
    echo "PostgreSQL stopped"
  '';

  # RabbitMQ for the GitHub delivery queue. Dev only: it listens on 127.0.0.1 (AMQP and the management
  # UI), the default guest account is deleted, and a dev user and vhost are created with a fixed dev
  # password, as the PostgreSQL role is. Safe to run twice.
  mq-start = pkgs.writeShellScriptBin "mq-start" ''
    set -euo pipefail
    root="${dataDir}/rabbitmq"
    port="''${RABBITMQ_PORT:-5672}"
    user="arnotes"
    password="arnotes"
    vhost="arnotes"
    mkdir -p "$root/mnesia" "$root/log"
    printf '%s\n' "listeners.tcp.default = 127.0.0.1:$port" "management.tcp.ip = 127.0.0.1" "management.tcp.port = 15672" > "$root/rabbitmq.conf"
    printf '%s\n' "[rabbitmq_management]." > "$root/enabled_plugins"
    export RABBITMQ_NODENAME="arnotes-dev@localhost"
    export RABBITMQ_MNESIA_BASE="$root/mnesia"
    export RABBITMQ_LOG_BASE="$root/log"
    export RABBITMQ_CONFIG_FILE="$root/rabbitmq"
    export RABBITMQ_ENABLED_PLUGINS_FILE="$root/enabled_plugins"
    if ! ${rmq}/rabbitmqctl -q status >/dev/null 2>&1; then
      ${rmq}/rabbitmq-server -detached >/dev/null
    fi
    for _ in $(seq 1 120); do ${rmq}/rabbitmqctl -q await_startup >/dev/null 2>&1 && break; sleep 1; done
    ${rmq}/rabbitmqctl -q delete_user guest >/dev/null 2>&1 || true
    # Dev only: the dev password is passed on the command line here; the NixOS module reads its password inside the broker instead.
    ${rmq}/rabbitmqctl -q add_user "$user" "$password" >/dev/null 2>&1 \
      || ${rmq}/rabbitmqctl -q change_password "$user" "$password" >/dev/null
    ${rmq}/rabbitmqctl -q add_vhost "$vhost" >/dev/null 2>&1 || true
    ${rmq}/rabbitmqctl -q set_permissions -p "$vhost" "$user" ".*" ".*" ".*" >/dev/null
    ${rmq}/rabbitmqctl -q set_user_tags "$user" administrator >/dev/null
    echo "RabbitMQ ready on 127.0.0.1:$port (RABBITMQ_URL=amqp://$user:$password@127.0.0.1:$port/$vhost)"
    echo "  management: http://127.0.0.1:15672 (user $user, dev password $password)"
  '';

  mq-stop = pkgs.writeShellScriptBin "mq-stop" ''
    set -euo pipefail
    root="${dataDir}/rabbitmq"
    export RABBITMQ_NODENAME="arnotes-dev@localhost"
    export RABBITMQ_MNESIA_BASE="$root/mnesia"
    export RABBITMQ_LOG_BASE="$root/log"
    ${rmq}/rabbitmqctl -q -t 60 stop >/dev/null 2>&1 || true
    echo "RabbitMQ stopped"
  '';
in
pkgs.mkShell {
  packages = [
    bun
    nodejs
    postgresql_16
    rabbitmq-server
    db-start
    db-stop
    mq-start
    mq-stop
  ];

  shellHook = ''
    echo "Taskmanager development shell"
    echo "  db-start            start a local PostgreSQL on port 5432"
    echo "  db-stop             stop it again"
    echo "  mq-start            start a local RabbitMQ on 127.0.0.1:5672 and print its RABBITMQ_URL"
    echo "  mq-stop             stop it again"
    echo "  bun install         install dependencies"
    echo "  bun run db:push     push the schema to PostgreSQL"
    echo "  bun run dev         run the dev server with hot reload"
  '';
}