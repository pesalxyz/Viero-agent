# Viero Autonomous Phase 4 Remediation Plan

Original audit plan. Phase 4.1 applied only the bounded local changes described
in the results report; no production remediation was applied.

Phase 4.1 local remediation status is recorded in
`viero-autonomous-phase4-1-remediation-results.md`. The changes remain local
and were not deployed or committed.

| ID | Severity | Finding | Evidence | Smallest safe remediation | Acceptance test |
|---|---|---|---|---|---|
| F1 | High | Live/Telegram startup requires an LLM key although public configuration says LLM is optional. | `src/viero/cli.ts` constructs `createLlmClient()` for `live`/`telegram`; `src/viero/agent/llmClient.ts` throws `LLM_NOT_CONFIGURED`; `docs/configuration.md` describes LLM as optional. | Decide and document one contract. Preferred deterministic option: defer LLM construction until an LLM feature is requested; otherwise mark the key required for those modes and add a preflight check. | Empty-key deterministic live/telegram startup behavior is explicit and tested; no silent fallback or strategy change. |
| F2 | High | Production host is safely stopped but not start-ready. | Phase 4.2 verified all four units inactive/disabled and no Viero process/timer; required `/etc/viero/viero.env`, signer env files, and the current Phase 4.1 release are absent. | Restore the intended release/configuration under a separately authorized deployment, then repeat the read-only checklist: service state, signer `/health`, socket permissions, enabled indexer state, journal/storage checks. | All expected services report the intended state; required env files exist with restrictive permissions; signer health/socket/journal checks pass; indexer remains inactive when required. |
| F3 | Medium | Some management recovery/normalization and receipt reads can be attributed to telemetry `unknown`. | `manageLive` has named confirmation scopes, but closing recovery and some direct reads are not consistently wrapped in `telemetry.run`; fallback retry callback has no method. | Add narrow workflow scopes/counters only; do not change read order or safety decisions. | Critical management and signer-recovery calls have non-unknown workflow labels; logical results and RPC counts remain unchanged. |
| F4 | Medium | Process interruption between broadcast, receipt, and persisted state is not fully fault-injected. | Persistence and reconciliation tests exist; no controlled process-kill/restart matrix was run. | Add offline crash-boundary tests for open/close/normalize, incomplete receipt, journal replay, and storage failure. | Restart converges to OPEN/CLOSING/CLOSED safely, never duplicates authorization, and remains fail-closed. |
| F5 | Low | Operational documentation is stale in places. | `docs/viero.md` describes independent management scheduling as future work while `cli.ts` runs a management interval. | Update documentation only after runtime behavior is confirmed. | Docs match scheduler and service units; no code behavior changes. |
| F6 | Low | Depth USD conversion uses JavaScript `Number` after `formatUnits`. | `src/viero/screening/math.ts` converts token amounts for USD valuation. | Add extreme-value precision tests and, only if needed, a fixed-precision representation change with unchanged policy semantics. | Ordinary and extreme decimal fixtures preserve threshold decisions exactly. |

## No-go changes

Do not solve cost or readiness by caching mutable pool state, skipping fresh confirmation, weakening V3/V4 identity or hook checks, bypassing simulation, removing complete historical logs, or enabling the indexer as a substitute for required evidence.

## Suggested order

Resolve F1 and F2 before any controlled paper run. Then add F4 fault-injection coverage and F3 observability scoping. F5/F6 can follow as lower-risk hygiene work.
