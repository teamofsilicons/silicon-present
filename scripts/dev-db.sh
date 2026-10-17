#!/usr/bin/env bash
# Silicon Present's own Postgres 16 cluster for development and tests: .dev/pg on port 5490, trust auth,
# database and role `present`. Never touches any other Postgres (the Carbon's 5444 stays alone).
#
#   scripts/dev-db.sh start     start (creating the cluster on first use)
#   scripts/dev-db.sh stop      stop it
#   scripts/dev-db.sh status    is it running?
#   scripts/dev-db.sh url       print the database URL
#   scripts/dev-db.sh create N  create database N (e.g. present_cli) if missing
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
DATA="$ROOT/.dev/pg"
PORT="${PRESENT_PG_PORT:-5490}"
LOG="$ROOT/.dev/pg.log"

running() { "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }

case "${1:-start}" in
  start)
    mkdir -p "$ROOT/.dev"
    if [ ! -f "$DATA/PG_VERSION" ]; then
      "$PGBIN/initdb" -D "$DATA" -U present --auth=trust --encoding=UTF8 --locale=C >/dev/null
    fi
    if running; then
      echo "Postgres is already running on 127.0.0.1:$PORT ($DATA)."
    else
      "$PGBIN/pg_ctl" -D "$DATA" -l "$LOG" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -w start >/dev/null
      echo "Postgres started on 127.0.0.1:$PORT ($DATA)."
    fi
    "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U present -d postgres -tAc "select 1 from pg_database where datname='present'" | grep -q 1 \
      || "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U present present
    echo "postgres://present@127.0.0.1:$PORT/present"
    ;;
  stop)
    if running; then "$PGBIN/pg_ctl" -D "$DATA" -w stop >/dev/null && echo "Postgres stopped."; else echo "Postgres is not running."; fi
    ;;
  status)
    if running; then echo "running on 127.0.0.1:$PORT"; else echo "not running"; exit 1; fi
    ;;
  url)
    echo "postgres://present@127.0.0.1:$PORT/present"
    ;;
  create)
    name="${2:?usage: scripts/dev-db.sh create <database>}"
    "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U present -d postgres -tAc "select 1 from pg_database where datname='$name'" | grep -q 1 \
      || "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U present "$name"
    echo "postgres://present@127.0.0.1:$PORT/$name"
    ;;
  *)
    echo "usage: scripts/dev-db.sh start|stop|status|url|create <database>" >&2
    exit 2
    ;;
esac
