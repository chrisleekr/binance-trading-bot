# Binance Trading Bot

[![GitHub version](https://img.shields.io/github/package-json/v/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/releases)
[![Build](https://github.com/chrisleekr/binance-trading-bot/workflows/Push/badge.svg)](https://github.com/chrisleekr/binance-trading-bot/actions?query=workflow%3APush)
[![CodeCov](https://codecov.io/gh/chrisleekr/binance-trading-bot/branch/master/graph/badge.svg)](https://codecov.io/gh/chrisleekr/binance-trading-bot)
[![Docker pull](https://img.shields.io/docker/pulls/chrisleekr/binance-trading-bot)](https://hub.docker.com/r/chrisleekr/binance-trading-bot)
[![GitHub contributors](https://img.shields.io/github/contributors/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/graphs/contributors)
[![MIT License](https://img.shields.io/github/license/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/blob/master/LICENSE)

> Automated Binance trading bot with trailing buy/sell strategy

---

[![ko](https://img.shields.io/badge/lang-한국어-brightgreen.svg)](https://github.com/chrisleekr/binance-trading-bot/blob/master/README.ko.md)
[![中文](https://img.shields.io/badge/lang-中文-blue.svg)](https://github.com/chrisleekr/binance-trading-bot/blob/master/README.zh-cn.md)

This is a test project. I am just testing my code.

## Warnings

**I cannot guarantee whether you can make money or not.**

**So use it at your own risk! I have no responsibility for any loss or hardship
incurred directly or indirectly by using this code. Read
[disclaimer](#disclaimer) before using this code.**

**Before updating the bot, make sure to record the last buy price in the note. It may lose the configuration or last buy price records.**

## How it works

### Trailing Grid Trade Buy/Sell Bot

This bot is using the concept of trailing buy/sell order which allows following the price fall/rise.

> Trailing Stop Orders
> About Trailing Stop Orders Concept you can find at [Binance Official document](https://www.binance.com/en/support/faq/360042299292)
>
> TL;DR
> Place orders at a fixed value or percentage when the price changes. Using this feature you can buy at the lowest possible price when buying down and sell at the highest possible price when selling up.

- The bot supports multiple buy/sell orders based on the configuration.
- The bot can monitor multiple symbols. All symbols will be monitored per second.
- The bot is using MongoDB to provide a persistence database. However, it does not use the latest MongoDB to support Raspberry Pi 32bit. Used MongoDB version
  is 3.2.20, which is provided by [apcheamitru](https://hub.docker.com/r/apcheamitru/arm32v7-mongo).
- The bot is tested/working with Linux and Raspberry Pi 4 32bit. Other platforms are not tested.

#### Buy Signal

The bot will continuously monitor the coin based on the grid trade configuration.

For grid trade #1, the bot will place a STOP-LOSS-LIMIT order to buy when the current price reaches the lowest price. If the current price continuously falls, then the bot will cancel the previous order and re-place the new STOP-LOSS-LIMIT order with the new price.

After grid trade #1, the bot will monitor the COIN based on the last buy price.

- The bot will not place a buy order of the grid trade #1 if has enough coin (typically over $10 worth) to sell when reaches the trigger price for selling.
- The bot will remove the last buy price if the estimated value is less than the last buy price removal threshold.

##### Buy Scenario

Let say, if the buy grid trade configurations are set as below:

- Number of grids: 2
- Grids
  | No# | Trigger Percentage  | Stop Price Percentage | Limit price percentage | USDT |
  | --- | ------------------- | --------------------- | ---------------------- | ---- |
  | 1   | 1                   | 1.05                  | 1.051                  | 50   |
  | 2   | 0.8                 | 1.03                  | 1.031                  | 100  |

To make it easier to understand, I will use `$` as a USDT symbol. For the simple calculation, I do not take an account for the commission. In real trading, the quantity may be different.

Your 1st grid trading for buying is configured as below:

- Grid No#: 1
- Trigger percentage: 1
- Stop percentage: 1.05 (5.00%)
- Limit percentage: 1.051 (5.10%)
- Max purchase amount: $50

And the market is as below:

- Current price: $105
- Lowest price: $100
- Trigger price: $100

When the current price is falling to the lowest price ($100) and lower than ATH(All-Time High) restricted price if enabled, the bot will place new STOP-LOSS-LIMIT order for buying.

- Stop price: $100 * 1.05 = $105
- Limit price: $100 * 1.051 = $105.1
- Quantity: 0.47573

Let's assume the market changes as below:

- Current price: $95

Then the bot will follow the price fall and place new STOP-LOSS-LIMIT order as below:

- Stop price: $95 * 1.05 = $99.75
- Limit price: $95 * 1.051 = $99.845
- Quantity: 0.5

Let's assume the market changes as below:

- Current price: $100

Then the bot will execute 1st purchase for the coin. The last buy price will be recorded as `$99.845`. The purchased quantity will be `0.5`.

Once the coin is purchased, the bot will start monitoring the sell signal and at the same time, monitor the next grid trading for buying.

Your 2nd grid trading for buying is configured as below:

- Grid#: 2
- Current last buy price: $99.845
- Trigger percentage: 0.8 (20%)
- Stop percentage: 1.03 (3.00%)
- Limit percentage: 1.031 (3.10%)
- Max purchase amount: $100

And if the current price is continuously falling to `$79.876` (20% lower), then the bot will place new STOP-LOSS-LIMIT order for the 2nd grid trading for the coin.

Let's assume the market changes as below:

- Current price: $75

Then the bot will follow the price fall and place new STOP-LOSS-LIMT order as below:

- Stop price: $75 * 1.03 = $77.25
- Limit price: $75 * 1.031 = $77.325
- Quantity: 1.29

Let's assume the market changes as below:

- Current price: $78

Then the bot will execute 2nd purchase for the coin. The last buy price will be automatically re-calculated as below:

- Final last buy price: ($50 + $100)/(0.5 COIN + 1.29 COIN) = $83.80

### Sell Signal

If there is enough balance for selling and the last buy price is recorded in the bot, then the bot will start monitoring the sell signal of the grid trade #1. Once the current price reaches the trigger price of the grid trade #1, then the bot will place a STOP-LOSS-LIMIT order to sell. If the current price continuously rises, then the bot will cancel the previous order and re-place the new STOP-LOSS-LIMIT order with the new price.

- If the bot does not have a record for the last buy price, the bot will not sell the coin.
- If the coin is worth less than the last buy price removal threshold, then the bot will remove the last buy price.
- If the coin is not worth than the minimum notional value, then the bot will not place an order.

#### Sell Scenario

Let say, if the sell grid trade configurations are set as below:

- Number of grids: 2
- Grids
  | No# | Trigger Percentage  | Stop Price Percentage | Limit price percentage | Sell Quantity Percentage |
  | --- | ------------------- | --------------------- | ---------------------- |------------------------- |
  | 1st | 1.05                | 0.97                  | 0.969                  | 0.5                      |
  | 2nd | 1.08                | 0.95                  | 0.949                  | 1                        |

Unlike buy, the sell configuration will use the percentage of a quantity. If you want to sell all of your coin quantity, then simply configure it as `1` (100%).

From the last buy actions, you now have the following balances:

- Current quantity: 1.79
- Current last buy price: $83.80

Your 1st grid trading for selling is configured as below:

- Grid No# 1
- Trigger percentage: 1.05
- Stop price percentage: 0.97
- Limit price percentage: 0.969
- Sell amount percentage: 0.5

Let's assume the market changes as below:

- Current price: $88

As the current price is higher than the sell trigger price($87.99), then the bot will place new STOP-LOSS-LIMIT order for selling.

- Stop price: $88 * 0.97 = $85.36
- Limit price: $88 * 0.969 = $85.272
- Quantity: 0.895

Let's assume the market changes as below:

- Current price: $90

Then the bot will follow the price rise and place new STOP-LOSS-LIMIT order as below:

- Stop price: $90 * 0.97 = $87.30
- Limit price: $90 * 0.969 = $87.21
- Quantity: 0.895

Let's assume the market changes as below:

- Current price: $87

Then the bot will execute 1st sell for the coin. Then the bot will now wait for 2nd selling trigger price ($83.80 * 1.08 = $90.504).

- Current quantity: 0.895
- Current last buy price: $83.80

Let's assume the market changes as below:

- Current price: $91

Then the current price($91) is higher than 2nd selling trigger price ($90.504), the bot will place new STOP-LOSS-LIMIT order as below:

- Stop price: $91 * 0.95 = $86.45
- Limit price: $91 * 0.949 = $86.359
- Quantity: 0.895

Let's assume the market changes as below:

- Current price: $100

Then the bot will follow the price rise and place new STOP-LOSS-LIMT order as below:

- Stop price: $100 * 0.95 = $95
- Limit price: $100 * 0.949 = $94.9
- Quantity: 0.895

Let's assume the market changes as below:

- Current price: $94

Then the bot will execute 2nd sell for the coin.

The final profit would be

- 1st sell: $94.9 * 0.895 = $84.9355
- 2nd sell: $87.21 * 0.895 = $78.05295
- Final profit: $162 (8% profit)

#### Sell Stop-Loss Scenario

Let say, if the sell Stop-Loss configurations are set as below:

- Max loss percentage: 0.90
- Temporary disable for buying (minutes): 60

And the market is as below:

- Current price: $95
- Last buy price: $100
- Stop-Loss price: $90

Then the bot will not place a Stop-Loss order because the Stop-Loss price ($90) is less than the current price ($95).

If the price is continuously falling, then the bot will keep monitoring until the price reaches the Stop-Loss price.

In the next tick, the market changes as below:

- Current price: $90
- Stop-Loss price: $90

The bot will place new MARKET order for selling because the current price ($90) is less or equal than the Stop-Loss price ($90). In real trading, the quantity may be different.

The bot will also set the symbol to be temporarily disabled for 60 minutes to avoid buying/sell continuously. In the frontend, the action will display the pause icon and how long left to be enabled again. The symbol can be enabled by clicking the play icon.

### [Features](https://github.com/chrisleekr/binance-trading-bot/wiki/Features)

- Manual trade
- Convert small balances to BNB
- Trade all symbols
- Monitoring multiple coins simultaneously
- Stop-Loss
- Restrict buying with ATH price
- Grid Trade for buy/sell

### Frontend + WebSocket

React.js based frontend communicating via Web Socket:

- List monitoring coins with buy/sell signals/open orders
- View account balances
- View open/closed trades
- Manage global/symbol settings
- Delete caches that are not monitored
- Link to public URL
- Support Add to Home Screen
- Secure frontend

## Environment Parameters

Use environment parameters to adjust parameters. Check `/config/custom-environment-variables.json` to see list of available environment parameters.

Or use the frontend to adjust configurations after launching the application.

## How to use

1. Create `.env` file based on `.env.dist`.

   | Environment Key                | Description                                                               | Sample Value                                                                                        |
   | ------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
   | BINANCE_LIVE_API_KEY           | Binance API key for live                                                  | (from [Binance](https://binance.zendesk.com/hc/en-us/articles/360002502072-How-to-create-API))      |
   | BINANCE_LIVE_SECRET_KEY        | Binance API secret for live                                               | (from [Binance](https://binance.zendesk.com/hc/en-us/articles/360002502072-How-to-create-API))      |
   | BINANCE_TEST_API_KEY           | Binance API key for test                                                  | (from [Binance Spot Test Network](https://testnet.binance.vision/))                                 |
   | BINANCE_TEST_SECRET_KEY        | Binance API secret for test                                               | (from [Binance Spot Test Network](https://testnet.binance.vision/))                                 |
   | BINANCE_SLACK_ENABLED          | Slack enable/disable                                                      | true                                                                                                |
   | BINANCE_SLACK_WEBHOOK_URL      | Slack webhook URL                                                         | (from [Slack](https://slack.com/intl/en-au/help/articles/115005265063-Incoming-webhooks-for-Slack)) |
   | BINANCE_SLACK_CHANNEL          | Slack channel                                                             | "#binance"                                                                                          |
   | BINANCE_SLACK_USERNAME         | Slack username                                                            | Chris                                                                                               |
   | BINANCE_LOCAL_TUNNEL_ENABLED   | Enable/Disable [local tunnel](https://github.com/localtunnel/localtunnel) | true                                                                                                |
   | BINANCE_LOCAL_TUNNEL_SUBDOMAIN | Local tunnel public URL subdomain                                         | binance                                                                                             |
   | BINANCE_AUTHENTICATION_ENABLED | Enable/Disable frontend authentication                                    | true  |
   | BINANCE_AUTHENTICATION_PASSWORD | Frontend password                                                        | 123456 |
   | BINANCE_LOG_LEVEL               | Logging level. [Possible values described on `bunyan` docs.](https://www.npmjs.com/package/bunyan#levels) | ERROR |

   *A local tunnel makes the bot accessible from the outside. Please set the subdomain of the local tunnel as a subdomain that only you can remember.*
   *You must change the authentication password; otherwise, it will be configured as the default password.*

2. Launch/Update the bot with docker-compose

   Pull latest code first:

   ```bash
   git pull
   ```

   If want production/live mode, then use the latest build image from DockerHub:

   ```bash
   docker-compose -f docker-compose.server.yml pull
   docker-compose -f docker-compose.server.yml up -d
   ```

   Or if want development/test mode, then run below commands:

   ```bash
   docker-compose up -d --build
   ```

3. Open browser `http://0.0.0.0:8080` to see the frontend

   - When launching the application, it will notify public URL to the Slack.
   - If you have any issue with the bot, you can check the log to find out what happened with the bot. Please take a look [Troubleshooting](https://github.com/chrisleekr/binance-trading-bot/wiki/Troubleshooting)

### Install via Stackfile

1. In [Portainer](https://www.portainer.io/) create new Stack

2. Copy content of `docker-stack.yml` or upload the file

3. Set environment keys for `binance-bot` in the `docker-stack.yml`

4. Launch and open browser `http://0.0.0.0:8080` to see the frontend

## Screenshots

| Password Protected | Frontend Mobile |
| ------------------ | --------------- |
| ![Password Protected](https://user-images.githubusercontent.com/5715919/127773484-51d01881-4933-454e-9052-9965b222e716.png) | ![Frontend Mobile](https://user-images.githubusercontent.com/5715919/132074850-e5caf676-a385-4cca-b1dc-4fbe538a28c4.png) |

| Setting | Manual Trade |
| ------- | ------------ |
| ![Setting](https://user-images.githubusercontent.com/5715919/127318581-4e422ac9-b145-4e83-a90d-5c05c61d6e2f.png) | ![Manual Trade](https://user-images.githubusercontent.com/5715919/127318630-f2180e1b-3feb-48fa-a083-4cb7f90f743f.png) |

| Frontend Desktop  | Closed Trades |
| ----------------- | ------------- |
| ![Frontend Desktop](https://user-images.githubusercontent.com/5715919/132074902-da9cf959-7533-409e-806d-8be20db2e57e.png) | ![Closed Trades](https://user-images.githubusercontent.com/5715919/132074927-d6739de0-910f-496a-b71d-508905c6adc1.png) |

### Sample Trade

| Chart                                                                                                          | Buy Orders                                                                                                          | Sell Orders                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Chart](https://user-images.githubusercontent.com/5715919/111027391-192db300-8444-11eb-8df4-91c98d0c835b.png) | ![Buy Orders](https://user-images.githubusercontent.com/5715919/111027403-36628180-8444-11eb-91dc-f3cdabc5a79e.png) | ![Sell Orders](https://user-images.githubusercontent.com/5715919/111027411-4b3f1500-8444-11eb-8525-37f02a63de25.png) |

## Changes & Todo

Please refer
[CHANGELOG.md](https://github.com/chrisleekr/binance-trading-bot/blob/master/CHANGELOG.md)
to view the past changes.

- [ ] Clear exchange/symbol info cache in the Redis periodically - [#284](https://github.com/chrisleekr/binance-trading-bot/issues/284)
- [ ] Improve sell strategy with conditional stop price percentage based on the profit percentage - [#94](https://github.com/chrisleekr/binance-trading-bot/issues/94)
- [ ] Add sudden drop buy strategy - [#67](https://github.com/chrisleekr/binance-trading-bot/issues/67)
- [ ] Add minimum required order amount - [#84](https://github.com/chrisleekr/binance-trading-bot/issues/84)
- [ ] Manage setting profiles (save/change/load?/export?) - [#151](https://github.com/chrisleekr/binance-trading-bot/issues/151)
- [ ] Improve notifications by supporting Apprise - [#106](https://github.com/chrisleekr/binance-trading-bot/issues/106)
- [ ] Support cool time after hitting the lowest price before buy - [#105](https://github.com/chrisleekr/binance-trading-bot/issues/105)
- [ ] Reset global configuration to initial configuration - [#97](https://github.com/chrisleekr/binance-trading-bot/issues/97)
- [ ] Support limit for active buy/sell orders - [#147](https://github.com/chrisleekr/binance-trading-bot/issues/147)
- [ ] Develop simple setup screen for secrets
- [ ] Support multilingual frontend - [#56](https://github.com/chrisleekr/binance-trading-bot/issues/56)
- [ ] Non linear stop price and chase function - [#246](https://github.com/chrisleekr/binance-trading-bot/issues/246)
- [ ] Support STOP-LOSS configuration per grid trade for selling - [#261](https://github.com/chrisleekr/binance-trading-bot/issues/261)
- [ ] Support triggering buy automatically to rescheduled if the price is over the ATH

## Donations

If you find this project helpful, feel free to make a small
[donation](https://github.com/chrisleekr/binance-trading-bot/blob/master/DONATIONS.md)
to the developer.

## Acknowledgments

- [@d0x2f](https://github.com/d0x2f)
- And many others! Thanks guys!

## Contributors

Thanks to all contributors :heart: [Click to see our heroes](https://github.com/chrisleekr/binance-trading-bot/graphs/contributors)

## Disclaimer

I give no warranty and accepts no responsibility or liability for the accuracy or the completeness of the information and materials contained in this project. Under no circumstances will I be held responsible or liable in any way for any claims, damages, losses, expenses, costs or liabilities whatsoever (including, without limitation, any direct or indirect damages for loss of profits, business interruption or loss of information) resulting from or arising directly or indirectly from your use of or inability to use this code or any code linked to it, or from your reliance on the information and material on this code, even if I have been advised of the possibility of such damages in advance.

**So use it at your own risk!**
