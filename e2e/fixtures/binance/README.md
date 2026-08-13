# Binance fixture set

Deterministic Binance REST + WS conversations used by integration and e2e suites. Hand-crafted from the Binance Spot API reference; bodies and types align with `packages/binance/src/binance-rest.ts`.

## Scenarios

| Scenario | Surface | Endpoint / event | What it represents |
| --- | --- | --- | --- |
| `account-info` | REST | `GET /api/v3/account` | Happy-path SPOT balances, `canTrade: true`, three asset rows. |
| `exchange-info` | REST | `GET /api/v3/exchangeInfo` | Two TRADING symbols (BTCUSDT, ETHUSDT) with PRICE_FILTER / LOT_SIZE / NOTIONAL filters. |
| `order-place` | REST | `POST /api/v3/order` | LIMIT BUY accepted as `NEW`, no fills yet. |
| `order-status` | REST | `GET /api/v3/order` | Same LIMIT BUY queried later, now `FILLED`. |
| `execution-report-filled` | WS | `executionReport` | 3 frames: `NEW` → `PARTIALLY_FILLED` → `FILLED`. |
| `account-update` | WS | `outboundAccountPosition` + `balanceUpdate` | Post-fill balance snapshot then a `balanceUpdate` notice. |

## Directory layout

```text
e2e/
├── __tests__/fixtures/binance/loader.test.ts   loader unit tests (mirrors src tree)
└── fixtures/binance/
    ├── README.md                                this file
    ├── loader.ts                                mountBinanceFixtures()
    └── <scenario>/
        ├── rest/<name>.json                     one fixture per file (request + response)
        └── ws/<name>.jsonl                      one frame per line (delayMs + data)
```

## REST fixture file shape

```jsonc
{
  "name": "human-readable label",
  "request": {
    "method": "GET", // or POST / PUT / DELETE
    "path": "/api/v3/account",
    "matchQuery": "any", // or { key: "value" } for partial match
  },
  "response": {
    "status": 200,
    "headers": {
      "content-type": "application/json",
      "x-mbx-used-weight-1m": "20",
    },
    "body": {/* exact response body */},
  },
}
```

`matchQuery: "any"` is the default for Binance fixtures because the private-endpoint signature & timestamp query parameters change every request — strict matching would force every consumer to know the exact signature. Switch to an object when two fixtures on the same `(method, path)` need to be told apart by query (e.g. `GET /api/v3/order` by `symbol`). For `POST /api/v3/order` the side/price/quantity are in the form-encoded body, not the query, so discriminating those fixtures requires a body-level matcher (a future loader extension if needed).

## WS frame file shape (`.jsonl`)

```json
{"delayMs": 0,  "data": { ... binance frame ... }}
{"delayMs": 10, "data": { ... }}
```

`delayMs` is the wait before this frame is sent, applied serially. A sequence `[0, 10, 10]` lands at roughly t+0, t+10, t+20 ms relative to the connection opening.

## Using the loader

```ts
import { mountBinanceFixtures } from '@app/e2e/fixtures/binance/loader.js';

const handle = await mountBinanceFixtures('order-place');
try {
  // REST: globalThis.fetch is patched so POST https://testnet.binance.vision/api/v3/order
  //       returns the fixture body. Calls to unmatched paths on the same host throw.
  // WS:   handle.wsUrl is undefined for this scenario (no ws frames).
} finally {
  await handle.dispose();
}
```

For scenarios with WS frames, point the system under test at `handle.wsUrl` (a `ws://127.0.0.1:<ephemeral>` URL). Each new WebSocket connection re-runs the full frame sequence.

### Interception surface

The loader patches `globalThis.fetch` directly with a roughly 30-line matcher that services requests to the chosen Binance host from the in-memory fixture set and forwards anything else to the original `fetch`. We deliberately avoid `nock` / `@mswjs/interceptors` for the REST layer because their Node `http`-module patching crashes on Bun-on-Alpine with `TypeError: Attempted to assign to readonly property` inside the ClientRequest shim — verified on Bun 1.3.12 in CI. The fixture files themselves stay portable: any consumer that prefers nock's assertion API can still load the same JSON files and feed them into nock from a Node-on-glibc runtime.

Only one mount may be live per process at a time — a second concurrent `mountBinanceFixtures(...)` call throws until the prior handle's `dispose()` resolves. `dispose()` is idempotent and only undoes the fetch patch the mount installed itself, so an outer harness that installed its own fetch wrapper before us is preserved.

## Capture procedure (optional — future regen)

Today every fixture is hand-crafted, so no live testnet credentials are required to land or run them. Regenerating from testnet is documented here for the future when the canonical scenario list grows large enough that hand-crafting becomes too error-prone.

1. Provision testnet keys at <https://testnet.binance.vision> and IP-allowlist your runner.
2. Drive each scenario against `https://testnet.binance.vision` with `BINANCE_TESTNET_API_KEY`/`BINANCE_TESTNET_API_SECRET`.
3. Capture with `mitmproxy` for a full headers/body dump, or wrap a tiny `fetch` proxy that records `(method, path, query, status, headers, body)` tuples.
4. **Scrub** before committing:
   - Remove `X-MBX-APIKEY` request header.
   - Remove `signature`, `timestamp`, `recvWindow` query params, and any `apiKey` values from bodies.
   - Replace `clientOrderId`, `orderId`, `accountAlias`, and any user-tagged identifiers with stable fixture-namespaced values (e.g. `fixture-limit-buy-1`).
   - Replace event-time/`time`/`updateTime`/`E`/`T`/`O`/`W` fields with fixed values (the suite pins clocks); the round numbers `1700000000000`+offset are used across the existing fixtures.
5. Split into one file per `(method, path)` conversation under the scenario directory; keep the schema documented above.
