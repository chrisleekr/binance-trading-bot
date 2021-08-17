/* eslint-disable global-require */
const fs = require('fs');

describe('concat', () => {
  let grunt;
  let mockInitConfig;
  let mockLoadNpmTasks;
  let mockRegisterTask;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockInitConfig = jest.fn().mockResolvedValue(true);
    mockLoadNpmTasks = jest.fn().mockResolvedValue(true);
    mockRegisterTask = jest.fn().mockResolvedValue(true);
    grunt = {
      initConfig: mockInitConfig,
      loadNpmTasks: mockLoadNpmTasks,
      registerTask: mockRegisterTask
    };
  });

  describe('has all files?', () => {
    beforeEach(() => {
      const Gruntfile = require('../Gruntfile');
      Gruntfile(grunt);
    });

    it('check concat src files', () => {
      const srcFiles = fs
        .readdirSync(`${__dirname}/../public/js/`)
        .map(f => `./public/dist/js/${f.replace('.js', '.min.js')}`);
      const gruntArgs = mockInitConfig.mock.calls[0][0];

      expect(gruntArgs.concat.dist.src.sort()).toMatchObject(srcFiles.sort());
    });
  });
});
