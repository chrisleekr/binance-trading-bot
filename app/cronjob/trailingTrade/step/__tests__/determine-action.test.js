const { cache, logger } = require('../../../../helpers');

const step = require('../determine-action');

describe('determine-action.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
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
            cache.get = jest.fn().mockImplementation(_key => null);

            cache.getWithTTL = jest.fn().mockResolvedValue([
              [null, -2],
              [null, null]
            ]);

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
            cache.get = jest.fn().mockImplementation(key => {
              if (key === `BTCUSDT-grid-trade-last-buy-order`) {
                return JSON.stringify({
                  orderId: 27123456
                });
              }

              return null;
            });

            cache.getWithTTL = jest.fn().mockResolvedValue([
              [null, -2],
              [null, null]
            ]);

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
            cache.get = jest.fn().mockImplementation(_key => null);
            cache.getWithTTL = jest.fn().mockResolvedValue([
              [null, 300],
              [
                null,
                JSON.stringify({
                  disabledBy: 'buy order',
                  message: 'Disabled action after confirming the buy order.',
                  canResume: false,
                  canRemoveLastBuyPrice: false
                })
              ]
            ]);

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

        describe('when the trigger price is higher than the ATH restriction price', () => {
          beforeEach(() => {
            cache.get = jest.fn().mockImplementation(_key => null);
          });

          describe('when the ATH restriction is enabled', () => {
            describe('currentGridTradeIndex is 0', () => {
              beforeEach(async () => {
                cache.getWithTTL = jest.fn().mockResolvedValue([
                  [null, -2],
                  [null, null]
                ]);

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
                    athRestrictionPrice: 27000
                  },
                  sell: {
                    currentPrice: 28000,
                    triggerPrice: null,
                    lastBuyPrice: null,
                    stopLossTriggerPrice: null
                  }
                };

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
                cache.getWithTTL = jest.fn().mockResolvedValue([
                  [null, -2],
                  [null, null]
                ]);

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
                cache.getWithTTL = jest.fn().mockResolvedValue([
                  [null, -2],
                  [null, null]
                ]);

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
                cache.getWithTTL = jest.fn().mockResolvedValue([
                  [null, -2],
                  [null, null]
                ]);

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
            cache.get = jest.fn().mockImplementation(_key => null);

            cache.getWithTTL = jest.fn().mockResolvedValue([
              [null, -2],
              [null, null]
            ]);

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
                athRestrictionPrice: 28001
              },
              sell: {
                currentPrice: 28000,
                triggerPrice: null,
                lastBuyPrice: null,
                stopLossTriggerPrice: null
              }
            };

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
            cache.get = jest.fn().mockImplementation(_key => null);

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
              cache.get = jest.fn().mockImplementation(key => {
                if (key === `BTCUSDT-grid-trade-last-sell-order`) {
                  return JSON.stringify({
                    orderId: 27123456
                  });
                }

                return null;
              });

              cache.getWithTTL = jest.fn().mockResolvedValue([
                [null, -2],
                [null, null]
              ]);

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
              cache.getWithTTL = jest.fn().mockResolvedValue([
                [null, 300],
                [
                  null,
                  JSON.stringify({
                    disabledBy: 'sell order',
                    message: 'Disabled action after confirming the sell order.',
                    canResume: false,
                    canRemoveLastBuyPrice: false
                  })
                ]
              ]);

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
              cache.getWithTTL = jest.fn().mockResolvedValue([
                [null, -2],
                [null, null]
              ]);

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
          beforeEach(() => {
            cache.get = jest.fn().mockImplementation(_key => null);
          });

          describe('when stop loss is disabled', () => {
            beforeEach(async () => {
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
                cache.getWithTTL = jest.fn().mockResolvedValue([
                  [null, 300],
                  [
                    null,
                    JSON.stringify({
                      disabledBy: 'sell order',
                      message:
                        'Disabled action after confirming the sell order.',
                      canResume: false,
                      canRemoveLastBuyPrice: false
                    })
                  ]
                ]);

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
                cache.getWithTTL = jest.fn().mockResolvedValue([
                  [null, -2],
                  [null, null]
                ]);

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
            cache.get = jest.fn().mockImplementation(_key => null);

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
                triggerPrice: 28840,
                lastBuyPrice: 28000,
                stopLossTriggerPrice: 22400
              }
            };

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
