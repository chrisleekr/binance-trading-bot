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
          {_.get(symbolConfiguration, 'candles') ? (
            <div className='coin-info-sub-wrapper'>
              <span className='coin-info-sub-label'>Candles</span>
              {_.get(symbolConfiguration, 'candles.interval') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Interval:</span>
                  <HightlightChange className='coin-info-value'>
                    {symbolConfiguration.candles.interval}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
              {_.get(symbolConfiguration, 'candles.limit') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Limit:</span>
                  <HightlightChange className='coin-info-value'>
                    {symbolConfiguration.candles.limit}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
            </div>
          ) : (
            ''
          )}

          {_.get(symbolConfiguration, 'buy') ? (
            <div className='coin-info-sub-wrapper'>
              <span className='coin-info-sub-label'>Buy</span>
              {_.get(symbolConfiguration, 'buy.enabled') !== undefined ? (
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
              ) : (
                ''
              )}

              {_.get(symbolConfiguration, 'buy.maxPurchaseAmount') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Maximum purchase amount:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {symbolConfiguration.buy.maxPurchaseAmount} {quoteAsset}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}

              {_.get(symbolConfiguration, 'buy.triggerPercentage') ? (
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
              ) : (
                ''
              )}

              {_.get(symbolConfiguration, 'buy.stopPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Stop percentage:</span>
                  <HightlightChange className='coin-info-value'>
                    {(
                      (symbolConfiguration.buy.stopPercentage - 1) *
                      100
                    ).toFixed(2)}
                    %
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}

              {_.get(symbolConfiguration, 'buy.limitPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Limit percentage:</span>
                  <HightlightChange className='coin-info-value'>
                    {(
                      (symbolConfiguration.buy.limitPercentage - 1) *
                      100
                    ).toFixed(2)}
                    %
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
            </div>
          ) : (
            ''
          )}

          {_.get(symbolConfiguration, 'sell') ? (
            <div className='coin-info-sub-wrapper'>
              <span className='coin-info-sub-label'>Sell</span>
              {_.get(symbolConfiguration, 'sell.enabled') !== undefined ? (
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
              ) : (
                ''
              )}
              {_.get(symbolConfiguration, 'sell.triggerPercentage') ? (
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
              ) : (
                ''
              )}
              {_.get(symbolConfiguration, 'sell.stopPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Stop price percentage:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {(
                      (symbolConfiguration.sell.stopPercentage - 1) *
                      100
                    ).toFixed(2)}
                    %
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
              {_.get(symbolConfiguration, 'sell.limitPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Limit price percentage:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {(
                      (symbolConfiguration.sell.limitPercentage - 1) *
                      100
                    ).toFixed(2)}
                    %
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
            </div>
          ) : (
            ''
          )}
        </div>
      </div>
    );
  }
}
