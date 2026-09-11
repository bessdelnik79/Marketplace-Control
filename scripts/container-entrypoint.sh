#!/bin/sh
set -eu
postgres_pid=''
app_pid=''
shutdown(){ [ -z "$app_pid" ] || kill -TERM "$app_pid" 2>/dev/null || true; [ -z "$postgres_pid" ] || kill -TERM "$postgres_pid" 2>/dev/null || true; }
trap shutdown INT TERM
docker-entrypoint.sh postgres &
postgres_pid=$!
until pg_isready --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null 2>&1; do
  if ! kill -0 "$postgres_pid" 2>/dev/null; then wait "$postgres_pid"; exit 1; fi
  sleep 1
done
node app/server.mjs &
app_pid=$!
wait "$app_pid"
app_status=$?
kill -TERM "$postgres_pid" 2>/dev/null || true
wait "$postgres_pid" 2>/dev/null || true
exit "$app_status"
