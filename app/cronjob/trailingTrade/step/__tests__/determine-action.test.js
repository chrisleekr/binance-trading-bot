/* eslint-disable global-require */
const moment = require('moment');
const _ = require('lodash');

describe('determine-action.js', () => {
  let result;
  let orgRawData;
  let rawData;
  let step;

  let cacheMock;
  let loggerMock;

  let mockIsActionDisabled;
  let mockGetNumberOfBuyOpenOrders;
  let mockGetNumberOfOpenTrades;
  let mockGetAPILimit;

  let mockGetGridTradeOrder;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
      mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(1);
      mockGetNumberOfOpenTrades = jest.fn().mockResolvedValue(6);
      mockGetAPILimit = jest.fn().mockReturnValue(5);
    });

    beforeEach(async () => {
      const { cache, logger } = require('../../../../helpers');
      cacheMock = cache;
      loggerMock = logger;

      cacheMock.get = jest.fn().mockImplementation(_key => null);

      orgRawData = {
        action: 'not-determined',
        symbol: 'BTCUSDT',
        isLocked: false,
        symbolInfo: {
          baseAsset: 'BTC',
          filterLotSize: { stepSize: '0.00000100' },
          filterMinNotional: {
            minNotional: '10.00000000'
          }
        },
        baseAssetBalance: {
          total: 0
        },
        symbolConfiguration: {
          botOptions: {
            orderLimit: {
              enabled: true,
              maxBuyOpenOrders: 3,
              maxOpenTrades: 6
            },
            tradingView: { useOnlyWithin: 5 }
          },
          buy: {
            athRestriction: {
              enabled: true
            },
            currentGridTradeIndex: 0,
            currentGridTrade: {
              triggerPercentage: 1,
              stopPercentage: 1.025,
              limitPercentage: 1.026,
              maxPurchaseAmount: 10,
              executed: false,
              executedOrder: null
            }
          },
          sell: {
            stopLoss: {
              enabled: false
            },
            currentGridTradeIndex: 0,
            currentGridTrade: {
              triggerPercentage: 1.03,
              stopPercentage: 0.985,
              limitPercentage: 0.984,
              quantityPercentage: 0.8,
              executed: false,
              executedOrder: null
            },
            tradingView: {
              forceSellOverZeroBelowTriggerPrice: {
                whenNeutral: true,
                whenSell: false,
                whenStrongSell: false
              }
            }
          }
        },
        buy: {
          currentPrice: 31786.08,
          triggerPrice: 28924.92,
          athRestrictionPrice: 29572.2
        },
        sell: {
          currentPrice: 31786.08,
          triggerPrice: 33102.964,
          lastBuyPrice: 32138.799999999996,
          stopLossTriggerPrice: 25711.039999999997
        },
        tradingView: {}
      };
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        rawData = _.cloneDeep(orgRawData);
        rawData.isLocked = true;

        step = require('../determine-action');

        result = await step.execute(loggerMock, rawData);
      });

      it('returns same data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is buy-order-wait', () => {
      beforeEach(async () => {
        rawData = _.cloneDeep(orgRawData);
        rawData.action = 'buy-order-wait';

        step = require('../determine-action');

        result = await step.execute(loggerMock, rawData);
      });

      it('returns same data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is buy', () => {
      beforeEach(async () => {
        rawData = _.cloneDeep(orgRawData);
        rawData.action = 'buy';

        step = require('../determine-action');

        result = await step.execute(loggerMock, rawData);
      });

      it('returns same data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is not-determined', () => {
      beforeEach(() => {
        mockIsActionDisabled = jest.fn().mockResolvedValue({
          isDisabled: false
        });

        jest.mock('../../../trailingTradeHelper/common', () => ({
          isActionDisabled: mockIsActionDisabled
        }));

        mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

        jest.mock('../../../trailingTradeHelper/order', () => ({
          getGridTradeOrder: mockGetGridTradeOrder
        }));
      });

      describe(
        `buy - when last buy price is not configured and ` +
          `current price is less or equal than trigger price`,
        () => {
          describe('when base asset balance has enough to sell', () => {
            beforeEach(async () => {
              rawData = _.cloneDeep(orgRawData);
              rawData.action = 'not-determined';
              rawData.baseAssetBalance.total = 0.0005;

              rawData.buy = {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 29572.2
              };

              rawData.sell = {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              };

              step = require('../determine-action');

              result = await step.execute(loggerMock, rawData);
            });

            it('should wait because not enough to sell', () => {
              expect(result).toMatchObject({
                action: 'wait',
                baseAssetBalance: {
                  total: 0.0005
                },
                buy: {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 29572.2,
                  processMessage:
                    `The current price reached the trigger price. But you have enough BTC to sell. ` +
                    `Set the last buy price to start selling. Do not process buy.`,
                  updatedAt: expect.any(Object)
                },
                sell: {
                  currentPrice: 28000,
                  triggerPrice: null,
                  lastBuyPrice: null,
                  stopLossTriggerPrice: null
                }
              });
            });
          });

          describe('getGridTradeLastOrder - when grid trade buy order is found', () => {
            beforeEach(async () => {
              mockGetGridTradeOrder = jest.fn().mockResolvedValue({
                orderId: 27123456
              });

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              rawData = _.cloneDeep(orgRawData);
              rawData.action = 'not-determined';
              rawData.baseAssetBalance.total = 0.0003;

              rawData.buy = {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 29572.2
              };

              rawData.sell = {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              };

              step = require('../determine-action');

              result = await step.execute(loggerMock, rawData);
            });

            it('should wait for a buy order because grid trade is found', () => {
              expect(result).toMatchObject({
                action: 'buy-order-wait',
                buy: {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 29572.2,
                  processMessage: `There is a last gird trade buy order. Wait.`,
                  updatedAt: expect.any(Object)
                },
                sell: {
                  currentPrice: 28000,
                  triggerPrice: null,
                  lastBuyPrice: null,
                  stopLossTriggerPrice: null
                }
              });
            });
          });

          describe('when the symbol is disabled', () => {
            beforeEach(async () => {
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: true,
                ttl: 300,
                disabledBy: 'buy order',
                message: 'Disabled action after confirming the buy order.',
                canResume: false,
                canRemoveLastBuyPrice: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              rawData = _.cloneDeep(orgRawData);
              rawData.action = 'not-determined';
              rawData.baseAssetBalance.total = 0.0003;

              rawData.buy = {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 29572.2
              };

              rawData.sell = {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              };

              step = require('../determine-action');

              result = await step.execute(loggerMock, rawData);
            });

            it('should not buy because buy is disabled', () => {
              expect(result).toMatchObject({
                action: 'buy-temporary-disabled',
                buy: {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 29572.2,
                  processMessage:
                    `The current price reached the trigger price. ` +
                    `However, the action is temporarily disabled by buy order. ` +
                    `Resume buy process after 300s.`,
                  updatedAt: expect.any(Object)
                },
                sell: {
                  currentPrice: 28000,
                  triggerPrice: null,
                  lastBuyPrice: null,
                  stopLossTriggerPrice: null
                }
              });
            });
          });

          describe('isGreaterThanTheATHRestrictionPrice', () => {
            beforeEach(() => {
              mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(1);
              mockGetNumberOfOpenTrades = jest.fn().mockResolvedValue(6);
            });

            describe('when the ATH restriction is enabled', () => {
              describe('currentGridTradeIndex is 0', () => {
                beforeEach(async () => {
                  mockIsActionDisabled = jest.fn().mockResolvedValue({
                    isDisabled: false
                  });

                  jest.mock('../../../trailingTradeHelper/common', () => ({
                    isActionDisabled: mockIsActionDisabled,
                    getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                    getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                    getAPILimit: mockGetAPILimit
                  }));

                  mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                  jest.mock('../../../trailingTradeHelper/order', () => ({
                    getGridTradeOrder: mockGetGridTradeOrder
                  }));

                  rawData = _.cloneDeep(orgRawData);

                  rawData.baseAssetBalance.total = 0.0003;

                  rawData.symbolConfiguration.botOptions.orderLimit = {
                    enabled: true,
                    maxBuyOpenOrders: 5,
                    maxOpenTrades: 10
                  };

                  // Set ATH restriction price less than the current price
                  rawData.buy = {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  };
                  rawData.sell = {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  };

                  step = require('../determine-action');

                  result = await step.execute(loggerMock, rawData);
                });

                it('should wait because ATH restriction price is less than the current price', () => {
                  expect(result).toMatchObject({
                    action: 'wait',
                    baseAssetBalance: {
                      total: 0.0003
                    },
                    symbolConfiguration: {
                      botOptions: {
                        orderLimit: {
                          enabled: true,
                          maxBuyOpenOrders: 5,
                          maxOpenTrades: 10
                        }
                      }
                    },
                    buy: {
                      currentPrice: 28000,
                      triggerPrice: 28000,
                      athRestrictionPrice: 27000,
                      processMessage:
                        `The current price has reached the lowest price; however, ` +
                        `it is restricted to buy the coin because ATH price higher than the current price.`,
                      updatedAt: expect.any(Object)
                    },
                    sell: {
                      currentPrice: 28000,
                      triggerPrice: null,
                      lastBuyPrice: null,
                      stopLossTriggerPrice: null
                    }
                  });
                });
              });

              describe('currentGridTradeIndex is 1', () => {
                beforeEach(async () => {
                  mockIsActionDisabled = jest.fn().mockResolvedValue({
                    isDisabled: false
                  });

                  jest.mock('../../../trailingTradeHelper/common', () => ({
                    isActionDisabled: mockIsActionDisabled,
                    getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                    getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                    getAPILimit: mockGetAPILimit
                  }));

                  mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                  jest.mock('../../../trailingTradeHelper/order', () => ({
                    getGridTradeOrder: mockGetGridTradeOrder
                  }));

                  rawData = _.cloneDeep(orgRawData);

                  rawData.baseAssetBalance.total = 0.0003;

                  rawData.symbolConfiguration.botOptions.orderLimit = {
                    enabled: true,
                    maxBuyOpenOrders: 5,
                    maxOpenTrades: 10
                  };

                  // Set ATH restriction true
                  rawData.symbolConfiguration.buy = {
                    athRestriction: {
                      enabled: true
                    },
                    currentGridTradeIndex: 1,
                    currentGridTrade: {
                      triggerPercentage: 0.8,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      maxPurchaseAmount: 10,
                      executed: false,
                      executedOrder: null
                    }
                  };

                  // Set ATH restriction price less than the current price
                  rawData.buy = {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  };
                  rawData.sell = {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  };

                  step = require('../determine-action');

                  result = await step.execute(loggerMock, rawData);
                });

                it(
                  `should place a buy order because ATH restriction does ` +
                    `not apply from 2nd grid trade onwards`,
                  () => {
                    expect(result).toMatchObject({
                      action: 'buy',
                      symbolConfiguration: {
                        botOptions: {
                          orderLimit: {
                            enabled: true,
                            maxBuyOpenOrders: 5,
                            maxOpenTrades: 10
                          }
                        },
                        buy: {
                          athRestriction: {
                            enabled: true
                          },
                          currentGridTradeIndex: 1,
                          currentGridTrade: {
                            triggerPercentage: 0.8,
                            stopPercentage: 1.025,
                            limitPercentage: 1.026,
                            maxPurchaseAmount: 10,
                            executed: false,
                            executedOrder: null
                          }
                        }
                      },
                      buy: {
                        currentPrice: 28000,
                        triggerPrice: 28000,
                        athRestrictionPrice: 27000,
                        processMessage:
                          "The current price reached the trigger price for the grid trade #2. Let's buy it.",
                        updatedAt: expect.any(Object)
                      },
                      sell: {
                        currentPrice: 28000,
                        triggerPrice: null,
                        lastBuyPrice: null,
                        stopLossTriggerPrice: null
                      }
                    });
                  }
                );
              });
            });

            describe('when the ATH restriction is disabled', () => {
              describe('currentGridTradeIndex is 0', () => {
                beforeEach(async () => {
                  mockIsActionDisabled = jest.fn().mockResolvedValue({
                    isDisabled: false
                  });

                  jest.mock('../../../trailingTradeHelper/common', () => ({
                    isActionDisabled: mockIsActionDisabled,
                    getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                    getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                    getAPILimit: mockGetAPILimit
                  }));

                  mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                  jest.mock('../../../trailingTradeHelper/order', () => ({
                    getGridTradeOrder: mockGetGridTradeOrder
                  }));

                  rawData = _.cloneDeep(orgRawData);

                  rawData.baseAssetBalance.total = 0.0003;

                  rawData.symbolConfiguration.botOptions.orderLimit = {
                    enabled: true,
                    maxBuyOpenOrders: 5,
                    maxOpenTrades: 10
                  };

                  // Set ATH restriction disabled
                  rawData.symbolConfiguration.buy = {
                    athRestriction: {
                      enabled: false
                    },
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      maxPurchaseAmount: 10,
                      executed: false,
                      executedOrder: null
                    }
                  };

                  // Set ATH restriction price less than the current price
                  rawData.buy = {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  };
                  rawData.sell = {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  };

                  step = require('../determine-action');

                  result = await step.execute(loggerMock, rawData);
                });

                it('should place a buy order because ATH restriction is disabled', () => {
                  expect(result).toMatchObject({
                    action: 'buy',
                    baseAssetBalance: {
                      total: 0.0003
                    },
                    symbolConfiguration: {
                      buy: {
                        athRestriction: {
                          enabled: false
                        },
                        currentGridTradeIndex: 0,
                        currentGridTrade: {
                          triggerPercentage: 1,
                          stopPercentage: 1.025,
                          limitPercentage: 1.026,
                          maxPurchaseAmount: 10,
                          executed: false,
                          executedOrder: null
                        }
                      }
                    },
                    buy: {
                      currentPrice: 28000,
                      triggerPrice: 28000,
                      athRestrictionPrice: 27000,
                      processMessage:
                        "The current price reached the trigger price for the grid trade #1. Let's buy it.",
                      updatedAt: expect.any(Object)
                    },
                    sell: {
                      currentPrice: 28000,
                      triggerPrice: null,
                      lastBuyPrice: null,
                      stopLossTriggerPrice: null
                    }
                  });
                });
              });

              describe('currentGridTradeIndex is 1', () => {
                beforeEach(async () => {
                  mockIsActionDisabled = jest.fn().mockResolvedValue({
                    isDisabled: false
                  });

                  jest.mock('../../../trailingTradeHelper/common', () => ({
                    isActionDisabled: mockIsActionDisabled,
                    getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                    getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                    getAPILimit: mockGetAPILimit
                  }));

                  mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                  jest.mock('../../../trailingTradeHelper/order', () => ({
                    getGridTradeOrder: mockGetGridTradeOrder
                  }));

                  rawData = _.cloneDeep(orgRawData);

                  rawData.baseAssetBalance.total = 0.0003;

                  rawData.symbolConfiguration.botOptions.orderLimit = {
                    enabled: true,
                    maxBuyOpenOrders: 5,
                    maxOpenTrades: 10
                  };

                  // Set ATH restriction disabled
                  rawData.symbolConfiguration.buy = {
                    athRestriction: {
                      enabled: false
                    },
                    currentGridTradeIndex: 1,
                    currentGridTrade: {
                      triggerPercentage: 0.8,
                      stopPercentage: 1.025,
                      limitPercentage: 1.026,
                      maxPurchaseAmount: 10,
                      executed: false,
                      executedOrder: null
                    }
                  };

                  // Set ATH restriction price less than the current price
                  rawData.buy = {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  };
                  rawData.sell = {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  };

                  step = require('../determine-action');

                  result = await step.execute(loggerMock, rawData);
                });

                it(
                  `should place a buy order because ATH restriction does ` +
                    `not apply from 2nd grid trade onwards`,
                  () => {
                    expect(result).toMatchObject({
                      action: 'buy',
                      baseAssetBalance: {
                        total: 0.0003
                      },
                      symbolConfiguration: {
                        buy: {
                          athRestriction: {
                            enabled: false
                          },
                          currentGridTradeIndex: 1,
                          currentGridTrade: {
                            triggerPercentage: 0.8,
                            stopPercentage: 1.025,
                            limitPercentage: 1.026,
                            maxPurchaseAmount: 10,
                            executed: false,
                            executedOrder: null
                          }
                        }
                      },
                      buy: {
                        currentPrice: 28000,
                        triggerPrice: 28000,
                        athRestrictionPrice: 27000,
                        processMessage:
                          "The current price reached the trigger price for the grid trade #2. Let's buy it.",
                        updatedAt: expect.any(Object)
                      },
                      sell: {
                        currentPrice: 28000,
                        triggerPrice: null,
                        lastBuyPrice: null,
                        stopLossTriggerPrice: null
                      }
                    });
                  }
                );
              });
            });
          });

          describe('isExceedingMaxBuyOpenOrders', () => {
            describe('when order limit is enabled', () => {
              beforeEach(async () => {
                // Set number of current buy open orders to 3
                mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(3);
                mockGetNumberOfOpenTrades = jest.fn().mockResolvedValue(6);

                mockIsActionDisabled = jest.fn().mockResolvedValue({
                  isDisabled: false
                });

                jest.mock('../../../trailingTradeHelper/common', () => ({
                  isActionDisabled: mockIsActionDisabled,
                  getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                  getAPILimit: mockGetAPILimit
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                rawData = _.cloneDeep(orgRawData);
                rawData.action = 'not-determined';
                rawData.baseAssetBalance.total = 0.0003;

                // Set maxBuyOpenOrders to 3
                rawData.symbolConfiguration.botOptions = {
                  orderLimit: {
                    enabled: true,
                    maxBuyOpenOrders: 3,
                    maxOpenTrades: 6
                  }
                };

                rawData.buy = {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 28100
                };

                rawData.sell = {
                  currentPrice: 28000,
                  triggerPrice: null,
                  lastBuyPrice: null,
                  stopLossTriggerPrice: null
                };

                step = require('../determine-action');

                result = await step.execute(loggerMock, rawData);
              });

              it('should wait because maximum buy open orders reached', () => {
                expect(result).toMatchObject({
                  action: 'wait',
                  baseAssetBalance: {
                    total: 0.0003
                  },
                  symbolConfiguration: {
                    botOptions: {
                      orderLimit: {
                        enabled: true,
                        maxBuyOpenOrders: 3,
                        maxOpenTrades: 6
                      }
                    }
                  },
                  buy: {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 28100,
                    processMessage:
                      `The current price has reached the lowest price; however, it is restricted to buy the coin ` +
                      `because of reached maximum buy open orders.`,
                    updatedAt: expect.any(Object)
                  },
                  sell: {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  }
                });
              });
            });

            describe('when order limit is disabled', () => {
              beforeEach(async () => {
                // Set number of current buy open orders to 3
                mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(3);
                mockGetNumberOfOpenTrades = jest.fn().mockResolvedValue(6);

                mockIsActionDisabled = jest.fn().mockResolvedValue({
                  isDisabled: false
                });

                jest.mock('../../../trailingTradeHelper/common', () => ({
                  isActionDisabled: mockIsActionDisabled,
                  getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                  getAPILimit: mockGetAPILimit
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                rawData = _.cloneDeep(orgRawData);
                rawData.action = 'not-determined';
                rawData.baseAssetBalance.total = 0.0003;

                // Set maxBuyOpenOrders to 3
                rawData.symbolConfiguration.botOptions = {
                  orderLimit: {
                    enabled: false,
                    maxBuyOpenOrders: 3,
                    maxOpenTrades: 6
                  }
                };

                rawData.buy = {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 28100
                };

                rawData.sell = {
                  currentPrice: 28000,
                  triggerPrice: null,
                  lastBuyPrice: null,
                  stopLossTriggerPrice: null
                };

                step = require('../determine-action');

                result = await step.execute(loggerMock, rawData);
              });

              it('should place a buy order because max buy open orders is disabled', () => {
                expect(result).toMatchObject({
                  action: 'buy',
                  symbolConfiguration: {
                    botOptions: {
                      orderLimit: {
                        enabled: false,
                        maxBuyOpenOrders: 3,
                        maxOpenTrades: 6
                      }
                    }
                  },
                  buy: {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 28100,
                    processMessage: `The current price reached the trigger price for the grid trade #1. Let's buy it.`,
                    updatedAt: expect.any(Object)
                  },
                  sell: {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  }
                });
              });
            });
          });

          describe('isExceedingMaxOpenTrades', () => {
            const mockInit = ({
              orderLimitEnabled,
              lastBuyPrice,
              maxOpenTrades,
              numberOfOpenTrades
            }) => {
              const clonedRawData = _.cloneDeep(orgRawData);

              clonedRawData.baseAssetBalance.total = 0.0003;

              clonedRawData.symbolConfiguration.botOptions.orderLimit = {
                enabled: orderLimitEnabled,
                maxBuyOpenOrders: 4,
                maxOpenTrades
              };

              clonedRawData.symbolConfiguration.buy.athRestriction = {
                enabled: true
              };

              clonedRawData.buy = {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 28100
              };

              clonedRawData.sell = {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice,
                stopLossTriggerPrice: null
              };

              mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(3);
              mockGetNumberOfOpenTrades = jest
                .fn()
                .mockResolvedValue(numberOfOpenTrades);

              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                getAPILimit: mockGetAPILimit
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              return clonedRawData;
            };

            describe('when order limit is enabled', () => {
              describe('when the last buy price is recorded', () => {
                describe('when number of current open trade is less than maximum open trades', () => {
                  beforeEach(async () => {
                    rawData = mockInit({
                      orderLimitEnabled: true,
                      lastBuyPrice: 29000,
                      maxOpenTrades: 3,
                      numberOfOpenTrades: 2
                    });

                    step = require('../determine-action');
                    result = await step.execute(loggerMock, rawData);
                  });

                  it(
                    `should place a buy order because ` +
                      `the current open trade is less than the maximum open trades`,
                    () => {
                      expect(result).toMatchObject({
                        action: 'buy',
                        buy: {
                          athRestrictionPrice: 28100,
                          currentPrice: 28000,
                          processMessage:
                            "The current price reached the trigger price for the grid trade #1. Let's buy it.",
                          triggerPrice: 28000,
                          updatedAt: expect.any(Object)
                        }
                      });
                    }
                  );
                });

                describe('when number of open trades is same as max open trades', () => {
                  beforeEach(async () => {
                    rawData = mockInit({
                      orderLimitEnabled: true,
                      lastBuyPrice: 29000,
                      maxOpenTrades: 3,
                      numberOfOpenTrades: 3
                    });

                    step = require('../determine-action');
                    result = await step.execute(loggerMock, rawData);
                  });

                  it(
                    `should place a buy order because the last buy price is recorded, ` +
                      `which means current open trades includes this symbol order`,
                    () => {
                      expect(result).toMatchObject({
                        action: 'buy',
                        buy: {
                          athRestrictionPrice: 28100,
                          currentPrice: 28000,
                          processMessage:
                            "The current price reached the trigger price for the grid trade #1. Let's buy it.",
                          triggerPrice: 28000,
                          updatedAt: expect.any(Object)
                        }
                      });
                    }
                  );
                });

                describe('when number of open trades is already exceeded max open trades', () => {
                  beforeEach(async () => {
                    rawData = mockInit({
                      orderLimitEnabled: true,
                      lastBuyPrice: 29000,
                      maxOpenTrades: 2,
                      numberOfOpenTrades: 3
                    });

                    step = require('../determine-action');
                    result = await step.execute(loggerMock, rawData);
                  });

                  it(
                    `should not place a buy order because number of current open trades is ` +
                      `exceeded the maximum number of open trade`,
                    () => {
                      expect(result).toMatchObject({
                        action: 'wait',
                        buy: {
                          athRestrictionPrice: 28100,
                          currentPrice: 28000,
                          processMessage:
                            `The current price has reached the lowest price; ` +
                            `however, it is restricted to buy the coin because of reached maximum open trades.`,
                          triggerPrice: 28000,
                          updatedAt: expect.any(Object)
                        }
                      });
                    }
                  );
                });
              });

              describe('when the last buy price is not recorded', () => {
                describe('when number of open trades is less than max open trades', () => {
                  beforeEach(async () => {
                    rawData = mockInit({
                      orderLimitEnabled: true,
                      lastBuyPrice: null,
                      maxOpenTrades: 3,
                      numberOfOpenTrades: 2
                    });

                    step = require('../determine-action');
                    result = await step.execute(loggerMock, rawData);
                  });

                  it(
                    `should place a buy order because the nubmer of current open trade ` +
                      `is less than the maximum number of  open trade`,
                    () => {
                      expect(result).toMatchObject({
                        action: 'buy',
                        buy: {
                          athRestrictionPrice: 28100,
                          currentPrice: 28000,
                          processMessage:
                            "The current price reached the trigger price for the grid trade #1. Let's buy it.",
                          triggerPrice: 28000,
                          updatedAt: expect.any(Object)
                        }
                      });
                    }
                  );
                });

                describe('when number of open trades is same as max open trades', () => {
                  beforeEach(async () => {
                    rawData = mockInit({
                      orderLimitEnabled: true,
                      lastBuyPrice: null,
                      maxOpenTrades: 3,
                      numberOfOpenTrades: 3
                    });

                    step = require('../determine-action');
                    result = await step.execute(loggerMock, rawData);
                  });

                  it(
                    `should not place a buy order because the last buy price is not recorded, ` +
                      `which means current open trades does not include this symbol order`,
                    () => {
                      expect(result).toMatchObject({
                        action: 'wait',
                        buy: {
                          athRestrictionPrice: 28100,
                          currentPrice: 28000,
                          processMessage:
                            `The current price has reached the lowest price; ` +
                            `however, it is restricted to buy the coin because of reached maximum open trades.`,
                          triggerPrice: 28000,
                          updatedAt: expect.any(Object)
                        }
                      });
                    }
                  );
                });

                describe('when number of open trades is already exceeded max open trades', () => {
                  beforeEach(async () => {
                    rawData = mockInit({
                      orderLimitEnabled: true,
                      lastBuyPrice: null,
                      maxOpenTrades: 2,
                      numberOfOpenTrades: 3
                    });

                    step = require('../determine-action');
                    result = await step.execute(loggerMock, rawData);
                  });

                  it(
                    `should not place a buy porder because number of curent open trade is ` +
                      `exceeded the maximum number of open trade`,
                    () => {
                      expect(result).toMatchObject({
                        action: 'wait',
                        buy: {
                          athRestrictionPrice: 28100,
                          currentPrice: 28000,
                          processMessage:
                            `The current price has reached the lowest price; ` +
                            `however, it is restricted to buy the coin because of reached maximum open trades.`,
                          triggerPrice: 28000,
                          updatedAt: expect.any(Object)
                        }
                      });
                    }
                  );
                });
              });
            });

            describe('when order limit is disabled', () => {
              beforeEach(async () => {
                rawData = mockInit({
                  orderLimitEnabled: false,
                  lastBuyPrice: null,
                  maxOpenTrades: 2,
                  numberOfOpenTrades: 2
                });

                step = require('../determine-action');

                result = await step.execute(loggerMock, rawData);
              });

              it('should place a buy order because order limit is disabled', () => {
                expect(result).toMatchObject({
                  action: 'buy',
                  symbolConfiguration: {
                    botOptions: {
                      orderLimit: {
                        enabled: false,
                        maxBuyOpenOrders: 4,
                        maxOpenTrades: 2
                      }
                    }
                  },
                  buy: {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 28100,
                    processMessage: `The current price reached the trigger price for the grid trade #1. Let's buy it.`,
                    updatedAt: expect.any(Object)
                  },
                  sell: {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  }
                });
              });
            });
          });

          describe('when base asset balance does not have enough to sell', () => {
            beforeEach(async () => {
              // Set action is enabled
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              // Set buy open orders and open trades
              mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(3);
              mockGetNumberOfOpenTrades = jest.fn().mockResolvedValue(5);

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                getAPILimit: mockGetAPILimit
              }));

              // Set there is no grid trade order
              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              rawData = _.cloneDeep(orgRawData);

              // Set balance less than minimum notional value
              rawData.baseAssetBalance.total = 0.0003;

              rawData.symbolConfiguration.botOptions.orderLimit = {
                enabled: true,
                maxBuyOpenOrders: 5,
                maxOpenTrades: 10
              };

              rawData.symbolConfiguration.buy = {
                athRestriction: {
                  enabled: true
                },
                currentGridTradeIndex: 0,
                currentGridTrade: {
                  triggerPercentage: 1,
                  stopPercentage: 1.025,
                  limitPercentage: 1.026,
                  maxPurchaseAmount: 10,
                  executed: false,
                  executedOrder: null
                }
              };

              // Set ATH restriction is higher than the current price
              rawData.buy = {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 28001
              };

              rawData.sell = {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              };

              step = require('../determine-action');

              result = await step.execute(loggerMock, rawData);
            });

            it('should place a buy order after passing all conditions', () => {
              expect(result).toMatchObject({
                action: 'buy',
                baseAssetBalance: {
                  total: 0.0003
                },
                buy: {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 28001,
                  processMessage:
                    "The current price reached the trigger price for the grid trade #1. Let's buy it.",
                  updatedAt: expect.any(Object)
                },
                sell: {
                  currentPrice: 28000,
                  lastBuyPrice: null,
                  triggerPrice: null,
                  stopLossTriggerPrice: null
                }
              });
            });
          });
        }
      );

      describe('sell - when last buy price is set and has enough to sell', () => {
        describe('isHigherThanSellTriggerPrice - when current price is higher than trigger price', () => {
          beforeEach(() => {
            mockIsActionDisabled = jest.fn().mockResolvedValue({
              isDisabled: false
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              isActionDisabled: mockIsActionDisabled,
              getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
              getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
              getAPILimit: mockGetAPILimit
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            rawData = _.cloneDeep(orgRawData);

            // Set total value more than notional value
            rawData.baseAssetBalance.total = 0.0006;

            rawData.symbolConfiguration.botOptions.orderLimit = {
              enabled: true,
              maxBuyOpenOrders: 5,
              maxOpenTrades: 10
            };
            rawData.symbolConfiguration.currentGridTradeIndex = 0;

            rawData.symbolConfiguration.currentGridTrade = {
              triggerPercentage: 1.03,
              stopPercentage: 0.985,
              limitPercentage: 0.984,
              quantityPercentage: 0.8,
              executed: false,
              executedOrder: null
            };

            rawData.buy = {
              currentPrice: 31000,
              triggerPrice: 28000,
              athRestrictionPrice: 27000
            };

            rawData.sell = {
              currentPrice: 31000,
              triggerPrice: 30900,
              lastBuyPrice: 30000,
              stopLossTriggerPrice: 24000
            };
          });

          describe('getGridTradeLastOrder - when grid trade sell order is found', () => {
            beforeEach(async () => {
              mockGetGridTradeOrder = jest.fn().mockResolvedValue({
                orderId: 27123456
              });

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              step = require('../determine-action');

              result = await step.execute(loggerMock, rawData);
            });

            it('should wait for a sell order because grid trade is found', () => {
              expect(result).toMatchObject({
                action: 'sell-order-wait',
                baseAssetBalance: {
                  total: 0.0006
                },
                symbolConfiguration: {
                  botOptions: {
                    orderLimit: {
                      enabled: true,
                      maxBuyOpenOrders: 5,
                      maxOpenTrades: 10
                    }
                  },
                  sell: {
                    stopLoss: {
                      enabled: false
                    },
                    currentGridTradeIndex: 0,
                    currentGridTrade: {
                      triggerPercentage: 1.03,
                      stopPercentage: 0.985,
                      limitPercentage: 0.984,
                      quantityPercentage: 0.8,
                      executed: false,
                      executedOrder: null
                    }
                  }
                },
                buy: {
                  currentPrice: 31000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 27000
                },
                sell: {
                  currentPrice: 31000,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000,
                  processMessage: `There is a last gird trade sell order. Wait.`,
                  updatedAt: expect.any(Object)
                }
              });
            });
          });

          describe('isActionDisabled - when symbol is disabled', () => {
            beforeEach(async () => {
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: true,
                ttl: 300,
                disabledBy: 'sell order',
                message: 'Disabled action after confirming the sell order.',
                canResume: false,
                canRemoveLastBuyPrice: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                getAPILimit: mockGetAPILimit
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              step = require('../determine-action');

              result = await step.execute(loggerMock, rawData);
            });

            it('should not place a sell order because symbole is disabled', () => {
              expect(result).toMatchObject({
                action: 'sell-temporary-disabled',
                sell: {
                  currentPrice: 31000,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000,
                  processMessage:
                    `The current price is reached the sell trigger price. ` +
                    `However, the action is temporarily disabled by sell order. ` +
                    `Resume sell process after 300s.`,
                  updatedAt: expect.any(Object)
                }
              });
            });
          });

          describe('isActionDisabled - when symbol is not disabled', () => {
            beforeEach(async () => {
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                getAPILimit: mockGetAPILimit
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              step = require('../determine-action');

              result = await step.execute(loggerMock, rawData);
            });

            it('should place a sell order because symbol is not disabled', () => {
              expect(result).toMatchObject({
                action: 'sell',
                baseAssetBalance: {
                  total: 0.0006
                },
                sell: {
                  currentPrice: 31000,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000,
                  processMessage:
                    "The current price is more than the trigger price. Let's sell.",
                  updatedAt: expect.any(Object)
                }
              });
            });
          });
        });

        describe('shouldForceSellByTradingViewRecommendation', () => {
          beforeEach(() => {
            mockIsActionDisabled = jest.fn().mockResolvedValue({
              isDisabled: false
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              isActionDisabled: mockIsActionDisabled,
              getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
              getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
              getAPILimit: mockGetAPILimit
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);
            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            rawData = _.cloneDeep(orgRawData);

            // Set total value more than notional value
            rawData.baseAssetBalance.total = 0.0006;

            rawData.buy = {
              currentPrice: 31000,
              triggerPrice: 28000,
              athRestrictionPrice: 27000
            };

            rawData.sell = {
              currentProfit: 1000,
              currentPrice: 31000,
              triggerPrice: 30900,
              lastBuyPrice: 30000,
              stopLossTriggerPrice: 24000
            };
          });

          [
            {
              name: 'when tradingView recommendation option is not enabled',
              rawData: {
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: false,
                        whenStrongSell: false
                      }
                    }
                  }
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell'
            },
            {
              name: 'when tradingView time is not defined',
              rawData: {
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                tradingView: {
                  result: {
                    time: undefined,
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell'
            },
            {
              name: 'when tradingView recommendation is not defined',
              rawData: {
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: undefined
                    }
                  }
                }
              },
              expectedAction: 'sell'
            },
            {
              name: 'when tradingView data is old',
              rawData: {
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                tradingView: {
                  result: {
                    time: moment().subtract('6', 'minutes').format(),
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell'
            },
            {
              name: 'when current profit is less than 0',
              rawData: {
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: -1
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell'
            },
            {
              name: 'when current price is higher than trigger price',
              rawData: {
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 1000,
                  currentPrice: 31000,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell'
            },
            {
              name: 'when current balance is less than minimum notional - BTCUSDT',
              rawData: {
                baseAssetBalance: {
                  free: 0.000323
                },
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 960,
                  currentPrice: 30960,
                  triggerPrice: 31000,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell-wait'
            },
            {
              name: 'when current balance is less than minimum notional - ALPHABTC',
              rawData: {
                symbol: 'ALPHABTC',
                symbolInfo: {
                  baseAsset: 'ALPHA',
                  quoteAsset: 'BTC',
                  filterLotSize: {
                    stepSize: '1.00000000',
                    minQty: '1.00000000'
                  },
                  filterPrice: { tickSize: '0.00000001' },
                  filterMinNotional: { minNotional: '0.00010000' }
                },
                baseAssetBalance: {
                  free: 3,
                  total: 10
                },
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 2,
                  currentPrice: 0.00003813,
                  triggerPrice: 0.000039264,
                  lastBuyPrice: 0.00003812,
                  stopLossTriggerPrice: 0.00030496
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell-wait'
            },
            {
              name: 'when tradingView recommendation is neutral, and allowed neutral',
              rawData: {
                baseAssetBalance: {
                  free: 0.0004,
                  total: 0.0004
                },
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 100,
                  currentPrice: 30100,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    }
                  }
                }
              },
              expectedAction: 'sell-stop-loss',
              expectedProcessMessage:
                `TradingView recommendation is NEUTRAL. The current profit (100) is more than 0 and ` +
                `the current price (30100) is under trigger price (30900). Sell at market price.`
            },
            {
              name: 'when tradingView recommendation is neutral, but only allowed sell',
              rawData: {
                baseAssetBalance: {
                  free: 0.0004,
                  total: 0.0004
                },
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: true,
                        whenStrongSell: false
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 100,
                  currentPrice: 30100,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'NEUTRAL'
                    }
                  }
                }
              },
              expectedAction: 'sell-wait'
            },
            {
              name: 'when tradingView recommendation is sell, but only allowed strong_sell',
              rawData: {
                baseAssetBalance: {
                  free: 0.0004,
                  total: 0.0004
                },
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: false,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 100,
                  currentPrice: 30100,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell-wait'
            },
            {
              name: 'when tradingView recommendation is strong sell, but only allowed sell',
              rawData: {
                baseAssetBalance: {
                  free: 0.0004,
                  total: 0.0004
                },
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: false
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 100,
                  currentPrice: 30100,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'STRONG_SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell-wait'
            },
            {
              name: 'when tradingView recommendation is sell, and allowed sell',
              rawData: {
                baseAssetBalance: {
                  free: 0.0004,
                  total: 0.0004
                },
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 100,
                  currentPrice: 30100,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell-stop-loss',
              expectedProcessMessage:
                `TradingView recommendation is SELL. The current profit (100) is more than 0 and ` +
                `the current price (30100) is under trigger price (30900). Sell at market price.`
            },
            {
              name: 'when tradingView recommendation is strong sell, and allowed strong sell',
              rawData: {
                baseAssetBalance: {
                  free: 0.0004,
                  total: 0.0004
                },
                symbolConfiguration: {
                  sell: {
                    tradingView: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                },
                sell: {
                  currentProfit: 100,
                  currentPrice: 30100,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 24000
                },
                tradingView: {
                  result: {
                    time: moment().format(),
                    summary: {
                      RECOMMENDATION: 'STRONG_SELL'
                    }
                  }
                }
              },
              expectedAction: 'sell-stop-loss',
              expectedProcessMessage:
                `TradingView recommendation is STRONG_SELL. The current profit (100) is more than 0 and ` +
                `the current price (30100) is under trigger price (30900). Sell at market price.`
            }
          ].forEach(t => {
            describe(`${t.name}`, () => {
              let testRawData;
              beforeEach(async () => {
                testRawData = _.mergeWith(rawData, t.rawData);

                step = require('../determine-action');

                result = await step.execute(loggerMock, testRawData);
              });

              if (t.expectedAction === 'sell-stop-loss') {
                it('should place a stop-loss order after checking tradingView', () => {
                  expect(result).toMatchObject({
                    action: 'sell-stop-loss',
                    baseAssetBalance: testRawData.baseAssetBalance,
                    sell: {
                      ...testRawData.sell,
                      processMessage: t.expectedProcessMessage,
                      updatedAt: expect.any(Object)
                    }
                  });
                });
              } else if (t.expectedAction === 'sell') {
                it('should place an order after ignoring tradingView', () => {
                  expect(result).toMatchObject({
                    action: 'sell',
                    baseAssetBalance: testRawData.baseAssetBalance,
                    sell: {
                      ...testRawData.sell,
                      processMessage:
                        "The current price is more than the trigger price. Let's sell.",
                      updatedAt: expect.any(Object)
                    }
                  });
                });
              } else {
                it('should wait for sell orderorder after ignoring tradingView', () => {
                  expect(result).toMatchObject({
                    action: 'sell-wait',
                    baseAssetBalance: testRawData.baseAssetBalance,
                    sell: {
                      ...testRawData.sell,
                      processMessage:
                        'The current price is lower than the selling trigger price for the grid trade #1. Wait.',
                      updatedAt: expect.any(Object)
                    }
                  });
                });
              }
            });
          });
        });

        describe('isLowerThanStopLossTriggerPrice - when current price is less than stop loss trigger price', () => {
          describe('isActionDisabled - when stop loss is disabled', () => {
            beforeEach(async () => {
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                getAPILimit: mockGetAPILimit
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              rawData = _.cloneDeep(orgRawData);

              // Set base asset balance is more than minimum notional value
              rawData.baseAssetBalance.total = 0.0006;

              rawData.symbolConfiguration.botOptions.orderLimit = {
                enabled: true,
                maxBuyOpenOrders: 5,
                maxOpenTrades: 10
              };

              rawData.buy = {
                currentPrice: 29000,
                triggerPrice: 28000,
                athRestrictionPrice: 27000
              };

              rawData.sell = {
                currentPrice: 29000,
                triggerPrice: 30900,
                lastBuyPrice: 30000,
                stopLossTriggerPrice: 29500
              };

              step = require('../determine-action');

              result = await step.execute(loggerMock, rawData);
            });

            it('should wait because stop loss is disabled', () => {
              expect(result).toMatchObject({
                action: 'sell-wait',
                baseAssetBalance: {
                  total: 0.0006
                },
                buy: {
                  currentPrice: 29000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 27000
                },
                sell: {
                  currentPrice: 29000,
                  triggerPrice: 30900,
                  lastBuyPrice: 30000,
                  stopLossTriggerPrice: 29500,
                  processMessage:
                    `The current price is lower than the selling trigger price ` +
                    `for the grid trade #1. Wait.`,
                  updatedAt: expect.any(Object)
                }
              });
            });
          });

          describe('isActionDisabled - when stop loss is enabled', () => {
            beforeEach(() => {
              rawData = _.cloneDeep(orgRawData);

              rawData.baseAssetBalance.total = 0.0006;

              rawData.symbolConfiguration.botOptions.orderLimit = {
                enabled: true,
                maxBuyOpenOrders: 5,
                maxOpenTrades: 10
              };

              rawData.symbolConfiguration.sell.stopLoss = {
                enabled: true
              };

              rawData.buy = {
                currentPrice: 29000,
                triggerPrice: 28000,
                athRestrictionPrice: 27000
              };

              // Set the current price is less than stop loss price
              rawData.sell = {
                currentPrice: 29000,
                triggerPrice: 30900,
                lastBuyPrice: 30000,
                stopLossTriggerPrice: 29500
              };
            });

            describe('isActionDisabled - when symbol is disabled', () => {
              beforeEach(async () => {
                mockIsActionDisabled = jest.fn().mockResolvedValue({
                  isDisabled: true,
                  ttl: 300,
                  disabledBy: 'sell order',
                  message: 'Disabled action after confirming the sell order.',
                  canResume: false,
                  canRemoveLastBuyPrice: false
                });

                jest.mock('../../../trailingTradeHelper/common', () => ({
                  isActionDisabled: mockIsActionDisabled,
                  getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                  getAPILimit: mockGetAPILimit
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                step = require('../determine-action');

                result = await step.execute(loggerMock, rawData);
              });

              it('should not place a stop loss order because symbol is disabled.', () => {
                expect(result).toMatchObject({
                  action: 'sell-temporary-disabled',
                  baseAssetBalance: {
                    total: 0.0006
                  },
                  symbolConfiguration: {
                    botOptions: {
                      orderLimit: {
                        enabled: true,
                        maxBuyOpenOrders: 5,
                        maxOpenTrades: 10
                      }
                    },
                    sell: {
                      stopLoss: {
                        enabled: true
                      },
                      currentGridTradeIndex: 0,
                      currentGridTrade: {
                        triggerPercentage: 1.03,
                        stopPercentage: 0.985,
                        limitPercentage: 0.984,
                        quantityPercentage: 0.8,
                        executed: false,
                        executedOrder: null
                      },
                      tradingView: {
                        forceSellOverZeroBelowTriggerPrice: {
                          whenNeutral: true,
                          whenSell: false,
                          whenStrongSell: false
                        }
                      }
                    }
                  },
                  buy: {
                    currentPrice: 29000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  },
                  sell: {
                    currentPrice: 29000,
                    triggerPrice: 30900,
                    lastBuyPrice: 30000,
                    stopLossTriggerPrice: 29500,
                    processMessage:
                      `The current price is reached the stop-loss price. ` +
                      `However, the action is temporarily disabled by sell order. ` +
                      `Resume sell process after 300s.`,
                    updatedAt: expect.any(Object)
                  }
                });
              });
            });

            describe('isActionDisabled - when symbol is not disabled', () => {
              beforeEach(async () => {
                mockIsActionDisabled = jest.fn().mockResolvedValue({
                  isDisabled: false
                });

                jest.mock('../../../trailingTradeHelper/common', () => ({
                  isActionDisabled: mockIsActionDisabled,
                  getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
                  getAPILimit: mockGetAPILimit
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                step = require('../determine-action');

                result = await step.execute(loggerMock, rawData);
              });

              it('should place a stop loss order because the current price is less than the stop loss price', () => {
                expect(result).toMatchObject({
                  action: 'sell-stop-loss',
                  baseAssetBalance: {
                    total: 0.0006
                  },
                  symbolConfiguration: {
                    botOptions: {
                      orderLimit: {
                        enabled: true,
                        maxBuyOpenOrders: 5,
                        maxOpenTrades: 10
                      }
                    },
                    sell: {
                      stopLoss: {
                        enabled: true
                      },
                      currentGridTradeIndex: 0,
                      currentGridTrade: {
                        triggerPercentage: 1.03,
                        stopPercentage: 0.985,
                        limitPercentage: 0.984,
                        quantityPercentage: 0.8,
                        executed: false,
                        executedOrder: null
                      }
                    }
                  },
                  buy: {
                    currentPrice: 29000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  },
                  sell: {
                    currentPrice: 29000,
                    triggerPrice: 30900,
                    lastBuyPrice: 30000,
                    stopLossTriggerPrice: 29500,
                    processMessage: `The current price is reached the stop-loss price. Place market sell order.`,
                    updatedAt: expect.any(Object)
                  }
                });
              });
            });
          });
        });

        describe('when current price is less than trigger price', () => {
          beforeEach(async () => {
            mockIsActionDisabled = jest.fn().mockResolvedValue({
              isDisabled: false
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              isActionDisabled: mockIsActionDisabled,
              getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
              getNumberOfOpenTrades: mockGetNumberOfOpenTrades,
              getAPILimit: mockGetAPILimit
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            rawData = _.cloneDeep(orgRawData);

            rawData.baseAssetBalance.total = 0.0006;

            rawData.symbolConfiguration.botOptions.orderLimit = {
              enabled: true,
              maxBuyOpenOrders: 5,
              maxOpenTrades: 10
            };

            rawData.symbolConfiguration.sell.stopLoss = {
              enabled: true
            };

            rawData.buy = {
              currentPrice: 27000,
              triggerPrice: 26000,
              athRestrictionPrice: 25000
            };

            rawData.sell = {
              currentPrice: 27000,
              triggerPrice: 28840,
              lastBuyPrice: 28000,
              stopLossTriggerPrice: 22400
            };

            step = require('../determine-action');

            result = await step.execute(loggerMock, rawData);
          });

          it('should wait for sell', () => {
            expect(result).toMatchObject({
              action: 'sell-wait',
              baseAssetBalance: {
                total: 0.0006
              },
              symbolConfiguration: {
                botOptions: {
                  orderLimit: {
                    enabled: true,
                    maxBuyOpenOrders: 5,
                    maxOpenTrades: 10
                  }
                },
                sell: {
                  stopLoss: {
                    enabled: true
                  },
                  currentGridTradeIndex: 0,
                  currentGridTrade: {
                    triggerPercentage: 1.03,
                    stopPercentage: 0.985,
                    limitPercentage: 0.984,
                    quantityPercentage: 0.8,
                    executed: false,
                    executedOrder: null
                  }
                }
              },
              buy: {
                currentPrice: 27000,
                triggerPrice: 26000,
                athRestrictionPrice: 25000
              },
              sell: {
                currentPrice: 27000,
                triggerPrice: 28840,
                lastBuyPrice: 28000,
                stopLossTriggerPrice: 22400,
                processMessage:
                  'The current price is lower than the selling trigger price for the grid trade #1. Wait.',
                updatedAt: expect.any(Object)
              }
            });
          });
        });
      });

      describe('when no condition is met', () => {
        beforeEach(async () => {
          mockIsActionDisabled = jest.fn().mockResolvedValue({
            isDisabled: false
          });

          jest.mock('../../../trailingTradeHelper/common', () => ({
            isActionDisabled: mockIsActionDisabled
          }));

          mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

          jest.mock('../../../trailingTradeHelper/order', () => ({
            getGridTradeOrder: mockGetGridTradeOrder
          }));

          rawData = _.cloneDeep(orgRawData);

          rawData.baseAssetBalance.total = 0.0006;

          rawData.symbolConfiguration.buy.athRestriction = {
            enabled: true
          };

          rawData.symbolConfiguration.sell.stopLoss = {
            enabled: true
          };

          rawData.buy = {
            currentPrice: 27000,
            triggerPrice: 26000,
            athRestrictionPrice: 25000
          };

          rawData.sell = {
            currentPrice: 27000,
            triggerPrice: null,
            lastBuyPrice: null,
            stopLossTriggerPrice: null
          };

          step = require('../determine-action');

          result = await step.execute(loggerMock, rawData);
        });

        it('returns expected result', () => {
          expect(result).toMatchObject({
            action: 'not-determined',
            baseAssetBalance: {
              total: 0.0006
            },
            symbolConfiguration: {
              buy: {
                athRestriction: {
                  enabled: true
                }
              },
              sell: {
                stopLoss: {
                  enabled: true
                }
              }
            },
            buy: {
              currentPrice: 27000,
              triggerPrice: 26000,
              athRestrictionPrice: 25000
            },
            sell: {
              currentPrice: 27000,
              triggerPrice: null,
              lastBuyPrice: null,
              stopLossTriggerPrice: null
            }
          });
        });
      });
    });
  });
});
