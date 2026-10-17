# Phase 4.3.3D.2 — Signer Server Crash Validation and Evidence Trust

Date: 2026-10-17
Scope: local-only validation with disposable stores, Unix sockets, fake RPC endpoints, and test identities.

## Verdict

**B — ADDITIONAL REMEDIATION REQUIRED.**

The actual signer server now has child-process coverage for startup, recovery readiness, Unix-socket route gating, restart, corrupt-store refusal, and concurrent startup. The evidence handoff no longer treats a SHA-256 checksum as authentication: exports require Ed25519 signatures and imports verify an operator-configured public key. File projection replacement now fsyncs the temporary file and parent directory around atomic rename. Readiness is not promoted to A because an actual transaction-execution crash through a fully valid `/v1/open` or `/v1/close` request was not run (the harness intentionally has no fake signer execution route), and production filesystem ownership/key deployment remains unverified.

## Files changed

- `src/viero/execution/executor.ts` — existing concurrent-recovery compare-and-set handling retained.
- `src/viero/storage/operationStore.ts` — bounded synchronous retry for transient SQLite `SQLITE_BUSY` during WAL/configuration/migration; explicitly permits the recovery-required `BROADCAST_UNKNOWN → RECEIPT_PENDING` transition.
- `src/viero/storage/evidenceHandoff.ts` — version-2 Ed25519-signed evidence envelope; checksum remains corruption detection, signature provides authenticity.
- `src/viero/storage/recoveryCli.ts` — evidence export/import supplies signing and verification keys through environment variables.
- `src/viero/storage/repositories.ts` — atomic strategy writes fsync the file before rename and fsync the parent directory after rename.
- `tests/phase433d2SignerServer.test.ts` — actual signer-server child-process and Unix-socket tests.
- `tests/phase433d2Projection.test.ts` — orphan-temp, concurrent replacement, and JSON-validity checks.
- `tests/phase433d1Evidence.test.ts` — signature, wrong-key, tamper, and BLOCKED-state regressions.

## Signer-server process coverage

`tests/phase433d2SignerServer.test.ts` launches `src/viero/execution/signerServer.ts` itself in separate Node processes with `VIERO_EXECUTION_ENABLED=true`, a deterministic test-only private key, disposable SQLite state, and a Unix socket:

- Valid empty store starts and reports `READY`.
- `/v1/open` reaches request validation only when READY; no malformed request bypasses recovery middleware.
- PREPARED, SIGNED, BROADCAST_UNKNOWN, and RECEIPT_PENDING unresolved stores start but report `RECONCILIATION_REQUIRED`; `/v1/open` is rejected with 503 before schema/execution handling.
- SIGTERM/restart of a valid server preserves READY state.
- Corrupt SQLite state fails startup nonzero.
- Two signer-server processes can initialize/read the same valid store without duplicate operation records; transient SQLite startup locking is retried.
- The health endpoint is read-only and exposes only address/recovery state.

All transaction-capable routes (`/v1/open`, `/v1/claim`, `/v1/close`, `/v1/normalize`) remain behind the same recovery middleware in source inspection. `/v1/balances` is intentionally read-only and is not a transaction-capable route.

The test does not submit a real or fake-chain transaction. A full valid execution request was intentionally not constructed because doing so would require either a signer-side fake transaction protocol or a live chain, both outside this phase.

## Evidence trust model

### Integrity versus authenticity

- SHA-256 checksum detects accidental corruption or truncation.
- Ed25519 signature authenticates that the holder of `VIERO_EVIDENCE_SIGNING_PRIVATE_KEY` produced the envelope.
- The agent-side repair path verifies with `VIERO_EVIDENCE_SIGNING_PUBLIC_KEY`; missing keys, wrong keys, checksum changes, malformed records, and incomplete finality evidence fail closed.
- The envelope omits signer address, nonce, request fingerprint, private keys, and signed transaction bytes.
- Only terminal, known-hash, successful-receipt, finality-confirmed, reconciliation-complete records with position and pool identity are exportable.

This prevents an agent process that lacks the private signing key from forging successful evidence. A compromised host root or process that can read the private key remains outside the local application threat model and must be addressed by service-user/file permissions and secret management during deployment.

### Ownership and IPC

The signer store remains signer-owned and mode 0600; parent directories must not be group/world writable. The agent consumes a signed export rather than opening signer SQLite. The existing Unix socket remains the transaction authorization boundary. SHA-256 alone was insufficient and is no longer used as the trust decision.

## Projection crash consistency

`FileRepository` already used temp-file plus rename. It now performs:

1. write temporary mode-0600 file;
2. fsync temporary file;
3. atomic rename over the target;
4. fsync the parent directory.

An orphan temporary file cannot replace the previous valid projection. A crash before rename leaves the old projection; a crash after rename leaves the new complete JSON. Repeated repair remains idempotent through operation/transaction identity checks. Concurrent replacement tests confirm the resulting strategy file remains parseable and schema-valid. Tampered evidence is rejected before projection application.

## Recovery authorization invariants

- BLOCKED does not release idempotency keys or nonce reservations.
- Operator blocking records an audit decision only; it cannot mark success or authorize a replacement.
- Reconciliation is separate from fresh signing/broadcast authorization.
- Hashless ambiguity remains unresolved and cannot be retried.
- Reorg-suspect evidence cannot become terminal without the existing canonicality checks.
- Fresh independent confirmation and V3/V4 identity protections are unchanged.
- `BROADCAST_UNKNOWN → RECEIPT_PENDING` is now explicit in the state transition table, matching the existing exact-hash reconciliation path.

## Validation results

| Validation | Result |
|---|---:|
| Typecheck | PASS |
| Full test suite | 487 passed, 1 skipped, 0 failed (488 total) |
| Actual signer-server child tests | 2 passed, 0 failed |
| Evidence and BLOCKED-state tests | 2 passed, 0 failed |
| Projection crash-consistency tests | 1 passed, 0 failed |
| Previous production executor crash tests | 2 tests / 11 scenarios passed |
| Build | PASS |
| Deployment script syntax | PASS |
| Real RPC, production signer, wallet, blockchain transactions | 0 |

## Remaining findings

1. A complete valid transaction request was not sent through `/v1/open` or `/v1/close`; transaction execution crash injection remains unvalidated at the HTTP process boundary.
2. Ed25519 key provisioning, rotation, service-user ownership, and Unix-socket group policy require deployment-specific verification.
3. Receipt finality and reorg behavior remain fake-transport tests only.
4. No VPS service operation, production recovery, Relay integration, or autonomous activation was performed.

No trading policy, execution amount, manual LP workflow, or production configuration was changed.
