# Viero fresh-state deployment preparation

Date: 2026-10-17

Scope: local preparation plus read-only VPS metadata/checksum verification. No VPS file was changed, no database was initialized, no service was started or stopped, no production RPC or wallet was accessed, and no transaction was broadcast. The separate manual LP bot and shared Alchemy configuration were not modified.

## Verdict

**READY FOR AUTHORIZED VPS REMEDIATION**

The fresh-state plan is locally validated and the operator has supplied an explicit baseline attestation. Remaining work is controlled VPS remediation and deployment review: provision the supported runtime/configuration, preserve the historical archive, create a separately identified empty baseline only after the state gate is accepted, install the immutable artifact, and keep all services stopped until separate activation approval.

This is **not** a production-ready or autonomous-activation verdict. The operator attestation is not exhaustive on-chain evidence, and unresolved Relay/journal ambiguity must remain a deployment gate rather than being silently treated as settled.

## Operator attestation

The following facts are recorded as operator-provided assertions in the deployment request, not independently verified by this audit:

- Viero Agent remained active between 2026-09-24 and 2026-10-10.
- More than approximately 50 liquidity positions may have been opened and closed during that period.
- The operator personally checked historical positions through the Uniswap website.
- The operator confirms that all known historical Viero liquidity positions are closed.
- The operator authorizes preparation of a fresh-state deployment and does not want the 2026-09-24 schema-v1 strategy snapshot restored as the active production database.

Important limits:

- Closed Uniswap positions do not automatically prove that every Relay normalization/swap completed.
- They do not prove that every collect/claim completed or that no signer transaction was pending.
- The missing post-2026-09-24 strategy-state history remains an archival limitation.
- This report does not reconstruct the approximately 50 historical positions or claim an exhaustive ledger.

## Preserved legacy evidence

The VPS archive was checked read-only on 2026-10-17:

`/var/backups/viero-predeploy-2.0.4-20260924T155115Z.tar.gz`

Observed metadata:

- owner/mode: `root:root`, `0644`;
- size: `181,805,964` bytes;
- timestamp: `2026-09-24 23:52:09 +0800`;
- SHA-256: `91a271cd0f3a3734a8d3f5a3af10e704ab5739fc4fb9cf0f550c7e6fda4b25bb`.

The archive contains the legacy `/var/lib/viero/data` projection and run history. Its non-sensitive summary was two positions, both `closed`, with seven strategy transactions. It contains no signer SQLite, Relay SQLite, WAL/SHM, or legacy JSONL journal. This is retained historical evidence only; it must not be copied into the new active state directory.

Other known VPS backup locations are:

- `/var/backups/viero`
- `/var/backups/viero-pre-final-screen-20260923T120510Z`
- `/var/backups/viero-pre-fixed-range-20260923T130052Z`
- `/var/backups/viero-pre-fresh-range-20260923T132746Z`
- `/var/backups/viero-pre-planner-20260923T123959Z`
- `/var/backups/viero-pre-rules-20260923T122620Z`
- `/var/lib/viero.deploy-backup`

The bounded inventory found these as directories without readable state files. Their emptiness is not treated as proof that no later state existed.

### Preservation procedure

1. Keep the original archive immutable; do not overwrite, delete, extract over, or rename it.
2. Record the path, owner/mode, size, mtime, and checksum in the deployment record.
3. Store any working copy under a separate root-owned archival location, never under `/var/lib/viero` or `/var/lib/viero-signer`.
4. Keep historical evidence and the new active runtime directories separate.
5. Before installation, run the new read-only schema/journal checkers against any recovered copy, not against the empty fresh baseline.
6. Do not restore schema-v1 `strategy-state.json` into the new active directory. If it is ever reviewed, use a disposable copy and retain the original checksum.

## Fresh-state safety analysis

### Agent projection

`FileRepository` initializes `runs/` lazily and returns `emptyStrategyState()` when `strategy-state.json` is absent. This behavior is safe only after the operator-approved fresh baseline gate; missing state alone is not evidence of historical finalization. The new deployment must start with a deliberately empty, owner/mode-validated `/var/lib/viero` and an explicit deployment record stating that the old snapshot was not restored.

### Signer operation store

Local disposable tests show that a newly created signer operation store with no unresolved operations returns `startupRecovery() = READY`. Any PREPARED/SIGNED/BROADCAST_UNKNOWN/RECEIPT_PENDING or unacknowledged mint evidence returns a recovery hold (`RECONCILIATION_REQUIRED`/`BLOCKED`) and gates transaction-capable routes. No production store was initialized during this task.

### Relay operation store

Local tests show that an empty Relay store reports `READY`; unresolved `UNKNOWN`/`EXECUTING` records report `RECONCILIATION_REQUIRED` and cannot be replayed. The fresh baseline must therefore create or validate an empty signer-owned Relay store only after the historical evidence decision, with no automatic import from the old archive.

### Close workflows and projection acknowledgements

The local schema-v2 operation store has no unresolved close workflows or pending projection acknowledgements when initialized empty. Confirmed mints without agent acknowledgement and incomplete V3 remove/collect workflows remain blocked after restart. This preserves fail-closed behavior, but it does not identify operations that were already erased from the old host.

### Smallest safe baseline mechanism

No runtime code change was made. The smallest safe operational mechanism is a signed deployment record (kept outside the runtime state directories) containing:

- the preserved legacy archive checksum;
- the operator fresh-state attestation;
- explicit statement that the legacy snapshot is not restored;
- empty-baseline paths and owner/mode checks;
- empty signer/Relay schema-check results; and
- the candidate release manifest/checksum.

The installer must refuse to initialize or activate if this record is absent, if a recovered state file is present unexpectedly, or if any signer/Relay/journal checker reports unresolved evidence. This is an operator/deployment gate, not a claim that missing files are historically complete.

## Bounded historical-continuity checklist

Before accepting the fresh baseline, the authorized operator should:

1. Preserve and checksum the 2026-09-24 archive.
2. Review all archived position and transaction records in a disposable copy.
3. Compare the operator's Uniswap-checked position list against the archive and any Telegram transaction references available to the operator.
4. For any mismatch, retain the position-manager address, chain ID, token ID, and referenced transaction hash as targeted verification records; do not perform RPC in this task.
5. Confirm whether any post-2026-09-24 Relay normalization or manual action was outstanding. If uncertain, keep Relay recovery conditional and do not enable normalization.
6. Confirm the operator accepts the archival gap and the fresh baseline explicitly.

No complete ledger reconstruction is required unless this checklist reveals an unresolved position, nonce, receipt, Relay request, or close/collect mismatch.

## VPS remediation instructions

These are preparation instructions only; they were not executed.

### Runtime and configuration

1. **Node.js:** provision Node `>=24.15.0` for Viero only, using an isolated service/runtime path if possible. The prior VPS inspection observed Node `22.23.2`; do not change a system-wide Node installation without checking unrelated applications.
2. **Agent environment:** create `/etc/viero/viero.env` through the approved secret channel, owner `root:viero`, mode `0640` or stricter. Keep execution disabled and set the selected chain/RPC mapping explicitly. Never print values.
3. **Signer environment:** create `/etc/viero/signer.env` for the `viero-signer` unit, owner `root:viero-signer`, mode `0600` or stricter. Provide only required signer/evidence paths and safe configuration; never print keys.
4. **Stale drop-in:** review `/etc/systemd/system/viero-signer.service.d/relay.conf` and retire the `/etc/viero/viero-signer.env` reference only through an authorized configuration change. Do not silently leave a missing EnvironmentFile dependency.
5. **Token-first drop-in:** review `/etc/systemd/system/viero-agent.service.d/token-first.conf`; remove or reconcile old hardcoded chain/indexer overrides so selected-chain configuration remains dynamic. Keep the indexer disabled unless separately authorized.

### Storage, keys, and permissions

6. **Fresh storage:** after all Viero writers are stopped, create empty `/var/lib/viero` and `/var/lib/viero-signer` only after the signed fresh-baseline record is accepted. Do not restore the schema-v1 archive into those paths.
7. **Signer-owned stores:** initialize schema-v2 operation and Relay stores as `viero-signer:viero-signer`, mode `0700`; WAL/SHM companions must remain signer-owned and non-world-readable. The agent must access only the Unix socket, never the SQLite files.
8. **Evidence keys:** provision Ed25519 private material signer-side only and the corresponding public verification key agent-side, with ownership and mode checks. Do not place private evidence keys in releases, backups intended for the agent, or environment output.
9. **Socket:** after a separately approved signer-only start, verify `/run/viero-signer` ownership/mode and the socket owner/group/mode. While stopped, socket absence is expected. Socket reachability is not permission to trade.

### Release, backup, and rollback

10. **Immutable release:** package only the reviewed candidate with a file manifest, lockfile hash, build hash, and secret/runtime-file scan. Do not use the dirty checkout as an unidentified release.
11. **Pre-install backup:** take a quiescent, checksummed backup of the newly prepared empty state plus the preserved legacy archive reference. Include SQLite WAL/SHM and any legacy journal if present.
12. **Schema checks:** run read-only state, operation-store, Relay-store, and legacy-journal checkers before install and before rollback. An incompatible schema or unresolved journal is a hard stop.
13. **Passive installation:** install without `--start`; confirm all units remain stopped/disabled. Installation and activation are separate approvals.
14. **Rollback:** validate both target and previous release readers before changing symlinks. Rollback must preserve the stopped/disabled state and refuse incompatible schema/state.

Manual LP services and unrelated system-wide Alchemy configuration must remain outside this procedure.

## RPC optimization preservation

Local source and tests retain the approved Phase 1–3 protections:

- verified immutable token metadata caching;
- verified pool creation-evidence caching;
- observation-local historical memoization;
- cycle-scoped block-boundary caching;
- complete paginated log recovery;
- fresh independent signer authorization/confirmation checks; and
- workflow/chain/method RPC telemetry.

The offline benchmark remains **180 → 118 simulated requests** and **5,032 → 3,672 estimated CU**, with an identical result digest. These are deterministic local estimates, not Alchemy billing measurements or production savings.

## Local validation

| Check | Result |
|---|---|
| `npm test` | **509 pass, 0 fail, 1 skip, 510 total**; PostgreSQL integration skipped because `TEST_DATABASE_URL` was not provided |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| Empty signer store startup/recovery | PASS in disposable tests; `READY` with zero unresolved operations |
| Unresolved signer/recovery gates | PASS; unresolved states block transaction routes |
| Empty Relay store and ambiguity gates | PASS in disposable tests |
| Projection/close acknowledgement and restart tests | PASS in production-module fake-RPC/socket tests |
| Backup/schema/installer contract tests | PASS; no implicit service activation |
| Legacy VPS archive checksum | VERIFIED read-only; SHA-256 recorded above |
| Production RPC, wallet, service mutation | NOT RUN by design |

## Acceptance criteria for authorized deployment

Deployment review may proceed only when all are true:

- the operator signs/records the fresh-state baseline and legacy archive checksum;
- Node `>=24.15.0` is available to Viero without unsafe system-wide side effects;
- protected env files exist with correct owner/mode and execution remains disabled;
- stale signer/token-first drop-ins are reconciled;
- fresh agent, signer, and Relay storage passes read-only schema checks;
- no recovered journal/operation/Relay record is unresolved;
- Ed25519 evidence-key ownership and socket ACLs are verified;
- the immutable artifact manifest is reviewed and contains no secrets/runtime state;
- passive installation leaves all services stopped/disabled; and
- activation and autonomous trading remain separate, later approvals.

Until these gates are satisfied, the system is not production-ready and must remain stopped.
