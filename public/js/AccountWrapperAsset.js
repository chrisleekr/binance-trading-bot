/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class AccountWrapperAsset extends React.Component {
  render() {
    const { balance, quoteEstimate } = this.props;

    return (
      <div className='account-wrapper-asset pt-2 pl-2 pr-2 pb-0'>
        <div className='account-wrapper-body'>
          <div className='account-asset-coin'>{balance.asset}</div>
          <div className='account-asset-row'>
            <span className='account-asset-label'>Total:</span>
            <span className='account-asset-value'>
              {(parseFloat(balance.free) + parseFloat(balance.locked)).toFixed(
                5
              )}
            </span>
          </div>
          <div className='account-asset-row'>
            <span className='account-asset-label'>Free:</span>
            <span className='account-asset-value'>
              {parseFloat(balance.free).toFixed(5)}
            </span>
          </div>
          <div className='account-asset-row'>
            <span className='account-asset-label'>Locked:</span>
            <span className='account-asset-value'>
              {parseFloat(balance.locked).toFixed(5)}
            </span>
          </div>
          {quoteEstimate !== null ? (
            <div className='account-asset-row'>
              <span className='account-asset-label text-success font-weight-bold'>
                In {quoteEstimate.quote}:
              </span>
              <span className='account-asset-value text-success font-weight-bold'>
                {parseFloat(quoteEstimate.estimate).toFixed(5)}
              </span>
            </div>
          ) : (
            <div className='account-asset-row account-asset-row-valignfix'>
              <span className='account-asset-label'>placeholder</span>
            </div>
          )}
        </div>
      </div>
    );
  }
}
