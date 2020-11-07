const path = require('path');
const fs = require('fs');

const { NODE_ENV = 'production' } = process.env;

const nodeModules = {};
fs.readdirSync('node_modules')
  .filter(x => {
    return ['.bin'].indexOf(x) === -1;
  })
  .forEach(mod => {
    nodeModules[mod] = `commonjs ${mod}`;
  });

module.exports = {
  entry: './app/server.js',
  target: 'node',
  mode: NODE_ENV,
  output: {
    filename: 'server.js',
    path: path.resolve(__dirname, 'dist')
  },
  resolve: {
    extensions: ['.js']
  },
  module: {
    rules: [
      {
        // Transpiles ES6-8 into ES5
        loader: 'babel-loader',
        test: /\.js$/,
        exclude: /node_modules/,
        options: {
          plugins: ['lodash'],
          presets: [['@babel/env', { targets: { node: 14 } }]]
        }
      }
    ]
  },
  externals: nodeModules
};
