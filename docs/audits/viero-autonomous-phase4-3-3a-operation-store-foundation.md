# Phase 4.3.3A Durable Operation Store Foundation

Date: **2026-10-17**. Local-only, non-transactional implementation.

## Files changed

- `src/viero/storage/operationStore.ts` — versioned SQLite/WAL store, schema
  migration v1, uniqueness constraints, immutable fingerprints, compare-and-set
  state transitions, nonce uniqueness, full-sync commits.
- `src/viero/storage/operationInspector.ts` — read-only unresolved-operation and
  evidence inspection; no RPC or signer calls.
- `scripts/audits/phase433a-import-journal.mjs` — deterministic legacy JSONL
  importer dry-run; preserves malformed/ambiguous evidence and performs zero writes.
- `tests/operationStore.test.ts` and `tests/operationStoreWorker.ts` — persistence,
  transition, inspector, and child-process WAL concurrency tests.
- `docs/audits/viero-autonomous-phase4-3-3a-architecture-decisions.md` — ownership,
  durability, and unresolved Node/SQLite decisions.

No executor, signer server/client, Relay, deployment, strategy policy, or manual LP
workflow was changed.

## Schema and transitions

Migration table version 1 creates `operations` with operation ID, idempotency key,
operation type, chain ID, position/pool identity, request fingerprint, signer
address reference, optional nonce/hash, broadcast status, receipt JSON, finality,
reconciliation, state, and timestamps. The partial unique nonce index prevents
conflicting reservations. Records reject unknown schema/state/type, invalid
fingerprints, and invalid signer addresses.

The validated transitions are PREPARED → SIGNED → BROADCAST_UNKNOWN or
BROADCAST_KNOWN → RECEIPT_PENDING → CONFIRMED/FAILED → TERMINAL. Ambiguous and
corrupt paths become RECONCILIATION_REQUIRED or BLOCKED. Terminal records cannot
become active; only explicitly allowed reconciliation transitions exist.

## Recovery inspector and importer

`inspectOperationStore()` opens SQLite read-only and reports unresolved records,
ambiguous broadcasts, incomplete finality, and nonce conflicts. It cannot mutate
the database. `phase433a-import-journal.mjs` generates stable hash-based import
candidates, preserves malformed lines as reconciliation findings, and reports
`writes: 0`.

## Validation

- Targeted operation-store tests: **4 passed, 0 failed**.
- Child-process WAL concurrency: **4 concurrent writers succeeded**.
- Typecheck: passed.
- Full suite: **471 passed, 1 skipped, 0 failed (472 total)**.
- Build: passed.
- Dry-run journal importer: verified valid hash candidate plus malformed-line
  preservation; zero writes and zero transactions.
- Real RPC calls, signer invocations, wallet access, and transactions: **0**.

These tests demonstrate process-level SQLite locking and deterministic validation;
they do not claim production transaction crash durability because the store is not
yet connected to executor or signer code.

## Unresolved decisions and integration prerequisites

1. Resolve Node runtime support: `node:sqlite` requires a supported Node release;
   production currently advertises Node >=20.
2. Approve signer-only ownership and a restricted inspector interface.
3. Define encrypted signed-byte retention or hash-only recovery policy.
4. Integrate intent persistence before signing/broadcast, then add production
   fake-RPC/signer crash tests for every state transition.
5. Add WAL/SHM-aware backup and migration/rollback validation.
6. Add Relay request-ID persistence and conservative status reconciliation.

The existing execution-safety blocker remains **OPEN**. No deployment or runtime
integration is authorized by this phase.
