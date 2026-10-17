# Phase 4.3.3D Signer Startup Recovery and Strategy Projection Repair

Date: **2026-10-17**. Local-only implementation. No VPS access, service
operation, real RPC, wallet, Relay, signer production invocation, or blockchain
transaction occurred.

## Verdict

**B — ADDITIONAL REMEDIATION REQUIRED.**

Signer startup now validates the durable store and gates transaction-capable
requests until recovery is ready. Confirmed operation evidence can be applied
to the agent strategy projection through an explicit local operator tool. Full
production readiness is still blocked because startup recovery is not yet
covered by a deployed service migration, Relay remains outside the durable
protocol, and process-level crash tests against a real signer child are not
complete.

## Startup readiness state machine

`LiveExecutor.startupRecovery()` performs no signing or submission:

```text
open store
  → integrity/schema/signer/chain validation
  → exact-hash read-only reconciliation
  → READY
       or RECONCILIATION_REQUIRED (evidence remains unresolved)
       or BLOCKED (storage, identity, schema, or prerequisite failure)
```

`signerServer.ts` runs this gate before opening its socket routes. `/health`
reports only the readiness state. `/v1/open`, `/v1/claim`, `/v1/close`, and
`/v1/normalize` return `SIGNER_RECOVERY_NOT_READY` unless the state is `READY`.
Balances remain read-only. Recovery never interprets a missing receipt as proof
that a transaction did not happen.

Validation includes SQLite integrity, schema version, signer identity for every
unresolved record, and supported chain IDs. Exact hashes are polled with the
configured confirmation depth. Hashless ambiguity remains
`RECONCILIATION_REQUIRED`.

## Operator reconciliation security

No unauthenticated HTTP recovery endpoint was added. The local command is:

```text
npm run operation:recovery -- --database <operations.db> --inspect
npm run operation:recovery -- --database <operations.db> --block <operation-id> --reason <CODE>
npm run operation:recovery -- --database <operations.db> --repair-strategy <agent-data-dir>
```

Inspection uses the existing redacted report and hides signer address, nonce,
request fingerprint, and sensitive metadata. The only mutation available to the
operator CLI is an explicit, validated transition to `BLOCKED`, recorded in a
0600 audit JSONL file. It cannot sign, broadcast, replace, or mark a transaction
successful. Projection repair writes only the agent-owned strategy state after
evidence validation; it never writes the signer database through the agent.

## Projection repair rules

`repairStrategyProjection()` accepts only records that are simultaneously:

- `TERMINAL`;
- broadcast status `KNOWN` with a transaction hash;
- receipt status `success`;
- `finality=CONFIRMED` and `reconciliation=COMPLETE`;
- linked to an exact position and pool identity.

Confirmed close/emergency-close records mark an existing matching position
closed and preserve normalization as a separate pending/not-required state.
Confirmed claim records add one transaction projection without inventing claimed
amounts. Replaying the same transaction hash is a no-op. Open records cannot
create a position from incomplete operation metadata; they require an existing
matching entry identity. Missing positions, pool mismatches, incomplete
identity, unsupported operation types, and all ambiguous/nonterminal records are
blocked rather than inferred.

## Workflow idempotency audit

| Workflow | Durable identity | Recovery result |
|---|---|---|
| Approval | chain + type + canonical request fingerprint | Same request is idempotent; unresolved record blocks retry |
| Wrap | chain + type + canonical request fingerprint | Same behavior; ambiguous submission blocks |
| Mint | request fingerprint, then position/pool annotation after receipt | Receipt evidence is linked; projection refuses incomplete opens |
| Claim | request fingerprint + position ID | Confirmed claim projection is replay-safe |
| Close | request fingerprint + position ID/pool | Confirmed close projection is replay-safe |
| Emergency close | same, with `EMERGENCY_CLOSE` type | Same fail-closed path |
| Burn | currently represented under close lifecycle | Cosmetic burn recovery remains incomplete and must not reopen/retry funds |

Relay acquire/liquidate is intentionally not integrated in this phase.

## Changed files

- `src/viero/execution/executor.ts` — startup recovery gate, readiness states,
  exact-hash recovery, and post-mint identity annotation.
- `src/viero/execution/signerServer.ts` — readiness-gated transaction routes.
- `src/viero/storage/operationStore.ts` — operation lookup, annotation, and
  complete-record inspection.
- `src/viero/storage/signerOperationStore.ts` — signer/chain/integrity
  validation and restricted delegates.
- `src/viero/storage/projectionRepair.ts` — evidence-gated idempotent repair.
- `src/viero/storage/recoveryCli.ts` — local operator inspection, block-only
  reconciliation decision, and projection repair.
- `tests/phase433dRecovery.test.ts` — startup identity gate and projection
  replay tests.
- `package.json` — local `operation:recovery` command.

## Validation

- Typecheck: passed.
- Full suite: **480 passed, 1 skipped, 0 failed (481 total)**.
- Phase 4.3.3C/D recovery tests: **7 passed, 0 failed**.
- Build: passed.
- Deployment shell syntax: passed.
- Valid empty-store startup: `READY`.
- Signer identity mismatch: `BLOCKED`.
- Exact-hash recovery and hashless ambiguity: passed.
- Confirmed close projection replay: one application, subsequent no-op.
- CLI redacted inspection against an isolated store: passed.
- Existing isolated process-boundary crash harness: **21/21 scenarios passed**;
  this harness is mock-only and does not import the signer/executor.
- Real RPC, production signer, wallet, Relay, and transactions: **0**.

Process-level child crash injection at every listed boundary and simultaneous
signer-process recovery remain unverified in this phase. Existing operation-store
concurrency tests remain passing, but they do not substitute for a full signer
process crash harness.

## Remaining blockers / next offline phase

1. Add a child-process signer harness that exercises startup and recovery around
   each durable boundary, including projection failure and repeated restarts.
2. Define an authenticated operator handoff for production deployments; retain
   the CLI as the offline fallback.
3. Add an explicit durable projection/evidence handoff artifact and backup
   checksum validation around strategy-state repair.
4. Integrate Relay request IDs only after a separate design and approval.
5. Validate migrations, service permissions, and Node compatibility in an
   isolated deployment environment before any VPS action.

No production activation or autonomous trading is authorized by this phase.
