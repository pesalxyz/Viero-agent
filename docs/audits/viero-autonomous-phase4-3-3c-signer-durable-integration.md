# Phase 4.3.3C Signer Durable Transaction Integration

Date: **2026-10-17**. Local-only implementation and validation. No VPS access,
service operation, real RPC request, wallet access, Relay execution, or
transaction broadcast was performed.

## Decision

**B — ADDITIONAL REMEDIATION REQUIRED.**

The real `LiveExecutor.write()` path now uses the signer-owned SQLite operation
store for ordinary signer transactions, but production activation remains
blocked until the deployed signer runtime, migration/backup procedure, and
operator-reviewed recovery process are validated separately. Relay operations
remain intentionally outside this phase.

## Integrated production path

`src/viero/execution/executor.ts` is the transaction-capable boundary used by
the existing Unix-socket signer server. Each approval, wrap, mint, claim,
close, emergency-close, and burn write now follows this local sequence:

```text
validated/simulated request
  → PREPARED durable record
  → atomic nonce reservation
  → local signing
  → SIGNED + signed transaction hash durable commit
  → raw submission
  → BROADCAST_KNOWN (or BROADCAST_UNKNOWN on transport ambiguity)
  → RECEIPT_PENDING
  → confirmation/finality evidence
  → CONFIRMED or FAILED
  → TERMINAL
```

The request fingerprint is derived from canonicalized transaction request data;
no signed bytes or private key are stored. Idempotency conflicts and any
unresolved same-chain signer operation fail closed before another authorization.
The operation record includes the position and pool identity where available.

`SignerOperationStore` remains the only mutation facade and keeps the underlying
store private. The agent still accesses the signer only through the existing
Unix socket; it does not open the SQLite file.

## Ambiguous broadcast and recovery

- A submission timeout/error transitions `SIGNED → BROADCAST_UNKNOWN`; no
  replacement signing or submission is attempted.
- A returned hash is persisted before receipt polling.
- A receipt wait failure leaves `RECEIPT_PENDING` for read-only recovery.
- `LiveExecutor.reconcileDurableOperations()` polls only the exact persisted
  hash with the configured confirmation depth. It can settle success/revert
  receipts idempotently; a hashless unknown operation becomes
  `RECONCILIATION_REQUIRED`.
- A signed record with a durable signed hash is treated as ambiguous on restart
  and reconciled by exact hash; it is never silently reauthorized.
- Receipt confirmation is distinct from terminal projection. Strategy-state
  projection and Relay request reconciliation are not wired in this phase.

No automatic nonce replacement is implemented. SQLite uniqueness on
`(chain_id, signer_address, nonce)` and compare-and-set transitions protect
concurrent writers.

## Changed files

- `src/viero/execution/executor.ts` — durable write lifecycle and read-only
  durable-operation reconciliation.
- `src/viero/storage/operationStore.ts` — atomic nonce reservation.
- `src/viero/storage/signerOperationStore.ts` — restricted nonce-reservation
  facade.
- `tests/phase433cSignerDurable.test.ts` — production `LiveExecutor.write()`
  tests with fake wallet/RPC transports.

No trading policy, amount, pool verification, fresh confirmation, Relay, manual
LP, or signer socket authorization rule was changed.

## Validation

- Typecheck: passed.
- Full tests: **477 passed, 1 skipped, 0 failed (478 total)**.
- Phase 4.3.3C signer/executor integration tests: **4 passed, 0 failed**.
- Build: passed.
- Deployment shell syntax: passed.
- Fake transport success path: one broadcast, terminal durable record.
- Ambiguous transport path: one attempted broadcast, unresolved durable record,
  second attempt refused.
- Post-broadcast store failure: one attempted broadcast, no replacement.
- Recovery: exact-hash receipt settled idempotently; hashless ambiguity blocked.
- Real RPC, signer, wallet, Relay, and blockchain transactions: **0**.

The tests use isolated temporary operation stores and deterministic fake
accounts/transports. They do not claim funded-chain behavior.

## Remaining blockers

1. The signer server does not yet invoke durable reconciliation at startup or
   expose an operator-only recovery endpoint.
2. Strategy-state persistence is still a separate projection; a crash after a
   terminal operation and before projection update requires the next phase's
   idempotent projection repair.
3. Relay acquire/liquidate remains on its existing SDK path and has no durable
   request-ID operation record by design.
4. Production migration, WAL backup/restore, service-user permissions, and
   deployed Node compatibility remain unverified.
5. Process-level crash injection against the live signer process is not run in
   this local phase; only isolated production-module failure tests were run.

## Phase 4.3.3D boundary

The next offline phase may add signer-startup recovery and an authenticated,
read-only/operator-mediated reconciliation protocol, plus idempotent strategy
projection repair. It must not add automatic replacement transactions, weaken
fresh independent confirmation, connect Relay execution, or activate production
trading without separate approval.
