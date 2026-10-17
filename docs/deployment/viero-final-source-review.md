# Viero Final Source Review and Release Provenance

Inspection date: 2026-10-18
Repository: `/Users/pesal/Documents/Viero-agent/mcp-evm-server`
Requested comparison revision: `128ac3d4b1ea96084d55a9578306d017006e709d`

## Verdict

**CONDITIONAL — SOURCE REVIEW REQUIRED**

The working tree contains a coherent Viero implementation and the local validation suite is green, but it is not yet a clean, attributable production release candidate. Two release-provenance issues must be resolved before commit approval:

1. The requested comparison revision is the old generic EVM MCP server. The complete Viero runtime, tests, deployment tooling, configuration, and audit records are untracked relative to that revision, so there is no committed Viero parent from which to prove a minimal semantic diff.
2. The proposed Viero CI workflow uses Node 22 and the public README says Node 20/22, while `package.json`, bootstrap, installer, and the validated deployment contract require Node 24.15+ for the SQLite operation-store path. This is a release configuration mismatch, not a runtime test failure.

No commit, staging, push, deployment, service operation, signer access, wallet access, RPC call, or transaction was performed during this review.

## Git change inventory

At the start of the review, `git status --short` contained 39 porcelain entries:

- **26 deletions** from the generic MCP implementation: `.cursor/mcp.json`, `.github/workflows/release-publish.yml`, `.npmignore`, `CHANGELOG.md`, `bin/cli.js`, `bun.lock`, `funding.json`, all files under `src/core/`, and `src/index.ts`, `src/server/http-server.ts`, `src/server/server.ts`.
- **3 modifications**: `.gitignore`, `README.md`, `package.json`.
- **10 untracked top-level entries**: `.env.example`, `.github/workflows/viero.yml`, `compose.viero.yml`, `config/`, `deploy/`, `docs/`, `package-lock.json`, `scripts/`, `src/viero/`, and `tests/`.

The deletions are internally consistent with replacing the generic MCP product: the package entry point is now `src/viero/cli.ts`, the scripts invoke the Viero CLI, the repository URL is `pesalxyz/Viero-agent`, and the new source/test/deployment tree is self-contained. They should nevertheless be staged as explicit reviewed deletions, never through an unreviewed `git add -A`.

The exact deletion set is: `.cursor/mcp.json`; `.github/workflows/release-publish.yml`; `.npmignore`; `CHANGELOG.md`; `bin/cli.js`; `bun.lock`; `funding.json`; `src/core/chains.ts`; `src/core/prompts.ts`; `src/core/resources.ts`; `src/core/services/abi.ts`; `src/core/services/balance.ts`; `src/core/services/blocks.ts`; `src/core/services/clients.ts`; `src/core/services/contracts.ts`; `src/core/services/ens.ts`; `src/core/services/index.ts`; `src/core/services/tokens.ts`; `src/core/services/transactions.ts`; `src/core/services/transfer.ts`; `src/core/services/utils.ts`; `src/core/services/wallet.ts`; `src/core/tools.ts`; `src/index.ts`; `src/server/http-server.ts`; and `src/server/server.ts`.

### Proposed Viero additions and modifications

The reviewed implementation set is:

- `.gitignore`, `README.md`, `package.json`, `package-lock.json`, `.env.example`.
- `.github/workflows/viero.yml` (conditional; Node version must be aligned first).
- `compose.viero.yml`.
- `config/` (paper configuration and strategy instructions).
- `deploy/` (installer, rollback, backups, schema checkers, systemd units, and empty-placeholder env examples).
- `scripts/` (build and bounded audit harnesses).
- `src/viero/` (agent, discovery, screening, execution, signer, Relay, storage, management, Telegram, RPC telemetry, and workers).
- `tests/` (runtime, signer/recovery, Relay, RPC optimization, strategy, Telegram, and policy regression suites).
- `docs/` (configuration, deployment runbooks, audits, manifests, and the report produced by this review).

`docs/thesis/` is ignored by policy and is not part of the proposed commit. It contains generated thesis PDFs/artifacts, not runtime source.

## Sensitive-file review

The following checks were read-only:

- `git ls-files` contains no `.env`, wallet, private-key, database, SQLite, transaction journal, socket, or release artifact.
- Present local `.env`, `data/`, `build/`, `dist/`, and `docs/thesis/` paths are ignored and are excluded from the commit plan. Their contents were not read.
- `.env.example`, `deploy/viero.env.example`, and `deploy/signer.env.example` contain placeholder assignments only; secret-like values are empty placeholders. No credential value was printed.
- `src/viero/config/blockedStockSeeds.ts` and the verified-pool audit manifest contain public contract addresses and block/pool evidence, not wallet keys or credentials. Long `0x...` matches from the generic scan were public addresses, PoolIds, block hashes, or test fixtures; no 64-byte private-key literal was found.
- No full private RPC URL, API key, Telegram token, Relay key, or wallet material was found in the proposed tracked set.

`git diff --check` completed without whitespace errors.

## Source-integrity findings

The requested revision is confirmed as the current `HEAD` and `origin/main`, but its tree is the old MCP server. There is no committed Viero source in that revision: all `src/viero/`, `tests/`, `deploy/`, `config/`, `scripts/`, and most `docs/` files are untracked in the working tree. Therefore a semantic “matches the previously validated release candidate” comparison cannot be proven from Git ancestry alone.

The implementation itself is internally consistent with the reviewed Viero audit documents and tests:

- `package.json` points to the Viero CLI and declares Node `>=24.15.0`.
- Installer/bootstrap checks require Node 24.15+, protected environment files, compatible schemas, and passive installation without implicit service activation.
- Signer-owned operation stores, Relay durability, evidence handoff, projection repair, recovery gates, fresh confirmation, V3/V4 identity checks, and RPC optimization tests are present in the new tree.
- The release package script copies only `build`, `config`, `deploy`, `docs`, package metadata, README, and LICENSE; it does not package source-tree credentials or runtime state.

### Blocking configuration drift

- `.github/workflows/viero.yml` selects `node-version: 22`, but `package.json`, `deploy/bootstrap-ubuntu.sh`, `deploy/install-release.sh`, and the validated deployment runbook require Node 24.15+.
- `README.md` still states “Node.js 20 or newer (Node.js 22 recommended),” which conflicts with the same production contract.
- `package.json.files` still mentions `bin/`, although the old `bin/cli.js` was intentionally deleted and the Viero build uses `build/viero/*`. This is package metadata drift to resolve or explicitly accept before publishing an immutable artifact.
- Local validation was run under Node `v26.4.0`; Node 24.15.0 compatibility was not independently executed on this workstation. Existing deployment evidence documents the intended Node 24.15.0 VPS baseline, but that is not a substitute for a clean release build under that runtime.

## Validation evidence

`npm run check` completed locally under Node 26.4.0:

| Check | Result |
|---|---|
| TypeScript typecheck | PASS |
| Tests | 510 total: 509 passed, 0 failed, 1 skipped (PostgreSQL integration) |
| Build | PASS |
| `git diff --check` | PASS |

The tests include production-module signer socket routes, crash/recovery boundaries, Relay durability, projection repair, V3/V4 identity and fresh-confirmation guards, fixed quote-size/range behavior, candidate selection, management/close decisions, RPC caches/telemetry, and deployment-script safety contracts. These are deterministic/offline tests; they do not prove production VPS state or funded-chain behavior.

The prior dirty-tree artifact was:

- `dist/viero-agent-2.0.4-20261017T175208Z.tar.gz`
- SHA-256 `d0c365d07226aa84080dd9a05f07d0a3a7f047d6a7dab9cd613d07b675ec7701`

It must not be treated as the final immutable production artifact because it was built before a reviewed commit.

## Proposed staging and commit plan

After the two configuration/provenance issues above are resolved and separately approved, stage only the following reviewed paths:

```
.env.example
.github/workflows/viero.yml
.gitignore
README.md
compose.viero.yml
config/
deploy/
docs/
package-lock.json
package.json
scripts/
src/viero/
tests/
```

Stage the 26 old generic-MCP deletions explicitly (the paths listed in the Git inventory), using `git add -u -- <reviewed deletion paths>` or equivalent. Do not stage any other tracked or untracked path.

### Exclude

- `.env`, local runtime `data/`, `build/`, `dist/`, and any database/journal/socket/log files.
- `docs/thesis/` and `.DS_Store` files.
- Any future wallet, key, credential, production environment, backup, or VPS state file.
- The old generic MCP files unless the explicit deletion review is approved; they are not to be silently overwritten or discarded.

Recommended commit message after remediation:

```
Establish Viero agent production source baseline
```

## Reproducible release procedure (operator approval required)

Do not run these commands until the staging plan is approved and the Node mismatch is corrected:

```bash
# review only; no automatic staging
git status --short
git diff --check

# after explicit approval, stage the exact reviewed additions and deletions
git add .env.example .github/workflows/viero.yml .gitignore README.md \
  compose.viero.yml config deploy docs package-lock.json package.json scripts src/viero tests
git add -u -- <the-26-reviewed-generic-MCP-deletion-paths>
git diff --cached --check
git diff --cached --name-status
git commit -m "Establish Viero agent production source baseline"

# post-commit provenance
test -z "$(git status --porcelain)"
git rev-parse HEAD

# clean release build under the supported Node 24.15.0 runtime
node --version                 # must report v24.15.0 or newer
npm ci
npm run check
npm run release:viero

# artifact and manifest
sha256sum dist/viero-agent-*.tar.gz
tar -tzf dist/viero-agent-*.tar.gz | sort > /tmp/viero-release-files.txt
sha256sum /tmp/viero-release-files.txt

# compare package contents with the previous validated artifact
tar -tzf /path/to/previous/validated-artifact.tar.gz | sort > /tmp/viero-previous-files.txt
diff -u /tmp/viero-previous-files.txt /tmp/viero-release-files.txt
```

The final artifact must be generated from the committed revision, have a recorded source commit and SHA-256 manifest, and pass the same typecheck/test/build suite under Node 24.15.0. A byte-for-byte comparison with the old dirty-tree artifact is not expected; compare file inventories and review intentional differences.

## Remaining blockers and required decisions

1. Align CI and README with the declared Node 24.15+ production baseline, or document and test a justified alternative. Do not commit a workflow that advertises an unsupported runtime.
2. Resolve the stale `package.json.files` `bin/` entry.
3. Establish a committed Viero parent/review branch (or explicitly approve this full migration commit) so future release provenance is attributable to Git rather than an uncommitted tree.
4. Re-run the complete validation and a clean release build under Node 24.15.0 after those changes.

Until these are resolved, the source is not ready for an immutable production release or deployment. No VPS action is authorized by this report.
