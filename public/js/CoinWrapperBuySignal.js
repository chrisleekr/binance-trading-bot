/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBuySignal extends React.Component {
  render() {
    const {
      symbolInfo: {
        symbolInfo: {
          filterPrice: { tickSize }
        },
        symbolConfiguration,
        buy
      },
      jsonStrings: { coin_wrapper, common_strings }
    } = this.props;

    const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;
    let predictionHigherThan = 0;
    if (
      buy.prediction !== undefined &&
      buy.prediction.meanPredictedValue !== undefined
    ) {
      predictionHigherThan = (
        100 -
        (parseFloat(buy.currentPrice) /
          parseFloat(buy.prediction.meanPredictedValue[0])) *
          100
      ).toFixed(2);
    }

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <div className='coin-info-label'>
            {coin_wrapper.buy_signal} ({symbolConfiguration.candles.interval}/
            {symbolConfiguration.candles.limit}){' '}
            <span className='coin-info-value'>
              {symbolConfiguration.buy.enabled ? (
                <i className='fa fa-toggle-on'></i>
              ) : (
                <i className='fa fa-toggle-off'></i>
              )}
            </span>{' '}
          </div>
          {symbolConfiguration.buy.enabled === false ? (
            <HightlightChange className='coin-info-message text-muted'>
              {common_strings.trading_disabled}.
            </HightlightChange>
          ) : (
            ''
          )}
        </div>

        {symbolConfiguration.strategyOptions.huskyOptions.buySignal &&
        _.isEmpty(buy.trend) === false ? (
          <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
            <span className='coin-info-label'>
              {common_strings._trending} Husky:
            </span>
            {!_.isEmpty(buy.trend) ? (
              <HightlightChange className='coin-info-value'>
                {buy.trend.status} - {common_strings._strength}:{' '}
                {buy.trend.trendDiff}%
              </HightlightChange>
            ) : (
              'Not enough data, wait.'
            )}
          </div>
        ) : (
          ''
        )}

        {symbolConfiguration.buy.predictValue === true &&
        buy.prediction !== undefined &&
        buy.prediction.meanPredictedValue !== undefined ? (
          <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
            <span className='coin-info-label'>
              Predict next {buy.prediction.interval}:
            </span>
            <HightlightChange className='coin-info-value coin-predict'>
              {parseFloat(buy.prediction.meanPredictedValue[0]).toFixed(
                precision
              )}
            </HightlightChange>
            <HightlightChange className='coin-info-value coin-predict'>
              (
              {Math.sign(
                parseFloat(buy.prediction.meanPredictedValue[0]).toFixed(
                  precision
                ) - buy.currentPrice
              ) === 1
                ? 'above)'
                : 'below)'}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}

        {symbolConfiguration.buy.predictValue === true &&
        buy.prediction !== undefined ? (
          <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
            <span className='coin-info-label'>Prediction error:</span>
            <HightlightChange className='coin-info-value coin-predict'>
              {predictionHigherThan}%
            </HightlightChange>
          </div>
        ) : (
          ''
        )}

        {symbolConfiguration.strategyOptions.athRestriction.enabled ? (
          <div className='d-flex flex-column w-100'>
            {buy.athPrice ? (
              <div className='coin-info-column coin-info-column-price'>
                <span className='coin-info-label'>
                  ATH price (
                  {
                    symbolConfiguration.strategyOptions.athRestriction.candles
                      .interval
                  }
                  /
                  {
                    symbolConfiguration.strategyOptions.athRestriction.candles
                      .limit
                  }
                  ):
                </span>
                <HightlightChange className='coin-info-value'>
                  {parseFloat(buy.athPrice).toFixed(precision)}
                </HightlightChange>
              </div>
            ) : (
              ''
            )}
            {buy.athRestrictionPrice ? (
              <div className='coin-info-column coin-info-column-price'>
                <div
                  className='coin-info-label d-flex flex-row justify-content-start'
                  style={{ flex: '0 100%' }}>
                  <span>
                    &#62; Restricted price (
                    {(
                      parseFloat(
                        symbolConfiguration.strategyOptions.athRestriction
                          .restrictionPercentage - 1
                      ) * 100
                    ).toFixed(2)}
                    %):
                  </span>
                  <OverlayTrigger
                    trigger='click'
                    key='buy-ath-restricted-price-overlay'
                    placement='bottom'
                    overlay={
                      <Popover id='buy-ath-restricted-price-overlay-right'>
                        <Popover.Content>
                          The bot will place a buy order when the trigger price
                          is lower than ATH restricted price. Even if the
                          current price reaches the trigger price, the bot will
                          not purchase the coin if the current price is higher
                          than the ATH restricted price. If you don't want to
                          restrict the purchase with ATH, please disable the ATH
                          price restriction in the setting.
                        </Popover.Content>
                      </Popover>
                    }>
                    <Button
                      variant='link'
                      className='p-0 m-0 ml-1 text-info d-inline-block'
                      style={{ 'line-height': '17px' }}>
                      <i className='fa fa-question-circle'></i>
                    </Button>
                  </OverlayTrigger>
                </div>
                <HightlightChange className='coin-info-value'>
                  {parseFloat(buy.athRestrictionPrice).toFixed(precision)}
                </HightlightChange>
              </div>
            ) : (
              ''
            )}
            <div className='coin-info-column coin-info-column-price divider'></div>
          </div>
        ) : (
          ''
        )}

        {buy.highestPrice ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>
              {coin_wrapper.highest_price}:
            </span>
            <HightlightChange className='coin-info-value'>
              {parseFloat(buy.highestPrice).toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {buy.currentPrice ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>
              {common_strings.current_price}:
            </span>
            <HightlightChange className='coin-info-value'>
              {parseFloat(buy.currentPrice).toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {buy.lowestPrice ? (
          <div className='coin-info-column coin-info-column-lowest-price'>
            <span className='coin-info-label'>
              {coin_wrapper.lowest_price}:
            </span>
            <HightlightChange className='coin-info-value'>
              {parseFloat(buy.lowestPrice).toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        <div className='coin-info-column coin-info-column-price divider'></div>
        {buy.triggerPrice ? (
          <div className='coin-info-column coin-info-column-price'>
            <div
              className='coin-info-label d-flex flex-row justify-content-start'
              style={{ flex: '0 100%' }}>
              <span>
                {coin_wrapper.trigger_price} (
                {(
                  parseFloat(symbolConfiguration.buy.triggerPercentage - 1) *
                  100
                ).toFixed(2)}
                %):
              </span>
              {symbolConfiguration.strategyOptions.athRestriction.enabled &&
              parseFloat(buy.triggerPrice) >
                parseFloat(buy.athRestrictionPrice) ? (
                <OverlayTrigger
                  trigger='click'
                  key='buy-trigger-price-overlay'
                  placement='bottom'
                  overlay={
                    <Popover id='buy-trigger-price-overlay-right'>
                      <Popover.Content>
                        The trigger price{' '}
                        <code>
                          {parseFloat(buy.triggerPrice).toFixed(precision)}
                        </code>{' '}
                        is higher than the ATH buy restricted price{' '}
                        <code>
                          {parseFloat(buy.athRestrictionPrice).toFixed(
                            precision
                          )}
                        </code>
                        . The bot will not place an order even if the current
                        price reaches the trigger price.
                      </Popover.Content>
                    </Popover>
                  }>
                  <Button
                    variant='link'
                    className='p-0 m-0 ml-1 text-warning d-inline-block'
                    style={{ 'line-height': '17px' }}>
                    <i className='fa fa-info-circle'></i>
                  </Button>
                </OverlayTrigger>
              ) : (
                ''
              )}
            </div>
            <HightlightChange className='coin-info-value'>
              {parseFloat(buy.triggerPrice).toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {buy.difference ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>{coin_wrapper.diff_buy}:</span>
            <HightlightChange className='coin-info-value' id='buy-difference'>
              {parseFloat(buy.difference).toFixed(2)}%
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {buy.processMessage ? (
          <div className='d-flex flex-column w-100'>
            <div className='coin-info-column coin-info-column-price divider'></div>
            <div className='coin-info-column coin-info-column-message'>
              <HightlightChange className='coin-info-message'>
                {buy.processMessage}
              </HightlightChange>
            </div>
          </div>
        ) : (
          ''
        )}
      </div>
    );
  }
}
