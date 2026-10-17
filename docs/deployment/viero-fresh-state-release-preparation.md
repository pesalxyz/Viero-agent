# Viero fresh-state release preparation

Preparation date: 2026-10-18 (Asia/Jakarta)

Scope: local fresh-state preparation, disposable schema validation, local
release packaging, and documentation. No VPS installation, production
database initialization, service operation, signer invocation, wallet access,
production RPC, transaction, normalization retry, or Git commit/push was
performed.

## Verdict

**CONDITIONAL — PREPARATION BLOCKERS REMAIN**

The historical disposition is explicitly accepted and the disposable fresh
baseline, build, tests, and package artifact are valid. The remaining blocker
is provenance: the repository is materially dirty relative to revision
`128ac3d4b1ea96084d55a9578306d017006e709d`, with 39 porcelain entries,
including many deletions and untracked Viero source/config/test files. A clean,
reviewed source revision was not created because the working tree must be
preserved. The artifact is checksum-identifiable, but it is not a clean Git
release and must not be treated as an immutable production release until the
changes are committed or otherwise approved as an attributable snapshot.

Node 26.4.0 was used for local validation. The package declares `node >=24.15.0`
and the existing Viero evidence supports Node 24.15.0 as the deployment
baseline, but a local Node 24.15.0 executable was not available for a second
runtime run. VPS runtime validation remains a separate prerequisite.

## Operator historical disposition

The separate decision record at
`docs/deployment/viero-fresh-state-decision-record.md` records the operator's
explicit acceptance:

`UNRESOLVED_HISTORICAL_NORMALIZATION — OPERATOR_ACCEPTED_RISK`

It applies only to BNB Chain 56, Uniswap V3, token ID `7651090`, normalization
status `pending`, attempts `0`, and no recorded swap hash. It does not mark the
record complete, authorize a retry/swap, or alter the historical state.

The reviewed inventory is 130 `CLOSED`, 0 `OPEN`, 0 `CLOSING`. The one legacy
broadcast-only journal transaction is a canonical finalized revert. Fourteen
normalization failures are classified as not executed. The September 24 backup
and October 10 checksums are reproduced in the decision record and the two
reconciliation reports.

## Historical archive plan

The archive must contain, without modification:

- October 10 `strategy-state.json`, `controls.json`, and legacy
  `transactions.jsonl`;
- the 5,159 run files and manifest
  `9076a8b9769d48a826f07c384b4d6cab6f80812431701a8c9e14f449d910ba56`;
- the September 24 backup reference and SHA-256
  `91a271cd0f3a3734a8d3f5a3af10e704ab5739fc4fb9cf0f550c7e6fda4b25bb`;
- `viero-final-historical-state-inspection.md` and
  `viero-targeted-onchain-reconciliation.md`; and
- the operator decision record.

The originals remain on the VPS and were not changed. Any remote archival copy
must be made only by a separately authorized, quiescent, checksum-verified
procedure; no remote archival write was attempted here. The archive is not an
active schema-v2 database and must not be silently imported.

## Fresh-state baseline

Manifest: [viero-fresh-state-baseline.json](/Users/pesal/Documents/Viero-agent/mcp-evm-server/docs/deployment/viero-fresh-state-baseline.json)

A disposable local baseline was created and checked with the release checkers:

| Check | Result |
|---|---|
| Strategy state | empty, 0 positions, 0 transactions |
| Controls | `STOPPED`, 0 enabled chains |
| Signer operation store | schema 2, 0 unresolved |
| Relay operation store | schema 2, 0 unresolved |
| Projection acknowledgements | 0 pending |
| Close workflows | 0 unresolved |
| Baseline directory permissions | `0700` |
| Agent database access | not granted; socket-only boundary retained |
| `check-state-schema.mjs` | PASS |
| `check-operation-store.mjs` | PASS |
| `check-relay-store.mjs` | PASS |

No production database or baseline directory was created on the VPS.

## Release candidate

The local packaging script produced:

`dist/viero-agent-2.0.4-20261017T175208Z.tar.gz`

Artifact SHA-256:

`d0c365d07226aa84080dd9a05f07d0a3a7f047d6a7dab9cd613d07b675ec7701`

The archive contains 1,245 files. Its complete per-file manifest is:

`dist/viero-agent-2.0.4-20261017T175208Z.tar.gz.manifest.sha256`

Manifest SHA-256:

`ccbde1cfd2435addec17d296afe297674d7b8904dd2f55d7e1238b0d3b0d37bd`

Additional reproducibility evidence:

- Source revision: `128ac3d4b1ea96084d55a9578306d017006e709d`.
- Working tree: dirty; 39 porcelain entries. No files were reset or cleaned.
- `package-lock.json` SHA-256:
  `6105455064c5150b3075fb76f475ec8cf0c4966076bc4d0bbb5ca942b62a8102`.
- Build directory: 13 files; manifest SHA-256
  `7ec1b2999ad34ca808701b68d182177768ead7f66a6906f786bff973f71cc288`.
- Package declares Node `>=24.15.0`; local runtime was Node `v26.4.0`.

The package scan found no private keys, API-key values, wallet files, runtime
databases, or production state files. Template files contain placeholders only.
The artifact does include documentation and source maps by design; it is not a
production secret bundle.

## Validation results

`npm run check` completed successfully during packaging:

- Typecheck: PASS.
- Tests: 510 total, 509 passed, 0 failed, 1 skipped (PostgreSQL integration).
- Build: PASS.
- Release archive creation: PASS.
- Fresh baseline checkers: PASS.

The suite includes signer/Relay recovery, projection acknowledgement, close
workflow, crash-boundary, RPC optimization, and fresh-state regression tests.
No test used a funded wallet, production RPC, signer, or live transaction.

## Passive-installation procedure (not executed)

Before any separately authorized VPS installation:

1. Preserve and checksum the October 10 files and September 24 archive before
   touching release paths.
2. Confirm all Viero services are inactive and disabled; do not reload systemd
   as part of artifact preparation.
3. Validate protected configuration names and permissions without printing
   values; provision evidence keys only through the approved secret channel.
4. Refuse installation if unexpected active schema-v2 databases, WAL/SHM files,
   or non-empty fresh paths are found.
5. Install the artifact separately from activation; keep live execution and
   indexer disabled.
6. Run read-only state, operation-store, Relay-store, and legacy-journal
   checkers against quiescent copies only. The legacy pending journal/state
   must not be auto-imported.
7. Validate signer socket ownership, evidence-key trust, startup recovery
   `READY`, and empty baseline invariants before any transaction-capable route
   is considered.
8. Keep rollback pointed at a compatible release and preserve both historical
   archive and fresh-state paths. Rollback must preserve the stopped/disabled
   state by default.

## Remaining prerequisites

- Produce a clean, reviewed, attributable Git snapshot or obtain explicit
  approval for this dirty-tree artifact.
- Re-run the artifact under the actual VPS Node 24.15.0 runtime (or document a
  supported newer LTS) before installation.
- Separately authorize passive VPS installation and any required protected
  configuration/evidence-key provisioning.
- Keep services stopped and autonomous execution disabled until a separate
  activation decision.

No production deployment or activation is authorized by this preparation.
