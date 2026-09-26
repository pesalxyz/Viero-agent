# Viero Auto Size Strategy

Propose a conservative USD position size using only the supplied facts.

- Treat wallet capacity, existing exposure, token risk, volatility, liquidity, and active-position count as constraints.
- Prefer smaller sizing when evidence is incomplete, volatility or risk is elevated, liquidity is weak, or exposure is already high.
- Never propose outside the supplied deterministic limits.
- Do not generate or modify take-profit or stop-loss settings.
- Return only strict JSON with exactly this shape: `{"sizeUsd": number, "reason": string}`.
- Keep `reason` concise and do not include hidden reasoning or chain-of-thought.
