# Viero VPS pre-deployment verification

Date: 2026-10-17. Inspection was read-only over the established SSH connection to `ubuntu@43.156.128.196:443`. No service operation, configuration write, deployment, signer start, wallet access, RPC request, or transaction was performed.

## Deployment readiness

**CONDITIONAL — OPERATOR ACTION REQUIRED**

The VPS is safely stopped, but prerequisites must be corrected before installation:

1. Upgrade/provision a supported Node.js runtime (minimum 24.15.0; observed 22.23.2).
2. Provision `/etc/viero/viero.env` and `/etc/viero/signer.env` through the approved secret process with required ownership/modes. Do not create them from this report.
3. Remove or explicitly retire the stale signer drop-in reference to `/etc/viero/viero-signer.env` through an authorized configuration change.
4. Install the reviewed candidate only after the local artifact and configuration gates pass.

## A. VPS inventory

| Check | Result | Evidence |
|---|---|---|
| OS/architecture | VERIFIED | Ubuntu Linux, x86_64, kernel 6.8.0-124-generic |
| `viero-agent.service` | VERIFIED safe-stopped | `inactive`, `disabled`, restart count 0, user/group `viero:viero` |
| `viero-telegram.service` | VERIFIED safe-stopped | `inactive`, `disabled`, restart count 0, user/group `viero:viero` |
| `viero-signer.service` | VERIFIED safe-stopped | `inactive`, `disabled`, restart count 0, user/group `viero-signer:viero` |
| `viero-indexer.service` | VERIFIED safe-stopped | `inactive`, `disabled`, restart count 0, user/group `viero:viero` |
| Viero timers/processes | VERIFIED none observed | No Viero timer or running Viero service process observed; the inspection shell itself was the only matching transient process |
| Node.js | FAILED | `v22.23.2`; local release requires `>=24.15.0` |
| npm | VERIFIED present | `10.9.8` |
| SQLite runtime | NOT VERIFIED | Services are stopped and Node is below the release baseline; no migration or database open was attempted |
| Disk | VERIFIED available | `/`: 40G total, 18G used, 20G available (48%) |
| Memory | VERIFIED available | 1.9 GiB total, approximately 1.4 GiB available; swap present |
| `/etc/viero` | VERIFIED metadata | `root:viero`, mode 750 |
| `/var/lib/viero` | VERIFIED metadata | `viero:viero`, mode 700 |
| `/var/lib/viero-signer` | VERIFIED metadata | `viero-signer:viero-signer`, mode 700 |
| `/run/viero-signer` | NOT VERIFIED | Parent directory absent while signer is stopped; this is expected before activation |

### Service configuration drift

The installed units use `/etc/viero/viero.env`; the signer additionally uses `/etc/viero/signer.env` and a drop-in references `/etc/viero/viero-signer.env`. The drop-in is present at:

`/etc/systemd/system/viero-signer.service.d/relay.conf`

The agent also has an old `token-first.conf` drop-in. Its explicit empty indexer variables do not activate the indexer, but it is deployment drift and must be reviewed against the candidate units. No drop-in was changed.

## B. Environment and storage

The following files were absent at inspection time:

- `/etc/viero/viero.env`
- `/etc/viero/signer.env`
- `/etc/viero/viero-signer.env`

Because the services are stopped, no environment values were read. Required variable names and secret values could not be verified. The absence of the two required files is a hard installation preflight failure under `deploy/install-release.sh`.

The following runtime state was absent:

- signer operation SQLite database and WAL/SHM companions;
- Relay operation database;
- legacy transaction journal;
- strategy-state JSON;
- signer Unix socket.

This means there were no readable unresolved operation records to inspect, but it also means production state continuity and backup history are **NOT VERIFIED**. Absence must not be interpreted as proof that prior transaction history was reconciled.

## C. Release candidate

Local repository state is dirty and contains substantial pre-existing uncommitted/untracked work. The repository HEAD is `128ac3d4b1ea96084d55a9578306d017006e709d`; HEAD alone is not the candidate identity.

Local candidate evidence:

- package version: `2.0.4`;
- local engine floor: Node `>=24.15.0`;
- `npm run check`: PASS (509 passed, 1 skipped, 0 failed);
- `npm run typecheck`: PASS;
- `npm run build`: PASS;
- deployment script syntax checks: PASS;
- disposable SHA-256 manifest: 197 files, manifest digest `844f2d8d3fe8c8b05f35358d2c11c9f346c107ae6a62fd792903b630cd20517d`; generated under `/tmp` and not uploaded.

The candidate includes the durable mint projection acknowledgement, V3 close workflow, operation-store schema v2, RPC optimizations, signer/Relay units, read-only checkers, and updated runbook. No candidate artifact was copied to the VPS.

The VPS current and previous release links resolve to:

- `/opt/viero/releases/2.0.4-20261006T140022Z` (current);
- `/opt/viero/releases/2.0.4-20261004T141120Z` (previous).

The current and 2026-10-06 release signer bundle had the same observed `build/viero/signer-server.js` hash. The deployed package advertises Node `>=20.0.0`, which is incompatible with the reviewed candidate's Node `>=24.15.0` floor. The deployed release did not contain the new local read-only schema checkers.

## D. Production blockers and required actions

| Severity | Finding | Required correction | Requires VPS mutation? | Acceptance |
|---|---|---|---|---|
| High | Node 22.23.2 is below the release floor | Provision Node >=24.15.0 and verify `node --version` before install | Yes | Supported runtime and `node:sqlite` compatibility verified |
| High | Required env files absent | Provision protected env files using approved secret handling | Yes | Files exist, correct owner/mode, required names present, values never printed |
| High | Legacy signer env drop-in remains | Review and retire `/etc/viero/viero-signer.env` reference | Yes | Effective signer unit matches candidate; no missing env-file dependency |
| High | No production state/journal evidence | Confirm whether this is a fresh host or recover state from a quiescent backup | Potentially | State continuity documented; schema v2 and Relay schema checks pass |
| Medium | Current/previous release is old and semantically identical | Stage immutable candidate artifact and compare manifest/hash before install | Yes | Candidate manifest reviewed; rollback target accepts new schemas or refuses safely |
| Medium | Socket/SQLite permissions cannot be exercised while stopped | Verify after separately authorized signer start, without enabling autonomy | Yes, later | Socket ACL, signer ownership, WAL durability and recovery gate verified |

## E. Deployment safety evaluation

- Quiescent backup: **CONDITIONAL**. Directories exist with appropriate modes, but no state files or backup evidence were present.
- Backup checksum verification: **NOT VERIFIED**. Must be performed on any recovered state before installation.
- Immutable release installation: **SUPPORTED LOCALLY**, pending supported Node and protected configuration.
- SQLite schema compatibility: **NOT VERIFIED ON VPS** because the databases are absent. The candidate checker expects operation-store schema 2 and must be run on any recovered database.
- Protected configuration: **FAILED** because required files are absent.
- Signer evidence-key provisioning: **NOT VERIFIED**; no key metadata was inspected or created.
- Service-user/socket permissions: **PARTIALLY VERIFIED**; state directory modes pass, runtime socket is absent as expected while stopped.
- Incomplete open/close recovery: **NOT VERIFIED** because no operation store exists to inspect. The local candidate fail-closed recovery protocol remains required.
- Relay ambiguity handling: **NOT VERIFIED** because no Relay store exists.
- Rollback without activation: **SUPPORTED LOCALLY** by the reviewed scripts, but rollback must refuse incompatible schema/state and the old deployed release is not a valid reader of the new candidate schema until verified.

## F. RPC optimization check

The local candidate retains the approved offline benchmark: 180 simulated requests / 5,032 estimated CU baseline versus 118 / 3,672 optimized, with identical results. This is a deterministic benchmark, not an Alchemy billing claim. No production RPC call was made during this inspection, and manual LP activity was not included.

## Final decision

**CONDITIONAL — OPERATOR ACTION REQUIRED.** The VPS is safely stopped and has adequate resources, but Node compatibility, protected configuration, stale unit references, and production-state continuity must be resolved and re-verified before any installation. No deployment or activation is authorized by this report.
