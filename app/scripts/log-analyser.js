/* istanbul ignore file */
/* eslint-disable no-console */
const _ = require('lodash');
const fs = require('fs');

const myArgs = process.argv.slice(2);

const filename = myArgs[0] || '';
if (filename === '') {
  console.log('No file provided.');
  process.exit(1);
}

const rawdata = fs.readFileSync(filename);
let logs;
try {
  logs = JSON.parse(rawdata);
} catch (e) {
  console.log('Error while parsing CSV file.');
  process.exit(1);
}

const csvRows = [
  [
    'CorrelationID',
    'Logged At',
    'Message',
    'Step Name',
    'Base Balance',
    'Order Status',
    'Executed Qty',
    'New Quantity',
    'New Last Buy Price'
  ]
];

logs.forEach(log => {
  const csvRow = [
    _.get(log, 'data.correlationId', ''),
    _.get(log, 'loggedAt', ''),
    _.get(log, 'msg', ''),
    _.get(log, 'data.stepName', ''),
    _.get(log, 'data.data.baseAssetBalance.total', ''),
    _.get(log, 'data.evt.status', ''),
    _.get(log, 'data.evt.quantity', ''),
    _.get(log, 'data.newQuantity', ''),
    _.get(log, 'data.newLastBuyPrice', '')
  ];

  csvRows.push(csvRow);
});

let csvData = '';
csvRows.forEach(csvRow => {
  csvData += `${csvRow
    .map(c => `"${c ? `${c}`.replace(/"/g, "'") : ''}"`)
    .join(',')}\r\n`;
});
fs.writeFileSync('result.csv', csvData);
