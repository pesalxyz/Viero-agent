#!/usr/bin/env bash
set -Eeuo pipefail
if (( EUID != 0 )); then printf 'Run with sudo: sudo %s DESTINATION\n' "$0" >&2; exit 77; fi
destination="${1:-}"
if [[ -z "$destination" || "$destination" == / || "$destination" == /var/lib || "$destination" == /var/lib/viero || "$destination" == /var/lib/viero-signer ]]; then
  printf 'Usage: sudo %s /var/lib/viero-backups/name\n' "$0" >&2; exit 64
fi
for command in tar sha256sum node systemctl; do command -v "$command" >/dev/null || { printf 'Missing %s\n' "$command" >&2; exit 69; }; done
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for service in viero-agent.service viero-telegram.service viero-signer.service viero-indexer.service; do
  state="$(systemctl show -p ActiveState --value "$service" 2>/dev/null || true)"
  if [[ "$state" != inactive && "$state" != failed && -n "$state" ]]; then
    printf 'Refusing non-quiescent backup: %s is %s\n' "$service" "$state" >&2
    exit 78
  fi
done
if [[ -f /var/lib/viero-signer/operations.db ]]; then
  node "$script_dir/check-operation-store.mjs" /var/lib/viero-signer/operations.db
fi
if [[ -f /var/lib/viero-signer/relay-operations.db ]]; then
  node "$script_dir/check-relay-store.mjs" /var/lib/viero-signer/relay-operations.db
fi
mkdir -p "$destination"
archive="$destination/state-and-journal.tar"
# The signer directory includes operations.db plus its WAL/SHM companions. The
# caller must quiesce writers before invoking this snapshot command.
tar --numeric-owner --xattrs --acls -cf "$archive" -C /var/lib viero -C /var/lib viero-signer
sha256sum "$archive" > "$archive.sha256"
chmod 0600 "$archive" "$archive.sha256"
printf 'Validated state/journal backup: %s\n' "$archive"
