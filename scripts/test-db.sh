#!/usr/bin/env bash
# Local Postgres 16 for tests (no Docker). Usage: scripts/test-db.sh start|stop|reset
# Data dir .tmp/pg, port 54329, superuser "postgres" (trust auth, localhost only).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${TEST_DB_PORT:-54329}"
DB_NAME="armadillo_test"
DATA_DIR="$ROOT/.tmp/pg"
RUN_DIR="$ROOT/.tmp/pgrun"   # unix socket + server log

# initdb/postgres refuse to run as root: drop to the "postgres" OS user (or the first
# unprivileged one available) when we are root.
as_pg() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$PG_OS_USER" -- "$@"
  else
    "$@"
  fi
}

PG_OS_USER=""
if [ "$(id -u)" -eq 0 ]; then
  if id postgres >/dev/null 2>&1; then
    PG_OS_USER=postgres
  else
    useradd --system --no-create-home --shell /usr/sbin/nologin armadillo-pg
    PG_OS_USER=armadillo-pg
  fi
fi

psql_admin() {
  PGOPTIONS="-c client_min_messages=warning" "$PGBIN/psql" -X -q -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 "$@"
}

is_running() {
  [ -f "$DATA_DIR/postmaster.pid" ] && as_pg "$PGBIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1
}

cmd_start() {
  mkdir -p "$ROOT/.tmp" "$RUN_DIR"
  if [ -n "$PG_OS_USER" ]; then
    # postgres must be able to traverse the path down to .tmp
    chown "$PG_OS_USER" "$ROOT/.tmp" "$RUN_DIR"
  fi
  if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
    as_pg "$PGBIN/initdb" -D "$DATA_DIR" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi
  if ! is_running; then
    as_pg "$PGBIN/pg_ctl" -D "$DATA_DIR" -l "$RUN_DIR/postgres.log" -w \
      -o "-p $PGPORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$RUN_DIR -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
      start >/dev/null
  fi
  echo "test db up on 127.0.0.1:$PGPORT"
}

cmd_stop() {
  if [ -f "$DATA_DIR/postmaster.pid" ] && is_running; then
    as_pg "$PGBIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null
  fi
  echo "test db stopped"
}

apply_dir() {
  local dir="$1" f
  [ -d "$dir" ] || return 0
  # sort in the C locale so ordering matches filename order everywhere
  while IFS= read -r f; do
    psql_admin -d "$DB_NAME" -f "$f"
  done < <(find "$dir" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort)
}

cmd_reset() {
  cmd_start
  psql_admin -d postgres -c "drop database if exists $DB_NAME with (force)"
  psql_admin -d postgres -c "create database $DB_NAME"
  apply_dir "$ROOT/supabase/shim"
  apply_dir "$ROOT/supabase/migrations"
  echo "$DB_NAME reset: shim + migrations applied"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  reset) cmd_reset ;;
  *) echo "usage: $0 start|stop|reset" >&2; exit 2 ;;
esac
