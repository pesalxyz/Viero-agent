#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

mode="${1:-${VIERO_MODE:-watch}}"
chains="${VIERO_CHAINS:-4663,56,8453,5042}"
token_limit="${VIERO_TOKEN_LIMIT:-3}"
pool_limit="${VIERO_POOL_LIMIT:-10}"
config="${VIERO_CONFIG:-config/viero.paper.json}"

if [[ ! "$chains" =~ ^(4663|56|8453|5042)(,(4663|56|8453|5042))*$ ]]; then
  printf 'Invalid VIERO_CHAINS: %s\n' "$chains" >&2
  exit 64
fi
if [[ ! "$token_limit" =~ ^[1-9][0-9]*$ ]] || (( token_limit > 100 )); then
  printf 'VIERO_TOKEN_LIMIT must be between 1 and 100\n' >&2
  exit 64
fi
if [[ ! "$pool_limit" =~ ^[1-9][0-9]*$ ]] || (( pool_limit > 1000 )); then
  printf 'VIERO_POOL_LIMIT must be between 1 and 1000\n' >&2
  exit 64
fi
if [[ ! -r "$config" ]]; then
  printf 'Viero config is not readable: %s\n' "$config" >&2
  exit 66
fi

case "$mode" in
  preflight)
    exec /usr/bin/node build/viero/cli.js preflight --chains "$chains" --config "$config"
    ;;
  watch)
    exec /usr/bin/node build/viero/cli.js watch --chains "$chains" --config "$config" \
      --token-limit "$token_limit" --pool-limit "$pool_limit"
    ;;
  live)
    exec /usr/bin/node build/viero/cli.js live --chains "$chains" --config "$config" \
      --token-limit "$token_limit" --pool-limit "$pool_limit"
    ;;
  telegram)
    exec /usr/bin/node build/viero/cli.js telegram --chains "$chains" --config "$config" \
      --token-limit "$token_limit" --pool-limit "$pool_limit"
    ;;
  *)
    printf 'Usage: %s [preflight|watch|live|telegram]\n' "$0" >&2
    exit 64
    ;;
esac
