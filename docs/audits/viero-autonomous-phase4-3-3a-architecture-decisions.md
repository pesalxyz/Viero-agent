# Phase 4.3.3A Architecture Decisions

Date: **2026-10-17**. Foundation only; no executor, signer authorization, Relay,
deployment, or production state integration.

## Ownership and trust boundary

The proposed operation store is signer-owned because it records nonce, signed
transaction, and broadcast evidence. Only the signer process should eventually
create/update records for transaction-capable operations. The agent may submit a
validated request through the existing Unix-socket signer boundary, but must not
open or write the database directly. A future read-only inspector may run as an
operator tool or a restricted agent-side process and receives redacted records,
never signer secrets.

The foundation currently has no runtime caller. This deliberate isolation avoids
changing the existing authorization boundary before the durable protocol is
approved.

## Storage and durability

Implementation: Node's built-in `node:sqlite` `DatabaseSync` (local validation used
Node **v26.4.0**), SQLite schema version 1, WAL mode, `synchronous=FULL`,
`busy_timeout=5000`, foreign keys enabled, and `BEGIN IMMEDIATE` compare-and-set
transactions. No npm SQLite dependency or private-key storage was added.

Each commit fsyncs the database file. A production integration must additionally
verify WAL checkpoint/parent-directory durability on the target Node/SQLite build
and include the WAL/SHM files in a crash-consistent backup. The repository currently
supports Node >=20, while `node:sqlite` is not available in all Node 20 builds;
raising the deployment Node floor or choosing a separately audited SQLite library
is an unresolved prerequisite.

## Operation identity and security

Records contain operation/idempotency IDs, type, chain, position/pool identity,
request fingerprint, signer address reference, optional nonce/hash, receipt/finality
evidence, reconciliation state, terminal state, schema version, and timestamps.

- idempotency keys and operation IDs are unique;
- `(chain, signer, nonce)` is unique when a nonce is present;
- request fingerprints are immutable;
- conflicting reuse is rejected;
- signed bytes are **not stored** by this foundation;
- private keys, API keys, RPC URLs, and secrets are never accepted by the record.

Without signed bytes, an unknown broadcast cannot automatically be rebroadcast;
it must be reconciled by hash/nonce or reviewed. Storing signed bytes later would
require encrypted, signer-only storage, key rotation, retention, and backup policy.

## Recovery ownership and backups

The operation store is authoritative for future transaction recovery; strategy JSON
remains a projection. A future checkpoint must back up SQLite database plus WAL/SHM,
strategy state, and the legacy signer journal under one maintenance lock. Restore
must validate schema versions and checksums before any service is enabled. Rollback
to an older binary is forbidden when it cannot read the operation schema.

## Foundation boundaries

The read-only inspector enumerates unresolved records, ambiguous broadcast states,
finality gaps, and nonce conflicts. It never migrates, signs, broadcasts, resends,
or calls RPC. The legacy importer is dry-run only and writes zero records.
