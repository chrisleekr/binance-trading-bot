// createWsFactory contract tests (#441 coverage).
//
// `createWsFactory(WsCtorImpl)` takes the WebSocket constructor as a
// parameter so production wires the real `ws` class and tests inject a fake.
// The fake records `send`, captures every `on(event, cb)` handler, and lets
// the test fire open / message / close / error to exercise every wrapper
// method including the best-effort close-throws path.

import { describe, expect, it, vi } from 'vitest';

import { createWsFactory } from '../../src/index.js';

interface MsgData {
  toString(encoding: string): string;
}

interface Handlers {
  open?: () => void;
  message?: (data: MsgData) => void;
  close?: () => void;
  error?: (err: Error) => void;
}

class FakeWs {
  readonly url: string;
  readonly sent: string[] = [];
  readonly handlers: Handlers = {};
  closeCalls = 0;
  closeThrows = false;

  constructor(url: string) {
    this.url = url;
  }

  on<K extends keyof Handlers>(event: K, cb: NonNullable<Handlers[K]>): void {
    this.handlers[event] = cb;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.closeThrows) throw new Error('already closed');
  }
}

// Returns a factory plus the array of constructed fakes. The fake ctor pushes
// itself into `instances` so the test reads back the captured socket without
// aliasing `this` to a local (which the lint config forbids).
const fakeFactory = (
  onConstruct?: (ws: FakeWs) => void,
): { factory: ReturnType<typeof createWsFactory>; instances: FakeWs[] } => {
  const instances: FakeWs[] = [];
  const factory = createWsFactory(
    class extends FakeWs {
      constructor(url: string) {
        super(url);
        onConstruct?.(this);
        instances.push(this);
      }
    },
  );
  return { factory, instances };
};

describe('createWsFactory', () => {
  it('constructs the injected ctor with the url and forwards send', () => {
    const { factory, instances } = fakeFactory();
    const ws = factory('wss://stream/test');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.url).toBe('wss://stream/test');

    ws.send('{"method":"SUBSCRIBE"}');
    expect(instances[0]?.sent).toEqual(['{"method":"SUBSCRIBE"}']);
  });

  it('wires onOpen / onClose / onError handlers to the underlying socket', () => {
    const { factory, instances } = fakeFactory();
    const ws = factory('wss://stream/test');

    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    ws.onOpen(onOpen);
    ws.onClose(onClose);
    ws.onError(onError);

    const fake = instances[0];
    fake?.handlers.open?.();
    fake?.handlers.close?.();
    const err = new Error('socket boom');
    fake?.handlers.error?.(err);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('decodes the message Buffer via toString("utf8") before handing it to onMessage', () => {
    const { factory, instances } = fakeFactory();
    const ws = factory('wss://stream/test');

    const onMessage = vi.fn();
    ws.onMessage(onMessage);

    // The real `ws` lib hands a Buffer-like whose toString(encoding) decodes
    // it. Assert the wrapper requests 'utf8' and forwards the decoded string.
    let encodingSeen: string | undefined;
    const data: MsgData = {
      toString(encoding: string) {
        encodingSeen = encoding;
        return 'decoded-frame';
      },
    };
    instances[0]?.handlers.message?.(data);

    expect(encodingSeen).toBe('utf8');
    expect(onMessage).toHaveBeenCalledWith('decoded-frame');
  });

  it('closes the underlying socket', () => {
    const { factory, instances } = fakeFactory();
    const ws = factory('wss://stream/test');
    ws.close();
    expect(instances[0]?.closeCalls).toBe(1);
  });

  it('swallows a throwing close() — best-effort, the reconnect loop owns recovery', () => {
    const { factory, instances } = fakeFactory((ws) => {
      ws.closeThrows = true;
    });
    const ws = factory('wss://stream/test');
    expect(() => ws.close()).not.toThrow();
    expect(instances[0]?.closeCalls).toBe(1);
  });
});
