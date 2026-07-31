// Thin WS abstraction. Re-exports from `@app/binance` so the worker stays
// thin — the canonical source moved next to its consumer (the
// MarketDataPort adapter) when #225 slice 2 introduced KlineFetcher.

export { createWsFactory, type BinanceWs, type BinanceWsFactory } from '@app/binance';
