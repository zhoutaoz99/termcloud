#!/bin/sh
set -e

USERS="${USERS:-admin:admin}"
printf '{"users":[' > /app/config.json
first=1
IFS=','
for pair in $USERS; do
  username="${pair%%:*}"
  password="${pair#*:}"
  if [ -z "$username" ] || [ -z "$password" ]; then
    echo "Invalid USERS format. Expected user1:pass1,user2:pass2"
    exit 1
  fi
  if [ $first -eq 0 ]; then
    printf ',' >> /app/config.json
  fi
  printf '{"username":"%s","password":"%s"}' "$username" "$password" >> /app/config.json
  first=0
done
printf ']}' >> /app/config.json
echo "Generated config.json with $(echo "$USERS" | tr ',' '\n' | wc -l | tr -d ' ') user(s)"

exec "$@"
