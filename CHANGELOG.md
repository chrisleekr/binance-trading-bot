# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Added indexes for MongoDB
- Updated configuration to use cache as well to improve performance
- Updated redis.conf to disable AOF for improving performance
- Moved grid/manual orders to MongoDB from Redis since Redis is not persistent anymore
- Updated MongoDB to not acknowledge insert/update/delete
- Updated Slack message for authentication. Thanks [@caebwallace](https://github.com/caebwallace) - [#287](https://github.com/chrisleekr/binance-trading-bot/pull/287)

## [0.0.77] - 2021-08-27

- Support setting minimum logging level. Thanks [ruslan-khalitov](https://github.com/ruslan-khalitov) - [#280](https://github.com/chrisleekr/binance-trading-bot/pull/280)
- Fixed cached symbol info is not removed when saving the global configuration

## [0.0.76] - 2021-08-17

- Fixed profit calculation. Thanks [@Bajt1](https://github.com/Bajt1) - [#270](https://github.com/chrisleekr/binance-trading-bot/issues/270)
- Improve Frontend performance with Gzip and compression
- Disabled saving every single order to MongoDB
- Fixed closed trade history error `can't $divide by zero`. Thanks [@BramFr](https://github.com/BramFr) - [#276](https://github.com/chrisleekr/binance-trading-bot/issues/276)
- Clear closed trade history cache when change the period

## [0.0.75] - 2021-08-13

- Support triggering buy automatically after configured minutes
- Support triggering grid trade for selling manually
- Save trades when the last buy price is removed
- Display closed trades history - [#160](https://github.com/chrisleekr/binance-trading-bot/issues/160)
- Display closed trades profit
- Support deleting trade history
- Support ARM/v7 (Raspberry Pi 4 32bit) docker image in the DockerHub

## [0.0.74] - 2021-08-01

- Secure frontend with the password authentication. Thanks [@pedrohusky](https://github.com/pedrohusky) - [#240](https://github.com/chrisleekr/binance-trading-bot/pull/240)
- Show badge for the customised symbol configuration by  [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#258](https://github.com/chrisleekr/binance-trading-bot/pull/258)
- Filter symbols in the frontend. Thanks [@pedrohusky](https://github.com/pedrohusky) - [#120](https://github.com/chrisleekr/binance-trading-bot/issues/120) [#242](https://github.com/chrisleekr/binance-trading-bot/pull/242)

## [0.0.73] - 2021-07-29

- Make the local tunnel to be disabled by default. Thanks [@pedrohusky](https://github.com/pedrohusky)
- Support Grid strategy for buy/sell to mitigate loss/increasing profit - [#158](https://github.com/chrisleekr/binance-trading-bot/issues/158)
- Add frontend option to disable sorting or improve sorting - [#244](https://github.com/chrisleekr/binance-trading-bot/issues/244)

## [0.0.72] - 2021-07-07

- Support ATH buy restriction by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#82](https://github.com/chrisleekr/binance-trading-bot/issues/82)
- Support last buy price removing threshold by [@pedrohusky](https://github.com/pedrohusky) - [#190](https://github.com/chrisleekr/binance-trading-bot/issues/190)

## [0.0.71] - 2021-06-14

- Fixed the issue with dust transfer

## [0.0.70] - 2021-06-14

- Support manual trade for all symbols -  [#100](https://github.com/chrisleekr/binance-trading-bot/issues/100)
- Configured Redis password
- Support converting small balances to BNB -  [#100](https://github.com/chrisleekr/binance-trading-bot/issues/100)

## [0.0.69] - 2021-06-05

- Fixed typo issue with CANCELED manual order handling

## [0.0.68] - 2021-06-05

- Fixed the issue with the order not found error for the manual order

## [0.0.67] - 2021-06-05

- Add Chinese translation of readme by [@izayl](https://github.com/izayl) - [#205](https://github.com/chrisleekr/binance-trading-bot/pull/205)
- Support manual trade - [#100](https://github.com/chrisleekr/binance-trading-bot/issues/100)

## [0.0.66] - 2021-05-21

- Updated frontend to display version - [#59](https://github.com/chrisleekr/binance-trading-bot/issues/59)
- Support monitoring multiple coins simultaneously - [#77](https://github.com/chrisleekr/binance-trading-bot/pull/77)
- Added `docker-stack.yml` for the Portainer - [@hipposen](https://github.com/hipposen)
- Fixed precision issues for some FIAT - [#90](https://github.com/chrisleekr/binance-trading-bot/issues/90)
- Improved frontend & settings UI - [#93](https://github.com/chrisleekr/binance-trading-bot/issues/93) [#85](https://github.com/chrisleekr/binance-trading-bot/issues/85)
- Support all symbols - [#104](https://github.com/chrisleekr/binance-trading-bot/issues/104)
- Added stop loss feature - [#99](https://github.com/chrisleekr/binance-trading-bot/issues/99)
- Stabilised Local Tunnel, cronjob and Binance WebSocket
- Prevented to place new order when the API limit reached - [#163](https://github.com/chrisleekr/binance-trading-bot/issues/163)
- Added NPM task for building docker image on Windows by [@garyng](https://github.com/garyng) - [#175](https://github.com/chrisleekr/binance-trading-bot/pull/175)

## [0.0.65] - 2021-03-27

- Added frontend option to update all symbol configurations

## [0.0.64] - 2021-03-19

- Fixed Github workflow

## [0.0.63] - 2021-03-19

- Fixed Github workflow

## [0.0.62] - 2021-03-19

- Fixed Github workflow
- Added contributors to README.md

## [0.0.61] - 2021-03-19

- Updated Github issue templates
- Updated Github actions
- Added contributors to README.md
- Updated index.html to support use of behind a protected reverse proxy -
  [@romualdr](https://github.com/romualdr)

## [0.0.60] - 2021-03-19

- Fixed the bug with limit step in the frontend
- Updated the frontend to display buy open orders with the buy signal

## [0.0.59] - 2021-03-18

- Fixed the bug with limit step in the frontend -
  [@thamlth](https://github.com/thamlth)

## [0.0.58] - 2021-03-17

- Fixed the bug with handling open orders

## [0.0.57] - 2021-03-14

- **Breaking changes** Re-organised configuration structures
- Apply chase-stop-loss-limit order for buy signal as well
- Added more candle periods - 1m, 3m and 5m
- Allow to disable local tunnel

## [0.0.56] - 2021-03-13

- Quick fix for the frontend Bootstrap issue

## [0.0.55] - 2021-03-08

- Add max-size for logging
- Execute chaseStopLossLimitOrder on every process
- Support buy trigger percentage

## [0.0.54] - 2021-03-06

- Allow entering more decimals for the last buy price
- Override buy/sell configuration per symbol
- Support PWA for frontend - now support "Add to Home screen"
- Enable/Disable symbols trading, but continue to monitor

## [0.0.53] - 2021-02-26

- Changed to more persistence database - MongoDB - for configuration and last
  buy price
- Display estimated value in the frontend
- Support other FIAT symbols such as BUSD, AUD

## [0.0.52] - 2021-02-13

- Fixed the bug last buy price not removed
- Updated frontend to be exposed to the public using the local tunnel
- Display account balances in the frontend
- Updated frontend to change symbols in the configuration
- Updated frontend to change last buy price per symbol

## [0.0.52] - 2021-02-08

- Fixed the issue with persistent redis

## [0.0.51] - 2021-02-08

- Fixed the issue with rounding when places an order

## [0.0.50] - 2021-02-07

- Fixed the issue with sorting in the frontend

## [0.0.49] - 2021-02-07

- Fixed the issue with the configuration
- Updated frontend to remove cache

## [0.0.48] - 2021-02-07

- Removed unused methods - Bollinger Bands, MACD Stop Chaser
- Support maximum purchase amount per symbol
- Developed backend to send cache values for frontend
- Developed simple frontend to see statistics
- Support multiple symbols
