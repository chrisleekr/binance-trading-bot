// Thin WS abstraction for Binance market-data adapters.
//
// Production wires `createWsFactory(WebSocket)` against the `ws` package;
// tests inject a stub that records sends and replays scripted messages.
// Moved here from `apps/worker/src/market-data/binance-ws.ts` so the
// abstraction lives next to its consumer (the `MarketDataPort` adapter).
//
// The interface is intentionally narrow: send a string, observe lifecycle
// events. Adapters layer reconnect/backoff/parsing on top.

export interface BinanceWs {
  send(payload: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
}

export type BinanceWsFactory = (url: string) => BinanceWs;

interface WsLike {
  on(event: 'message', cb: (data: { toString(encoding: string): string }) => void): void;
  on(event: 'open' | 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(payload: string): void;
  close(): void;
}

type WsCtor = new (url: string) => WsLike;

/**
 * Wraps a node `ws` constructor (or any compatible class) in the narrow
 * `BinanceWs` interface so adapters can swap a real socket for a fake at
 * the boundary. Best-effort close — a duplicate close throws on some
 * platforms; the reconnect loop owns the recovery so a swallowed
 * exception here is correct.
 */
export const createWsFactory =
  (WsCtorImpl: WsCtor): BinanceWsFactory =>
  (url) => {
    const ws = new WsCtorImpl(url);
    return {
      send(payload) {
        ws.send(payload);
      },
      close() {
        try {
          ws.close();
        } catch {
          // best-effort; the reconnect loop owns recovery
        }
      },
      onOpen(handler) {
        ws.on('open', handler);
      },
      onMessage(handler) {
        ws.on('message', (data) => {
          handler(data.toString('utf8'));
        });
      },
      onClose(handler) {
        ws.on('close', () => handler());
      },
      onError(handler) {
        ws.on('error', handler);
      },
    };
  };
