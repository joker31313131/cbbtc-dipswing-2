// Dip-buy mean-reversion bot for the BTC race: one asset (CBBTC), long only,
// one position at a time, full size. The strategy lives in strategy.ts; this
// file speaks the bars-replay protocol through the kit's shim and turns the
// strategy's signals into orders.
//
//   - hello: one batch per minute carries the bar that just closed, the fills
//     of the previous batch's orders, and the account. Every batch gets
//     exactly one reply echoing its seq, before the next batch arrives.
//   - A buy decided on a batch fills at the next bar's open, so the signal is
//     evaluated on the close and the fill price is the next open, moved by the
//     modelled slippage, the fee and the pool impact. Sells go out whole: the
//     full position, every time, so the position's cost basis always belongs
//     to exactly one entry.
//   - Orders cap their slippage at 1% past the close they were decided on, so
//     a fill through a gap is refused (and the signal retried on the next bar)
//     rather than filled far from the price the decision saw.
//   - Diagnostics go to stderr only; stdout carries replies alone.

import { BPS, runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';
import { DipStrategy, type DipParams } from './strategy.ts';

const SYMBOL = 'CBBTC';
/** Slippage cap per order, in bps past the close the decision saw. */
const MAX_SLIPPAGE_BPS = 100;

const PARAMS: DipParams = {
  fastSpan: 60,
  slowSpan: 120,
  dipBps: 60,
  dipRef: 'slow',
  trendFilter: false,
  bounce: true,
  takeProfitBps: 80,
  stopLossBps: 80,
  haltBps: 400,
  cooldownBars: 30,
  noEntryBars: 30,
  maxHoldBars: 1440,
};

const strategy = new DipStrategy(PARAMS);

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    const held = state.positions.get(SYMBOL);
    const signal = strategy.onBar({
      seq: batch.seq,
      close: bar === undefined ? null : Number(bar.c),
      position: held === undefined ? null : { value: state.value(SYMBOL, held.qty), cost: held.cost },
      equity: state.equity,
      startEquity: BigInt(state.hello.capital.quote_units),
      warmingUp: state.warmingUp,
      firstTradeSeq: state.warmupBars,
    });
    if (signal === 'sell' && held !== undefined) {
      const order: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [order];
    }
    if (signal === 'buy' && held === undefined) {
      const { caps, fees } = state.hello;
      // Full size: all the cash, within the weight cap, above the minimum.
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let spend = state.cash < byWeight ? state.cash : byWeight;
      if (spend < BigInt(fees.min_notional_quote_units)) return [];
      const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [order];
    }
    return [];
  },
});
