# Viero Auto Size Strategy

AUTO size is deterministic and does not use an LLM. It maps the selected token's
GMGN market cap logarithmically into the configured USD interval:

`sizeUsd = minSize + log(marketCap / marketCapMin) / log(marketCapMax / marketCapMin) * (maxSize - minSize)`

The production defaults are:

- `marketCapMin = $1,000,000`
- `marketCapMax = $100,000,000`
- `minSize = $5`
- `maxSize = $25`

Market cap is clamped to the configured interval. The result is then capped by
the available selected quote-token balance and remaining wallet-exposure limit.
Missing market cap or capacity below the configured minimum fails closed.

FIXED size bypasses this strategy completely. AUTO size never changes take-profit
or stop-loss settings. The legacy strategy response shape remains
`{"sizeUsd": number, "reason": string}` for configuration compatibility only.
