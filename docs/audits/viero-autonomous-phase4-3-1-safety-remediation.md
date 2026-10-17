# Viero Phase 4.3.1 Safety Remediation

Date: **2026-10-17**. Local-only implementation and validation. No VPS write,
service operation, signer/wallet access, RPC request, transaction, commit, or push
was performed.

## Result

**C — CRITICAL EXECUTION SAFETY BLOCKER.** Deployment tooling is now safer and
the isolated harness covers the requested failure injections, but production
transaction intent/recovery is not yet durable enough to authorize activation.
The unresolved post-broadcast journal ambiguity (including Relay normalization)
requires a deliberate transaction-intent/recovery design, not a speculative
one-line change.

## Changed files

- `deploy/install-release.sh`: requires protected env files before systemd work,
  rejects sensitive/runtime files in the source tree, removes implicit agent and
  Telegram enablement, and confines enable/start behavior to explicit `--start`.
- `deploy/rollback-release.sh`: validates state schema, creates a validated state
  and journal backup, daemon-reloads, and stops/disables every Viero unit without
  restarting autonomous trading.
- `deploy/check-state-schema.mjs`: validates the supported strategy-state schema
  and controls JSON before rollback.
- `deploy/backup-state.sh`: archives `/var/lib/viero` and `/var/lib/viero-signer`
  (including `transactions.jsonl`) and records a checksum with restrictive mode.
- `scripts/audits/phase431-deployment-contract.mjs`: isolated contract checks with
  a mocked `systemctl` log and temporary state directories.
- `scripts/audits/phase43-crash-recovery.mjs`: extended with post-broadcast journal
  failure, partial journal, disk-full/permission-denied simulations, and restart
  assertions.
- `docs/deployment/viero-controlled-deployment-runbook.md`: updated for the
  remediated installer, schema gate, and validated backups.

No manual LP or trading policy code was changed.

## Installer and rollback behavior

| Behavior | Before | After |
|---|---|---|
| Install without `--start` | Enabled agent/Telegram; could leave an activation path | Does not enable/start agent, Telegram, or signer; indexer remains stopped/disabled |
| Missing env files | Created guessed example files | Hard preflight failure before systemd operations |
| Sensitive files in source | `cp -a` could copy them | Refuses release copy |
| Rollback | Restarted agent automatically | Stops/disables all units; never starts/restarts autonomous trading |
| Rollback safety | No schema gate or state backup | Schema check plus checksum-validated state/signer-journal backup |

`--start` remains an explicit activation flag and is not used by this audit.

## Actual production journal lifecycle

For `LiveExecutor.write()` the current sequence is:

`simulateContract` → local sign/prepare → `eth_sendRawTransaction` → append
`broadcast` journal record → receipt wait → append `confirmed` journal record →
caller persists position/transaction state.

`journal()` uses synchronous append but catches and logs every filesystem error.
There is no pre-broadcast intent record, nonce reservation, journal replay, or
production recovery reader for `transactions.jsonl`. Consequently, after a
successful broadcast followed by journal failure, the hash exists only in memory;
the caller can report failure and a later management attempt may authorize again.
The same ambiguity exists after a confirmed receipt if the confirmed append fails.

Relay `acquire()`/`liquidate()` executes through the Relay SDK and returns hashes
to the caller, but does not use the signer journal. A process failure between Relay
broadcast and persisted strategy state is therefore also not durably recoverable.

## Journal failure-state matrix

| Boundary | Broadcast possible? | Durable evidence now | Safe retry? | Required outcome |
|---|---:|---|---:|---|
| Before `sendRawTransaction` / simulation failure | No | None needed | Yes after fresh plan | Fail normally; no journal entry |
| After send, before broadcast append | Yes | Hash only in memory | **No** | Mark operation ambiguous; block future authorization pending receipt investigation |
| Broadcast append fails | Yes | No reliable record | **No** | Same fail-closed ambiguous state; operator/on-chain lookup required |
| Receipt wait timeout | Yes | Broadcast record if append succeeded | **No** | Reconcile the recorded hash; never resend |
| Receipt success, confirmed append fails | Yes/confirmed | Broadcast record only | **No** | Reconcile receipt by hash; persist CLOSED idempotently |
| Position persistence fails after receipt | Yes/confirmed | Journal may contain confirmed record | **No** | Recovery replays confirmed receipt; no duplicate close/open |
| Relay swap after SDK broadcast before strategy persistence | Yes | No signer-journal record | **No** | Requires Relay operation intent/idempotency design |
| Partial/truncated journal | Maybe | Untrusted/incomplete | **No** | Preserve bytes and block execution |

Throwing on journal failure alone is not safe after broadcast: without a durable
operation identity and recovery reader it converts a known hash into an unknown
retry hazard. No speculative runtime change was made for this reason.

## Isolated validation

- Deployment contract harness: **8/8 checks passed**, 2 mocked `systemctl` calls,
  temporary directories only.
- Crash harness: **21/21 scenarios passed**, including pre/post-broadcast journal
  failures, partial journal, disk-full, permission-denied, concurrent recovery,
  unknown status, receipt timeout, and repeated restart.
- `npm run typecheck`: passed.
- `npm test`: 467 passed, 1 skipped, 0 failed.
- `npm run build`: passed.
- `bash -n deploy/*.sh`: passed.
- Real RPC calls/transactions: **0**.

The harness verifies the fail-closed protocol in child processes with fake state,
journals, RPC, and signer behavior. It does not claim production executor/recovery
coverage.

## Required next remediation (design first)

Before activation, design and test a durable operation record containing operation
ID, chain, position, nonce/request identity, intent, broadcast hash, receipt state,
and terminal status. It must be written durably before broadcast, block unresolved
operations across restarts, reconcile hashes independently, and support idempotent
Relay normalization. Add a real production-module isolated test before changing
`executor.ts` or `relay.ts`.

Until that design and implementation are separately reviewed, keep all services
disabled and `VIERO_EXECUTION_ENABLED=false`.
