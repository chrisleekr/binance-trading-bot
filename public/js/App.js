/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

class App extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      webSocket: {
        instance: null,
        connected: false
      },
      packageVersion: '',
      gitHash: '',
      configuration: {},
      orderStats: {},
      exchangeSymbols: [],
      symbols: [],
      apiInfo: {},
      accountInfo: {},
      closedTrades: [],
      publicURL: '',
      dustTransfer: {},
      availableSortOptions: [
        { sortBy: 'default', label: 'Default' },
        { sortBy: 'buy-difference-asc', label: 'Buy - Difference (asc)' },
        { sortBy: 'buy-difference-desc', label: 'Buy - Difference (desc)' },
        { sortBy: 'sell-profit-asc', label: 'Sell - Profit (asc)' },
        { sortBy: 'sell-profit-desc', label: 'Sell - Profit (desc)' },
        { sortBy: 'alpha-asc', label: 'Alphabetical (asc)' },
        { sortBy: 'alpha-desc', label: 'Alphabetical (desc)' }
      ],
      selectedSortOption: 'default',
      searchKeyword: '',
      isLoaded: false,
      isAuthenticated: false,
      botOptions: {},
      authToken: localStorage.getItem('authToken') || ''
    };
    this.requestLatest = this.requestLatest.bind(this);
    this.connectWebSocket = this.connectWebSocket.bind(this);
    this.sendWebSocket = this.sendWebSocket.bind(this);
    this.setSortOption = this.setSortOption.bind(this);
    this.setSearchKeyword = this.setSearchKeyword.bind(this);

    this.toast = this.toast.bind(this);

    this.notyf = new Notyf({
      types: [
        {
          type: 'info',
          background: '#2f96b4',
          icon: {
            className: 'fas fa-info-circle fa-lg',
            tagName: 'i',
            text: '',
            color: 'white'
          }
        },
        {
          type: 'warning',
          background: '#fd7e14',
          icon: {
            className: 'fas fa-exclamation-circle fa-lg',
            tagName: 'i',
            text: '',
            color: 'white'
          }
        }
      ],
      duration: 3000,
      ripple: true,
      position: { x: 'right', y: 'bottom' },
      dismissible: true
    });
  }

  requestLatest() {
    this.sendWebSocket('latest');
  }

  toast({ type, title }) {
    // this.notyf.dismissAll();
    this.notyf.open({
      type,
      message: title
    });
  }

  connectWebSocket() {
    const instance = new WebSocket(config.webSocketUrl);

    this.setState(prevState => ({
      webSocket: {
        ...prevState.webSocket,
        instance
      }
    }));

    const self = this;

    instance.onopen = () => {
      console.log('Connection is successfully established.');
      this.toast({
        type: 'success',
        title: 'Connected to the bot.'
      });
      self.setState(prevState => ({
        webSocket: {
          ...prevState.webSocket,
          connected: true
        }
      }));
    };

    instance.onmessage = evt => {
      let response = {};
      try {
        response = JSON.parse(evt.data);
      } catch (_e) {}

      if (response.type === 'latest') {
        // Set states
        self.setState({
          isLoaded: true,
          isAuthenticated: response.isAuthenticated,
          botOptions: response.botOptions,
          configuration: response.configuration,
          orderStats: response.common.orderStats,
          closedTradesSetting: _.get(
            response,
            ['common', 'closedTradesSetting'],
            {}
          ),
          closedTrades: _.get(response, ['common', 'closedTrades'], []),
          symbols: sortingSymbols(_.get(response, ['stats', 'symbols'], []), {
            selectedSortOption: self.state.selectedSortOption,
            searchKeyword: self.state.searchKeyword
          }),
          packageVersion: _.get(response, ['common', 'version'], ''),
          gitHash: _.get(response, ['common', 'gitHash'], ''),
          exchangeSymbols: _.get(response, ['common', 'exchangeSymbols'], []),
          accountInfo: _.get(response, ['common', 'accountInfo'], {}),
          publicURL: _.get(response, ['common', 'publicURL'], ''),
          apiInfo: _.get(response, ['common', 'apiInfo'], {})
        });
      }

      if (response.type === 'notification') {
        this.toast({
          type: response.message.type,
          title: response.message.title
        });
      }

      if (response.type === 'dust-transfer-get-result') {
        self.setState({
          dustTransfer: response.dustTransfer
        });
      }
    };

    instance.onclose = () => {
      console.log('Socket is closed. Reconnect will be attempted in 1 second.');

      this.toast({
        type: 'info',
        title: 'Disconnected from the bot. Reconnecting...'
      });
      self.setState(prevState => ({
        webSocket: {
          ...prevState.webSocket,
          connected: false
        }
      }));

      setTimeout(function () {
        self.connectWebSocket();
      }, 1000);
    };
  }

  sendWebSocket(command, data = {}) {
    const { instance, connected } = this.state.webSocket;

    if (connected) {
      const authToken = localStorage.getItem('authToken') || '';

      instance.send(JSON.stringify({ command, authToken, data }));
    }
  }

  setSortOption(newSortOption) {
    this.setState({
      selectedSortOption: newSortOption
    });
  }

  setSearchKeyword(searchKeyword) {
    this.setState({
      searchKeyword
    });
  }

  componentDidMount() {
    const selectedSortOption =
      localStorage.getItem('selectedSortOption') || 'default';

    this.setState({
      selectedSortOption
    });

    this.connectWebSocket();

    this.timerID = setInterval(() => this.requestLatest(), 1000);
  }

  componentWillUnmount() {
    clearInterval(this.timerID);
  }

  render() {
    const {
      packageVersion,
      gitHash,
      exchangeSymbols,
      symbols,
      configuration,
      orderStats,
      accountInfo,
      closedTradesSetting,
      closedTrades,
      publicURL,
      apiInfo,
      dustTransfer,
      availableSortOptions,
      selectedSortOption,
      searchKeyword,
      isAuthenticated,
      botOptions,
      isLoaded
    } = this.state;

    if (isLoaded === false) {
      return <AppLoading />;
    }

    if (
      isLoaded === true &&
      isAuthenticated === false &&
      _.get(botOptions, ['authentication', 'lockList'], true) === true
    ) {
      return <LockScreen />;
    }

    const coinWrappers = symbols.map((symbol, index) => {
      return (
        <CoinWrapper
          extraClassName={
            index % 2 === 0 ? 'coin-wrapper-even' : 'coin-wrapper-odd'
          }
          key={'coin-wrapper-' + symbol.symbol}
          isAuthenticated={isAuthenticated}
          symbolInfo={symbol}
          configuration={configuration}
          sendWebSocket={this.sendWebSocket}
        />
      );
    });

    const symbolEstimates = symbols.map(symbol => {
      return {
        baseAsset: symbol.symbolInfo.baseAsset,
        quoteAsset: symbol.symbolInfo.quoteAsset,
        estimatedValue: symbol.baseAssetBalance.estimatedValue,
        tickSize: symbol.symbolInfo.filterPrice.tickSize
      };
    });

    return (
      <React.Fragment>
        <Header
          isAuthenticated={isAuthenticated}
          configuration={configuration}
          publicURL={publicURL}
          exchangeSymbols={exchangeSymbols}
          sendWebSocket={this.sendWebSocket}
          availableSortOptions={availableSortOptions}
          selectedSortOption={selectedSortOption}
          searchKeyword={searchKeyword}
          setSortOption={this.setSortOption}
          setSearchKeyword={this.setSearchKeyword}
        />
        {_.isEmpty(configuration) === false ? (
          <div className='app-body'>
            <div className='app-body-header-wrapper'>
              <AccountWrapper
                isAuthenticated={isAuthenticated}
                accountInfo={accountInfo}
                dustTransfer={dustTransfer}
                sendWebSocket={this.sendWebSocket}
                quoteEstimates={symbolEstimates}
              />
              <ProfitLossWrapper
                isAuthenticated={isAuthenticated}
                symbols={symbols}
                closedTradesSetting={closedTradesSetting}
                closedTrades={closedTrades}
                sendWebSocket={this.sendWebSocket}
                symbolEstimates={symbolEstimates}
              />
              <OrderStats orderStats={orderStats} />
            </div>
            <div className='coin-wrappers'>{coinWrappers}</div>
            <div className='app-body-footer-wrapper'>
              <Status apiInfo={apiInfo} />
            </div>
          </div>
        ) : (
          <div className='app-body app-body-loading'>
            <Spinner animation='border' role='status'>
              <span className='sr-only'>Loading...</span>
            </Spinner>
          </div>
        )}

        <Footer packageVersion={packageVersion} gitHash={gitHash} />
      </React.Fragment>
    );
  }
}

ReactDOM.render(<App />, document.querySelector('#app'));
