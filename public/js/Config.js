/* eslint-disable no-unused-vars */
/* eslint-disable no-restricted-globals */

const config = {
  webSocketUrl:
    location.protocol === 'https:'
      ? `wss://${location.hostname}${
          location.port !== 80 ? ':' + location.port : ''
        }`
      : `ws://${location.hostname}${
          location.port !== 80 ? ':' + location.port : ''
        }`
};
