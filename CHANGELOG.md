# Changelog

All notable changes to this project will be documented in this file.

## [0.0.98] - 2023-04-13

- Added the prefix to environment parameter for `TRADINGVIEW` related - [#616](https://github.com/chrisleekr/binance-trading-bot/pull/616)
- Fixed the issue with minNotional - [#623](https://github.com/chrisleekr/binance-trading-bot/pull/623)
- Add clear symbols button by [@TheSmuks](https://github.com/TheSmuks) - [#626](https://github.com/chrisleekr/binance-trading-bot/pull/626)
- Improved customised setting details by [@rando128](https://github.com/rando128) - [#625](https://github.com/chrisleekr/binance-trading-bot/pull/625)
- Updated collapsable header UX by [@rando128](https://github.com/rando128) - [#624](https://github.com/chrisleekr/binance-trading-bot/pull/624)

Thanks [@TheSmuks](https://github.com/TheSmuks) and [@rando128](https://github.com/rando128) for your great contributions. 💯 :heart:

## [0.0.97] - 2023-03-21

- Fixed sorting symbols open trades first by [@uhliksk](https://github.com/uhliksk) - [#564](https://github.com/chrisleekr/binance-trading-bot/pull/564)
- Fixed the issue that cannot export huge logs - [#561](https://github.com/chrisleekr/binance-trading-bot/pull/561), [#567](https://github.com/chrisleekr/binance-trading-bot/pull/567)
- Fixed the balance calculation to include dust balances by [@uhliksk](https://github.com/uhliksk) - [#571](https://github.com/chrisleekr/binance-trading-bot/pull/571)
- Fixed the open orders to be cancelled when the current price is higher/lower than the order price by [@uhliksk](https://github.com/uhliksk) - [#569](https://github.com/chrisleekr/binance-trading-bot/pull/569)
- Improved queue processing by replacing Bull queue to customised queue system by [@uhliksk](https://github.com/uhliksk) - [#562](https://github.com/chrisleekr/binance-trading-bot/pull/562), [#581](https://github.com/chrisleekr/binance-trading-bot/pull/581), [#588](https://github.com/chrisleekr/binance-trading-bot/pull/588)
- Added conservative sell strategy, which can reduce the sell trigger price as the grid gets deeper by [@rando128](https://github.com/rando128) - [#585](https://github.com/chrisleekr/binance-trading-bot/pull/585)
- Fixed the stop-loss to be a higher priority than the new buy order by [@uhliksk](https://github.com/uhliksk) - [#589](https://github.com/chrisleekr/binance-trading-bot/pull/589)
- Improved search and filtering UX by [@rando128](https://github.com/rando128) - [#591](https://github.com/chrisleekr/binance-trading-bot/pull/591)
- Enhanced the break-even calculator by [@rando128](https://github.com/rando128) - [#597](https://github.com/chrisleekr/binance-trading-bot/pull/597), [#601](https://github.com/chrisleekr/binance-trading-bot/pull/601)
- Updated TradingView host/port configurable  by [@rando128](https://github.com/rando128) - [#608](https://github.com/chrisleekr/binance-trading-bot/pull/608)

Thanks [@uhliksk](https://github.com/uhliksk) and [@rando128](https://github.com/rando128) for your great contributions. 💯 :heart:

## [0.0.96] - 2022-12-28

- Enhanced the suggested break-even amount a grid calculator by [@rando128](https://github.com/rando128) - [#555](https://github.com/chrisleekr/binance-trading-bot/pull/555), [#557](https://github.com/chrisleekr/binance-trading-bot/pull/557)
- Fixed API error page priority by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#556](https://github.com/chrisleekr/binance-trading-bot/pull/556)

Thanks [@rando128](https://github.com/rando128) and [@habibalkhabbaz](https://github.com/habibalkhabbaz) for your great contributions. 💯 :heart:

## [0.0.95] - 2022-12-19

- Added API error message when using the wrong API key/secret - [#544](https://github.com/chrisleekr/binance-trading-bot/pull/544)
- Automatic login when password is autofilled by the browser by [@rando128](https://github.com/rando128) - [#550](https://github.com/chrisleekr/binance-trading-bot/pull/550)
- Fixed the queue concurrency issue - [#551](https://github.com/chrisleekr/binance-trading-bot/pull/551)
- Added the feature to hide temporary disabled trading coins from dashboard by [@rando128](https://github.com/rando128) - [#552](https://github.com/chrisleekr/binance-trading-bot/pull/552)
- Enhanced the suggested break-even amount with a grid calculator by [@rando128](https://github.com/rando128) - [#554](https://github.com/chrisleekr/binance-trading-bot/pull/554)

Thanks [@rando128](https://github.com/rando128) for your great contributions. 💯 :heart:

## [0.0.94] - 2022-11-24

- Added advanced chart link to Tradingview section by [@rando128](https://github.com/rando128) - [#525](https://github.com/chrisleekr/binance-trading-bot/pull/525)
- Fixed Frontend pagination by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#526](https://github.com/chrisleekr/binance-trading-bot/pull/526)
- Added buy/sell order details in the grid trade sections by [@rando128](https://github.com/rando128) - [#527](https://github.com/chrisleekr/binance-trading-bot/pull/527)
- Added to show suggested break-even amount by [@rando128](https://github.com/rando128) - [#540](https://github.com/chrisleekr/binance-trading-bot/pull/540)

Thanks [@habibalkhabbaz](https://github.com/habibalkhabbaz) and [@rando128](https://github.com/rando128) for your great contributions. 💯 :heart:

## [0.0.93] - 2022-10-07

- Updated redlock locking period by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#522](https://github.com/chrisleekr/binance-trading-bot/pull/522)
- Updated Slack notification for last buy updated and buy confirmation by [@rando128](https://github.com/rando128) - [#518](https://github.com/chrisleekr/binance-trading-bot/pull/518)

## [0.0.92] - 2022-10-07

- Fixed Axios version issue by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#521](https://github.com/chrisleekr/binance-trading-bot/pull/521)

## [0.0.91] - 2022-08-28

- Fixed sorting symbols by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#496](https://github.com/chrisleekr/binance-trading-bot/pull/496)
- Added backup/restore functions - [#501](https://github.com/chrisleekr/binance-trading-bot/pull/501)
- Added demo mode - [#509](https://github.com/chrisleekr/binance-trading-bot/pull/509)
- Fixed account balance calculation by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#514]([https://github.com/chrisleekr/binance-trading-bot/pull/496](https://github.com/chrisleekr/binance-trading-bot/pull/514))

Thanks [@habibalkhabbaz](https://github.com/habibalkhabbaz) for your great contributions. 💯 :heart:

## [0.0.90] - 2022-08-27

- Fixed handling execution report - [#495](https://github.com/chrisleekr/binance-trading-bot/pull/495)
- Fixed archiving grid order if all sell orders are executed - [#490](https://github.com/chrisleekr/binance-trading-bot/pull/490)
- Update symbol delete action to remove override data - [#489](https://github.com/chrisleekr/binance-trading-bot/pull/489)
- Improved performance with bulk write candles to DB by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#481](https://github.com/chrisleekr/binance-trading-bot/pull/481)
- Fixed non-active exchange symbols by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#478](https://github.com/chrisleekr/binance-trading-bot/pull/478)
- Fixed incorrect symbol in reset-symbol-websockets by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#477](https://github.com/chrisleekr/binance-trading-bot/pull/477)
- Improved UI by [@uhliksk](https://github.com/uhliksk) - [#479](https://github.com/chrisleekr/binance-trading-bot/pull/479)

Thanks [@habibalkhabbaz](https://github.com/habibalkhabbaz) and [@uhliksk](https://github.com/uhliksk) for your great contributions. 💯 :heart:

## [0.0.89] - 2022-08-16

- Fixed incorrect behaviour of exceeding max open orders by [@uhliksk](https://github.com/uhliksk) - [#462](https://github.com/chrisleekr/binance-trading-bot/pull/462)
- Bumped vulnerable package versions - [#472](https://github.com/chrisleekr/binance-trading-bot/pull/472)
- Refactored the slack hander to avoid message flooding to Slack - [#471](https://github.com/chrisleekr/binance-trading-bot/pull/471)
- Implemented queue to stabilise the trade by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#464](https://github.com/chrisleekr/binance-trading-bot/pull/464)
- Fixed to handle order status update correctly - [#461](https://github.com/chrisleekr/binance-trading-bot/pull/461)
- Fixed timezone inconsistency by [@uhliksk](https://github.com/uhliksk) - [#454](https://github.com/chrisleekr/binance-trading-bot/pull/454)
- Improved UI by [@uhliksk](https://github.com/uhliksk) - [#452](https://github.com/chrisleekr/binance-trading-bot/pull/452)
- Improved error handler and stability by [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#448](https://github.com/chrisleekr/binance-trading-bot/pull/448)

Thanks [@habibalkhabbaz](https://github.com/habibalkhabbaz) and [@uhliksk](https://github.com/uhliksk) for your great contributions.

## [0.0.88] - 2022-07-24

- Added TRADINGVIEW_LOG_LEVEL. Thanks [@azorpax](https://github.com/azorpax) - [#436](https://github.com/chrisleekr/binance-trading-bot/pull/436)

## [0.0.87] - 2022-07-23

- Refactored error handling. Thanks [@habibalkhabbaz](https://github.com/habibalkhabbaz) - [#434](https://github.com/chrisleekr/binance-trading-bot/pull/434)

## [0.0.86] - 2022-07-22

- Upgraded TradingView TA to 3.2.10 - [#426](https://github.com/chrisleekr/binance-trading-bot/pull/426)
- Added override trading view with auto trigger buy - [#429](https://github.com/chrisleekr/binance-trading-bot/pull/429)
- Enhanced to use WebSocket for monitoring candles/orders/account information. It's faster! - [#431](https://github.com/chrisleekr/binance-trading-bot/pull/431)
- Updated the frontend with pagination [#431](https://github.com/chrisleekr/binance-trading-bot/pull/431)
- Updated account balance layout in the frontend [#431](https://github.com/chrisleekr/binance-trading-bot/pull/431)

Thanks [@habibalkhabbaz](https://github.com/habibalkhabbaz) for all these updates!

## [0.0.85] - 2021-11-02

- Refactored TradingView python server - [#383](https://github.com/chrisleekr/binance-trading-bot/pull/383)

## [0.0.84] - 2021-10-30

- Enhanced TradingView using get_multiple_analysis - [#375](https://github.com/chrisleekr/binance-trading-bot/pull/375)
- Fixed the last buy removal threshold. Thanks [@Rayn0r](https://github.com/Rayn0r) - [#379](https://github.com/chrisleekr/binance-trading-bot/pull/379)

## [0.0.83] - 2021-10-23

- Fixed Redis/TradingView docker images for Raspberry Pi - [#366](https://github.com/chrisleekr/binance-trading-bot/pull/366)

## [0.0.82] - 2021-10-23

- Fixed Github actions

## [0.0.81] - 2021-10-23

- Fixed Github actions

## [0.0.80] - 2021-10-22

- Enhanced auto-trigger buy feature - [#316](https://github.com/chrisleekr/binance-trading-bot/issues/316)
- Added TradingView Technical Analysis - [#327](https://github.com/chrisleekr/binance-trading-bot/issues/327)
- Updated buy/auto-buy trigger/sell action to integrate with TradingView Technical Analysis - [#327](https://github.com/chrisleekr/binance-trading-bot/issues/327)
- Fixed dust transfer base amount. Thanks  [@ilbuonmarcio](https://github.com/ilbuonmarcio) - [#346](https://github.com/chrisleekr/binance-trading-bot/pull/346)
- Added `/status` endpoint. Thanks  [@ilbuonmarcio](https://github.com/ilbuonmarcio) - [#347](https://github.com/chrisleekr/binance-trading-bot/pull/347)
- Added logging features for actions - [#362](https://github.com/chrisleekr/binance-trading-bot/pull/362)

## [0.0.79] - 2021-09-19

- Clear exchange/symbol info cache in the Redis periodically - [#284](https://github.com/chrisleekr/binance-trading-bot/issues/284)
- Added minimum required order amount - [#84](https://github.com/chrisleekr/binance-trading-bot/issues/84)
- Added estimates for quote assets. Thanks [@ilbuonmarcio](https://github.com/ilbuonmarcio) - [#305](https://github.com/chrisleekr/binance-trading-bot/pull/305)
- Support limit for buy open orders/open trades - [#147](https://github.com/chrisleekr/binance-trading-bot/issues/147)
- Fixed CRLF issue on Windows. Thanks  [@ilbuonmarcio](https://github.com/ilbuonmarcio) - [#326](https://github.com/chrisleekr/binance-trading-bot/pull/326)

## [0.0.78] - 2021-09-05

- Added indexes for MongoDB
- Updated configuration to use cache as well to improve performance
- Updated redis.conf to disable AOF for improving performance
- Moved grid/manual orders to MongoDB from Redis since Redis is not persistent anymore
- Updated MongoDB to not acknowledge insert/update/delete
- Updated Slack message for authentication. Thanks [@caebwallace](https://github.com/caebwallace) - [#287](https://github.com/chrisleekr/binance-trading-bot/pull/287)
- Support Redis DB. Thanks [@azorpax](https://github.com/azorpax) - [#292](https://github.com/chrisleekr/binance-trading-bot/pull/292)
- Support Rate Limiter to prevent brute force. Thanks [@caebwallace](https://github.com/caebwallace) - [#287](https://github.com/chrisleekr/binance-trading-bot/pull/287)

## [0.0.77] - 2021-08-27

- Support setting minimum logging level. Thanks [@ruslan-khalitov](https://github.com/ruslan-khalitov) - [#280](https://github.com/chrisleekr/binance-trading-bot/pull/280)
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
