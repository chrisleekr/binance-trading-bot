# Vendored from `bennycode/trading-signals`

The files in this directory are MIT-licensed code ported verbatim (other than the prepended SPDX header) from <https://github.com/bennycode/trading-signals>.

- **Upstream version**: v7.4.3
- **Upstream commit hash**: `537d859adad67a7bf0c5e812ff621877d9d355fd`
- **Commit date**: 2026-05-19
- **Vendored on**: 2026-05-21
- **Original copyright holder**: © 2020 Benny Neugebauer

## Why vendored, not depended on

Indicator math (RSI/MACD/CCI/etc.) is settled — these formulas have not changed in decades. We have no need for upstream updates, but we may want to tweak a per-indicator threshold if calibration against TradingView shows divergence. Modifying a vendored file is straightforward; modifying an npm dep is not.

## Files vendored

```
error/NotEnoughDataError.ts
error/index.ts
momentum/AO/AO.ts
momentum/CCI/CCI.ts
momentum/MACD/MACD.ts
momentum/MOM/MOM.ts
momentum/RSI/RSI.ts
momentum/STOCH/StochasticOscillator.ts
momentum/STOCHRSI/StochasticRSI.ts
momentum/WILLR/WilliamsR.ts
trend/ADX/ADX.ts
trend/DEMA/DEMA.ts
trend/DX/DX.ts
trend/EMA/EMA.ts
trend/MA/MovingAverage.ts
trend/MA/MovingAverageTypes.ts
trend/RMA/RMA.ts
trend/SMA/SMA.ts
trend/WMA/WMA.ts
trend/WSMA/WSMA.ts
types/HighLowClose.ts
types/Indicator.ts
types/Period.ts
util/getAverage.ts
util/pushUpdate.ts
volatility/ATR/ATR.ts
volatility/MAD/MAD.ts
volatility/TR/TR.ts
volume/VWMA/VWMA.ts
```

`util/index.ts` is NOT vendored — upstream re-exported 13 helpers; we only need two, so the slim re-exporter in this tree is our own code (header notes it).

## Re-syncing from upstream

If a future bug fix or improvement lands upstream worth absorbing:

```fish
cd /tmp && rm -rf trading-signals && git clone --depth 1 https://github.com/bennycode/trading-signals
# diff each file against its upstream counterpart, apply only the change you want,
# update the commit hash + date above.
```

A quarterly check (issue tracker reminder) suffices — there is no reason to track every release.

## License

The upstream MIT license is reproduced below in full and applies to every file in this directory tree, EXCEPT `util/index.ts` which is project-original.

---

MIT License

Copyright (c) 2020 Benny Neugebauer

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
