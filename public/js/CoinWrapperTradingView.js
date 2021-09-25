/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperTradingView extends React.Component {
  constructor(props) {
    super(props);
    this._ref = React.createRef();
  }

  getTradingViewInterval(interval) {
    switch (interval) {
      case '3m':
        return '5m';
      default:
        return interval;
    }
  }

  componentDidMount() {
    const {
      symbolInfo: {
        symbolInfo: { symbol },
        symbolConfiguration: {
          candles: { interval },
          botOptions: {
            tradingView: { showTechnicalAnalysisWidget }
          }
        }
      }
    } = this.props;

    if (showTechnicalAnalysisWidget === false) {
      return;
    }
    const script = document.createElement('script');
    script.src =
      'https://s3.tradingview.com/external-embedding/embed-widget-technical-analysis.js';
    script.async = true;
    script.innerHTML =
      `{
      "interval": "` +
      this.getTradingViewInterval(interval) +
      `",
      "width": "100%",
      "isTransparent": true,
      "height": "450",
      "symbol": "BINANCE:` +
      symbol +
      `",
      "showIntervalTabs": true,
      "locale": "en",
      "colorTheme": "dark"
    }`;
    this._ref.current.appendChild(script);
  }

  render() {
    const {
      symbolInfo: {
        symbol,
        symbolConfiguration: {
          botOptions: {
            tradingView: { showTechnicalAnalysisWidget }
          }
        }
      }
    } = this.props;

    if (showTechnicalAnalysisWidget === false) {
      return '';
    }

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title border-bottom-0 mb-0 pb-0'>
          <div className='tradingview-widget-container' ref={this._ref}>
            <div className='tradingview-widget-container__widget'></div>
            <div className='tradingview-widget-copyright'>
              <a
                href='https://www.tradingview.com/symbols/{symbol}/technicals/'
                rel='noopener noreferrer'
                target='_blank'>
                <span className='blue-text'>
                  Technical Analysis for {symbol}
                </span>
              </a>{' '}
              by TradingView
            </div>
          </div>
        </div>
      </div>
    );
  }
}
