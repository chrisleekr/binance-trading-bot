/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSellLastBuyPrice extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket } = this.props;

    const {
      symbolInfo: {
        filterPrice: { tickSize }
      },
      sell
    } = symbolInfo;

    const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    return (
      <div className='coin-info-column coin-info-column-price'>
        <span className='coin-info-label coin-info-label-with-icon'>
          Last buy price:
          <SymbolEditLastBuyPriceIcon
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
          />
        </span>
        {sell.lastBuyPrice > 0 ? (
          <div className='coin-info-value  coin-info-value-with-icon'>
            <HightlightChange className='coin-info-value coin-info-value-with-icon'>
              {sell.lastBuyPrice.toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          <span className='coin-info-value coin-info-value-with-icon'>N/A</span>
        )}
      </div>
    );
  }
}
