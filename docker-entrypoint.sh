#!/bin/sh
set -eu

secret_file="/app/data/.auth-secret"

if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
  if [ ! -s "$secret_file" ]; then
    umask 077
    bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())" > "$secret_file"
  fi
  BETTER_AUTH_SECRET="$(tr -d '\n' < "$secret_file")"
  export BETTER_AUTH_SECRET
fi

secrets_key_file="/app/data/.secrets-key"

if [ -z "${SECRETS_ENCRYPTION_KEY:-}" ]; then
  if [ ! -s "$secrets_key_file" ]; then
    umask 077
    bun -e "console.log(Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''))" > "$secrets_key_file"
  fi
  SECRETS_ENCRYPTION_KEY="$(tr -d '\n' < "$secrets_key_file")"
  export SECRETS_ENCRYPTION_KEY
fi

exec "$@"
