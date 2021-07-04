/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBalance extends React.Component {
  render() {
    const { symbolInfo, jsonStrings } = this.props;

    const {
      symbolInfo: {
        filterLotSize: { stepSize },
        filterPrice: { tickSize }
      },
      baseAssetBalance,
      quoteAssetBalance: { asset: quoteAsset }
    } = symbolInfo;

    const basePrecision =
      parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
    const quotePrecision =
      parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    const { coin_wrapper, common_strings } = jsonStrings;

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <span className='coin-info-label'>{common_strings._balance}</span>
          <span className='coin-info-value'>{baseAssetBalance.asset}</span>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>{common_strings._trending} Husky:</span>
          <HightlightChange className='coin-info-value'>
            {symbolInfo.indicators.trend} - {common_strings._strength}: {symbolInfo.indicators.trendDiff}%
          </HightlightChange>
        </div >

        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>{common_strings._free}:</span>
          <HightlightChange className='coin-info-value'>
            {parseFloat(baseAssetBalance.free).toFixed(basePrecision)}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>{common_strings._locked}:</span>
          <HightlightChange className='coin-info-value'>
            {parseFloat(baseAssetBalance.locked).toFixed(basePrecision)}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>{coin_wrapper.estimated_value}:</span>
          <HightlightChange className='coin-info-value'>
            {parseFloat(baseAssetBalance.estimatedValue).toFixed(
              quotePrecision
            )}{' '}
            {quoteAsset}
          </HightlightChange>
        </div>
      </div >
    );
  }
}
