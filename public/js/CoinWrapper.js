/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapper extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket, configuration } = this.props;

    const className = 'coin-wrapper ' + this.props.extraClassName;

    return (
      <div className={className} data-symbol={symbolInfo.symbol}>
        <div className='coin-info-wrapper'>
          <CoinWrapperSymbol
            symbolInfo={symbolInfo}
            configuration={configuration}
            sendWebSocket={sendWebSocket}
          />
          <CoinWrapperBalance symbolInfo={symbolInfo} />
          <CoinWrapperSetting
            symbolInfo={symbolInfo}
            configuration={configuration}
            sendWebSocket={sendWebSocket}
          />

          <CoinWrapperAction
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
          />

          <CoinWrapperBuySignal symbolInfo={symbolInfo} />
          <CoinWrapperBuyOrders symbolInfo={symbolInfo} />

          <CoinWrapperSellSignal
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
          />
          <CoinWrapperSellOrders
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
          />
        </div>
      </div>
    );
  }
}
