# Viero fresh-state deployment decision record

Decision date: 2026-10-18 (Asia/Jakarta)

This record is separate from the historical state files. It records the
operator's disposition for preparation only; it is not a signature, a
cryptographic approval, or authorization to install or activate services.

## Historical disposition

The operator confirms that all known historical LP positions were closed and
accepts the archival uncertainty for the one pending normalization record:

`UNRESOLVED_HISTORICAL_NORMALIZATION — OPERATOR_ACCEPTED_RISK`

Scope of accepted risk: BNB Chain (56), Uniswap V3, token ID `7651090`,
historical normalization status `pending`, attempts `0`, no recorded
normalization transaction hash. This disposition does **not** mark the record
complete, does **not** assert a zero residual balance, and authorizes no retry,
swap, or historical state mutation.

Historical inventory: 130 `CLOSED`, 0 `OPEN`, 0 `CLOSING`.

The one legacy signer broadcast-only transaction was reconciled as a canonical
revert. Fourteen normalization failures were classified as not executed from
pre-execution Relay errors and the absence of an exact normalization hash.

The September 24 backup remains preserved with SHA-256:

`91a271cd0f3a3734a8d3f5a3af10e704ab5739fc4fb9cf0f550c7e6fda4b25bb`

October 10 historical source checksums:

- `strategy-state.json`: `e05f2d3f8d12da14f0565b9c7ceec1c44406e45d38aa61a2658e890d6ce9dead`
- `controls.json`: `5046450ad561d1c146c1b3c6825250c8c9fcb5837b6fee9d3cc18d48390cbcde`
- `transactions.jsonl`: `619f6c42a5c0d284cd9fb5a6182633734e1da358aa3fbf9f81845f4a31f39d3b`

Fresh-state initialization does not erase, resolve, or import historical
economic obligations. The historical archive must remain immutable and
separate from the active schema-v2 paths.

## Fresh baseline

The disposable baseline manifest is
`docs/deployment/viero-fresh-state-baseline.json`. It requires:

- zero positions and zero strategy transactions;
- stopped controls with no enabled chains until separately configured;
- schema-v2 signer and Relay stores with zero unresolved records;
- zero pending projection acknowledgements and close workflows;
- signer-owned `0700` storage and a Unix-socket-only agent boundary;
- no schema-v1 import and no automatic normalization retry.

The baseline was instantiated only under a disposable local temporary
directory. No production database was initialized.

## Operator boundary

This record does not authorize VPS installation, configuration provisioning,
systemd reload, service start/stop, signer invocation, wallet access, RPC
execution, transaction broadcast, or Git commit/push.
