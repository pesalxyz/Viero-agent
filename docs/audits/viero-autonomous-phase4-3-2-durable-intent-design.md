# Phase 4.3.2 Durable Transaction Intent and Recovery Design

Status: **DESIGN ONLY** — 2026-10-17. No runtime files were modified.

## Evidence reviewed

The Phase 4 through 4.3.1 reports identify a stopped VPS, missing protected
configuration, and a post-broadcast JSONL journal gap. Source evidence is in:

- `src/viero/execution/executor.ts` (`LiveExecutor.write`, `journal`, `open`,
  `claim`, `close`, `normalize`)
- `src/viero/execution/signerServer.ts` and `signerClient.ts`
- `src/viero/execution/liveState.ts` and `storage/repositories.ts`
- `src/viero/workers/screeningWorker.ts` (`manageLive`,
  `executePositionAction`)
- `src/viero/execution/relay.ts`
- `deploy/install-release.sh`, `deploy/rollback-release.sh`, and the Phase 4.3.1
  controlled-deployment runbook.

## Current transaction-capable operations

| Operation | Current authorization boundary | Current durable evidence | Current recovery |
|---|---|---|---|
| Open/mint | `SignerClient.open` → signer `/v1/open`; `simulateContract`, local sign, raw send in `LiveExecutor.open` | `broadcast`/`confirmed` JSONL entries only after send; strategy state after response | No operation-intent reader; management sees only persisted position/transactions |
| Close | `SignerClient.close` after fresh independent confirmation in `manageLive` or Telegram action | Same executor journal; strategy state after response | `status=closing` logic uses strategy transactions, but cannot resolve an unknown hash safely |
| Claim | Signer `/v1/claim`, simulation and `write` | Same journal and state | No durable intent recovery |
| Rebalance | No live rebalance execution branch is currently present; enum/management paths are policy/state-oriented | Not applicable | Planned/design only |
| Emergency close | Same `/v1/close` boundary with `emergency=true`; fresh confirmation remains required | Same journal | Same ambiguity as close |
| Relay acquire | `RelayBalancer.acquire` calls SDK quote then `actions.execute` | Returned hashes are stored only after SDK returns | No local operation record; unknown SDK result can be retried |
| Relay liquidate/normalization | `LiveExecutor.normalize` → `RelayBalancer.liquidate` | Strategy state/transactions after response only | `pending`/`failed` retry exists, but no durable Relay intent |

`src/viero/execution/guard.ts` is read-only and is not the live signer boundary;
the live boundary is the Unix-socket signer service. `signerServer.ts` rejects
startup unless `VIERO_EXECUTION_ENABLED=true`, but that flag is not an intent
record or idempotency mechanism.

## Proposed durable operation record

Use a versioned record in a dedicated operation store, separate from the strategy
projection:

```text
OperationRecord {
  schemaVersion: 1
  operationId: UUID
  idempotencyKey: string
  type: OPEN | CLOSE | CLAIM | EMERGENCY_CLOSE | RELAY_ACQUIRE | NORMALIZE
  chainId: number
  positionId?: string
  poolIdentity?: string
  requestFingerprint: sha256(canonical validated request)
  signerAddress: address                 // reference only, never a private key
  nonce?: uint256
  signedTransactionHash?: bytes32
  signedTransactionBytes?: encrypted/permissioned blob, optional
  broadcastStatus: NOT_ATTEMPTED | UNKNOWN | KNOWN
  receipt?: { blockHash, blockNumber, status, confirmations }
  finality: UNCHECKED | CONFIRMED | REORG_SUSPECTED
  reconciliation: NONE | REQUIRED | IN_PROGRESS | COMPLETE
  terminalStatus: NON_TERMINAL | SUCCEEDED | FAILED | BLOCKED
  createdAt, updatedAt: timestamp
}
```

Uniqueness constraints:

1. `operationId` is the primary key.
2. `(chainId, signerAddress, nonce)` is unique when a nonce exists.
3. `idempotencyKey` is unique for an economically identical operation, such as
   `close:<positionId>:<closeDecisionVersion>` or
   `normalize:<positionId>:<residualFingerprint>`.
4. A request fingerprint mismatch never updates an existing operation; it creates
   a blocked conflict requiring review.

The record is written durably before signing/broadcast. Canonical JSON plus a
record hash detects corruption. Use a single-writer lock (SQLite `BEGIN IMMEDIATE`
or an exclusive lock file) and an append-only WAL/operation table. Commit data,
fsync the file, fsync the parent directory, then release the lock. A projection of
terminal operations may be written to strategy state afterward; the operation store
is authoritative for transaction recovery.

Signed bytes should be retained only if encrypted/restricted storage is approved;
otherwise retain the request fingerprint, nonce, and hash and require operator
reconciliation. Never put private keys in the record, logs, Telegram, or release.

## Protocol ordering

1. Validate plan identity, fresh state, policy, simulation, and signer health.
2. Create `PREPARED` record under the idempotency key. If an unresolved record
   already exists, reconcile it and do not authorize a new transaction.
3. Allocate/verify the nonce under the signer lock; persist nonce.
4. Sign locally; persist `SIGNED` and hash/bytes before submission.
5. Submit the exact signed bytes. A timeout or transport error becomes
   `BROADCAST_UNKNOWN`; it is never treated as “not sent”.
6. If a hash is returned, persist `BROADCAST_KNOWN` before any receipt wait.
7. Persist `RECEIPT_PENDING`, then independently fetch and verify the receipt,
   block hash, status, and required confirmations.
8. Persist `CONFIRMED`/`FAILED`, then update strategy state transactionally or
   idempotently from the operation record.

Rebroadcasting identical signed bytes may be considered only when the same nonce,
chain, signer, and exact bytes are durably recorded, the provider confirms the
transaction is absent/pending, and the chain's replacement rules are understood.
Creating a new transaction or nonce is never an automatic recovery action.

## Relay SDK finding

Installed Relay SDK types expose `requestId` on quote/step data and `txHashes` and
receipts on executed steps (`node_modules/@relayprotocol/relay-sdk/_types/src/types/Execute.d.ts`).
The local `RelayBalancer` currently discards the quote/step request ID and only
returns hashes after `actions.execute` resolves. The SDK has status/polling support
around request IDs, but Viero has not verified a stable idempotent re-submit API or
an operator-safe local idempotency key. Therefore a Relay operation must be stored
before `execute`, retain request IDs and every returned hash, and on unknown result
poll/reconcile by request ID and on-chain receipts. It must never call `execute` a
second time automatically. Normalization remains separate from close: a confirmed
close is terminal even if normalization is `RECONCILIATION_REQUIRED`.

## Recommendation

Use SQLite for the operation store (one file under signer state, mode 0600) with a
WAL and explicit schema version, while keeping existing JSON state as a projection.
SQLite supplies uniqueness, transactions, locking, corruption detection, and
restart recovery without inventing a fragile multi-file protocol. The first
implementation should cover signer writes, then Relay operations, then projection
reconciliation. Do not implement until the state machine and migration plan are
approved.
