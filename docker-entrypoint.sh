#!/bin/sh
set -e

if [ ! -f /app/config.json ]; then
  USERNAME="${USERNAME:-admin}"
  PASSWORD="${PASSWORD:-admin}"
  echo '{"username":"'"$USERNAME"'","password":"'"$PASSWORD"'"}' > /app/config.json
  echo "Generated config.json with USERNAME=$USERNAME"
fi

exec "$@"
