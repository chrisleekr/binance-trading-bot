/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

let languageReady = '';
let languageData = {};
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
      exchangeSymbols: [],
      symbols: [],
      accountInfo: {},
      publicURL: '',
      dustTransfer: {},
      passwordActivated: false,
      searchKeyword: '',
      sortType: 'default',
      pastTrades: {}
    };
    this.requestLatest = this.requestLatest.bind(this);
    this.connectWebSocket = this.connectWebSocket.bind(this);
    this.sendWebSocket = this.sendWebSocket.bind(this);
    this.searchKeyword = this.searchKeyword.bind(this);
    this.sortSymbols = this.sortSymbols.bind(this);

    this.toast = this.toast.bind(this);

    this.notyf = new Notyf({
      types: [
        {
          type: 'info',
          background: '#2f96b4',
          icon: {
            className: 'fa fa-info-circle fa-lg',
            tagName: 'i',
            text: '',
            color: 'white'
          }
        },
        {
          type: 'warning',
          background: '#fd7e14',
          icon: {
            className: 'fa fa-exclamation-circle fa-lg',
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

  searchKeyword(searchKeyword) {

    this.setState({
      searchKeyword
    });
  }

  sortSymbols(sortType) {

    this.setState({
      sortType
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
      } catch (_e) { }

      if (response.type === 'latest') {
        if (_.isEmpty(response.common.accountInfo)) {
          return;
        }

        let symbols = response.stats.symbols;
        switch (this.state.sortType) {
          case 'name':
            symbols = _.sortBy(symbols, 'symbol');
            break;

          case 'buy':
            symbols = _.sortBy(symbols, 'buy.difference');
            break;

          case 'sell':
            symbols = _.sortBy(symbols, 'sell.difference');
            break;

          case 'profit':
            symbols = _.sortBy(symbols, 'sell.currentProfitPercentage');
            break;

          default:
            symbols = _.sortBy(response.stats.symbols, s => {
              if (s.buy.openOrders.length > 0) {
                const openOrder = s.buy.openOrders[0];
                if (openOrder.differenceToCancel) {
                  return (openOrder.differenceToCancel + 3000) * -10;
                }
              }
              if (s.sell.openOrders.length > 0) {
                const openOrder = s.sell.openOrders[0];
                if (openOrder.differenceToCancel) {
                  return (openOrder.differenceToCancel + 2000) * -10;
                }
              }
              if (s.sell.difference) {
                return (s.sell.difference + 1000) * -10;
              }
              return s.buy.difference;
            })
            break;
        }

        // Set states
        self.setState({
          symbols,
          packageVersion: response.common.version,
          gitHash: response.common.gitHash,
          exchangeSymbols: response.common.exchangeSymbols,
          configuration: response.common.configuration,
          accountInfo: response.common.accountInfo,
          publicURL: response.common.publicURL,
          apiInfo: response.common.apiInfo,
          passwordActivated: response.common.passwordActivated,
          login: response.common.login,
          pastTrades: response.common.pastTrades
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
      instance.send(JSON.stringify({ command, data }));
    }
  }

  componentDidMount() {
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
      accountInfo,
      publicURL,
      apiInfo,
      dustTransfer,
      login,
      passwordActivated,
      searchKeyword,
      pastTrades
    } = this.state;

    if (configuration.botOptions != undefined) {
      if (languageReady != configuration.botOptions.language) {
        languageReady = configuration.botOptions.language;

        fetch(configuration.botOptions.language + ".json")
          .then(res => res.json())
          .then(data => languageData = data);
      }

      if (login === {} || passwordActivated && !login.logged) {
        return (
          <div className='app' >
            <PasswordScreen
              jsonStrings={languageData}
              configuration={configuration}
              sendWebSocket={this.sendWebSocket}
            />
          </div>
        );
      }

      if (login.logged) {

        if (languageData != undefined) {
          const coinWrappers = symbols.map((symbol, index) => {
            if (searchKeyword != '') {
              if (symbol.symbol.includes(searchKeyword)) {
                return (
                  <CoinWrapper
                    extraClassName={
                      index % 2 === 0 ? 'coin-wrapper-even' : 'coin-wrapper-odd'
                    }
                    key={'coin-wrapper-' + symbol.symbol}
                    symbolInfo={symbol}
                    configuration={configuration}
                    sendWebSocket={this.sendWebSocket}
                    jsonStrings={languageData}
                  />
                );
              }
            } else {
              return (
                <CoinWrapper
                  extraClassName={
                    index % 2 === 0 ? 'coin-wrapper-even' : 'coin-wrapper-odd'
                  }
                  key={'coin-wrapper-' + symbol.symbol}
                  symbolInfo={symbol}
                  configuration={configuration}
                  sendWebSocket={this.sendWebSocket}
                  jsonStrings={languageData}
                />
              );
            }
          });

          return (
            <div className='app' >
              <Header
                configuration={configuration}
                publicURL={publicURL}
                exchangeSymbols={exchangeSymbols}
                sendWebSocket={this.sendWebSocket}
                jsonStrings={languageData}
              />
              {_.isEmpty(configuration) === false ? (
                <div className='app-body'>
                  <div className='app-body-header-wrapper'>
                    <AccountWrapper
                      accountInfo={accountInfo}
                      dustTransfer={dustTransfer}
                      sendWebSocket={this.sendWebSocket}
                      jsonStrings={languageData}
                    />
                    <ProfitLossWrapper
                      symbols={symbols}
                      sendWebSocket={this.sendWebSocket}
                      jsonStrings={languageData}
                    />
                    <MonitorOptionsWrapper
                      jsonStrings={languageData}
                      searchKeyword={this.searchKeyword}
                      sortSymbols={this.sortSymbols} />
                  </div>
                  <div className='coin-wrappers'>{coinWrappers}</div>
                  <div className='app-body-footer-wrapper'>
                    <Status apiInfo={apiInfo} jsonStrings={languageData} />
                  </div>
                </div>
              ) : (
                <div className='app-body app-body-loading'>
                  <Spinner animation='border' role='status'>
                    <span className='sr-only'>Loading...</span>
                  </Spinner>
                </div>
              )}

              <PastTradesWrapper
                pastTrades={pastTrades}
                jsonStrings={languageData}
              />

              <Footer packageVersion={packageVersion} gitHash={gitHash} jsonStrings={languageData} />
            </div >
          );
        } else {
          return '';
        }
      } else {
        return '';
      }
    } else {
      return '';
    }
  }
}

ReactDOM.render(<App />, document.querySelector('#app'));
