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

## 最近更新

### 支持所有交易对

机器人现在支持所有交易对（Symbol），比如 ETH/BTC、XRP/BTC。同时，最大购买数量也在全局配置中进行了更新。

一个交易由一个基本资产（base asset）和一个报价资产（quote asset）组成。给定一个交易对 BTC/USDT，BTC 代表基础资产，USDT 代表报价资产。

在全局配置中，你会看到一个“USDT最大购买金额”的字段。如果你配置了这个字段，任何新添加的使用USDT的交易对将被应用于配置的最大购买金额。

默认值将根据交易对的最小名义价值动态计算。

### 支持同时监控多个代币

机器人现在每秒监控所有代币。然而，由于API的限制，交易对的数据不能做到每秒更新。
因此，我不得不为交易对引入锁定机制。当交易对在后台更新数据时，前端会显示锁定图标。在更新数据期间，机器人将不处理订单。

如果有兴趣，可以看一下这个PR [#77](https://github.com/chrisleekr/binance-trading-bot/pull/77)

### 支持限价止损

机器人现在支持限价止损，以防止超过设置中预期的损失。在配置中，你可以启用“止损”，并设置最大亏损百分比和禁用再次下买单的分钟数。机器人将根据最后的买入价格来计算止损的触发价格。

例如，让我们假设 “最大损失百分比（Max loss percentage）” 被配置为 “0.8”，“暂时禁止买入（Temporary disable for buying）”为 60。最后的买入价格是`$100`。那么机器人将计算出止损触发价格为`$80`。当当前价格达到`$80`时，机器人将进行市价买单委托。

目前，该机器人只支持市价订单。

## 工作原理

### 跟踪委托买入/卖出机器人

这个机器人使用跟踪买入/卖出订单的概念，跟踪价格的下跌/上涨。

> 跟踪委托单
> 关于跟踪委托的信息可以看币安的[官方文档](https://www.binance.com/zh-CN/support/faq/360042299292)
>
> 简单来说就是在价格变化时，按固定的数值或百分比进行委托。利用这个特性可以在下跌买入时买到尽可能低的价格，在上涨卖出时卖出最高的价格。

- 该机器人可以监测多个代币，并对每个代币的价格进行每秒监测。
- 这个机器人只在 USDT 交易对中测试过，比如 BTC/USDT，ETH/USDT。你也可以添加其他与法币锚定的稳定币，比如 BUSD、AUD。但是我并没有使用这些稳定币在生产环境测试过，请自行承担风险。
- 该机器人使用 MongoDB 数据库。然而，它并没有没有使用最新的 MongoDB 来支持Raspberry Pi 32bit，使用的 MongoDB 版本是3.2.20，这是由 [apcheamitru](https://hub.docker.com/r/apcheamitru/arm32v7-mongo) 提供的。

#### 买入信号（Buy Signal）

该机器人将持续监测一段时间内的最低值。一旦当前价格达到最低价格，那么机器人将下达买入的 "止损限价单（STOP-LOSS-LIMIT）"指令。如果当前价格持续下跌。那么机器人将取消之前的订单，并重新放置新的"止损限价单（STOP-LOSS-LIMIT）"订单。

- 当达到卖出的触发价格时，如果有足够的持仓（通常超过10美元），机器人就不会再下买单。

##### 买入方案

比方说，使用如下买入配置设置：

- 最大购买金额(Maximum purchase amount): $50
- 触发百分比(Trigger percentage): 1.005 (0.5%)
- 止损百分比(Stop price percentage): 1.01 (1.0%)
- 限价百分比(Limit price percentage): 1.011 (1.1%)

市场情况如下：

- 市场价: $101
- 限价: $100
- 触发价: $100.5

现在机器人不会下单，因为触发价（100.5）低于现价（101）

在下一次市场成交后（next tick），市场情况现在如下：

- 市场价: $100
- 限价: $100
- 触发价: $100.5

现在，机器人会新建一个限价止损单来买入，因为现价(\$100)已经低于了触发价(\$100.5)。为了简化计算，这里没有考虑佣金。在真实的交易中，数量会有不同。新的买入订单会被执行如下：

- 止损价 Stop price: \$100 \* 1.01 = $101
- 限价 Limit price: \$100 \* 1.011 = $101.1
- 数量: 0.49

在下一次市场成交后（next tick），市场情况现在如下：

- 现价: $99
- 当前限价 Current limit price: $99 \* 1.011 = 100.089
- 未平仓止损价 Open order stop price: $101

由于当前的未平仓止损价 101 高于当前限价 100.089，机器人会取消当前的订单并按以下方式重新下单

- 止损价 Stop price: \$99 \* 1.01 = $99.99
- 限价 Limit price: \$99 \* 1.011 = $100.089
- 数量 Quantity: 0.49

如果价格不断下跌，这个新的买单也会不断更新报价。

接下来在一次市场成交后（next tick），市场情况如下：

- 现价 Current price: $100

现在当前价格到了止损价（99.99），因此，买单将会按限价 100.089 报价下单。

### 卖出信号

如果有足够的余额用于卖出，并且最后的买入价格已被记录，那么机器人将开始监测卖出信号。一旦当前价格达到触发价格，机器人将下达一个止损限价单来卖出。如果当前价格持续上涨，那么机器人将取消之前的订单，并重新以新的价格重新下新的止损限价单。

- 如果该币的价值低于10美元（最低名义价值），那么机器人将删除最后的买入价格，因为Binance不允许下低于10美元的订单。
- 如果机器人没有最后买入价格的记录，机器人将不会卖出该币。

#### 卖出方案

比方说，使用如下卖出配置设置：

- 触发百分比 Trigger percentage: 1.05 (5.0%)
- 止损百分比 Stop price percentage: 0.98 (-2.0%)
- 限价百分比 Limit price percentage: 0.979 (-2.1%)

同时市场行情如下：

- 剩余代币数量 Coin owned: 0.5
- 市场价 Current price: $100
- Last buy price: $100
- 触发价 Trigger price: \$100 \* 1.05 = $105

这时机器人将不会提交订单，因为触发价(\$105)低于市场价(\$100)

如果价格持续走低，机器会持续监控价格，直到价格达到触发价

接下来在一次市场成交后（next tick），市场行情如下：

- 市场价 Current price: $105
- 触发价 Trigger price: $105

机器人将提交新的止损限价单进行卖出，因为当前的价格（\$105）高于或等于触发价格（\$105）。
为了简化计算，我没有考虑佣金。在实际交易中，数量可能会有所不同。新的卖单将被提交如下：

- 止损价 Stop price: \$105 \* 0.98 = $102.9
- 限价 Limit price: \$105 \* 0.979 = $102.795
- 数量 Quantity: 0.5

接下来在一次市场成交后（next tick），市场情况如下：

- 市场价 Current price: $106
- 当前限价 Current limit price: $103.774
- 开仓止损价 Open order stop price: $102.29

由于未平仓订单的止损价格（\$102.29）低于当前的限价(\$103.774)，机器人将取消未平仓订单，并提交新的止损限价单，如下所示：

- 止损价 Stop price: \$106 \* 0.98 = $103.88
- 限价 Limit price: \$106 \* 0.979 = $103.774
- 数量 Quantity: 0.5

如果市场价不断升高，新的卖单也会更新报价。

如果市场价格变化：

- 市场价 Current price: $103

目前的价格达到了止损价（\$103.88）；因此，订单将以限价（$103.774）执行。

### 前端 + WebSocket

基于 React.js 的前端，通过 Web Socket 通信:

- List monitoring coins with buy/sell signals/open orders
- View account balances
- Manage global/symbol settings
- Delete caches that are not monitored
- Link to public URL
- Support Add to Home Screen

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

   Or if using Raspberry Pi 4 32bit, must build again for Raspberry Pi:

   ```bash
   npm run docker:build
   docker-compose -f docker-compose.rpi.yml up -d
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

| 前端 移动端 | 设置 | 手工交易 |
| --------- | ---- | ------ |
| ![Frontend Mobile](https://user-images.githubusercontent.com/5715919/120882974-07604400-c61e-11eb-8509-96eaac88231b.png) | ![Setting](https://user-images.githubusercontent.com/5715919/120882990-1810ba00-c61e-11eb-839b-a866fcb355e4.png) | ![Manual Trade](https://user-images.githubusercontent.com/5715919/120883027-41314a80-c61e-11eb-84aa-8b8fc55a4732.png) |

| Frontend Desktop                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- |
| ![Frontend Desktop](https://user-images.githubusercontent.com/5715919/120882948-e992df00-c61d-11eb-913a-bcb19bbfb5ac.png) |

### Sample Trade

| 图表                                                                                                          | 买单                                                                                                          | 卖单                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ![Chart](https://user-images.githubusercontent.com/5715919/111027391-192db300-8444-11eb-8df4-91c98d0c835b.png) | ![Buy Orders](https://user-images.githubusercontent.com/5715919/111027403-36628180-8444-11eb-91dc-f3cdabc5a79e.png) | ![Sell Orders](https://user-images.githubusercontent.com/5715919/111027411-4b3f1500-8444-11eb-8525-37f02a63de25.png) |

## Donations

如果你觉得这个项目对你有帮助，欢迎你给开发者一个小小的[捐赠](https://github.com/chrisleekr/binance-trading-bot/blob/master/DONATIONS.md)

## 免责声明

我对本项目所包含的信息和材料的准确性或完整性不作任何保证，也不承担任何责任或义务。在任何情况下，对于因您使用或无法使用本代码或与之链接的任何代码，或因您依赖本代码上的信息和材料而直接或间接导致的任何索赔、损害、损失、费用、成本或责任（包括但不限于任何利润损失、业务中断或信息损失的直接或间接损害），我不承担任何责任或义务，即使我已事先被告知此类损害的可能性。

**所以请自行承担所有风险!**
