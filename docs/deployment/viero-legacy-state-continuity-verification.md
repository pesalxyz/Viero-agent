# Viero legacy state-continuity verification

Date: 2026-10-17

Scope: read-only inspection of the stopped Viero VPS at `ubuntu@43.156.128.196:443` and the source maps/package corresponding to the previously deployed release. No service operation, file mutation, deployment, production RPC call, wallet access, signer invocation, or transaction was performed. The separate manual LP bot was not inspected.

## Final classification

**C — STATE CONTINUITY UNVERIFIED**

The evidence proves that a dated backup existed with a quiescent legacy strategy snapshot whose recorded positions were both closed. It does **not** prove that this was the final Viero state, that no later position was opened, or that every later transaction was finalized before the live files disappeared. Therefore the missing live files are not safe to interpret as an empty, reconciled state.

The minimum next action before deployment is to preserve and review the dated backup as the authoritative recovery candidate, reconcile its complete transaction/position history, and obtain a later quiescent state/backup (or an operator attestation that no Viero activity occurred after that backup). Do not install or activate the new release until this continuity gate is explicitly accepted.

## Legacy persistence architecture

The deployed package at `/opt/viero/current` is version `2.0.4` and advertises `node >=20.0.0`. Its source maps expose the relevant source paths under `../../src/viero/`.

### Agent state and run history

The embedded `src/viero/storage/repositories.ts` implementation has two persistence modes:

- `FileRepository`, selected by default when `DATABASE_URL` is absent, stores state under `VIERO_DATA_DIR` (default `data/viero`). It creates `runs/` lazily and writes `strategy-state.json`, `controls.json`, `latest.json`, and run JSON files with an atomic temporary-file/rename operation.
- `PostgresRepository`, selected only when `DATABASE_URL` is set, stores runs and strategy state in PostgreSQL tables (`viero_agent_runs`, `viero_observations`, `viero_decisions`, `viero_controls`, and `viero_strategy_state`).

The legacy `strategyState()` path returns an empty state when `strategy-state.json` is absent. There is no delete/unlink/cleanup operation for that file in the deployed repository source map. `setStrategyState()` writes the complete state, including active and closed positions, transactions, lessons, blacklist and controls.

### Active versus closed positions

The embedded `src/viero/execution/liveState.ts` schema stores `positions` with status `open`, `closing`, or `closed`, and stores transaction records separately in the same strategy state. The legacy close path in `src/viero/execution/executor.ts` returns a position with `status: 'closed'` after the V3 decrease/collect sequence or the V4 decrease/collect transaction. The worker then assigns that value back into `state.positions[index]` and persists the state. The close path does not remove the position from the array.

Consequences:

1. A successful close was retained as a closed historical position in `strategy-state.json` (or the PostgreSQL projection).
2. The same state also retained the execution transaction records and close reason/realized-PnL fields.
3. A last-position close does **not** legitimately make `strategy-state.json` disappear. The file may be absent on a never-executed/fresh data directory, after an external cleanup or replacement, or if another persistence backend was used, but absence is not a documented close behavior.
4. The legacy source has no separate closed-position archive in the file backend. Run history is separate, but `AgentRun.positions` is the run snapshot rather than a durable replacement for live strategy state.

### Journals, signer SQLite, and Relay state

The deployed `build/viero/signer-server.js` contains the legacy `VIERO_SIGNER_TX_JOURNAL`/`transactions.jsonl` path but no `operations.db`, `relay-operations.db`, SQLite, or `SignerOperationStore` symbols. The embedded executor journal is best-effort append logging: it creates the parent directory and appends after transaction lifecycle events, logging an error if the append fails. It is not the authoritative position store and is only created after a relevant transaction path reaches the journal call.

The deployed package's legacy repository source contains no signer SQLite or Relay-operation database implementation. Therefore absence of those databases is consistent with the previously deployed version, but it does not establish that no transaction was outstanding. The new local implementation is materially different: it introduces signer-owned SQLite operation/Relay stores and explicit recovery gates; those stores cannot be inferred from the old release's absence.

### Partial-close risk in the legacy path

The legacy V3 executor performs decrease-liquidity, then collect, then an optional cosmetic NFT burn. The worker persists the returned closed position only after the executor returns. A process failure between an on-chain step and the later state write could therefore leave the file projection stale or absent of the completed step. The old path did not have the newer durable per-step `close_workflows`/operation records. Missing state files cannot prove that no such interruption occurred.

## Read-only VPS inventory

Inspection timestamp: 2026-10-17 (Asia/Jakarta).

### Live locations

| Location | Observation | Classification |
|---|---|---|
| `/var/lib/viero` | Exists, mode `0700`, owner `viero:viero`; no files were present | VERIFIED |
| `/var/lib/viero-signer` | Exists, mode `0700`, owner `viero-signer:viero-signer`; no files were present | VERIFIED |
| `/var/backups/viero` | Exists, mode `0700`, owner `root:root`; no files were present directly | VERIFIED |
| `/var/lib/viero.deploy-backup` | Exists, mode `0700`, owner `root:root`; no state files were found | VERIFIED |
| `/run/viero-signer/viero.sock` | Absent while signer is stopped | EXPECTED/VERIFIED |
| `/opt/viero/current` | Resolves to `2.0.4-20261006T140022Z` | VERIFIED |
| `/opt/viero/previous` | Resolves to `2.0.4-20261004T141120Z` | VERIFIED |

No `strategy-state.json`, `controls.json`, `latest.json`, run files, signer SQLite database/WAL/SHM, Relay database/WAL/SHM, or `transactions.jsonl` was present in the live Viero state directories.

### Backups and archived state

The VPS contains a root-owned, mode `0644` archive:

`/var/backups/viero-predeploy-2.0.4-20260924T155115Z.tar.gz`

Observed metadata: 181,805,964 bytes; timestamp `2026-09-24 23:52:09 +0800`; SHA-256 `91a271cd0f3a3734a8d3f5a3af10e704ab5739fc4fb9cf0f550c7e6fda4b25bb`.

Only archive metadata and the non-secret strategy-state/controls summaries were inspected. Environment-file contents were not read. The archive contains:

- `var/lib/viero/data/strategy-state.json`
- `var/lib/viero/data/controls.json`
- `var/lib/viero/data/latest.json`
- a large `var/lib/viero/data/runs/` history
- no `var/lib/viero-signer/operations.db`, `relay-operations.db`, WAL/SHM files, or `transactions.jsonl` entries

The archived strategy-state summary is:

| Field | Value |
|---|---:|
| Schema version | 1 |
| Positions | 2 |
| Open | 0 |
| Closing | 0 |
| Closed | 2 |
| Closed reasons | `SPOT_PRICE_DIVERGENCE`: 1; `FAR_ABOVE_RANGE`: 1 |
| Strategy transactions | 7 (`approve` 1, `mint` 2, `decrease` 2, `claim` 1, `burn` 1) |
| Lessons | 2 |
| Blacklist entries | 4 |
| Controls bot state | `STOPPED` |
| Enabled chains | `4663` |

This is useful historical evidence, not proof of the final state after 2026-09-24. The archive is also not a replacement for the new signer operation store because it contains no signer-owned SQLite evidence.

Additional dated backup directories under `/var/backups` and `/var/lib/viero.deploy-backup` were present as directories, but no readable state files were found in them during the bounded inventory. Their empty directory metadata does not establish whether files were removed before inspection.

## Close-semantics answers

1. **Was an active position removed after a successful close?** No. The deployed legacy worker replaces the position with a `closed` value and persists the array; it does not delete the record.
2. **Was historical state retained elsewhere?** Closed positions and execution transactions were retained in `strategy-state.json`/PostgreSQL. Run JSON files also exist, but are run snapshots, not a guaranteed close ledger.
3. **Could the entire strategy-state file legitimately disappear after the last position closed?** Not from the observed legacy close code. It was created lazily and then rewritten; no normal close cleanup deletes it.
4. **Were signer and Relay databases expected in the deployed version?** No evidence of those SQLite stores exists in the deployed bundle; the old signer bundle exposes only the optional JSONL journal path. Their absence is therefore legacy-compatible, but not evidence that every operation finalized.
5. **Were journals created only after the first relevant transaction?** Yes. The journal append path creates the file on demand; there is no reason for it to exist on a fresh/no-transaction deployment.
6. **Could a partial close leave untracked economic state?** Yes. The old multi-step V3 close had no durable per-step close workflow; a crash between broadcast/confirmation and later projection persistence could leave stale local state. The newer local implementation specifically adds durable remove/collect evidence to address this class of failure.
7. **What evidence shows prior positions were fully closed?** The 2026-09-24 archive records two positions as `closed` and includes their decrease/claim/burn transaction records. That is strong snapshot evidence for those two positions at that backup time, but it is not independent finality verification and does not cover activity after the snapshot.

## Remaining uncertainty and required action

The current host is stopped and contains no inspectable live state. The dated archive establishes a historical closed snapshot, but the gap between 2026-09-24 and the current empty directories is unresolved. In particular, we cannot determine from filenames/metadata whether:

- the archive was the final operational snapshot;
- a later release or manual cleanup replaced `/var/lib/viero`;
- a later position was opened and closed after the archive;
- a transaction journal or signer state existed temporarily and was removed; or
- a partial close occurred after the archive and before shutdown.

Before any deployment, the operator must choose and document one of these safe paths:

1. **Recovery path:** preserve the archive immutably, validate its checksum, inspect all run/position/transaction records using the new read-only checkers, reconcile any position/transaction identity evidence, and migrate only after the new release's schema gates pass.
2. **Fresh-host path:** obtain an explicit operator attestation that no Viero activity occurred after the archive and that the host is intentionally reset, retain the archive for rollback/audit, and record that no unresolved historical state can be recovered locally.

If position identities from the archive need independent verification, use only the non-secret position-manager address, chain ID, and token ID recorded in a quiescent copy, then perform a separately authorized read-only on-chain verification. No such RPC verification was performed in this task.

## Conclusion

The missing signer/Relay databases are normal for the legacy bundle because that deployed version did not implement those SQLite stores. The missing live `strategy-state.json` and journal are **not** explained by normal successful position-close behavior: the legacy code retained closed positions and wrote state atomically, while the journal was merely lazy/best-effort. Because a dated backup exists but is not proven to be the final snapshot, the correct overall decision is **C — STATE CONTINUITY UNVERIFIED**, not “expected empty legacy state.”
