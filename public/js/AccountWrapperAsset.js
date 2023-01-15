/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class AccountWrapperAsset extends React.Component {
  render() {
    const { balance, isQuoteAsset } = this.props;

    return (
      <div className='account-wrapper-assets'>
        <div
          className={`account-wrapper-body ${
            isQuoteAsset === false && balance.quote === null ? 'text-muted' : ''
          }`}>
          <div className='account-asset-coin d-flex justify-content-between align-items-center'>
            <span
              className={`${
                isQuoteAsset === true && balance.quote === null
                  ? 'text-warning'
                  : ''
              }`}>
              {(parseFloat(balance.free) + parseFloat(balance.locked)).toFixed(
                5
              )}{' '}
              {balance.asset}
              {isQuoteAsset === false && balance.quote === null ? (
                ''
              ) : (
                <button
                  type='button'
                  className='btn btn-sm ml-1 mb-1 text-white'
                  onClick={() => this.props.setFilter(balance.asset)}>
                  <i className={'fas fa-search fa-sm'}></i>
                </button>
              )}
            </span>
            {balance.quote !== null ? (
              <span className='text-right text-success font-weight-bold'>
                {parseFloat(balance.estimate).toFixed(5)} {balance.quote}
              </span>
            ) : (
              <div className='account-asset-row account-asset-row-valignfix'>
                <span className='account-asset-label'>placeholder</span>
              </div>
            )}
          </div>
          <div className='account-asset-row'>
            <span className='account-asset-label'>
              <span>Free</span>
            </span>
            <span className='account-asset-value'>
              {parseFloat(balance.free).toFixed(5)}
            </span>
          </div>
          <div
            className={`account-asset-row ${
              balance.locked > 0 ? 'text-warning' : ''
            }`}>
            <span className='account-asset-label'>
              <span>Locked</span>
            </span>
            <span className='account-asset-value'>
              {parseFloat(balance.locked).toFixed(5)}
            </span>
          </div>
        </div>
      </div>
    );
  }
}
