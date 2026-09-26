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

for command in node npm systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing %s; run deploy/bootstrap-ubuntu.sh first\n' "$command" >&2
    exit 69
  fi
done
node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if (( node_major < 20 )); then
  printf 'Node 20 or newer is required\n' >&2
  exit 69
fi
if ! command -v gmgn-cli >/dev/null 2>&1; then
  printf 'gmgn-cli is missing; run deploy/bootstrap-ubuntu.sh first\n' >&2
  exit 69
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
cp -a "$source_dir/." "$target/"
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

if [[ ! -e /etc/viero/viero.env ]]; then
  install -o root -g viero -m 0640 "$target/deploy/viero.env.example" /etc/viero/viero.env
  printf 'Created /etc/viero/viero.env; set GMGN_API_KEY before starting the service.\n'
fi
if [[ ! -e /etc/viero/signer.env ]]; then
  install -o root -g viero-signer -m 0640 "$target/deploy/signer.env.example" /etc/viero/signer.env
  printf 'Created /etc/viero/signer.env; live execution remains disabled.\n'
fi
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
# The legacy full-universe indexer is intentionally not part of the runtime.
# Keep it disabled across every release installation; tolerate hosts where the
# unit has already been removed.
systemctl disable viero-indexer.service 2>/dev/null || true
systemctl stop viero-indexer.service 2>/dev/null || true
systemctl enable viero-agent.service viero-telegram.service
live_enabled=false
if grep -Eq '^VIERO_EXECUTION_ENABLED=true$' /etc/viero/signer.env && grep -Eq '^VIERO_EXECUTION_ENABLED=true$' /etc/viero/viero.env; then
  live_enabled=true
  systemctl enable viero-signer.service
fi

if $start_service; then
  if $live_enabled; then systemctl restart viero-signer.service; else systemctl stop viero-signer.service 2>/dev/null || true; fi
  systemctl restart viero-agent.service viero-telegram.service
  systemctl --no-pager --full status viero-agent.service
  systemctl --no-pager --full status viero-telegram.service
  if $live_enabled; then systemctl --no-pager --full status viero-signer.service; fi
else
  printf 'Installed %s. Configure /etc/viero/viero.env, then run:\n' "$release_id"
  printf '  sudo systemctl start viero-agent viero-telegram\n'
fi
