const { cache, logger } = require('../../../../helpers');

const step = require('../determine-action');

describe('determine-action.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    describe('when symbol is locked', () => {
      beforeEach(async () => {
        rawData = {
          action: 'not-determined',
          isLocked: true,
          symbolInfo: {
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          baseAssetBalance: { total: '1.4500000' },
          symbolConfiguration: {
            buy: {
              athRestriction: {
                enabled: true
              }
            }
          },
          buy: {
            currentPrice: 184.099,
            triggerPrice: 172.375,
            athRestrictionPrice: 180.0
          },
          sell: {
            currentPrice: 184.099,
            lastBuyPrice: null,
            triggerPrice: null
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
        rawData = {
          action: 'buy-order-wait',
          isLocked: false,
          symbolInfo: {
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          baseAssetBalance: { total: '1.4500000' },
          symbolConfiguration: {
            buy: {
              athRestriction: {
                enabled: true
              }
            }
          },
          buy: {
            currentPrice: 184.099,
            triggerPrice: 172.375,
            athRestrictionPrice: 180.0
          },
          sell: {
            currentPrice: 184.099,
            lastBuyPrice: null,
            triggerPrice: null
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
        rawData = {
          action: 'buy',
          isLocked: false,
          symbolInfo: {
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          baseAssetBalance: { total: '1.4500000' },
          symbolConfiguration: {
            buy: {
              athRestriction: {
                enabled: true
              }
            }
          },
          buy: {
            currentPrice: 184.099,
            triggerPrice: 172.375,
            athRestrictionPrice: 180.0
          },
          sell: {
            currentPrice: 184.099,
            lastBuyPrice: null,
            triggerPrice: null
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
            cache.getWithTTL = jest.fn().mockResolvedValue([
              [null, -2],
              [null, null]
            ]);

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '1.0500000' },
              symbolConfiguration: {
                buy: {
                  athRestriction: {
                    enabled: true
                  }
                }
              },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375,
                athRestrictionPrice: 180.0
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: null,
                triggerPrice: null
              }
            };

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'wait',
              isLocked: false,
              symbolInfo: {
                baseAsset: 'BTC',
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '1.0500000' },
              symbolConfiguration: {
                buy: {
                  athRestriction: {
                    enabled: true
                  }
                }
              },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375,
                athRestrictionPrice: 180.0,
                processMessage:
                  `The current price reached the trigger price. ` +
                  `But you have enough BTC to sell. ` +
                  `Set the last buy price to start selling. ` +
                  `Do not process buy.`,
                updatedAt: expect.any(Object)
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: null,
                triggerPrice: null
              }
            });
          });
        });

        describe('when the symbol is disabled', () => {
          beforeEach(async () => {
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
              isLocked: false,
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '0.0500000' },
              symbolConfiguration: {
                buy: {
                  athRestriction: {
                    enabled: true
                  }
                }
              },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375,
                athRestrictionPrice: 180.0
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: null,
                triggerPrice: null
              }
            };

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'buy-temporary-disabled',
              isLocked: false,
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '0.0500000' },
              symbolConfiguration: {
                buy: {
                  athRestriction: {
                    enabled: true
                  }
                }
              },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375,
                athRestrictionPrice: 180.0,
                processMessage:
                  `The current price reached the trigger price. ` +
                  `However, the action is temporarily disabled by buy order. ` +
                  `Resume buy process after 300s.`,
                updatedAt: expect.any(Object)
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: null,
                triggerPrice: null
              }
            });
          });
        });

        describe('when the trigger price is higher than the ATH restriction price', () => {
          describe('when the ATH restriction is enabled', () => {
            beforeEach(async () => {
              cache.getWithTTL = jest.fn().mockResolvedValue([
                [null, -2],
                [null, null]
              ]);

              rawData = {
                action: 'not-determined',
                isLocked: false,
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '0.0500000' },
                symbolConfiguration: {
                  buy: {
                    athRestriction: {
                      enabled: true
                    }
                  }
                },
                buy: {
                  currentPrice: 184.099,
                  triggerPrice: 185.375,
                  athRestrictionPrice: 180.0
                },
                sell: {
                  currentPrice: 184.099,
                  lastBuyPrice: null,
                  triggerPrice: null
                }
              };

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'wait',
                isLocked: false,
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '0.0500000' },
                symbolConfiguration: {
                  buy: {
                    athRestriction: {
                      enabled: true
                    }
                  }
                },
                buy: {
                  currentPrice: 184.099,
                  triggerPrice: 185.375,
                  athRestrictionPrice: 180.0,
                  processMessage:
                    'The current price has reached the lowest price; however, it is restricted to buy the coin.',
                  updatedAt: expect.any(Object)
                },
                sell: {
                  currentPrice: 184.099,
                  lastBuyPrice: null,
                  triggerPrice: null
                }
              });
            });
          });

          describe('when the ATH restriction is disabled', () => {
            beforeEach(async () => {
              cache.getWithTTL = jest.fn().mockResolvedValue([
                [null, -2],
                [null, null]
              ]);

              rawData = {
                action: 'not-determined',
                isLocked: false,
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '0.0500000' },
                symbolConfiguration: {
                  buy: {
                    athRestriction: {
                      enabled: false
                    }
                  }
                },
                buy: {
                  currentPrice: 184.099,
                  triggerPrice: 185.375,
                  athRestrictionPrice: 180.0
                },
                sell: {
                  currentPrice: 184.099,
                  lastBuyPrice: null,
                  triggerPrice: null
                }
              };

              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'buy',
                isLocked: false,
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '0.0500000' },
                symbolConfiguration: {
                  buy: {
                    athRestriction: {
                      enabled: false
                    }
                  }
                },
                buy: {
                  currentPrice: 184.099,
                  triggerPrice: 185.375,
                  athRestrictionPrice: 180.0,
                  processMessage:
                    "The current price reached the trigger price. Let's buy it.",
                  updatedAt: expect.any(Object)
                },
                sell: {
                  currentPrice: 184.099,
                  lastBuyPrice: null,
                  triggerPrice: null
                }
              });
            });
          });
        });

        describe('when base asset balance does not have enough to sell', () => {
          beforeEach(async () => {
            cache.getWithTTL = jest.fn().mockResolvedValue([
              [null, -2],
              [null, null]
            ]);

            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '0.0500000' },
              symbolConfiguration: {
                buy: {
                  athRestriction: {
                    enabled: true
                  }
                }
              },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375,
                athRestrictionPrice: 190.0
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: null,
                triggerPrice: null
              }
            };

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'buy',
              isLocked: false,
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '0.0500000' },
              symbolConfiguration: {
                buy: {
                  athRestriction: {
                    enabled: true
                  }
                }
              },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375,
                athRestrictionPrice: 190.0,
                processMessage:
                  "The current price reached the trigger price. Let's buy it.",
                updatedAt: expect.any(Object)
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: null,
                triggerPrice: null
              }
            });
          });
        });
      });

      describe('when last buy price is set and has enough to sell', () => {
        describe('when current price is higher than trigger price', () => {
          beforeEach(() => {
            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '1.0500000' },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: 175.0,
                triggerPrice: 183.75
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
                isLocked: false,
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '1.0500000' },
                buy: {
                  currentPrice: 184.099,
                  triggerPrice: 185.375
                },
                sell: {
                  currentPrice: 184.099,
                  lastBuyPrice: 175.0,
                  triggerPrice: 183.75,
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
                isLocked: false,
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '1.0500000' },
                buy: {
                  currentPrice: 184.099,
                  triggerPrice: 185.375
                },
                sell: {
                  currentPrice: 184.099,
                  lastBuyPrice: 175.0,
                  triggerPrice: 183.75,
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
              rawData = {
                action: 'not-determined',
                isLocked: false,
                symbolConfiguration: {
                  sell: {
                    stopLoss: { enabled: false }
                  }
                },
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '1.0500000' },
                buy: {
                  currentPrice: 160.099,
                  triggerPrice: 185.375
                },
                sell: {
                  currentPrice: 160.099,
                  lastBuyPrice: 175.0,
                  triggerPrice: 170.75,
                  stopLossTriggerPrice: 165
                }
              };
              result = await step.execute(logger, rawData);
            });

            it('returns expected result', () => {
              expect(result).toStrictEqual({
                action: 'sell-wait',
                isLocked: false,
                symbolConfiguration: {
                  sell: {
                    stopLoss: { enabled: false }
                  }
                },
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '1.0500000' },
                buy: {
                  currentPrice: 160.099,
                  triggerPrice: 185.375
                },
                sell: {
                  currentPrice: 160.099,
                  lastBuyPrice: 175.0,
                  triggerPrice: 170.75,
                  stopLossTriggerPrice: 165,
                  processMessage: `The current price is lower than the selling trigger price. Wait.`,
                  updatedAt: expect.any(Object)
                }
              });
            });
          });

          describe('when stop loss is enabled', () => {
            beforeEach(() => {
              rawData = {
                action: 'not-determined',
                isLocked: false,
                symbolConfiguration: {
                  sell: {
                    stopLoss: { enabled: true }
                  }
                },
                symbolInfo: {
                  filterMinNotional: {
                    minNotional: '10.00000000'
                  }
                },
                baseAssetBalance: { total: '1.0500000' },
                buy: {
                  currentPrice: 160.099,
                  triggerPrice: 185.375
                },
                sell: {
                  currentPrice: 160.099,
                  lastBuyPrice: 175.0,
                  triggerPrice: 170.75,
                  stopLossTriggerPrice: 165
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
                  isLocked: false,
                  symbolConfiguration: {
                    sell: {
                      stopLoss: { enabled: true }
                    }
                  },
                  symbolInfo: {
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
                  baseAssetBalance: { total: '1.0500000' },
                  buy: {
                    currentPrice: 160.099,
                    triggerPrice: 185.375
                  },
                  sell: {
                    currentPrice: 160.099,
                    lastBuyPrice: 175.0,
                    triggerPrice: 170.75,
                    stopLossTriggerPrice: 165,
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
                  isLocked: false,
                  symbolConfiguration: {
                    sell: {
                      stopLoss: { enabled: true }
                    }
                  },
                  symbolInfo: {
                    filterMinNotional: {
                      minNotional: '10.00000000'
                    }
                  },
                  baseAssetBalance: { total: '1.0500000' },
                  buy: {
                    currentPrice: 160.099,
                    triggerPrice: 185.375
                  },
                  sell: {
                    currentPrice: 160.099,
                    lastBuyPrice: 175.0,
                    triggerPrice: 170.75,
                    stopLossTriggerPrice: 165,
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
            rawData = {
              action: 'not-determined',
              isLocked: false,
              symbolConfiguration: {
                sell: {
                  stopLoss: { enabled: false }
                }
              },
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '1.0500000' },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: 178,
                triggerPrice: 186.9
              }
            };

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'sell-wait',
              isLocked: false,
              symbolConfiguration: {
                sell: {
                  stopLoss: { enabled: false }
                }
              },
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '1.0500000' },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375
              },
              sell: {
                currentPrice: 184.099,
                lastBuyPrice: 178,
                triggerPrice: 186.9,
                processMessage:
                  'The current price is lower than the selling trigger price. Wait.',
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
            isLocked: false,
            symbolInfo: {
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            baseAssetBalance: { total: '0.0500000' },
            buy: {
              currentPrice: 184.099,
              triggerPrice: 180.375
            },
            sell: {
              currentPrice: 184.099,
              lastBuyPrice: null,
              triggerPrice: null
            }
          };

          result = await step.execute(logger, rawData);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            action: 'not-determined',
            isLocked: false,
            symbolInfo: {
              filterMinNotional: {
                minNotional: '10.00000000'
              }
            },
            baseAssetBalance: { total: '0.0500000' },
            buy: {
              currentPrice: 184.099,
              triggerPrice: 180.375
            },
            sell: {
              currentPrice: 184.099,
              lastBuyPrice: null,
              triggerPrice: null
            }
          });
        });
      });
    });
  });
});
