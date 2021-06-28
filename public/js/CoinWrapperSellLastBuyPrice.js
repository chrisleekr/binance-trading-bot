/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSellLastBuyPrice extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket, jsonStrings } = this.props;

    const {
      symbolInfo: {
        filterPrice: { tickSize }
      },
      sell
    } = symbolInfo;

    const { commonStrings } = jsonStrings;
    const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    return (
      <div className='coin-info-column coin-info-column-price'>
        <span className='coin-info-label coin-info-label-with-icon'>
          {commonStrings.last_buy_price}:
          <SymbolEditLastBuyPriceIcon
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
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
        <span className='coin-info-label coin-info-label-with-icon'>
          - Average Price:
        </span>
        {sell.averageLastBuyPrices != null ? (
          <div className='coin-info-value  coin-info-value-with-icon'>
            <HightlightChange className='coin-info-value coin-info-value-with-icon'>
              {sell.averageLastBuyPrices.toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          <span className='coin-info-value coin-info-value-with-icon'>N/A</span>
        )}
      </div>
    );
  }
}
