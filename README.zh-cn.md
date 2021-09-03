# Binance Trading Bot

[![GitHub version](https://img.shields.io/github/package-json/v/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/releases)
[![Build](https://github.com/chrisleekr/binance-trading-bot/workflows/main/badge.svg)](https://github.com/chrisleekr/binance-trading-bot/actions?query=workflow%3Amain)
[![CodeCov](https://codecov.io/gh/chrisleekr/binance-trading-bot/branch/master/graph/badge.svg)](https://codecov.io/gh/chrisleekr/binance-trading-bot)
[![Docker pull](https://img.shields.io/docker/pulls/chrisleekr/binance-trading-bot)](https://hub.docker.com/r/chrisleekr/binance-trading-bot)
[![GitHub contributors](https://img.shields.io/github/contributors/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/graphs/contributors)
[![MIT License](https://img.shields.io/github/license/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/blob/master/LICENSE)

> 币安跟踪委托单高买低卖策略交易机器人

---

[![en](https://img.shields.io/badge/lang-English-blue.svg)](https://github.com/chrisleekr/binance-trading-bot/blob/master/README.md)
[![ko](https://img.shields.io/badge/lang-한국어-brightgreen.svg)](https://github.com/chrisleekr/binance-trading-bot/blob/master/README.ko.md)

这只是一个测试项目，代码正在测试中。

## 警告

**我不能保证你能通过这个项目来挣钱**
**所以，使用这个项目的风险由你自己承担，我对使用此代码直接或间接引起的任何损失不承担任何责任。在使用本项目前请先阅读[免责协议](#免责协议)**。
**在更新机器人之前，请确保记录最后的买入价格。更新后可能会丢失配置或最后的买入价格记录。**

## 工作原理

### 跟踪委托买入/卖出机器人

这个机器人使用跟踪买入/卖出订单的概念，跟踪价格的下跌/上涨。

> 跟踪委托单
> 关于跟踪委托的信息可以看币安的[官方文档](https://www.binance.com/zh-CN/support/faq/360042299292)
>
> 简单来说就是在价格变化时，按固定的数值或百分比进行委托。利用这个特性可以在下跌买入时买到尽可能低的价格，在上涨卖出时卖出最高的价格。

- The bot supports multiple buy/sell orders based on the configuration.
- The bot can monitor multiple symbols. All symbols will be monitored per second.
- The bot is using MongoDB to provide a persistence database. However, it does not use the latest MongoDB to support Raspberry Pi 32bit. Used MongoDB version
  is 3.2.20, which is provided by [apcheamitru](https://hub.docker.com/r/apcheamitru/arm32v7-mongo).
- The bot is tested/working with Linux and Raspberry Pi 4 32bit. Other platforms are not tested.

#### 买入信号（Buy Signal）

The bot will continuously monitor the coin based on the grid trade configuration.

For grid trade #1, the bot will place a STOP-LOSS-LIMIT order to buy when the current price reaches the lowest price. If the current price continuously falls, then the bot will cancel the previous order and re-place the new STOP-LOSS-LIMIT order with the new price.

After grid trade #1, the bot will monitor the COIN based on the last buy price.

- The bot will not place a buy order of the grid trade #1 if has enough coin (typically over $10 worth) to sell when reaches the trigger price for selling.
- The bot will remove the last buy price if the estimated value is less than the last buy price removal threshold.

##### 买入方案

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

### 卖出信号

If there is enough balance for selling and the last buy price is recorded in the bot, then the bot will start monitoring the sell signal of the grid trade #1. Once the current price reaches the trigger price of the grid trade #1, then the bot will place a STOP-LOSS-LIMIT order to sell. If the current price continuously rises, then the bot will cancel the previous order and re-place the new STOP-LOSS-LIMIT order with the new price.

- If the bot does not have a record for the last buy price, the bot will not sell the coin.
- If the coin is worth less than the last buy price removal threshold, then the bot will remove the last buy price.
- If the coin is not worth than the minimum notional value, then the bot will not place an order.

#### 卖出方案

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

### [功能](https://github.com/chrisleekr/binance-trading-bot/wiki/Features)

- 手动交易
- 小资产转BNB
- 交易所有硬币
- 同时监控多个硬币
- 止损
- 限制最高价格的购买次数

### 前端 + WebSocket

基于 React.js 的前端，通过 Web Socket 通信:

- List monitoring coins with buy/sell signals/open orders
- View account balances
- Manage global/symbol settings
- Delete caches that are not monitored
- Link to public URL
- Support Add to Home Screen
- Secure frontend

## 环境变量

通过环境变量调整参数. 参考`/config/custom-environment-variables.json` 查看所有的环境变量.

或者在应用启动后调整参数。

## 使用方法

1. 基于 `.env.dist`创建 `.env` 文件

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

   *本地隧道使机器人可以从外部访问。 请将本地隧道的子域设置为只有您能记住的子域。*
  *You must change the authentication password; otherwise, it will be configured as the default password.*

2. Check `docker-compose.yml` for `BINANCE_MODE` environment parameter

3. Launch/Update the bot with docker-compose

   Pull latest code first:

   ```bash
   git pull
   ```

   If want production mode, then use the latest build image from DockerHub:

   ```bash
   docker-compose -f docker-compose.server.yml pull
   docker-compose -f docker-compose.server.yml up -d
   ```

   Or if want development mode, then run below commands:

   ```bash
   docker-compose up -d
   ```

4. Open browser `http://0.0.0.0:8080` to see the frontend

   - When launching the application, it will notify public URL to the Slack.
   - If you have any issue with the bot, you can check the log to find out what
     happened with the bot. Please take a look
     [Troubleshooting](https://github.com/chrisleekr/binance-trading-bot/wiki/Troubleshooting)

### Install via Stackfile

1. In [Portainer](https://www.portainer.io/) create new Stack

2. Copy content of `docker-stack.yml` or upload the file

3. Set environment keys for `binance-bot` in the `docker-stack.yml`

4. Launch and open browser `http://0.0.0.0:8080` to see the frontend

## 截图

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

| 图表                                                                                                          | 买单                                                                                                          | 卖单                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Chart](https://user-images.githubusercontent.com/5715919/111027391-192db300-8444-11eb-8df4-91c98d0c835b.png) | ![Buy Orders](https://user-images.githubusercontent.com/5715919/111027403-36628180-8444-11eb-91dc-f3cdabc5a79e.png) | ![Sell Orders](https://user-images.githubusercontent.com/5715919/111027411-4b3f1500-8444-11eb-8525-37f02a63de25.png) |

## Donations

如果你觉得这个项目对你有帮助，欢迎你给开发者一个小小的[捐赠](https://github.com/chrisleekr/binance-trading-bot/blob/master/DONATIONS.md)

## 免责声明

我对本项目所包含的信息和材料的准确性或完整性不作任何保证，也不承担任何责任或义务。在任何情况下，对于因您使用或无法使用本代码或与之链接的任何代码，或因您依赖本代码上的信息和材料而直接或间接导致的任何索赔、损害、损失、费用、成本或责任（包括但不限于任何利润损失、业务中断或信息损失的直接或间接损害），我不承担任何责任或义务，即使我已事先被告知此类损害的可能性。

**所以请自行承担所有风险!**
