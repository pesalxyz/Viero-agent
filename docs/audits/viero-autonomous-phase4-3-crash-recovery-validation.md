# Viero Phase 4.3 Isolated Crash-Recovery Validation

Date: **2026-10-17**
Command: `node scripts/audits/phase43-crash-recovery.mjs`

## Scope and isolation

The harness uses child Node processes, a temporary directory under the operating
system temp directory, a fake signer journal, and deterministic fake receipts. It
does not import viem/Viero, read environment secrets, open a socket, use an RPC,
access a wallet, or broadcast. Production services were not started or changed.

This is a process-boundary protocol harness, not a claim that the production
signer has been destructively tested. Production F4 remains a separate controlled
test requiring an isolated VM/container.

## Results

**17/17 scenarios completed; all assertions passed; 0 transactions; 0 network
requests.** Every recovery process exited 0 after returning a conservative outcome.

Executed scenario names: `before-intent`, `after-intent`, `after-broadcast`,
`after-hash`, `after-receipt`, `during-reconciliation`,
`after-close-before-persist`, `during-normalization`, `during-journal-append`,
`during-atomic-write`, `duplicate-scheduler`, `concurrent-recovery`,
`storage-failure`, `truncated-journal`, `unknown-status`, `receipt-timeout`,
and `restart-cycles`.

| Scenario group | Result |
|---|---|
| Before/after intent persistence | Unbroadcast intent is reset to OPEN; no authorization exists. |
| Broadcast acknowledgement/hash uncertainty | `blocked:ambiguous-transaction`; state is never reopened or re-authorized. |
| Receipt confirmation and close persistence | `reconciled-confirmed`; CLOSED convergence is idempotent. |
| Reconciliation and receipt timeout/unknown status | Fail closed pending evidence. |
| Normalization boundary | Close remains CLOSED and normalization is isolated as a separate pending step. |
| Journal append/atomic-write/storage failure | No partial authorization is invented; state remains safe/open or recovery blocks. |
| Duplicate scheduler and two concurrent recovery processes | Duplicate authorization is detected and blocked; no second broadcast is created. |
| Truncated journal | `blocked:truncated-journal`; evidence is not silently discarded. |
| Repeated restart cycle | Confirmed receipt converges to CLOSED without duplicate authorization. |

The JSON output is intentionally local and contains only the fake hash
`0xfake`; it contains no production identifiers.

## Safety invariants exercised

- no duplicate authorization/broadcast/position creation;
- ambiguous transaction state fails closed;
- journal evidence is preserved;
- confirmed receipts reconcile idempotently;
- missing evidence blocks recovery;
- close and normalization are separate boundaries;
- the harness never changes a STOPPED control.

## Important limitations and open defects

The harness is independent by design, so it cannot prove that every production
path reaches these exact persistence boundaries. A production code-integrated F4
test is still required before activation. Source review also found that production
signer journal write failures are logged by the executor rather than making the
operation fail closed; this is a **high-priority reliability concern** to remediate
and test separately, but it was not silently changed in this audit.

Future isolated tests must run with disposable fake RPC/signer transports and no
production filesystem. They must cover the real executor/recovery modules before
any production service is enabled.
