const moment = require('moment');
const {
  isBuyAllowedByTradingView,
  shouldForceSellByTradingView
} = require('../tradingview');

describe('tradingview.js', () => {
  let result;

  let loggerMock;
  let loggerMockInfo;

  const validTime = moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSSSSS');

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    loggerMockInfo = jest.fn();

    loggerMock = {
      info: loggerMockInfo
    };
  });

  describe('isBuyAllowedByTradingView', () => {
    describe('when there is override data and set false to check TraidingView', () => {
      beforeEach(() => {
        result = isBuyAllowedByTradingView(loggerMock, {
          symbolConfiguration: {
            botOptions: {
              tradingViews: [
                {
                  interval: '5m',
                  buy: {
                    whenStrongBuy: true,
                    whenBuy: true
                  },
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: false,
                      whenSell: true,
                      whenStrongSell: true
                    }
                  }
                }
              ]
            }
          },
          overrideData: {
            checkTradingView: false
          }
        });
      });

      it('logs expected message', () => {
        expect(loggerMockInfo).toHaveBeenCalledWith(
          {
            overrideData: {
              checkTradingView: false
            }
          },
          'Override data is not empty. Ignore TradingView recommendation.'
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          isTradingViewAllowed: true,
          tradingViewRejectedReason: ''
        });
      });
    });

    describe('validateTradingViewsForBuy', () => {
      describe('when there is TradingViews undefined', () => {
        beforeEach(() => {
          result = isBuyAllowedByTradingView(loggerMock, {
            symbolConfiguration: {
              botOptions: {
                tradingViews: undefined,
                tradingViewOptions: { useOnlyWithin: 5, ifExpires: 'ignore' }
              }
            },
            overrideData: {},
            tradingViews: [
              {
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: validTime
                }
              },
              {
                result: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: validTime
                }
              }
            ]
          });
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            isTradingViewAllowed: false,
            tradingViewRejectedReason:
              'Do not place an order because there are missing TradingView configuration.'
          });
        });
      });

      describe('when there is no buy configuration configured', () => {
        beforeEach(() => {
          result = isBuyAllowedByTradingView(loggerMock, {
            symbolConfiguration: {
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: false,
                      whenBuy: false
                    }
                  },
                  {
                    interval: '15m',
                    buy: {
                      whenStrongBuy: false,
                      whenBuy: false
                    }
                  }
                ],
                tradingViewOptions: { useOnlyWithin: 5, ifExpires: 'ignore' }
              }
            },
            overrideData: {},
            tradingViews: [
              {
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: validTime
                }
              },
              {
                result: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: validTime
                }
              }
            ]
          });
        });

        it('logs expected message', () => {
          expect(loggerMockInfo).toHaveBeenCalledWith(
            'There is no buy condition configured. Ignore TradingView recommendation.'
          );
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            isTradingViewAllowed: true,
            tradingViewRejectedReason: ''
          });
        });
      });

      describe('when there is expired TradingView', () => {
        beforeEach(() => {
          result = isBuyAllowedByTradingView(loggerMock, {
            symbolConfiguration: {
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: false
                    }
                  },
                  {
                    interval: '15m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    }
                  }
                ],
                tradingViewOptions: {
                  useOnlyWithin: 5,
                  ifExpires: 'do-not-buy'
                }
              }
            },
            overrideData: {},
            tradingViews: [
              {
                request: {
                  interval: '5m'
                },
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: '2021-10-30T08:53:53.973250'
                }
              },
              {
                request: {
                  interval: '15m'
                },
                result: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: '2021-10-30T08:53:53.973250'
                }
              }
            ]
          });
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            isTradingViewAllowed: false,
            tradingViewRejectedReason:
              'Do not place an order because TradingView data is older than 5 minutes.'
          });
        });
      });

      describe('when there is no valid TradingView', () => {
        beforeEach(() => {
          result = isBuyAllowedByTradingView(loggerMock, {
            symbolConfiguration: {
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: false
                    }
                  },
                  {
                    interval: '15m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    }
                  }
                ],
                tradingViewOptions: {
                  useOnlyWithin: 5,
                  ifExpires: 'ignore'
                }
              }
            },
            overrideData: {},
            tradingViews: [
              {
                request: {
                  interval: '5m'
                },
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: ''
                }
              },
              {
                request: {
                  interval: '15m'
                },
                result: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: '2021-10-30T08:53:53.973250'
                }
              },
              {
                request: {
                  interval: '30m'
                },
                result: {
                  summary: { RECOMMENDATION: '' },
                  time: validTime
                }
              }
            ]
          });
        });

        it('logs expected message', () => {
          expect(loggerMockInfo).toHaveBeenCalledWith(
            'TradingView time or recommendation is empty. Ignore TradingView recommendation.'
          );
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            isTradingViewAllowed: true,
            tradingViewRejectedReason: ''
          });
        });
      });

      describe('when there is missing TradingView', () => {
        beforeEach(() => {
          result = isBuyAllowedByTradingView(loggerMock, {
            symbolConfiguration: {
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: false
                    }
                  },
                  {
                    interval: '15m',
                    buy: {
                      whenStrongBuy: true,
                      whenBuy: true
                    }
                  }
                ],
                tradingViewOptions: {
                  useOnlyWithin: 5,
                  ifExpires: 'ignore'
                }
              }
            },
            overrideData: {},
            tradingViews: [
              {
                request: {
                  interval: '5m'
                },
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: validTime
                }
              }
            ]
          });
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            isTradingViewAllowed: false,
            tradingViewRejectedReason:
              'Do not place an order because there are missing TradingView data.'
          });
        });
      });
    });

    describe('when could not satisfy all recommendations', () => {
      [
        {
          desc: 'when none of buy conditions is matching',
          tradingViewsConfig: [
            {
              interval: '5m',
              buy: {
                whenStrongBuy: true,
                whenBuy: false
              }
            },
            {
              interval: '15m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            }
          ],
          expectedReaons:
            'Do not place an order because TradingView recommendation for 5m is NEUTRAL.'
        },
        {
          desc: 'when one interval buy conditions is matching',
          tradingViewsConfig: [
            {
              interval: '5m',
              buy: {
                whenStrongBuy: true,
                whenBuy: false
              }
            },
            {
              interval: '15m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            }
          ],
          expectedReaons:
            'Do not place an order because TradingView recommendation for 15m is NEUTRAL.'
        },
        {
          desc: 'when one interval buy conditions is matching',
          tradingViewsConfig: [
            {
              interval: '5m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            },
            {
              interval: '15m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: validTime
              }
            }
          ],
          expectedReaons:
            'Do not place an order because TradingView recommendation for 5m is NEUTRAL.'
        },
        {
          desc: 'when one interval is not active',
          tradingViewsConfig: [
            {
              interval: '5m',
              buy: {
                whenStrongBuy: false,
                whenBuy: false
              }
            },
            {
              interval: '15m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            }
          ],
          expectedReaons:
            'Do not place an order because TradingView recommendation for 15m is NEUTRAL.'
        },
        {
          desc: 'with single config',
          tradingViewsConfig: [
            {
              interval: '5m',
              buy: {
                whenStrongBuy: false,
                whenBuy: true
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            }
          ],
          expectedReaons:
            'Do not place an order because TradingView recommendation for 5m is STRONG_BUY.'
        }
      ].forEach(t => {
        describe(`${t.desc}`, () => {
          beforeEach(() => {
            result = isBuyAllowedByTradingView(loggerMock, {
              symbolConfiguration: {
                botOptions: {
                  tradingViews: t.tradingViewsConfig,
                  tradingViewOptions: {
                    useOnlyWithin: 5,
                    ifExpires: 'do-not-buy'
                  }
                }
              },
              overrideData: {},
              tradingViews: t.tradingViews
            });
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              isTradingViewAllowed: false,
              tradingViewRejectedReason: t.expectedReaons
            });
          });
        });
      });
    });

    describe('when satisfies all recommendations', () => {
      [
        {
          desc: 'two buy conditions are matching',
          tradingViewsConfig: [
            {
              interval: '5m',
              buy: {
                whenStrongBuy: true,
                whenBuy: false
              }
            },
            {
              interval: '15m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'BUY' },
                time: validTime
              }
            }
          ]
        },
        {
          desc: 'two buy conditions are matching',
          tradingViewsConfig: [
            {
              interval: '5m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            },
            {
              interval: '15m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'BUY' },
                time: validTime
              }
            }
          ]
        },
        {
          desc: "one buy condition is matching, but one interval's conditions are all false",
          tradingViewsConfig: [
            {
              interval: '5m',
              buy: {
                whenStrongBuy: false,
                whenBuy: false
              }
            },
            {
              interval: '15m',
              buy: {
                whenStrongBuy: true,
                whenBuy: true
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_BUY' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'BUY' },
                time: validTime
              }
            }
          ]
        }
      ].forEach(t => {
        describe(`${t.desc}`, () => {
          beforeEach(() => {
            result = isBuyAllowedByTradingView(loggerMock, {
              symbolConfiguration: {
                botOptions: {
                  tradingViews: t.tradingViewsConfig,
                  tradingViewOptions: {
                    useOnlyWithin: 5,
                    ifExpires: 'do-not-buy'
                  }
                }
              },
              overrideData: {},
              tradingViews: t.tradingViews
            });
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              isTradingViewAllowed: true,
              tradingViewRejectedReason: ''
            });
          });
        });
      });
    });
  });

  describe('shouldForceSellByTradingView', () => {
    const baseData = {
      symbolInfo: {
        filterLotSize: { stepSize: '0.00000100' },
        filterMinNotional: { minNotional: '10.00000000' }
      },
      baseAssetBalance: { free: 0.5 },
      sell: {
        currentProfit: 50,
        currentPrice: 29000,
        triggerPrice: 30900
      }
    };

    describe('validateTradingViewsForForceSell', () => {
      describe('when there is TradingViews undefined', () => {
        beforeEach(() => {
          result = shouldForceSellByTradingView(loggerMock, {
            ...baseData,
            symbolConfiguration: {
              botOptions: {
                tradingViews: undefined,
                tradingViewOptions: { useOnlyWithin: 5, ifExpires: 'ignore' }
              }
            },
            tradingViews: [
              {
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: validTime
                }
              },
              {
                result: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: validTime
                }
              }
            ]
          });
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            shouldForceSell: false,
            forceSellMessage:
              'Do not place an order because there are missing TradingView configuration.'
          });
        });
      });

      describe('when there is no sell configuration configured', () => {
        beforeEach(() => {
          result = shouldForceSellByTradingView(loggerMock, {
            ...baseData,
            symbolConfiguration: {
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: false,
                        whenStrongSell: false
                      }
                    }
                  },
                  {
                    interval: '15m',
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: false,
                        whenSell: false,
                        whenStrongSell: false
                      }
                    }
                  }
                ],
                tradingViewOptions: { useOnlyWithin: 5, ifExpires: 'ignore' }
              }
            },
            tradingViews: [
              {
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: validTime
                }
              },
              {
                result: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: validTime
                }
              }
            ]
          });
        });

        it('logs expected message', () => {
          expect(loggerMockInfo).toHaveBeenCalledWith(
            'There is no sell condition configured. Ignore TradingView recommendation.'
          );
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            shouldForceSell: false,
            forceSellMessage: ''
          });
        });
      });

      describe('when there is expired TradingView', () => {
        beforeEach(() => {
          result = shouldForceSellByTradingView(loggerMock, {
            ...baseData,
            symbolConfiguration: {
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  },
                  {
                    interval: '15m',
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ],
                tradingViewOptions: {
                  useOnlyWithin: 5,
                  ifExpires: 'do-not-buy'
                }
              }
            },
            tradingViews: [
              {
                request: {
                  interval: '5m'
                },
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: '2021-10-30T08:53:53.973250'
                }
              },
              {
                request: {
                  interval: '15m'
                },
                result: {
                  summary: { RECOMMENDATION: 'BUY' },
                  time: '2021-10-30T08:53:53.973250'
                }
              }
            ]
          });
        });

        it('logs expected message', () => {
          expect(loggerMockInfo).toHaveBeenCalledWith(
            'TradingView time or recommendation is empty. Ignore TradingView recommendation.'
          );
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            shouldForceSell: false,
            forceSellMessage: ''
          });
        });
      });

      describe('when there is no valid TradingView', () => {
        beforeEach(() => {
          result = shouldForceSellByTradingView(loggerMock, {
            ...baseData,
            symbolConfiguration: {
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  },
                  {
                    interval: '15m',
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ],
                tradingViewOptions: {
                  useOnlyWithin: 5,
                  ifExpires: 'do-not-buy'
                }
              }
            },
            tradingViews: [
              {
                request: {
                  interval: '5m'
                },
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: ''
                }
              },
              {
                request: {
                  interval: '15m'
                },
                result: {
                  summary: { RECOMMENDATION: '' },
                  time: validTime
                }
              }
            ]
          });
        });

        it('logs expected message', () => {
          expect(loggerMockInfo).toHaveBeenCalledWith(
            'TradingView time or recommendation is empty. Ignore TradingView recommendation.'
          );
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            shouldForceSell: false,
            forceSellMessage: ''
          });
        });
      });

      describe('when there is missingTradingView', () => {
        beforeEach(() => {
          result = shouldForceSellByTradingView(loggerMock, {
            ...baseData,
            symbolConfiguration: {
              botOptions: {
                tradingViews: [
                  {
                    interval: '5m',
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  },
                  {
                    interval: '15m',
                    sell: {
                      forceSellOverZeroBelowTriggerPrice: {
                        whenNeutral: true,
                        whenSell: true,
                        whenStrongSell: true
                      }
                    }
                  }
                ],
                tradingViewOptions: {
                  useOnlyWithin: 5,
                  ifExpires: 'do-not-buy'
                }
              }
            },
            tradingViews: [
              {
                request: {
                  interval: '5m'
                },
                result: {
                  summary: { RECOMMENDATION: 'NEUTRAL' },
                  time: validTime
                }
              }
            ]
          });
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            shouldForceSell: false,
            forceSellMessage:
              'Do not force-sell because there are missing TradingView data.'
          });
        });
      });
    });

    describe('when current profit is less than 0', () => {
      beforeEach(() => {
        result = shouldForceSellByTradingView(loggerMock, {
          ...baseData,
          symbolConfiguration: {
            botOptions: {
              tradingViews: [
                {
                  interval: '5m',
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: true,
                      whenSell: true,
                      whenStrongSell: true
                    }
                  }
                },
                {
                  interval: '15m',
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: true,
                      whenSell: true,
                      whenStrongSell: true
                    }
                  }
                }
              ],
              tradingViewOptions: {
                useOnlyWithin: 5,
                ifExpires: 'do-not-buy'
              }
            }
          },
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            }
          ],
          sell: {
            currentProfit: -50,
            currentPrice: 29000,
            triggerPrice: 30900
          }
        });
      });

      it('logs expected message', () => {
        expect(loggerMockInfo).toHaveBeenCalledWith(
          {
            sellCurrentProfit: -50,
            sellCurrentPrice: 29000,
            sellTriggerPrice: 30900
          },
          `Current profit if equal or less than 0 or ` +
            `current price is more than trigger price. Ignore TradingView recommendation.`
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          shouldForceSell: false,
          forceSellMessage: ''
        });
      });
    });

    describe('when current price is higher than trigger price', () => {
      beforeEach(() => {
        result = shouldForceSellByTradingView(loggerMock, {
          ...baseData,
          symbolConfiguration: {
            botOptions: {
              tradingViews: [
                {
                  interval: '5m',
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: true,
                      whenSell: true,
                      whenStrongSell: true
                    }
                  }
                },
                {
                  interval: '15m',
                  sell: {
                    forceSellOverZeroBelowTriggerPrice: {
                      whenNeutral: true,
                      whenSell: true,
                      whenStrongSell: true
                    }
                  }
                }
              ],
              tradingViewOptions: {
                useOnlyWithin: 5,
                ifExpires: 'do-not-buy'
              }
            }
          },
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            }
          ],
          sell: {
            currentProfit: 50,
            currentPrice: 29000,
            triggerPrice: 28950
          }
        });
      });

      it('logs expected message', () => {
        expect(loggerMockInfo).toHaveBeenCalledWith(
          {
            sellCurrentProfit: 50,
            sellCurrentPrice: 29000,
            sellTriggerPrice: 28950
          },
          `Current profit if equal or less than 0 or ` +
            `current price is more than trigger price. Ignore TradingView recommendation.`
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          shouldForceSell: false,
          forceSellMessage: ''
        });
      });
    });

    describe('when free balance is less than minimum notional value', () => {
      [
        {
          desc: 'stepSize is not 1',
          symbolInfo: {
            filterLotSize: { stepSize: '0.00000100' },
            filterMinNotional: { minNotional: '10.00000000' }
          }
        },
        {
          desc: 'stepSize is 1',
          symbolInfo: {
            filterLotSize: { stepSize: '1.00000000' },
            filterMinNotional: { minNotional: '10.00000000' }
          }
        }
      ].forEach(t => {
        describe(`${t.desc}`, () => {
          beforeEach(() => {
            result = shouldForceSellByTradingView(loggerMock, {
              ...baseData,
              symbolConfiguration: {
                botOptions: {
                  tradingViews: [
                    {
                      interval: '5m',
                      sell: {
                        forceSellOverZeroBelowTriggerPrice: {
                          whenNeutral: true,
                          whenSell: true,
                          whenStrongSell: true
                        }
                      }
                    },
                    {
                      interval: '15m',
                      sell: {
                        forceSellOverZeroBelowTriggerPrice: {
                          whenNeutral: true,
                          whenSell: true,
                          whenStrongSell: true
                        }
                      }
                    }
                  ],
                  tradingViewOptions: {
                    useOnlyWithin: 5,
                    ifExpires: 'do-not-buy'
                  }
                }
              },
              tradingViews: [
                {
                  request: {
                    interval: '5m'
                  },
                  result: {
                    summary: { RECOMMENDATION: 'NEUTRAL' },
                    time: validTime
                  }
                },
                {
                  request: {
                    interval: '15m'
                  },
                  result: {
                    summary: { RECOMMENDATION: 'NEUTRAL' },
                    time: validTime
                  }
                }
              ],
              symbolInfo: t.symbolInfo,
              baseAssetBalance: { free: 0.0003 },
              sell: {
                currentProfit: 1,
                currentPrice: 29000,
                triggerPrice: 35000
              }
            });
          });

          it('logs expected message', () => {
            expect(loggerMockInfo).toHaveBeenCalledWith(
              {
                sellCurrentProfit: 1,
                sellCurrentPrice: 29000,
                sellTriggerPrice: 35000
              },
              `Order quantity is less than minimum notional value. Ignore TradingView recommendation.`
            );
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              shouldForceSell: false,
              forceSellMessage: ''
            });
          });
        });
      });
    });

    describe('when could not satisfy any force sell recommendation', () => {
      [
        {
          desc: 'all sell conditions are set, but recommendation is not satisfied',
          tradingViewsConfig: [
            {
              interval: '5m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: true,
                  whenSell: true,
                  whenStrongSell: true
                }
              }
            },
            {
              interval: '15m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: true,
                  whenSell: true,
                  whenStrongSell: true
                }
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'BUY' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'BUY' },
                time: validTime
              }
            }
          ]
        },
        {
          desc: 'some sell conditions are set, but recommendation is not satisfied',
          tradingViewsConfig: [
            {
              interval: '5m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: false,
                  whenSell: false,
                  whenStrongSell: true
                }
              }
            },
            {
              interval: '15m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: false,
                  whenSell: false,
                  whenStrongSell: true
                }
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'SELL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'SELL' },
                time: validTime
              }
            }
          ]
        },
        {
          desc: 'one interval sell conditions are set, but recommendation is not satisfied',
          tradingViewsConfig: [
            {
              interval: '5m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: false,
                  whenSell: false,
                  whenStrongSell: false
                }
              }
            },
            {
              interval: '15m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: false,
                  whenSell: true,
                  whenStrongSell: true
                }
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'SELL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            }
          ]
        }
      ].forEach(t => {
        describe(`${t.desc}`, () => {
          beforeEach(() => {
            result = shouldForceSellByTradingView(loggerMock, {
              ...baseData,
              symbolConfiguration: {
                botOptions: {
                  tradingViews: t.tradingViewsConfig,
                  tradingViewOptions: {
                    useOnlyWithin: 5,
                    ifExpires: 'do-not-buy'
                  }
                }
              },
              tradingViews: t.tradingViews
            });
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              shouldForceSell: false,
              forceSellMessage: ''
            });
          });
        });
      });
    });

    describe('when satisfies any recommendation', () => {
      [
        {
          desc: 'all sell conditions are set, and one recommendation is satisfied.',
          tradingViewsConfig: [
            {
              interval: '5m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: true,
                  whenSell: true,
                  whenStrongSell: true
                }
              }
            },
            {
              interval: '15m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: true,
                  whenSell: true,
                  whenStrongSell: true
                }
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'NEUTRAL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'SELL' },
                time: validTime
              }
            }
          ],
          expectedForceSellReason:
            `TradingView recommendation for 5m is neutral. The current profit (50) is more than 0 ` +
            `and the current price (29000) is under trigger price (30900). Sell at market price.`
        },
        {
          desc: 'some sell conditions are set, and one recommendation is satisfied.',
          tradingViewsConfig: [
            {
              interval: '5m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: false,
                  whenSell: true,
                  whenStrongSell: true
                }
              }
            },
            {
              interval: '15m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: false,
                  whenSell: false,
                  whenStrongSell: true
                }
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'BUY' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            }
          ],
          expectedForceSellReason:
            `TradingView recommendation for 15m is strong_sell. The current profit (50) is more than 0 ` +
            `and the current price (29000) is under trigger price (30900). Sell at market price.`
        },
        {
          desc: 'only one sell conditions are set, and one recommendation is satisfied.',
          tradingViewsConfig: [
            {
              interval: '5m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: false,
                  whenSell: false,
                  whenStrongSell: false
                }
              }
            },
            {
              interval: '15m',
              sell: {
                forceSellOverZeroBelowTriggerPrice: {
                  whenNeutral: false,
                  whenSell: true,
                  whenStrongSell: true
                }
              }
            }
          ],
          tradingViews: [
            {
              request: {
                interval: '5m'
              },
              result: {
                summary: { RECOMMENDATION: 'STRONG_SELL' },
                time: validTime
              }
            },
            {
              request: {
                interval: '15m'
              },
              result: {
                summary: { RECOMMENDATION: 'SELL' },
                time: validTime
              }
            }
          ],
          expectedForceSellReason:
            `TradingView recommendation for 15m is sell. The current profit (50) is more than 0 ` +
            `and the current price (29000) is under trigger price (30900). Sell at market price.`
        }
      ].forEach(t => {
        describe(`${t.desc}`, () => {
          beforeEach(() => {
            result = shouldForceSellByTradingView(loggerMock, {
              ...baseData,
              symbolConfiguration: {
                botOptions: {
                  tradingViews: t.tradingViewsConfig,
                  tradingViewOptions: {
                    useOnlyWithin: 5,
                    ifExpires: 'do-not-buy'
                  }
                }
              },
              tradingViews: t.tradingViews
            });
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              shouldForceSell: true,
              forceSellMessage: t.expectedForceSellReason
            });
          });
        });
      });
    });
  });
});
