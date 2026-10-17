# Viero Phase 4.3 Configuration Dependency Matrix

Status: **AUDIT ONLY** (2026-10-17). Values and secrets were not read.

## Environment-file graph

| Consumer | Unit / entry point | Environment files | Required for safe stopped install |
|---|---|---|---|
| Agent | `deploy/viero-agent.service` → `deploy/run-agent.sh` → `src/viero/cli.ts` | `/etc/viero/viero.env` | File must exist before activation; no secret value was created in this audit. |
| Telegram | `deploy/viero-telegram.service` → `src/viero/cli.ts telegram` | `/etc/viero/viero.env` | Telegram credentials are required only to receive/send Telegram updates. |
| Signer | `deploy/viero-signer.service` → `src/viero/execution/signerServer.ts` | `/etc/viero/viero.env`, `/etc/viero/signer.env`; VPS drop-in additionally references `/etc/viero/viero-signer.env` | All referenced files must be reviewed and present before enabling the signer. |
| Indexer | `deploy/viero-indexer.service` | `/etc/viero/viero.env` | Intentionally disabled in production; no configuration is needed while disabled. |

The three files were **absent on the inspected VPS**. They are not interchangeable:
the signer key and journal belong in signer scope, while agent/Telegram configuration
belongs in the general file. The extra `viero-signer.env` reference is a deployed
drop-in concern and is not represented by the repository's main signer unit; it must
be removed or deliberately provisioned in a separately authorized change.

## Variable matrix

| Variable | Consumer | Classification | Contract / safe state |
|---|---|---|---|
| `VIERO_CHAINS` | Agent, Telegram | REQUIRED | Selected comma-separated chain IDs; every selected chain needs an RPC. |
| `VIERO_RPC_<chainId>` | Agent, Telegram, signer clients | REQUIRED (per enabled chain) | Real endpoint supplied by operator; never commit or print it. |
| `GMGN_API_KEY` | Agent preflight/discovery | REQUIRED for normal autonomous discovery | Keep empty only when an explicitly reviewed `VIERO_SKIP_GMGN_PREFLIGHT=1` path is used. |
| `VIERO_GMGN_BIN` | Agent | OPTIONAL | Defaults to `gmgn-cli`. |
| `VIERO_SKIP_GMGN_PREFLIGHT` | Agent | CONDITIONAL | Operator override; should remain `0` for normal production readiness. |
| `VIERO_MODE` | Agent unit/launcher | REQUIRED | `watch`/live mode is not an execution authorization by itself. |
| `VIERO_CONFIG` | Agent | REQUIRED | Points to deterministic strategy configuration. |
| `VIERO_DATA_DIR` | Agent/storage | REQUIRED in deployment | `/var/lib/viero`; persistent state must be owned by `viero`. |
| `VIERO_TOKEN_LIMIT`, `VIERO_POOL_LIMIT` | Agent | OPTIONAL | Bounded discovery limits with code defaults. |
| `VIERO_EXECUTION_ENABLED` | Agent and signer | CONDITIONAL | Must be `false` for the default safe-stopped target; true requires separate authorization in both scopes. |
| `VIERO_SIGNER_SOCKET` | Agent/signer | CONDITIONAL | Defaults to `/run/viero-signer/viero.sock`; paths must match. |
| `VIERO_SIGNER_PRIVATE_KEY` | Signer only | CONDITIONAL / SECRET | Required only for intentionally enabled live execution. Never place in agent/Telegram env or source. |
| `VIERO_SIGNER_TX_JOURNAL` | Signer | OPTIONAL (deployment default) | `/var/lib/viero-signer/transactions.jsonl`; journal must not be discarded during rollback. |
| `RELAY_API_KEY` | Post-close normalization | CONDITIONAL / SECRET | Only required when Relay normalization/autoswap is enabled. |
| `TELEGRAM_BOT_TOKEN` | Telegram | CONDITIONAL / SECRET | Required to run Telegram service; no token was read. |
| `TELEGRAM_USER_IDS` | Telegram | CONDITIONAL | Restricts command authorization. |
| `VIERO_LLM_ENABLED` | Telegram optional features | OPTIONAL | Must remain explicitly false/unconfigured for deterministic operation; no LLM is required for live or slash-command functionality. |
| `VIERO_LLM_BASE_URL`, `VIERO_LLM_API_KEY`, model/temperature/token/timeout vars | Optional LLM client | CONDITIONAL / SECRET where applicable | Used only if optional LLM is enabled; missing credentials must fail closed for that feature, not block deterministic startup. |
| `VIERO_INDEXER_DISABLE` | Legacy indexer | CONDITIONAL / LEGACY | Keep `1`; indexer remains disabled. |
| `VIERO_INDEXER_<chain>`, `VIERO_INDEXER_START_<chain>` | Indexer | DEPRECATED while disabled | Not needed by token-first runtime; do not activate the indexer to satisfy them. |
| `VIERO_INDEXER_HOST`, `VIERO_INDEXER_PORT`, `VIERO_INDEXER_DATA_DIR` | Indexer | DEPRECATED while disabled | Only relevant to an explicitly approved indexer deployment. |
| `VIERO_EVIDENCE_CACHE_FILE` | Evidence cache | OPTIONAL | Use a persistent path only after schema/ownership review. |
| `VIERO_TOKEN_MEMORY_PATH`, `VIERO_BLOCKED_TOKENS_PATH` | Token memory/blacklist | OPTIONAL | Defaults under persistent state; preserve during release changes. |

## Configuration blockers and remediation

1. Do not populate the missing files with guesses. Provision them from an
   operator-supplied secret-management step, with root ownership and restrictive
   modes, only after the release artifact and state backup gates pass.
2. Resolve the extra signer drop-in reference before signer enablement; otherwise
   a missing file can make the effective unit configuration ambiguous.
3. Keep execution false and all services disabled by default. A configured RPC is
   not authorization to trade.
4. Validate only variable names and file modes in automation; never echo values.

No wallet key, Telegram token, Relay key, RPC URL, or environment value was read or
written for this matrix.
