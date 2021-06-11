/* eslint-disable global-require */
describe('place-manual-trade.js', () => {
  let result;
  let error;
  let rawData;

  let binanceMock;
  let slackMock;
  let loggerMock;
  let cacheMock;

  let mockGetAndCacheOpenOrdersForSymbol;
  let mockGetAccountInfoFromAPI;
  let mockGetAPILimit;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    // Mock moment to return static date
    jest.mock(
      'moment',
      () => () => jest.requireActual('moment')('2020-01-01T00:00:00.000Z')
    );

    const { binance, slack, cache, logger } = require('../../../../helpers');

    binanceMock = binance;
    slackMock = slack;
    loggerMock = logger;
    cacheMock = cache;

    cacheMock.hset = jest.fn().mockResolvedValue(true);
    slackMock.sendMessage = jest.fn().mockResolvedValue(true);
    binanceMock.client.order = jest.fn().mockResolvedValue(true);

    mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockReturnValue([]);
    mockGetAccountInfoFromAPI = jest
      .fn()
      .mockResolvedValue({ account: 'info' });
    mockGetAPILimit = jest.fn().mockResolvedValue(10);
  });

  describe('when symbol is locked', () => {
    beforeEach(async () => {
      jest.mock('../../../trailingTradeHelper/common', () => ({
        getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
        getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
        getAPILimit: mockGetAPILimit
      }));

      const step = require('../place-manual-trade');

      rawData = {
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: true,
        symbolConfiguration: {
          system: {
            checkManualBuyOrderPeriod: 10
          }
        },
        order: {}
      };

      result = await step.execute(loggerMock, rawData);
    });

    it('does not trigger cache.hset', () => {
      expect(cacheMock.hset).not.toHaveBeenCalled();
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: true,
        symbolConfiguration: {
          system: {
            checkManualBuyOrderPeriod: 10
          }
        },
        order: {}
      });
    });
  });

  describe('when action is not manual-trade', () => {
    beforeEach(async () => {
      jest.mock('../../../trailingTradeHelper/common', () => ({
        getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
        getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
        getAPILimit: mockGetAPILimit
      }));

      const step = require('../place-manual-trade');

      rawData = {
        symbol: 'BTCUSDT',
        action: 'buy-order-wait',
        isLocked: false,
        symbolConfiguration: {
          system: {
            checkManualBuyOrderPeriod: 10
          }
        },
        order: {}
      };

      result = await step.execute(loggerMock, rawData);
    });

    it('does not trigger cache.hset', () => {
      expect(cacheMock.hset).not.toHaveBeenCalled();
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT',
        action: 'buy-order-wait',
        isLocked: false,
        symbolConfiguration: {
          system: {
            checkManualBuyOrderPeriod: 10
          }
        },
        order: {}
      });
    });
  });

  [
    {
      desc: 'BTCUSDT Buy Limit',
      order: {
        side: 'buy',
        buy: {
          type: 'limit',
          price: 39330.29,
          quantity: 0.1,
          total: 3933.029,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 0,
          isValid: true
        },
        sell: {
          type: 'limit',
          price: 39330.29,
          quantity: 0,
          total: 0,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 0,
          isValid: false
        }
      },
      expectedOrderParams: {
        symbol: 'BTCUSDT',
        side: 'buy',
        type: 'LIMIT',
        quantity: 0.1,
        price: 39330.29
      },
      orderResult: {
        symbol: 'BTCUSDT',
        orderId: 250376,
        orderListId: -1,
        clientOrderId: 'X7yz5s4UoDtkEW3j3oDDhe',
        transactTime: 1622716391215,
        price: '39330.29000000',
        origQty: '0.10000000',
        executedQty: '0.00000000',
        cummulativeQuoteQty: '0.00000000',
        status: 'NEW',
        timeInForce: 'GTC',
        type: 'LIMIT',
        side: 'BUY',
        fills: []
      },
      openOrders: [
        {
          symbol: 'BTCUSDT',
          orderId: 250376,
          orderListId: -1,
          clientOrderId: 'X7yz5s4UoDtkEW3j3oDDhe',
          price: '39330.29000000',
          origQty: '0.10000000',
          executedQty: '0.00000000',
          cummulativeQuoteQty: '0.00000000',
          status: 'NEW',
          timeInForce: 'GTC',
          type: 'LIMIT',
          side: 'BUY',
          stopPrice: '0.00000000',
          icebergQty: '0.00000000',
          time: 1622716391215,
          updateTime: 1622716391215,
          isWorking: true,
          origQuoteOrderQty: '0.00000000'
        }
      ],
      expectedData: {
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: false,
        symbolConfiguration: { system: { checkManualBuyOrderPeriod: 10 } },
        buy: {
          openOrders: [
            {
              symbol: 'BTCUSDT',
              orderId: 250376,
              orderListId: -1,
              clientOrderId: 'X7yz5s4UoDtkEW3j3oDDhe',
              price: '39330.29000000',
              origQty: '0.10000000',
              executedQty: '0.00000000',
              cummulativeQuoteQty: '0.00000000',
              status: 'NEW',
              timeInForce: 'GTC',
              type: 'LIMIT',
              side: 'BUY',
              stopPrice: '0.00000000',
              icebergQty: '0.00000000',
              time: 1622716391215,
              updateTime: 1622716391215,
              isWorking: true,
              origQuoteOrderQty: '0.00000000'
            }
          ],
          processMessage: 'Placed new manual order.',
          updatedAt: expect.any(Object)
        },
        sell: { openOrders: [] },
        order: {
          side: 'buy',
          buy: {
            type: 'limit',
            price: 39330.29,
            quantity: 0.1,
            total: 3933.029,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: true
          },
          sell: {
            type: 'limit',
            price: 39330.29,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: false
          }
        },
        openOrders: [
          {
            symbol: 'BTCUSDT',
            orderId: 250376,
            orderListId: -1,
            clientOrderId: 'X7yz5s4UoDtkEW3j3oDDhe',
            price: '39330.29000000',
            origQty: '0.10000000',
            executedQty: '0.00000000',
            cummulativeQuoteQty: '0.00000000',
            status: 'NEW',
            timeInForce: 'GTC',
            type: 'LIMIT',
            side: 'BUY',
            stopPrice: '0.00000000',
            icebergQty: '0.00000000',
            time: 1622716391215,
            updateTime: 1622716391215,
            isWorking: true,
            origQuoteOrderQty: '0.00000000'
          }
        ],
        accountInfo: { account: 'info' }
      }
    },
    {
      desc: 'BTCUSDT Buy Market Total',
      order: {
        side: 'buy',
        buy: {
          type: 'market',
          price: 39372.07,
          quantity: 0,
          total: 0,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 100,
          isValid: true
        },
        sell: {
          type: 'limit',
          price: 39372.07,
          quantity: 0,
          total: 0,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 0,
          isValid: false
        }
      },
      expectedOrderParams: {
        symbol: 'BTCUSDT',
        side: 'buy',
        type: 'MARKET',
        quoteOrderQty: 100
      },
      orderResult: {
        symbol: 'BTCUSDT',
        orderId: 251934,
        orderListId: -1,
        clientOrderId: 'Ejpj93cueEiwAuCoQ5vPmL',
        transactTime: 1622717131271,
        price: '0.00000000',
        origQty: '0.00254000',
        executedQty: '0.00254000',
        cummulativeQuoteQty: '99.99146880',
        status: 'FILLED',
        timeInForce: 'GTC',
        type: 'MARKET',
        side: 'BUY',
        fills: [
          {
            price: '39366.72000000',
            qty: '0.00254000',
            commission: '0.00000000',
            commissionAsset: 'BTC',
            tradeId: 68553
          }
        ]
      },
      openOrders: [],
      expectedData: {
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: false,
        symbolConfiguration: { system: { checkManualBuyOrderPeriod: 10 } },
        buy: {
          openOrders: [],
          processMessage: 'Placed new manual order.',
          updatedAt: expect.any(Object)
        },
        sell: { openOrders: [] },
        order: {
          side: 'buy',
          buy: {
            type: 'market',
            price: 39372.07,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 100,
            isValid: true
          },
          sell: {
            type: 'limit',
            price: 39372.07,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: false
          }
        },
        openOrders: [],
        accountInfo: { account: 'info' }
      }
    },
    {
      desc: 'BTCUSDT Buy Market Amount',
      order: {
        side: 'buy',
        buy: {
          type: 'market',
          price: 39365,
          quantity: 0,
          total: 0,
          marketType: 'amount',
          marketQuantity: 0.1,
          quoteOrderQty: 0,
          isValid: true
        },
        sell: {
          type: 'limit',
          price: 39365,
          quantity: 0,
          total: 0,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 0,
          isValid: false
        }
      },
      expectedOrderParams: {
        symbol: 'BTCUSDT',
        side: 'buy',
        type: 'MARKET',
        quantity: 0.1
      },
      orderResult: {
        symbol: 'BTCUSDT',
        orderId: 252348,
        orderListId: -1,
        clientOrderId: 'J537Cni9axtnhpPIZqhOWC',
        transactTime: 1622717329242,
        price: '0.00000000',
        origQty: '0.10000000',
        executedQty: '0.10000000',
        cummulativeQuoteQty: '3947.22326758',
        status: 'FILLED',
        timeInForce: 'GTC',
        type: 'MARKET',
        side: 'BUY',
        fills: [
          {
            price: '39432.26000000',
            qty: '0.01354900',
            commission: '0.00000000',
            commissionAsset: 'BTC',
            tradeId: 68645
          }
        ]
      },
      openOrders: [],
      expectedData: {
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: false,
        symbolConfiguration: { system: { checkManualBuyOrderPeriod: 10 } },
        buy: {
          openOrders: [],
          processMessage: 'Placed new manual order.',
          updatedAt: expect.any(Object)
        },
        sell: { openOrders: [] },
        order: {
          side: 'buy',
          buy: {
            type: 'market',
            price: 39365,
            quantity: 0,
            total: 0,
            marketType: 'amount',
            marketQuantity: 0.1,
            quoteOrderQty: 0,
            isValid: true
          },
          sell: {
            type: 'limit',
            price: 39365,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: false
          }
        },
        openOrders: [],
        accountInfo: { account: 'info' }
      }
    },
    {
      desc: 'BTCUSDT Sell Limit',
      order: {
        side: 'sell',
        buy: {
          type: 'limit',
          price: 39321.23,
          quantity: 0,
          total: 0,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 0,
          isValid: false
        },
        sell: {
          type: 'limit',
          price: 39321.23,
          quantity: 0.1,
          total: 3932.123,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 0,
          isValid: true
        }
      },
      expectedOrderParams: {
        symbol: 'BTCUSDT',
        side: 'sell',
        type: 'LIMIT',
        quantity: 0.1,
        price: 39321.23
      },
      orderResult: {
        symbol: 'BTCUSDT',
        orderId: 252849,
        orderListId: -1,
        clientOrderId: 'TAdKp3tT6Cloxyi0jaCKiJ',
        transactTime: 1622717568219,
        price: '39321.23000000',
        origQty: '0.10000000',
        executedQty: '0.00000000',
        cummulativeQuoteQty: '0.00000000',
        status: 'NEW',
        timeInForce: 'GTC',
        type: 'LIMIT',
        side: 'SELL',
        fills: []
      },
      openOrders: [],
      expectedData: {
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: false,
        symbolConfiguration: { system: { checkManualBuyOrderPeriod: 10 } },
        buy: {
          openOrders: [],
          processMessage: 'Placed new manual order.',
          updatedAt: expect.any(Object)
        },
        sell: { openOrders: [] },
        order: {
          side: 'sell',
          buy: {
            type: 'limit',
            price: 39321.23,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: false
          },
          sell: {
            type: 'limit',
            price: 39321.23,
            quantity: 0.1,
            total: 3932.123,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: true
          }
        },
        openOrders: [],
        accountInfo: { account: 'info' }
      }
    },
    {
      desc: 'BTCUSDT Sell Market Total',
      order: {
        side: 'sell',
        buy: {
          type: 'limit',
          price: 39284.99,
          quantity: 0,
          total: 0,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 0,
          isValid: false
        },
        sell: {
          type: 'market',
          price: 39284.99,
          quantity: 0,
          total: 0,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 100,
          isValid: true
        }
      },
      expectedOrderParams: {
        symbol: 'BTCUSDT',
        side: 'sell',
        type: 'MARKET',
        quoteOrderQty: 100
      },
      orderResult: {
        symbol: 'BTCUSDT',
        orderId: 254445,
        orderListId: -1,
        clientOrderId: 'g9NWI84xD4wwLe00f0VtlJ',
        transactTime: 1622718270224,
        price: '0.00000000',
        origQty: '0.00254600',
        executedQty: '0.00254600',
        cummulativeQuoteQty: '99.99684876',
        status: 'FILLED',
        timeInForce: 'GTC',
        type: 'MARKET',
        side: 'SELL',
        fills: [
          {
            price: '39276.06000000',
            qty: '0.00254600',
            commission: '0.00000000',
            commissionAsset: 'USDT',
            tradeId: 69077
          }
        ]
      },
      openOrders: [],
      expectedData: {
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: false,
        symbolConfiguration: { system: { checkManualBuyOrderPeriod: 10 } },
        buy: {
          openOrders: [],
          processMessage: 'Placed new manual order.',
          updatedAt: expect.any(Object)
        },
        sell: { openOrders: [] },
        order: {
          side: 'sell',
          buy: {
            type: 'limit',
            price: 39284.99,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: false
          },
          sell: {
            type: 'market',
            price: 39284.99,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 100,
            isValid: true
          }
        },
        openOrders: [],
        accountInfo: { account: 'info' }
      }
    },
    {
      desc: 'BTCUSDT Sell Market Amount',
      order: {
        side: 'sell',
        buy: {
          type: 'limit',
          price: 39168.94,
          quantity: 0,
          total: 0,
          marketType: 'total',
          marketQuantity: 0,
          quoteOrderQty: 0,
          isValid: false
        },
        sell: {
          type: 'market',
          price: 39168.94,
          quantity: 0,
          total: 0,
          marketType: 'amount',
          marketQuantity: 0.1,
          quoteOrderQty: 0,
          isValid: true
        }
      },
      expectedOrderParams: {
        symbol: 'BTCUSDT',
        side: 'sell',
        type: 'MARKET',
        quantity: 0.1
      },
      orderResult: {
        symbol: 'BTCUSDT',
        orderId: 254603,
        orderListId: -1,
        clientOrderId: 'jtWFk4FoIcGwk8aeP1hwnz',
        transactTime: 1622718341244,
        price: '0.00000000',
        origQty: '0.10000000',
        executedQty: '0.09569200',
        cummulativeQuoteQty: '3452.34603593',
        status: 'EXPIRED',
        timeInForce: 'GTC',
        type: 'MARKET',
        side: 'SELL',
        fills: [
          {
            price: '39114.25000000',
            qty: '0.01398500',
            commission: '0.00000000',
            commissionAsset: 'USDT',
            tradeId: 69148
          }
        ]
      },
      openOrders: [],
      expectedData: {
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: false,
        symbolConfiguration: { system: { checkManualBuyOrderPeriod: 10 } },
        buy: {
          openOrders: [],
          processMessage: 'Placed new manual order.',
          updatedAt: expect.any(Object)
        },
        sell: { openOrders: [] },
        order: {
          side: 'sell',
          buy: {
            type: 'limit',
            price: 39168.94,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: false
          },
          sell: {
            type: 'market',
            price: 39168.94,
            quantity: 0,
            total: 0,
            marketType: 'amount',
            marketQuantity: 0.1,
            quoteOrderQty: 0,
            isValid: true
          }
        },
        openOrders: [],
        accountInfo: { account: 'info' }
      }
    }
  ].forEach(testData => {
    describe(`${testData.desc}`, () => {
      beforeEach(async () => {
        mockGetAndCacheOpenOrdersForSymbol = jest
          .fn()
          .mockResolvedValue(testData.openOrders);

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
          getAPILimit: mockGetAPILimit
        }));

        binanceMock.client.order = jest
          .fn()
          .mockResolvedValue(testData.orderResult);

        const step = require('../place-manual-trade');

        rawData = {
          symbol: 'BTCUSDT',
          action: 'manual-trade',
          isLocked: false,
          symbolConfiguration: {
            system: {
              checkManualBuyOrderPeriod: 10
            }
          },
          buy: {
            openOrders: []
          },
          sell: {
            openOrders: []
          },
          order: testData.order
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('triggers binance.client.order', () => {
        expect(binanceMock.client.order).toHaveBeenCalledWith(
          testData.expectedOrderParams
        );
      });

      if (testData.order.side === 'buy') {
        it('triggers cache.hset', () => {
          expect(cacheMock.hset).toHaveBeenCalledWith(
            'trailing-trade-manual-buy-order-BTCUSDT',
            testData.orderResult.orderId,
            JSON.stringify({
              ...testData.orderResult,
              nextCheck: '2020-01-01T00:00:10.000Z'
            })
          );
        });
      } else {
        it('does not trigger cache.hset', () => {
          expect(cacheMock.hset).not.toHaveBeenCalled();
        });
      }

      it('returns expected result', () => {
        expect(result).toStrictEqual(testData.expectedData);
      });
    });
  });

  describe('when unknown order side/type is provided', () => {
    beforeEach(async () => {
      mockGetAndCacheOpenOrdersForSymbol = jest.fn().mockResolvedValue([]);

      jest.mock('../../../trailingTradeHelper/common', () => ({
        getAndCacheOpenOrdersForSymbol: mockGetAndCacheOpenOrdersForSymbol,
        getAccountInfoFromAPI: mockGetAccountInfoFromAPI,
        getAPILimit: mockGetAPILimit
      }));

      binanceMock.client.order = jest.fn().mockResolvedValue(true);

      const step = require('../place-manual-trade');

      rawData = {
        symbol: 'BTCUSDT',
        action: 'manual-trade',
        isLocked: false,
        symbolConfiguration: {
          system: {
            checkManualBuyOrderPeriod: 10
          }
        },
        buy: {
          openOrders: []
        },
        sell: {
          openOrders: []
        },
        order: {
          side: 'sell-not-valid',
          buy: {
            type: 'limit',
            price: 39168.94,
            quantity: 0,
            total: 0,
            marketType: 'total',
            marketQuantity: 0,
            quoteOrderQty: 0,
            isValid: false
          },
          sell: {
            type: 'market',
            price: 39168.94,
            quantity: 0,
            total: 0,
            marketType: 'amount',
            marketQuantity: 0.1,
            quoteOrderQty: 0,
            isValid: true
          }
        }
      };

      try {
        result = await step.execute(loggerMock, rawData);
      } catch (e) {
        error = e;
      }
    });

    it('throws exception', () => {
      expect(error).toStrictEqual(
        new Error('Unknown order side/type for manual trade')
      );
    });
  });
});
