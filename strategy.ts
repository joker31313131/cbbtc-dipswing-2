// Dip-buy mean reversion on cbBTC 1-minute bars.
//
// The idea: in an uptrend, short pullbacks toward the fast EMA tend to bounce.
// Buy the dip, take a quick profit on the bounce, cut the trade fast when the
// dip keeps falling. Long only, one position at a time, full size.
//
// Rules, evaluated on each bar's close (fills happen at the next bar's open):
//   - Indicators: EMA(60) and EMA(240) of closes, seeded as the mean of their
//     first span of closes, then moving 2 / (span + 1) toward each new close.
//     A minute with no bar for the symbol adds nothing.
//   - Entry (flat only): the close sits at least dipBps below EMA(60), the
//     trend filter holds (EMA(60) above EMA(240)) when enabled, and the close
//     ticked up from the previous bar's close when the bounce rule is enabled.
//     No entry while warming up, in cooldown after an exit, halted, or in the
//     last noEntryBars bars of the window (an order decided on the last batch
//     is rejected, and a position opened at the very end is flattened at the
//     last close for the same costs without time to earn them back).
//   - Exit (holding): the position is worth takeProfitBps over its cost, or
//     stopLossBps under it, or the fast EMA falls under the slow one (trend
//     flip, only when the trend filter is enabled), or the position has been
//     held maxHoldBars bars without either (time exit: cut a bounce that
//     never came instead of riding the drift), or equity falls haltBps
//     under the starting capital (equity halt: flatten and never trade again).
//   - Cooldown: after a position disappears (an exit filled), no new entry
//     for cooldownBars bars, so one whipsaw does not chain into the next.
//
// Everything is deterministic: float64 EMAs on + - * / alone, no clock, no
// randomness, no environment. The same bars always give the same signals.

export interface DipParams {
  /** Fast EMA span in bars. */
  fastSpan: number;
  /** Slow EMA span in bars. */
  slowSpan: number;
  /** Entry: close must be at least this many bps below the fast EMA. */
  dipBps: number;
  /** Which EMA the dip is measured against: the fast one or the slow one. */
  dipRef: 'fast' | 'slow';
  /** Entry: require the fast EMA above the slow EMA; exit on the flip back. */
  trendFilter: boolean;
  /** Entry: require the close above the previous bar's close. */
  bounce: boolean;
  /** Exit: position value this many bps over its cost. */
  takeProfitBps: number;
  /** Exit: position value this many bps under its cost. */
  stopLossBps: number;
  /** Equity halt: equity this many bps under starting capital stops trading. */
  haltBps: number;
  /** Bars to wait after an exit before a new entry. */
  cooldownBars: number;
  /** No new entries in the last this many bars of the scored window. */
  noEntryBars: number;
  /** Exit a position held this many bars without hitting profit or stop. */
  maxHoldBars: number;
}

export interface BarInput {
  /** Batch sequence number. */
  seq: number;
  /** The symbol's close on this bar (raw price units), null when absent. */
  close: number | null;
  /** The position held, valued at the latest close, or null when flat. */
  position: { value: bigint; cost: bigint } | null;
  /** Current equity in quote units. */
  equity: bigint;
  /** Starting capital in quote units (hello.capital). */
  startEquity: bigint;
  /** True while the batch is a warm-up batch: orders would be rejected. */
  warmingUp: boolean;
  /** Seq of the first tradeable batch (hello.warmup_bars, 0 without one). */
  firstTradeSeq: number;
}

export type Signal = 'buy' | 'sell' | 'hold';

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

export class DipStrategy {
  readonly params: DipParams;
  /** Bars in the scored window (dev and race windows are 1,440 each). */
  readonly windowBars: number;
  #fast: Ema;
  #slow: Ema;
  #prevClose: number | null = null;
  #wasHolding = false;
  #lastExitSeq = -1;
  #entrySeq = -1;
  #halted = false;

  constructor(params: DipParams, windowBars = 1440) {
    this.params = params;
    this.windowBars = windowBars;
    this.#fast = { span: params.fastSpan, warm: [], value: null };
    this.#slow = { span: params.slowSpan, warm: [], value: null };
  }

  /** Whether trading is halted for the rest of the run. */
  get halted(): boolean {
    return this.#halted;
  }

  onBar(input: BarInput): Signal {
    const p = this.params;
    // A filled exit shows up as the position disappearing; start the cooldown.
    // A filled entry shows up as a position appearing; start the hold clock.
    if (this.#wasHolding && input.position === null) this.#lastExitSeq = input.seq;
    if (!this.#wasHolding && input.position !== null) this.#entrySeq = input.seq;
    this.#wasHolding = input.position !== null;
    // Indicators read every bar, warm-up included; a missing bar adds nothing.
    if (input.close !== null) {
      stepEma(this.#fast, input.close);
      stepEma(this.#slow, input.close);
    }
    // Equity halt: latch once equity falls far enough under the start.
    if (input.equity * 10_000n <= input.startEquity * BigInt(10_000 - p.haltBps)) {
      this.#halted = true;
    }
    if (input.warmingUp || input.close === null) {
      if (input.close !== null) this.#prevClose = input.close;
      return 'hold';
    }
    const close = input.close;
    const fast = this.#fast.value;
    const slow = this.#slow.value;
    let signal: Signal = 'hold';
    if (input.position !== null) {
      signal = this.#exitSignal(input.position, close, fast, slow, input.seq);
    } else if (!this.#halted && fast !== null && slow !== null) {
      signal = this.#entrySignal(close, fast, slow, input.seq, input.firstTradeSeq);
    }
    this.#prevClose = close;
    return signal;
  }

  #exitSignal(held: { value: bigint; cost: bigint }, _close: number, fast: number | null, slow: number | null, seq: number): Signal {
    const p = this.params;
    if (this.#halted) return 'sell';
    // Take profit / stop loss on value versus cost, in exact integers.
    if (held.value * 10_000n >= held.cost * BigInt(10_000 + p.takeProfitBps)) return 'sell';
    if (held.value * 10_000n <= held.cost * BigInt(10_000 - p.stopLossBps)) return 'sell';
    // Trend flip: the fast EMA falls under the slow one.
    if (p.trendFilter && fast !== null && slow !== null && fast < slow) return 'sell';
    // Time exit: the bounce never came; do not ride the drift.
    if (this.#entrySeq >= 0 && seq - this.#entrySeq >= p.maxHoldBars) return 'sell';
    return 'hold';
  }

  #entrySignal(close: number, fast: number, slow: number, seq: number, firstTradeSeq: number): Signal {
    const p = this.params;
    if (p.trendFilter && fast <= slow) return 'hold';
    // The dip: the close sits far enough under the reference EMA.
    const ref = p.dipRef === 'slow' ? slow : fast;
    if (close > ref * (1 - p.dipBps / 10_000)) return 'hold';
    // The bounce: the close ticked up from the previous bar's close.
    if (p.bounce && (this.#prevClose === null || close <= this.#prevClose)) return 'hold';
    // Cooldown after an exit.
    if (this.#lastExitSeq >= 0 && seq - this.#lastExitSeq <= p.cooldownBars) return 'hold';
    // No fresh entries in the tail of the window.
    if (seq >= firstTradeSeq + this.windowBars - p.noEntryBars) return 'hold';
    return 'buy';
  }
}
