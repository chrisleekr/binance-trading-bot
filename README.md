# Binance Trading Bot

[![GitHub version](https://img.shields.io/github/package-json/v/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/releases)
[![Build](https://github.com/chrisleekr/binance-trading-bot/workflows/main/badge.svg)](https://github.com/chrisleekr/binance-trading-bot/actions?query=workflow%3Amain)
[![CodeCov](https://codecov.io/gh/chrisleekr/binance-trading-bot/branch/master/graph/badge.svg)](https://codecov.io/gh/chrisleekr/binance-trading-bot)
[![Docker pull](https://img.shields.io/docker/pulls/chrisleekr/binance-trading-bot)](https://hub.docker.com/r/chrisleekr/binance-trading-bot)
[![GitHub contributors](https://img.shields.io/github/contributors/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/graphs/contributors)
[![MIT License](https://img.shields.io/github/license/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/blob/master/LICENSE)

> Automated Binance trading bot with trailing buy/sell strategy

---

[![ko](https://img.shields.io/badge/lang-한국어-brightgreen.svg)](https://github.com/chrisleekr/binance-trading-bot/blob/master/README.ko.md)

This is a test project. I am just testing my code.

## Warnings

**I cannot guarantee whether you can make money or not.**

**So use it at your own risk! I have no responsibility for any loss or hardship
incurred directly or indirectly by using this code.**

**Before updating the bot, make sure to record the last buy price in the note.
It may lose the configuration or last buy price records.**

## Breaking Changes

As I introduce a new feature, I did lots of refactoring the code including
settings. If the bot version is lower than the version `0.0.57`, then the update
will cause lost your settings and the last buy price records. You must write
down settings and the last buy price records and re-configure after the upgrade.

If experiences any issue, simply delete all docker volumes/images and re-launch
the bot.

## How it works

### Trailing Buy/Sell Bot

This bot is using the concept of trailing buy/sell order which allows following
the price fall/rise.

- The bot can monitor multiple symbols. Each symbol will be monitored per
  second.
- The bot is only tested and working with USDT pair in the FIAT market such as
  BTCUSDT, ETHUSDT. You can add more FIAT symbols like BUSD, AUD from the
  frontend. However, I didn't test in the live server. So use with your own
  risk.
- The bot is using MongoDB to provide a persistence database. However, it does
  not use the latest MongoDB to support Raspberry Pi 32bit. Used MongoDB version
  is 3.2.20, which is provided by
  [apcheamitru](https://hub.docker.com/r/apcheamitru/arm32v7-mongo).

#### Buy Signal

The bot will continuously monitor the lowest value for the period of the
candles. Once the current price reaches the lowest price, then the bot will
place a STOP-LOSS-LIMIT order to buy. If the current price continuously falls,
then the bot will cancel the previous order and re-place the new STOP-LOSS-LIMIT
order with the new price.

- The bot will not place a buy order if has enough coin (typically over $10
  worth) to sell when reaches the trigger price for selling.

##### Buy Scenario

Let say, if the buy configurations are set as below:

- Maximum purchase amount: $50
- Trigger percentage: 1.005 (0.5%)
- Stop price percentage: 1.01 (1.0%)
- Limit price percentage: 1.011 (1.1%)

And the market is as below:

- Current price: $101
- Lowest price: $100
- Trigger price: $100.5

Then the bot will not place an order because the trigger price ($100.5) is less
than the current price ($101).

In the next tick, the market changes as below:

- Current price: $100
- Lowest price: $100
- Trigger price: $100.5

The bot will place new STOP-LOSS-LIMIT order for buying because the current
price ($100) is less than the trigger price ($100.5). For the simple
calculation, I do not take an account for the commission. In real trading, the
quantity may be different. The new buy order will be placed as below:

- Stop price: $100 \* 1.01 = $101
- Limit price: $100 \* 1.011 = $101.1
- Quantity: 0.49

In the next tick, the market changes as below:

- Current price: $99
- Current limit price: $99 \* 1.011 = 100.089
- Open order stop price: $101

As the open order's stop price ($101) is higher than the current limit price
($100.089), the bot will cancel the open order and place new STOP-LOSS-LIMIT
order as below:

- Stop price: $99 \* 1.01 = $99.99
- Limit price: $99 \* 1.011 = $100.089
- Quantity: 0.49

If the price continuously falls, then the new buy order will be placed with the
new price.

And if the market changes as below in the next tick:

- Current price: $100

Then the current price reaches the stop price ($99.99); hence, the order will be
executed with the limit price ($100.089).

### Sell Signal

If there is enough balance for selling and the last buy price is recorded in the
bot, then the bot will start monitoring the sell signal. Once the current price
reaches the trigger price, then the bot will place a STOP-LOSS-LIMIT order to
sell. If the current price continuously rises, then the bot will cancel the
previous order and re-place the new STOP-LOSS-LIMIT order with the new price.

- If the coin is worth less than typically $10 (minimum notional value), then
  the bot will remove the last buy price because Binance does not allow to place
  an order of less than $10.
- If the bot does not have a record for the last buy price, the bot will not
  sell the coin.

#### Sell Scenario

Let say, if the sell configurations are set as below:

- Trigger percentage: 1.05 (5.0%)
- Stop price percentage: 0.98 (-2.0%)
- Limit price percentage: 0.979 (-2.1%)

And the market is as below:

- Coin owned: 0.5
- Current price: $100
- Last buy price: $100
- Trigger price: $100 \* 1.05 = $105

Then the bot will not place an order because the trigger price ($105) is higher
than the current price ($100).

If the price is continuously falling, then the bot will keep monitoring until
the price reaches the trigger price.

In the next tick, the market changes as below:

- Current price: $105
- Trigger price: $105

The bot will place new STOP-LOSS-LIMIT order for selling because the current
price ($105) is higher or equal than the trigger price ($105). For the simple
calculation, I do not take an account for the commission. In real trading, the
quantity may be different. The new sell order will be placed as below:

- Stop price: $105 \* 0.98 = $102.9
- Limit price: $105 \* 0.979 = $102.795
- Quantity: 0.5

In the next tick, the market changes as below:

- Current price: $106
- Current limit price: $103.774
- Open order stop price: $102.29

As the open order's stop price ($102.29) is less than the current limit price
($103.774), the bot will cancel the open order and place new STOP-LOSS-LIMIT
order as below:

- Stop price: $106 \* 0.98 = $103.88
- Limit price: $106 \* 0.979 = $103.774
- Quantity: 0.5

If the price continuously rises, then the new sell order will be placed with the
new price.

And if the market changes as below in the next tick:

- Current price: $103

The the current price reaches the stop price ($103.88); hence, the order will be
executed with the limit price ($103.774).

### Frontend + WebSocket

React.js based frontend communicating via Web Socket:

- List monitoring coins with buy/sell signals/open orders
- View account balances
- Manage global/symbol settings
- Delete caches that are not monitored
- Link to public URL
- Support Add to Home Screen

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
   git pull
   docker-compose up -d
   ```

   or using the latest build image from DockerHub

   ```bash
   git pull
   docker-compose -f docker-compose.server.yml pull
   docker-compose -f docker-compose.server.yml up -d
   ```

   or if using Raspberry Pi 32bit. Must build again for Raspberry Pi.

   ```bash
   git pull
   docker build . --build-arg NODE_ENV=production --target production-stage -t chrisleekr/binance-trading-bot:latest
   docker-compose -f docker-compose.rpi.yml up -d
   ```

4. Open browser `http://0.0.0.0:8080` to see the frontend

   - When launching the application, it will notify public URL to the Slack.

## Screenshots

| Frontend Mobile                                                                                                          | Setting                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| ![Frontend Mobile](https://user-images.githubusercontent.com/5715919/111430413-72e8f280-874e-11eb-9870-6603282fde8e.png) | ![Setting](https://user-images.githubusercontent.com/5715919/111027223-f2bb4800-8442-11eb-9f5d-95f77298f4c0.png) |

| Frontend Desktop                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- |
| ![Frontend Desktop](https://user-images.githubusercontent.com/5715919/111430212-28677600-874e-11eb-9314-1d617e25fd06.png) |

### Sample Trade

| Chart                                                                                                          | Buy Orders                                                                                                          | Sell Orders                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Chart](https://user-images.githubusercontent.com/5715919/111027391-192db300-8444-11eb-8df4-91c98d0c835b.png) | ![Buy Orders](https://user-images.githubusercontent.com/5715919/111027403-36628180-8444-11eb-91dc-f3cdabc5a79e.png) | ![Sell Orders](https://user-images.githubusercontent.com/5715919/111027411-4b3f1500-8444-11eb-8525-37f02a63de25.png) |

### Last 30 days trade

| Trade History                                                                                                          | PNL Analysis                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ![Trade History](https://user-images.githubusercontent.com/5715919/111430291-4503ae00-874e-11eb-9e68-aefa4bca19b2.png) | ![Profit & Loss](https://user-images.githubusercontent.com/5715919/111430313-4df47f80-874e-11eb-9f3d-e85cf3027d74.png) |

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
- [x] Support PWA for frontend - **now support "Add to Home screen"**
- [x] Enable/Disable symbols trading, but continue to monitor
- [x] Add max-size for logging
- [x] Execute chaseStopLossLimitOrder on every process
- [x] Support buy trigger percentage
- [x] **Breaking changes** Re-organise configuration structures
- [x] Apply chase-stop-loss-limit order for buy signal as well
- [x] Added more candle periods - 1m, 3m and 5m
- [x] Allow to disable local tunnel
- [x] Fix the bug with handling open orders
- [x] Fix the bug with limit step in the frontend
- [x] Updated the frontend to display buy open orders with the buy signal
- [x] Add frontend option to update all symbol configurations
- [ ] Update the bot to monitor all coins every second
- [ ] Add frontend option to disable sorting
- [ ] Add minimum required order amount
- [ ] Allow browser notification in the frontend
- [ ] Secure frontend with the password
- [ ] Develop simple setup screen for secrets

## Acknowledgments

- [@d0x2f](https://github.com/d0x2f)
- [@Maxoos](https://github.com/Maxoos)
- [@OOtta](https://github.com/OOtta)
- [@ienthach](https://github.com/ienthach)
- [@PlayeTT](https://github.com/PlayeTT)
- [@chopeta](https://github.com/chopeta)

## Contributors

<table>
<tr>
    <td align="center" style="word-wrap: break-word; width: 150.0; height: 150.0">
        <a href=https://github.com/chrisleekr>
            <img src=https://avatars.githubusercontent.com/u/5715919?v=4 width="100;"  style="border-radius:50%;align-items:center;justify-content:center;overflow:hidden;padding-top:10px" alt=chrisleekr/>
            <br />
            <sub style="font-size:14px"><b>chrisleekr</b></sub>
        </a>
    </td>
    <td align="center" style="word-wrap: break-word; width: 150.0; height: 150.0">
        <a href=https://github.com/romualdr>
            <img src=https://avatars.githubusercontent.com/u/5497356?v=4 width="100;"  style="border-radius:50%;align-items:center;justify-content:center;overflow:hidden;padding-top:10px" alt=Romuald R./>
            <br />
            <sub style="font-size:14px"><b>Romuald R.</b></sub>
        </a>
    </td>
    <td align="center" style="word-wrap: break-word; width: 150.0; height: 150.0">
        <a href=https://github.com/thamlth>
            <img src=https://avatars.githubusercontent.com/u/45093611?v=4 width="100;"  style="border-radius:50%;align-items:center;justify-content:center;overflow:hidden;padding-top:10px" alt=thamlth/>
            <br />
            <sub style="font-size:14px"><b>thamlth</b></sub>
        </a>
    </td>
</tr>
</table>
