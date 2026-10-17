# Viero Phase 4.3 Deployment Preparation Audit

Inspection date: **2026-10-17**. Audit-only; no production mutation.

## Verdict

**B — REQUIRES ADDITIONAL REMEDIATION.** The VPS is safely stopped, but missing
environment files, release drift, incomplete rollback semantics, and the lack of a
production-integrated F4 test prevent a controlled activation. This verdict is not
permission to deploy.

## Baseline and drift

- Local baseline: `main`, commit `128ac3d4b1ea96084d55a9578306d017006e709d`,
  dirty working tree containing the existing Viero migration/Phase 4.1 work.
- Active VPS release: `/opt/viero/releases/2.0.4-20261006T140022Z`, package
  version `2.0.4`; package version alone does not identify the source.
- Active release lacks Phase 4.1 optional-LLM and RPC telemetry markers. Local
  Phase 4.1 source therefore is not in the active artifact.
- Main unit hashes matched local unit files, but VPS drop-ins add effective drift:
  `token-first.conf`, `relay.conf`, and `heap.conf`.
- Agent, Telegram, signer, and indexer were all inactive and disabled; no Viero
  timer/process was present. Indexer was safely disabled.
- `/etc/viero/viero.env`, `/etc/viero/signer.env`, and the drop-in-referenced
  `/etc/viero/viero-signer.env` were absent. No values were read or created.
- State directories were mode 0700 and correctly owned; signer socket/journal were
  absent because signer was stopped.

## Artifact, schema, and rollback assessment

`deploy/package-release.sh` runs `npm run check` and packages an immutable build
artifact, but the artifact does not itself identify the Git commit. The next release
must carry a manifest containing commit, package version, UTC release ID, SHA-256,
and dependency lock hash.

The repository uses versioned JSON/file persistence (strategy schema version 1,
atomic writes) without a migration manifest. No migration was evidenced for the
active VPS state. A future deployment must validate schemas before activation and
preserve state, token memory, blocked-token data, evidence cache, and the signer
journal. A newer state schema must never be rolled back into an older binary without
an explicit compatibility check.

`deploy/install-release.sh` creates env examples and, even without `--start`,
enables agent and Telegram; this conflicts with the required safe-stopped default
unless an explicit post-install disable gate is applied. `deploy/rollback-release.sh`
restarts the agent automatically and does not handle Telegram/signer state or
journal backups. It is not safe as an unattended rollback procedure.

## Required remediation before activation

1. Build and review a release with a commit-bound manifest and current Phase 4.1
   source; do not rely on `2.0.4` alone.
2. Provision and permission environment files from operator-supplied secrets;
   resolve the extra signer drop-in reference.
3. Add schema compatibility/migration evidence and tested state/journal backups.
4. Replace or wrap install/rollback behavior with the explicit authorization gates
   in the controlled runbook.
5. Integrate the isolated crash protocol with the real executor/recovery modules
   in a disposable environment, then repeat the required tests.

No source runtime behavior, production configuration, service, signer, wallet, or
blockchain state was changed by this phase.
