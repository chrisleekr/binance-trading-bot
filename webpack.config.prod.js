const path = require('path');
const fs = require('fs');
const LodashModuleReplacementPlugin = require('lodash-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin'); // installed via npm

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
  devtool: '#source-map',
  plugins: [
    new CleanWebpackPlugin(),
    new TerserPlugin({
      cache: true,
      parallel: true,
      sourceMap: true
    }),
    new LodashModuleReplacementPlugin()
  ],
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
          presets: [['@babel/env', { targets: { node: 13 } }]]
        }
      }
    ]
  },
  externals: nodeModules
};
