/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSellAveragedPrice extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket, jsonStrings } = this.props;

    const {
      symbolInfo: {
        filterPrice: { tickSize }
      },
      sell
    } = symbolInfo;

    const { common_strings } = jsonStrings;
    const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    if (sell.gridStrategyActivated) {
      return (
        <div className='coin-info-column coin-info-column-price'>
          <span className='coin-info-label coin-info-label'>
            {common_strings.last_buy_price}:
          </span>
          {sell.lastBoughtPrice > 0 ? (
            <div className='coin-info-value  coin-info-value'>
              <HightlightChange className='coin-info-value coin-info-value'>
                {sell.lastBoughtPrice.toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            <span className='coin-info-value coin-info-value-with-icon'>N/A</span>
          )}
        </div>
      );
    } else {
      return '';
    }
  }
}
