/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class ProfitLossWrapper extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      canUpdate: true,
      symbols: {},
      closedTradesLoading: false,
      closedTradesSetting: {},
      closedTradesOpened: window.innerWidth >= 826,
      openedTradesOpened: window.innerWidth >= 826,
      selectedPeriod: null,
      selectedPeriodTZ: null,
      selectedPeriodLC: null
    };

    this.setUpdate = this.setUpdate.bind(this);
    this.requestClosedTradesSetPeriod =
      this.requestClosedTradesSetPeriod.bind(this);
    this.handleClosedTradesClick = this.handleClosedTradesClick.bind(this);
    this.handleOpenedTradesClick = this.handleOpenedTradesClick.bind(this);
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

      this.setState({
        symbols
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

    const { selectedPeriod, selectedPeriodTZ, selectedPeriodLC } = this.state;
    const { loadedPeriod, loadedPeriodTZ, loadedPeriodLC } =
      this.state.closedTradesSetting;

    // Set initial selected period
    if (loadedPeriod !== undefined && selectedPeriod === null) {
      this.setState({
        selectedPeriod: loadedPeriod,
        selectedPeriodTZ: loadedPeriodTZ,
        selectedPeriodLC: loadedPeriodLC
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

  handleClosedTradesClick(event) {
    const target = event.target.tagName.toLowerCase();
    if (target !== 'i' && target !== 'button') {
      this.setState({
        closedTradesOpened: !this.state.closedTradesOpened
      });
    }
  }

  handleOpenedTradesClick(event) {
    const target = event.target.tagName.toLowerCase();
    if (target !== 'i' && target !== 'button') {
      this.setState({
        openedTradesOpened: !this.state.openedTradesOpened
      });
    }
  }

  setUpdate(newStatus) {
    this.setState({
      canUpdate: newStatus
    });
  }

  requestClosedTradesSetPeriod() {
    const { selectedPeriod, selectedPeriodTZ, selectedPeriodLC } = this.state;
    return axios.post('/closed-trades-set-period', {
      selectedPeriod,
      selectedPeriodTZ,
      selectedPeriodLC
    });
  }

  setSelectedPeriod(newSelectedPeriod) {
    const newSelectedPeriodTZ =
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    const newSelectedPeriodLC = Intl.DateTimeFormat().resolvedOptions().locale;
    this.setState(
      {
        selectedPeriod: newSelectedPeriod,
        selectedPeriodTZ: newSelectedPeriodTZ,
        selectedPeriodLC: newSelectedPeriodLC
      },
      () => this.requestClosedTradesSetPeriod()
    );
  }

  render() {
    const { sendWebSocket, isAuthenticated, closedTrades, totalProfitAndLoss } =
      this.props;
    const {
      symbols,
      selectedPeriod,
      closedTradesLoading,
      closedTradesOpened,
      openedTradesOpened
    } = this.state;

    if (_.isEmpty(totalProfitAndLoss)) {
      return '';
    }

    const openTradeWrappers = Object.values(totalProfitAndLoss).map(
      (profitAndLoss, index) => {
        const percentage =
          profitAndLoss.amount > 0
            ? ((profitAndLoss.profit / profitAndLoss.amount) * 100).toFixed(2)
            : 0;

        const quoteAssetTotal =
          profitAndLoss.estimatedBalance -
          +profitAndLoss.profit +
          +profitAndLoss.free +
          +profitAndLoss.locked;
        const openTradesRatio = quoteAssetTotal
          ? ((profitAndLoss.estimatedBalance - +profitAndLoss.profit) /
              quoteAssetTotal) *
            100
          : 0;

        return (
          <div
            key={`open-trade-pnl-` + index}
            className='profit-loss-wrapper pt-2 pl-2 pr-2 pb-0'>
            <div className='profit-loss-wrapper-body'>
              <div className='profit-loss-asset'>
                {profitAndLoss.asset}
                <br />
                <div
                  className={`${
                    openTradesRatio > 90
                      ? 'text-danger'
                      : openTradesRatio > 50
                      ? 'text-warning'
                      : 'text-success'
                  } text-truncate`}>
                  {profitAndLoss.estimatedBalance.toFixed(5)}
                </div>
                <div className='fs-9'>
                  {openTradesRatio.toFixed(2) +
                    '% of ' +
                    quoteAssetTotal.toFixed(5) +
                    ' ' +
                    profitAndLoss.asset}
                </div>
              </div>{' '}
              <div
                className={`profit-loss-value ${
                  profitAndLoss.profit > 0
                    ? 'text-success'
                    : profitAndLoss.profit < 0
                    ? 'text-danger'
                    : ''
                }`}>
                {profitAndLoss.profit > 0 ? '+' : ''}
                {profitAndLoss.profit.toFixed(5)}
                <br />({percentage}%)
              </div>
            </div>
          </div>
        );
      }
    );

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
                <div className='fs-9'>
                  {stat.lastArchivedAt
                    ? stat.lastSymbol +
                      ' ' +
                      (stat.lastProfit > 0 ? '+' : '') +
                      parseFloat(stat.lastProfit).toFixed(5) +
                      ' ' +
                      stat.quoteAsset
                    : 'No closed trades yet'}
                </div>
              </div>{' '}
              <div className='profit-loss-value'>
                <span
                  className={`${
                    stat.profit > 0
                      ? 'text-success'
                      : stat.profit < 0
                      ? 'text-danger'
                      : ''
                  }`}>
                  {stat.profit > 0 ? '+' : ''}
                  {stat.profit.toFixed(5)}
                  <br />({stat.profitPercentage.toFixed(2)}%)
                </span>
                <div
                  className='fs-9'
                  title={
                    stat.lastArchivedAt
                      ? moment(stat.lastArchivedAt).format()
                      : ''
                  }>
                  {stat.lastArchivedAt
                    ? moment(stat.lastArchivedAt).fromNow()
                    : ''}
                </div>
              </div>
            </div>
          </div>
        );
      }
    );

    return (
      <div className='profit-loss-container'>
        <div className='accordion-wrapper profit-loss-accordion-wrapper profit-loss-open-trades-accordion-wrapper'>
          <Accordion>
            <Card bg='dark'>
              <Accordion.Toggle
                as={Card.Header}
                onClick={this.handleOpenedTradesClick}
                className='px-2 py-1'>
                <div className='d-flex flex-row justify-content-between'>
                  <div className='flex-column-left'>
                    <div className='btn-profit-loss text-uppercase text-left font-weight-bold btn-link'>
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
                          className='p-0 m-0 ml-1 text-info align-baseline'>
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
              </Accordion.Toggle>
              <Accordion.Collapse in={openedTradesOpened}>
                <Card.Body className='d-flex flex-column py-2 px-0 card-body'>
                  <div className='profit-loss-wrappers profit-loss-open-trades-wrappers'>
                    {_.isEmpty(totalProfitAndLoss) ? (
                      <div className='text-center w-100 m-3'>
                        <Spinner
                          animation='border'
                          role='status'
                          style={{ width: '3rem', height: '3rem' }}>
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
          <Accordion>
            <Card bg='dark'>
              <Accordion.Toggle
                as={Card.Header}
                onClick={this.handleClosedTradesClick}
                className='px-2 py-1'>
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
                            <Popover.Content>
                              This section displays the total profit of each
                              asset as well as the number of closed trades and
                              the last trade profit.
                            </Popover.Content>
                          </Popover>
                        }>
                        <Button
                          variant='link'
                          className='p-0 m-0 ml-1 text-info align-baseline'>
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
              </Accordion.Toggle>
              <Accordion.Collapse in={closedTradesOpened}>
                <Card.Body className='d-flex flex-column py-2 px-0 card-body'>
                  <div className='profit-loss-wrappers profit-loss-open-trades-wrappers'>
                    {closedTradesLoading === true || _.isEmpty(closedTrades) ? (
                      <div className='text-center w-100 m-3'>
                        <Spinner
                          animation='border'
                          role='status'
                          style={{ width: '3rem', height: '3rem' }}>
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
