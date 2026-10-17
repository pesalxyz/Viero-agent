# Viero final local remediation and readiness

Date: 2026-10-17. Scope: local repository only. No VPS access, production RPC, funded wallet, blockchain broadcast, service activation, manual LP modification, commit, or push occurred. The existing VPS must remain stopped. This report supersedes the earlier readiness conclusions for **local code** only; it does not assert a new VPS state.

## Verdict

**GO FOR CONTROLLED DEPLOYMENT REVIEW.** Both previously identified local blockers now have durable implementation and passing local evidence. This verdict does not authorize VPS deployment, service activation, or autonomous trading; the external production gates below remain mandatory.

The tested signer request, crash/recovery, Relay fail-closed, RPC equivalence, key-hand-off, packaging/dependency and backup/schema paths pass. The two former local blockers are resolved below; the external gates remain open and must be completed in a separately authorized deployment review.

## Implemented fixes and code evidence

| Area | Change and evidence |
|---|---|
| Signer intent/idempotency | `src/viero/storage/operationStore.ts` adds one-transaction `createExclusive()`; `src/viero/storage/signerOperationStore.ts` exposes it; `src/viero/execution/executor.ts` uses it before nonce/sign/broadcast. Concurrent unresolved same signer/chain and repeated keys cannot open a second authorization. Existing WAL/FULL/nonce uniqueness remains. This protects an individual transaction, not an entire multi-transaction workflow. |
| Canonical receipt and close safety | `executor.ts` refuses to terminalize a confirmed receipt whose block number/hash differs from durable evidence, marking reorg suspicion. New close and emergency close re-verify canonical pool/token identity independently before signing. Zero *active pool* liquidity no longer prevents safe exit of an existing out-of-range position; identity, price, position liquidity, simulation, and authorization remain mandatory. Startup blocks confirmed mints until complete evidence and projection acknowledgement are present. |
| Actual signer route coverage | `src/viero/execution/signerServer.ts` exports the same production route factory used by its executable main. `tests/finalSignerSocketWorker.ts`/`.test.ts` launch it over a disposable Unix socket with fake RPC/test identities. Valid V3 and V4 open/approval/Permit2/mint/claim/close, emergency close, native wrap before mint, fresh identity rejection, and process-kill/restart boundaries pass. Earlier actual signer-main startup/route-gate tests remain in the full suite. |
| Relay lifecycle | `src/viero/storage/relayOperationStore.ts` creates a separate signer-owned SQLite WAL/FULL operation record with validated key, quote fingerprint, request IDs, token/amount/context, progress hashes, and independent receipt evidence. `src/viero/execution/relay.ts` commits intent before SDK execution, rejects partial/mismatched completed steps, verifies exact receipt hash/block and required confirmations, and never repeats an ambiguous `actions.execute()`. UNKNOWN/EXECUTING remains manual-reconciliation-required; normalization is separate from close. `signerServer.ts` exposes a redacted readiness state and gates normalization when Relay recovery is not READY. The installed SDK is `@relayprotocol/relay-sdk@8.0.1`; no SDK request-ID idempotency or safe automatic replay guarantee is assumed. |
| Projection/evidence boundary | `src/viero/storage/recoveryCli.ts` requires a signed evidence file for agent-side projection repair; it cannot fall back to direct signer SQLite. `src/viero/storage/evidenceHandoff.ts` supports protected Ed25519 PEM/DER key files and rejects wrong key/type or tampering. Signer/agent ownership remains separate. |
| Confirmed mint → projection acknowledgement | Operation-store schema v2 persists signer-authored mint context/evidence and projection acknowledgement. The signer records token ID, pool identity, manager, plan evidence and receipt hash before terminalizing the mint. `/v1/ack-position` is a transaction-free signer-owned acknowledgement after the agent atomically persists its strategy projection; `/v1/recovery/open-positions` exposes recovery evidence. Startup and new opens remain held while a confirmed mint lacks acknowledgement, and acknowledgement is idempotent and evidence-bound. |
| V3 close workflow | `close_workflows` durably tracks V3 remove-liquidity and collect as separate steps, linked to operation records with hashes/receipts/finality. Restart reconciliation advances only receipt-backed completed steps; a non-complete workflow keeps readiness held, while the close route may resume collect only after fresh pool/price/position checks. A zero-liquidity observation cannot mark an incomplete V3 workflow closed. Completed remove/collect operations are never repeated. |
| Release safety | `deploy/install-release.sh` now refuses passive installation unless services are already stopped/disabled, preflights protected configuration and schemas, excludes sensitive/runtime material, and makes release installation distinct from activation. `deploy/rollback-release.sh` validates both source/target schemas, makes a backup, and never auto-starts. `deploy/backup-state.sh` requires quiescence and includes signer/Relay SQLite companions and legacy journal. New read-only `check-relay-store.mjs`, `inspect-relay-store.mjs`, and `check-legacy-journal.mjs` support inventory without replay. Unit/env templates define signer ownership and evidence key-file paths. |
| Bounded RPC reuse | `src/viero/adapters/events.ts` caps the cycle-scoped boundary cache at 128 entries. Existing verified token metadata, creation evidence, observation-local historical memo, complete `pagedLogs()`, and telemetry were checked with `scripts/audits/final-offline-rpc-benchmark.ts`; no additional freshness-critical cache was added. |

Changed local areas are the files named above, `deploy/viero-signer.service`, `deploy/signer.env.example`, `deploy/viero.env.example`, the five `tests/final*.test.ts` files and socket worker, relevant existing durable-store regressions, the benchmark script, and these three final documents. The working tree was already dirty/untracked before this task; no unrelated deletion or refactoring was performed. The repository's baseline HEAD is `128ac3d4b1ea96084d55a9578306d017006e709d`, but uncommitted source must not be treated as an identified release.

## Safety and regression checks

- BNB V3 factory/canonical token/fee relationship and Robinhood V4 complete PoolKey/PoolId, state-view, and hook allowlist are retained in fresh `verifyPool()` reads. Read-only identity fixtures and new close-handoff mismatch test pass. Required block-pinned canonical hashes are not bypassed.
- Initialized tick bitmap/tick-liquidity reads, exact LP-net fee/depth calculations, and full historical log pagination were unchanged; benchmark results, log count/order, and candidate decision digests match. Provider-style pagination splits still recover all pages.
- Each signer *transaction* remains PREPARED → reserved nonce → SIGNED hash → submission/receipt/finality. Tested ambiguous individual writes cannot authorize an automatic replacement; `BLOCKED` retains the key and nonce. Stale/reorged receipt evidence does not become terminal. Confirmed mint projection and V3 close are separate durable milestones with explicit acknowledgement/step evidence; neither is considered safely complete from a receipt alone.
- STOPPED/execution-disabled configuration and deterministic candidate/management tests remain in the full suite. No LLM key is required for deterministic operation. No trading threshold, selection strategy, execution size, or manual LP workflow changed.
- Authenticated Ed25519 handoff is distinct from the SHA-256 corruption checksum. Private signer evidence keys stay signer-side; agent repair consumes only signature-verified final receipt/finality evidence. Rotation with the wrong public key fails closed.

## Validation performed

| Check | Result | Boundary |
|---|---|---|
| `npm run typecheck` | PASS | Local Node 26.4.0; production Node 24.15+ not yet observed |
| `npm test` | **509 pass, 1 skip, 0 fail (510 total)** | The sole skip is optional PostgreSQL integration without `TEST_DATABASE_URL`; file persistence is default |
| `npm run build` | PASS | Local build only |
| Actual production-route Unix-socket valid-request/crash suite | 10 pass, 0 fail | Fake RPC/test identity; V3, V4, wrap, close, emergency, mint evidence/ack restart, mint-before-identity hold, restarts |
| Relay durable/recovery suite | 5 pass, 0 fail | Fake SDK/RPC; ambiguity, partial steps, receipts, no replay |
| Disposable backup/schema/install-contract suite | 3 pass, 0 fail | Includes signer/Relay/journal state restore and startup recovery |
| Protected Ed25519 key-file test | 1 pass, 0 fail | Correct/wrong-key and rotation behavior |
| Deterministic RPC comparison test | 1 pass, 0 fail | Same result digest and complete log count |
| Offline clean production dependency install | PASS | `npm ci --offline --omit=dev --ignore-scripts`: 181 packages; Relay SDK 8.0.1 present |
| `bash -n` on installer, backup, rollback | PASS | Syntax plus passive-install/rollback static contract tests |

The process tests use the real `LiveExecutor`, signer operation store, and production Express route factory with fake transports. They are stronger than state-machine-only tests, but do not establish live-chain behavior. The packaging rehearsal uses disposable directories, clean locked dependencies, a quiescent tar/restore, schema refusal, and fake signer startup. It does **not** execute the privileged absolute-path installer or systemd against a host; doing so was outside the local boundary.

## RPC result

The comparable synthetic two-chain/two-cycle fixture produced 180 versus 118 simulated transport calls, estimated 5,032 versus 3,672 method-weighted CU, and identical outcome digest. The 62-call/1,360-estimated-CU difference applies only to this controlled fixture. The 28 complete log queries were unchanged. These are **not** actual Alchemy-billed CU, dollars, measured production latency, or a full autonomous-runtime percentage. See `docs/audits/viero-final-rpc-optimization-benchmark.md` for method counts, cache hits, assumptions, memory limits, and historical-profile context. Fresh execution/management safety reads were not removed.

## Remaining blockers and exact acceptance criteria

| Rank | Status | Blocker / acceptance criterion |
|---|---|---|
| **Critical — local** | **RESOLVED** | Confirmed mint → agent projection: schema-v2 signer evidence, explicit `/v1/ack-position`, recovery evidence endpoint, dynamic open hold, and restart/idempotence process tests. No new mint is accepted while a confirmed evidence record is unacknowledged. |
| **High — local** | **RESOLVED** | V3 remove → collect: durable `close_workflows` and step-linked operations, restart reconciliation, fresh checks before collect, incomplete-workflow readiness hold, zero-liquidity fail-closed handling, and no-repeat step semantics. |
| **High — external** | OPEN | VPS runtime/release drift. Read-only verify actual Node >=24.15, active/previous artifact hashes and unit/drop-in paths. The prior VPS audit saw old release `2.0.4-20261006T140022Z`; semantic version alone is insufficient. Stage a reviewed immutable artifact from the dirty tree, with manifest and secret scan. |
| **High — external** | OPEN | Required protected `/etc/viero/viero.env` and `/etc/viero/signer.env` were absent at the prior VPS inspection. Provision through an approved secret path, verify owner/mode, selected-chain RPC presence and old signer/drop-in drift without printing values; leave execution flags false. No key or RPC endpoint was accessed in this run. |
| **High — external** | OPEN | Actual signer socket ACL, filesystem ownership/WAL durability, journal writability, and process restart behavior cannot be established while VPS services are stopped. Verify with read-only metadata and a separately authorized isolated signer-start gate; do not turn on autonomy merely to inspect. |
| **High — external** | OPEN | Production signer/Relay DB and legacy journal contents/schema are unknown. Take quiescent, checksummed backups; run read-only schema/legacy checkers; reconcile every ambiguous hash/nonce and Relay UNKNOWN/EXECUTING record. A missing receipt is not proof of failure. Previous-release rollback must explicitly accept the new schemas or refuse. |
| **Medium — design/liveness** | ACCEPTED HOLD | Relay SDK status/idempotency is not proven sufficient for automatic safe resumption after an ambiguous multi-step execution. The durable state deliberately blocks replay and exposes redacted evidence for human reconciliation. Do not delete the DB or mark success from an SDK request ID. Enable Relay normalization only with an operator procedure for these holds; otherwise leave Relay disabled. |
| **Medium — measurement** | OPEN | Actual Alchemy-billed CU and production per-workflow cache hit rates were not measured. Later approved passive telemetry is needed to attribute cost; this is not a transaction-safety or installation blocker. Manual LP must remain separately attributed. |
| **Low — test environment** | OPEN | PostgreSQL test skipped because no test database was provided. File persistence is the default and was exercised. If PostgreSQL is selected on the VPS, separately validate its migration/backup path before activation. |

The local implementation is now suitable for a **controlled deployment review**. Production-only prerequisites remain mandatory: safe-stopped VPS inspection, protected configuration and schema checks, signer socket ACL verification, quiescent backups, legacy/Relay reconciliation, and an independently authorized activation decision. This report does not authorize deployment or autonomous activation.
