# Binance Auto Trading Bot

[![Build](https://github.com/chrisleekr/binance-trading-bot/workflows/main/badge.svg)](https://github.com/chrisleekr/binance-trading-bot/actions?query=workflow%3Amain)
[![CodeCov](https://codecov.io/gh/chrisleekr/binance-trading-bot/branch/master/graph/badge.svg)](https://codecov.io/gh/chrisleekr/binance-trading-bot)
[![MIT License](https://img.shields.io/github/license/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/blob/master/LICENSE)

This is a test project. I am just testing my code. **I cannot guarantee whether
you can make money or not.**

**So use it at your own risk! I have no responsibility for any loss or hardship
incurred directly or indirectly by using this code.**

## How it works

### Simple-Stop-Chaser

This method is buying at lowest price without any indicator, never sell under
purchase price. And chase rising money. Stop chaser methodology was the idea
from [@d0x2f](https://github.com/d0x2f). I have found MACD indicators often
mislead buying signal. In box pattern market, buy signal with lowest price is
effective than using MACD indicators.

#### Note

- This method is only tested and working with USDT pair in the FIAT market such
  as BTCUSDT, ETHUSDT.
- This method can monitor multiple symbols.

#### Process

1. Get next symbol

2. Detect buy signal

   - Get lowest closed price with period
   - If current closed price is lower than lowest closed price, then **buy
     NOW.**
     - It will only purchase maximum purchase amount or less.
     - It will not purchase if base asset, such as BTC, has enough balance to
       place stop loss limit order.
   - If current closed price is higher than lowest closed price, then _do not
     buy._

3. Chase Stop-Loss-Limit order

   - If there is no open order but have coins that bought by the buy signal,
     then check
     - Get last purchase price
     - If current closed price is higher than minimum profit percentage \* last
       purchase price, then **place Stop-Loss-Limit order.**
     - Otherwise, _do not place Stop-Loss-Limit order._
   - If there is an open Stop-Loss-Limit order, then check current closed price.
     - If current closed price is higher than stop price, then cancel the open
       order. So it can be place new Stop-Loss-Limit order.

## Environment Parameters

Use environment parameter to adjust parameters. Checkout
`/config/custom-environment-variables.json`

## How to use

1. Create `.env` file based on `.env.dist`.

2. Check `docker-compose.yml` for `BINANCE_MODE` environment parameter

3. Launch docker compose

   ```bash
   docker-compose up -d
   ```

   or using latest build image

   ```bash
   docker-compose -f docker-compose.server.yml up -d
   ```

[![asciicast](https://asciinema.org/a/371137.png)](https://asciinema.org/a/371137)

4. Open browser `http://0.0.0.0:8080` to see frontend statistics

## Frontend + WebSocket

React.js based frontend communicating via Web Socket

- List monitoring coins with buy/sell signals
- Manage settings

| Frontend Mobile                                                                                                       | Setting                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot1](https://user-images.githubusercontent.com/5715919/106989986-77250600-67c7-11eb-97c7-3383dccd45b4.jpeg) | ![Screenshot2](https://user-images.githubusercontent.com/5715919/106989983-75f3d900-67c7-11eb-94f0-fdf6d3256c11.jpeg) |

| Frontend Desktop                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot](https://user-images.githubusercontent.com/5715919/106990244-f6b2d500-67c7-11eb-8f63-9603649f9d7d.png) |

## Trades

### First trade

| Chart                                                                                                                | Order History                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot1](https://user-images.githubusercontent.com/5715919/99874214-f7f94a80-2c39-11eb-9f6d-92fa7b4cb000.jpeg) | ![Screenshot2](https://user-images.githubusercontent.com/5715919/99874212-f465c380-2c39-11eb-8185-dce0d6d21e27.jpeg) |

### Last 30 days trade

| Trade History                                                                                                        | PNL Analysis                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot3](https://user-images.githubusercontent.com/5715919/104917671-d4f3d880-59e7-11eb-87ea-b73a8e75f725.jpg) | ![Screenshot4](https://user-images.githubusercontent.com/5715919/104917674-d6250580-59e7-11eb-911f-9d5491fdfdcb.jpg) |

## Todo

- [x] Support multiple symbols
- [x] Removed unused methods - Bollinger Bands, MACD Stop Chaser
- [x] Support maximum purchase amount per symbol
- [x] Develop backend to send cache values for frontend
- [x] Develop simple frontend to see statistics
