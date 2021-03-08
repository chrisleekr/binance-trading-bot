/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapper extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket, configuration } = this.props;

    const className = 'coin-wrapper ' + this.props.extraClassName;

    const symbolConfiguration = _.defaultsDeep(
      symbolInfo.configuration,
      configuration
    );

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
            symbolConfiguration={symbolConfiguration}
            sendWebSocket={sendWebSocket}
          />
          <CoinWrapperBuy
            symbolInfo={symbolInfo}
            symbolConfiguration={symbolConfiguration}
          />
          <CoinWrapperSell
            symbolInfo={symbolInfo}
            symbolConfiguration={symbolConfiguration}
            sendWebSocket={sendWebSocket}
          />
          <CoinWrapperOpenOrder
            symbolInfo={symbolInfo}
            symbolConfiguration={symbolConfiguration}
          />
        </div>
      </div>
    );
  }
}
