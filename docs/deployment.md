# VPS deployment

Viero releases are built locally, installed under `/opt/viero/releases`, and selected through `/opt/viero/current`. Persistent state and protected environment files live outside the release tree.

## Build a release

```sh
npm ci
npm run check
npm run release:viero
```

Copy `dist/viero-agent-*.tar.gz` to the host, extract it to a temporary directory, and bootstrap/install as root:

```sh
mkdir -p /tmp/viero-release
tar -xzf /tmp/viero-agent-*.tar.gz -C /tmp/viero-release --strip-components=1
sudo /tmp/viero-release/deploy/bootstrap-ubuntu.sh
sudo /tmp/viero-release/deploy/install-release.sh
```

The installer creates protected examples at `/etc/viero/viero.env` and `/etc/viero/signer.env` if they do not exist. Supply your own GMGN credential, Telegram token, allowlisted user IDs, and RPC URLs. Wallet and Relay credentials belong only in `signer.env`.

```sh
sudoedit /etc/viero/viero.env
sudoedit /etc/viero/signer.env
sudo /opt/viero/current/deploy/run-agent.sh preflight
sudo systemctl start viero-agent viero-telegram
```

The legacy indexer is deliberately stopped and disabled on every installation. Token-first pool discovery and lightweight position management do not require it.

## Live execution

Start in `VIERO_MODE=watch` with `VIERO_EXECUTION_ENABLED=false`. Before enabling execution, review the strategy configuration, confirm the signer wallet and native gas reserve, test simulation, and verify Telegram operator access.

Live execution requires `VIERO_EXECUTION_ENABLED=true` in both protected environment files. Only `/etc/viero/signer.env` should contain `VIERO_SIGNER_PRIVATE_KEY` and `RELAY_API_KEY`.

```sh
sudo systemctl restart viero-signer viero-agent viero-telegram
sudo systemctl status viero-signer viero-agent viero-telegram --no-pager
```

The Telegram bot control state is independent of the process state. Starting a systemd service does not authorize writes; use `/status` and leave the bot STOPPED until ready.

## Operations

```sh
sudo systemctl status viero-agent viero-telegram viero-signer --no-pager
sudo journalctl -u viero-agent -u viero-telegram -u viero-signer -f
sudo systemctl restart viero-agent viero-telegram
sudo systemctl stop viero-agent viero-telegram viero-signer
systemctl is-enabled viero-indexer.service
systemctl is-active viero-indexer.service
```

The expected indexer results are `disabled` and `inactive`.

## Rollback

The previous immutable release is retained at `/opt/viero/previous`:

```sh
sudo /opt/viero/current/deploy/rollback-release.sh
```

Rollback does not replace `/etc/viero` or `/var/lib/viero`.

## Filesystem and secrets

- `/etc/viero/viero.env`: `root:viero`, mode `0640`
- `/etc/viero/signer.env`: `root:viero-signer`, mode `0640` or stricter
- `/var/lib/viero`: agent runtime state, mode `0700`
- `/var/lib/viero-signer`: signer journal, mode `0700`
- `/run/viero-signer/viero.sock`: signer Unix socket

Never copy a local `.env`, wallet file, transaction journal, runtime database, or API key into a release archive or Git repository.
