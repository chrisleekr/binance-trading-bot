/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSetting extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      collapsed: true
    };

    this.toggleCollapse = this.toggleCollapse.bind(this);
  }

  toggleCollapse() {
    this.setState({
      collapsed: !this.state.collapsed
    });
  }

  render() {
    const { collapsed } = this.state;
    const { symbolInfo } = this.props;
    const { symbolConfiguration } = symbolInfo;

    const {
      quoteAssetBalance: { asset: quoteAsset }
    } = symbolInfo;

    return (
      <div className='coin-info-sub-wrapper coin-info-sub-wrapper-setting'>
        <div className='coin-info-column coin-info-column-title coin-info-column-title-setting'>
          <div className='coin-info-label'>
            <div className='mr-1'>Setting</div>
          </div>

          <button
            type='button'
            className='btn btn-sm btn-link p-0 ml-1'
            onClick={this.toggleCollapse}>
            <i
              className={`fa ${
                collapsed ? 'fa-arrow-right' : 'fa-arrow-down'
              }`}></i>
          </button>
        </div>
        <div
          className={`coin-info-content-setting ${collapsed ? 'd-none' : ''}`}>
          <div className='coin-info-sub-wrapper'>
            <span className='coin-info-sub-label'>Candles</span>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Interval:</span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.candles.interval}
              </HightlightChange>
            </div>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Limit:</span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.candles.limit}
              </HightlightChange>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <span className='coin-info-sub-label'>Buy</span>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Trading enabled:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.buy.enabled ? (
                  <i className='fa fa-toggle-on'></i>
                ) : (
                  <i className='fa fa-toggle-off'></i>
                )}
              </span>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Max purchase amount:</span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.buy.maxPurchaseAmount} {quoteAsset}
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                Remove last buy price under:
              </span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.buy.lastBuyPriceRemoveThreshold}{' '}
                {quoteAsset}
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Trigger percentage:</span>
              <HightlightChange className='coin-info-value'>
                {(
                  (symbolConfiguration.buy.triggerPercentage - 1) *
                  100
                ).toFixed(2)}
                %
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Stop percentage:</span>
              <HightlightChange className='coin-info-value'>
                {((symbolConfiguration.buy.stopPercentage - 1) * 100).toFixed(
                  2
                )}
                %
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Limit percentage:</span>
              <HightlightChange className='coin-info-value'>
                {((symbolConfiguration.buy.limitPercentage - 1) * 100).toFixed(
                  2
                )}
                %
              </HightlightChange>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <span className='coin-info-sub-label'>Sell</span>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Trading enabled:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.enabled ? (
                  <i className='fa fa-toggle-on'></i>
                ) : (
                  <i className='fa fa-toggle-off'></i>
                )}
              </span>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Trigger percentage:</span>
              <HightlightChange className='coin-info-value'>
                {(
                  (symbolConfiguration.sell.triggerPercentage - 1) *
                  100
                ).toFixed(2)}
                %
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Stop price percentage:</span>
              <HightlightChange className='coin-info-value'>
                {((symbolConfiguration.sell.stopPercentage - 1) * 100).toFixed(
                  2
                )}
                %
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Limit price percentage:</span>
              <HightlightChange className='coin-info-value'>
                {((symbolConfiguration.sell.limitPercentage - 1) * 100).toFixed(
                  2
                )}
                %
              </HightlightChange>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <span className='coin-info-sub-label'>Sell - Stop Loss</span>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Stop Loss Enabled:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.stopLoss.enabled ? (
                  <i className='fa fa-toggle-on'></i>
                ) : (
                  <i className='fa fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Max Loss Percentage:</span>
              <HightlightChange className='coin-info-value'>
                {(
                  (symbolConfiguration.sell.stopLoss.maxLossPercentage - 1) *
                  100
                ).toFixed(2)}
                %
              </HightlightChange>
            </div>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Temporary disable buy:</span>
              <HightlightChange className='coin-info-value'>
                {moment
                  .duration(
                    symbolConfiguration.sell.stopLoss.disableBuyMinutes,
                    'minutes'
                  )
                  .humanize()}
              </HightlightChange>
            </div>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Order Type:</span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.sell.stopLoss.orderType}
              </HightlightChange>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
