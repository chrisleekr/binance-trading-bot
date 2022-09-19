/* eslint-disable global-require */
describe('webserver/handlers/backup-get', () => {
  let loggerMock;

  let shellMock;

  let rsDownload;
  let rsSend;

  const appMock = {
    route: null
  };

  let getReq;

  let mockVerifyAuthenticated;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    const shell = require('shelljs');
    jest.mock('shelljs');

    shellMock = shell;
    shellMock.exec = jest.fn().mockImplementation((_cmd, fn) => fn());

    rsSend = jest.fn().mockResolvedValue(true);
    rsDownload = jest.fn().mockResolvedValue(true);
    appMock.route = jest.fn(() => ({
      get: jest.fn().mockImplementation(func => {
        func(getReq, { send: rsSend, download: rsDownload });
      })
    }));
  });

  describe('when verification failed', () => {
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');

      loggerMock = logger;

      mockVerifyAuthenticated = jest.fn().mockResolvedValue(false);

      jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
        verifyAuthenticated: mockVerifyAuthenticated
      }));

      getReq = {
        header: () => 'some token'
      };
      const { handleBackupGet } = require('../backup-get');

      await handleBackupGet(loggerMock, appMock);
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
        data: {}
      });
    });
  });

  describe('when verification success', () => {
    describe(`backup failed`, () => {
      beforeEach(async () => {
        const { logger } = require('../../../../helpers');

        loggerMock = logger;

        mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

        jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
          verifyAuthenticated: mockVerifyAuthenticated
        }));

        getReq = {
          header: () => 'some token'
        };

        shellMock.exec = jest
          .fn()
          .mockImplementation((_cmd, fn) => fn(1, '', 'something happened'));

        const { handleBackupGet } = require('../backup-get');

        await handleBackupGet(loggerMock, appMock);
      });

      it('triggers verifyAuthenticated', () => {
        expect(mockVerifyAuthenticated).toHaveBeenCalledWith(
          loggerMock,
          'some token'
        );
      });

      it('triggers shell.exec', () => {
        expect(shellMock.exec).toHaveBeenCalledWith(
          expect.stringContaining(
            `${process.cwd()}/scripts/backup.sh binance-mongo 27017 binance-bot`
          ),
          expect.any(Function)
        );
      });

      it('return failed', () => {
        expect(rsSend).toHaveBeenCalledWith({
          success: false,
          status: 500,
          message: 'Backup failed',
          data: {
            code: 1,
            stderr: 'something happened',
            stdout: ''
          }
        });
      });
    });

    describe(`backup succeeed`, () => {
      beforeEach(async () => {
        const { logger } = require('../../../../helpers');

        loggerMock = logger;

        mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

        jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
          verifyAuthenticated: mockVerifyAuthenticated
        }));

        getReq = {
          header: () => 'some token'
        };

        shellMock.exec = jest
          .fn()
          .mockImplementation((_cmd, fn) => fn(0, 'all good', ''));

        const { handleBackupGet } = require('../backup-get');

        await handleBackupGet(loggerMock, appMock);
      });

      it('triggers verifyAuthenticated', () => {
        expect(mockVerifyAuthenticated).toHaveBeenCalledWith(
          loggerMock,
          'some token'
        );
      });

      it('return download', () => {
        expect(rsDownload).toHaveBeenCalledWith(
          expect.stringContaining('.archive'),
          expect.stringContaining('.archive')
        );
      });
    });
  });
});
