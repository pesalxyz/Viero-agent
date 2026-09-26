#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  printf 'Run with sudo: sudo %s\n' "$0" >&2
  exit 77
fi

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
fi

apt-get update
apt-get install -y ca-certificates curl gnupg

if (( node_major < 20 )); then
  install -d -m 0755 /etc/apt/keyrings
  key_tmp="$(mktemp)"
  trap 'rm -f "$key_tmp"' EXIT
  curl --fail --silent --show-error --location https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key --output "$key_tmp"
  gpg --batch --yes --dearmor --output /etc/apt/keyrings/nodesource.gpg "$key_tmp"
  printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if (( node_major < 20 )); then
  printf 'Node 20 or newer is required; found %s\n' "$(node --version)" >&2
  exit 69
fi

npm install --global gmgn-cli@1.6.6
printf 'Installed %s, npm %s, and %s\n' "$(node --version)" "$(npm --version)" "$(gmgn-cli --version 2>/dev/null || printf 'gmgn-cli')"
