/* eslint-disable global-require */
describe('webserver/handlers/restore-post', () => {
  let loggerMock;

  let shellMock;
  let config;

  let rsSend;
  let archiveMv;

  const appMock = {
    route: null
  };

  let postReq;

  let mockVerifyAuthenticated;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    const childProcess = require('child_process');
    jest.mock('child_process');

    shellMock = childProcess;
    shellMock.execFile = jest
      .fn()
      .mockImplementation((_cmd, _args, fn) => fn(1, '', 'something happened'));

    rsSend = jest.fn().mockResolvedValue(true);
    appMock.route = jest.fn(() => ({
      post: jest.fn().mockImplementation(func => {
        func(postReq, { send: rsSend });
      })
    }));

    jest.mock('config');
    config = require('config');

    config.get = jest.fn(key => {
      switch (key) {
        case 'demoMode':
          return false;
        case 'mongo.host':
          return 'binance-mongo';
        case 'mongo.port':
          return 27017;
        default:
          return null;
      }
    });
  });

  describe('when it is demo mode', () => {
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');

      loggerMock = logger;

      config.get = jest.fn(key => {
        switch (key) {
          case 'demoMode':
            return true;
          default:
            return null;
        }
      });

      postReq = {
        header: () => 'some token'
      };
      const { handleRestorePost } = require('../restore-post');

      await handleRestorePost(loggerMock, appMock);
    });

    it('return unauthorised', () => {
      expect(rsSend).toHaveBeenCalledWith({
        success: false,
        status: 403,
        message: 'You cannot restore database in the demo mode.',
        data: {}
      });
    });
  });

  describe('when verification failed', () => {
    beforeEach(async () => {
      const { logger } = require('../../../../helpers');

      loggerMock = logger;

      mockVerifyAuthenticated = jest.fn().mockResolvedValue(false);

      jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
        verifyAuthenticated: mockVerifyAuthenticated
      }));

      postReq = {
        header: () => 'some token'
      };
      const { handleRestorePost } = require('../restore-post');

      await handleRestorePost(loggerMock, appMock);
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
    beforeEach(() => {
      archiveMv = jest.fn();
    });

    describe(`backup failed`, () => {
      beforeEach(async () => {
        const { logger } = require('../../../../helpers');

        loggerMock = logger;

        mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

        jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
          verifyAuthenticated: mockVerifyAuthenticated
        }));

        postReq = {
          header: () => 'some token',
          files: {
            archive: {
              name: 'my-backup.archive',
              mv: archiveMv
            }
          }
        };

        shellMock.execFile = jest
          .fn()
          .mockImplementation((_cmd, _args, fn) =>
            fn(new Error('something happened'), '', 'something happened')
          );

        const { handleRestorePost } = require('../restore-post');

        await handleRestorePost(loggerMock, appMock);
      });

      it('triggers verifyAuthenticated', () => {
        expect(mockVerifyAuthenticated).toHaveBeenCalledWith(
          loggerMock,
          'some token'
        );
      });

      it('moves to tmp folder', () => {
        expect(archiveMv).toHaveBeenCalled();
      });

      it('return failed', () => {
        expect(rsSend).toHaveBeenCalledWith({
          success: false,
          status: 500,
          message: 'Restore failed',
          data: {
            code: 1,
            stderr: 'something happened',
            stdout: '',
            error: new Error('something happened')
          }
        });
      });
    });

    describe(`backup succeed`, () => {
      beforeEach(async () => {
        const { logger } = require('../../../../helpers');

        loggerMock = logger;

        mockVerifyAuthenticated = jest.fn().mockResolvedValue(true);

        jest.mock('../../../../cronjob/trailingTradeHelper/common', () => ({
          verifyAuthenticated: mockVerifyAuthenticated
        }));

        postReq = {
          header: () => 'some token',
          files: {
            archive: {
              name: 'my-backup.archive',
              mv: archiveMv
            }
          }
        };

        shellMock.execFile = jest
          .fn()
          .mockImplementation((_cmd, _args, fn) => fn(null, 'all good', ''));

        const { handleRestorePost } = require('../restore-post');

        await handleRestorePost(loggerMock, appMock);
      });

      it('triggers verifyAuthenticated', () => {
        expect(mockVerifyAuthenticated).toHaveBeenCalledWith(
          loggerMock,
          'some token'
        );
      });

      it('triggers execFile', () => {
        expect(shellMock.execFile).toHaveBeenCalledWith(
          `${process.cwd()}/scripts/restore.sh`,
          ['binance-mongo', 27017, expect.stringContaining('/tmp/')],
          expect.any(Function)
        );
      });

      it('return success', () => {
        expect(rsSend).toHaveBeenCalledWith({
          success: true,
          status: 200,
          message: 'Restore success',
          data: {
            code: 0,
            stderr: '',
            stdout: 'all good'
          }
        });
      });
    });
  });
});
