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
        { sortBy: 'default', sortByDesc: false, label: 'Default' },
        {
          sortBy: 'buy-difference',
          sortByDesc: false,
          label: 'Buy - Difference (asc)'
        },
        {
          sortBy: 'buy-difference',
          sortByDesc: true,
          label: 'Buy - Difference (desc)'
        },
        {
          sortBy: 'sell-profit',
          sortByDesc: false,
          label: 'Sell - Profit (asc)'
        },
        {
          sortBy: 'sell-profit',
          sortByDesc: true,
          label: 'Sell - Profit (desc)'
        },
        { sortBy: 'alpha', sortByDesc: false, label: 'Alphabetical (asc)' },
        { sortBy: 'alpha', sortByDesc: true, label: 'Alphabetical (desc)' }
      ],
      selectedSortOption: {
        sortBy: 'default',
        sortByDesc: false,
        hideInactive: false
      },
      searchKeyword: '',
      isLoaded: false,
      isAuthenticated: false,
      botOptions: {},
      authToken: localStorage.getItem('authToken') || '',
      totalProfitAndLoss: {},
      streamsCount: 0,
      monitoringSymbolsCount: 0,
      cachedMonitoringSymbolsCount: 0,
      page: 1,
      totalPages: 1
    };
    this.requestLatest = this.requestLatest.bind(this);
    this.connectWebSocket = this.connectWebSocket.bind(this);
    this.sendWebSocket = this.sendWebSocket.bind(this);
    this.setSortOption = this.setSortOption.bind(this);
    this.setSearchKeyword = this.setSearchKeyword.bind(this);
    this.setPage = this.setPage.bind(this);

    this.toast = this.toast.bind(this);

    this.notyf = new Notyf({
      types: [
        {
          type: 'info',
          background: '#bf9106',
          icon: {
            className: 'fas fa-info-circle fa-lg',
            tagName: 'i',
            text: '',
            color: 'white'
          }
        },
        {
          type: 'buy',
          background: '#02c076',
          icon: {
            className: 'fas fa-info-circle fa-lg',
            tagName: 'i',
            text: '',
            color: 'white'
          }
        },
        {
          type: 'sell',
          background: '#bf374a',
          icon: {
            className: 'fas fa-info-circle fa-lg',
            tagName: 'i',
            text: '',
            color: 'white'
          }
        },
        {
          type: 'success',
          background: '#17a9bf',
          icon: {
            className: 'fas fa-info-circle fa-lg',
            tagName: 'i',
            text: '',
            color: 'white'
          }
        },
        {
          type: 'warning',
          background: '#bf5e0f',
          icon: {
            className: 'fas fa-exclamation-circle fa-lg',
            tagName: 'i',
            text: '',
            color: 'white'
          }
        }
      ],
      duration: 8000,
      ripple: true,
      position: { x: 'right', y: 'bottom' },
      dismissible: true
    });
  }

  requestLatest() {
    this.sendWebSocket('latest', {
      page: this.state.page,
      searchKeyword: this.state.searchKeyword,
      sortBy: this.state.selectedSortOption.sortBy,
      sortByDesc: this.state.selectedSortOption.sortByDesc,
      hideInactive: this.state.selectedSortOption.hideInactive
    });
  }

  toast({ type, title }) {
    // this.notyf.dismissAll();
    if (type !== 'warning' && type !== 'error') {
      if (title.toLowerCase().includes('buy ')) {
        type = 'buy';
      }
      if (title.toLowerCase().includes('sell ')) {
        type = 'sell';
      }
    }
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
          symbols: _.get(response, ['stats', 'symbols'], []),
          packageVersion: _.get(response, ['common', 'version'], ''),
          gitHash: _.get(response, ['common', 'gitHash'], ''),
          accountInfo: _.get(response, ['common', 'accountInfo'], {}),
          publicURL: _.get(response, ['common', 'publicURL'], ''),
          apiInfo: _.get(response, ['common', 'apiInfo'], {}),
          totalProfitAndLoss: _.get(
            response,
            ['common', 'totalProfitAndLoss'],
            ''
          ),
          streamsCount: _.get(response, ['common', 'streamsCount'], 0),
          monitoringSymbolsCount: _.get(
            response,
            ['common', 'monitoringSymbolsCount'],
            0
          ),
          cachedMonitoringSymbolsCount: _.get(
            response,
            ['common', 'cachedMonitoringSymbolsCount'],
            0
          ),
          totalPages: _.get(response, ['common', 'totalPages'], 1)
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

      if (response.type === 'exchange-symbols-get-result') {
        self.setState({
          exchangeSymbols: response.exchangeSymbols
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

  isAccountLoaded() {
    const { isLoaded, accountInfo } = this.state;

    return isLoaded === true && _.get(accountInfo, 'accountType') === 'SPOT';
  }

  isLocked() {
    const { isAuthenticated, botOptions, isLoaded } = this.state;

    return (
      isLoaded === true &&
      isAuthenticated === false &&
      _.get(botOptions, ['authentication', 'lockList'], true) === true
    );
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
    if (searchKeyword)
      this.toast({
        type: 'success',
        title: `Filtering assets with ${searchKeyword}`
      });
    else
      this.toast({
        type: 'success',
        title: this.state.selectedSortOption.hideInactive
          ? 'Showing active symbols'
          : 'Showing all symbols'
      });

    this.setState({
      searchKeyword,
      page: 1
    });
  }

  setPage(newPage) {
    this.setState({
      page: newPage
    });
  }

  componentDidMount() {
    let selectedSortOption = {
      sortBy: 'default',
      sortByDesc: false,
      hideInactive: false
    };

    try {
      selectedSortOption = JSON.parse(
        localStorage.getItem('selectedSortOption')
      ) || {
        sortBy: 'default',
        sortByDesc: false,
        hideInactive: false
      };
    } catch (e) {}

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
      webSocket: { connected },
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
      streamsCount,
      monitoringSymbolsCount,
      cachedMonitoringSymbolsCount,
      dustTransfer,
      availableSortOptions,
      selectedSortOption,
      searchKeyword,
      isAuthenticated,
      isLoaded,
      totalProfitAndLoss,
      page,
      totalPages
    } = this.state;

    if (isLoaded === false) {
      return <AppLoading />;
    }

    if (this.isLocked()) {
      return <LockScreen />;
    }

    if (this.isAccountLoaded() === false) {
      return <APIError />;
    }

    const activeSymbols = selectedSortOption.hideInactive
      ? symbols.filter(
          s =>
            s.symbolConfiguration.buy.enabled ||
            s.symbolConfiguration.sell.enabled
        )
      : symbols;

    const coinWrappers = activeSymbols.map((symbol, index) => {
      return (
        <CoinWrapper
          extraClassName={
            index % 2 === 0 ? 'coin-wrapper-even' : 'coin-wrapper-odd'
          }
          key={'coin-wrapper-' + symbol.symbol}
          connected={connected}
          isAuthenticated={isAuthenticated}
          symbolInfo={symbol}
          configuration={configuration}
          sendWebSocket={this.sendWebSocket}
        />
      );
    });

    const paginationItems = [];

    paginationItems.push(
      <Pagination.First
        key='first'
        disabled={page === 1 || totalPages === 1}
        onClick={() => this.setPage(1)}
      />
    );
    paginationItems.push(
      <Pagination.Prev
        key='pagination-item-prev'
        onClick={() => this.setPage(page - 1)}
        disabled={page === 1 || totalPages === 1}
      />
    );
    const maxButtons = 8;
    const buttons = Math.min(maxButtons, ~~totalPages);
    [...Array(buttons).keys()].forEach(x => {
      const pageNum = Math.min(
        Math.max(x + 1, page + x + 1 - Math.ceil(buttons / 2)),
        totalPages + x + 1 - buttons
      );
      paginationItems.push(
        <Pagination.Item
          active={pageNum === page}
          disabled={pageNum > totalPages}
          key={`pagination-item-${x}`}
          onClick={() => this.setPage(pageNum)}>
          {pageNum}
        </Pagination.Item>
      );
    });
    paginationItems.push(
      <Pagination.Next
        key='pagination-item-next'
        onClick={() => this.setPage(page + 1)}
        disabled={page === totalPages || page >= totalPages}
      />
    );
    const lastPage = totalPages;
    paginationItems.push(
      <Pagination.Last
        key='last'
        disabled={page === totalPages || page >= totalPages}
        onClick={() => this.setPage(lastPage)}
      />
    );

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
                totalProfitAndLoss={totalProfitAndLoss}
                setSearchKeyword={this.setSearchKeyword}
              />
              <ProfitLossWrapper
                isAuthenticated={isAuthenticated}
                symbols={symbols}
                closedTradesSetting={closedTradesSetting}
                closedTrades={closedTrades}
                sendWebSocket={this.sendWebSocket}
                totalProfitAndLoss={totalProfitAndLoss}
              />
              <OrderStats
                orderStats={orderStats}
                selectedSortOption={selectedSortOption}
                searchKeyword={searchKeyword}
                setSearchKeyword={this.setSearchKeyword}
              />
            </div>
            <Pagination>{paginationItems}</Pagination>
            <div className='coin-wrappers'>{coinWrappers}</div>
            <Pagination>{paginationItems}</Pagination>
            <div className='app-body-footer-wrapper'>
              <Status
                apiInfo={apiInfo}
                streamsCount={streamsCount}
                monitoringSymbolsCount={monitoringSymbolsCount}
                cachedMonitoringSymbolsCount={cachedMonitoringSymbolsCount}
              />
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
