#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  printf 'Run with sudo: sudo %s [--start]\n' "$0" >&2
  exit 77
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
start_service=false
if [[ "${1:-}" == '--start' ]]; then start_service=true; elif [[ -n "${1:-}" ]]; then
  printf 'Usage: sudo %s [--start]\n' "$0" >&2
  exit 64
fi

# A passive release installation must not inherit a scheduled restart from an
# already enabled unit, or swap code underneath a live process. Refuse before
# touching release links, users, units, or persistent directories.
if ! $start_service; then
  for service in viero-agent.service viero-telegram.service viero-signer.service viero-indexer.service; do
    state="$(systemctl show -p ActiveState --value "$service" 2>/dev/null || true)"
    enabled="$(systemctl is-enabled "$service" 2>/dev/null || true)"
    if [[ "$state" != inactive && "$state" != failed && -n "$state" ]] || [[ "$enabled" == enabled ]]; then
      printf 'Passive install requires stopped and disabled services: %s state=%s enabled=%s\n' "$service" "$state" "$enabled" >&2
      exit 78
    fi
  done
fi

for command in node npm systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing %s; run deploy/bootstrap-ubuntu.sh first\n' "$command" >&2
    exit 69
  fi
done
# Installation is separate from activation. Refuse to guess configuration.
for env_file in /etc/viero/viero.env /etc/viero/signer.env; do
  if [[ ! -f "$env_file" ]]; then
    printf 'Missing required configuration %s; provision it before installation.\n' "$env_file" >&2
    exit 78
  fi
  if [[ "$(stat -c '%u' "$env_file")" != 0 ]] || find "$env_file" -perm /027 -print -quit | grep -q .; then
    printf 'Configuration owner/mode is unsafe: %s (require root owner, no group write or world access).\n' "$env_file" >&2
    exit 78
  fi
done
if [[ -e /etc/viero/viero-signer.env ]]; then
  printf 'Review legacy signer environment reference /etc/viero/viero-signer.env before installation.\n' >&2
  exit 78
fi
# Never copy credentials, runtime state, or wallet material from a checkout.
if find "$source_dir" \( -name .git -o -name node_modules -o -name data \) -prune -o -type f \
  \( -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) -o -name '*.key' -o -name '*.pem' \
  -o -name '*private-key*' -o -name '*wallet*.json' -o -name '*.db' -o -name '*.sqlite' \
  -o -name '*.jsonl' -o -name '*.log' \) -print -quit | grep -q .; then
  printf 'Refusing release copy: sensitive/runtime file detected in source tree.\n' >&2
  exit 78
fi
if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 24 || (major === 24 && minor >= 15) ? 0 : 1)"; then
  printf 'Node 24.15 or newer is required\n' >&2
  exit 69
fi
if ! command -v gmgn-cli >/dev/null 2>&1; then
  printf 'gmgn-cli is missing; run deploy/bootstrap-ubuntu.sh first\n' >&2
  exit 69
fi
node "$source_dir/deploy/check-state-schema.mjs" /var/lib/viero /var/lib/viero-signer
if [[ -f /var/lib/viero-signer/operations.db ]]; then
  node "$source_dir/deploy/check-operation-store.mjs" /var/lib/viero-signer/operations.db
fi
if [[ -f /var/lib/viero-signer/relay-operations.db ]]; then
  node "$source_dir/deploy/check-relay-store.mjs" /var/lib/viero-signer/relay-operations.db
fi
if [[ -f /var/lib/viero-signer/transactions.jsonl ]]; then
  disposition_file=/var/lib/viero-signer/legacy-dispositions.json
  if [[ ! -f "$disposition_file" ]]; then
    printf 'Missing required historical disposition for legacy signer journal: %s\n' "$disposition_file" >&2
    exit 78
  fi
  if [[ "$(stat -c '%u' "$disposition_file")" != 0 ]] || find "$disposition_file" -perm /027 -print -quit | grep -q .; then
    printf 'Historical disposition ownership/mode is unsafe: %s\n' "$disposition_file" >&2
    exit 78
  fi
  node "$source_dir/deploy/check-legacy-journal.mjs" /var/lib/viero-signer/transactions.jsonl "$disposition_file"
fi
if [[ ! -f "$source_dir/build/viero/signer-server.js" || ! -f "$source_dir/package-lock.json" ]]; then
  printf 'Built release and package lock are required before installation.\n' >&2
  exit 78
fi

if ! id viero >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/viero --shell /usr/sbin/nologin --user-group viero
fi
if ! id viero-signer >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/viero-signer --shell /usr/sbin/nologin --user-group viero-signer
  usermod -a -G viero viero-signer
fi
install -d -m 0755 /opt/viero/releases
install -d -o viero -g viero -m 0700 /var/lib/viero
install -d -o root -g viero -m 0750 /etc/viero
install -d -o viero-signer -g viero-signer -m 0700 /var/lib/viero-signer

version="$(node -p "require('$source_dir/package.json').version")"
release_id="${version}-$(date -u +%Y%m%dT%H%M%SZ)"
target="/opt/viero/releases/$release_id"
if [[ -e "$target" ]]; then
  printf 'Release already exists: %s\n' "$target" >&2
  exit 73
fi
install -d -m 0755 "$target"
tar -C "$source_dir" --exclude='./.git' --exclude='./node_modules' --exclude='./.env' --exclude='./.env.*' --exclude='./data' \
  --exclude='./logs' --exclude='./backups' --exclude='./dist' --exclude='./docs/thesis' -cf - . | tar -C "$target" -xf -
if [[ -f "$source_dir/.env.example" ]]; then install -m 0644 "$source_dir/.env.example" "$target/.env.example"; fi
# `cp -a source/. target/` can copy the mode of a private staging
# directory onto the release root. Services run as the unprivileged
# `viero` user and must be able to traverse this immutable directory.
chmod 0755 "$target"
rm -rf "$target/node_modules"
(
  cd "$target"
  npm ci --omit=dev --ignore-scripts
)
chown -R root:root "$target"
find "$target/deploy" -type f -name '*.sh' -exec chmod 0755 {} +

install -o root -g root -m 0644 "$target/deploy/viero-agent.service" /etc/systemd/system/viero-agent.service
install -o root -g root -m 0644 "$target/deploy/viero-indexer.service" /etc/systemd/system/viero-indexer.service
install -o root -g root -m 0644 "$target/deploy/viero-telegram.service" /etc/systemd/system/viero-telegram.service
install -o root -g root -m 0644 "$target/deploy/viero-signer.service" /etc/systemd/system/viero-signer.service

# Older deployments used local drop-ins that pinned the agent to Robinhood.
# They are not part of the release and must not override the operator's
# persisted chain selection. Preserve them outside systemd for auditability,
# rather than deleting them, so a future install cannot reactivate the pin.
legacy_dropin_dir=/etc/viero/disabled-dropins
install -d -o root -g root -m 0700 "$legacy_dropin_dir"
for legacy_dropin in \
  /etc/systemd/system/viero-agent.service.d/live-robinhood.conf \
  /etc/systemd/system/viero-agent.service.d/zz-live-robinhood.conf; do
  if [[ -e "$legacy_dropin" || -L "$legacy_dropin" ]]; then
    mv -f "$legacy_dropin" "$legacy_dropin_dir/$(basename "$legacy_dropin").disabled.$release_id"
  fi
done

if [[ -L /opt/viero/current ]]; then
  ln -sfn "$(readlink -f /opt/viero/current)" /opt/viero/previous
fi
ln -sfn "$target" /opt/viero/current.next
mv -Tf /opt/viero/current.next /opt/viero/current
systemctl daemon-reload
live_enabled=false
if grep -Eq '^VIERO_EXECUTION_ENABLED=true$' /etc/viero/signer.env && grep -Eq '^VIERO_EXECUTION_ENABLED=true$' /etc/viero/viero.env; then
  live_enabled=true
fi

if $start_service; then
  # --start is an explicit activation authorization.
  # The legacy full-universe indexer remains disabled only when activation
  # was explicitly requested; a passive install never mutates service state.
  systemctl disable viero-indexer.service 2>/dev/null || true
  systemctl stop viero-indexer.service 2>/dev/null || true
  systemctl enable viero-agent.service viero-telegram.service
  if $live_enabled; then systemctl enable viero-signer.service; fi
  if $live_enabled; then systemctl restart viero-signer.service; else systemctl stop viero-signer.service 2>/dev/null || true; fi
  systemctl restart viero-agent.service viero-telegram.service
  systemctl --no-pager --full status viero-agent.service
  systemctl --no-pager --full status viero-telegram.service
  if $live_enabled; then systemctl --no-pager --full status viero-signer.service; fi
else
  printf 'Installed %s. No service was enabled or started.\n' "$release_id"
  printf 'Review configuration, then authorize activation separately.\n'
fi
