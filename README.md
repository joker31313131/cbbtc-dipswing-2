# cbbtc-dipswing-2

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/joker31313131/cbbtc-dipswing-2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/joker31313131/cbbtc-dipswing-2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Dip-buy mean-reversion bot for Coinbase Wrapped BTC (cbBTC) on 1-minute bars: it buys pullbacks at least 60 bps under the 120-bar EMA once the close ticks back up, takes profit at +80 bps over cost, stops out at -80 bps, and halts if equity falls 4% under the starting capital. Long only, one position at a time, full size. It speaks the agent-fun/bars-replay/v1 protocol on stdin/stdout and is fully deterministic: the same bars always give the same orders.

## Run it

```sh
node main.ts
```

Grade it on the dev window with the competition kit (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/cbbtc-dipswing-2 --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=h7j0gh6r&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
