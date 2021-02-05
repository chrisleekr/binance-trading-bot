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
      configuration: {},
      symbols: []
    };
    this.requestWebSocket = this.requestWebSocket.bind(this);
    this.connectWebSocket = this.connectWebSocket.bind(this);
    this.sendWebSocket = this.sendWebSocket.bind(this);
  }

  requestWebSocket() {
    this.sendWebSocket('latest');
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
        self.setState({
          symbols: _.sortBy(response.stats.symbols, s => {
            if (s.openOrder.difference) {
              return s.openOrder.difference * -1;
            }
            return s.buy.difference;
          }),
          configuration: response.configuration
        });
      }
    };

    instance.onclose = () => {
      console.log('Socket is closed. Reconnect will be attempted in 1 second.');

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

    this.timerID = setInterval(() => this.requestWebSocket(), 1000);
  }

  componentWillUnmount() {
    clearInterval(this.timerID);
  }

  render() {
    const { symbols, configuration } = this.state;

    const coinWrappers = symbols.map((symbol, index) => {
      return (
        <CoinWrapper
          extraClassName={
            index % 2 === 0 ? 'coin-wrapper-even' : 'coin-wrapper-odd'
          }
          key={symbol.symbol}
          symbolInfo={symbol}
        />
      );
    });
    return (
      <div className='app'>
        <Header
          configuration={configuration}
          sendWebSocket={this.sendWebSocket}
        />
        <div className='coin-wrappers'>{coinWrappers}</div>
      </div>
    );
  }
}

ReactDOM.render(<App />, document.querySelector('#app'));
