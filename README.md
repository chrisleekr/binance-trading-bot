# Binance Auto Trading Bot

[![Build](https://github.com/chrisleekr/binance-trading-bot/workflows/main/badge.svg)](https://github.com/chrisleekr/binance-trading-bot/actions?query=workflow%3Amain)
[![CodeCov](https://codecov.io/gh/chrisleekr/binance-trading-bot/branch/master/graph/badge.svg)](https://codecov.io/gh/chrisleekr/binance-trading-bot)
[![MIT License](https://img.shields.io/github/license/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/blob/master/LICENSE)

This is a test project. I am just testing my code.

## Warnings

**I cannot guarantee whether you can make money or not.**

**So use it at your own risk! I have no responsibility for any loss or hardship
incurred directly or indirectly by using this code.**

**Before update any changes, make sure record last buy price in the note. It may
lose the configuration or last buy price.**

## How it works

### Trading Bot

This bot is buying at the lowest price without any indicator, never sell under
purchase price. And chase rising money. Stop chaser methodology was the idea
from [@d0x2f](https://github.com/d0x2f). I have found MACD indicators often
mislead buying signal. In box pattern market, buy signal with the lowest price
is effective than using MACD indicators.

- The bot can monitor multiple symbols. Each symbol will be monitored per
  second.
- The bot is only tested and working with USDT pair in the FIAT market such as
  BTCUSDT, ETHUSDT. You can add more FIAT symbols like BUSD, AUD from the
  frontend. However, I didn't test in the live server. So use with your own
  risk.
- Note that if the coin is worth less than $10, then the bot will remove the
  last buy price because Binance does not allow to place an order of less than
  $10.
- The bot is using MongoDB to provide a persistence database. However, it does
  not use the latest MongoDB to support Raspberry Pi 32bit. Used MongoDB version
  is 3.2.20, which is provided by
  [apcheamitru](https://hub.docker.com/r/apcheamitru/arm32v7-mongo).

#### Process

1. Get the next symbol to process

2. Process buy signal

   - Get lowest closed price with period
   - If the current price is lower than the lowest closed price, then **buy
     NOW.**
     - It will only purchase the maximum purchase amount or less.
     - It will not purchase if the base asset, such as BTC, has enough balance
       to place a stop-loss limit order.
     - If trading is disabled, then the bot won't place an order.
   - If the current price is higher than the lowest closed price, then _do not
     buy._

3. Process Stop-Loss-Limit order

   - If there is no open order but have coins enough to sell, then check
     - Get last buy price from the cache
     - If the current price is higher than the minimum profit percentage _last
       buy price_, then **place Stop-Loss-Limit order.**
       - If trading is disabled, then the bot won't place an order.
     - Otherwise, _do not place Stop-Loss-Limit order._
   - If there is an opened Stop-Loss-Limit order, then check the current price.
     - If the current price is higher than stop price, then cancel the open
       order. Then it will place new Stop-Loss-Limit order in next process.

### Frontend + WebSocket

React.js based frontend communicating via Web Socket:

- List monitoring coins with buy/sell signals/open orders
- View account balances
- Manage global/symbol settings
- Delete caches that are not monitored
- Link to public URL

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

   or using the latest build image from DockerHub

   ```bash
   docker-compose -f docker-compose.server.yml up -d
   ```

   or if using Raspberry Pi 32bit. Must build again for Raspberry Pi.

   ```bash
   docker build . --build-arg NODE_ENV=production --target production-stage -t chrisleekr/binance-trading-bot:latest
   docker-compose -f docker-compose.rpi.yml up -d
   ```

4. Open browser `http://0.0.0.0:8080` to see the frontend

   - When launching the application, it will notify public URL to the Slack.

## Screenshots

| Frontend Mobile                                                                                                      | Setting                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot1](https://user-images.githubusercontent.com/5715919/110298077-421b0600-8048-11eb-9763-94ebc2159745.png) | ![Screenshot2](https://user-images.githubusercontent.com/5715919/110298101-4a734100-8048-11eb-8916-4d4381d3161e.png) |

| Frontend Desktop                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot](https://user-images.githubusercontent.com/5715919/110298003-2b74af00-8048-11eb-81d4-52a4696b11f4.png) |

### First trade

| Chart                                                                                                                | Order History                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot1](https://user-images.githubusercontent.com/5715919/99874214-f7f94a80-2c39-11eb-9f6d-92fa7b4cb000.jpeg) | ![Screenshot2](https://user-images.githubusercontent.com/5715919/99874212-f465c380-2c39-11eb-8185-dce0d6d21e27.jpeg) |

### Last 30 days trade

| Trade History                                                                                                        | PNL Analysis                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Screenshot3](https://user-images.githubusercontent.com/5715919/110196375-38eb3700-7e98-11eb-870b-d2d145a6fb97.png) | ![Screenshot4](https://user-images.githubusercontent.com/5715919/110196380-41dc0880-7e98-11eb-98b7-697f5d2f351f.png) |

## Changes & Todo

- [x] Support multiple symbols
- [x] Remove unused methods - Bollinger Bands, MACD Stop Chaser
- [x] Support a maximum purchase amount per symbol
- [x] Develop backend to send cache values for frontend
- [x] Develop a simple frontend to see statistics
- [x] Fix the issue with the configuration
- [x] Update frontend to remove cache
- [x] Fix the issue with rounding when places an order
- [x] Fix the issue with persistent Redis
- [x] Fix the bug last buy price not removed
- [x] Update frontend to be exposed to the public using the local tunnel
- [x] Display account balances in the frontend
- [x] Update frontend to change symbols in the configuration
- [x] Update frontend to change last buy price per symbol
- [x] Change to more persistence database - MongoDB - for configuration and last
      buy price
- [x] Display estimated value in the frontend
- [x] Support other FIAT symbols such as BUSD, AUD
- [x] Allow entering more decimals for the last buy price
- [x] Override buy/sell configuration per symbol
- [x] Support PWA for frontend - now support "Add to Home screen"
- [x] Enable/Disable symbols trading, but continue to monitor
- [x] Add max-size for logging
- [x] Execute chaseStopLossLimitOrder on every process
- [x] Support buy trigger percentage
- [ ] Apply chase-stop-loss-limit order for buy signal as well
- [ ] Override the lowest value in the frontend
- [ ] Re-organise configuration structures
- [ ] Allow browser notification
- [ ] Secure frontend with the password

## Acknowledgments

- [@d0x2f](https://github.com/d0x2f)
- [@Maxoos](https://github.com/Maxoos)
- [@OOtta](https://github.com/OOtta)
