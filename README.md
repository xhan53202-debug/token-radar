# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/xhan53202-debug/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/xhan53202-debug/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks 178 pre-token DeFi protocols by implied token value using a sealed DefiLlama snapshot from 2026-11-14. It covers the 40-protocol watchlist and adds 138 eligible protocols below the $50 million TVL floor, with 24 live-token protocols displayed separately.

The radar-2 model starts with the median market-cap-per-TVL ratio across qualifying live-token protocols. It applies a bounded category tilt based on live peers, then adjusts for seven-day TVL growth, age with no recorded token, and chain breadth. Every ranked row carries a seven-step farm plan with costs and times.

The dashboard is a static offline page with sorting, search, category and chain filters, a protocol detail drawer, category calibration, and a model sandbox. Sandbox values never change the submitted board. Implied value is a model, not a promise; a record with no token is not proof that none exists.

## Run it

Use Node 22 with TypeScript stripping enabled. Place at least three screenshots in `screenshots/`, then run from the repository root:
