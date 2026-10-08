# Benchmark

Measured 2026-10-06 with `node --experimental-strip-types --test src/engine/engine.test.ts` on this machine (Node 22, Linux). These are in-process synthetic snapshots, not live provider latency and not network time.

Each snapshot is one fictional in-play match with one goal. The engine emits match-created, match-started, and the goal, so sample counts are about 3× matches until the 4096-sample ring fills.

Nearest-rank percentiles. No interpolation.

| Matches | Wall time for the whole loop | Samples kept | p50 | p75 | p90 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 3.965 ms | 300 | 0.015 ms | 0.019 ms | 0.028 ms | 0.039 ms | 0.114 ms | 0.669 ms |
| 500 | 28.249 ms | 1500 | 0.015 ms | 0.024 ms | 0.055 ms | 0.194 ms | 0.501 ms | 1.216 ms |
| 1000 | 70.143 ms | 3000 | 0.035 ms | 0.048 ms | 0.103 ms | 0.200 ms | 0.479 ms | 1.905 ms |
| 5000 | 1512.166 ms | 4096 (ring cap, biased to later events) | 0.336 ms | 0.372 ms | 0.769 ms | 1.742 ms | 5.251 ms | 14.119 ms |

CPU and RSS were not sampled in this run. Not invented.

Provider-side delay is not in this table. API-Football documents a 15-second update plus possible extra delay. Sportmonks documents a 10-second cycle. Those dominate anything in the table above.

Re-run:

```
node --experimental-strip-types --test src/engine/engine.test.ts
```

The batch test prints a JSON line with the same fields.
