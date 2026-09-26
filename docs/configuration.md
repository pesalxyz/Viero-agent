# Viero configuration reference

`.env.example` is intentionally short. Copy it to `.env`, then add only the
features and chains you use. Empty values are placeholders; supply your own
credentials and RPC URLs.

## Required

For a Robinhood Chain (`4663`) watch-mode installation:

| Variable | Meaning |
| --- | --- |
| `GMGN_API_KEY` | GMGN credential for Hot Search and token-security data. |
| `VIERO_RPC_4663` | One or more comma-separated RPC URLs. |
| `VIERO_CHAINS` | Enabled chain IDs; use `4663` for the minimal setup. |
| `VIERO_MODE` | Use `watch` for read-only operation. |
| `VIERO_EXECUTION_ENABLED` | Keep `false` until live execution is deliberately enabled. |

The other chain RPC variables are not required unless their chain IDs are
added to `VIERO_CHAINS`. `VIERO_GMGN_BIN` defaults to `gmgn-cli`.

## Live execution

Live execution requires all of the following:

- `VIERO_MODE=live` and `VIERO_EXECUTION_ENABLED=true` in the agent environment;
- the same execution flag enabled in the protected signer environment;
- `VIERO_SIGNER_PRIVATE_KEY` in the signer environment only;
- `VIERO_SIGNER_SOCKET` pointing to the signer Unix socket;
- a dedicated wallet with native gas and the required quote-token balance.

The agent never needs to read the private key. Keep signer secrets in
`/etc/viero/signer.env` on a VPS, with restrictive ownership and permissions.
`VIERO_SIGNER_TX_JOURNAL` controls the signer journal path.

## Optional features

### Telegram

`TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_IDS` are required only when running the
Telegram service. The allowlist contains numeric Telegram user IDs, not names.

### PostgreSQL

Set `DATABASE_URL` to use PostgreSQL persistence. If it is omitted, Viero uses
atomic file persistence under `VIERO_DATA_DIR` (default `data/viero`).
`TEST_DATABASE_URL` is used only by database tests.

### Relay normalization

`RELAY_API_KEY` is required only for optional post-close residual normalization
swaps. Relay is not required for discovery, planning, opening liquidity, or
closing liquidity.

### Additional chains

Add the chain ID to `VIERO_CHAINS` and provide its RPC variable:

- `VIERO_RPC_56` — BNB Smart Chain
- `VIERO_RPC_8453` — Base
- `VIERO_RPC_5042` — Arc

## Optional LLM

LLM analysis is optional. Deterministic discovery, economic/security screening,
Stage-1 ranking, planning, and position management do not require an LLM.

| Variable | Default / purpose |
| --- | --- |
| `VIERO_LLM_ENABLED` | `false`; enable optional analysis features. |
| `VIERO_LLM_BASE_URL` | Empty; OpenAI-compatible endpoint when enabled. |
| `VIERO_LLM_API_KEY` | Empty; provider credential. |
| `VIERO_LLM_MODEL` | Provider model name. |
| `VIERO_LLM_MODEL_SCREENER` | Optional screener-role override. |
| `VIERO_LLM_MODEL_MANAGER` | Optional manager-role override. |
| `VIERO_LLM_MODEL_GENERAL` | Optional general-role override. |
| `VIERO_LLM_TEMPERATURE` | `0.2`. |
| `VIERO_LLM_MAX_TOKENS` | `1024`. |
| `VIERO_LLM_TIMEOUT_MS` | `90000`. |

## Advanced configuration

These variables already have safe defaults and normally do not need editing:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIERO_CONFIG` | `config/viero.paper.json` | Policy/configuration file. |
| `VIERO_DATA_DIR` | `data/viero` | File persistence directory. |
| `VIERO_TOKEN_LIMIT` | `50` | Discovery token limit. |
| `VIERO_POOL_LIMIT` | `10` | Pool shortlist limit. |
| `VIERO_TOKEN_MEMORY_PATH` | `data/viero/token-memory.json` | Token-memory state. |
| `VIERO_BLOCKED_TOKENS_PATH` | `data/viero/blocked-tokens.json` | Manual blocked-token state. |
| `VIERO_SIGNER_SOCKET` | `/run/viero-signer/viero.sock` | Agent/signer IPC socket. |
| `VIERO_SKIP_GMGN_PREFLIGHT` | `0` | Operator-only preflight behavior. |

The `VIERO_INDEXER_*` variables are legacy development settings. The production
installer keeps `viero-indexer.service` disabled and inactive; token-first
discovery and lightweight position management do not require it.

## Security rules

Never commit `.env`, private keys, mnemonics, Telegram tokens, GMGN/API keys,
Relay keys, transaction journals, or runtime state. Do not put signer secrets on
the command line or in the agent environment.
