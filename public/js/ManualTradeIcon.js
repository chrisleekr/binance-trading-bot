/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

class ManualTradeIcon extends React.Component {
  constructor(props) {
    super(props);

    this.initialOrders = {
      side: 'buy',
      buy: {
        type: 'market', // only support market
        marketType: 'total', // only support total
        // quoteOrderQty: 0, // market total
        isValid: false,
        symbols: {}
      },
      sell: {
        type: 'market', // only support market
        marketType: 'amount', // only support amount percentage
        // marketQuantity: 0, // market amount percentage
        isValid: false,
        symbols: {}
      }
    };

    this.state = {
      showModal: false,
      lastCandle: null,
      symbols: {},
      orders: _.cloneDeep(this.initialOrders)
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleFormSubmit = this.handleFormSubmit.bind(this);
    this.handleInputChange = this.handleInputChange.bind(this);
    this.handleClick = this.handleClick.bind(this);

    this.toFixed = this.toFixed.bind(this);
    this.calculateBalance = this.calculateBalance.bind(this);
    this.calculateBuyPercentage = this.calculateBuyPercentage.bind(this);
    this.calculateSellPercentage = this.calculateSellPercentage.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update, when the canUpdate is true.
    if (
      _.get(nextProps, 'symbols', null) !== null &&
      _.isEqual(_.get(nextProps, 'symbols', null), this.state.symbols) === false
    ) {
      const { orders } = this.state;
      const { symbols } = nextProps;

      const buySymbols = {};
      const sellSymbols = {};

      _.forEach(symbols, s => {
        const {
          symbol,
          baseAssetBalance,
          quoteAssetBalance,
          symbolInfo: { filterPrice, filterLotSize }
        } = s;

        const baseAssetStepSize =
          parseFloat(filterLotSize.stepSize) === 1
            ? 0
            : filterLotSize.stepSize.indexOf(1) - 1;
        const quoteAssetTickSize =
          parseFloat(filterPrice.tickSize) === 1
            ? 0
            : filterPrice.tickSize.indexOf(1) - 1;

        // Re-construct buy symbols if free quote asset balance is over 0
        if (parseFloat(quoteAssetBalance.free) > 0) {
          if (buySymbols[quoteAssetBalance.asset] === undefined) {
            buySymbols[quoteAssetBalance.asset] = {
              quoteAssetBalance,
              quoteAssetTickSize,
              filterPrice,
              remainingQuoteAssetBalance: parseFloat(quoteAssetBalance.free),
              baseAssets: {}
            };
          }

          if (
            buySymbols[quoteAssetBalance.asset].baseAssets[
              baseAssetBalance.asset
            ] === undefined
          ) {
            buySymbols[quoteAssetBalance.asset].baseAssets[
              baseAssetBalance.asset
            ] = {
              symbol,
              baseAssetBalance,
              baseAssetStepSize,
              filterPrice,
              quoteOrderQty: 0
            };
          }
        }

        // Re-construct sell symbols if free base asset balance is over 0
        if (parseFloat(baseAssetBalance.free) > 0) {
          if (sellSymbols[quoteAssetBalance.asset] === undefined) {
            sellSymbols[quoteAssetBalance.asset] = {
              quoteAssetBalance,
              quoteAssetTickSize,
              filterPrice,
              baseAssets: {}
            };
          }

          if (
            sellSymbols[quoteAssetBalance.asset].baseAssets[
              baseAssetBalance.asset
            ] === undefined
          ) {
            sellSymbols[quoteAssetBalance.asset].baseAssets[
              baseAssetBalance.asset
            ] = {
              symbol,
              baseAssetBalance,
              baseAssetStepSize,
              filterLotSize,
              marketQuantity: 0,
              remainingBalance: parseFloat(baseAssetBalance.free)
            };
          }
        }
      });

      orders.buy.symbols = buySymbols;
      orders.sell.symbols = sellSymbols;

      this.setState({
        symbols,
        orders
      });
    }
  }

  handleModalShow() {
    const newOrder = _.cloneDeep(this.initialOrder);

    this.setState({
      showModal: true,
      order: newOrder
    });

    this.props.setUpdate(false);
  }

  handleModalClose() {
    this.setState({
      showModal: false
    });

    this.props.setUpdate(true);
  }

  handleClick(e) {
    e.target.select();
  }

  // To support 0.00000001 precision, it uses toFixed.
  toFixed(value, precision) {
    return Number(value).toFixed(precision);
  }

  handleInput(e, precision) {
    console.log('precision => ', precision);
    // Make string to get precision length
    const value = e.target.value + '';
    if (
      precision > 0 &&
      value.split('.')[1] &&
      value.split('.')[1].length >= precision
    ) {
      e.target.value = this.toFixed(e.target.value, precision);
    }
  }

  calculateBuyPercentage(
    side,
    quoteSymbol,
    quoteAssetTickSize,
    baseSymbol,
    percentage
  ) {
    const { orders } = this.state;

    const currentQuoteOrderQty = parseFloat(
      orders[side].symbols[quoteSymbol].baseAssets[baseSymbol].quoteOrderQty
    );
    const remainingBalance =
      parseFloat(orders[side].symbols[quoteSymbol].remainingQuoteAssetBalance) +
      currentQuoteOrderQty;

    const newBalance = this.toFixed(
      _.floor(remainingBalance * (percentage / 100), quoteAssetTickSize),
      quoteAssetTickSize
    );

    orders[side].symbols[quoteSymbol].baseAssets[baseSymbol].quoteOrderQty =
      newBalance;

    const newOrders = this.calculateBalance(orders);

    this.setState({
      orders: newOrders
    });
  }

  calculateSellPercentage(
    side,
    quoteSymbol,
    baseAssetStepSize,
    baseSymbol,
    percentage
  ) {
    const { orders } = this.state;

    const baseBalanceFree = parseFloat(
      orders[side].symbols[quoteSymbol].baseAssets[baseSymbol].baseAssetBalance
        .free
    );

    let newBalance = this.toFixed(
      _.floor(baseBalanceFree * (percentage / 100), baseAssetStepSize),
      baseAssetStepSize
    );

    // If it is 100%, try to deduct commission 0.1%
    if (percentage === 100) {
      newBalance = _.floor(
        newBalance - newBalance * (0.1 / 100),
        baseAssetStepSize
      );
    }

    orders[side].symbols[quoteSymbol].baseAssets[baseSymbol].marketQuantity =
      newBalance;
    orders[side].symbols[quoteSymbol].baseAssets[baseSymbol].remainingBalance =
      baseBalanceFree - newBalance;

    const newOrders = this.calculateBalance(orders);

    this.setState({
      orders: newOrders
    });
  }

  validateOrder(orders) {
    // Validate buy remaining balances
    orders.buy.isValid = false;

    let hasZeroRemainingBalance = false;
    let hasQuoteOrderQty = false;
    _.forOwn(orders.buy.symbols, (quoteAsset, _quoteSymbol) => {
      const remainingBalance = parseFloat(
        quoteAsset.remainingQuoteAssetBalance
      );
      if (remainingBalance <= 0) {
        hasZeroRemainingBalance = true;
      }

      _.forOwn(quoteAsset.baseAssets, (baseAsset, _baseSymbol) => {
        const quoteOrderQty = parseFloat(baseAsset.quoteOrderQty);
        if (quoteOrderQty > 0) {
          hasQuoteOrderQty = true;
        }
      });
    });

    if (hasZeroRemainingBalance === true || hasQuoteOrderQty === false) {
      orders.buy.isValid = false;
    } else {
      orders.buy.isValid = true;
    }

    // Validate sell quantity
    orders.sell.isValid = false;

    hasZeroRemainingBalance = false;
    let hasMarketQuantity = false;
    _.forOwn(orders.sell.symbols, (quoteAsset, _quoteSymbol) => {
      _.forOwn(quoteAsset.baseAssets, (baseAsset, _baseSymbol) => {
        const marketQuantity = parseFloat(baseAsset.marketQuantity);
        const remainingBalance = parseFloat(baseAsset.remainingBalance);
        if (marketQuantity > 0) {
          hasMarketQuantity = true;
        }
        if (remainingBalance <= 0) {
          hasZeroRemainingBalance = true;
        }
      });
    });

    if (hasZeroRemainingBalance === false && hasMarketQuantity === true) {
      orders.sell.isValid = true;
    } else {
      orders.sell.isValid = false;
    }

    return orders;
  }

  calculateBalance(orders) {
    // Calculate buy remaining balances
    _.forOwn(orders.buy.symbols, (quoteAsset, quoteSymbol) => {
      let remainingBalance = parseFloat(quoteAsset.quoteAssetBalance.free);

      _.forOwn(quoteAsset.baseAssets, (baseAsset, _baseSymbol) => {
        remainingBalance -= parseFloat(baseAsset.quoteOrderQty);
      });

      orders.buy.symbols[quoteSymbol].remainingQuoteAssetBalance =
        remainingBalance;
    });

    // Calculate sell remaining balances
    _.forOwn(orders.sell.symbols, (quoteAsset, quoteSymbol) => {
      _.forOwn(quoteAsset.baseAssets, (baseAsset, baseSymbol) => {
        const baseAssetBalance = parseFloat(baseAsset.baseAssetBalance.free);
        const marketQuantity = parseFloat(baseAsset.marketQuantity);
        const baseAssetStepSize = baseAsset.baseAssetStepSize;

        orders.sell.symbols[quoteSymbol].baseAssets[
          baseSymbol
        ].remainingBalance = this.toFixed(
          _.floor(baseAssetBalance - marketQuantity, baseAssetStepSize),
          baseAssetStepSize
        );
      });
    });

    return this.validateOrder(orders);
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

    const { orders } = this.state;

    const newOrders = this.calculateBalance(_.set(orders, stateKey, value));
    console.log('newOrders => ', newOrders);
    this.setState({
      orders: newOrders
    });
  }

  handleFormSubmit(e) {
    e.preventDefault();
    console.log('handleFormSubmit', this.state.orders);

    this.handleModalClose();

    this.props.sendWebSocket('manual-trade-all-symbols', {
      orders: this.state.orders
    });
  }

  render() {
    const { showModal, orders } = this.state;

    return (
      <div className='coin-info-manual-trade-wrapper'>
        <div className='coin-info-column coin-info-column-manual-trade d-flex flex-row justify-content-start align-content-between border-bottom-0 mb-0 pb-0'>
          <button
            type='button'
            className='btn btn-sm btn-manual-trade mr-1'
            onClick={() => this.handleModalShow()}>
            <i className='fa fa-shopping-bag'></i> Trade all
          </button>
        </div>
        <Modal
          show={showModal}
          onHide={() => this.handleModalClose()}
          backdrop='static'
          size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>Manual trade for all symbols</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className='d-block text-muted mb-2'>
              In this modal, you can trade all symbols manually. To simplify the
              order process, it only supports Market - Total buy order, Market -
              Amount sell order.
              <br />
              <br />
              If you enter 0 on the symbol, the bot won't place an order for the
              symbol. If you already have the last buy price, then the bot will
              calculate average cost and re-calculate the last buy price.
              <br />
              <br />
              To make sure the last buy price is recorded only if the order is
              successfully executed, the bot will monitor the order after
              placing the buy order. This action may increase the use of API
              weight.
              {orders.side === 'sell' ? (
                <React.Fragment>
                  <br />
                  <br />
                  If you click the button to sell 100% of the remaining balance,
                  it will automatically caluclate 0.1% commission.
                </React.Fragment>
              ) : (
                ''
              )}
            </p>
            <div className='manual-trade-sides-selector-wrappers'>
              <ButtonGroup size='sm' className='d-block'>
                <Button
                  variant={orders.side === 'buy' ? 'primary' : 'secondary'}
                  className='w-50'
                  data-state-key='side'
                  data-state-value='buy'
                  onClick={e => this.handleInputChange(e)}>
                  Buy
                </Button>
                <Button
                  variant={orders.side === 'sell' ? 'primary' : 'secondary'}
                  className='w-50'
                  data-state-key='side'
                  data-state-value='sell'
                  onClick={e => this.handleInputChange(e)}>
                  Sell
                </Button>
              </ButtonGroup>
            </div>
            <div className='manual-trade-all-wrappers'>
              {orders.side === 'buy' ? (
                <div className='manual-trade-all-wrapper manual-trade-buy-wrapper'>
                  <div className='manual-trade-row manual-trade-type-wrapper mt-2'>
                    <ButtonGroup size='sm' className='d-block'>
                      <Button
                        variant='primary'
                        className='w-100'
                        disabled={true}>
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

                        <FormControl
                          id='field-buy-price-input'
                          type='text'
                          className='text-right'
                          value='Market'
                          disabled={true}
                        />
                      </InputGroup>
                    </Form.Group>
                  </div>

                  <div className='manual-trade-row manual-trade-type-wrapper mt-2'>
                    <ButtonGroup size='sm' className='d-block'>
                      <Button
                        variant='primary'
                        className='w-100'
                        disabled={true}>
                        Total
                      </Button>
                    </ButtonGroup>
                  </div>

                  <div className='manual-trade-rows'>
                    {orders.buy &&
                      orders.buy.symbols &&
                      Object.values(orders.buy.symbols).map(quoteAsset => {
                        const {
                          quoteAssetBalance,
                          quoteAssetTickSize,
                          filterPrice,
                          remainingQuoteAssetBalance,
                          baseAssets
                        } = quoteAsset;
                        return (
                          <div
                            key={
                              'manual-trade-buy-quote-symbol-' +
                              quoteAssetBalance.asset
                            }
                            className='manual-trade-row-quote-asset'>
                            <div className='manual-trade-row  manual-trade-quote-asset-title'>
                              {quoteAssetBalance.asset}
                            </div>
                            <div className='manual-trade-row d-flex flex-row justify-content-between mt-1 mb-1'>
                              <div className='manual-trade-label'>
                                Current Balance
                              </div>
                              <span className='manual-trade-quote-asset'>
                                {parseFloat(quoteAssetBalance.free).toFixed(
                                  quoteAssetTickSize
                                )}{' '}
                                {quoteAssetBalance.asset}
                              </span>
                            </div>

                            <div className='manual-trade-all-row-base-assets-wrapper'>
                              {Object.values(baseAssets).map(baseAsset => {
                                const { baseAssetBalance } = baseAsset;

                                return (
                                  <div
                                    key={
                                      'manual-trade-buy-base-asset-' +
                                      baseAssetBalance.asset
                                    }
                                    className='manual-trade-all-row-base-assets  pr-1'>
                                    <div className='manual-trade-row manual-trade-row-base-asset'>
                                      <Form.Group
                                        controlId={
                                          'field-buy-market-total-' +
                                          baseAssetBalance.asset
                                        }
                                        className='mb-1'>
                                        <Form.Label
                                          htmlFor={
                                            'field-buy-market-total-' +
                                            baseAssetBalance.asset +
                                            '-input'
                                          }
                                          srOnly>
                                          {baseAssetBalance.asset}
                                        </Form.Label>
                                        <InputGroup size='sm'>
                                          <InputGroup.Prepend>
                                            <InputGroup.Text>
                                              {baseAssetBalance.asset}
                                            </InputGroup.Text>
                                          </InputGroup.Prepend>
                                          <FormControl
                                            id={
                                              'field-buy-market-total-' +
                                              baseAssetBalance.asset +
                                              '-input'
                                            }
                                            type='number'
                                            placeholder='Amount'
                                            step={filterPrice.tickSize}
                                            className='text-right'
                                            data-state-key={
                                              'buy.symbols[' +
                                              quoteAssetBalance.asset +
                                              '].baseAssets[' +
                                              baseAssetBalance.asset +
                                              '].quoteOrderQty'
                                            }
                                            onInput={e =>
                                              this.handleInput(
                                                e,
                                                quoteAssetTickSize
                                              )
                                            }
                                            min='0'
                                            value={
                                              orders.buy.symbols[
                                                quoteAssetBalance.asset
                                              ].baseAssets[
                                                baseAssetBalance.asset
                                              ].quoteOrderQty
                                            }
                                            onClick={this.handleClick}
                                            onChange={this.handleInputChange}
                                          />
                                          <InputGroup.Append>
                                            <InputGroup.Text>
                                              {quoteAssetBalance.asset}
                                            </InputGroup.Text>
                                          </InputGroup.Append>
                                        </InputGroup>
                                      </Form.Group>
                                    </div>
                                    <div className='manual-trade-row manual-trade-quantity-percentage-wrapper mt-1 mb-2'>
                                      <ButtonGroup
                                        size='sm'
                                        className='d-block font'>
                                        <Button
                                          variant='secondary'
                                          className='w-20 btn-percentage m-0'
                                          onClick={() =>
                                            this.calculateBuyPercentage(
                                              'buy',
                                              quoteAssetBalance.asset,
                                              quoteAssetTickSize,
                                              baseAssetBalance.asset,
                                              0
                                            )
                                          }>
                                          0%
                                        </Button>
                                        <Button
                                          variant='secondary'
                                          className='w-20 btn-percentage m-0'
                                          onClick={() =>
                                            this.calculateBuyPercentage(
                                              'buy',
                                              quoteAssetBalance.asset,
                                              quoteAssetTickSize,
                                              baseAssetBalance.asset,
                                              25
                                            )
                                          }>
                                          25%
                                        </Button>
                                        <Button
                                          variant='secondary'
                                          className='w-20 btn-percentage m-0'
                                          onClick={() =>
                                            this.calculateBuyPercentage(
                                              'buy',
                                              quoteAssetBalance.asset,
                                              quoteAssetTickSize,
                                              baseAssetBalance.asset,
                                              50
                                            )
                                          }>
                                          50%
                                        </Button>
                                        <Button
                                          variant='secondary'
                                          className='w-20 btn-percentage m-0'
                                          onClick={() =>
                                            this.calculateBuyPercentage(
                                              'buy',
                                              quoteAssetBalance.asset,
                                              quoteAssetTickSize,
                                              baseAssetBalance.asset,
                                              75
                                            )
                                          }>
                                          75%
                                        </Button>
                                        <Button
                                          variant='secondary'
                                          className='w-20 btn-percentage m-0'
                                          onClick={() =>
                                            this.calculateBuyPercentage(
                                              'buy',
                                              quoteAssetBalance.asset,
                                              quoteAssetTickSize,
                                              baseAssetBalance.asset,
                                              100
                                            )
                                          }>
                                          100%
                                        </Button>
                                      </ButtonGroup>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <div className='manual-trade-row d-flex flex-row justify-content-between mt-1 mb-1'>
                              <div className='manual-trade-label'>
                                Remaining Balance
                              </div>
                              <span className='manual-trade-quote-asset'>
                                {parseFloat(remainingQuoteAssetBalance).toFixed(
                                  quoteAssetTickSize
                                )}{' '}
                                {quoteAssetBalance.asset}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    <div className='manual-trade-row manual-trade-button-wrapper mt-2'>
                      <button
                        type='button'
                        className='btn btn-sm w-100 btn-manual btn-manual-buy mr-1'
                        data-state-key='side'
                        data-state-value='buy'
                        disabled={orders.buy.isValid === false}
                        onClick={e => {
                          this.handleInputChange(e);
                          this.handleFormSubmit(e);
                        }}>
                        Buy
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                ''
              )}

              {orders.side === 'sell' ? (
                <div className='manual-trade-all-wrapper manual-trade-sell-wrapper'>
                  <div className='manual-trade-row manual-trade-type-wrapper mt-2'>
                    <ButtonGroup size='sm' className='d-block'>
                      <Button
                        variant='primary'
                        className='w-100'
                        disabled={true}>
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
                        <FormControl
                          id='field-sell-price-input'
                          type='text'
                          className='text-right'
                          value='Market'
                          disabled={true}
                        />
                      </InputGroup>
                    </Form.Group>
                  </div>

                  <div className='manual-trade-row manual-trade-type-wrapper mt-2'>
                    <ButtonGroup size='sm' className='d-block'>
                      <Button
                        variant='primary'
                        className='w-100'
                        disabled={true}>
                        Amount
                      </Button>
                    </ButtonGroup>
                  </div>

                  <div className='manual-trade-rows'>
                    {orders.sell &&
                      orders.sell.symbols &&
                      Object.values(orders.sell.symbols).map(quoteAsset => {
                        const { quoteAssetBalance, baseAssets } = quoteAsset;

                        return (
                          <div
                            key={
                              'manual-trade-sell-quote-symbol-' +
                              quoteAssetBalance.asset
                            }
                            className='manual-trade-row manual-trade-row-quote-asset'>
                            <div className='manual-trade-quote-asset-title'>
                              {quoteAssetBalance.asset}
                            </div>

                            <div className='manual-trade-all-row-base-assets-wrapper'>
                              {Object.values(baseAssets).map(baseAsset => {
                                const {
                                  baseAssetBalance,
                                  baseAssetStepSize,
                                  filterLotSize,
                                  remainingBalance
                                } = baseAsset;

                                return (
                                  <div
                                    key={
                                      'manual-trade-sell-base-asset-' +
                                      baseAssetBalance.asset
                                    }
                                    className='manual-trade-all-row-base-assets pr-1'>
                                    <div className='manual-trade-row manual-trade-row-base-asset'>
                                      <div className='manual-trade-row d-flex flex-row justify-content-between mt-1 mb-1'>
                                        <div className='manual-trade-label'>
                                          Remaining Balance
                                        </div>
                                        <span className='manual-trade-quote-asset'>
                                          {parseFloat(remainingBalance).toFixed(
                                            baseAssetStepSize
                                          )}{' '}
                                          {baseAssetBalance.asset}
                                        </span>
                                      </div>
                                      <div className='manual-trade-row manual-trade-row-base-asset'>
                                        <Form.Group
                                          controlId={
                                            'field-sell-market-amount-' +
                                            baseAssetBalance.asset
                                          }
                                          className='mb-1'>
                                          <Form.Label
                                            htmlFor={
                                              'field-sell-market-amount-' +
                                              baseAssetBalance.asset +
                                              '-input'
                                            }
                                            srOnly>
                                            {baseAssetBalance.asset}
                                          </Form.Label>
                                          <InputGroup size='sm'>
                                            <FormControl
                                              id={
                                                'field-sell-market-amount-' +
                                                baseAssetBalance.asset +
                                                '-input'
                                              }
                                              type='number'
                                              placeholder='Amount'
                                              step={filterLotSize.stepSize}
                                              className='text-right'
                                              data-state-key={
                                                'sell.symbols[' +
                                                quoteAssetBalance.asset +
                                                '].baseAssets[' +
                                                baseAssetBalance.asset +
                                                '].marketQuantity'
                                              }
                                              onInput={e =>
                                                this.handleInput(
                                                  e,
                                                  baseAssetStepSize
                                                )
                                              }
                                              min='0'
                                              value={
                                                orders.sell.symbols[
                                                  quoteAssetBalance.asset
                                                ].baseAssets[
                                                  baseAssetBalance.asset
                                                ].marketQuantity
                                              }
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
                                      <div className='manual-trade-row manual-trade-quantity-percentage-wrapper mt-1 mb-2'>
                                        <ButtonGroup
                                          size='sm'
                                          className='d-block font'>
                                          <Button
                                            variant='secondary'
                                            className='w-20 btn-percentage m-0'
                                            onClick={() =>
                                              this.calculateSellPercentage(
                                                'sell',
                                                quoteAssetBalance.asset,
                                                baseAssetStepSize,
                                                baseAssetBalance.asset,
                                                0
                                              )
                                            }>
                                            0%
                                          </Button>
                                          <Button
                                            variant='secondary'
                                            className='w-20 btn-percentage m-0'
                                            onClick={() =>
                                              this.calculateSellPercentage(
                                                'sell',
                                                quoteAssetBalance.asset,
                                                baseAssetStepSize,
                                                baseAssetBalance.asset,
                                                25
                                              )
                                            }>
                                            25%
                                          </Button>
                                          <Button
                                            variant='secondary'
                                            className='w-20 btn-percentage m-0'
                                            onClick={() =>
                                              this.calculateSellPercentage(
                                                'sell',
                                                quoteAssetBalance.asset,
                                                baseAssetStepSize,
                                                baseAssetBalance.asset,
                                                50
                                              )
                                            }>
                                            50%
                                          </Button>
                                          <Button
                                            variant='secondary'
                                            className='w-20 btn-percentage m-0'
                                            onClick={() =>
                                              this.calculateSellPercentage(
                                                'sell',
                                                quoteAssetBalance.asset,
                                                baseAssetStepSize,
                                                baseAssetBalance.asset,
                                                75
                                              )
                                            }>
                                            75%
                                          </Button>
                                          <Button
                                            variant='secondary'
                                            className='w-20 btn-percentage m-0'
                                            onClick={() =>
                                              this.calculateSellPercentage(
                                                'sell',
                                                quoteAssetBalance.asset,
                                                baseAssetStepSize,
                                                baseAssetBalance.asset,
                                                100
                                              )
                                            }>
                                            100%
                                          </Button>
                                        </ButtonGroup>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                  <div className='manual-trade-row manual-trade-button-wrapper mt-2'>
                    <button
                      type='button'
                      className='btn btn-sm w-100 btn-manual btn-manual-sell mr-1'
                      data-state-key='side'
                      data-state-value='sell'
                      disabled={orders.sell.isValid === false}
                      onClick={e => {
                        this.handleInputChange(e);
                        this.handleFormSubmit(e);
                      }}>
                      Sell
                    </button>
                  </div>
                </div>
              ) : (
                ''
              )}
            </div>
          </Modal.Body>
        </Modal>
      </div>
    );
  }
}
