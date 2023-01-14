/* eslint-disable global-require */

describe('user.js', () => {
  let binanceMock;
  let loggerMock;
  let mockExecute;

  let mockGetAccountInfoFromAPI;
  let mockUpdateAccountInfo;
  let mockGridTradeLastOrder;
  let mockUpdateGridTradeLastOrder;
  let mockGetManualOrder;
  let mockSaveManualOrder;

  let mockUserClean;

  describe('setupUserWebsocket', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      jest.mock('../../cronjob');

      const { binance, logger } = require('../../helpers');
      binanceMock = binance;
      loggerMock = logger;

      mockExecute = jest.fn((funcLogger, symbol, jobPayload) => {
        if (!funcLogger || !symbol || !jobPayload) return false;
        return jobPayload.preprocessFn();
      });

      jest.mock('../../cronjob/trailingTradeHelper/queue', () => ({
        execute: mockExecute
      }));
    });

    describe('when balanceUpdate event received', () => {
      beforeEach(async () => {
        mockUserClean = jest.fn().mockResolvedValue(true);

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        binanceMock.client.ws.user = jest.fn().mockImplementationOnce(cb => {
          cb({ eventType: 'balanceUpdate' });

          return mockUserClean;
        });

        const { setupUserWebsocket } = require('../user');

        await setupUserWebsocket(loggerMock);
      });

      it('triggers user', () => {
        expect(binanceMock.client.ws.user).toHaveBeenCalled();
      });

      it('triggers getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
      });

      it('does not trigger userClean', () => {
        expect(mockUserClean).not.toHaveBeenCalled();
      });
    });

    describe('when account event received', () => {
      beforeEach(async () => {
        mockUserClean = jest.fn().mockResolvedValue(true);

        mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
          account: 'info'
        });

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          getAccountInfoFromAPI: mockGetAccountInfoFromAPI
        }));

        binanceMock.client.ws.user = jest.fn().mockImplementationOnce(cb => {
          cb({ eventType: 'account' });

          return mockUserClean;
        });

        const { setupUserWebsocket } = require('../user');

        await setupUserWebsocket(loggerMock);
      });

      it('triggers user', () => {
        expect(binanceMock.client.ws.user).toHaveBeenCalled();
      });

      it('triggers getAccountInfoFromAPI', () => {
        expect(mockGetAccountInfoFromAPI).toHaveBeenCalledWith(loggerMock);
      });

      it('does not trigger userClean', () => {
        expect(mockUserClean).not.toHaveBeenCalled();
      });
    });

    describe('when outboundAccountPosition event received', () => {
      beforeEach(async () => {
        mockUserClean = jest.fn().mockResolvedValue(true);

        mockUpdateAccountInfo = jest.fn().mockResolvedValue({
          account: 'updated'
        });

        jest.mock('../../cronjob/trailingTradeHelper/common', () => ({
          updateAccountInfo: mockUpdateAccountInfo
        }));

        binanceMock.client.ws.user = jest.fn().mockImplementationOnce(cb => {
          cb({
            eventType: 'outboundAccountPosition',
            balances: [
              { asset: 'ADA', free: '0.00000000', locked: '13.82000000' }
            ],
            lastAccountUpdate: 1625585531721
          });

          return mockUserClean;
        });

        const { setupUserWebsocket } = require('../user');

        await setupUserWebsocket(loggerMock);
      });

      it('triggers updateAccountInfo', () => {
        expect(mockUpdateAccountInfo).toHaveBeenCalledWith(
          loggerMock,
          [{ asset: 'ADA', free: '0.00000000', locked: '13.82000000' }],
          1625585531721
        );
      });

      it('does not trigger userClean', () => {
        expect(mockUserClean).not.toHaveBeenCalled();
      });
    });

    describe('when executionReport event received', () => {
      describe('when last order not found', () => {
        beforeEach(async () => {
          mockUserClean = jest.fn().mockResolvedValue(true);

          mockGridTradeLastOrder = jest.fn().mockResolvedValue(null);
          mockUpdateGridTradeLastOrder = jest.fn().mockResolvedValue(null);
          mockGetManualOrder = jest.fn().mockResolvedValue(null);
          mockSaveManualOrder = jest.fn().mockResolvedValue(null);

          jest.mock('../../cronjob/trailingTradeHelper/order', () => ({
            getGridTradeLastOrder: mockGridTradeLastOrder,
            updateGridTradeLastOrder: mockUpdateGridTradeLastOrder,
            getManualOrder: mockGetManualOrder,
            saveManualOrder: mockSaveManualOrder
          }));

          binanceMock.client.ws.user = jest.fn().mockImplementationOnce(cb => {
            /**
             * Sample execution report
             * {
             *   "eventType": "executionReport",
             *   "eventTime": 1642713283562,
             *   "symbol": "ETHUSDT",
             *   "newClientOrderId": "R4gzUYn9pQbOA3vAkgKTSw",
             *   "originalClientOrderId": "",
             *   "side": "BUY",
             *   "orderType": "STOP_LOSS_LIMIT",
             *   "timeInForce": "GTC",
             *   "quantity": "0.00920000",
             *   "price": "3248.37000000",
             *   "executionType": "NEW",
             *   "stopPrice": "3245.19000000",
             *   "icebergQuantity": "0.00000000",
             *   "orderStatus": "NEW",
             *   "orderRejectReason": "NONE",
             *   "orderId": 7479643460,
             *   "orderTime": 1642713283561,
             *   "lastTradeQuantity": "0.00000000",
             *   "totalTradeQuantity": "0.00000000",
             *   "priceLastTrade": "0.00000000",
             *   "commission": "0",
             *   "commissionAsset": null,
             *   "tradeId": -1,
             *   "isOrderWorking": false,
             *   "isBuyerMaker": false,
             *   "creationTime": 1642713283561,
             *   "totalQuoteTradeQuantity": "0.00000000",
             *   "orderListId": -1,
             *   "quoteOrderQuantity": "0.00000000",
             *   "lastQuoteTransacted": "0.00000000"
             * }
             */
            cb({
              eventType: 'executionReport',
              eventTime: 1642713283562,
              symbol: 'ETHUSDT',
              side: 'BUY',
              orderStatus: 'NEW',
              orderType: 'STOP_LOSS_LIMIT',
              stopPrice: '3245.19000000',
              price: '3248.37000000',
              orderId: 7479643460,
              quantity: '0.00920000',
              isOrderWorking: false,
              totalQuoteTradeQuantity: '0.00000000',
              totalTradeQuantity: '0.00000000'
            });

            return mockUserClean;
          });

          const { setupUserWebsocket } = require('../user');

          await setupUserWebsocket(loggerMock);
        });

        it('triggers getGridTradeLastOrder', () => {
          expect(mockGridTradeLastOrder).toHaveBeenCalledWith(
            loggerMock,
            'ETHUSDT',
            'buy'
          );
        });

        it('does not trigger updateGridTradeLastOrder', () => {
          expect(mockUpdateGridTradeLastOrder).not.toHaveBeenCalled();
        });

        it('triggers queue.execute twice', () => {
          expect(mockExecute).toHaveBeenCalledTimes(2);
        });

        it('does not trigger userClean', () => {
          expect(mockUserClean).not.toHaveBeenCalled();
        });
      });

      describe('when last order found', () => {
        describe('received transaction time > existing transaction time', () => {
          beforeEach(async () => {
            mockUserClean = jest.fn().mockResolvedValue(true);

            mockGridTradeLastOrder = jest.fn().mockResolvedValue({
              orderId: 7479643460,
              transactTime: 1642713282000
            });
            mockUpdateGridTradeLastOrder = jest.fn().mockResolvedValue(null);
            mockGetManualOrder = jest.fn().mockResolvedValue(null);
            mockSaveManualOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../cronjob/trailingTradeHelper/order', () => ({
              getGridTradeLastOrder: mockGridTradeLastOrder,
              updateGridTradeLastOrder: mockUpdateGridTradeLastOrder,
              getManualOrder: mockGetManualOrder,
              saveManualOrder: mockSaveManualOrder
            }));

            binanceMock.client.ws.user = jest
              .fn()
              .mockImplementationOnce(cb => {
                /**
                 * Sample execution report
                 * {
                 *   "eventType": "executionReport",
                 *   "eventTime": 1642713283562,
                 *   "symbol": "ETHUSDT",
                 *   "newClientOrderId": "R4gzUYn9pQbOA3vAkgKTSw",
                 *   "originalClientOrderId": "",
                 *   "side": "BUY",
                 *   "orderType": "STOP_LOSS_LIMIT",
                 *   "timeInForce": "GTC",
                 *   "quantity": "0.00920000",
                 *   "price": "3248.37000000",
                 *   "executionType": "NEW",
                 *   "stopPrice": "3245.19000000",
                 *   "icebergQuantity": "0.00000000",
                 *   "orderStatus": "NEW",
                 *   "orderRejectReason": "NONE",
                 *   "orderId": 7479643460,
                 *   "orderTime": 1642713283561,
                 *   "lastTradeQuantity": "0.00000000",
                 *   "totalTradeQuantity": "0.00000000",
                 *   "priceLastTrade": "0.00000000",
                 *   "commission": "0",
                 *   "commissionAsset": null,
                 *   "tradeId": -1,
                 *   "isOrderWorking": false,
                 *   "isBuyerMaker": false,
                 *   "creationTime": 1642713283561,
                 *   "totalQuoteTradeQuantity": "0.00000000",
                 *   "orderListId": -1,
                 *   "quoteOrderQuantity": "0.00000000",
                 *   "lastQuoteTransacted": "0.00000000"
                 * }
                 */
                cb({
                  eventType: 'executionReport',
                  eventTime: 1642713283562,
                  symbol: 'ETHUSDT',
                  side: 'BUY',
                  orderStatus: 'NEW',
                  orderType: 'STOP_LOSS_LIMIT',
                  stopPrice: '3245.19000000',
                  price: '3248.37000000',
                  orderId: 7479643460,
                  quantity: '0.00920000',
                  isOrderWorking: false,
                  totalQuoteTradeQuantity: '0.00000000',
                  totalTradeQuantity: '0.00000000',
                  orderTime: 1642713283561
                });

                return mockUserClean;
              });

            const { setupUserWebsocket } = require('../user');

            await setupUserWebsocket(loggerMock);
          });

          it('triggers getGridTradeLastOrder', () => {
            expect(mockGridTradeLastOrder).toHaveBeenCalledWith(
              loggerMock,
              'ETHUSDT',
              'buy'
            );
          });

          it('triggers updateGridTradeLastOrder', () => {
            expect(mockUpdateGridTradeLastOrder).toHaveBeenCalledWith(
              loggerMock,
              'ETHUSDT',
              'buy',
              {
                cummulativeQuoteQty: '0.00000000',
                executedQty: '0.00000000',
                isWorking: false,
                orderId: 7479643460,
                origQty: '0.00920000',
                price: '3248.37000000',
                side: 'BUY',
                status: 'NEW',
                stopPrice: '3245.19000000',
                type: 'STOP_LOSS_LIMIT',
                updateTime: 1642713283562,
                transactTime: 1642713283561
              }
            );
          });

          it('triggers queue.execute', () => {
            expect(mockExecute).toHaveBeenCalledWith(loggerMock, 'ETHUSDT', {
              correlationId: expect.any(String),
              preprocessFn: expect.any(Function),
              processFn: expect.any(Function)
            });
          });

          it('does not trigger userClean', () => {
            expect(mockUserClean).not.toHaveBeenCalled();
          });
        });
        describe('received transaction time < existing transaction time', () => {
          beforeEach(async () => {
            mockUserClean = jest.fn().mockResolvedValue(true);

            mockGridTradeLastOrder = jest.fn().mockResolvedValue({
              orderId: 7479643460,
              transactTime: 1642713282000
            });
            mockUpdateGridTradeLastOrder = jest.fn().mockResolvedValue(null);
            mockGetManualOrder = jest.fn().mockResolvedValue(null);
            mockSaveManualOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../cronjob/trailingTradeHelper/order', () => ({
              getGridTradeLastOrder: mockGridTradeLastOrder,
              updateGridTradeLastOrder: mockUpdateGridTradeLastOrder,
              getManualOrder: mockGetManualOrder,
              saveManualOrder: mockSaveManualOrder
            }));

            binanceMock.client.ws.user = jest
              .fn()
              .mockImplementationOnce(cb => {
                /**
                 * Sample execution report
                 * {
                 *   "eventType": "executionReport",
                 *   "eventTime": 1642713283562,
                 *   "symbol": "ETHUSDT",
                 *   "newClientOrderId": "R4gzUYn9pQbOA3vAkgKTSw",
                 *   "originalClientOrderId": "",
                 *   "side": "BUY",
                 *   "orderType": "STOP_LOSS_LIMIT",
                 *   "timeInForce": "GTC",
                 *   "quantity": "0.00920000",
                 *   "price": "3248.37000000",
                 *   "executionType": "NEW",
                 *   "stopPrice": "3245.19000000",
                 *   "icebergQuantity": "0.00000000",
                 *   "orderStatus": "NEW",
                 *   "orderRejectReason": "NONE",
                 *   "orderId": 7479643460,
                 *   "orderTime": 1642713283561,
                 *   "lastTradeQuantity": "0.00000000",
                 *   "totalTradeQuantity": "0.00000000",
                 *   "priceLastTrade": "0.00000000",
                 *   "commission": "0",
                 *   "commissionAsset": null,
                 *   "tradeId": -1,
                 *   "isOrderWorking": false,
                 *   "isBuyerMaker": false,
                 *   "creationTime": 1642713283561,
                 *   "totalQuoteTradeQuantity": "0.00000000",
                 *   "orderListId": -1,
                 *   "quoteOrderQuantity": "0.00000000",
                 *   "lastQuoteTransacted": "0.00000000"
                 * }
                 */
                cb({
                  eventType: 'executionReport',
                  eventTime: 1642713283562,
                  symbol: 'ETHUSDT',
                  side: 'BUY',
                  orderStatus: 'NEW',
                  orderType: 'STOP_LOSS_LIMIT',
                  stopPrice: '3245.19000000',
                  price: '3248.37000000',
                  orderId: 7479643460,
                  quantity: '0.00920000',
                  isOrderWorking: false,
                  totalQuoteTradeQuantity: '0.00000000',
                  totalTradeQuantity: '0.00000000',
                  orderTime: 1642713281000
                });

                return mockUserClean;
              });

            const { setupUserWebsocket } = require('../user');

            await setupUserWebsocket(loggerMock);
          });

          it('triggers getGridTradeLastOrder', () => {
            expect(mockGridTradeLastOrder).toHaveBeenCalledWith(
              loggerMock,
              'ETHUSDT',
              'buy'
            );
          });

          it('does not trigger updateGridTradeLastOrder', () => {
            expect(mockUpdateGridTradeLastOrder).not.toHaveBeenCalled();
          });

          it('triggers queue.execute twice', () => {
            expect(mockExecute).toHaveBeenCalledTimes(2);
          });

          it('does not trigger userClean', () => {
            expect(mockUserClean).not.toHaveBeenCalled();
          });
        });
      });

      describe('when manual order not found', () => {
        beforeEach(async () => {
          mockUserClean = jest.fn().mockResolvedValue(true);

          mockGridTradeLastOrder = jest.fn().mockResolvedValue(null);
          mockUpdateGridTradeLastOrder = jest.fn().mockResolvedValue(null);
          mockGetManualOrder = jest.fn().mockResolvedValue(null);
          mockSaveManualOrder = jest.fn().mockResolvedValue(null);

          jest.mock('../../cronjob/trailingTradeHelper/order', () => ({
            getGridTradeLastOrder: mockGridTradeLastOrder,
            updateGridTradeLastOrder: mockUpdateGridTradeLastOrder,
            getManualOrder: mockGetManualOrder,
            saveManualOrder: mockSaveManualOrder
          }));

          binanceMock.client.ws.user = jest.fn().mockImplementationOnce(cb => {
            /**
             * Sample execution report
             * {
             *   "eventType": "executionReport",
             *   "eventTime": 1642713283562,
             *   "symbol": "ETHUSDT",
             *   "newClientOrderId": "R4gzUYn9pQbOA3vAkgKTSw",
             *   "originalClientOrderId": "",
             *   "side": "BUY",
             *   "orderType": "STOP_LOSS_LIMIT",
             *   "timeInForce": "GTC",
             *   "quantity": "0.00920000",
             *   "price": "3248.37000000",
             *   "executionType": "NEW",
             *   "stopPrice": "3245.19000000",
             *   "icebergQuantity": "0.00000000",
             *   "orderStatus": "NEW",
             *   "orderRejectReason": "NONE",
             *   "orderId": 7479643460,
             *   "orderTime": 1642713283561,
             *   "lastTradeQuantity": "0.00000000",
             *   "totalTradeQuantity": "0.00000000",
             *   "priceLastTrade": "0.00000000",
             *   "commission": "0",
             *   "commissionAsset": null,
             *   "tradeId": -1,
             *   "isOrderWorking": false,
             *   "isBuyerMaker": false,
             *   "creationTime": 1642713283561,
             *   "totalQuoteTradeQuantity": "0.00000000",
             *   "orderListId": -1,
             *   "quoteOrderQuantity": "0.00000000",
             *   "lastQuoteTransacted": "0.00000000"
             * }
             */
            cb({
              eventType: 'executionReport',
              eventTime: 1642713283562,
              symbol: 'ETHUSDT',
              side: 'BUY',
              orderStatus: 'NEW',
              orderType: 'STOP_LOSS_LIMIT',
              stopPrice: '3245.19000000',
              price: '3248.37000000',
              orderId: 7479643460,
              quantity: '0.00920000',
              isOrderWorking: false,
              totalQuoteTradeQuantity: '0.00000000',
              totalTradeQuantity: '0.00000000'
            });

            return mockUserClean;
          });

          const { setupUserWebsocket } = require('../user');

          await setupUserWebsocket(loggerMock);
        });

        it('triggers getManualOrder', () => {
          expect(mockGetManualOrder).toHaveBeenCalledWith(
            loggerMock,
            'ETHUSDT',
            7479643460
          );
        });

        it('does not trigger saveManualOrder', () => {
          expect(mockSaveManualOrder).not.toHaveBeenCalled();
        });

        it('triggers queue.execute twice', () => {
          expect(mockExecute).toHaveBeenCalledTimes(2);
        });

        it('does not trigger userClean', () => {
          expect(mockUserClean).not.toHaveBeenCalled();
        });
      });
      describe('when manual order found', () => {
        beforeEach(async () => {
          mockUserClean = jest.fn().mockResolvedValue(true);

          mockGridTradeLastOrder = jest.fn().mockResolvedValue(null);
          mockUpdateGridTradeLastOrder = jest.fn().mockResolvedValue(null);
          mockGetManualOrder = jest
            .fn()
            .mockResolvedValue({ orderId: 7479643460 });
          mockSaveManualOrder = jest.fn().mockResolvedValue(true);

          jest.mock('../../cronjob/trailingTradeHelper/order', () => ({
            getGridTradeLastOrder: mockGridTradeLastOrder,
            updateGridTradeLastOrder: mockUpdateGridTradeLastOrder,
            getManualOrder: mockGetManualOrder,
            saveManualOrder: mockSaveManualOrder
          }));

          binanceMock.client.ws.user = jest.fn().mockImplementationOnce(cb => {
            /**
             * Sample execution report
             * {
             *   "eventType": "executionReport",
             *   "eventTime": 1642713283562,
             *   "symbol": "ETHUSDT",
             *   "newClientOrderId": "R4gzUYn9pQbOA3vAkgKTSw",
             *   "originalClientOrderId": "",
             *   "side": "BUY",
             *   "orderType": "STOP_LOSS_LIMIT",
             *   "timeInForce": "GTC",
             *   "quantity": "0.00920000",
             *   "price": "3248.37000000",
             *   "executionType": "NEW",
             *   "stopPrice": "3245.19000000",
             *   "icebergQuantity": "0.00000000",
             *   "orderStatus": "NEW",
             *   "orderRejectReason": "NONE",
             *   "orderId": 7479643460,
             *   "orderTime": 1642713283561,
             *   "lastTradeQuantity": "0.00000000",
             *   "totalTradeQuantity": "0.00000000",
             *   "priceLastTrade": "0.00000000",
             *   "commission": "0",
             *   "commissionAsset": null,
             *   "tradeId": -1,
             *   "isOrderWorking": false,
             *   "isBuyerMaker": false,
             *   "creationTime": 1642713283561,
             *   "totalQuoteTradeQuantity": "0.00000000",
             *   "orderListId": -1,
             *   "quoteOrderQuantity": "0.00000000",
             *   "lastQuoteTransacted": "0.00000000"
             * }
             */
            cb({
              eventType: 'executionReport',
              eventTime: 1642713283562,
              symbol: 'ETHUSDT',
              side: 'BUY',
              orderStatus: 'NEW',
              orderType: 'STOP_LOSS_LIMIT',
              stopPrice: '3245.19000000',
              price: '3248.37000000',
              orderId: 7479643460,
              quantity: '0.00920000',
              isOrderWorking: false,
              totalQuoteTradeQuantity: '0.00000000',
              totalTradeQuantity: '0.00000000'
            });

            return mockUserClean;
          });

          const { setupUserWebsocket } = require('../user');

          await setupUserWebsocket(loggerMock);
        });

        it('triggers getManualOrder', () => {
          expect(mockGetManualOrder).toHaveBeenCalledWith(
            loggerMock,
            'ETHUSDT',
            7479643460
          );
        });

        it('triggers saveManualOrder', () => {
          expect(mockSaveManualOrder).toHaveBeenCalledWith(
            loggerMock,
            'ETHUSDT',
            7479643460,
            {
              cummulativeQuoteQty: '0.00000000',
              executedQty: '0.00000000',
              isWorking: false,
              orderId: 7479643460,
              origQty: '0.00920000',
              price: '3248.37000000',
              side: 'BUY',
              status: 'NEW',
              stopPrice: '3245.19000000',
              type: 'STOP_LOSS_LIMIT',
              updateTime: 1642713283562
            }
          );
        });

        it('triggers queue.execute', () => {
          expect(mockExecute).toHaveBeenCalledWith(loggerMock, 'ETHUSDT', {
            correlationId: expect.any(String),
            preprocessFn: expect.any(Function),
            processFn: expect.any(Function)
          });
        });

        it('does not trigger userClean', () => {
          expect(mockUserClean).not.toHaveBeenCalled();
        });
      });
    });

    describe('when user clean is not null', () => {
      beforeEach(async () => {
        mockUserClean = jest.fn().mockResolvedValue(true);
        binanceMock.client.ws.user = jest
          .fn()
          .mockImplementationOnce(() => mockUserClean);

        const { setupUserWebsocket } = require('../user');

        await setupUserWebsocket(loggerMock);

        await setupUserWebsocket(loggerMock);
      });

      it('triggers user', () => {
        expect(binanceMock.client.ws.user).toHaveBeenCalled();
      });

      it('triggers userClean', () => {
        expect(mockUserClean).toHaveBeenCalled();
      });
    });
  });
});
