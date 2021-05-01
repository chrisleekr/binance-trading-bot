# 바이낸스 자동 매매 트레이딩 봇

[![GitHub version](https://img.shields.io/github/package-json/v/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/releases)
[![Build](https://github.com/chrisleekr/binance-trading-bot/workflows/main/badge.svg)](https://github.com/chrisleekr/binance-trading-bot/actions?query=workflow%3Amain)
[![CodeCov](https://codecov.io/gh/chrisleekr/binance-trading-bot/branch/master/graph/badge.svg)](https://codecov.io/gh/chrisleekr/binance-trading-bot)
[![Docker pull](https://img.shields.io/docker/pulls/chrisleekr/binance-trading-bot)](https://hub.docker.com/r/chrisleekr/binance-trading-bot)
[![GitHub contributors](https://img.shields.io/github/contributors/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/graphs/contributors)
[![MIT License](https://img.shields.io/github/license/chrisleekr/binance-trading-bot)](https://github.com/chrisleekr/binance-trading-bot/blob/master/LICENSE)

> 추적 매수/매도 기법(Trailing buy/sell strategy)을 이용한 자동화된 바이낸스 자
> 동매매 프로그램

---

[![en](https://img.shields.io/badge/lang-English-blue.svg)](https://github.com/chrisleekr/binance-trading-bot/blob/master/README.md)

이 프로젝트는 제 코드를 테스트 하기 위한 단순한 테스트 프로젝트 입니다.

**최신 업데이트 정보는
[README.md](https://github.com/chrisleekr/binance-trading-bot#binance-trading-bot)에
서 확인 가능합니다. 이 페이지는 한국어로 프로그램에 대한 설명만 적혀있습니다.**

## 경고

**이 프로그램을 이용하여 돈을 벌 수 있을지 없을지는 절대 보장하지 않습니다.**

**리스크를 감당하실 수 있을 경우에만 사용하세요! 이 코드를 이용하여 직/간접적으
로생긴 손실이나 경제적인 어려움이 생길 경우 절대 책임지지 않습니다.**

**프로그램을 업데이트하기 전에, 구매 가격을 꼭 적어두시기 바랍니다. 환경설정이나
구매 가격 정보가 손실될 수 있습니다.**

## 작동 방법

### 추적 매수 프로그램

이 프로그램은 가격의 하락/상승 추세를 따라가며 추적 매수/추적 매도를 하는 기법을
기반으로 작성되었습니다.

- 이 프로그램은 여러개의 코인을 모니터링 가능합니다. 각 코인들은 1초마다 가격 확
  인 및 매수/매도 처리가 됩니다.
- 이 프로그램은 BTCUSDT, ETHUSDT와 같은 화폐(FIAT) 마켓의 USDT 코인들만 테스트하
  였습니다. BUSD나 AUD와 같은 다른 화폐를 프론트엔드에서 추가 가능합니다. 하지만
  다른 화폐는 실서버에서 테스트 되지 않았으니, 리스크를 감수하실 수 있을 경우에
  만 사용하세요.
- 이 프로그램은 지속적인 데이터베이스로 MongoDB를 사용합니다. 하지만 라즈베리파
  이 32bit 지원을 위해 최신 버젼을 사용하지 않습니다. 사용된 MongoDB 버젼은
  [apcheamitru](https://hub.docker.com/r/apcheamitru/arm32v7-mongo)에서 제공된
  3.2.20입니다

#### 매수 신호

이 프로그램은 설정된 기간동안의 가장 낮은 가격을 모니터링합니다. 현재 값이 가장
낮은 가격에 도달했을 경우에, 프로그램은 매수를 위한 STOP-LOSS-LIMIT 주문을 넣습
니다. 현재 가격이 계속 떨어질 경우, 프로그램은 이전 주문을 취소하고, 새로운 가격
으로 STOP-LOSS-LIMIT 주문을 넣습니다.

- 이 프로그램은 매도를 위한 코인이 충분할 경우 (보통 $10정도) 매수 주문을 넣지않
  습니다.

##### 매수 시나리오

예를 들어, 매수 환경설정이 다음과 같이 되었다고 가정해봅시다:

- 최대 매수 수량(Maximum purchase amount): $50
- 매수 시작 퍼센트(Trigger percentage): 1.005 (0.5%)
- 스탑 가격 퍼센트(Stop price percentage): 1.01 (1.0%)
- 리밋 가격 퍼센트(Limit price percentage): 1.011 (1.1%)

그리고 현재 마켓이 아래와 같다고 가정합니다:

- 현재 가격(Current price): $101
- 최저 가격(Lowest price): $100
- 매수 시작 가격(Trigger price): $100.5

이럴 경우 현재 가격($101)이 매수 시작 가격($100.5)보다 높기 때문에, 프로그램은주
문을 넣지 않습니다.

시간이 지나, 마켓이 다음과 같이 변했다고 가정합니다:

- 현재 가격(Current price): $100
- 최저 가격(Lowest price): $100
- 매수 시작 가격(Trigger price): $100.5

현재 가격 ($100)이 매수 시작 가격($100.5)보다 낮기 때문에, 프로그램은매수
STOP-LOSS-LIMIT 주문을 넣습니다. 간단한 계산을 위해 커미션은 계산하지 않았습니다
. 실 거래시, 주문 수량은 다를 수 있습니다. 매수 주문은 다음과 같이 넣어집니다:

- 스탑 가격(Stop price): $100 \* 1.01 = $101
- 리밋 가격(Limit price): $100 \* 1.011 = $101.1
- 수량(Quantity): 0.49

시간이 지나 마켓이 다음과 같이 변했다고 가정합니다:

- 현재 가격(Current price): $99
- 현재 리밋 가격(Current limit price): $99 \* 1.011 = 100.089
- 주문 스탑 가격(Open order stop price): $101

주문 스탑 가격($101)이 현재 리밋 가격($100.089)보다 높기 때문에, 프로그램은 현재
주문을 취소하고 새로운 매수 STOP-LOSS-LIMIT 주문을 넣습니다:

- 스탑 가격(Stop price): $99 \* 1.01 = $99.99
- 리밋 가격(Limit price): $99 \* 1.011 = $100.089
- 수량(Quantity): 0.49

만약 현재 가격이 계속 떨어진다면, 새로운 매수 주문이 새로운 가격에 맞춰 다시 넣
어집니다.

만약 마켓이 다음과 같이 변했다고 가정합니다:

- 현재 가격(Current price): $100

그러면 현재 가격이 스탑 가격($99.99)에 도달하였기 때문에, 매수 주문은 리밋 가격
($100.089)에 체결이 됩니다.

### 매도 신호

만약 매도를 위한 충분한 코인이 있고 매수 가격(Last buy price)가 저장되었을 경우,
프로그램은 매도 신호를 모니터링하기 시작합니다. 현재 가격이 매도 시작 가격에 도
달한다면, 프로그램은 매도 STOP-LOSS-LIMIT 주문을 넣습니다. 만약 현재 가격이 계속
상승한다면, 프로그램은 이전 주문을 취소하고, 새 가격으로 매도 STOP-LOSS-LIMIT 주
문을 넣습니다.

- 만약 코인이 최소 주문 금액 ($10)보다 평가금이 낮다면, Binance에서 $10미만의 주
  문은 접수되지 않기 때문에 프로그램은 매수 가격(Last buy price) 기록을 없앴니다
  .
- 만약 매수 가격(Last buy price)가 저장되지 않았다면, 프로그램은 코인을 매도하지
  않습니다.

#### 매도 시나리오

예를 들어, 매도 환경설정이 다음과 같이 되었다고 가정해봅시다:

- 매도 시작 퍼센트(Trigger percentage): 1.05 (5.0%)
- 스탑 가격 퍼센트(Stop price percentage): 0.98 (-2.0%)
- 리밋 가격 퍼센트(Limit price percentage): 0.979 (-2.1%)

그리고 현재 마켓이 아래와 같다고 가정합니다:

- 소유 코인 수량(Coin owned): 0.5
- 현재 가격(Current price): $100
- 매수 가격(Last buy price): $100
- 매도 시작 가격(Trigger price): $100 \* 1.05 = $105

이럴 경우 매도 시작 가격($105)이 현재 가격 ($100)보다 높기 때문에 프로그램은 주
문을 넣지 않습니다.

만약 현재 가격이 계속 하락한다면, 프로그램은 현재 가격이 매도 시작 가격에 도달할
때까지 계속 모니터링합니다.

시간이 지나, 마켓이 다음과 같이 변했다고 가정합니다:

- 현재 가격(Current price): $105
- 매도 시작 가격(Trigger price): $105

현재 가격 ($105)가 매도 시작 가격($105)와 같거나 높기때문에 프로그램은 새로운 매
도 STOP-LOSS-LIMIT 주문을 넣습니다. 간단한 계산을 위해 커미션은 계산하지 않았습
니다. 실 거래시, 주문 수량은 다를 수 있습니다. 매도 주문은 다음과 같이 넣어집니
다:

- 스탑 가격(Stop price): $105 \* 0.98 = $102.9
- 리밋 가격(Limit price): $105 \* 0.979 = $102.795
- 수량(Quantity): 0.5

시간이 지나 마켓이 다음과 같이 변했다고 가정합니다.:

- 현재 가격(Current price): $106
- 현재 리밋 가격(Current limit price): $103.774
- 주문 스탑 가격(Open order stop price): $102.29

주문 스탑 가격($102.29)가 현재 리밋 가격($103.774)보다 낮기 때문에, 프로그램은현
재 주문을 취소하고 새로운 매도 STOP-LOSS-LIMIT 주문을 넣습니다:

- 스탑 가격(Stop price): $106 \* 0.98 = $103.88
- 리밋 가격(Limit price): $106 \* 0.979 = $103.774
- 수량(Quantity): 0.5

만약 현재 가격이 계속 상승한다면, 새로운 매도 주문이 새로운 가격에 맞춰 다시 넣
어집니다.

만약 마켓이 다음과 같이 변했다고 가정합니다:

- 현재 가격(Current price): $103

그러면 현재 가격이 스탑 가격($103.88)에 도달하였기 때문에, 매도 주문은 리밋 가격
($103.774)에 체결이 됩니다.

### 프론트엔드 + 웹 소켓

프론트엔드는 React.js 기반으로 개발 되었으며 웹소켓을 통해 통신합니다:

- 지정한 코인들의 매수/매도 신호와 현재 주문을 모니터링 할 수 있습니다.
- 계좌 현황을 볼 수 있습니다.
- 전체 환경 설정/코인 환경설정을 할 수 있습니다.
- 모니터링 되지 않은 코인의 캐시 정보를 지울 수 있습니다.
- 외부 링크를 볼수 있습니다.
- 홈 화면에 추가하기 기능을 지원합니다.

## 환경 변수 (Environment parameters)

환경 변수를 이용해 환경 설정을 변경 가능합니다.
`/config/custom-environment-variables.json` 코드를 확인하시면 설정 가능한 환경변
수 목록을 볼 수 있습니다.

아니면 프로그램 실행 후, 프론트엔드에서 설정을 변경 가능합니다.

## 사용 방법

1. 먼저 `.env.dist` 파일을 `.env` 파일로 복사합니다

   | 환경 변수명                    | 설명                                                                                 | 예시                                                                                           |
   | ------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
   | BINANCE_LIVE_API_KEY           | 실서버 Binance API key                                                               | (from [Binance](https://binance.zendesk.com/hc/en-us/articles/360002502072-How-to-create-API)) |
   | BINANCE_LIVE_SECRET_KEY        | 실서버 Binance API secret                                                            | (from [Binance](https://binance.zendesk.com/hc/en-us/articles/360002502072-How-to-create-API)) |
   | BINANCE_TEST_API_KEY           | 테스트서버 Binance API key                                                           | (from [Binance Spot Test Network](https://testnet.binance.vision/))                            |
   | BINANCE_TEST_SECRET_KEY        | 테스트서버 Binance API secret                                                        | (from [Binance Spot Test Network](https://testnet.binance.vision/))                            |
   | BINANCE_SLACK_ENABLED          | 슬랙(Slack) 활성화/비활성화                                                          | true                                                                                           |
   | BINANCE_SLACK_WEBHOOK_URL      | 슬랙(Slack) 웹훅(webhook) URL                                                        | (from Slack)                                                                                   |
   | BINANCE_SLACK_CHANNEL          | 슬랙(Slack) 채널(channel)명                                                          | "#binance"                                                                                     |
   | BINANCE_SLACK_USERNAME         | 슬랙(Slack) username                                                                 | Chris                                                                                          |
   | BINANCE_LOCAL_TUNNEL_ENABLED   | 로컬터널([local tunnel](https://github.com/localtunnel/localtunnel)) 활성화/비활성화 | true                                                                                           |
   | BINANCE_LOCAL_TUNNEL_SUBDOMAIN | 외부 링크를 위한 로컬터널(local tunnel) 서브도메인                                   | binance                                                                                        |

2. `docker-compose.yml`에 있는 `BINANCE_MODE` 환경 변수를 확인하시기 바랍니다.

3. docker-compose를 이용하여 프로그램을 실행하시기 바랍니다.

   먼저 최신 코드를 Pull합니다:

   ```bash
   git pull
   ```

   실서버 모드를 사용하실려면, DockerHub에서 최근에 빌드된 이미지를 사용하실 수
   있습니다:

   ```bash
   docker-compose -f docker-compose.server.yml pull
   docker-compose -f docker-compose.server.yml up -d
   ```

   라즈베리 파이 4 32bit를 사용하실 경우, 이미지를 다시 빌드하시기 바랍니다:

   ```bash
   npm run docker:build
   docker-compose -f docker-compose.rpi.yml up -d
   ```

   개발 모드를 사용하실려면, 아래 명령어를 실행하시면 됩니다:

   ```bash
   docker-compose up -d
   ```

4. 브라우저를 열어 `http://0.0.0.0:8080`에 접근하시면 프론트엔드에 접근하실 수있
   습니다.

   - 프로그램 실행시, 외부 URL은 슬랙(Slack)에 공지 됩니다.
   - 봇을 사용시 문제가 발생할 경우, 먼저 로그를 확인하시기 바랍니다. 참조:
     [Troubleshooting](https://github.com/chrisleekr/binance-trading-bot/wiki/Troubleshooting)

## 스크린샷

**스크린샷 정보는
[README.md](https://github.com/chrisleekr/binance-trading-bot#screenshots)에서참
고하시기 바랍니다.**
