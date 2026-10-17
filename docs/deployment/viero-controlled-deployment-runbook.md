# Viero Controlled Deployment Runbook (Future Use)

This runbook is a design for a separately authorized operation. It does not grant
permission to deploy or start anything. Default post-install state is all services
inactive/disabled, execution disabled, and zero transaction broadcasts.

## Gates

Obtain explicit approval independently for: artifact installation; signer start;
Telegram start; agent start; and enabling transaction execution. Installing a
release never implies any of the latter operations.

## 1. Local preflight and artifact identity

1. Record branch, commit, working-tree status, package version, Node version, and
   lockfile hash. A dirty tree requires explicit written approval or a clean
   staging checkout; never package unknown local edits.
2. Run `npm run check` and the isolated Phase 4.3 harness. Run deployment static
   checks (`bash -n deploy/*.sh`, unit-file review, secret scan).
3. Run `npm run release:viero`; record the tarball SHA-256. Attach a manifest with
   Git commit, package version, UTC release ID, artifact hash, and lock hash.

## 2. Read-only VPS gate and backups

Record current/previous symlinks, units, drop-ins, service users, disk/memory,
and the stopped-state matrix. Verify `/etc/viero` file names and modes without
printing values. Before installation, obtain separate authorization to snapshot
`/opt/viero/current`, `/opt/viero/previous`, `/var/lib/viero`,
`/var/lib/viero-signer` and the signer journal. Validate archive checksums and
ownership; do not copy secrets into logs or chat.

## 3. Configuration and schema gate

Provision only operator-supplied env files with restrictive ownership/modes.
Validate variable names, enabled chains/RPC presence, signer socket agreement,
execution flags, and indexer-disabled intent. Validate state/journal schema
compatibility and migration/rollback direction before installing. Missing or
ambiguous env-file references are a hard stop.

## 4. Install without activation

Install the immutable artifact under a new `/opt/viero/releases/<manifest-id>`,
set root ownership, update `current` only after checksum verification, and run
`systemctl daemon-reload`. The remediated installer requires pre-existing protected
environment files and refuses to copy sensitive/runtime files. Without `--start`
it does not enable or start agent, Telegram, or signer; the indexer remains stopped
and disabled. Do not use `--start` during preparation.

## 5. Separate activation gates

1. **Signer:** only after signer env, socket permissions, journal writability, and
   read-only health checks pass. Start alone does not authorize a transaction;
   keep `VIERO_EXECUTION_ENABLED=false` until the final gate.
2. **Telegram:** start only after token/user-ID configuration is verified.
3. **Agent:** start only after deterministic preflight and selected-chain checks.
4. **Execution:** change execution flags only after explicit approval, with signer
   and agent values changed together. Never enable execution as a side effect of
   installation.

## 6. Post-deployment checks and rollback

Check service status, restart counters, socket mode/group, read-only health,
state/journal ownership, indexer disabled state, and recent logs with secret
redaction. If a check fails, stop at the current gate and preserve evidence.

Rollback must first validate schema compatibility with
`deploy/check-state-schema.mjs`, snapshot state and the signer journal with
`deploy/backup-state.sh`, stop/disable every service, flip symlinks, daemon-reload,
and leave every service disabled. The remediated `deploy/rollback-release.sh`
never starts or restarts autonomous trading. Restore state only after an explicit
compatibility decision.

## 7. Final default target

Agent, Telegram, signer, and indexer: **inactive/disabled**. Execution: **false**.
No scheduler, signer invocation, or transaction is permitted until separate
authorization is recorded.
