/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSymbol extends React.Component {
  constructor(props) {
    super(props);

    this.handleDelete = this.handleDelete.bind(this);
  }

  handleDelete(e) {
    e.preventDefault();
    const { symbolInfo } = this.props;
    this.props.sendWebSocket('symbol-delete', {
      symbolInfo
    });
  }

  render() {
    const { symbolInfo } = this.props;

    return (
      <div className='coin-info-sub-wrapper coin-info-sub-wrapper-symbol'>
        <div className='coin-info-column coin-info-column-name'>
          <a
            href={`https://www.binance.com/en/trade/${symbolInfo.symbol}?layout=pro`}
            target='_blank'
            rel='noreferrer'>
            {symbolInfo.symbol}
          </a>
        </div>
        <div className='coin-info-column coin-info-column-icon'>
          {symbolInfo.sell.lastBuyPrice <= 0 && (
            <button
              type='button'
              className='btn btn-link btn-sm m-0 p-0'
              onClick={this.handleDelete}>
              X
            </button>
          )}
        </div>
      </div>
    );
  }
}
