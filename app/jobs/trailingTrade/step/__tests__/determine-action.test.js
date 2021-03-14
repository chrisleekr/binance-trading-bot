const { logger } = require('../../../../helpers');

const step = require('../determine-action');

describe('determine-action.js', () => {
  let result;
  let rawData;

  describe('execute', () => {
    describe('when action is buy', () => {
      beforeEach(async () => {
        rawData = {
          action: 'buy',
          symbolInfo: {
            filterMinNotional: {
              minNotional: '10.00000000'
            }
          },
          baseAssetBalance: { total: '1.4500000' },
          buy: {
            currentPrice: 184.099,
            triggerPrice: 172.375
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
            rawData = {
              action: 'not-determined',
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '0.0500000' },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375
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
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '0.0500000' },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375,
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

        describe('when base asset balance does not have enough to sell', () => {
          beforeEach(async () => {
            rawData = {
              action: 'not-determined',
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
                lastBuyPrice: null,
                triggerPrice: null
              }
            };

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'wait',
              symbolInfo: {
                filterMinNotional: {
                  minNotional: '10.00000000'
                }
              },
              baseAssetBalance: { total: '1.0500000' },
              buy: {
                currentPrice: 184.099,
                triggerPrice: 185.375,
                processMessage:
                  'The current price reached the trigger price. But has enough to sell. Hence, do not buy it.',
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
          beforeEach(async () => {
            rawData = {
              action: 'not-determined',
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

            result = await step.execute(logger, rawData);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'sell',
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

        describe('when current price is less than trigger price', () => {
          beforeEach(async () => {
            rawData = {
              action: 'not-determined',
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
