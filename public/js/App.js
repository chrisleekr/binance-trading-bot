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
      symbols: [],
      accountInfo: {},
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
      selectedSortOption: 'default'
    };
    this.requestLatest = this.requestLatest.bind(this);
    this.connectWebSocket = this.connectWebSocket.bind(this);
    this.sendWebSocket = this.sendWebSocket.bind(this);
    this.setSortOption = this.setSortOption.bind(this);

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

        // Set states
        self.setState({
          symbols: sortingSymbols(
            response.stats.symbols,
            self.state.selectedSortOption
          ),
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

  setSortOption(newSortOption) {
    this.setState({
      selectedSortOption: newSortOption
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
      accountInfo,
      publicURL,
      apiInfo,
      dustTransfer,
      availableSortOptions,
      selectedSortOption
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
          sendWebSocket={this.sendWebSocket}
          availableSortOptions={availableSortOptions}
          selectedSortOption={selectedSortOption}
          setSortOption={this.setSortOption}
        />
        {_.isEmpty(configuration) === false ? (
          <div className='app-body'>
            <div className='app-body-header-wrapper'>
              <AccountWrapper
                accountInfo={accountInfo}
                dustTransfer={dustTransfer}
                sendWebSocket={this.sendWebSocket}
              />
              <ProfitLossWrapper
                symbols={symbols}
                sendWebSocket={this.sendWebSocket}
              />
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
