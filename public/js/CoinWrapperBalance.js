/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBalance extends React.Component {
  render() {
    const { symbolInfo } = this.props;

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

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <span className='coin-info-label'>Balance</span>
          <span className='coin-info-value'>{baseAssetBalance.asset}</span>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>Free:</span>
          <HightlightChange className='coin-info-value'>
            {parseFloat(baseAssetBalance.free).toFixed(basePrecision)}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>Locked:</span>
          <HightlightChange className='coin-info-value'>
            {parseFloat(baseAssetBalance.locked).toFixed(basePrecision)}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>Estimated Value:</span>
          <HightlightChange className='coin-info-value'>
            {parseFloat(baseAssetBalance.estimatedValue).toFixed(
              quotePrecision
            )}{' '}
            {quoteAsset}
          </HightlightChange>
        </div>
      </div>
    );
  }
}
