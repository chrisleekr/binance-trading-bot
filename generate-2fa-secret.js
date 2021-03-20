#!/usr/bin/env node
const otp = require('node-2fa');
const config = require('config');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

const twoFAData = {
  name: 'Binance Trading Bot',
  account: config.frontend_auth.username
};
const secret = otp.generateSecret(twoFAData);

fs.writeFileSync('./.2fa_secret', secret.secret);

const output = qrcode => {
  console.log(`Please scan the following QRCode on your 2FA authentication app or open the URL below on a web browser:
${qrcode}
${secret.qr}

Secret generated: ${secret.secret}

Warning: If you loose your secret or re-run that file, you will need to configure 2FA again on your app.
  `);
};

qrcode.generate(
  `otpauth://totp/${twoFAData.name}:${twoFAData.account}?secret=${secret.secret}`,
  { small: true },
  output
);
