/**
 * Gruntfile
 *  - compiling JSX files and concatenate them into a single file.
 *  - minifing CSS file
 *
 * @param {*} grunt
 */
module.exports = grunt => {
  // Project configuration.
  grunt.initConfig({
    // Compile Javascript files; so I don't need to use bable-standalone.
    babel: {
      options: {
        sourceMap: false,
        comments: false,
        compact: true,
        plugins: ['@babel/plugin-transform-react-jsx']
      },
      files: {
        expand: true,
        cwd: './public/js/',
        src: ['**/*.js'],
        dest: './public/dist/js/',
        ext: '.min.js',
        extDot: 'first'
      }
    },
    // Concat all compiled files to single files.
    //    All files in the src are not working.
    //    The files should be listed in the src option in sequence.
    //    Otherwise, it may not see undefined.
    concat: {
      options: {},
      dist: {
        src: [
          './public/dist/js/Config.min.js',
          './public/dist/js/HighlightChange.min.js',
          './public/dist/js/CoinWrapperSellLastBuyPrice.min.js',
          './public/dist/js/CoinWrapperSetting.min.js',
          './public/dist/js/CoinWrapperSellOrders.min.js',
          './public/dist/js/CoinWrapperSellSignal.min.js',
          './public/dist/js/CoinWrapperBuyOrders.min.js',
          './public/dist/js/CoinWrapperBuySignal.min.js',
          './public/dist/js/SymbolManualTradeIcon.min.js',
          './public/dist/js/CoinWrapperAction.min.js',
          './public/dist/js/CoinWrapperBalance.min.js',
          './public/dist/js/SymbolGridTradeArchiveIcon.min.js',
          './public/dist/js/SymbolCancelIcon.min.js',
          './public/dist/js/SymbolEnableActionIcon.min.js',
          './public/dist/js/SymbolDeleteIcon.min.js',
          './public/dist/js/SymbolEditLastBuyPriceIcon.min.js',
          './public/dist/js/SymbolTriggerSellIcon.min.js',
          './public/dist/js/SymbolTriggerBuyIcon.min.js',
          './public/dist/js/SymbolSettingIconBotOptions.min.js',
          './public/dist/js/SymbolSettingIconGridBuy.min.js',
          './public/dist/js/SymbolSettingIconGridSell.min.js',
          './public/dist/js/SymbolSettingIcon.min.js',
          './public/dist/js/CoinWrapperSymbol.min.js',
          './public/dist/js/CoinWrapper.min.js',
          './public/dist/js/DustTransferIcon.min.js',
          './public/dist/js/ManualTradeIcon.min.js',
          './public/dist/js/SettingIconGridSell.min.js',
          './public/dist/js/SettingIconGridBuy.min.js',
          './public/dist/js/SettingIconBotOptions.min.js',
          './public/dist/js/SettingIconLastBuyPriceRemoveThreshold.min.js',
          './public/dist/js/SettingIcon.min.js',
          './public/dist/js/AccountWrapperAsset.min.js',
          './public/dist/js/AccountWrapper.min.js',
          './public/dist/js/QuoteAssetGridTradeArchiveIcon.min.js',
          './public/dist/js/ProfitLossWrapper.min.js',
          './public/dist/js/Status.min.js',
          './public/dist/js/Footer.min.js',
          './public/dist/js/FilterIcon.min.js',
          './public/dist/js/LockIcon.min.js',
          './public/dist/js/UnlockIcon.min.js',
          './public/dist/js/Header.min.js',
          './public/dist/js/LockScreen.min.js',
          './public/dist/js/AppSorting.min.js',
          './public/dist/js/AppLoading.min.js',
          './public/dist/js/App.min.js'
        ],
        dest: './public/dist/App.min.js'
      }
    },
    cssmin: {
      target: {
        files: {
          './public/dist/App.min.css': ['./public/css/App.css']
        }
      }
    },
    clean: ['./public/dist/js']
  });

  grunt.loadNpmTasks('grunt-babel');
  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-cssmin');
  grunt.loadNpmTasks('grunt-contrib-clean');

  // Default task(s).
  grunt.registerTask('default', ['babel', 'concat', 'cssmin', 'clean']);
};
