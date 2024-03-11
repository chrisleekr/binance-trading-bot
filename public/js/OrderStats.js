/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class OrderStats extends React.Component {
  render() {
    const { orderStats, selectedSortOption, searchKeyword } = this.props;

    if (_.isEmpty(orderStats)) {
      return '';
    }

    return (
      <div className='order-stats-wrapper bg-dark p-2 px-3 mb-2'>
        <div className='order-stat-wrapper'>
          <button
            type='button'
            className={`btn btn-span ${
              orderStats.numberOfBuyOpenOrders ? '' : 'btn-span-disabled'
            }`}
            onClick={() => this.props.setSearchKeyword('open orders')}>
            <span className='order-stat-label'>Open Buy Orders</span>
            <span className='order-stat-value text-info'>
              {orderStats.numberOfBuyOpenOrders}
            </span>
          </button>
        </div>
        <div className='order-stat-wrapper'>
          <button
            type='button'
            className={`btn btn-span ${
              orderStats.numberOfOpenTrades ? '' : 'btn-span-disabled'
            }`}
            onClick={() => this.props.setSearchKeyword('open trades')}>
            <span className='order-stat-label'>Open Trades</span>
            <span className='order-stat-value text-info'>
              {orderStats.numberOfOpenTrades}
            </span>
          </button>
        </div>
        {searchKeyword ? (
          <div className='order-stat-wrapper'>
            <span className='order-stat-label'>Filtering</span>
            <span className='order-stat-value text-info text-capitalize'>
              {searchKeyword}

              <button
                type='button'
                className={'btn btn-span p-0 pl-1 text-white'}
                onClick={() => this.props.setSearchKeyword()}>
                <i className='fas fa-times-circle'></i>
              </button>
            </span>
          </div>
        ) : (
          ''
        )}
        {selectedSortOption.hideInactive && !searchKeyword ? (
          <div className='order-stat-wrapper'>
            <span className='order-stat-label'>Some coins are hidden</span>
          </div>
        ) : (
          ''
        )}
      </div>
    );
  }
}
