# Viero Agent

Viero is an operator-controlled concentrated-liquidity agent for EVM networks. It discovers and screens tokens, verifies Uniswap V3/V4 and PancakeSwap V3 pools on-chain, plans single-sided LP positions, manages open positions with deterministic risk rules, and reports through Telegram. Live transaction signing runs in a separate, hardened signer service.

> **Experimental software:** Automated DeFi execution can lose funds. Review the code and configuration, start in watch mode, use a dedicated wallet with limited funds, and never commit wallet keys or `.env` files.

## Features

- GMGN token discovery and security evidence
- address-based blocked-token registry and durable token memory
- deterministic Stage-1 ranking from token-level volume and liquidity
- DEX Screener, GeckoTerminal, Uniswap GraphQL, and RPC-assisted pool discovery
- on-chain verification for Uniswap V3/V4 and PancakeSwap V3
- USDG/WETH quote-token planning on Robinhood Chain
- configurable spot-divergence, TVL, local-depth, and security gates
- isolated signer over a Unix socket, with transaction simulation and confirmation
- deterministic stop loss, take profit, trailing take profit, range, and timeout management
- exact V3/V4 position and fee enrichment where on-chain evidence is available
- Telegram controls and cycle/position reports
- atomic file repositories or PostgreSQL persistence

The included chain configuration covers Robinhood Chain (`4663`), BNB Smart Chain (`56`), Base (`8453`), and Arc (`5042`). Only enabled chains need RPC endpoints; a Robinhood-only setup needs only `VIERO_RPC_4663`.

## Prerequisites

- Node.js 20 or newer (Node.js 22 recommended)
- npm
- `gmgn-cli` plus your own GMGN API key for live discovery
- PostgreSQL 17 if you choose database persistence; file persistence is supported without it
- a Telegram bot token and operator user ID for Telegram operation
- Linux with systemd for the supplied VPS deployment scripts
- for live execution only: a dedicated EVM private key and, for Relay normalization, your own Relay API key

## Install and build

```sh
git clone https://github.com/pesalxyz/Viero-agent.git
cd Viero-agent
npm ci
cp .env.example .env
# Edit .env and provide your own endpoints and credentials.
npm run typecheck
npm test
npm run build
```

Run the offline demonstration:

```sh
npm run agent:demo
```

Run a preflight check after configuring the environment:

```sh
set -a; . ./.env; set +a
node build/viero/cli.js preflight --chains "${VIERO_CHAINS:-4663}" --config "${VIERO_CONFIG:-config/viero.paper.json}"
```

## Configuration

Copy `.env.example` to `.env`. `.env` is ignored by Git and `.env.example` contains only empty placeholders. The short Robinhood-only setup below is enough for deterministic watch-mode operation:

```sh
cp .env.example .env
# Set GMGN_API_KEY and VIERO_RPC_4663 in .env.
npm run build
VIERO_MODE=watch ./deploy/run-agent.sh
```

Configuration is grouped by when it is needed. The complete reference is in [docs/configuration.md](docs/configuration.md).

### 1. Required

For Robinhood Chain (`4663`), provide `GMGN_API_KEY` and `VIERO_RPC_4663`. Keep `VIERO_CHAINS=4663`, `VIERO_MODE=watch`, and `VIERO_EXECUTION_ENABLED=false` for the safe default. Other chain RPCs are not required unless those chains are enabled.

### 2. Live execution

Live trading additionally requires the protected signer environment, a dedicated wallet key, `VIERO_EXECUTION_ENABLED=true` in both agent and signer environments, and a funded signer wallet. Never put `VIERO_SIGNER_PRIVATE_KEY` in the agent `.env`. Relay is not needed to open or close liquidity; it is only needed for optional post-close normalization swaps.

### 3. Optional features

Telegram, PostgreSQL, Relay normalization, additional chains, and operator overrides are optional. File persistence is the default when `DATABASE_URL` is unset. The legacy indexer is not required and the production installer keeps it stopped and disabled.

### 4. Optional LLM

All `VIERO_LLM_*` variables are optional. Deterministic discovery, screening, ranking, planning, and management do not require an LLM.

### 5. Advanced configuration

Variables with safe defaults include token/pool limits, data paths, policy-file selection, signer socket paths, LLM tuning, and indexer development settings. Change them only when you understand the operational effect; see [docs/configuration.md](docs/configuration.md).

## Local operation

Load `.env`, build, and choose a mode:

```sh
set -a; . ./.env; set +a
npm run build

# Read-only/watch loop
VIERO_MODE=watch ./deploy/run-agent.sh

# Telegram interface
./deploy/run-agent.sh telegram

# Live-capable loop (still subject to execution and control-plane gates)
VIERO_MODE=live ./deploy/run-agent.sh
```

Keep the bot STOPPED until RPC, signer, Telegram allowlist, strategy thresholds, wallet balances, and transaction simulation have all been verified.

## Telegram setup

1. Create a bot with BotFather and obtain a new token.
2. Set `TELEGRAM_BOT_TOKEN` in your local `.env` or `/etc/viero/viero.env`.
3. Set `TELEGRAM_USER_IDS` to the numeric IDs of trusted operators only.
4. Start the Telegram process with `npm run agent:telegram` locally or `systemctl start viero-telegram` on a VPS.
5. Use `/status` before `/start`. `/stop` disables transaction-producing automation; refresh/report operations remain read-only.

Never paste the bot token into source, a unit file, a command line, an issue, or a log.

## Signer setup

The signer is a separate Unix-socket service. On a VPS, keep wallet material in `/etc/viero/signer.env`, owned by `root:viero-signer` with mode `0640` or stricter. The agent environment must not contain the private key.

```sh
sudo install -o root -g viero-signer -m 0640 deploy/signer.env.example /etc/viero/signer.env
sudoedit /etc/viero/signer.env
sudo systemctl restart viero-signer
sudo systemctl status viero-signer --no-pager
```

The service exposes `/health`, `/v1/open`, `/v1/close`, `/v1/claim`, and `/v1/normalize` over `/run/viero-signer/viero.sock`. Close/claim logic is separate from Relay normalization. Review [execution documentation](docs/execution.md) before enabling live execution.

## VPS deployment

Build an immutable release locally:

```sh
npm ci
npm run check
npm run release:viero
```

Copy the generated archive to a supported Ubuntu host, extract it to a temporary directory, then run:

```sh
sudo ./deploy/bootstrap-ubuntu.sh
sudo ./deploy/install-release.sh
sudoedit /etc/viero/viero.env
sudoedit /etc/viero/signer.env
sudo systemctl start viero-agent viero-telegram
```

The installer creates immutable releases under `/opt/viero/releases`, points `/opt/viero/current` at the active release, preserves `/var/lib/viero`, and keeps the obsolete indexer inactive/disabled. The signer is enabled only when live execution is explicitly enabled in both protected environment files. See [docs/deployment.md](docs/deployment.md).

## Operations

```sh
sudo systemctl start viero-agent viero-telegram
sudo systemctl stop viero-agent viero-telegram
sudo systemctl restart viero-agent viero-telegram
sudo systemctl status viero-agent viero-telegram viero-signer --no-pager
sudo journalctl -u viero-agent -u viero-telegram -u viero-signer -f
```

Rollback an installed release:

```sh
sudo /opt/viero/current/deploy/rollback-release.sh
```

## Security

- Never commit `.env`, wallet files, mnemonics, private keys, bot tokens, API keys, transaction journals, or runtime state.
- Use your own authenticated RPC endpoints; no usable RPC URL is bundled.
- Use a dedicated, low-value execution wallet and preserve native gas reserves.
- Keep `/etc/viero/viero.env` and `/etc/viero/signer.env` readable only by their required service accounts.
- Restrict Telegram commands to an explicit numeric user-ID allowlist.
- Run watch mode first and review every configured threshold.
- Rotate any credential that was ever exposed, even if it was later removed from Git.

## Verification

```sh
npm run typecheck
npm test
npm run build
# or all three
npm run check
```

GitHub Actions runs the same checks on pushes and pull requests.

## License

MIT. See [LICENSE](LICENSE).
