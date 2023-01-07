/* eslint-disable global-require */
const fs = require('fs');
const path = require('path');
const { sep: directorySeparator } = require('path');

describe('webserver/handlers/grid-trade-logs-export', () => {
  let loggerMock;
  let mongoMock;

  let rsSend;

  let fileFolder;

  const appMock = {
    route: null
  };

  let postReq;

  let mockVerifyAuthenticated;
  global.appRoot = path.join(__dirname, '/../../../../');

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    rsSend = jest.fn().mockResolvedValue(true);

    appMock.route = jest.fn(() => ({
      post: jest.fn().mockImplementation(func => {
        func(postReq, { send: rsSend });
      })
    }));
  });

  describe('when verification failed', () => {
    beforeEach(async () => {
      const { logger, mongo } = require('../../../../helpers');

      loggerMock = logger;
      mongoMock = mongo;

      mockVerifyAuthenticated = jest.fn().mockResolvedValue(false);

      jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
        verifyAuthenticated: mockVerifyAuthenticated
      }));

      postReq = {
        body: {
          authToken: 'some token',
          symbol: 'BTCUSDT'
        }
      };
      const {
        handleGridTradeLogsExport
      } = require('../grid-trade-logs-export');

      await handleGridTradeLogsExport(loggerMock, appMock);
    });

    it('triggers verifyAuthenticated', () => {
      expect(mockVerifyAuthenticated).toHaveBeenCalledWith(
        loggerMock,
        'some token'
      );
    });

    it('return unauthorised', () => {
      expect(rsSend).toHaveBeenCalledWith({
        success: false,
        status: 403,
        message: 'Please authenticate first.',
        data: {
          rows: []
        }
      });
    });
  });

  describe('when verification success', () => {
    [
      {
        desc: 'symbol',
        requestBody: {
          authToken: 'valid-auth-token',
          symbol: 'BTCUSDT'
        },
        expectedMatch: {
          symbol: 'BTCUSDT'
        },
        expectFindAllParams: {
          sort: { loggedAt: -1 }
        }
      }
    ].forEach(t => {
      describe(`found rows - ${t.desc}`, () => {
        beforeEach(async () => {
          // Delete log folder
          fileFolder = path.join(__dirname, '/../../../../../public/data/logs');
          fs.rmSync(fileFolder, { recursive: true, force: true });

          const { logger, mongo } = require('../../../../helpers');

          loggerMock = logger;
          mongoMock = mongo;

          mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

          jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
            verifyAuthenticated: mockVerifyAuthenticated
          }));

          mongoMock.findAll = jest.fn().mockResolvedValue([
            {
              someValue: 'value1'
            },
            {
              someValue: 'value2'
            }
          ]);

          postReq = {
            body: t.requestBody
          };
          const {
            handleGridTradeLogsExport
          } = require('../grid-trade-logs-export');

          await handleGridTradeLogsExport(loggerMock, appMock);
        });

        it('triggers mongo.findAll', () => {
          expect(mongoMock.findAll).toHaveBeenCalledWith(
            loggerMock,
            'trailing-trade-logs',
            t.expectedMatch,
            t.expectFindAllParams
          );
        });

        it('return data', () => {
          expect(rsSend).toHaveBeenCalledWith({
            success: true,
            status: 200,
            message: 'Exported log file',
            data: {
              fileName: expect.any(String)
            }
          });
        });
      });
    });

    describe(`cannot find rows`, () => {
      beforeEach(async () => {
        // Delete log folder
        fileFolder = path.join(__dirname, '/../../../../../public/data/logs');
        fs.rmSync(fileFolder, { recursive: true, force: true });

        if (!fs.existsSync(fileFolder)) {
          fs.mkdirSync(fileFolder);
        }

        // Create 10 files to test keeping last 10 logs
        for (let i = 1; i <= 10; i += 1) {
          fs.writeFileSync(
            `${fileFolder}${directorySeparator}file${i}.json`,
            JSON.stringify([{ log: 'value' }])
          );
        }
        const { logger, mongo } = require('../../../../helpers');

        loggerMock = logger;
        mongoMock = mongo;

        mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

        jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
          verifyAuthenticated: mockVerifyAuthenticated
        }));

        mongoMock.findAll = jest.fn().mockResolvedValue([]);

        mongoMock.aggregate = jest.fn().mockResolvedValue([]);

        postReq = {
          body: {
            authToken: 'valid-auth-token',
            symbol: 'BTCUSDT'
          }
        };
        const {
          handleGridTradeLogsExport
        } = require('../grid-trade-logs-export');

        await handleGridTradeLogsExport(loggerMock, appMock);
      });

      it('keeps 10 logs in the folder', () => {
        const files = fs.readdirSync(fileFolder);
        expect(files.length).toBe(10);
      });

      it('triggers mongo.findAll', () => {
        expect(mongoMock.findAll).toHaveBeenCalledWith(
          loggerMock,
          'trailing-trade-logs',
          {
            symbol: 'BTCUSDT'
          },
          {
            sort: { loggedAt: -1 }
          }
        );
      });

      it('return data', () => {
        expect(rsSend).toHaveBeenCalledWith({
          success: true,
          status: 200,
          message: 'Exported log file',
          data: {
            fileName: expect.any(String)
          }
        });
      });
    });
  });
});
