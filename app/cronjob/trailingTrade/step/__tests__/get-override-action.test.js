/* eslint-disable global-require */
const _ = require('lodash');

describe('get-override-action.js', () => {
  let result;
  let rawData;

  let loggerMock;

  let mockGetOverrideDataForSymbol;
  let mockRemoveOverrideDataForSymbol;
  let mockIsActionDisabled;
  let mockSaveOverrideAction;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockGetOverrideDataForSymbol = jest.fn();
      mockRemoveOverrideDataForSymbol = jest.fn();
      mockIsActionDisabled = jest.fn();
      mockSaveOverrideAction = jest.fn();

      const { logger } = require('../../../../helpers');

      loggerMock = logger;

      jest.mock('../../../trailingTradeHelper/common', () => ({
        getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
        removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol,
        isActionDisabled: mockIsActionDisabled,
        saveOverrideAction: mockSaveOverrideAction
      }));
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        rawData = {
          action: 'not-determined',
          symbol: 'BTCUSDT',
          isLocked: true,
          symbolConfiguration: {
            botOptions: {
              autoTriggerBuy: { triggerAfter: 20 }
            }
          }
        };

        const step = require('../get-override-action');
        result = await step.execute(loggerMock, rawData);
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          action: 'not-determined',
          symbol: 'BTCUSDT',
          isLocked: true,
          symbolConfiguration: {
            botOptions: {
              autoTriggerBuy: { triggerAfter: 20 }
            }
          }
        });
      });
    });

    describe('when action is not "not-determined"', () => {
      beforeEach(async () => {
        rawData = {
          action: 'buy-order-wait',
          symbol: 'BTCUSDT',
          isLocked: false,
          symbolConfiguration: {
            botOptions: {
              autoTriggerBuy: { triggerAfter: 20 }
            }
          }
        };

        const step = require('../get-override-action');
        result = await step.execute(loggerMock, rawData);
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          action: 'buy-order-wait',
          symbol: 'BTCUSDT',
          isLocked: false,
          symbolConfiguration: {
            botOptions: {
              autoTriggerBuy: { triggerAfter: 20 }
            }
          }
        });
      });
    });

    describe('when action is "not-determined"', () => {
      describe('when override data is not retrieved', () => {
        beforeEach(async () => {
          mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue(null);
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
            removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol,
            isActionDisabled: mockIsActionDisabled,
            saveOverrideAction: mockSaveOverrideAction
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolConfiguration: {
              botOptions: {
                autoTriggerBuy: { triggerAfter: 20 }
              }
            }
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForSymbol', () => {
          expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('does not trigger removeOverrideDataForSymbol', () => {
          expect(mockRemoveOverrideDataForSymbol).not.toHaveBeenCalled();
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolConfiguration: {
              botOptions: {
                autoTriggerBuy: { triggerAfter: 20 }
              }
            },
            overrideData: {}
          });
        });
      });

      describe('when action is manual-trade', () => {
        beforeEach(async () => {
          mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue({
            action: 'manual-trade',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
            removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol,
            isActionDisabled: mockIsActionDisabled,
            saveOverrideAction: mockSaveOverrideAction
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolConfiguration: {
              botOptions: {
                autoTriggerBuy: { triggerAfter: 20 }
              }
            }
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForSymbol', () => {
          expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers removeOverrideDataForSymbol', () => {
          expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'manual-trade',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolConfiguration: {
              botOptions: {
                autoTriggerBuy: { triggerAfter: 20 }
              }
            },
            overrideData: {
              action: 'manual-trade',
              order: {
                some: 'data'
              }
            },
            order: {
              some: 'data'
            }
          });
        });
      });

      describe('when action is cancel-order', () => {
        beforeEach(async () => {
          mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue({
            action: 'cancel-order',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
            removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol,
            isActionDisabled: mockIsActionDisabled,
            saveOverrideAction: mockSaveOverrideAction
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolConfiguration: {
              botOptions: {
                autoTriggerBuy: { triggerAfter: 20 }
              }
            }
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForSymbol', () => {
          expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers removeOverrideDataForSymbol', () => {
          expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'cancel-order',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolConfiguration: {
              botOptions: {
                autoTriggerBuy: { triggerAfter: 20 }
              }
            },
            overrideData: {
              action: 'cancel-order',
              order: {
                some: 'data'
              }
            },
            order: {
              some: 'data'
            }
          });
        });
      });

      describe('when action is buy', () => {
        describe('when action is not triggered by auto trigger', () => {
          beforeEach(async () => {
            mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue({
              action: 'buy'
            });
            jest.mock('../../../trailingTradeHelper/common', () => ({
              getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
              removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol,
              isActionDisabled: mockIsActionDisabled,
              saveOverrideAction: mockSaveOverrideAction
            }));

            rawData = {
              action: 'not-determined',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolConfiguration: {
                botOptions: {
                  autoTriggerBuy: { triggerAfter: 20 }
                }
              }
            };

            const step = require('../get-override-action');
            result = await step.execute(loggerMock, rawData);
          });

          it('triggers getOverrideDataForSymbol', () => {
            expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT'
            );
          });

          it('triggers removeOverrideDataForSymbol', () => {
            expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
              loggerMock,
              'BTCUSDT'
            );
          });

          it('retruns expected result', () => {
            expect(result).toStrictEqual({
              action: 'buy',
              symbol: 'BTCUSDT',
              isLocked: false,
              symbolConfiguration: {
                botOptions: {
                  autoTriggerBuy: { triggerAfter: 20 }
                }
              },
              overrideData: {
                action: 'buy'
              },
              order: {}
            });
          });
        });

        describe('when buy action is triggered by auto trigger', () => {
          beforeEach(async () => {
            mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue({
              action: 'buy',
              order: {
                some: 'data'
              },
              triggeredBy: 'auto-trigger'
            });

            jest.mock('../../../trailingTradeHelper/common', () => ({
              getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
              removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol,
              isActionDisabled: mockIsActionDisabled,
              saveOverrideAction: mockSaveOverrideAction
            }));
          });

          describe('when ATH Restriction is enabled', () => {
            describe('when auto trigger buy condition is enabled', () => {
              describe('when current price is more than ATH restriction price', () => {
                beforeEach(async () => {
                  rawData = {
                    action: 'not-determined',
                    symbol: 'BTCUSDT',
                    isLocked: false,
                    symbolConfiguration: {
                      buy: {
                        athRestriction: {
                          enabled: true
                        }
                      },
                      botOptions: {
                        autoTriggerBuy: {
                          triggerAfter: 20,
                          conditions: {
                            whenLessThanATHRestriction: true,
                            afterDisabledPeriod: false,
                            tradingView: {
                              whenStrongBuy: true,
                              whenBuy: true
                            }
                          }
                        }
                      }
                    },
                    buy: {
                      currentPrice: 1000,
                      athRestrictionPrice: 900
                    }
                  };

                  const step = require('../get-override-action');
                  result = await step.execute(loggerMock, rawData);
                });

                it('triggers getOverrideDataForSymbol', () => {
                  expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT'
                  );
                });

                it('does not trigger removeOverrideDataForSymbol', () => {
                  expect(
                    mockRemoveOverrideDataForSymbol
                  ).not.toHaveBeenCalled();
                });

                it('triggers saveOverrideAction', () => {
                  expect(mockSaveOverrideAction).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT',
                    {
                      action: 'buy',
                      order: {
                        some: 'data'
                      },
                      actionAt: expect.any(String),
                      triggeredBy: 'auto-trigger'
                    },
                    `The auto-trigger buy action needs to be re-scheduled ` +
                      `because the current price is higher than ATH restriction price.`
                  );
                });

                it('retruns expected result', () => {
                  expect(result).toStrictEqual({
                    action: 'not-determined',
                    symbol: 'BTCUSDT',
                    isLocked: false,
                    symbolConfiguration: {
                      buy: {
                        athRestriction: {
                          enabled: true
                        }
                      },
                      botOptions: {
                        autoTriggerBuy: {
                          triggerAfter: 20,
                          conditions: {
                            whenLessThanATHRestriction: true,
                            afterDisabledPeriod: false,
                            tradingView: {
                              whenStrongBuy: true,
                              whenBuy: true
                            }
                          }
                        }
                      }
                    },
                    buy: {
                      athRestrictionPrice: 900,
                      currentPrice: 1000
                    },
                    overrideData: {
                      action: 'buy',
                      order: {
                        some: 'data'
                      },
                      triggeredBy: 'auto-trigger'
                    }
                  });
                });
              });

              describe('when current price is less than ATH restriction price', () => {
                beforeEach(async () => {
                  rawData = {
                    action: 'not-determined',
                    symbol: 'BTCUSDT',
                    isLocked: false,
                    symbolConfiguration: {
                      buy: {
                        athRestriction: {
                          enabled: true
                        }
                      },
                      botOptions: {
                        autoTriggerBuy: {
                          triggerAfter: 20,
                          conditions: {
                            whenLessThanATHRestriction: true,
                            afterDisabledPeriod: false,
                            tradingView: {
                              whenStrongBuy: true,
                              whenBuy: true
                            }
                          }
                        }
                      }
                    },
                    buy: {
                      currentPrice: 900,
                      athRestrictionPrice: 1000
                    }
                  };

                  const step = require('../get-override-action');
                  result = await step.execute(loggerMock, rawData);
                });

                it('triggers getOverrideDataForSymbol', () => {
                  expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT'
                  );
                });

                it('triggers removeOverrideDataForSymbol', () => {
                  expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT'
                  );
                });

                it('does not trigger saveOverrideAction', () => {
                  expect(mockSaveOverrideAction).not.toHaveBeenCalled();
                });

                it('retruns expected result', () => {
                  expect(result).toStrictEqual({
                    action: 'buy',
                    symbol: 'BTCUSDT',
                    isLocked: false,
                    symbolConfiguration: {
                      buy: {
                        athRestriction: {
                          enabled: true
                        }
                      },
                      botOptions: {
                        autoTriggerBuy: {
                          triggerAfter: 20,
                          conditions: {
                            whenLessThanATHRestriction: true,
                            afterDisabledPeriod: false,
                            tradingView: {
                              whenStrongBuy: true,
                              whenBuy: true
                            }
                          }
                        }
                      }
                    },
                    buy: {
                      athRestrictionPrice: 1000,
                      currentPrice: 900
                    },
                    overrideData: {
                      action: 'buy',
                      order: {
                        some: 'data'
                      },
                      triggeredBy: 'auto-trigger'
                    },
                    order: {
                      some: 'data'
                    }
                  });
                });
              });
            });

            describe('when auto trigger buy condition is disabled', () => {
              beforeEach(async () => {
                rawData = {
                  action: 'not-determined',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolConfiguration: {
                    buy: {
                      athRestriction: {
                        enabled: true
                      }
                    },
                    botOptions: {
                      autoTriggerBuy: {
                        triggerAfter: 20,
                        conditions: {
                          whenLessThanATHRestriction: false,
                          afterDisabledPeriod: false,
                          tradingView: {
                            whenStrongBuy: true,
                            whenBuy: true
                          }
                        }
                      }
                    }
                  },
                  buy: {
                    currentPrice: 1000,
                    athRestrictionPrice: 900
                  }
                };

                const step = require('../get-override-action');
                result = await step.execute(loggerMock, rawData);
              });

              it('triggers getOverrideDataForSymbol', () => {
                expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('triggers removeOverrideDataForSymbol', () => {
                expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('does not trigger saveOverrideAction', () => {
                expect(mockSaveOverrideAction).not.toHaveBeenCalled();
              });

              it('retruns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'buy',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolConfiguration: {
                    buy: {
                      athRestriction: {
                        enabled: true
                      }
                    },
                    botOptions: {
                      autoTriggerBuy: {
                        triggerAfter: 20,
                        conditions: {
                          whenLessThanATHRestriction: false,
                          afterDisabledPeriod: false,
                          tradingView: {
                            whenStrongBuy: true,
                            whenBuy: true
                          }
                        }
                      }
                    }
                  },
                  buy: {
                    athRestrictionPrice: 900,
                    currentPrice: 1000
                  },
                  overrideData: {
                    action: 'buy',
                    order: {
                      some: 'data'
                    },
                    triggeredBy: 'auto-trigger'
                  },
                  order: {
                    some: 'data'
                  }
                });
              });
            });
          });

          describe('when the action is disabled', () => {
            beforeEach(() => {
              mockIsActionDisabled = jest.fn().mockResolvedValue({
                isDisabled: true,
                ttl: 300,
                disabledBy: 'sell order',
                message: 'Disabled action after confirming the sell order.',
                canResume: false,
                canRemoveLastBuyPrice: false
              });

              jest.mock('../../../trailingTradeHelper/common', () => ({
                getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
                removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol,
                isActionDisabled: mockIsActionDisabled,
                saveOverrideAction: mockSaveOverrideAction
              }));
            });

            describe('when after disable period condition is enabled', () => {
              beforeEach(async () => {
                rawData = {
                  action: 'not-determined',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolConfiguration: {
                    buy: {
                      athRestriction: {
                        enabled: true
                      }
                    },
                    botOptions: {
                      autoTriggerBuy: {
                        triggerAfter: 20,
                        conditions: {
                          whenLessThanATHRestriction: false,
                          afterDisabledPeriod: true,
                          tradingView: {
                            whenStrongBuy: true,
                            whenBuy: true
                          }
                        }
                      }
                    }
                  },
                  buy: {
                    currentPrice: 1000,
                    athRestrictionPrice: 900
                  }
                };

                const step = require('../get-override-action');
                result = await step.execute(loggerMock, rawData);
              });

              it('triggers getOverrideDataForSymbol', () => {
                expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('does not trigger removeOverrideDataForSymbol', () => {
                expect(mockRemoveOverrideDataForSymbol).not.toHaveBeenCalled();
              });

              it('triggers saveOverrideAction', () => {
                expect(mockSaveOverrideAction).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT',
                  {
                    action: 'buy',
                    order: {
                      some: 'data'
                    },
                    actionAt: expect.any(String),
                    triggeredBy: 'auto-trigger'
                  },
                  `The auto-trigger buy action needs to be re-scheduled because ` +
                    `the action is disabled at the moment.`
                );
              });

              it('retruns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'not-determined',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolConfiguration: {
                    buy: {
                      athRestriction: {
                        enabled: true
                      }
                    },
                    botOptions: {
                      autoTriggerBuy: {
                        triggerAfter: 20,
                        conditions: {
                          whenLessThanATHRestriction: false,
                          afterDisabledPeriod: true,
                          tradingView: {
                            whenStrongBuy: true,
                            whenBuy: true
                          }
                        }
                      }
                    }
                  },
                  buy: {
                    athRestrictionPrice: 900,
                    currentPrice: 1000
                  },
                  overrideData: {
                    action: 'buy',
                    order: {
                      some: 'data'
                    },
                    triggeredBy: 'auto-trigger'
                  }
                });
              });
            });

            describe('when after disable period condition is disabled', () => {
              beforeEach(async () => {
                rawData = {
                  action: 'not-determined',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolConfiguration: {
                    buy: {
                      athRestriction: {
                        enabled: true
                      }
                    },
                    botOptions: {
                      autoTriggerBuy: {
                        triggerAfter: 20,
                        conditions: {
                          whenLessThanATHRestriction: false,
                          afterDisabledPeriod: false,
                          tradingView: {
                            whenStrongBuy: true,
                            whenBuy: true
                          }
                        }
                      }
                    }
                  },
                  buy: {
                    currentPrice: 1000,
                    athRestrictionPrice: 900
                  }
                };

                const step = require('../get-override-action');
                result = await step.execute(loggerMock, rawData);
              });

              it('triggers getOverrideDataForSymbol', () => {
                expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('triggers removeOverrideDataForSymbol', () => {
                expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('does not trigger saveOverrideAction', () => {
                expect(mockSaveOverrideAction).not.toHaveBeenCalled();
              });

              it('retruns expected result', () => {
                expect(result).toStrictEqual({
                  action: 'buy',
                  symbol: 'BTCUSDT',
                  isLocked: false,
                  symbolConfiguration: {
                    buy: {
                      athRestriction: {
                        enabled: true
                      }
                    },
                    botOptions: {
                      autoTriggerBuy: {
                        triggerAfter: 20,
                        conditions: {
                          whenLessThanATHRestriction: false,
                          afterDisabledPeriod: false,
                          tradingView: {
                            whenStrongBuy: true,
                            whenBuy: true
                          }
                        }
                      }
                    }
                  },
                  buy: {
                    athRestrictionPrice: 900,
                    currentPrice: 1000
                  },
                  overrideData: {
                    action: 'buy',
                    order: {
                      some: 'data'
                    },
                    triggeredBy: 'auto-trigger'
                  },
                  order: {
                    some: 'data'
                  }
                });
              });
            });
          });

          describe('recommendation', () => {
            beforeEach(() => {
              rawData = {
                action: 'not-determined',
                symbol: 'BTCUSDT',
                isLocked: false,
                symbolConfiguration: {
                  buy: {
                    athRestriction: {
                      enabled: true
                    }
                  },
                  botOptions: {
                    autoTriggerBuy: {
                      triggerAfter: 20,
                      conditions: {
                        whenLessThanATHRestriction: true,
                        afterDisabledPeriod: false,
                        tradingView: {
                          whenStrongBuy: true,
                          whenBuy: true
                        }
                      }
                    }
                  }
                },
                buy: {
                  currentPrice: 1000,
                  athRestrictionPrice: 1100
                },
                tradingView: {}
              };
            });

            describe('when recommendation is empty', () => {
              beforeEach(async () => {
                const step = require('../get-override-action');
                result = await step.execute(loggerMock, rawData);
              });

              it('triggers getOverrideDataForSymbol', () => {
                expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('triggers removeOverrideDataForSymbol', () => {
                expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('does not trigger saveOverrideAction', () => {
                expect(mockSaveOverrideAction).not.toHaveBeenCalled();
              });

              it('retruns expected result', () => {
                expect(result).toMatchObject({
                  action: 'buy',
                  order: {
                    some: 'data'
                  },
                  overrideData: {
                    action: 'buy',
                    order: {
                      some: 'data'
                    },
                    triggeredBy: 'auto-trigger'
                  }
                });
              });
            });

            describe('when recommendation is not enabled', () => {
              beforeEach(async () => {
                rawData.symbolConfiguration.botOptions.autoTriggerBuy.conditions.tradingView.whenStrongBuy = false;
                rawData.symbolConfiguration.botOptions.autoTriggerBuy.conditions.tradingView.whenBuy = false;

                const step = require('../get-override-action');
                result = await step.execute(loggerMock, rawData);
              });

              it('triggers getOverrideDataForSymbol', () => {
                expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('triggers removeOverrideDataForSymbol', () => {
                expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
                  loggerMock,
                  'BTCUSDT'
                );
              });

              it('does not trigger saveOverrideAction', () => {
                expect(mockSaveOverrideAction).not.toHaveBeenCalled();
              });

              it('retruns expected result', () => {
                expect(result).toMatchObject({
                  action: 'buy',
                  order: {
                    some: 'data'
                  },
                  overrideData: {
                    action: 'buy',
                    order: {
                      some: 'data'
                    },
                    triggeredBy: 'auto-trigger'
                  }
                });
              });
            });

            describe('when recommendations are enabled', () => {
              describe('when summary recommendation is strong buy', () => {
                beforeEach(async () => {
                  // Set recommendation as strong buy
                  rawData = _.set(
                    rawData,
                    'tradingView.result.summary.RECOMMENDATION',
                    'STRONG_BUY'
                  );
                  const step = require('../get-override-action');
                  result = await step.execute(loggerMock, rawData);
                });

                it('triggers getOverrideDataForSymbol', () => {
                  expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT'
                  );
                });

                it('triggers removeOverrideDataForSymbol', () => {
                  expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT'
                  );
                });

                it('does not trigger saveOverrideAction', () => {
                  expect(mockSaveOverrideAction).not.toHaveBeenCalled();
                });

                it('retruns expected result', () => {
                  expect(result).toMatchObject({
                    action: 'buy',
                    order: {
                      some: 'data'
                    },
                    overrideData: {
                      action: 'buy',
                      order: {
                        some: 'data'
                      },
                      triggeredBy: 'auto-trigger'
                    },
                    tradingView: {
                      result: {
                        summary: {
                          RECOMMENDATION: 'STRONG_BUY'
                        }
                      }
                    }
                  });
                });
              });

              describe('when summary recommendation is buy', () => {
                beforeEach(async () => {
                  // Set recommendation as strong buy
                  rawData = _.set(
                    rawData,
                    'tradingView.result.summary.RECOMMENDATION',
                    'BUY'
                  );
                  const step = require('../get-override-action');
                  result = await step.execute(loggerMock, rawData);
                });

                it('triggers getOverrideDataForSymbol', () => {
                  expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT'
                  );
                });

                it('triggers removeOverrideDataForSymbol', () => {
                  expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT'
                  );
                });

                it('does not trigger saveOverrideAction', () => {
                  expect(mockSaveOverrideAction).not.toHaveBeenCalled();
                });

                it('retruns expected result', () => {
                  expect(result).toMatchObject({
                    action: 'buy',
                    order: {
                      some: 'data'
                    },
                    overrideData: {
                      action: 'buy',
                      order: {
                        some: 'data'
                      },
                      triggeredBy: 'auto-trigger'
                    },
                    tradingView: {
                      result: {
                        summary: {
                          RECOMMENDATION: 'BUY'
                        }
                      }
                    }
                  });
                });
              });

              describe('when summary recommendation is not strong buy or buy', () => {
                beforeEach(async () => {
                  // Set recommendation as neutral
                  rawData = _.set(
                    rawData,
                    'tradingView.result.summary.RECOMMENDATION',
                    'NEUTRAL'
                  );
                  const step = require('../get-override-action');
                  result = await step.execute(loggerMock, rawData);
                });

                it('triggers getOverrideDataForSymbol', () => {
                  expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT'
                  );
                });

                it('does not trigger removeOverrideDataForSymbol', () => {
                  expect(
                    mockRemoveOverrideDataForSymbol
                  ).not.toHaveBeenCalled();
                });

                it('triggers saveOverrideAction', () => {
                  expect(mockSaveOverrideAction).toHaveBeenCalledWith(
                    loggerMock,
                    'BTCUSDT',
                    {
                      action: 'buy',
                      actionAt: expect.any(String),
                      order: { some: 'data' },
                      triggeredBy: 'auto-trigger'
                    },
                    `The auto-trigger buy action needs to be re-scheduled ` +
                      `because the TradingView recommendation is NEUTRAL.`
                  );
                });

                it('retruns expected result', () => {
                  expect(result).toMatchObject({
                    action: 'not-determined',
                    overrideData: {
                      action: 'buy',
                      order: {
                        some: 'data'
                      },
                      triggeredBy: 'auto-trigger'
                    },
                    tradingView: {
                      result: {
                        summary: {
                          RECOMMENDATION: 'NEUTRAL'
                        }
                      }
                    }
                  });
                });
              });
            });
          });
        });
      });

      describe('when action is not matching', () => {
        beforeEach(async () => {
          mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue({
            action: 'something-unknown',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
            removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol,
            isActionDisabled: mockIsActionDisabled,
            saveOverrideAction: mockSaveOverrideAction
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolConfiguration: {
              botOptions: {
                autoTriggerBuy: { triggerAfter: 20 }
              }
            }
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForSymbol', () => {
          expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('does not trigger removeOverrideDataForSymbol', () => {
          expect(mockRemoveOverrideDataForSymbol).not.toHaveBeenCalled();
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false,
            symbolConfiguration: {
              botOptions: {
                autoTriggerBuy: { triggerAfter: 20 }
              }
            },
            overrideData: {
              action: 'something-unknown',
              order: {
                some: 'data'
              }
            }
          });
        });
      });
    });
  });
});
