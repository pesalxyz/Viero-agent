# Phase 4.3.3B Runtime Compatibility and Signer Contract

Date: **2026-10-17**. Local-only preparation. No VPS, signer, wallet, RPC, Relay,
service, or transaction activity occurred.

## Node/SQLite decision

The foundation uses only these `node:sqlite` APIs: `DatabaseSync`, constructor
`readOnly` option, `exec`, `prepare`, prepared-statement `get`/`all`/`run`, and
`close`. Node's official history records `node:sqlite` added in **v22.5.0**;
the module no longer required the experimental flag in v22.13.0 but remained
experimental. In Node 24, it became a release candidate in v24.15.0. Therefore:

- API minimum: Node **22.5.0** for the APIs used here;
- minimum without the CLI experimental flag: **22.13.0**;
- selected production baseline: **Node 24.15+ LTS line**, where the module is a
  release candidate rather than the still-experimental Node 22 line;
- local validation runtime: Node **v26.4.0**, used only as a development runtime,
  not selected as the production baseline;
- the inspected VPS runtime was not rechecked in this phase; prior evidence only
  established that deployed runtime compatibility was unknown.

Evidence: [Node 22 SQLite history](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)
and [Node 24 SQLite history](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

The project engine floor and bootstrap/install checks now require `>=24.15.0` and
the NodeSource bootstrap path targets Node 24. This is a local metadata/tooling
change only; no runtime was installed. A future deployment must verify the exact
`node --version` before installation.

No maintained alternative dependency was introduced: adding `better-sqlite3` or
`sqlite3` would introduce native ABI/build/backup concerns without being needed
once the Node 24 baseline is adopted.

## Files changed

- `src/viero/storage/signerOperationStore.ts` — signer-only mutation facade,
  restrictive permission checks, and redaction helper.
- `src/viero/storage/operationInspector.ts` — read-only reports now redact signer
  address, request fingerprint, and nonce.
- `deploy/check-operation-store.mjs` — read-only SQLite integrity/schema check.
- `deploy/backup-state.sh` — validates the operation store and documents inclusion
  of database/WAL/SHM alongside strategy state and legacy journal.
- `package.json`, `deploy/bootstrap-ubuntu.sh`, `deploy/install-release.sh`,
  `docs/viero.md` — Node 24.15 compatibility contract.
- `tests/operationStore.test.ts`, `tests/phase433bBackup.test.ts`, and worker —
  permission, redaction, concurrency, and backup/restore coverage.

No executor, signer server/client endpoint, Relay, transaction authorization, or
manual LP workflow was changed.

## Signer ownership contract

The future operation database belongs under signer-owned state, with parent and DB
permissions excluding group/world writes. `SignerOperationStore` is a local facade
that rejects the `agent` role, validates the safe path, delegates only mutation
methods, and never accepts private keys. It is not yet imported by the signer
server; this prevents accidental lifecycle integration in this phase.

The agent continues to cross the trust boundary only through the existing Unix
socket `SignerClient`. A future signer endpoint may accept a validated operation
request and return a redacted operation ID/status. The agent must never open the DB
file directly. The inspector is read-only and redacts signer address, nonce, and
request fingerprint.

## Future integration boundaries

The store must be called in this order, without changing current policy:

1. signer validates fresh plan/identity/simulation and creates PREPARED intent;
2. durable commit succeeds or execution is refused;
3. signer reserves nonce and commits it;
4. signer commits signed hash/metadata before submission;
5. submission produces BROADCAST_UNKNOWN or BROADCAST_KNOWN;
6. exact hash receipt/finality reconciliation updates the operation record;
7. strategy state is an idempotent projection of the operation record.

No step may broadcast when its preceding durable commit failed. An ambiguous
operation blocks new authorization and is reconciled read-only. Fresh independent
on-chain confirmation remains mandatory before any new close/rebalance/emergency
close. Relay normalization requires a separate operation record and request-ID
reconciliation; it must not be folded into close.

## Backup and restore compatibility

The backup contract now explicitly covers:

- `operations.db`;
- `operations.db-wal` and `operations.db-shm` companions;
- strategy projection under `/var/lib/viero`;
- legacy signer JSONL journal;
- schema/integrity checks and archive checksums.

Writers must be quiesced before a crash-consistent snapshot. The new checker opens
SQLite read-only, runs `PRAGMA integrity_check`, and requires migration version 1.
Rollback must refuse incompatible schemas before changing a release pointer.

Disposable backup/restore tests copied all database/WAL/SHM, projection, and legacy
journal fixtures, verified an archive checksum, and restored them successfully.
No production file was read or modified.

## Validation

- Typecheck: passed.
- Targeted store/contract/backup tests: **6 passed, 0 failed**.
- Full suite: **473 passed, 1 skipped, 0 failed (474 total)**.
- Build: passed.
- Deployment shell syntax: passed.
- Child-process concurrent SQLite writers: **4/4 succeeded**.
- Permission-boundary and redaction checks: passed.
- Migration/schema compatibility checks: passed through the store schema and
  read-only checker.
- RPC calls, signer invocations, wallet access, and transactions: **0**.

## Remaining blockers and Phase 4.3.3C boundaries

The production execution-safety blocker remains **OPEN**. Phase 4.3.3C may only:

1. integrate PREPARED intent creation into the signer process;
2. add nonce reservation under a signer lock;
3. persist signed metadata before broadcast;
4. reconcile exact hashes/receipts/reorgs without reauthorization;
5. add fake-RPC/fake-signer process-crash tests against the real executor boundary;
6. add Relay request-ID persistence and unknown-result handling;
7. provide WAL-aware migration/rollback tests.

It must not enable live execution, alter trading policy, weaken fresh confirmation,
or connect the agent directly to the database.
