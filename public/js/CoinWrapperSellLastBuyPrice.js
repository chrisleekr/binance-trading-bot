/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSellLastBuyPrice extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket } = this.props;

    if (symbolInfo.openOrder.type !== null) {
      return null;
    }

    return (
      <div className='coin-info-column coin-info-column-price'>
        <span className='coin-info-label coin-info-label-with-icon'>
          Last buy price:
          <SymbolEditLastBuyPriceIcon
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
          />
        </span>
        {symbolInfo.sell.lastBuyPrice > 0 ? (
          <div className='coin-info-value  coin-info-value-with-icon'>
            <HightlightChange className='coin-info-value  coin-info-value-with-icon'>
              {symbolInfo.sell.lastBuyPrice.toFixed(symbolInfo.precision)}
            </HightlightChange>
          </div>
        ) : (
          <span className='coin-info-value coin-info-value-with-icon'>N/A</span>
        )}
      </div>
    );
  }
}
