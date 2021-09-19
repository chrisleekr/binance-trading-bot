/* eslint-disable global-require */
const { cache, logger } = require('../../../../helpers');

describe('determine-action.js', () => {
  let result;
  let rawData;
  let step;

  let mockIsActionDisabled;
  let mockGetNumberOfBuyOpenOrders;
  let mockGetNumberOfOpenTrades;
  let mockGetGridTradeOrder;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        cache.get = jest.fn().mockImplementation(_key => null);

        rawData = {
          action: 'not-determined',
          symbol: 'BTCUSDT',
          isLocked: true,
          symbolInfo: {
            baseAsset: 'BTC',
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          baseAssetBalance: {
            total: 0.000312
          },
          symbolConfiguration: {
            buy: {
              athRestriction: {
                enabled: true
              },
              currentGridTradeIndex: 1,
              currentGridTrade: {
                triggerPercentage: 0.9,
                stopPercentage: 1.025,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                executed: false,
                executedOrder: null
              }
            },
            sell: {
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
            currentPrice: 31786.08,
            triggerPrice: 28924.92,
            athRestrictionPrice: 29572.2
          },
          sell: {
            currentPrice: 31786.08,
            triggerPrice: 33102.964,
            lastBuyPrice: 32138.799999999996,
            stopLossTriggerPrice: 25711.039999999997
          }
        };

        step = require('../determine-action');

        result = await step.execute(logger, rawData);
      });

      it('returns same data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is buy-order-wait', () => {
      beforeEach(async () => {
        cache.get = jest.fn().mockImplementation(_key => null);

        rawData = {
          action: 'buy-order-wait',
          symbol: 'BTCUSDT',
          isLocked: false,
          symbolInfo: {
            baseAsset: 'BTC',
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          baseAssetBalance: {
            total: 0.000312
          },
          symbolConfiguration: {
            buy: {
              athRestriction: {
                enabled: true
              },
              currentGridTradeIndex: 1,
              currentGridTrade: {
                triggerPercentage: 0.9,
                stopPercentage: 1.025,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                executed: false,
                executedOrder: null
              }
            },
            sell: {
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
            currentPrice: 31786.08,
            triggerPrice: 28924.92,
            athRestrictionPrice: 29572.2
          },
          sell: {
            currentPrice: 31786.08,
            triggerPrice: 33102.964,
            lastBuyPrice: 32138.799999999996,
            stopLossTriggerPrice: 25711.039999999997
          }
        };

        step = require('../determine-action');

        result = await step.execute(logger, rawData);
      });

      it('returns same data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is buy', () => {
      beforeEach(async () => {
        cache.get = jest.fn().mockImplementation(_key => null);

        rawData = {
          action: 'buy',
          symbol: 'BTCUSDT',
          isLocked: false,
          symbolInfo: {
            baseAsset: 'BTC',
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          baseAssetBalance: {
            total: 0.000312
          },
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
                triggerPercentage: 0.9,
                stopPercentage: 1.025,
                limitPercentage: 1.026,
                maxPurchaseAmount: 10,
                executed: false,
                executedOrder: null
              }
            },
            sell: {
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
            currentPrice: 31786.08,
            triggerPrice: 28924.92,
            athRestrictionPrice: 29572.2
          },
          sell: {
            currentPrice: 31786.08,
            triggerPrice: 33102.964,
            lastBuyPrice: 32138.799999999996,
            stopLossTriggerPrice: 25711.039999999997
          }
        };

        step = require('../determine-action');

        result = await step.execute(logger, rawData);
      });

      it('returns same data', () => {
        expect(result).toStrictEqual(rawData);
      });
    });

    describe('when action is not-determined', () => {
      describe('when last buy price is not configured and current price is less or equal than trigger price', () => {
        describe('when base asset balance has enough to sell', () => {
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

            rawData = {
              action: 'not-determined',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: {
                total: 0.0005
              },
              symbolConfiguration: {
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
                  }
                }
              },
              buy: {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 29572.2
              },
              sell: {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              }
            };

            step = require('../determine-action');

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'wait',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: {
                total: 0.0005
              },
              symbolConfiguration: {
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
                  }
                }
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

        describe('when grid trade buy order is found', () => {
          beforeEach(async () => {
            mockIsActionDisabled = jest.fn().mockResolvedValue({
              isDisabled: false
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              isActionDisabled: mockIsActionDisabled
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue({
              orderId: 27123456
            });

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            rawData = {
              action: 'not-determined',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: {
                total: 0.0003
              },
              symbolConfiguration: {
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
                  }
                }
              },
              buy: {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 29572.2
              },
              sell: {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              }
            };

            step = require('../determine-action');

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'buy-order-wait',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: {
                total: 0.0003
              },
              symbolConfiguration: {
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
                  }
                }
              },
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

            rawData = {
              action: 'not-determined',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: {
                total: 0.0003
              },
              symbolConfiguration: {
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
                  }
                }
              },
              buy: {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 29572.2
              },
              sell: {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              }
            };

            step = require('../determine-action');

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'buy-temporary-disabled',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: {
                total: 0.0003
              },
              symbolConfiguration: {
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
                  }
                }
              },
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

        describe('when number of current buy open orders more than maximum buy open orders', () => {
          describe('when order limit is enabled', () => {
            beforeEach(async () => {
              cache.get = jest.fn().mockImplementation(_key => null);

              mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(3);
              mockGetNumberOfOpenTrades = jest.fn().mockResolvedValue(6);

              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              rawData = {
                action: 'not-determined',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
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
                    }
                  }
                },
                buy: {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 28100
                },
                sell: {
                  currentPrice: 28000,
                  triggerPrice: null,
                  lastBuyPrice: null,
                  stopLossTriggerPrice: null
                }
              };

              step = require('../determine-action');

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'wait',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
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
              cache.get = jest.fn().mockImplementation(_key => null);

              mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(3);
              mockGetNumberOfOpenTrades = jest.fn().mockResolvedValue(6);

              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              rawData = {
                action: 'not-determined',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: {
                  total: 0.0003
                },
                symbolConfiguration: {
                  botOptions: {
                    orderLimit: {
                      enabled: false,
                      maxBuyOpenOrders: 3,
                      maxOpenTrades: 6
                    }
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
                    }
                  }
                },
                buy: {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 28100
                },
                sell: {
                  currentPrice: 28000,
                  triggerPrice: null,
                  lastBuyPrice: null,
                  stopLossTriggerPrice: null
                }
              };

              step = require('../determine-action');

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'buy',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: {
                  total: 0.0003
                },
                symbolConfiguration: {
                  botOptions: {
                    orderLimit: {
                      enabled: false,
                      maxBuyOpenOrders: 3,
                      maxOpenTrades: 6
                    }
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

        describe('when number of current buy open orders more than maximum open trades', () => {
          const mockInit = ({
            lastBuyPrice,
            maxOpenTrades,
            numberOfOpenTrades
          }) => {
            rawData = {
              action: 'not-determined',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: {
                total: 0.0003
              },
              symbolConfiguration: {
                botOptions: {
                  orderLimit: {
                    enabled: true,
                    maxBuyOpenOrders: 4,
                    maxOpenTrades
                  }
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
                  }
                }
              },
              buy: {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 28100
              },
              sell: {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice,
                stopLossTriggerPrice: null
              }
            };

            cache.get = jest.fn().mockImplementation(_key => null);

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
              getNumberOfOpenTrades: mockGetNumberOfOpenTrades
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            step = require('../determine-action');
            return step;
          };

          describe('when order limit is enabled', () => {
            describe('when the last buy price is recorded', () => {
              describe('when number of open trade is less than max open trades', () => {
                beforeEach(async () => {
                  step = mockInit({
                    lastBuyPrice: 29000,
                    maxOpenTrades: 3,
                    numberOfOpenTrades: 2
                  });
                  result = await step.execute(logger, rawData);
                });

                it('returns expected result', () => {
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
                });
              });

              describe('when number of open trades is same as max open trades', () => {
                beforeEach(async () => {
                  step = mockInit({
                    lastBuyPrice: 29000,
                    maxOpenTrades: 3,
                    numberOfOpenTrades: 3
                  });
                  result = await step.execute(logger, rawData);
                });

                it('returns expected result', () => {
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
                });
              });

              describe('when number of open trades is already exceeded max open trades', () => {
                beforeEach(async () => {
                  step = mockInit({
                    lastBuyPrice: 29000,
                    maxOpenTrades: 2,
                    numberOfOpenTrades: 3
                  });
                  result = await step.execute(logger, rawData);
                });

                it('returns expected result', () => {
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
                });
              });
            });

            describe('when the last buy price is not recorded', () => {
              describe('when number of open trades is less than max open trades', () => {
                beforeEach(async () => {
                  step = mockInit({
                    lastBuyPrice: null,
                    maxOpenTrades: 3,
                    numberOfOpenTrades: 2
                  });
                  result = await step.execute(logger, rawData);
                });

                it('returns expected result', () => {
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
                });
              });

              describe('when number of open trades is same as max open trades', () => {
                beforeEach(async () => {
                  step = mockInit({
                    lastBuyPrice: null,
                    maxOpenTrades: 3,
                    numberOfOpenTrades: 3
                  });
                  result = await step.execute(logger, rawData);
                });

                it('returns expected result', () => {
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
                });
              });

              describe('when number of open trades is already exceeded max open trades', () => {
                beforeEach(async () => {
                  step = mockInit({
                    lastBuyPrice: null,
                    maxOpenTrades: 2,
                    numberOfOpenTrades: 3
                  });
                  result = await step.execute(logger, rawData);
                });

                it('returns expected result', () => {
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
                });
              });
            });
          });

          describe('when order limit is disabled', () => {
            beforeEach(async () => {
              cache.get = jest.fn().mockImplementation(_key => null);

              mockGetNumberOfBuyOpenOrders = jest.fn().mockResolvedValue(3);
              mockGetNumberOfOpenTrades = jest.fn().mockResolvedValue(6);

              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              rawData = {
                action: 'not-determined',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: {
                  total: 0.0003
                },
                symbolConfiguration: {
                  botOptions: {
                    orderLimit: {
                      enabled: false,
                      maxBuyOpenOrders: 4,
                      maxOpenTrades: 6
                    }
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
                    }
                  }
                },
                buy: {
                  currentPrice: 28000,
                  triggerPrice: 28000,
                  athRestrictionPrice: 28100
                },
                sell: {
                  currentPrice: 28000,
                  triggerPrice: null,
                  lastBuyPrice: null,
                  stopLossTriggerPrice: null
                }
              };

              step = require('../determine-action');

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'buy',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: {
                  total: 0.0003
                },
                symbolConfiguration: {
                  botOptions: {
                    orderLimit: {
                      enabled: false,
                      maxBuyOpenOrders: 4,
                      maxOpenTrades: 6
                    }
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

        describe('when the trigger price is higher than the ATH restriction price', () => {
          beforeEach(() => {
            cache.get = jest.fn().mockImplementation(_key => null);

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
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                rawData = {
                  action: 'not-determined',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
                      }
                    }
                  },
                  buy: {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  },
                  sell: {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  }
                };

                step = require('../determine-action');

                result = await step.execute(logger, rawData);
              });

              it('returns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'wait',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
                      }
                    }
                  },
                  buy: {
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000,
                    processMessage:
                      'The current price has reached the lowest price; however, it is restricted to buy the coin.',
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
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                rawData = {
                  action: 'not-determined',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  },
                  sell: {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  }
                };

                step = require('../determine-action');

                result = await step.execute(logger, rawData);
              });

              it('returns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'buy',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
              });
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
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                rawData = {
                  action: 'not-determined',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
                    },
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
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  },
                  sell: {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  }
                };

                step = require('../determine-action');

                result = await step.execute(logger, rawData);
              });

              it('returns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'buy',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
                    },
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
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                rawData = {
                  action: 'not-determined',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
                    },
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
                    currentPrice: 28000,
                    triggerPrice: 28000,
                    athRestrictionPrice: 27000
                  },
                  sell: {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  }
                };

                step = require('../determine-action');

                result = await step.execute(logger, rawData);
              });

              it('returns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'buy',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
                    },
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
              });
            });
          });
        });

        describe('when base asset balance does not have enough to sell', () => {
          beforeEach(async () => {
            mockIsActionDisabled = jest.fn().mockResolvedValue({
              isDisabled: false
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              isActionDisabled: mockIsActionDisabled,
              getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
              getNumberOfOpenTrades: mockGetNumberOfOpenTrades
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            rawData = {
              action: 'not-determined',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
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
                  }
                }
              },
              buy: {
                currentPrice: 28000,
                triggerPrice: 28000,
                athRestrictionPrice: 28001
              },
              sell: {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              }
            };

            step = require('../determine-action');

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'buy',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
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
                  }
                }
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
      });

      describe('when last buy price is set and has enough to sell', () => {
        describe('when current price is higher than trigger price', () => {
          beforeEach(() => {
            mockIsActionDisabled = jest.fn().mockResolvedValue({
              isDisabled: false
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              isActionDisabled: mockIsActionDisabled,
              getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
              getNumberOfOpenTrades: mockGetNumberOfOpenTrades
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            rawData = {
              action: 'not-determined',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
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
                stopLossTriggerPrice: 24000
              }
            };
          });

          describe('when grid trade sell order is found', () => {
            beforeEach(async () => {
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue({
                orderId: 27123456
              });

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              step = require('../determine-action');

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'sell-order-wait',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
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

          describe('when symbol is disabled', () => {
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
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              step = require('../determine-action');

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'sell-temporary-disabled',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
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
                  processMessage:
                    `The current price is reached the sell trigger price. ` +
                    `However, the action is temporarily disabled by sell order. ` +
                    `Resume sell process after 300s.`,
                  updatedAt: expect.any(Object)
                }
              });
            });
          });

          describe('when symbol is not disabled', () => {
            beforeEach(async () => {
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              step = require('../determine-action');

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'sell',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
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
                  processMessage:
                    "The current price is more than the trigger price. Let's sell.",
                  updatedAt: expect.any(Object)
                }
              });
            });
          });
        });

        describe('when current price is less than stop loss trigger price', () => {
          describe('when stop loss is disabled', () => {
            beforeEach(async () => {
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                isActionDisabled: mockIsActionDisabled,
                getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                getNumberOfOpenTrades: mockGetNumberOfOpenTrades
              }));

              mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

              jest.mock('../../../trailingTradeHelper/order', () => ({
                getGridTradeOrder: mockGetGridTradeOrder
              }));

              rawData = {
                action: 'not-determined',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
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
                  stopLossTriggerPrice: 29500
                }
              };

              step = require('../determine-action');

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'sell-wait',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
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
                    `The current price is lower than the selling trigger price ` +
                    `for the grid trade #1. Wait.`,
                  updatedAt: expect.any(Object)
                }
              });
            });
          });

          describe('when stop loss is enabled', () => {
            beforeEach(() => {
              rawData = {
                action: 'not-determined',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolInfo: {
                  baseAsset: 'BTC',
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
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
                  stopLossTriggerPrice: 29500
                }
              };
            });

            describe('when symbol is disabled', () => {
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
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                step = require('../determine-action');

                result = await step.execute(logger, rawData);
              });

              it('returns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'sell-temporary-disabled',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
                    processMessage:
                      `The current price is reached the stop-loss price. ` +
                      `However, the action is temporarily disabled by sell order. ` +
                      `Resume sell process after 300s.`,
                    updatedAt: expect.any(Object)
                  }
                });
              });
            });

            describe('when symbol is not disabled', () => {
              beforeEach(async () => {
                mockIsActionDisabled = jest.fn().mockResolvedValue({
                  isDisabled: false
                });

                jest.mock('../../../trailingTradeHelper/common', () => ({
                  isActionDisabled: mockIsActionDisabled,
                  getNumberOfBuyOpenOrders: mockGetNumberOfBuyOpenOrders,
                  getNumberOfOpenTrades: mockGetNumberOfOpenTrades
                }));

                mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

                jest.mock('../../../trailingTradeHelper/order', () => ({
                  getGridTradeOrder: mockGetGridTradeOrder
                }));

                step = require('../determine-action');

                result = await step.execute(logger, rawData);
              });

              it('returns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'sell-stop-loss',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolInfo: {
                    baseAsset: 'BTC',
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
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
              getNumberOfOpenTrades: mockGetNumberOfOpenTrades
            }));

            mockGetGridTradeOrder = jest.fn().mockResolvedValue(null);

            jest.mock('../../../trailingTradeHelper/order', () => ({
              getGridTradeOrder: mockGetGridTradeOrder
            }));

            rawData = {
              action: 'not-determined',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
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
                stopLossTriggerPrice: 22400
              }
            };

            step = require('../determine-action');

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'sell-wait',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
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

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolInfo: {
              baseAsset: 'BTC',
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            baseAssetBalance: {
              total: 0.0006
            },
            symbolConfiguration: {
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
              triggerPrice: null,
              lastBuyPrice: null,
              stopLossTriggerPrice: null
            }
          };

          step = require('../determine-action');

          result = await step.execute(logger, rawData);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolInfo: {
              baseAsset: 'BTC',
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            baseAssetBalance: {
              total: 0.0006
            },
            symbolConfiguration: {
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
