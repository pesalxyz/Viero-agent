# Phase 4.3.2 Operation State Machine

Design only; no runtime behavior changed.

## States and transitions

| From → To | Preconditions and durable write | Side effects | Restart/retry rule |
|---|---|---|---|
| absent → PREPARED | Validated request; unique idempotency key committed | None | Existing key returns the same record; fingerprint mismatch blocks |
| PREPARED → SIGNED | Nonce reserved; exact signed payload/hash committed | Local signing only | Never sign a second payload for the same operation |
| SIGNED → BROADCAST_UNKNOWN | Submission returned transport error/timeout | Broadcast may have happened | Reconcile same nonce/hash; never create a new auth |
| SIGNED → BROADCAST_KNOWN | Raw submission returned hash; hash committed before receipt wait | One broadcast | Poll exact hash; no new transaction |
| BROADCAST_UNKNOWN → BROADCAST_KNOWN | Independent lookup discovers hash | None | Continue exact-hash reconciliation |
| BROADCAST_UNKNOWN → RECONCILIATION_REQUIRED | Hash cannot be proven after bounded lookup | None | Block all duplicate authorization; operator review |
| BROADCAST_KNOWN → RECEIPT_PENDING | Hash durable | Receipt reads | Retry reads only, never broadcast |
| RECEIPT_PENDING → CONFIRMED | Receipt success, block hash/finality verified | Projection may reconcile | Idempotent terminal projection |
| RECEIPT_PENDING → FAILED | Revert receipt verified | None | Terminal failure; policy may decide a new operation separately |
| CONFIRMED → RECONCILIATION_REQUIRED | Reorg/hash mismatch | Freeze projection | Reconfirm canonicality; never reauthorize blindly |
| CONFIRMED → TERMINAL | Required confirmations and projection commit | Position/normalization boundary updated | Replays are no-ops |
| any nonterminal → BLOCKED | Corrupt record, missing evidence, nonce conflict, signer mismatch | None | Manual intervention only |

`TERMINAL` is an operation-store state, not necessarily a closed position:
normalization is a separate operation and may remain pending after a confirmed
close.

## Recovery rules

- PREPARED without SIGNED: safe to abandon only if no signer submission occurred;
  otherwise require evidence that signing never began.
- SIGNED: recover by exact hash/nonce; no new signing.
- BROADCAST_UNKNOWN: query the chain by exact hash where available and inspect the
  signer nonce/pending pool; remain blocked when evidence is incomplete.
- RECEIPT_PENDING: retry read-only receipt/finality checks.
- CONFIRMED with stale strategy state: repair projection idempotently.
- Corrupt/truncated WAL: preserve bytes, stop execution, restore from a validated
  backup or operator-reviewed repair.
- Concurrent recovery workers: database lock plus compare-and-set transition;
  only one worker may advance a record.
- STOPPED control: suppress new authorization and normalization; reconciliation of
  already-broadcast operations remains read-only and safety-critical.

Fresh independent on-chain confirmation remains mandatory immediately before any
new close, rebalance, or emergency-close authorization. Reconciliation of an old
operation is not authorization of a new one.
