# Phase 4.3.2 Migration and Rollback Plan

Design only; no migration or runtime change was executed.

## Existing data

`strategy-state.json` is schema version 1 and stores positions/transactions in the
agent repository. `transactions.jsonl` is signer-side append-only evidence written
after broadcast. Existing JSONL entries may contain `broadcast` and `confirmed`
records but no operation IDs, request fingerprints, nonce, or signed bytes. Relay
operations are not represented in that journal.

## Migration phases

1. **Read-only inventory:** validate JSON/JSONL syntax, count records, hash source
   files, and never discard malformed lines. Stop on corruption.
2. **Import known evidence:** create version-1 operation records for entries with a
   valid chain/hash/status. Mark missing intent/fingerprint/nonce as
   `RECONCILIATION_REQUIRED`, not as failed or safe to retry.
3. **Position link:** link records to strategy transactions by exact hash and
   position ID where available. Ambiguous links remain blocked.
4. **Relay inventory:** no fabricated records. Historical normalization without a
   Relay request ID or hash is `UNKNOWN` and requires on-chain/operator review.
5. **Dual-read period:** recovery reads the operation store first and legacy JSONL
   only for imported evidence; no new operation uses legacy append-only writes.
6. **Cutover:** require a clean checkpoint, checksum backup, and explicit approval;
   then reject new execution if the operation store is unavailable.

## Compatibility and rollback

The operation schema has its own version and migration number. A newer release may
read an older schema only through a tested migration. An older binary must never
be pointed at a newer operation store or state projection. Rollback therefore:

1. stops/disables all services;
2. snapshots operation store, JSON state, legacy journal, and environment metadata
   without exposing secrets;
3. validates the target release's supported schema;
4. restores only a compatible snapshot; and
5. leaves execution disabled until reconciliation passes.

If migration is interrupted, resume from an idempotent import checkpoint. If WAL or
SQLite corruption is detected, fail closed and restore the last checksum-validated
backup; never truncate records to make startup succeed.

## Acceptance tests before implementation

- Every crash boundary in the Phase 4.3 harness mapped to a real operation-store
  transition.
- Duplicate idempotency key and nonce conflicts are rejected.
- Exact signed bytes can be reconciled without a new authorization.
- Receipt confirmation and reorg invalidation are idempotent.
- Relay request ID/hash recovery works with a fake SDK transport; unknown Relay
  results never call `execute` twice.
- Legacy journal import preserves malformed evidence and blocks ambiguous entries.
- Older-release rollback is rejected when schema compatibility is absent.
- State, operation store, and journal backups restore in a disposable environment.

## Unresolved decisions

- Whether signed transaction bytes may be encrypted and retained or must require
  operator recovery after a hash-only record.
- Exact nonce-manager API and replacement policy per supported chain.
- Relay status endpoint guarantees and retention period for request IDs.
- Whether SQLite belongs to signer state or a separate protected agent store.
