# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Added `docker-stack.yml` for the Portainer -
  [@hipposen](https://github.com/hipposen)

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
