#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  printf 'Run with sudo: sudo %s\n' "$0" >&2
  exit 77
fi
if [[ ! -L /opt/viero/previous ]] || [[ ! -d "$(readlink -f /opt/viero/previous)" ]]; then
  printf 'No previous Viero release is available\n' >&2
  exit 66
fi

current="$(readlink -f /opt/viero/current)"
previous="$(readlink -f /opt/viero/previous)"
ln -sfn "$previous" /opt/viero/current.next
mv -Tf /opt/viero/current.next /opt/viero/current
ln -sfn "$current" /opt/viero/previous
systemctl disable viero-indexer.service 2>/dev/null || true
systemctl stop viero-indexer.service 2>/dev/null || true
systemctl restart viero-agent.service
systemctl --no-pager --full status viero-agent.service
