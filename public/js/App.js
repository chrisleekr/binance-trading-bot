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
      exchangeSymbols: [],
      // This list is from binance FIAT markets. Dosn't need to be dynamic.
      exchangeFIATs: [
        'USDT',
        'BUSD',
        'BRL',
        'EUR',
        'GBP',
        'TRY',
        'TUSD',
        'USDC',
        'PAX',
        'AUD',
        'BIDR',
        'DAI',
        'IDRT',
        'RUB',
        'ZAR',
        'NGN',
        'UAH',
        'VAI',
        'BVND'
      ],
      symbols: [],
      accountInfo: {},
      publicURL: '',
      totalPnL: {}
    };
    this.requestLatest = this.requestLatest.bind(this);
    this.connectWebSocket = this.connectWebSocket.bind(this);
    this.sendWebSocket = this.sendWebSocket.bind(this);

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
        if (_.isEmpty(response.common.accountInfo)) {
          return;
        }

        // Calculate total profit/loss
        const totalPnL = {};
        _.forEach(response.stats.symbols, s => {
          if (totalPnL[s.quoteAssetBalance.asset] === undefined) {
            totalPnL[s.quoteAssetBalance.asset] = {
              asset: s.quoteAssetBalance.asset,
              amount: 0,
              profit: 0
            };
          }

          totalPnL[s.quoteAssetBalance.asset].amount +=
            (parseFloat(s.baseAssetBalance.free) +
              parseFloat(s.baseAssetBalance.free)) *
            s.sell.lastBuyPrice;
          totalPnL[s.quoteAssetBalance.asset].profit += s.sell.currentProfit;
        });

        // Set states
        self.setState({
          totalPnL,
          symbols: _.sortBy(response.stats.symbols, s => {
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
          }),
          packageVersion: response.common.version,
          gitHash: response.common.gitHash,
          exchangeSymbols: response.common.exchangeSymbols,
          configuration: response.common.configuration,
          accountInfo: response.common.accountInfo,
          publicURL: response.common.publicURL,
          apiInfo: response.common.apiInfo
        });
      }

      if (response.type === 'notification') {
        this.toast({
          type: response.message.type,
          title: response.message.title
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
      exchangeFIATs,
      symbols,
      configuration,
      accountInfo,
      publicURL,
      apiInfo,
      totalPnL
    } = this.state;

    const coinWrappers = symbols.map((symbol, index) => {
      return (
        <CoinWrapper
          extraClassName={
            index % 2 === 0 ? 'coin-wrapper-even' : 'coin-wrapper-odd'
          }
          key={'coin-wrapper-' + symbol.symbol}
          symbolInfo={symbol}
          configuration={configuration}
          sendWebSocket={this.sendWebSocket}
        />
      );
    });

    return (
      <div className='app'>
        <Header
          configuration={configuration}
          publicURL={publicURL}
          exchangeSymbols={exchangeSymbols}
          exchangeFIATs={exchangeFIATs}
          sendWebSocket={this.sendWebSocket}
        />
        {_.isEmpty(configuration) === false ? (
          <div className='app-body'>
            <div className='app-body-header-wrapper'>
              <AccountWrapper accountInfo={accountInfo} />
              <ProfitLossWrapper totalPnL={totalPnL} />
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
      </div>
    );
  }
}

ReactDOM.render(<App />, document.querySelector('#app'));
