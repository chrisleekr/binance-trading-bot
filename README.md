# Binance Auto Trading API

## How it works

### MACD-Stop-Chaser

The concept of MACD-Stop-Chaser is simple. Buy at low price, never sell under purchase price. Chase rising money.

1. Detect buy signal

   - Get previous MACD trend (Rising/Falling or Unknown)
   - Get last two MACD trend (All rising or all falling)
   - If previous MACD trend is falling and last two MACD trend is all rising, then check
     - If current closed price is higher than lowest price within 24 hours, then _do not buy._
     - If current closed price is lower or similar than lowest price within 24 hours, then **buy NOW.**

2. Chase Stop-Loss-Limit order

   - If there is no open order but have coins that bought by the buy signal, then check
     - Get last purchase price
     - If current closed price is higher than minimum profit percentage \* last purchase price, then place Stop-Loss-Limit order.
     - Otherwise, do not place Stop-Loss-Limit order.
   - If there is an open Stop-Loss-Limit order, then check current closed price.
     - If current closed price is higher than stop price, then cancel the open order. So it can be place new Stop-Loss-Limit order.

## How to use

1. Create `.env` file based on `.env.dist`.

2. Check `docker-compose.yml` for `BINANCE_MODE` environment parameter

3. Launch docker compose

```bash
$ docker-compose up -d
```

or

```bash
$ docker-compose -f docker-compose.server.yml up -d
```

## Environment Parameters

Use environment parameter to adjust parameters. Checkout `/config/custom-environment-variables.json`
