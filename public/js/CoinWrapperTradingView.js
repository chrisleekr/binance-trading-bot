/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperTradingView extends React.Component {
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

  getRecommendationClass(recommend) {
    switch (recommend) {
      case 'STRONG_BUY':
      case 'BUY':
        return 'text-success';
      case 'STRONG_SELL':
      case 'SELL':
        return 'text-danger';
      default:
        return '';
    }
  }

  render() {
    const { collapsed } = this.state;
    const {
      connected,
      symbolInfo: {
        symbol,
        symbolInfo: {
          filterPrice: { tickSize }
        },
        symbolConfiguration: {
          botOptions: {
            tradingView: { useOnlyWithin: tradingViewUseOnlyWithin }
          }
        },
        tradingView
      }
    } = this.props;

    if (_.isEmpty(tradingView)) {
      return '';
    }

    const quotePrecision =
      parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    const oscillators = [
      {
        name: 'Relative Strength Index (14)',
        indicator: (
          _.get(tradingView, 'result.indicators["RSI"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE.RSI
      },
      {
        name: 'Stochastic %K (14, 3, 3)',
        indicator: (
          _.get(tradingView, 'result.indicators["Stoch.K"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE['STOCH.K']
      },
      {
        name: 'Commodity Channel Index (20)',
        indicator: (
          _.get(tradingView, 'result.indicators["CCI20"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE['CCI']
      },
      {
        name: 'Average Directional Index (14)',
        indicator: (
          _.get(tradingView, 'result.indicators["ADX"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE['ADX']
      },
      {
        name: 'Awesome Oscillator',
        indicator: (_.get(tradingView, 'result.indicators["AO"]') || 0).toFixed(
          quotePrecision
        ),
        recommend: tradingView.result.oscillators.COMPUTE['AO']
      },
      {
        name: 'Momentum (10)',
        indicator: (
          _.get(tradingView, 'result.indicators["Mom"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE['Mom']
      },
      {
        name: 'MACD Level (12, 26)',
        indicator: (
          _.get(tradingView, 'result.indicators["MACD.macd"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE['MACD']
      },
      {
        name: 'Stochastic RSI Fast',
        indicator: (
          _.get(tradingView, 'result.indicators["Stoch.RSI.K"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE['Stoch.RSI']
      },
      {
        name: 'Williams Percent Range (14)',
        indicator: (
          _.get(tradingView, 'result.indicators["W.R"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE['W%R']
      },
      {
        name: 'Bull Bear Power',
        indicator: (
          _.get(tradingView, 'result.indicators["BBPower"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.oscillators.COMPUTE['BBP']
      },
      {
        name: 'Ultimate Oscillator (7, 14, 28)',
        indicator: (_.get(tradingView, 'result.indicators["UO"]') || 0).toFixed(
          quotePrecision
        ),
        recommend: tradingView.result.oscillators.COMPUTE['UO']
      }
    ].map((oscillator, i) => {
      return (
        <React.Fragment key={'tradingview-oscillator-' + i}>
          <div className='coin-info-column coin-info-column-tradingview fs-9'>
            <span className='coin-info-label'>{oscillator.name}</span>
            <div className='coin-info-value'>{oscillator.indicator}</div>
            <div
              className={
                'coin-info-value ' +
                this.getRecommendationClass(oscillator.recommend)
              }>
              {oscillator.recommend}
            </div>
          </div>
        </React.Fragment>
      );
    });

    const movingAverages = [
      {
        name: 'Exponential Moving Average (10)',
        indicator: (
          _.get(tradingView, 'result.indicators["EMA10"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['EMA10']
      },
      {
        name: 'Simple Moving Average (10)',
        indicator: (
          _.get(tradingView, 'result.indicators["SMA10"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['SMA10']
      },
      {
        name: 'Exponential Moving Average (20)',
        indicator: (
          _.get(tradingView, 'result.indicators["EMA20"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['EMA20']
      },
      {
        name: 'Simple Moving Average (20)',
        indicator: (
          _.get(tradingView, 'result.indicators["SMA20"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['SMA20']
      },
      {
        name: 'Exponential Moving Average (30)',
        indicator: (
          _.get(tradingView, 'result.indicators["EMA30"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['EMA30']
      },
      {
        name: 'Simple Moving Average (30)',
        indicator: (
          _.get(tradingView, 'result.indicators["SMA30"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['SMA30']
      },
      {
        name: 'Exponential Moving Average (50)',
        indicator: (
          _.get(tradingView, 'result.indicators["EMA50"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['EMA50']
      },
      {
        name: 'Simple Moving Average (50)',
        indicator: (
          _.get(tradingView, 'result.indicators["SMA50"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['SMA50']
      },
      {
        name: 'Exponential Moving Average (100)',
        indicator: (
          _.get(tradingView, 'result.indicators["EMA100"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['EMA100']
      },
      {
        name: 'Simple Moving Average (100)',
        indicator: (
          _.get(tradingView, 'result.indicators["SMA100"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['SMA100']
      },
      {
        name: 'Exponential Moving Average (200)',
        indicator: (
          _.get(tradingView, 'result.indicators["EMA200"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['EMA200']
      },
      {
        name: 'Simple Moving Average (200)',
        indicator: (
          _.get(tradingView, 'result.indicators["SMA200"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['SMA200']
      },
      {
        name: 'Ichimoku Base Line (9, 26, 52, 26)',
        indicator: (
          _.get(tradingView, 'result.indicators["Ichimoku.BLine"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['Ichimoku']
      },
      {
        name: 'Volume Weighted Moving Average (20)',
        indicator: (
          _.get(tradingView, 'result.indicators["VWMA"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['VWMA']
      },
      {
        name: 'Hull Moving Average (9)',
        indicator: (
          _.get(tradingView, 'result.indicators["HullMA9"]') || 0
        ).toFixed(quotePrecision),
        recommend: tradingView.result.moving_averages.COMPUTE['HullMA']
      }
    ].map((movingAverage, i) => {
      return (
        <React.Fragment key={'tradingview-moving-average-' + i}>
          <div className='coin-info-column coin-info-column-tradingview fs-9'>
            <span className='coin-info-label'>{movingAverage.name}</span>
            <div className='coin-info-value'>{movingAverage.indicator}</div>
            <div
              className={
                'coin-info-value ' +
                this.getRecommendationClass(movingAverage.recommend)
              }>
              {movingAverage.recommend}
            </div>
          </div>
        </React.Fragment>
      );
    });

    let updatedWithinAlert = '';
    const updatedAt = moment
      .utc(tradingView.result.time, 'YYYY-MM-DDTHH:mm:ss.SSSSSS')
      .add(tradingViewUseOnlyWithin, 'minutes');
    const currentTime = moment.utc();
    // Show error message only if connected
    if (connected && updatedAt.isBefore(currentTime)) {
      updatedWithinAlert = (
        <div className='coin-info-column coin-info-column-title border-bottom-0 m-0 p-0'>
          <div className='bg-light text-dark w-100 px-1'>
            The data is older than {tradingViewUseOnlyWithin} minute(s). This
            data will not be used until it is updated.
          </div>
        </div>
      );
    }

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <div className='coin-info-label'>
            Technical Analysis from{' '}
            <a
              href={
                'https://www.tradingview.com/symbols/' + symbol + '/technicals/'
              }
              rel='noopener noreferrer'
              target='_blank'>
              TradingView
            </a>
          </div>
        </div>
        <div className='d-flex flex-column w-100'>
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>
              Summary ({tradingView.request.interval})
            </span>
            <HightlightChange
              className={
                'coin-info-value text-bold ' +
                this.getRecommendationClass(
                  tradingView.result.summary.RECOMMENDATION
                )
              }>
              {_.startCase(tradingView.result.summary.RECOMMENDATION)}
            </HightlightChange>
            <button
              type='button'
              className='btn btn-sm btn-link p-0 ml-1 text-white'
              onClick={this.toggleCollapse}>
              <i
                className={`fas ${
                  collapsed ? 'fa-arrow-right' : 'fa-arrow-down'
                }`}></i>
            </button>
          </div>
          <div className='coin-info-column-rows coin-info-column-price'>
            <div className='coin-info-column-row'>
              <div className='coin-info-column w-row-3 text-center text-danger'>
                Sell
              </div>
              <div className='coin-info-column w-row-3 text-center text-muted'>
                Neutral
              </div>
              <div className='coin-info-column w-row-3 text-center text-success'>
                Buy
              </div>
            </div>
            <div className='coin-info-column-row'>
              <div className='coin-info-column w-row-3 text-center text-danger'>
                {tradingView.result.summary.SELL}
              </div>
              <div className='coin-info-column w-row-3 text-center text-muted'>
                {tradingView.result.summary.NEUTRAL}
              </div>
              <div className='coin-info-column w-row-3 text-center text-success'>
                {tradingView.result.summary.BUY}
              </div>
            </div>
          </div>
          <div className='coin-info-column coin-info-column-price'>
            <span
              className='coin-info-value font-italic fs-9'
              title={tradingView.result.time}>
              Updated{' '}
              {moment
                .utc(tradingView.result.time, 'YYYY-MM-DDTHH:mm:ss.SSSSSS')
                .fromNow()}
            </span>
          </div>
          {updatedWithinAlert}
          <div
            className={`coin-info-content-setting ${
              collapsed ? 'd-none' : ''
            }`}>
            <div className='coin-info-sub-wrapper'>
              <div className='coin-info-sub-label'>
                Oscillators (
                <span className='text-danger mx-1'>
                  Sell: {tradingView.result.oscillators.SELL}
                </span>
                /
                <span className='text-muted mx-1'>
                  Neutral: {tradingView.result.oscillators.NEUTRAL}
                </span>
                /
                <span className='text-success mx-1'>
                  Buy: {tradingView.result.oscillators.BUY}
                </span>
                )
              </div>
              {oscillators}
            </div>
            <div className='coin-info-sub-wrapper'>
              <div className='coin-info-sub-label'>
                Moving Averages (
                <span className='text-danger mx-1'>
                  Sell: {tradingView.result.moving_averages.SELL}
                </span>
                /
                <span className='text-muted mx-1'>
                  Neutral: {tradingView.result.moving_averages.NEUTRAL}
                </span>
                /
                <span className='text-success mx-1'>
                  Buy: {tradingView.result.moving_averages.BUY}
                </span>
                )
              </div>
              {movingAverages}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
