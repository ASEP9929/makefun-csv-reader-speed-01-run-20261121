[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/ASEP9929/makefun-csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/ASEP9929/makefun-csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# Faster CSV reader — csv-reader-speed-01-run-20261121

A drop-in, dependency-free replacement for csv-reader 1.0.0 that reads broken
CSV files faster. Entry for the [make.fun bounty](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
"Read broken CSV files faster, 21 November 2026".

`solve.js` exports `run(input)`, returning exactly `{columns, rows, errors}`
for `{text, header}` — the same answer csv-reader 1.0.0 gives for every input,
including its broken-row policy (BOM, CRLF/LF, stray CRs, quoted fields,
doubled quotes, unterminated quotes, quote junk, short/long rows).

How it gets faster: records with no quote and no CR are split natively;
everything else is parsed with `indexOf` jumps and one-pass delimiter scans
instead of one character at a time, with the field reader inlined and no
per-field result arrays allocated.

Local benchmark (6 practice cases, ~10.2 MB of CSV, Node 24,
`--no-incremental-marking`):

| implementation | median ms/run |
|---|---|
| csv-reader 1.0.0 (house baseline) | ~566–759 |
| this entry | ~125–154 |

About 4–5× faster, byte-identical answers on all 6 practice cases and on
120,000 fuzzed broken-CSV inputs.

`main.ts` is the harness driver (kept as shipped); `solve.js` is the entry.
