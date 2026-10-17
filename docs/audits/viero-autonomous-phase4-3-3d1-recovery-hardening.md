# Phase 4.3.3D.1 — Recovery Hardening and Process-Level Crash Validation

Date: 2026-10-17
Scope: local repository only; no VPS access, production signer, real RPC, or transactions.

## Verdict

**B — ADDITIONAL REMEDIATION REQUIRED.**

The durable signer path is materially safer and the production `LiveExecutor` survives the tested child-process crash boundaries without duplicate authorization, signing, broadcast, or nonce allocation. A concurrent-startup compare-and-set race was also corrected so the losing recovery process re-reads durable state instead of falsely reporting `BLOCKED`. Readiness is not promoted to A because the live `signerServer` process was not started in this phase, a crash cannot be injected inside the synchronous projection mutation itself, and deployment/production verification remain intentionally out of scope.

## Production modules exercised

- `src/viero/execution/executor.ts` — `LiveExecutor.write()`, `startupRecovery()`, and `reconcileDurableOperations()`.
- `src/viero/storage/operationStore.ts` and `src/viero/storage/signerOperationStore.ts` — SQLite WAL, FULL synchronous commits, compare-and-set transitions, nonce uniqueness, validation.
- `src/viero/storage/projectionRepair.ts` — receipt-gated, idempotent strategy projection application.
- `src/viero/storage/evidenceHandoff.ts` — restricted checksum-protected signer-to-agent evidence export/import.

The child worker uses fake accounts and fake RPC transports only. It never loads a wallet key from production and cannot broadcast to a network.

## Crash boundaries covered

`tests/phase433d1SignerCrashWorker.ts` and `tests/phase433d1Crash.test.ts` exercise the actual `LiveExecutor.write()` path in separate Node child processes:

1. Before PREPARED commit — no operation is created.
2. After PREPARED commit — one PREPARED record remains.
3. After nonce reservation — nonce 7 remains durably reserved.
4. After signed-hash persistence — SIGNED and signed identity remain.
5. Immediately before broadcast — no submission occurs; SIGNED remains.
6. After the broadcast call boundary — no retry is authorized; SIGNED remains when acknowledgement is lost.
7. Ambiguous transport — BROADCAST_UNKNOWN is persisted and the operation remains unresolved.
8. During receipt wait — RECEIPT_PENDING remains.
9. After confirmed transition — CONFIRMED remains and is recoverable.
10. Normal completion — the operation reaches TERMINAL exactly once.
11. Repeated startup recovery — two concurrent child processes reconcile the same operation without duplicate action.

The existing production-module tests also cover a durability failure after a successful broadcast acknowledgement and exact-hash versus hashless recovery. The older `scripts/audits/phase43-crash-recovery.mjs` remains a mock-only 21/21 harness and is not counted as production-module coverage.

## Recovery-state safety

- `BLOCKED` has no transition to a new authorization; it can only move to `RECONCILIATION_REQUIRED` through an explicit operator decision.
- Idempotency keys remain unique while an operation is BLOCKED or unresolved.
- SQLite nonce uniqueness remains enforced for `(chain, signer, nonce)` and is not released by blocking.
- Missing receipts remain unresolved; they are never treated as failed broadcasts.
- A known hash is reconciled by exact hash and required confirmations. A hashless `BROADCAST_UNKNOWN` operation becomes `RECONCILIATION_REQUIRED` and cannot be retried automatically.
- Reverted or reorg-suspect evidence is not silently terminalized.
- Startup readiness is `READY` only after validation and an empty unresolved set; otherwise it is `RECONCILIATION_REQUIRED` or `BLOCKED`.
- Concurrent recovery uses compare-and-set. A stale loser now re-reads the durable record rather than converting a harmless race into a false BLOCKED readiness result. Unresolved records still gate readiness.

## Durable evidence handoff

`src/viero/storage/evidenceHandoff.ts` provides a restricted boundary for projection repair:

- Exports only terminal, known-hash, successful-receipt, finality-confirmed, reconciliation-complete records.
- Omits signer address, nonce, request fingerprint, and any secret or signed transaction material.
- Canonically sorts records and stores a SHA-256 checksum in an atomic mode-0600 envelope.
- Rejects checksum changes, incomplete evidence, missing position/pool identity, non-success receipts, and non-terminal states.
- `recoveryCli.ts` can export with `--export-evidence <file>` and repair from a validated `--evidence-file <file>`; the CLI has no signing, RPC, broadcast, or force-success endpoint.
- Projection repair remains idempotent: a repeated evidence application is skipped by transaction hash/position identity, while mismatches are blocked.

## Operator recovery procedure

1. Run `npm run operation:recovery -- --database <store> --inspect` and preserve the redacted output and database backup.
2. Treat `BROADCAST_UNKNOWN`, `SIGNED`, `RECEIPT_PENDING`, and `RECONCILIATION_REQUIRED` as unresolved; do not retry.
3. For a known hash, reconcile exact hash and finality through the signer recovery path. A missing receipt is not proof of failure.
4. For hashless ambiguity, keep the operation blocked and obtain independent operator evidence; never invent a hash or authorize a replacement.
5. If evidence is terminal and complete, export it with `--export-evidence`; apply it to the agent data directory using `--repair-strategy <dataDir> --evidence-file <file>`.
6. Preserve the evidence envelope, checksum, operation database backup, and audit JSONL before any manual decision.
7. Use `--block <operationId> --reason <CODE> --audit-file <file>` only to record a manual block. It cannot mark success or release a nonce/idempotency key.

## Validation

| Check | Result |
|---|---:|
| Typecheck (`npm run typecheck`) | PASS |
| Full tests (`npm test`) | 484 pass, 1 skipped, 0 failed (485 total) |
| Production-module crash/recovery tests | 11 pass, 0 failed |
| Evidence handoff and BLOCKED-state tests | 2 pass, 0 failed |
| Build (`npm run build`) | PASS |
| Deployment shell syntax (`bash -n deploy/*.sh`) | PASS |
| Legacy mock crash harness | 21/21 pass; mock-only, not counted above |

## Uncovered boundaries and remaining blockers

- The HTTP `signerServer` was not launched in this phase; its startup gate is covered by existing in-process recovery tests, but not by a child-process HTTP crash test.
- `repairStrategyProjection` is synchronous and has no safe internal yield point. The before-persistence path is represented by the recoverable handoff contract, but an injected mid-function process kill is not separately instrumented.
- Receipt finality and reorg behavior are constrained by the fake transport fixtures; live chain finality remains unverified by design.
- Production deployment, filesystem ownership, service restart behavior, and F4 process-level VPS tests remain outside scope.

No trading thresholds, amounts, policy rules, manual LP workflows, or authorization boundaries were changed.
