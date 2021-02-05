/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapper extends React.Component {
  render() {
    const { symbolInfo } = this.props;

    const className = 'coin-wrapper ' + this.props.extraClassName;

    return (
      <div className={className} data-symbol={symbolInfo.symbol}>
        <div className='coin-info-wrapper'>
          <div className='coin-info-column coin-info-column-name'>
            <a
              href={`https://www.binance.com/en/trade/${symbolInfo.symbol}?layout=pro`}
              target='_blank'
              rel='noreferrer'>
              {symbolInfo.symbol}
            </a>
          </div>
          <CoinWrapperBalance symbolInfo={symbolInfo} />
          <CoinWrapperBuy symbolInfo={symbolInfo} />
          <CoinWrapperSell symbolInfo={symbolInfo} />
          <CoinWrapperOpenOrder symbolInfo={symbolInfo} />
        </div>
      </div>
    );
  }
}
