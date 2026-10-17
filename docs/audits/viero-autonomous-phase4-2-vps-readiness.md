# Viero Autonomous Phase 4.2 VPS Readiness Audit

Inspection timestamp: **2026-10-16 22:14:28 +08:00**
Target: `ubuntu@43.156.128.196` over the previously authorized SSH key.
Scope: read-only inspection only. No service, signer, wallet, configuration,
or blockchain operation was invoked.

## Classification key

- **VERIFIED** — directly observed without changing state.
- **FAILED** — directly observed to violate the intended deployment condition.
- **NOT VERIFIED** — unavailable or unsafe to establish in this audit.
- **NOT APPLICABLE** — intentionally not run under the phase constraints.

## 1. Local preflight

| Item | Result | Evidence |
|---|---|---|
| Local branch/commit | VERIFIED | `main`, commit `128ac3d4b1ea96084d55a9578306d017006e709d` |
| Local working tree | VERIFIED (DIRTY) | Pre-existing deleted/modified files and untracked Viero/deployment/docs/tests were preserved. |
| Expected services | VERIFIED | `viero-agent.service`, `viero-telegram.service`, `viero-signer.service`, `viero-indexer.service` |
| Agent state path | VERIFIED | `/var/lib/viero`, expected mode `0700`, owner `viero:viero` |
| Signer state/journal path | VERIFIED | `/var/lib/viero-signer`, expected mode `0700`, owner `viero-signer:viero-signer`; journal path is `/var/lib/viero-signer/transactions.jsonl` |
| Signer socket | VERIFIED (expected path) | `/run/viero-signer/viero.sock` |
| Indexer disable intent | VERIFIED (source expectation) | `VIERO_INDEXER_DISABLE=1` is documented/supported; deployed state checked below. |
| Expected users/groups | VERIFIED (source expectation) | Agent/Telegram/indexer: `viero:viero`; signer: `viero-signer:viero`. |

## 2. VPS service-state matrix

| Service | Active | Enabled | Restarts | User/group | Result |
|---|---|---|---:|---|---|
| `viero-agent.service` | inactive/dead | disabled | 0 | `viero:viero` | VERIFIED |
| `viero-telegram.service` | inactive/dead | disabled | 0 | `viero:viero` | VERIFIED |
| `viero-signer.service` | inactive/dead | disabled | 0 | `viero-signer:viero` | VERIFIED |
| `viero-indexer.service` | inactive/dead | disabled | 0 | `viero:viero` | VERIFIED |

No Viero process was running and no Viero systemd timer was present. Autonomous
trading is therefore paused/disabled on this host. Service availability is not
the same as permission to execute: all services are stopped, and the signer
cannot currently authorize anything.

## 3. Signer socket and health

| Check | Result | Evidence |
|---|---|---|
| `/run/viero-signer` directory | NOT VERIFIED / absent | Runtime directory is created only while the unit is active. |
| `/run/viero-signer/viero.sock` | NOT VERIFIED / absent | No socket exists while signer is stopped. |
| `/health` | NOT APPLICABLE | Not queried because the socket is absent; no signer invocation was attempted. |
| Socket authorization | NOT VERIFIED | Socket mode/group cannot be inspected while it does not exist. Local unit expects runtime directory `0750` and socket setup `0660`. |

## 4. Storage and journal access controls

| Check | Result | Evidence |
|---|---|---|
| Agent state directory | VERIFIED | `/var/lib/viero` is `drwx------`, `viero:viero`. |
| Signer state directory | VERIFIED | `/var/lib/viero-signer` is `drwx------`, `viero-signer:viero-signer`. |
| Signer journal file | NOT VERIFIED | `transactions.jsonl` is absent because signer is inactive; writability was not tested. |
| `/etc/viero` directory | VERIFIED | `drwxr-x---`, `root:viero`. |
| `/etc/viero/viero.env` | FAILED | Required environment file is absent on the VPS. |
| `/etc/viero/signer.env` | FAILED | Required signer environment file is absent on the VPS. |
| `/etc/viero/viero-signer.env` | FAILED | A signer drop-in references this path, but the file is absent. |

The missing environment files are a startup blocker. They were not read or
created. No secret value was printed.

## 5. Resources and recent errors

| Check | Result | Evidence |
|---|---|---|
| Disk | VERIFIED | Root filesystem: 40G total, 18G used, 20G available (48%). |
| Memory | VERIFIED | 1.9GiB total, 1.4GiB available; swap 1.9GiB total, 1.8GiB available. |
| Journal retention usage | VERIFIED | Journals use approximately 727.5M. |
| Recent unit error messages | VERIFIED | No recent error-priority entries were returned for the four units in the inspected 24-hour window. |
| Journal writability for future signer transactions | NOT VERIFIED | No write test was performed and signer is stopped. |

## 6. Deployed release and drift

The active symlink resolves to:

`/opt/viero/releases/2.0.4-20261006T140022Z`

The active `package.json` reports version `2.0.4`. It does not include the
current local source tree or Phase 4.1 markers:

- `src/viero/agent/llmClient.ts`: absent in the active release.
- `src/viero/observability/rpcTelemetry.ts`: absent in the active release.
- `createOptionalLlmClient`: absent from active build/source.
- `management-recovery`: absent from active build/source.
- `normalization`: present in the older active signer build.

The local checkout is also version `2.0.4`, but its commit and behavior cannot
be equated to the deployed release. Therefore:

| Drift item | Result |
|---|---|
| Semantic release/version mismatch | FAILED — same package version, different source/build content |
| Phase 4.1 remediation deployed | FAILED — markers absent from active release |
| Main unit file hash | VERIFIED — deployed main unit hashes matched local deployment units |
| Drop-in drift | VERIFIED — deployed drop-ins exist: `token-first.conf`, `relay.conf`, `heap.conf` |
| Signer environment-file drift | FAILED — signer drop-in references an additional missing env path |
| State schema migration requirement | NOT VERIFIED — active release metadata does not identify a migration manifest; no state migration was run |
| Telemetry configuration | NOT VERIFIED — service is inactive and active build predates local Phase 4.1 telemetry labels |

The agent drop-in clears legacy `VIERO_INDEXER_<chain>` variables in its
`ExecStart` wrapper. The indexer unit itself is disabled, so no scheduler was
unexpectedly running.

## 7. Security observations

| Observation | Result |
|---|---|
| Autonomous scheduler unexpectedly active | VERIFIED NO — no process/timer and agent disabled |
| Indexer unexpectedly active | VERIFIED NO — inactive and disabled |
| Signer reachable by unauthorized users | NOT VERIFIED — socket absent; local unit design restricts runtime directory/group |
| Wallet key exposure | NOT APPLICABLE — key material was not read |
| Environment secret exposure | VERIFIED NO — environment files were not read or printed |
| State directory access control | VERIFIED — both runtime state directories are mode `0700` |
| Required startup configuration present | FAILED — expected env files are missing |

## 8. F4 process-boundary test prerequisites

Production destructive tests were not run. A future isolated test environment
must provide:

1. A disposable VM/container with no funded wallet and no production RPC
   credentials.
2. A fake signer/RPC transport that records simulation, authorization, and
   receipt calls without broadcasting.
3. A temporary state and journal directory with injected atomic-write failures.
4. Controlled process termination at each boundary: intent write, raw-broadcast
   acknowledgement, journal append, receipt confirmation, CLOSED persistence,
   and normalization persistence.
5. Two concurrent recovery workers and duplicate scheduler invocations.
6. Assertions that uncertain hashes are never re-authorized, confirmed receipts
   converge idempotently, missing evidence fails closed, and normalization is
   retried separately from close.

## 9. Remaining F2 blockers

F2 is **not fully resolved**. Service state is now directly verified as safely
stopped, but the target is not ready to start:

- required `/etc/viero/viero.env` and signer environment files are absent;
- the active release predates the local Phase 4.1 remediation;
- signer socket/health and journal writability cannot be verified while stopped;
- deployed state-schema compatibility is not evidenced;
- no production configuration/RPC mapping can be validated without reading the
  missing environment files.

## Readiness verdict

**FAILED for production activation; VERIFIED SAFE-STOPPED.**

The host is not unexpectedly running Viero, and the optional indexer is
disabled. However, missing environment files and release drift are hard startup
blockers. This audit made no attempt to repair them. A future deployment or
configuration remediation requires separate explicit authorization.
