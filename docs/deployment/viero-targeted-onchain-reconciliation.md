# Viero targeted read-only on-chain reconciliation

Inspection date: 2026-10-18 (Asia/Jakarta)

This was one bounded, read-only pass authorized for exactly one journal record
and 15 historical post-close normalization records. No signer or Relay endpoint
was invoked. No wallet key was read, no transaction was signed or broadcast,
and no VPS file, database, service, or configuration was modified.

## Verdict

**CONDITIONAL — OPERATOR DISPOSITION REQUIRED**

The only broadcast-only journal transaction is now resolved as a canonical,
deeply finalized **revert**, not a successful or pending economic action. All
15 affected close transactions are canonical successful receipts. Fourteen
normalization records have strong evidence that no normalization transaction
was executed (pre-execution Relay errors and no normalization hash). One BNB V3 record remains
`UNRESOLVED`: it is still locally `pending`, has zero attempts and no swap
hash, but the available evidence does not prove whether a normalization was
required or whether a balance changed independently.

Fresh-state initialization is defensible only after the operator explicitly
dispositions that one pending record, while preserving the historical archive.
This is not exhaustive on-chain reconstruction of all 130 positions.

## Authorization and source evidence

The inspected historical source files and checksums were unchanged from the
prior inspection:

| Path | SHA-256 |
|---|---|
| `/var/lib/viero/data/strategy-state.json` | `e05f2d3f8d12da14f0565b9c7ceec1c44406e45d38aa61a2658e890d6ce9dead` |
| `/var/lib/viero/data/controls.json` | `5046450ad561d1c146c1b3c6825250c8c9fcb5837b6fee9d3cc18d48390cbcde` |
| `/var/lib/viero-signer/transactions.jsonl` | `619f6c42a5c0d284cd9fb5a6182633734e1da358aa3fbf9f81845f4a31f39d3b` |

The legacy JSONL schema was interpreted as one lifecycle record per hash with
`status`, `chainId`, `hash`, `at`, and optional receipt fields. The legacy
source's Relay path performs quote/currency/amount validation before any
execution hash is recorded; this is relevant to the failed normalization
errors but is not treated as independent chain evidence.

## RPC identity and bounded usage

The existing configured endpoints were read privately on the VPS; no endpoint
or credential was printed. Both endpoint identities matched their requested
chain IDs:

| Chain | `eth_chainId` | Observed head during pass |
|---|---:|---:|
| Robinhood | 4663 | 91,108,380 |
| BNB | 56 | 128,211,522 |

Exactly 84 JSON-RPC requests were made, with no retries and no RPC errors:

| Method | Requests |
|---|---:|
| `eth_chainId` | 2 |
| `eth_blockNumber` | 18 |
| `eth_getTransactionByHash` | 16 |
| `eth_getTransactionReceipt` | 16 |
| `eth_getBlockByNumber` | 16 |
| `eth_getBlockByHash` | 16 |

No `eth_getLogs`, `eth_call`, transaction-count, or broad historical scan was
needed. Confirmation depth was evaluated against the chain configuration;
both target chains require three confirmations.

## Broadcast-only journal transaction

The exact hash was read internally from the one `broadcast`-only journal group
and is intentionally not reproduced here. Read-only results:

- Transaction lookup: found on chain 4663.
- Receipt lookup: found at block `73,390,331`.
- Receipt status: `0x0` (reverted).
- Receipt block hash: matched `eth_getBlockByNumber` and
  `eth_getBlockByHash`.
- Confirmations at inspection: 17,718,051; finality threshold satisfied.
- Sender and nonce were present; nonce was 3317.
- No replacement analysis is needed to explain the outcome: the original
  transaction itself is canonical and finalized as reverted.
- It was absent from the strategy transaction projection because the legacy
  projection contained only confirmed successful transaction records.

Classification: **CONFIRMED_REVERT_CANONICAL**.

This resolves the journal ambiguity as a failed historical transaction. It
does not prove that every associated business action was otherwise completed;
the position/normalization records remain the source for that separate check.

## Normalization records

The 15 records were identified from the October 10 strategy snapshot. Their
recorded normalization objects contained no exact normalization transaction
hash (`15/15`), so no swap receipt could be falsely inferred.

### Close-transaction evidence

Each record's recorded close transaction was looked up exactly. Results:

| Chain | Records | Canonical successful close receipts |
|---:|---:|---:|
| 4663 | 11 | 11 |
| 56 | 4 | 4 |

All 15 close receipts had successful status, matching canonical block hashes,
and sufficient confirmations. This verifies the close transaction itself, not
post-close normalization.

### Per-record disposition

| Historical status | Count | Disposition | Evidence |
|---|---:|---|---|
| `failed` | 14 | **VERIFIED_NOT_EXECUTED** | 13 records report the pre-execution error `Amount is too small to be swapped`; one reports `Unsupported currency`; all have zero recorded normalization hash. The legacy Relay implementation validates these conditions before `actions.execute()` can produce a transaction hash. |
| `pending` | 1 | **UNRESOLVED** | BNB chain 56, V3 token ID `7651090`; attempts `0`, no error, no normalization hash. The close is finalized, but the snapshot does not establish whether normalization was required, interrupted before quote/execute, or affected by an unrelated balance change. |

The 14 failed records are not classified as completed swaps. They are
classified as not executed because the errors are pre-execution validation
failures and there is no exact swap hash to verify. This is source-plus-record
evidence, not a claim that every possible unrelated transfer was reconstructed.

For auditability, the failed record identifiers were: chain 4663 V3 token ID
`1296861` (missing close reason), chain 4663 V3 `1306865`, chain 4663 V4
`3292662`, `3307052`, `3371400`, `3544795`, `3552761`, `3556039`, `3563615`,
`3571641`, `3625540`, and chain 56 V3 `7632039`, `7636406`, `7637411`.

The pending record remains unresolved by design. A zero balance or absence of
a local hash would not, by itself, prove completion or non-execution.

One failed record has no recorded `closeReason`; this is a historical schema
quality anomaly, but its close receipt is canonical and successful. It does not
create an open or closing position.

## Fresh-state eligibility assessment

The earlier inspection established 130 positions, all locally `closed`, with
no `open` or `closing` status. This pass adds independent chain evidence for
the one journal ambiguity and the 15 relevant close transactions. Therefore:

- **Resolved/archive-safe:** the broadcast-only transaction is a canonical
  revert; the 14 failed normalization records have no executable swap
  evidence and pre-execution failure causes.
- **Operator disposition required:** the one pending BNB V3 normalization
  record.
- **No active-position evidence:** none was found in the inspected state.

Do not import the legacy schema-v1 files into the active schema-v2 database.
Retain the three source files, the runs directory, and the September 24 archive
immutably. A fresh schema-v2 directory may be initialized only after the
operator records one of the following for token ID `7651090`:

1. independently verified `NOT_REQUIRED_WITH_EVIDENCE` or
   `VERIFIED_NOT_EXECUTED`, with the evidence retained; or
2. explicit risk acceptance that this historical normalization remains
   unresolved and will not be retried automatically.

No automatic swap, state rewrite, or migration was performed.

## Remaining operator actions

1. Preserve the historical files and checksums as an immutable archive.
2. Review the pending BNB V3 normalization record and its recorded target
   asset under the operator's historical-position evidence.
3. Record the disposition before fresh-state initialization.
4. Keep the old state out of the schema-v2 active directory unless a separately
   authorized migration is designed and verified.

The inspection stops here. No deployment authorization is implied.
