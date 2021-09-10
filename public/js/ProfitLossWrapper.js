/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class ProfitLossWrapper extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      canUpdate: true,
      symbols: {},
      totalPnL: {},
      closedTradesLoading: false,
      closedTradesSetting: {},
      selectedPeriod: null
    };

    this.setUpdate = this.setUpdate.bind(this);
    this.requestClosedTradesSetPeriod =
      this.requestClosedTradesSetPeriod.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update, when the canUpdate is true.
    const { canUpdate } = this.state;
    if (
      canUpdate === true &&
      _.get(nextProps, 'symbols', null) !== null &&
      _.isEqual(_.get(nextProps, 'symbols', null), this.state.symbols) === false
    ) {
      const { symbols } = nextProps;

      // Calculate total profit/loss
      const totalPnL = {};
      _.forEach(symbols, s => {
        if (totalPnL[s.quoteAssetBalance.asset] === undefined) {
          totalPnL[s.quoteAssetBalance.asset] = {
            asset: s.quoteAssetBalance.asset,
            amount: 0,
            profit: 0
          };
        }

        totalPnL[s.quoteAssetBalance.asset].amount +=
          parseFloat(s.baseAssetBalance.total) * s.sell.lastBuyPrice;
        totalPnL[s.quoteAssetBalance.asset].profit += s.sell.currentProfit;
      });

      this.setState({
        symbols,
        totalPnL
      });
    }

    if (
      _.get(nextProps, 'closedTradesSetting', null) !== null &&
      _.isEqual(
        _.get(nextProps, 'closedTradesSetting', null),
        this.state.closedTradesSetting
      ) === false
    ) {
      const { closedTradesSetting } = nextProps;
      this.setState({
        closedTradesSetting
      });
    }

    const { selectedPeriod } = this.state;
    const { loadedPeriod } = this.state.closedTradesSetting;

    // Set initial selected period
    if (loadedPeriod !== undefined && selectedPeriod === null) {
      this.setState({
        selectedPeriod: loadedPeriod
      });
    }

    // If loaded period and selected period, then wait for reloaded
    if (loadedPeriod !== selectedPeriod) {
      if (this.state.closedTradesLoading === false) {
        // Set loading as true
        this.setState({
          closedTradesLoading: true
        });
      }
    } else {
      // If loaded period and selected period, then it's loaded correctly.
      if (this.state.closedTradesLoading === true) {
        // Set loading as false
        this.setState({
          closedTradesLoading: false
        });
      }
    }
  }

  setUpdate(newStatus) {
    this.setState({
      canUpdate: newStatus
    });
  }

  requestClosedTradesSetPeriod() {
    const { selectedPeriod } = this.state;
    return axios.post('/closed-trades-set-period', {
      selectedPeriod
    });
  }

  setSelectedPeriod(newSelectedPeriod) {
    this.setState({ selectedPeriod: newSelectedPeriod }, () =>
      this.requestClosedTradesSetPeriod()
    );
  }

  render() {
    const { sendWebSocket, isAuthenticated, closedTrades, symbolEstimates } =
      this.props;
    const { totalPnL, symbols, selectedPeriod, closedTradesLoading } =
      this.state;

    if (_.isEmpty(totalPnL)) {
      return '';
    }

    const groupedEstimates = {};
    symbolEstimates.forEach(symbol => {
      if (groupedEstimates[symbol.quoteAsset] === undefined) {
        groupedEstimates[symbol.quoteAsset] = {
          value: 0,
          quotePrecision:
            parseFloat(symbol.tickSize) === 1
              ? 0
              : symbol.tickSize.indexOf(1) - 1
        };
      }

      groupedEstimates[symbol.quoteAsset].value += symbol.estimatedValue;
    });

    const openTradeWrappers = Object.values(totalPnL).map((pnl, index) => {
      const percentage =
        pnl.amount > 0 ? ((pnl.profit / pnl.amount) * 100).toFixed(2) : 0;
      return (
        <div
          key={`open-trade-pnl-` + index}
          className='profit-loss-wrapper pt-2 pl-2 pr-2 pb-0'>
          <div className='profit-loss-wrapper-body'>
            <div className='profit-loss-asset'>
              {pnl.asset}
              <br />
              <div className='text-success text-truncate'>
                {groupedEstimates[pnl.asset].value.toFixed(
                  groupedEstimates[pnl.asset].quotePrecision
                )}
              </div>
            </div>{' '}
            <div className='profit-loss-value'>
              {pnl.profit > 0 ? '+' : ''}
              {pnl.profit.toFixed(5)}
              <br />({percentage}%)
            </div>
          </div>
        </div>
      );
    });

    const closedTradeWrappers = Object.values(closedTrades).map(
      (stat, index) => {
        return (
          <div
            key={`closed-trade-pnl-` + index}
            className='profit-loss-wrapper pt-2 pl-2 pr-2 pb-0'>
            <div className='profit-loss-wrapper-body'>
              <div className='profit-loss-asset'>
                {stat.quoteAsset}
                <br />
                <QuoteAssetGridTradeArchiveIcon
                  isAuthenticated={isAuthenticated}
                  quoteAsset={stat.quoteAsset}
                  quoteAssetTickSize={5}
                />
                ({stat.trades})
              </div>{' '}
              <div className='profit-loss-value'>
                {stat.profit > 0 ? '+' : ''}
                {stat.profit.toFixed(5)}
                <br />({stat.profitPercentage.toFixed(2)}%)
              </div>
            </div>
          </div>
        );
      }
    );

    return (
      <div className='profit-loss-container'>
        <div className='accordion-wrapper profit-loss-accordion-wrapper profit-loss-open-trades-accordion-wrapper'>
          <Accordion defaultActiveKey='0'>
            <Card bg='dark'>
              <Card.Header className='px-2 py-1'>
                <div className='d-flex flex-row justify-content-between'>
                  <div className='flex-column-left'>
                    <div className='btn-profit-loss text-uppercase text-left font-weight-bold'>
                      <span>Open Trades</span>{' '}
                      <OverlayTrigger
                        trigger='click'
                        key='profit-loss-overlay'
                        placement='bottom'
                        overlay={
                          <Popover id='profit-loss-overlay-right'>
                            <Popover.Content>
                              This section displays the estimated profit/loss
                              for the list of assets that are currently open to
                              selling with the last buy price recorded. The
                              calculation is simply adding profit/loss values
                              for each quote asset. Note that it does not
                              represent the historical profit/loss.
                            </Popover.Content>
                          </Popover>
                        }>
                        <Button
                          variant='link'
                          className='p-0 m-0 ml-1 text-info'>
                          <i className='fas fa-question-circle fa-sm'></i>
                        </Button>
                      </OverlayTrigger>
                    </div>
                  </div>
                  <div className='flex-column-right pt-2'>
                    {_.isEmpty(symbols) === false ? (
                      <ManualTradeIcon
                        symbols={symbols}
                        setUpdate={this.setUpdate}
                        sendWebSocket={sendWebSocket}
                        isAuthenticated={isAuthenticated}
                      />
                    ) : (
                      ''
                    )}
                  </div>
                </div>
              </Card.Header>

              <Accordion.Collapse eventKey='0'>
                <Card.Body className='d-flex flex-column py-2 px-0 card-body'>
                  <div className='profit-loss-wrappers profit-loss-open-trades-wrappers'>
                    {_.isEmpty(totalPnL) ? (
                      <div className='text-center w-100 m-3'>
                        <Spinner animation='border' role='status'>
                          <span className='sr-only'>Loading...</span>
                        </Spinner>
                      </div>
                    ) : (
                      openTradeWrappers
                    )}
                  </div>
                </Card.Body>
              </Accordion.Collapse>
            </Card>
          </Accordion>
        </div>
        <div className='accordion-wrapper profit-loss-accordion-wrapper profit-loss-closed-trades-accordion-wrapper'>
          <Accordion defaultActiveKey='0'>
            <Card bg='dark'>
              <Card.Header className='px-2 py-1'>
                <div className='d-flex flex-row justify-content-between'>
                  <div className='flex-column-left'>
                    <div className='btn-profit-loss text-uppercase font-weight-bold'>
                      Closed Trades{' '}
                      <OverlayTrigger
                        trigger='click'
                        key='profit-loss-overlay'
                        placement='bottom'
                        overlay={
                          <Popover id='profit-loss-overlay-right'>
                            <Popover.Content>...</Popover.Content>
                          </Popover>
                        }>
                        <Button
                          variant='link'
                          className='p-0 m-0 ml-1 text-info'>
                          <i className='fas fa-question-circle fa-sm'></i>
                        </Button>
                      </OverlayTrigger>
                    </div>
                  </div>
                  <div className='flex-column-right pt-2'>
                    <button
                      type='button'
                      className={`btn btn-period ml-1 btn-sm ${
                        selectedPeriod === 'd' ? 'btn-info' : 'btn-light'
                      }`}
                      onClick={() => this.setSelectedPeriod('d')}
                      title='Day'>
                      D
                    </button>
                    <button
                      type='button'
                      className={`btn btn-period ml-1 btn-sm ${
                        selectedPeriod === 'w' ? 'btn-info' : 'btn-light'
                      }`}
                      onClick={() => this.setSelectedPeriod('w')}
                      title='Week'>
                      W
                    </button>
                    <button
                      type='button'
                      className={`btn btn-period ml-1 btn-sm ${
                        selectedPeriod === 'm' ? 'btn-info' : 'btn-light'
                      }`}
                      onClick={() => this.setSelectedPeriod('m')}
                      title='Month'>
                      M
                    </button>
                    <button
                      type='button'
                      className={`btn btn-period ml-1 btn-sm ${
                        selectedPeriod === 'a' ? 'btn-info' : 'btn-light'
                      }`}
                      onClick={() => this.setSelectedPeriod('a')}
                      title='All'>
                      All
                    </button>
                  </div>
                </div>
              </Card.Header>

              <Accordion.Collapse eventKey='0'>
                <Card.Body className='d-flex flex-column py-2 px-0 card-body'>
                  <div className='profit-loss-wrappers profit-loss-open-trades-wrappers'>
                    {closedTradesLoading === true || _.isEmpty(closedTrades) ? (
                      <div className='text-center w-100 m-3'>
                        <Spinner animation='border' role='status'>
                          <span className='sr-only'>Loading...</span>
                        </Spinner>
                      </div>
                    ) : (
                      <React.Fragment>{closedTradeWrappers}</React.Fragment>
                    )}
                  </div>
                </Card.Body>
              </Accordion.Collapse>
            </Card>
          </Accordion>
        </div>
      </div>
    );
  }
}
