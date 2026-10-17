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
for env_file in /etc/viero/viero.env /etc/viero/signer.env; do
  if [[ ! -f "$env_file" ]]; then printf 'Missing required configuration %s; refusing rollback\n' "$env_file" >&2; exit 78; fi
done

current="$(readlink -f /opt/viero/current)"
previous="$(readlink -f /opt/viero/previous)"
if [[ ! -f "$current/deploy/check-state-schema.mjs" || ! -f "$current/deploy/backup-state.sh"
  || ! -f "$previous/deploy/check-state-schema.mjs" ]]; then
  printf 'Rollback safety tooling missing from current release; refusing rollback\n' >&2
  exit 78
fi
for service in viero-agent.service viero-telegram.service viero-signer.service viero-indexer.service; do
  state="$(systemctl show -p ActiveState --value "$service" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "$service" 2>/dev/null || true)"
  if [[ "$state" != inactive && "$state" != failed && -n "$state" ]] || [[ "$enabled" == enabled ]]; then
    printf 'Rollback requires stopped and disabled services: %s state=%s enabled=%s\n' "$service" "$state" "$enabled" >&2
    exit 78
  fi
done
node "$current/deploy/check-state-schema.mjs" /var/lib/viero /var/lib/viero-signer
node "$previous/deploy/check-state-schema.mjs" /var/lib/viero /var/lib/viero-signer
if [[ -f /var/lib/viero-signer/operations.db ]]; then
  [[ -f "$previous/deploy/check-operation-store.mjs" ]] || { printf 'Rollback target cannot validate signer operation schema\n' >&2; exit 78; }
  node "$previous/deploy/check-operation-store.mjs" /var/lib/viero-signer/operations.db
fi
if [[ -f /var/lib/viero-signer/relay-operations.db ]]; then
  [[ -f "$previous/deploy/check-relay-store.mjs" ]] || { printf 'Rollback target cannot validate Relay operation schema\n' >&2; exit 78; }
  node "$previous/deploy/check-relay-store.mjs" /var/lib/viero-signer/relay-operations.db
fi
backup_root="/var/lib/viero-backups"
install -d -m 0700 "$backup_root"
"$current/deploy/backup-state.sh" "$backup_root/rollback-$(date -u +%Y%m%dT%H%M%SZ)"
ln -sfn "$previous" /opt/viero/current.next
mv -Tf /opt/viero/current.next /opt/viero/current
ln -sfn "$current" /opt/viero/previous
systemctl daemon-reload
# Services were verified stopped/disabled before rollback and are left untouched.
printf 'Rolled back to %s; all Viero services remain stopped and disabled.\n' "$previous"
