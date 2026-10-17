# Viero Autonomous Phase 4 Integration Matrix

Audit date: 2026-10-16
Scope: local source and deterministic tests only. No service, signer, wallet, or chain was activated.

| Capability | Source / function | Runtime caller | Evidence | Status | Safety note |
|---|---|---|---|---|---|
| Scheduler | `src/viero/cli.ts` (`live` loop, management interval) | `run-agent.sh` → `cli live` | Typecheck; full suite | READY WITH CONDITIONS | Requires the service environment to select `live` and execution to be explicitly enabled. |
| RPC transport/fallback | `src/viero/clients/publicClients.ts` (`instrumentedHttp`, `PublicClients.get`) | All agent workers | RPC telemetry and integration tests | READY WITH CONDITIONS | Physical-request accounting is best effort with viem batching; fallback retries without a method label are grouped as `unknown`. |
| RPC telemetry | `src/viero/observability/rpcTelemetry.ts` | Discovery, verification, observation, management, confirmation, signer routes | Telemetry and Phase 4.1 workflow tests | READY WITH CONDITIONS | Recovery and normalization now have named scopes; physical-request accounting remains best effort with viem batching. |
| Token metadata cache | `src/viero/adapters/pools.ts` (`readToken`), `src/viero/storage/evidenceCache.ts` | `verifyPool` | Cache persistence, corruption, identity tests | READY | Keyed by chain/address/bytecode identity; mutable price/liquidity data is not cached. |
| Pool creation evidence cache | `src/viero/adapters/events.ts` (`exactPoolCreatedEvidence`) | `targetedRpcObservation` | Cache/reorg tests | READY | Cached evidence is checked against canonical block hash and invalidated on mismatch. |
| Cycle block-boundary cache | `src/viero/adapters/events.ts` (`BlockBoundaryCache`, `firstBlockAt`) | Screening cycle observation | Boundary-cache tests | READY | Scoped to chain/head/hash/time window; not a latest-state cache. |
| Observation-local memo | `src/viero/adapters/events.ts` (`ObservationRpcMemo`, `rpcObservation`) | Historical observation | Memo hit/miss, failure, capacity, reorg tests | READY | Never shared across independent observations or authorization boundaries. |
| Complete log pagination | `src/viero/adapters/events.ts` (`pagedLogs`) | Discovery and historical observations | Pagination/split tests | READY | Row caps and provider errors fail closed; complete evidence is retained. |
| Advisory market data | `src/viero/adapters/targetedPoolDiscovery.ts`, `screeningWorker.ts` | Candidate discovery | Discovery/integration tests | READY WITH CONDITIONS | DEX Screener/GeckoTerminal hints do not replace canonical on-chain identity verification. |
| V3/V4 identity verification | `src/viero/adapters/pools.ts` (`verifyPool`) | Candidate verification and pre-execution checks | Wrong-chain, bytecode, factory, PoolId, hook tests | READY WITH CONDITIONS | Non-zero V4 hooks require an approved allowlist; production allowlist/service state was not inspected. |
| Depth and fee observation | `src/viero/screening/math.ts`, `screening/pipeline.ts`, `events.ts` | Screening | Depth, tick, fee, and missing-evidence tests | READY | Missing prices/ticks/depth fail closed; exact ±1% calculation is preserved. |
| Candidate handoff | `src/viero/workers/screeningWorker.ts` (`executeCandidateToken`) | Live cycle after ranking | Execution/planner tests | READY WITH CONDITIONS | Signer health and execution environment must be verified at runtime. |
| Fresh close confirmation | `src/viero/workers/screeningWorker.ts` (`manageLive`) | Management close decision | Live-management tests | READY WITH CONDITIONS | Open-position decisions perform an independent confirmation before signer handoff. Pending-close recovery is a distinct reconciliation path. |
| Transaction simulation/authorization | `src/viero/execution/executor.ts`, `execution/guard.ts` | Signer service | Execution and authorization tests | READY | Writes are isolated behind signer, simulation, identity assertions, receipt waits, and journals. |
| Signer API/socket | `src/viero/execution/signerServer.ts`, `deploy/viero-signer.service` | Agent `SignerClient` | Phase 4.2 VPS inspection | BLOCKED | VPS signer is safely stopped/disabled, but socket/health are absent and required environment files are missing. |
| Persistence/recovery | Strategy repository and `EvidenceCache` | Agent restart and management | Persistence/corruption tests | READY WITH CONDITIONS | Crash-window behavior between broadcast, receipt, and state persistence has not been exercised as a process fault test. |
| Indexer optional path | `src/viero/indexer/server.ts`, `deploy/viero-indexer.service` | Separate optional service | Phase 4.2 VPS inspection | READY WITH CONDITIONS | VPS unit is inactive and disabled; future activation still requires explicit operator configuration. |
| LLM integration | `src/viero/cli.ts`, `src/viero/agent/llmClient.ts` | Optional Telegram conversational/explanation features | Phase 4.1 startup/config tests | READY WITH CONDITIONS | Deterministic live/Telegram startup no longer constructs an LLM without credentials; explicitly enabled LLM features still fail clearly when unconfigured. |

## Overall interpretation

The safety-critical deterministic path is present and covered by the local suite. The table is not a production sign-off: operational service state and the LLM/configuration mismatch remain unresolved, and telemetry attribution is incomplete on a few recovery paths.
