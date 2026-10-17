# Final autonomous RPC optimization verification

Date: 2026-10-17. Local, deterministic, read-only fake transport only. No Alchemy endpoint, production RPC, signer, scheduler, or manual LP operation was used.

## Reproduction and comparison boundary

Run `node --import tsx scripts/audits/final-offline-rpc-benchmark.ts` from the repository root. The matching regression is `tests/finalRpcBenchmark.test.ts`. Both paths use the same two synthetic pinned observations (BNB V3 and Robinhood V4), two screening cycles, token and creation evidence, two equivalent time-boundary requests per observation, repeated event-block/state/transaction reads, complete paginated logs, initialized-tick depth, and deterministic screening. The baseline executes those same logical reads without the Phase 1–3 memo/cache reuse; the optimized path enables the current implementation. It is a controlled feature-off baseline, **not** a checkout of the historical pre-optimization commit, and it is not a complete autonomous runtime replay.

The fake transport increments one method count per invocation; therefore “physical” means simulated transport attempts, not observed HTTP requests. There were no retries or fallbacks. Estimated CU weights in the harness are 26 for `eth_call`, 60 for `eth_getLogs`, and 20 each for `eth_getBlockByNumber`, `eth_getCode`, and `eth_getTransactionByHash`. These are modeling weights, not Alchemy invoices or current provider pricing.

| Method | Baseline | Optimized | Avoided |
|---|---:|---:|---:|
| `eth_getCode` | 24 | 16 | 8 |
| `eth_call` | 52 | 32 | 20 |
| `eth_getBlockByNumber` | 68 | 38 | 30 |
| `eth_getTransactionByHash` | 8 | 4 | 4 |
| `eth_getLogs` | 28 | 28 | 0 |
| **Total logical / simulated physical** | **180** | **118** | **62** |
| **Method-weighted estimated CU** | **5,032** | **3,672** | **1,360** |

The difference is 34.4% of baseline simulated requests and 27.0% of baseline estimated CU **for this fixture only**. The baseline and optimized result digests both equal `0xa27a774087ddeb0465d7315bb37edecdc904b93cd409ca571c251712a8545753`; candidate approval/rejection, depth result, event ordering, creation/boundary answers, and returned logs are unchanged. No historical log page was removed to achieve the reduction.

## Cache, pagination, and resource observations

- Verified token metadata: four misses/four hits on the optimized path; key includes chain, token address, verified bytecode identity and canonical block evidence. Fresh code checks remain. Historical pool creation: two misses/two hits, with creation-block canonical hash validation on reuse. Mismatches, reorg evidence, and corrupt cache fail closed or recompute under the existing tests.
- Cycle-scoped boundary cache: maximum two entries in this run; runtime capacity is bounded at 128. It is not shared with the next cycle or a different pinned head. Observation-local memo: four hits and four misses each for block metadata, historical state, and transaction lookup; 12 equivalent historical reads avoided, three maximum resident entries in this run. The memo does not cross a signer authorization boundary or cache mutable latest state.
- Both paths made 28 log queries across four complete windows, each returning eight logs (32 total). Provider-style range-limit errors caused 12 recursive splits; all required pages were recovered. The four logged provider errors are deliberate fake split triggers, not failed final observations. Exact initialized-tick/depth calls and screening conclusions stayed identical.
- The optimized evidence file was 2,258 bytes in this fixture. This does not measure peak RSS; no production memory footprint was inferred. Wall times (about 257 ms versus 139 ms in one run) are local fake-transport timings and not a credible network-latency saving.
- Telemetry keeps chain/workflow/method/process-role attribution and bounded counters for logical calls, observable physical attempts, retries/fallbacks, errors, latency, candidates, cache outcomes, and log pagination. Screening, management, and signer execution are distinguishable; this benchmark exercises screening/historical paths, not a live management tick or live transaction.

## Existing evidence and limits

The earlier Phase 3B.2 bounded **live read-only profiling path** recorded 240 physical attempts and 5,824 estimated CU, including 104 `eth_call`, 68 block reads, 33 code reads, and 14 log queries. It used different scenarios and cannot be subtracted from this fixture or presented as a production before/after result. No actual Alchemy-billed CU or USD savings can be attributed to these local code changes without separately authorized, workload-matched production telemetry. Manual LP use must remain a separate workload.

Fresh pinned pool identity, full V4 PoolKey/PoolId and hook checks, current pool state, receipt/finality verification, all historical log pages, exact fee/depth, and independent signer-handoff confirmation remain mandatory. The benchmark deliberately did not cache latest prices, balances, fee growth, initialized ticks across observations, or transaction authorization evidence. No further speculative cache is recommended from this result.
