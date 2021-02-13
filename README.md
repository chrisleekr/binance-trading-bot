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

This method is buying at the lowest price without any indicator, never sell
under purchase price. And chase rising money. Stop chaser methodology was the
idea from [@d0x2f](https://github.com/d0x2f). I have found MACD indicators often
mislead buying signal. In box pattern market, buy signal with the lowest price
is effective than using MACD indicators.

#### Note

- This method is only tested and working with USDT pair in the FIAT market such
  as BTCUSDT, ETHUSDT.
- This method can monitor multiple symbols.

#### Process

1. Get the next symbol to process

2. Process buy signal

   - Get lowest closed price with period
   - If the current price is lower than the lowest closed price, then **buy
     NOW.**
     - It will only purchase the maximum purchase amount or less.
     - It will not purchase if the base asset, such as BTC, has enough balance
       to place a stop-loss limit order.
   - If the current price is higher than the lowest closed price, then _do not
     buy._

3. Process Stop-Loss-Limit order

   - If there is no open order but have coins enough to sell, then check
     - Get last buy price from the cache
     - If the current price is higher than the minimum profit percentage _last
       buy price_, then **place Stop-Loss-Limit order.**
     - Otherwise, _do not place Stop-Loss-Limit order._
   - If there is an opened Stop-Loss-Limit order, then check the current price.
     - If the current price is higher than stop price, then cancel the open
       order. Then it will place new Stop-Loss-Limit order in next process.

## Environment Parameters

Use environment parameters to adjust parameters. Check
`/config/custom-environment-variables.json` to see list of available environment
parameters.

Or use the frontend to adjust configurations after launching the application.

## How to use

1. Create `.env` file based on `.env.dist`.

   | Environment Key                | Description                       | Sample Value   |
   | ------------------------------ | --------------------------------- | -------------- |
   | BINANCE_LIVE_API_KEY           | Binance API key for live          | (from Binance) |
   | BINANCE_LIVE_SECRET_KEY        | Binance API secret for live       | (from Binance) |
   | BINANCE_TEST_API_KEY           | Binance API key for test          | (from Binance) |
   | BINANCE_TEST_SECRET_KEY        | Binance API secret for test       | (from Binance) |
   | BINANCE_SLACK_WEBHOOK_URL      | Slack webhook URL                 | (from Slack)   |
   | BINANCE_SLACK_CHANNEL          | Slack channel                     | "#binance"     |
   | BINANCE_SLACK_USERNAME         | Slack username                    | Chris          |
   | BINANCE_LOCAL_TUNNEL_SUBDOMAIN | Local tunnel public URL subdomain | binance        |

2. Check `docker-compose.yml` for `BINANCE_MODE` environment parameter

3. Launch the application with docker-compose

   ```bash
   docker-compose up -d
   ```

   or using the latest build image

   ```bash
   docker-compose -f docker-compose.server.yml up -d
   ```

   [![asciicast](https://asciinema.org/a/371137.png)](https://asciinema.org/a/371137)

4. Open browser `http://0.0.0.0:8080` to see the frontend

   - When launching the application, it will notify public URL to the Slack.

## Frontend + WebSocket

React.js based frontend communicating via Web Socket:

- List monitoring coins with buy/sell signals/open orders
- View account balances
- Manage settings including symbols
- Delete caches that are not monitored
- Link to public URL

| Frontend Mobile                                                                                                       | Setting                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot1](https://user-images.githubusercontent.com/5715919/107846451-fc4b9300-6e37-11eb-95cd-a24cc5cf746f.jpeg) | ![Screenshot2](https://user-images.githubusercontent.com/5715919/107846449-fa81cf80-6e37-11eb-9f4a-d35216997abb.jpeg) |

| Frontend Desktop                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot](https://user-images.githubusercontent.com/5715919/107846474-2a30d780-6e38-11eb-9abd-ebd1c2b60b66.png) |

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
- [x] Remove unused methods - Bollinger Bands, MACD Stop Chaser
- [x] Support a maximum purchase amount per symbol
- [x] Develop backend to send cache values for frontend
- [x] Develop simple frontend to see statistics
- [x] Fix the issue with configuration
- [x] Update frontend to remove cache
- [x] Fix the issue with rounding when places an order
- [x] Fix the issue with persistent Redis
- [x] Fix the bug last buy price not removed
- [x] Update frontend to be exposed to the public using the local tunnel
- [x] Display account balances in the frontend
- [x] Update frontend to change symbols in the configuration
- [x] Update frontend to change last buy price per symbol
- [ ] Secure frontend with the password to disable the configuration
- [ ] Change to more persistence database
