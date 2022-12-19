/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolGridCalculator extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false,
      scenario: {}
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
    this.handleInputChange = this.handleInputChange.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      this.state.showModal === false &&
      _.isEmpty(nextProps.scenario) === false &&
      _.isEqual(nextProps.scenario, this.state.scenario) === false
    ) {
      this.setState({
        scenario: nextProps.scenario
      });
    }
  }

  handleModalShow() {
    this.setState({
      showModal: true,
      scenario: {}
    });
  }

  handleModalClose() {
    this.setState({
      showModal: false
    });
  }

  handleInputChange(event) {
    const target = event.target;
    const value =
      target.type === 'button'
        ? target.getAttribute('data-state-value')
        : target.type === 'checkbox'
        ? target.checked
        : target.type === 'number'
        ? +target.value
        : target.value;

    const stateKey = target.getAttribute('data-state-key');

    const { scenario } = this.state;

    this.setState({
      scenario: _.set(scenario, stateKey, value)
    });
  }

  render() {
    const { symbol, symbolInfo, isAuthenticated } = this.props;

    if (isAuthenticated === false) {
      return '';
    }

    const {
      symbolInfo: {
        filterPrice: { tickSize },
        quoteAsset
      },
      symbolConfiguration
    } = symbolInfo;

    const {
      buy: { gridTrade }
    } = symbolConfiguration;

    const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    const currentPrice = parseFloat(symbolInfo.sell.currentPrice);

    const lastBuyPrice = parseFloat(symbolInfo.sell.lastBuyPrice);

    const currentSellPercentage = parseFloat(
      symbolConfiguration.sell.currentGridTrade.triggerPercentage
    );

    const currentBuyPercentage =
      1 - (lastBuyPrice - currentPrice) / lastBuyPrice;

    const totalBoughtQty = gridTrade
      .filter(trade => trade.executed)
      .map(order => parseFloat(order.executedOrder.executedQty))
      .reduce((acc, qty) => acc + qty, 0);

    const totalBoughtAmount = gridTrade
      .filter(trade => trade.executed)
      .map(order => parseFloat(order.executedOrder.cummulativeQuoteQty))
      .reduce((acc, qty) => acc + qty, 0);

    const buyTrigger =
      parseFloat(this.state.scenario.buyTrigger) || currentBuyPercentage;

    const sellTrigger =
      parseFloat(this.state.scenario.sellTrigger) || currentSellPercentage;

    const priceEquivalent = currentPrice * parseFloat(sellTrigger);

    const differenceFromCurrentPrice =
      (100 * (buyTrigger * lastBuyPrice - currentPrice)) / currentPrice;

    const breakevenAmount =
      (totalBoughtAmount -
        totalBoughtQty * buyTrigger * lastBuyPrice * sellTrigger) /
      (sellTrigger - 1);

    return (
      <span className='header-column-icon-wrapper grid-calculator-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link mx-1 p-0 text-white'
          onClick={this.handleModalShow}>
          <i className='fas fa-calculator fa-sm'></i>
        </button>

        <Modal show={this.state.showModal} onHide={this.handleModalClose}>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>Grid calculator - {symbol}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            Determine the amount you would need to purchase at a specific buy
            trigger point and achieve break-even if the market price rebounds to
            your targeted percentage.
            <div className='grid-calculator-row grid-calculator-wrapper mt-2'>
              <Form.Group className='mb-2'>
                <Form.Label className='mb-0 font-weight-bold'>
                  Buy trigger percentage based on last buy price
                </Form.Label>
                <FormControl
                  size='sm'
                  type='number'
                  step='0.0001'
                  placeholder='Enter buy trigger %'
                  required
                  defaultValue={currentBuyPercentage.toFixed(3)}
                  data-state-key='buyTrigger'
                  onChange={this.handleInputChange}
                />
                <Form.Text className='ml-2 text-muted'>
                  Difference from current price:{' '}
                  {differenceFromCurrentPrice.toFixed(3)}% — Buy trigger with
                  current price: {currentBuyPercentage.toFixed(3)}
                </Form.Text>
              </Form.Group>
              <Form.Group className='mb-2'>
                <Form.Label className='mb-0 font-weight-bold'>
                  Expected price rebound percentage
                </Form.Label>
                <FormControl
                  size='sm'
                  type='number'
                  step='0.0001'
                  placeholder='Enter price increase percentage'
                  required
                  min='1'
                  defaultValue={currentSellPercentage.toFixed(4)}
                  data-state-key='sellTrigger'
                  onChange={this.handleInputChange}
                />
                <Form.Text className='ml-2 text-muted'>
                  {currentSellPercentage
                    ? `Equivalent market price: ${priceEquivalent.toFixed(
                        precision
                      )}`
                    : '\u00A0'}
                </Form.Text>
              </Form.Group>
            </div>
            <div>
              {buyTrigger >= 1 ? (
                <span>
                  <b>Result: </b>the bot will make a new purchase only if the
                  price goes down. Set a trigger percentage inferior to 1.
                </span>
              ) : breakevenAmount > 0 ? (
                <span>
                  <b>Result: </b>executing a new grid at
                  <code> {((buyTrigger - 1) * 100).toFixed(2)}% </code>
                  from your current last buy price with a purchase amount of
                  <code>
                    {' '}
                    {sellTrigger === 1
                      ? ' - '
                      : breakevenAmount.toFixed(2)}{' '}
                    {quoteAsset}
                  </code>
                  , would allow you to break-even if the market price rebounds
                  <code> {((sellTrigger - 1) * 100).toFixed(2)}%</code>.
                </span>
              ) : sellTrigger > 1 ? (
                <span>
                  <b>Result: </b>it is pointless to execute a new grid at
                  <code> {((buyTrigger - 1) * 100).toFixed(2)}% </code> from
                  your current last buy price if you expect the market price to
                  rebound <code> {((sellTrigger - 1) * 100).toFixed(2)}%</code>,
                  as you would breakeven by reaching your current last buy price
                  of <code> {lastBuyPrice.toFixed(precision)}</code>.
                </span>
              ) : (
                <span>
                  <b>Result: </b>it is pointless to execute a new grid if you
                  don't expect a price rebound. You should set a price rebound
                  percentage superior to 1.
                </span>
              )}
              <img
                src='./img/calculator-diagram.png'
                className='px-4 pt-2'
                width='100%'
                alt='Grid calculator'
              />
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={this.handleModalClose}>
              Close
            </Button>
          </Modal.Footer>
        </Modal>
      </span>
    );
  }
}
