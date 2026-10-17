# Viero Autonomous Phase 4.1 Remediation Results

Date: 2026-10-16
Scope: local repository only. No deployment, service restart, autonomous activation, signer invocation, wallet access, or blockchain transaction occurred.

## 1. Baseline and protection

- Branch: `main`
- Baseline commit: `128ac3d4b1ea96084d55a9578306d017006e709d`
- The checkout already contained a dirty working tree with earlier Viero,
  deployment, documentation, and generated-file changes. Those changes were
  preserved; no reset, clean, commit, or push was performed.
- Earlier Phase 1–3 audit documents and the Phase 4 readiness documents were
  read before editing.

Changed files in this remediation:

- `src/viero/agent/llmClient.ts`
- `src/viero/cli.ts`
- `src/viero/observability/rpcTelemetry.ts`
- `src/viero/execution/signerServer.ts`
- `src/viero/workers/screeningWorker.ts`
- `docs/configuration.md`
- `docs/viero.md`
- `docs/audits/viero-autonomous-phase4-integration-matrix.md`
- `docs/audits/viero-autonomous-phase4-remediation-plan.md`
- `tests/phase41Readiness.test.ts`
- this report

No trading thresholds, pool selection, hook allowlist, range/depth math,
execution planner, signer authorization, or transaction semantics were changed.

## 2. F1 — LLM startup contract

Resolved locally.

`live` no longer constructs an LLM client at startup. Deterministic screening,
ranking, auto-size, auto-range, planning, and management therefore do not need
`VIERO_LLM_API_KEY`. Telegram slash commands can also start without the key;
the optional conversational/explanation handler is constructed only when
`VIERO_LLM_ENABLED` is not `false` and a non-blank key is present.

The strict `createLlmClient()` path remains unchanged for explicitly
LLM-dependent callers: missing credentials still raises
`LLM_NOT_CONFIGURED`. A supplied but invalid LLM configuration is not silently
ignored.

Tests cover empty credentials, explicit disabled mode, valid configuration, and
the CLI source contract. No live or Telegram service was started.

## 3. F3 — telemetry attribution

Resolved locally with narrow workflow labels:

- `management-recovery` wraps persisted closing-position recovery observations.
- `management` wraps manual position observation before close/autoswap.
- `execution-receipt` wraps signer balance/open/claim/close RPC work.
- `normalization` wraps signer Relay normalization RPC work.

The RPC request order, retry count, fallback behavior, confirmation sequence,
and authorization boundaries are unchanged. `RpcTelemetry` remains bounded and
best-effort. Physical HTTP attempts can still be aggregated by viem batching;
that limitation is documented and no billing claim is made from the counters.

## 4. F4 — crash/restart safety

Offline coverage was added for receipt-unavailable fail-closed behavior,
journal idempotence, and named fixtures covering:

- open intent without broadcast;
- broadcast without persisted hash;
- persisted hash with unavailable receipt;
- confirmed receipt before state persistence;
- pending close during restart;
- confirmed close before `CLOSED` persistence;
- pending normalization;
- storage failure;
- duplicate scheduler invocation; and
- concurrent recovery attempts.

Existing tests also cover stale `CLOSING` reconciliation, zero-liquidity close
reconciliation, STOPPED write suppression, and normalization failure handling.

These are deterministic offline fixtures, not process-kill tests against a
running signer. The process-level crash window between raw broadcast, journal
write, receipt confirmation, and repository persistence therefore remains an
operationally unverified condition. No speculative recovery policy was added,
and no transaction semantics were changed.

## 5. F5 — documentation

Updated `docs/viero.md` and `docs/configuration.md` to describe:

- five-minute default screening cadence;
- five-minute default management cadence;
- reuse of the displayed cycle observation followed by independent fresh
  confirmation before close/claim handoff;
- signer isolation over the Unix socket;
- optional indexer status as a deployment property; and
- optional LLM behavior and startup prerequisites.

The documentation does not claim any unverified VPS service state.

## 6. F6 — depth precision tests

Added deterministic fixtures for 6-, 9-, and 18-decimal tokens, very small and
large raw amounts, exact threshold values, one-raw-unit boundary values, and
asymmetric fixture inputs. An independent decimal-string reference confirms
the expected ordinary values.

The existing `tokenValue()` conversion still returns JavaScript `Number`. At a
threshold such as `100 * 10^18 + 1` raw units, a one-wei difference is below
Number precision and rounds to `100`. This is a documented precision boundary,
but it is not sufficient evidence to change the policy arithmetic in this
phase. No numeric representation was changed. F6 therefore remains open for a
separate fixed-precision design if exact raw-unit threshold behavior becomes a
requirement.

## 7. Validation

- `npm run typecheck`: passed.
- Targeted `tests/phase41Readiness.test.ts`: 6 passed, 0 failed.
- `npm test`: 466 passed, 1 skipped, 0 failed (467 total).
- `npm run build`: passed.
- No test invoked `SignerClient`, `LiveExecutor` wallet signing, raw transaction
  submission, Relay execution, or any blockchain transaction.

## 8. Findings resolved and still open

Resolved locally:

- F1: deterministic live/Telegram startup no longer requires an LLM key.
- F3: recovery, execution receipt, and normalization paths have named scopes.
- F5: scheduler/management/signer/indexer/LLM documentation aligned.

Partially resolved:

- F4: offline fault fixtures and idempotence checks added; process-level crash
  and storage-failure integration remain unverified.

Still open:

- F2: VPS service health, signer socket/journal, and indexer inactive state were
  not verified and were intentionally out of scope.
- F6: exact sub-raw-unit precision at floating-point threshold boundaries is
  documented but not changed.

## 9. Safety invariants preserved

- Fresh independent confirmation before signer handoff.
- Canonical V3/V4 identity and hook checks.
- Complete historical log evidence and reorg invalidation.
- Exact depth, fee, and policy thresholds.
- Simulation and signer authorization boundaries.
- Fail-closed missing evidence.
- Separate post-close Relay normalization failure boundary.
- No manual LP workflow changes.

## Readiness recommendation

The deterministic runtime is improved and suitable for further local/paper
validation. It is not a production approval: the operational F2 checks and
process-level F4 crash tests still require a separately authorized, read-only
deployment validation. No automatic production-readiness check was started.
