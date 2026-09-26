# Viero Auto Range Strategy

AUTO range is deterministic and does not use an LLM. It creates a single-sided,
selected-quote-token-only range using:

`rangePct = clamp(minRange + volatilityPct / volatilityReferencePct * (maxRange - minRange), minRange, maxRange)`

The production defaults are:

- `minRange = 30%`
- `maxRange = 85%`
- `volatilityReference = 5%`

At or above the reference volatility, the range is capped at 85%. Missing or
invalid volatility fails closed. FIXED range bypasses this strategy completely.
AUTO range never changes take-profit or stop-loss settings. The legacy strategy
response shape remains `{"rangePct": number, "reason": string}` for configuration
compatibility only.
