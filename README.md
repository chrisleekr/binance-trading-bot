# Binance Auto Trading Bot

[![Build](https://github.com/chrisleekr/binance-trading-bot/workflows/main/badge.svg)](https://github.com/chrisleekr/binance-trading-bot/actions?query=workflow%3Amain) [![CodeCov](https://codecov.io/gh/chrisleekr/binance-trading-bot/branch/master/graph/badge.svg)](https://codecov.io/gh/chrisleekr/binance-trading-bot) [![MIT License](https://img.shields.io/github/license/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/blob/master/LICENSE)

This is a test project. I am just testing my code. You won't make a big money with this bot.

**Use it at your own risk! I have no responsibility for any loss or hardship incurred directly or indirectly by using this code.**

## How it works

### MACD-Stop-Chaser

The concept of MACD-Stop-Chaser is simple. Buy at low price, never sell under purchase price. Chase rising money. Stop chaser methodology was the idea from [@d0x2f](https://github.com/d0x2f)

1. Detect buy signal

   - Get previous MACD trend (Rising/Falling or Unknown)
   - Get last two MACD trend (All rising or all falling)
   - If previous MACD trend is falling and last two MACD trend is all rising, then check
     - If current closed price is higher than lowest price within 24 hours, then _do not buy._
     - If current closed price is lower or similar than lowest price within 24 hours, then **buy NOW.**

2. Chase Stop-Loss-Limit order

   - If there is no open order but have coins that bought by the buy signal, then check
     - Get last purchase price
     - If current closed price is higher than minimum profit percentage \* last purchase price, then **place Stop-Loss-Limit order.**
     - Otherwise, _do not place Stop-Loss-Limit order._
   - If there is an open Stop-Loss-Limit order, then check current closed price.
     - If current closed price is higher than stop price, then cancel the open order. So it can be place new Stop-Loss-Limit order.

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


## Environment Parameters

Use environment parameter to adjust parameters. Checkout `/config/custom-environment-variables.json`

## First trade

Chart | Order History
------------ | -------------
![IMG_6975](https://user-images.githubusercontent.com/5715919/99874214-f7f94a80-2c39-11eb-9f6d-92fa7b4cb000.jpeg)|![IMG_6973](https://user-images.githubusercontent.com/5715919/99874212-f465c380-2c39-11eb-8185-dce0d6d21e27.jpeg) 





## Todo

[ ] Support multiple symbols
