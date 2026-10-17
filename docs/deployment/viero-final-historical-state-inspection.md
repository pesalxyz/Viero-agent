# Viero final historical state inspection

Inspection date: 2026-10-18 (Asia/Jakarta)

Scope: one bounded, read-only inspection of the stopped Viero VPS at
`ubuntu@43.156.128.196:443`. No file was modified, created, renamed, deleted, or
restored. No service, signer, Relay, wallet, production RPC, transaction, or
manual-LP host was accessed. Values that could identify wallets, tokens, or
transactions are intentionally not reproduced.

## Verdict

**CONDITIONAL — TARGETED RECONCILIATION REQUIRED**

The strategy projection is internally consistent as a position inventory: all
130 recorded positions are `closed`, with no `open`, `closing`, or other status.
The V3 action totals also form complete decrease/claim/burn sets. However, the
legacy signer journal contains one hash with `broadcast` and no `confirmed`
record, and that hash is absent from the strategy transaction projection. One
closed position also has post-close normalization `pending`; 14 others are
`failed` normalization records. These are not proof of an on-chain loss, but
they are unresolved historical evidence under the deployment runbook. Fresh
state must not be accepted until the one journal hash and the pending/failed
normalization records are reconciled or explicitly dispositioned and preserved.

This is not an exhaustive on-chain verification.

## Inspected files and integrity

The following metadata and SHA-256 values were read from the VPS. Ownership is
shown by the system account names (numeric IDs were also verified remotely).

| Path | Owner/mode | Bytes | VPS mtime (+08) | SHA-256 |
|---|---|---:|---|---|
| `/var/lib/viero/data/strategy-state.json` | `viero:viero`, `0600` | 893,427 | 2026-10-10 23:22:07 | `e05f2d3f8d12da14f0565b9c7ceec1c44406e45d38aa61a2658e890d6ce9dead` |
| `/var/lib/viero/data/controls.json` | `viero:viero`, `0600` | 779 | 2026-10-10 23:22:14 | `5046450ad561d1c146c1b3c6825250c8c9fcb5837b6fee9d3cc18d48390cbcde` |
| `/var/lib/viero-signer/transactions.jsonl` | `viero-signer:viero-signer`, `0600` | 132,251 | 2026-10-10 23:22:07 | `619f6c42a5c0d284cd9fb5a6182633734e1da358aa3fbf9f81845f4a31f39d3b` |

`/var/lib/viero/data/runs/` contained 5,159 JSON files and 689,433,180
bytes. A deterministic manifest hash (sorted basename plus each file's
SHA-256) was `9076a8b9769d48a826f07c384b4d6cab6f80812431701a8c9e14f449d910ba56`.
The latest run file parsed successfully. The bounded run inspection did not
parse every historical run payload; the manifest nevertheless covers every
run file's bytes. The latest numeric run prefix was 2026-10-10 23:18:15 +08;
its status was `degraded` and it contained zero positions in its `positions`
snapshot. The strategy state was written a few minutes later.

## Strategy state

The legacy schema is version 1 with top-level state, position, transaction,
lesson, blacklist, and notification data. The state contained 130 positions:

| Chain | Protocol | Closed |
|---:|---|---:|
| 4663 | V3 | 6 |
| 4663 | V4 | 83 |
| 56 | V3 | 40 |
| 56 | V4 | 1 |

Status counts were `closed: 130`; `open: 0`; `closing: 0`; other statuses: 0.
The latest position activity was an `updatedAt` record at 2026-10-10
23:22:07.460 +08. Close reasons were: `OUT_OF_RANGE_TIMEOUT` 75,
`FAR_ABOVE_RANGE` 23, `TAKE_PROFIT` 14, `STOP_LOSS` 9,
`TRAILING_TAKE_PROFIT` 4, `MANUAL` 3, and `SPOT_PRICE_DIVERGENCE` 1.

The state transaction projection contained 491 records and every one had
status `confirmed`. Actions were: `mint` 130, `decrease` 130, `approve` 98,
`claim` 46, `burn` 46, and `swap` 41. The latest projected transaction was a
confirmed `burn` at 2026-10-10 23:22:07.438 +08.

The V3 subset is internally consistent: 46 V3 positions have 46 decrease,
46 claim, and 46 burn records. The V4 subset has 84 positions and does not
require the V3 claim/burn pair in this legacy model. This is projection-level
evidence only; it does not establish independent blockchain finality.

## Controls and run history

`controls.json` reported `botState: STOPPED`, `globalPaused: false`, and
`enabledChains: [56]` at the snapshot. This is a historical control value, not
proof that no activity occurred before the final write. The run directory's
latest recorded run and the strategy-state timestamps both end on October 10;
no later Viero run/state timestamp was found in the inspected paths.

The source interpretation is the legacy `FileRepository`/`liveState` behavior
documented in `viero-legacy-state-continuity-verification.md`: closed positions
remain in `strategy-state.json`; a normal close does not delete the file.
Therefore this October 10 state is a real retained historical snapshot, not an
ordinary empty-state result.

## Signer journal and unresolved records

The legacy JSONL schema is one record per lifecycle event with fields equivalent
to `status`, `chainId`, `hash`, `at`, and (for confirmation) `blockNumber` and
`receiptStatus`; it has no operation ID or idempotency key. The parser found:

- 833 valid JSON records; 0 malformed lines.
- 417 distinct transaction hashes: 416 `broadcast -> confirmed`, and 1
  `broadcast` only.
- Confirmed receipts: 416, all with `receiptStatus: success`.
- Chains represented: 254 hashes on chain 4663 and 163 on chain 56.
- The unresolved broadcast occurred at 2026-09-27 05:03:49 +08 on chain 4663.
- Its hash was **not** present in the 491-record strategy transaction
  projection.

Because the legacy journal has no operation identity beyond the hash, the
unresolved record cannot be safely classified as failed, replaced, or
confirmed without targeted exact-hash/nonce and canonicality verification.
Missing confirmation is not proof of failure.

## Post-close normalization and Relay references

The position projection records normalization status as follows:

- `complete`: 59
- `not-required`: 56
- `failed`: 14
- `pending`: 1

The one `pending` record is on chain 56, V3. The failed records are 11 on
chain 4663 and 3 on chain 56. These records are attached to positions already
marked closed; they do not create an `open`/`closing` position in the local
projection. They do, however, represent post-close balance-normalization work
that the legacy worker was designed to retry from observed balances. No Relay
SQLite store exists in this legacy schema, so no stronger Relay execution
evidence can be inferred from this inspection.

The correct disposition is to preserve these records and independently inspect
the pending/failed normalization evidence before importing or discarding the
history. Do not re-run a swap merely because a local status is pending/failed.

## Relationship to the September 24 backup

The previously preserved archive
`/var/backups/viero-predeploy-2.0.4-20260924T155115Z.tar.gz` remains unchanged;
its SHA-256 is
`91a271cd0f3a3734a8d3f5a3af10e704ab5739fc4fb9cf0f550c7e6fda4b25bb` and its
size is 181,805,964 bytes. Its inspected summary contained 2 closed positions,
7 confirmed strategy transactions, and no signer JSONL/SQLite store. The
October 10 snapshot is later and substantially more complete (130 closed
positions and 833 signer-journal records), so it supersedes the September 24
snapshot as the latest internally recorded state. The older archive must still
be retained as an immutable historical predecessor; it is not safe to merge it
into the new schema-v2 active database.

The timestamp gap is therefore resolved as a *record-order* matter (October 10
is later), but not as an on-chain finality matter. The unresolved journal hash
and normalization records are the remaining continuity uncertainty.

## Fresh-state decision and safe archival position

It is defensible to preserve the October 10 files as an immutable historical
archive and initialize a separate fresh schema-v2 directory **only after**:

1. exact-hash/nonce/canonicality reconciliation of the one broadcast-only
   journal record;
2. a documented disposition of the one pending and 14 failed normalization
   records; and
3. an operator record stating that the old files are retained and are not
   imported into the active schema-v2 store.

No production RPC or signer call was made here, so those checks remain
outstanding. Until then, treating the active state as safely empty would be
premature.

## Remaining uncertainty

- No exhaustive on-chain verification was performed.
- The legacy journal lacks operation IDs, nonce fields, and a durable intent
  state machine; ambiguity cannot be eliminated from JSONL alone.
- A local `confirmed` projection is not independent finality evidence.
- Normalization failure records do not prove that a swap is still economically
  required, but they also do not prove that it is complete.
- No signer/Relay SQLite databases were expected in the legacy release and none
  were used to resolve the pending records.

The bounded inspection therefore stops at the conditional verdict above.
