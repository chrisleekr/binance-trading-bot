/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

class CoinWrapperManualTrade extends React.Component {
  constructor(props) {
    super(props);

    this.initialOrder = {
      side: null,
      buy: {
        type: 'limit', // limit or market
        price: 0, // limit price
        quantity: 0, // limit quantity
        total: 0, // limit total
        marketType: 'total', // total or amount
        marketQuantity: 0, // market quantity
        quoteOrderQty: 0, // market total
        isValid: false
      },
      sell: {
        type: 'limit', // limit or market
        price: 0, // limit price
        quantity: 0, // limit quantity
        total: 0, // limit total
        marketType: 'total', // total or amount
        marketQuantity: 0, // market quantity
        quoteOrderQty: 0, // market total
        isValid: false
      }
    };

    this.state = {
      showModal: false,
      lastCandle: null,
      order: _.cloneDeep(this.initialOrder)
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleFormSubmit = this.handleFormSubmit.bind(this);
    this.handleInputChange = this.handleInputChange.bind(this);
    this.handleClick = this.handleClick.bind(this);

    this.calculatePercentage = this.calculatePercentage.bind(this);
  }

  componentDidUpdate(nextProps) {
    const { showModal, lastCandle } = this.state;
    // Only update symbol configuration, when the modal is closed and different.
    if (showModal === false) {
      // Modal is not opened, update state
      // Update lastCandle
      if (
        _.get(nextProps, 'lastCandle', null) !== null &&
        _.isEqual(_.get(nextProps, 'lastCandle', null), lastCandle) === false
      ) {
        const newLastCandle = nextProps.lastCandle;

        this.setState({ lastCandle: newLastCandle });
      }
    } else {
      // Modal is opened, no state update
    }
  }

  handleModalShow() {
    const { lastCandle } = this.state;
    const newOrder = _.cloneDeep(this.initialOrder);
    newOrder.buy.price = parseFloat(lastCandle.close);
    newOrder.sell.price = parseFloat(lastCandle.close);

    this.setState({
      showModal: true,
      order: newOrder
    });
  }

  handleModalClose() {
    this.setState({
      showModal: false
    });
  }

  handleClick(e) {
    e.target.select();
  }

  calculateTotal(order) {
    const { quotePrecision } = this.props;

    order.buy.total = parseFloat(
      (parseFloat(order.buy.price) * parseFloat(order.buy.quantity)).toFixed(
        quotePrecision
      )
    );

    order.sell.total = parseFloat(
      (parseFloat(order.sell.price) * parseFloat(order.sell.quantity)).toFixed(
        quotePrecision
      )
    );
    return this.validateOrder(order);
  }

  validateOrder(order) {
    const { baseAssetBalance, quoteAssetBalance } = this.props;
    const { lastCandle } = this.state;

    const baseAssetBalanceFree = parseFloat(baseAssetBalance.free);
    const quoteAssetBalanceFree = parseFloat(quoteAssetBalance.free);

    const currentPrice = parseFloat(lastCandle.close);

    order.buy.isValid = false;
    order.sell.isValid = false;

    if (order.buy.type === 'limit') {
      // Total must be more than 0 and total must be less than the quote asset balance.
      if (order.buy.total > 0 && order.buy.total <= quoteAssetBalanceFree) {
        order.buy.isValid = true;
      }
    }

    if (order.sell.type === 'limit') {
      // Total must be more than 0 and quantity must be less than the base asset balance.
      if (order.sell.total > 0 && order.sell.quantity <= baseAssetBalanceFree) {
        order.sell.isValid = true;
      }
    }

    if (order.buy.type === 'market') {
      // Quote amount must be more than 0 and must be less than the quote asset balance.
      if (
        order.buy.marketType === 'total' &&
        order.buy.quoteOrderQty > 0 &&
        order.buy.quoteOrderQty <= quoteAssetBalanceFree
      ) {
        order.buy.isValid = true;
      }

      // Quantity must be more than 0 and total amount must be less than the quote asset balance.
      if (
        order.buy.marketType === 'amount' &&
        order.buy.marketQuantity > 0 &&
        order.buy.marketQuantity * currentPrice <= quoteAssetBalanceFree
      ) {
        order.buy.isValid = true;
      }
    }

    if (order.sell.type === 'market') {
      // Quote amount must be more than 0 and quantity must be less than the base asset balance.
      if (
        order.sell.marketType === 'total' &&
        order.sell.quoteOrderQty > 0 &&
        order.sell.quoteOrderQty / currentPrice <= baseAssetBalanceFree
      ) {
        order.sell.isValid = true;
      }

      // Quantity must be more than 0 and must be less than the base asset balance.
      if (
        order.sell.marketType === 'amount' &&
        order.sell.marketQuantity > 0 &&
        order.sell.marketQuantity <= baseAssetBalanceFree
      ) {
        order.sell.isValid = true;
      }
    }
    return order;
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

    const { order } = this.state;

    const newOrder = this.calculateTotal(_.set(order, stateKey, value));
    this.setState({
      order: newOrder
    });
  }

  handleFormSubmit(e) {
    e.preventDefault();
    console.log('handleFormSubmit', this.state.order);

    this.handleModalClose();

    this.props.sendWebSocket('manual-trade', {
      symbol: this.props.symbol,
      order: this.state.order
    });
  }

  calculatePercentageLimitBuy({
    quoteAssetBalance,
    currentPrice,
    percentage,
    filterPrice,
    baseAssetStepSize
  }) {
    const quoteAssetBalanceFree = parseFloat(quoteAssetBalance.free);

    let newAmount = _.floor(
      (quoteAssetBalanceFree / currentPrice) * (percentage / 100),
      baseAssetStepSize
    );

    if (parseFloat(newAmount) > parseFloat(filterPrice.maxPrice)) {
      newAmount = parseFloat(filterPrice.maxPrice).toFixed(baseAssetStepSize);
    }

    return parseFloat(newAmount);
  }

  calculatePercentageLimitSell({
    baseAssetBalance,
    percentage,
    baseAssetStepSize,
    filterLotSize
  }) {
    const baseAssetBalanceFree = parseFloat(baseAssetBalance.free);

    // Make base asset precision correctly
    let newAmount = _.floor(
      baseAssetBalanceFree * (percentage / 100),
      baseAssetStepSize
    );

    if (parseFloat(newAmount) > parseFloat(filterLotSize.maxQty)) {
      newAmount = parseFloat(filterLotSize.maxQty).toFixed(baseAssetStepSize);
    }

    return parseFloat(newAmount);
  }

  calculatePercentageMarketBuyTotal({
    quoteAssetBalance,
    quoteAssetTickSize,
    percentage,
    filterPrice
  }) {
    const quoteAssetBalanceFree = parseFloat(quoteAssetBalance.free);

    let newAmount = _.floor(
      quoteAssetBalanceFree * (percentage / 100),
      quoteAssetTickSize
    );

    if (parseFloat(newAmount) > parseFloat(filterPrice.maxPrice)) {
      newAmount = parseFloat(filterPrice.maxPrice).toFixed(quoteAssetTickSize);
    }

    return parseFloat(newAmount);
  }

  calculatePercentageMarketBuyAmount({
    quoteAssetBalance,
    lastCandle,
    baseAssetStepSize,
    percentage,
    filterLotSize
  }) {
    const quoteAssetBalanceFree = parseFloat(quoteAssetBalance.free);
    const currentPrice = parseFloat(lastCandle.close);

    let newAmount = _.floor(
      (quoteAssetBalanceFree / currentPrice) * (percentage / 100),
      baseAssetStepSize
    );

    if (parseFloat(newAmount) > parseFloat(filterLotSize.maxQty)) {
      newAmount = parseFloat(filterLotSize.maxQty).toFixed(baseAssetStepSize);
    }

    return parseFloat(newAmount);
  }

  calculatePercentageMarketSellTotal({
    baseAssetBalance,
    lastCandle,
    quoteAssetTickSize,
    percentage,
    filterPrice
  }) {
    const baseAssetBalanceFree = parseFloat(baseAssetBalance.free);
    const currentPrice = parseFloat(lastCandle.close);

    let newAmount = _.floor(
      baseAssetBalanceFree * currentPrice * (percentage / 100),
      quoteAssetTickSize
    );

    if (parseFloat(newAmount) > parseFloat(filterPrice.maxPrice)) {
      newAmount = parseFloat(filterPrice.maxPrice).toFixed(quoteAssetTickSize);
    }

    return parseFloat(newAmount);
  }

  calculatePercentageMarketSellAmount({
    baseAssetBalance,
    baseAssetStepSize,
    percentage,
    filterLotSize
  }) {
    const baseAssetBalanceFree = parseFloat(baseAssetBalance.free);

    let newAmount = _.floor(
      baseAssetBalanceFree * (percentage / 100),
      baseAssetStepSize
    );

    if (parseFloat(newAmount) > parseFloat(filterLotSize.maxQty)) {
      newAmount = parseFloat(filterLotSize.maxQty).toFixed(baseAssetStepSize);
    }

    return parseFloat(newAmount);
  }

  calculatePercentage(side, percentage) {
    const {
      baseAssetStepSize,
      quoteAssetTickSize,
      filterPrice,
      filterLotSize,
      baseAssetBalance,
      quoteAssetBalance
    } = this.props;

    const { lastCandle } = this.state;

    const { order } = this.state;
    const orderParams = order[side];

    if (orderParams.type === 'limit' && side === 'buy') {
      orderParams.quantity = this.calculatePercentageLimitBuy({
        quoteAssetBalance,
        currentPrice: parseFloat(orderParams.price),
        percentage,
        filterPrice,
        baseAssetStepSize
      });
    } else if (orderParams.type === 'limit' && side === 'sell') {
      orderParams.quantity = this.calculatePercentageLimitSell({
        baseAssetBalance,
        percentage,
        baseAssetStepSize,
        filterLotSize
      });
    } else if (
      orderParams.type === 'market' &&
      side === 'buy' &&
      orderParams.marketType === 'total'
    ) {
      orderParams.quoteOrderQty = this.calculatePercentageMarketBuyTotal({
        quoteAssetBalance,
        quoteAssetTickSize,
        percentage,
        filterPrice
      });
    } else if (
      orderParams.type === 'market' &&
      side === 'buy' &&
      orderParams.marketType === 'amount'
    ) {
      orderParams.marketQuantity = this.calculatePercentageMarketBuyAmount({
        quoteAssetBalance,
        lastCandle,
        baseAssetStepSize,
        percentage,
        filterLotSize
      });
    } else if (
      orderParams.type === 'market' &&
      side === 'sell' &&
      orderParams.marketType === 'total'
    ) {
      orderParams.quoteOrderQty = this.calculatePercentageMarketSellTotal({
        baseAssetBalance,
        lastCandle,
        quoteAssetTickSize,
        percentage,
        filterPrice
      });
    } else if (
      orderParams.type === 'market' &&
      side === 'sell' &&
      orderParams.marketType === 'amount'
    ) {
      orderParams.marketQuantity = this.calculatePercentageMarketSellAmount({
        baseAssetBalance,
        baseAssetStepSize,
        percentage,
        filterLotSize
      });
    }

    order[side] = orderParams;

    const newOrder = this.calculateTotal(order);

    this.setState({
      order: newOrder
    });
  }

  render() {
    const {
      symbol,
      filterPrice,
      filterLotSize,
      baseAssetBalance,
      quoteAssetBalance,
      baseAssetStepSize,
      quoteAssetTickSize
    } = this.props;

    const { showModal, lastCandle, order } = this.state;

    if (_.get(lastCandle, 'close', null) === null) {
      return '';
    }

    return (
      <div className='coin-info-symbol-manual-trade-wrapper'>
        <div className='coin-info-column coin-info-column-symbol-manual-trade d-flex flex-row justify-content-start align-content-between border-bottom-0 mb-0 pb-0'>
          <button
            type='button'
            className='btn btn-sm btn-manual-trade mr-1'
            onClick={() => this.handleModalShow()}>
            <i className='fa fa-shopping-bag'></i> Trade
          </button>
        </div>
        <Modal
          show={showModal}
          onHide={() => this.handleModalClose()}
          backdrop='static'
          size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>Manual trade for {symbol}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className='d-block text-muted mb-2'>
              In this modal, you can trade {symbol} manually. If you already
              have the last buy price, then the bot will calculate average cost
              and re-calculate the last buy price.
              <br />
              To make sure the last buy price is recorded only if the order is
              successfully executed, the bot will monitor the order after
              placing the buy order. This action may increase the use of API
              weight.
            </p>

            <div className='manual-trade-wrappers'>
              <div className='manual-trade-wrapper manual-trade-buy-wrapper'>
                <div className='manual-trade-title-wrapper d-flex flex-row justify-content-between'>
                  <span className='manual-trade-title-buy'>
                    Buy {baseAssetBalance.asset}
                  </span>
                </div>
                <div className='manual-trade-row d-flex flex-row justify-content-between mt-1'>
                  <div className='manual-trade-label'>Current price</div>
                  <span className='manual-trade-quote-asset'>
                    1 {baseAssetBalance.asset} ={' '}
                    {parseFloat(lastCandle.close).toFixed(quoteAssetTickSize)}{' '}
                    {quoteAssetBalance.asset}
                  </span>
                </div>
                <div className='manual-trade-row d-flex flex-row justify-content-between mt-1'>
                  <div className='manual-trade-label'>Balance</div>
                  <span className='manual-trade-quote-asset'>
                    {parseFloat(quoteAssetBalance.free).toFixed(
                      quoteAssetTickSize
                    )}{' '}
                    {quoteAssetBalance.asset}
                  </span>
                </div>
                <div className='manual-trade-row manual-trade-type-wrapper mt-2'>
                  <ButtonGroup size='sm' className='d-block'>
                    <Button
                      variant={
                        order.buy.type === 'limit' ? 'primary' : 'secondary'
                      }
                      className='w-50'
                      data-state-key='buy.type'
                      data-state-value='limit'
                      onClick={e => this.handleInputChange(e)}>
                      Limit
                    </Button>
                    <Button
                      variant={
                        order.buy.type === 'market' ? 'primary' : 'secondary'
                      }
                      className='w-50'
                      data-state-key='buy.type'
                      data-state-value='market'
                      onClick={e => this.handleInputChange(e)}>
                      Market
                    </Button>
                  </ButtonGroup>
                </div>
                <div className='manual-trade-row manual-trade-price-wrapper mt-2'>
                  <Form.Group controlId='field-buy-price' className='mb-2'>
                    <Form.Label htmlFor='field-buy-price-input' srOnly>
                      Price
                    </Form.Label>
                    <InputGroup size='sm'>
                      <InputGroup.Prepend>
                        <InputGroup.Text>Price</InputGroup.Text>
                      </InputGroup.Prepend>
                      {order.buy.type === 'limit' ? (
                        <FormControl
                          id='field-buy-price-input'
                          type='number'
                          placeholder='Price'
                          step={filterPrice.tickSize}
                          className='text-right'
                          data-state-key='buy.price'
                          value={order.buy.price}
                          onClick={this.handleClick}
                          onChange={this.handleInputChange}
                        />
                      ) : (
                        <FormControl
                          id='field-buy-price-input'
                          type='text'
                          className='text-right'
                          value='Market'
                          disabled={true}
                        />
                      )}

                      <InputGroup.Append>
                        <InputGroup.Text>
                          {quoteAssetBalance.asset}
                        </InputGroup.Text>
                      </InputGroup.Append>
                    </InputGroup>
                  </Form.Group>
                </div>
                {order.buy.type === 'limit' ? (
                  <div className='manual-trade-row manual-trade-quantity-wrapper mt-2'>
                    <Form.Group controlId='field-buy-quantity' className='mb-2'>
                      <Form.Label htmlFor='field-buy-quantity-input' srOnly>
                        Amount
                      </Form.Label>
                      <InputGroup size='sm'>
                        <InputGroup.Prepend>
                          <InputGroup.Text>Amount</InputGroup.Text>
                        </InputGroup.Prepend>
                        <FormControl
                          id='field-buy-quantity-input'
                          type='number'
                          placeholder='Amount'
                          step={filterLotSize.stepSize}
                          className='text-right'
                          max={filterLotSize.maxQty}
                          data-state-key='buy.quantity'
                          value={order.buy.quantity}
                          onClick={this.handleClick}
                          onChange={this.handleInputChange}
                        />
                        <InputGroup.Append>
                          <InputGroup.Text>
                            {baseAssetBalance.asset}
                          </InputGroup.Text>
                        </InputGroup.Append>
                      </InputGroup>
                    </Form.Group>
                  </div>
                ) : (
                  ''
                )}
                {order.buy.type === 'market' ? (
                  <div className='manual-trade-row-wrapper manual-trade-row-wrapper-market'>
                    <div className='manual-trade-row manual-trade-type-wrapper mt-2'>
                      <ButtonGroup size='sm' className='d-block'>
                        <Button
                          variant={
                            order.buy.marketType === 'total'
                              ? 'primary'
                              : 'secondary'
                          }
                          className='w-50'
                          data-state-key='buy.marketType'
                          data-state-value='total'
                          onClick={e => this.handleInputChange(e)}>
                          Total
                        </Button>
                        <Button
                          variant={
                            order.buy.marketType === 'amount'
                              ? 'primary'
                              : 'secondary'
                          }
                          className='w-50'
                          data-state-key='buy.marketType'
                          data-state-value='amount'
                          onClick={e => this.handleInputChange(e)}>
                          Amount
                        </Button>
                      </ButtonGroup>
                    </div>

                    <div className='manual-trade-row manual-trade-market-total-wrapper mt-2'>
                      <Form.Group
                        controlId='field-buy-market-total'
                        className='mb-2'>
                        <Form.Label
                          htmlFor='field-buy-market-total-input'
                          srOnly>
                          {order.buy.marketType === 'total'
                            ? 'Total'
                            : 'Amount'}
                        </Form.Label>
                        <InputGroup size='sm'>
                          <InputGroup.Prepend>
                            <InputGroup.Text>
                              {order.buy.marketType === 'total'
                                ? 'Total'
                                : 'Amount'}
                            </InputGroup.Text>
                          </InputGroup.Prepend>
                          {order.buy.marketType === 'total' ? (
                            <FormControl
                              id='field-buy-market-total-input'
                              type='number'
                              placeholder='Quantity'
                              step={filterPrice.tickSize}
                              className='text-right'
                              data-state-key='buy.quoteOrderQty'
                              value={order.buy.quoteOrderQty}
                              onClick={this.handleClick}
                              onChange={this.handleInputChange}
                            />
                          ) : (
                            ''
                          )}
                          {order.buy.marketType === 'amount' ? (
                            <FormControl
                              id='field-buy-market-total-input'
                              type='number'
                              step={filterLotSize.stepSize}
                              placeholder='Total'
                              className='text-right'
                              data-state-key='buy.marketQuantity'
                              value={order.buy.marketQuantity}
                              onClick={this.handleClick}
                              onChange={this.handleInputChange}
                            />
                          ) : (
                            ''
                          )}

                          <InputGroup.Append>
                            <InputGroup.Text>
                              {order.buy.marketType === 'total'
                                ? quoteAssetBalance.asset
                                : baseAssetBalance.asset}
                            </InputGroup.Text>
                          </InputGroup.Append>
                        </InputGroup>
                      </Form.Group>
                    </div>
                  </div>
                ) : (
                  ''
                )}
                <div className='manual-trade-row manual-trade-quantity-percentage-wrapper mt-2'>
                  <ButtonGroup size='sm' className='d-block font'>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('buy', 0)}>
                      0%
                    </Button>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('buy', 25)}>
                      25%
                    </Button>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('buy', 50)}>
                      50%
                    </Button>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('buy', 75)}>
                      75%
                    </Button>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('buy', 100)}>
                      100%
                    </Button>
                  </ButtonGroup>
                </div>
                {order.buy.type === 'limit' ? (
                  <div className='manual-trade-row manual-trade-total-wrapper mt-2'>
                    <Form.Group controlId='field-buy-total' className='mb-2'>
                      <Form.Label htmlFor='field-buy-total-input' srOnly>
                        Total
                      </Form.Label>
                      <InputGroup size='sm'>
                        <InputGroup.Prepend>
                          <InputGroup.Text>Total</InputGroup.Text>
                        </InputGroup.Prepend>
                        <FormControl
                          id='field-buy-total-input'
                          type='number'
                          placeholder='Amount'
                          className='text-right'
                          value={order.buy.total}
                          disabled
                        />
                        <InputGroup.Append>
                          <InputGroup.Text>
                            {quoteAssetBalance.asset}
                          </InputGroup.Text>
                        </InputGroup.Append>
                      </InputGroup>
                    </Form.Group>
                  </div>
                ) : (
                  ''
                )}

                <div className='manual-trade-row manual-trade-button-wrapper mt-2'>
                  <button
                    type='button'
                    className='btn btn-sm w-100 btn-manual btn-manual-buy mr-1'
                    data-state-key='side'
                    data-state-value='buy'
                    disabled={order.buy.isValid === false}
                    onClick={e => {
                      this.handleInputChange(e);
                      this.handleFormSubmit(e);
                    }}>
                    Buy {baseAssetBalance.asset}
                  </button>
                </div>
              </div>
              <div className='manual-trade-wrapper manual-trade-sell-wrapper'>
                <div className='manual-trade-title-wrapper d-flex flex-row justify-content-between'>
                  <span className='manual-trade-title-buy font-weight-bolder'>
                    Sell {baseAssetBalance.asset}
                  </span>
                </div>

                <div className='manual-trade-row d-flex flex-row justify-content-between mt-1'>
                  <div className='manual-trade-label'>Current price</div>
                  <span className='manual-trade-quote-asset'>
                    1 {baseAssetBalance.asset} ={' '}
                    {parseFloat(lastCandle.close).toFixed(quoteAssetTickSize)}{' '}
                    {quoteAssetBalance.asset}
                  </span>
                </div>
                <div className='manual-trade-row d-flex flex-row justify-content-between'>
                  <div className='manual-trade-label'>Balance</div>
                  <span className='manual-trade-base-sset'>
                    {parseFloat(baseAssetBalance.free).toFixed(
                      baseAssetStepSize
                    )}{' '}
                    {baseAssetBalance.asset}
                  </span>
                </div>
                <div className='manual-trade-row manual-trade-type-wrapper mt-2'>
                  <ButtonGroup size='sm' className='d-block'>
                    <Button
                      variant={
                        order.sell.type === 'limit' ? 'primary' : 'secondary'
                      }
                      className='w-50'
                      data-state-key='sell.type'
                      data-state-value='limit'
                      onClick={e => this.handleInputChange(e)}>
                      Limit
                    </Button>
                    <Button
                      variant={
                        order.sell.type === 'market' ? 'primary' : 'secondary'
                      }
                      className='w-50'
                      data-state-key='sell.type'
                      data-state-value='market'
                      onClick={e => this.handleInputChange(e)}>
                      Market
                    </Button>
                  </ButtonGroup>
                </div>
                <div className='manual-trade-row manual-trade-price-wrapper mt-2'>
                  <Form.Group controlId='field-sell-price' className='mb-2'>
                    <Form.Label htmlFor='field-sell-price-input' srOnly>
                      Price
                    </Form.Label>
                    <InputGroup size='sm'>
                      <InputGroup.Prepend>
                        <InputGroup.Text>Price</InputGroup.Text>
                      </InputGroup.Prepend>
                      {order.sell.type === 'limit' ? (
                        <FormControl
                          id='field-sell-price-input'
                          type='number'
                          placeholder='Price'
                          step={filterPrice.tickSize}
                          className='text-right'
                          data-state-key='sell.price'
                          value={order.sell.price}
                          onClick={this.handleClick}
                          onChange={this.handleInputChange}
                        />
                      ) : (
                        <FormControl
                          id='field-sell-price-input'
                          type='text'
                          className='text-right'
                          value='Market'
                          disabled={true}
                        />
                      )}

                      <InputGroup.Append>
                        <InputGroup.Text>
                          {quoteAssetBalance.asset}
                        </InputGroup.Text>
                      </InputGroup.Append>
                    </InputGroup>
                  </Form.Group>
                </div>
                {order.sell.type === 'limit' ? (
                  <div className='manual-trade-row manual-trade-quantity-wrapper mt-2'>
                    <Form.Group
                      controlId='field-sell-quantity'
                      className='mb-2'>
                      <Form.Label htmlFor='field-sell-quantity-input' srOnly>
                        Amount
                      </Form.Label>
                      <InputGroup size='sm'>
                        <InputGroup.Prepend>
                          <InputGroup.Text>Amount</InputGroup.Text>
                        </InputGroup.Prepend>
                        <FormControl
                          id='field-sell-quantity-input'
                          type='number'
                          placeholder='Amount'
                          step={filterLotSize.stepSize}
                          className='text-right'
                          max={filterLotSize.maxQty}
                          data-state-key='sell.quantity'
                          value={order.sell.quantity}
                          onClick={this.handleClick}
                          onChange={this.handleInputChange}
                        />
                        <InputGroup.Append>
                          <InputGroup.Text>
                            {baseAssetBalance.asset}
                          </InputGroup.Text>
                        </InputGroup.Append>
                      </InputGroup>
                    </Form.Group>
                  </div>
                ) : (
                  ''
                )}
                {order.sell.type === 'market' ? (
                  <div className='manual-trade-row-wrapper manual-trade-row-wrapper-market'>
                    <div className='manual-trade-row manual-trade-type-wrapper mt-2'>
                      <ButtonGroup size='sm' className='d-block'>
                        <Button
                          variant={
                            order.sell.marketType === 'total'
                              ? 'primary'
                              : 'secondary'
                          }
                          className='w-50'
                          data-state-key='sell.marketType'
                          data-state-value='total'
                          onClick={e => this.handleInputChange(e)}>
                          Total
                        </Button>
                        <Button
                          variant={
                            order.sell.marketType === 'amount'
                              ? 'primary'
                              : 'secondary'
                          }
                          className='w-50'
                          data-state-key='sell.marketType'
                          data-state-value='amount'
                          onClick={e => this.handleInputChange(e)}>
                          Amount
                        </Button>
                      </ButtonGroup>
                    </div>

                    <div className='manual-trade-row manual-trade-market-total-wrapper mt-2'>
                      <Form.Group
                        controlId='field-sell-market-total'
                        className='mb-2'>
                        <Form.Label
                          htmlFor='field-sell-market-total-input'
                          srOnly>
                          {order.sell.marketType === 'total'
                            ? 'Total'
                            : 'Amount'}
                        </Form.Label>
                        <InputGroup size='sm'>
                          <InputGroup.Prepend>
                            <InputGroup.Text>
                              {order.sell.marketType === 'total'
                                ? 'Total'
                                : 'Amount'}
                            </InputGroup.Text>
                          </InputGroup.Prepend>
                          {order.sell.marketType === 'total' ? (
                            <FormControl
                              id='field-sell-market-total-input'
                              type='number'
                              placeholder='Quantity'
                              step={filterPrice.tickSize}
                              className='text-right'
                              data-state-key='sell.quoteOrderQty'
                              value={order.sell.quoteOrderQty}
                              onClick={this.handleClick}
                              onChange={this.handleInputChange}
                            />
                          ) : (
                            ''
                          )}
                          {order.sell.marketType === 'amount' ? (
                            <FormControl
                              id='field-sell-market-total-input'
                              type='number'
                              step={filterLotSize.stepSize}
                              placeholder='Total'
                              className='text-right'
                              data-state-key='sell.marketQuantity'
                              value={order.sell.marketQuantity}
                              onClick={this.handleClick}
                              onChange={this.handleInputChange}
                            />
                          ) : (
                            ''
                          )}

                          <InputGroup.Append>
                            <InputGroup.Text>
                              {order.sell.marketType === 'total'
                                ? quoteAssetBalance.asset
                                : baseAssetBalance.asset}
                            </InputGroup.Text>
                          </InputGroup.Append>
                        </InputGroup>
                      </Form.Group>
                    </div>
                  </div>
                ) : (
                  ''
                )}
                <div className='manual-trade-row manual-trade-quantity-percentage-wrapper mt-2'>
                  <ButtonGroup size='sm' className='d-block font'>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('sell', 0)}>
                      0%
                    </Button>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('sell', 25)}>
                      25%
                    </Button>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('sell', 50)}>
                      50%
                    </Button>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('sell', 75)}>
                      75%
                    </Button>
                    <Button
                      variant='secondary'
                      className='w-20'
                      onClick={() => this.calculatePercentage('sell', 100)}>
                      100%
                    </Button>
                  </ButtonGroup>
                </div>
                {order.sell.type === 'limit' ? (
                  <div className='manual-trade-row manual-trade-total-wrapper mt-2'>
                    <Form.Group controlId='field-sell-total' className='mb-2'>
                      <Form.Label htmlFor='field-sell-total-input' srOnly>
                        Total
                      </Form.Label>
                      <InputGroup size='sm'>
                        <InputGroup.Prepend>
                          <InputGroup.Text>Total</InputGroup.Text>
                        </InputGroup.Prepend>
                        <FormControl
                          id='field-sell-total-input'
                          type='number'
                          placeholder='Amount'
                          className='text-right'
                          value={order.sell.total}
                          disabled
                        />
                        <InputGroup.Append>
                          <InputGroup.Text>
                            {quoteAssetBalance.asset}
                          </InputGroup.Text>
                        </InputGroup.Append>
                      </InputGroup>
                    </Form.Group>
                  </div>
                ) : (
                  ''
                )}

                <div className='manual-trade-row manual-trade-button-wrapper mt-2'>
                  <button
                    type='button'
                    className='btn btn-sm w-100 btn-manual btn-manual-sell mr-1'
                    data-state-key='side'
                    data-state-value='sell'
                    disabled={order.sell.isValid === false}
                    onClick={e => {
                      this.handleInputChange(e);
                      this.handleFormSubmit(e);
                    }}>
                    Sell {baseAssetBalance.asset}
                  </button>
                </div>
              </div>
            </div>
          </Modal.Body>
        </Modal>
      </div>
    );
  }
}
