# Viero VPS environment remediation

Date: 2026-10-18 (Asia/Jakarta)

Scope: authorized Viero VPS environment remediation only. No Viero release was installed, no active/previous release symlink was changed, no Viero service was started/stopped/restarted/enabled/disabled/reloaded, no database was initialized, no wallet/signer credential was accessed, no production RPC or transaction was performed, and the separate manual LP VPS was not accessed.

## Verdict

**PARTIALLY READY — OPERATOR INPUT REQUIRED**

The isolated Node.js runtime and Viero-only drop-in cleanup completed safely. However, post-change verification found unexpected historical Viero runtime state that was not present in the prior inventory: a strategy projection, transaction journal, extensive run history, and control/archive files. Per the authorization, no storage was overwritten or cleared. Fresh-state initialization is therefore halted until the operator identifies and preserves this state and explicitly decides whether it is the authoritative post-October-10 state or must be archived separately.

The environment is not ready for release installation or activation until that state-continuity decision and protected configuration review are completed.

## Verified VPS identity and pre-change inventory

Host identity matched the previously verified Viero VPS:

- Hostname: `VM-0-2-ubuntu`
- Machine ID: `fd410411419d40079742fdbc36dec028`
- SSH endpoint: `ubuntu@43.156.128.196:443`
- Architecture: x86_64 Ubuntu Linux
- System Node before remediation: `/usr/bin/node` `v22.23.2`
- System Node SHA-256: `3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327`
- Disk before remediation: approximately 20 GiB available
- Memory before remediation: approximately 1.4 GiB available; swap enabled
- All four Viero services: inactive, disabled, restart count 0
- `/var/lib/viero`: `0700`, `viero:viero`
- `/var/lib/viero-signer`: `0700`, `viero-signer:viero-signer`
- Current release: `/opt/viero/releases/2.0.4-20261006T140022Z`
- Previous release: `/opt/viero/releases/2.0.4-20261004T141120Z`

No service, timer, or Viero process was active during the changes.

## Exact changes made

### Isolated Node.js runtime

The official Node.js `v24.15.0` Linux x64 archive was downloaded from the official Node distribution endpoint and verified against its published SHA-256 manifest before installation.

Installed path:

`/opt/viero/node-v24.15.0`

Verification:

- `node --version`: `v24.15.0`
- architecture: `x64`
- `node:sqlite`: passed an in-memory create/insert/select/close check
- Node binary SHA-256: `d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c`
- ownership/mode: `root:root`, executable mode `0755`
- system-wide `/usr/bin/node` remained `v22.23.2` with the same pre-change checksum

The runtime is isolated; no global `PATH`, npm installation, or unrelated application was changed. Temporary upload archives were removed. A failed partial extraction was quarantined as `/opt/viero/node-v24.15.0.partial-20261018T0110Z`; it is root-owned and not referenced by any service.

### Viero systemd drop-ins

Both obsolete Viero-only drop-ins were backed up and retired. No daemon reload was run.

1. `/etc/systemd/system/viero-signer.service.d/relay.conf`
   - Before SHA-256: `a34a06775f6f9b4cefac610e5dac00d4496426708d599fa79686df0038a9e4f9`
   - Before content: only `EnvironmentFile=/etc/viero/viero-signer.env`, which was an unresolved stale dependency.
   - Backup: `/var/backups/viero/viero-signer-relay.conf.before-20261017T170948Z`
   - Backup mode/owner: `0600`, `root:root`
   - After state: absent.

2. `/etc/systemd/system/viero-agent.service.d/token-first.conf`
   - Before SHA-256: `d7a7c5aa9c912305cb388fa8781de354f67cd60fe7e760d696389af127ddcfa1`
   - Before content: Viero-only `ExecStart`/`ExecStartPre` overrides that injected empty indexer variables and bypassed the candidate unit's normal command path.
   - Backup: `/var/backups/viero/viero-agent-token-first.conf.before-20261017T171009Z`
   - Backup mode/owner: `0600`, `root:root`
   - After state: absent.

The remaining Viero unit files were inspected statically with `systemctl cat`; no reload was performed, so any systemd manager cache refresh remains a deployment-time action.

### Non-secret preparation only

Created:

- `/etc/viero/requirements.manifest`: mode `0600`, `root:root`, SHA-256 `7794b34dfaeeb4e3cca6a30109c826e65b6be0377cd58f9e194a773810d6a664`.
- `/etc/viero/evidence`: mode `0750`, `root:viero-signer`.
- `/run/viero-signer`: mode `0750`, `root:viero-signer`, with no socket created.

The manifest contains variable names/statuses only. It contains no RPC URLs, API keys, Telegram tokens, wallet keys, or placeholder credentials.

No live environment file was created or edited by this remediation. The agent and signer environment files were not read.

## Unexpected state discovered after remediation

The prior pre-deployment inventory reported the following paths absent. During post-change verification they were present; their provenance is unknown and their contents were not read:

| Path | Metadata observed |
|---|---|
| `/etc/viero/viero.env` | `0640`, `root:viero`, 1326 bytes, mtime 2026-09-24 01:52:38 +0800 |
| `/etc/viero/signer.env` | `0600`, `root:viero-signer`, 355 bytes, mtime 2026-09-23 01:20:55 +0800 |
| `/var/lib/viero/data/strategy-state.json` | `0600`, `viero:viero`, 893,427 bytes, mtime 2026-10-10 23:22:07 +0800 |
| `/var/lib/viero-signer/transactions.jsonl` | `0600`, `viero-signer:viero-signer`, 132,251 bytes, mtime 2026-10-10 23:22:07 +0800 |

Additional names observed under the protected state directories included:

- `/var/lib/viero/data/runs/` with extensive run history;
- `strategy-state.json.pre-jolly-reconcile-20260925T0540Z`;
- `controls.json` plus several dated control backups and a temporary control file;
- `/var/lib/viero/blocked-tokens.json`; and
- `/var/lib/viero/indexer/`.

These files were not moved, deleted, opened, hashed, or overwritten. Their presence means the fresh-state storage gate is **blocked pending operator review**. The exact active configuration values and state contents remain intentionally undisclosed.

## Legacy archive integrity

The preserved archive remained unchanged before and after remediation:

`/var/backups/viero-predeploy-2.0.4-20260924T155115Z.tar.gz`

- Expected and observed SHA-256: `91a271cd0f3a3734a8d3f5a3af10e704ab5739fc4fb9cf0f550c7e6fda4b25bb`
- Size: `181,805,964` bytes
- Owner/mode: `root:root`, `0644`

It was not extracted or restored.

## Evidence keys and socket readiness

Prepared filesystem ownership only. No Ed25519 key was generated or read, no wallet/signing key was accessed, and no Unix socket was opened. Future provisioning must provide:

- signer-side private Ed25519 evidence key readable only by `viero-signer`;
- agent-side public verification key readable by `viero`;
- signer-owned operation/Relay databases and WAL/SHM with mode `0700` directory protection;
- `/run/viero-signer` parent ownership/mode suitable for the approved agent group; and
- socket ACL verification after a separately authorized signer-only start.

## Post-change safety validation

- Correct Viero VPS: **VERIFIED**; host and machine ID matched.
- Four Viero services inactive/disabled: **VERIFIED**.
- No Viero trading process or timer: **VERIFIED**.
- System Node unchanged: **VERIFIED**.
- Isolated Node `>=24.15.0`: **VERIFIED**.
- `node:sqlite`: **VERIFIED**.
- Drop-in backups protected and checksummed: **VERIFIED**.
- Legacy archive checksum unchanged: **VERIFIED**.
- Current/previous release symlinks unchanged: **VERIFIED**.
- No Viero release installed: **VERIFIED**.
- No production database initialized by this task: **VERIFIED**.
- No signer socket opened: **VERIFIED**.
- No production RPC, wallet operation, or blockchain transaction: **VERIFIED**.
- Manual LP VPS accessed: **NO**.
- Shared Alchemy configuration changed: **NO**.

## Remaining blockers and required operator action

1. **Unexpected state continuity:** preserve the newly observed state in place and have the operator identify whether it is the authoritative final state after October 10. Do not initialize fresh stores, delete files, or overwrite the projection.
2. **Environment-file provenance:** an authorized operator must validate the existing `/etc/viero/viero.env` and `/etc/viero/signer.env` through the approved secret/configuration process. This report intentionally does not inspect their values.
3. **Fresh-state decision:** only after state review may the operator explicitly choose fresh-state initialization; the old strategy state must not be silently loaded or discarded.
4. **Deployment-time daemon reload:** because no `systemctl daemon-reload` was authorized, the drop-in retirement becomes effective to systemd only in the separately authorized installation procedure.
5. **Release installation and activation:** still not performed and require separate authorization, immutable artifact review, schema checks, backup, and staged activation gates.

Do not proceed to deployment while the unexpected state is unresolved. No automatic rollback was attempted because it could overwrite or obscure evidence.
