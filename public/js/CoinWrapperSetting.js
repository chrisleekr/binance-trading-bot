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

  isCustomised = configurationKeyName =>
    configurationKeyName !== 'configuration';

  jsonValueAtPath = (obj, path) => {
    // Extract the value of the object at the given path
    const value = path.split('.').reduce((acc, key) => {
      if (key.includes('[')) {
        const index = key.match(/\d+/)[0];
        const arrKey = key.split('[')[0];
        return acc[arrKey][index];
      } else {
        if (acc && acc.hasOwnProperty(key)) return acc[key];
        else return -1;
      }
    }, obj);
    return value;
  };

  warnIfAttributeCustomised = (path, globalPath = path) => {
    if (
      this.jsonValueAtPath(this.props.symbolInfo.symbolConfiguration, path) !==
      this.jsonValueAtPath(this.props.configuration, globalPath)
    )
      return 'text-warning';
    else return '';
  };

  render() {
    const { collapsed } = this.state;
    const { symbolInfo } = this.props;
    const { symbolConfiguration } = symbolInfo;

    const {
      symbol,
      quoteAssetBalance: { asset: quoteAsset }
    } = symbolInfo;

    const {
      key: configurationKeyName,
      buy: { gridTrade: buyGridTrade },
      sell: { gridTrade: sellGridTrade }
    } = symbolConfiguration;

    const buyGridRows = buyGridTrade.map((grid, i) => {
      return (
        <React.Fragment
          key={'coin-wrapper-setting-buy-grid-row-' + symbol + '-' + i}>
          <div className='coin-info-column-grid'>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Grid Trade #{i + 1}</span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `buy.gridTrade[${i}].triggerPercentage`
              )}`}>
              <span className='coin-info-label'>
                Trigger percentage{' '}
                <strong>
                  {i === 0 ? `(lowest price)` : `(last buy price)`}
                </strong>
                :
              </span>
              <div className='coin-info-value'>
                {(parseFloat(grid.triggerPercentage - 1) * 100).toFixed(2)}%
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `buy.gridTrade[${i}].stopPercentage`
              )}`}>
              <span className='coin-info-label'>Stop percentage:</span>
              <div className='coin-info-value'>
                {(parseFloat(grid.stopPercentage - 1) * 100).toFixed(2)}%
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `buy.gridTrade[${i}].limitPercentage`
              )}`}>
              <span className='coin-info-label'>Limit percentage:</span>
              <div className='coin-info-value'>
                {(parseFloat(grid.limitPercentage - 1) * 100).toFixed(2)}%
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `buy.gridTrade[${i}].minPurchaseAmount`,
                `buy.gridTrade[${i}].minPurchaseAmounts.${quoteAsset}`
              )}`}>
              <span className='coin-info-label'>Min purchase amount:</span>
              <div className='coin-info-value'>
                {grid.minPurchaseAmount} {quoteAsset}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `buy.gridTrade[${i}].maxPurchaseAmount`,
                `buy.gridTrade[${i}].maxPurchaseAmounts.${quoteAsset}`
              )}`}>
              <span className='coin-info-label'>Max purchase amount:</span>
              <div className='coin-info-value'>
                {grid.maxPurchaseAmount} {quoteAsset}
              </div>
            </div>
          </div>
        </React.Fragment>
      );
    });

    const sellGridRows = sellGridTrade.map((grid, i) => {
      return (
        <React.Fragment
          key={'coin-wrapper-setting-sell-grid-row-' + symbol + '-' + i}>
          <div className='coin-info-column-grid'>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Grid Trade #{i + 1}</span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `sell.gridTrade[${i}].triggerPercentage`
              )}`}>
              <span className='coin-info-label'>Trigger percentage:</span>
              <div className='coin-info-value'>
                {(parseFloat(grid.triggerPercentage - 1) * 100).toFixed(2)}%
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `sell.gridTrade[${i}].stopPercentage`
              )}`}>
              <span className='coin-info-label'>Stop percentage:</span>
              <div className='coin-info-value'>
                {(parseFloat(grid.stopPercentage - 1) * 100).toFixed(2)}%
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `sell.gridTrade[${i}].limitPercentage`
              )}`}>
              <span className='coin-info-label'>Limit percentage:</span>
              <div className='coin-info-value'>
                {(parseFloat(grid.limitPercentage - 1) * 100).toFixed(2)}%
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                `sell.gridTrade[${i}].quantityPercentage`,
                `sell.gridTrade[${i}].quantityPercentages.${quoteAsset}`
              )}`}>
              <span className='coin-info-label'>Quantity Percentage:</span>
              <div className='coin-info-value'>
                {(parseFloat(grid.quantityPercentage) * 100).toFixed(2)}%
              </div>
            </div>
          </div>
        </React.Fragment>
      );
    });

    return (
      <div className='coin-info-sub-wrapper coin-info-sub-wrapper-setting'>
        <div className='coin-info-column coin-info-column-title coin-info-column-title-setting'>
          <div className='coin-info-label'>
            <div className='mr-1'>
              Setting{' '}
              {this.isCustomised(configurationKeyName) ? (
                <Badge pill variant='warning'>
                  Customised
                </Badge>
              ) : (
                <Badge pill variant='light'>
                  Global
                </Badge>
              )}
            </div>
          </div>

          <button
            type='button'
            className='btn btn-sm btn-link p-0 ml-1'
            onClick={this.toggleCollapse}>
            <i
              className={`fas ${
                collapsed ? 'fa-arrow-right' : 'fa-arrow-down'
              }`}></i>
          </button>
        </div>
        <div
          className={`coin-info-content-setting ${collapsed ? 'd-none' : ''}`}>
          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>Candles</div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'candles.interval'
              )}`}>
              <span className='coin-info-label'>Interval:</span>
              <div className='coin-info-value'>
                {symbolConfiguration.candles.interval}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'candles.limit'
              )}`}>
              <span className='coin-info-label'>Limit:</span>
              <div className='coin-info-value'>
                {symbolConfiguration.candles.limit}
              </div>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>Buy</div>
            <div
              className={`coin-info-column coin-info-column-order ${
                this.warnIfAttributeCustomised('buy.enabled')
                  ? 'text-warning'
                  : ''
              }`}>
              <span className='coin-info-label'>Trading enabled:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.buy.enabled ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            {buyGridRows}
          </div>
          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>
              Buy - Last buy price removal threshold
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'buy.lastBuyPriceRemoveThreshold'
              )}`}>
              <span className='coin-info-label'>
                Remove last buy price under:
              </span>
              <div className='coin-info-value'>
                {symbolConfiguration.buy.lastBuyPriceRemoveThreshold}{' '}
                {quoteAsset}
              </div>
            </div>
          </div>
          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>
              Buy - Restriction with ATH
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'buy.athRestriction.enabled'
              )}`}>
              <span className='coin-info-label'>Restriction Enabled:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.buy.athRestriction.enabled ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'buy.athRestriction.candles.interval'
              )}`}>
              <span className='coin-info-label'>Candles - Interval:</span>
              <div className='coin-info-value'>
                {symbolConfiguration.buy.athRestriction.candles.interval}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'buy.athRestriction.candles.limit'
              )}`}>
              <span className='coin-info-label'>Candles - Limit:</span>
              <div className='coin-info-value'>
                {symbolConfiguration.buy.athRestriction.candles.limit}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'buy.athRestriction.restrictionPercentage'
              )}`}>
              <span className='coin-info-label'>Restriction Percentage:</span>
              <div className='coin-info-value'>
                {(
                  (symbolConfiguration.buy.athRestriction
                    .restrictionPercentage -
                    1) *
                  100
                ).toFixed(2)}
                %
              </div>
            </div>
          </div>
          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>Buy - TradingView</div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'buy.tradingView.whenStrongBuy'
              )}`}>
              <span className='coin-info-label'>
                Allow when recommendation is <code>Strong buy</code>:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.buy.tradingView.whenStrongBuy ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'buy.tradingView.whenBuy'
              )}`}>
              <span className='coin-info-label'>
                Allow when recommendation is <code>Buy</code>:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.buy.tradingView.whenBuy ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>Sell</div>
            <div
              className={`coin-info-column coin-info-column-order ${
                this.warnIfAttributeCustomised('sell.enabled')
                  ? 'text-warning'
                  : ''
              }`}>
              <span className='coin-info-label'>Trading enabled:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.enabled ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            {sellGridRows}
          </div>

          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>Sell - Stop Loss</div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.stopLoss.enabled'
              )}`}>
              <span className='coin-info-label'>Stop Loss Enabled:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.stopLoss.enabled ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.stopLoss.maxLossPercentage'
              )}`}>
              <span className='coin-info-label'>Max Loss Percentage:</span>
              <div className='coin-info-value'>
                {(
                  (symbolConfiguration.sell.stopLoss.maxLossPercentage - 1) *
                  100
                ).toFixed(2)}
                %
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.stopLoss.disableBuyMinutes'
              )}`}>
              <span className='coin-info-label'>Temporary disable buy:</span>
              <div className='coin-info-value'>
                {moment
                  .duration(
                    symbolConfiguration.sell.stopLoss.disableBuyMinutes,
                    'minutes'
                  )
                  .humanize()}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.stopLoss.orderType'
              )}`}>
              <span className='coin-info-label'>Order Type:</span>
              <div className='coin-info-value'>
                {symbolConfiguration.sell.stopLoss.orderType}
              </div>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>Sell - TradingView</div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenNeutral'
              )}`}>
              <span className='coin-info-label'>
                Force sell when recommendation is <code>Neutral</code>:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.tradingView
                  .forceSellOverZeroBelowTriggerPrice.whenNeutral ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenSell'
              )}`}>
              <span className='coin-info-label'>
                Force sell when recommendation is <code>Sell</code>:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.tradingView
                  .forceSellOverZeroBelowTriggerPrice.whenSell ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenStrongSell'
              )}`}>
              <span className='coin-info-label'>
                Force sell when recommendation is <code>Strong sell</code>:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.tradingView
                  .forceSellOverZeroBelowTriggerPrice.whenStrongSell ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>Conservative Mode</div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.conservativeMode.enabled'
              )}`}>
              <span className='coin-info-label'>
                Conservative Sell Enabled:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.conservativeMode.enabled ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'sell.conservativeMode.factor'
              )}`}>
              <span className='coin-info-label'>Conservative ratio:</span>
              <div className='coin-info-value'>
                {symbolConfiguration.sell.conservativeMode.factor}
              </div>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>
              Bot Options - Auto Trigger Buy
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.autoTriggerBuy.enabled'
              )}`}>
              <span className='coin-info-label'>Enabled:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.botOptions.autoTriggerBuy.enabled ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.autoTriggerBuy.triggerAfter'
              )}`}>
              <span className='coin-info-label'>Trigger after:</span>
              <div className='coin-info-value'>
                {moment
                  .duration(
                    symbolConfiguration.botOptions.autoTriggerBuy.triggerAfter,
                    'minutes'
                  )
                  .humanize()}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.autoTriggerBuy.conditions.whenLessThanATHRestriction'
              )}`}>
              <span className='coin-info-label'>
                Re-schedule when the current price is over ATH restriction:
              </span>
              <div className='coin-info-value'>
                {symbolConfiguration.botOptions.autoTriggerBuy.conditions
                  .whenLessThanATHRestriction ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.autoTriggerBuy.conditions.afterDisabledPeriod'
              )}`}>
              <span className='coin-info-label'>
                Re-schedule when the action is disabled:
              </span>
              <div className='coin-info-value'>
                {symbolConfiguration.botOptions.autoTriggerBuy.conditions
                  .afterDisabledPeriod ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.autoTriggerBuy.conditions.tradingView.overrideInterval'
              )}`}>
              <span className='coin-info-label'>
                TradingView Overriden Interval:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.botOptions.autoTriggerBuy.conditions
                  .tradingView.overrideInterval !== ''
                  ? symbolConfiguration.botOptions.autoTriggerBuy.conditions
                      .tradingView.overrideInterval
                  : 'Use TradingView'}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.autoTriggerBuy.conditions.tradingView.whenStrongBuy'
              )}`}>
              <span className='coin-info-label'>
                Allow when TradingView recommendation is <code>Strong buy</code>
                :
              </span>
              <div className='coin-info-value'>
                {symbolConfiguration.botOptions.autoTriggerBuy.conditions
                  .tradingView.whenStrongBuy ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </div>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.autoTriggerBuy.conditions.tradingView.whenBuy'
              )}`}>
              <span className='coin-info-label'>
                Allow when TradingView recommendation is <code>Buy</code>:
              </span>
              <div className='coin-info-value'>
                {symbolConfiguration.botOptions.autoTriggerBuy.conditions
                  .tradingView.whenBuy ? (
                  <i className='fas fa-toggle-on'></i>
                ) : (
                  <i className='fas fa-toggle-off'></i>
                )}
              </div>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <div className='coin-info-sub-label'>Bot Options - TradingView</div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.tradingView.interval'
              )}`}>
              <span className='coin-info-label'>Interval:</span>
              <span className='coin-info-value'>
                {symbolConfiguration.botOptions.tradingView.interval !== ''
                  ? symbolConfiguration.botOptions.tradingView.interval
                  : symbolConfiguration.candles.interval}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.tradingView.useOnlyWithin'
              )}`}>
              <span className='coin-info-label'>
                Use data only updated within:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.botOptions.tradingView.useOnlyWithin}
              </span>
            </div>
            <div
              className={`coin-info-column coin-info-column-order ${this.warnIfAttributeCustomised(
                'botOptions.tradingView.ifExpires'
              )}`}>
              <span className='coin-info-label'>
                If data passed "Use data only updated within":
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.botOptions.tradingView.ifExpires ===
                'ignore'
                  ? 'Ignore data'
                  : 'Do not buy'}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
