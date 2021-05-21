/* eslint-disable global-require */

describe('pubsub.js', () => {
  let PubSubMock;
  beforeEach(() => {
    jest.mock('pubsub-js');
    const PubSub = require('../pubsub');

    PubSubMock = PubSub;
  });
  it('defines expected', () => {
    expect(PubSubMock).toBeDefined();
  });
});
