#!/usr/bin/env node
/* eslint-disable no-console */
const _ = require('lodash');
const otp = require('node-2fa');
const config = require('config');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

if (
  _.get(config, 'frontend.auth.username', null) === null ||
  _.get(config, 'frontend.auth.password', null) === null
) {
  console.log('Please configure your frontend username/password in .env file');
  process.exit(1);
}

const {
  frontend: {
    auth: { username, password }
  }
} = config;

const twoFAData = {
  name: 'Binance Trading Bot',
  account: config.frontend.auth.username
};
const secret = otp.generateSecret(twoFAData);

fs.writeFileSync('./.2fa_secret', secret.secret);

const output = qrcodeOutput => {
  console.log(`Please scan the following QRCode on your 2FA authentication app or open the URL below on a web browser:
${qrcodeOutput}
${secret.qr}

Secret generated: ${secret.secret}

Warning: If you loose your secret or re-run that file, you will need to configure 2FA again on your app.

Your username: ${username}
Your password: ${password}
  `);
};

qrcode.generate(
  `otpauth://totp/${twoFAData.name}:${twoFAData.account}?secret=${secret.secret}`,
  { small: true },
  output
);
