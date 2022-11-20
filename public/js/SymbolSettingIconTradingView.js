/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolSettingIconTradingView extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      botOptions: {},
      remainingIntervals: []
    };

    this.handleInputChange = this.handleInputChange.bind(this);

    this.onAddTradingView = this.onAddTradingView.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      _.isEmpty(nextProps.botOptions) === false &&
      _.isEqual(nextProps.botOptions, this.state.botOptions) === false
    ) {
      const { botOptions } = nextProps;

      this.setState(
        {
          botOptions
        },
        () => this.calculateReminaingIntervals()
      );
    }
  }

  handleInputChange(event) {
    const target = event.target;
    const value =
      target.type === 'checkbox'
        ? target.checked
        : target.type === 'number'
        ? +target.value
        : target.value;
    const stateKey = target.getAttribute('data-state-key');

    const { botOptions } = this.state;
    const { tradingViews } = botOptions;

    const newTradingViews = _.set(tradingViews, stateKey, value);
    botOptions.tradingViews = newTradingViews;
    this.setState(
      {
        botOptions
      },
      () => this.calculateReminaingIntervals()
    );

    this.props.handleBotOptionsChange(botOptions);
  }

  calculateReminaingIntervals() {
    const { tradingViewIntervals } = this.props;
    const { botOptions } = this.state;
    const { tradingViews } = botOptions;

    const addedTradingViewInterval = (tradingViews || []).map(t => t.interval);

    const remainingIntervals = tradingViewIntervals.filter(
      i => addedTradingViewInterval.includes(i) === false
    );

    this.setState({
      remainingIntervals
    });
  }

  onAddTradingView(_event) {
    this.calculateReminaingIntervals();

    const { botOptions, remainingIntervals } = this.state;
    const { tradingViews } = botOptions;

    if (remainingIntervals.length === 0) {
      return;
    }

    const newTradingViews = _.concat(tradingViews || [], {
      interval: remainingIntervals[0],
      buy: {
        whenStrongBuy: true,
        whenBuy: true
      },
      sell: {
        forceSellOverZeroBelowTriggerPrice: {
          whenNeutral: true,
          whenSell: true,
          whenStrongSell: true
        }
      }
    });

    botOptions.tradingViews = newTradingViews;

    this.setState(
      {
        botOptions
      },
      () => this.calculateReminaingIntervals()
    );

    this.props.handleBotOptionsChange(botOptions);
  }

  onRemoveTradingView(index) {
    const { botOptions } = this.state;
    const { tradingViews } = botOptions;

    _.pullAt(tradingViews, index);
    botOptions.tradingViews = tradingViews;

    this.setState(
      {
        botOptions
      },
      () => this.calculateReminaingIntervals()
    );
    this.props.handleBotOptionsChange(botOptions);
  }

  render() {
    const { botOptions, remainingIntervals } = this.state;

    if (_.isEmpty(botOptions)) {
      return '';
    }

    const { tradingViews } = botOptions;

    // To avoid massive traffic to TradingView, limit TradingView to maximum 4 intervals.
    const canAddTradingView =
      remainingIntervals.length !== 0 && (tradingViews || []).length < 3;

    const tradingViewRows = (tradingViews || []).map((tradingView, i) => {
      const {
        buy: { whenStrongBuy, whenBuy },
        sell: {
          forceSellOverZeroBelowTriggerPrice: {
            whenNeutral,
            whenSell,
            whenStrongSell
          }
        }
      } = tradingView;

      const isBuyTriggerActive = whenStrongBuy || whenBuy;
      const isForceSellTriggerActive =
        whenNeutral || whenSell || whenStrongSell;

      return (
        <React.Fragment key={'trading-view-' + i}>
          <tr>
            <td className='align-middle font-weight-bold' width='90%'>
              TradingView #{i + 1}
            </td>
            <td className='align-middle text-center'>
              {i !== 0 ? (
                <button
                  type='button'
                  className='btn btn-sm btn-link p-0'
                  onClick={() => this.onRemoveTradingView(i)}>
                  <i className='fas fa-times-circle text-danger'></i>
                </button>
              ) : (
                ''
              )}
            </td>
          </tr>
          <tr>
            <td colSpan='2'>
              <div className='row'>
                <div className='col-12 mb-2'>
                  <Form.Group
                    controlId={'field-tradingview-' + i + '-interval'}
                    className='mb-0'>
                    <Form.Label className='mb-0'>
                      Interval
                      <OverlayTrigger
                        trigger='click'
                        key={'field-tradingview-' + i + '-interval-overlay'}
                        placement='bottom'
                        overlay={
                          <Popover
                            id={
                              'field-tradingview-' +
                              i +
                              '-interval-overlay-right'
                            }>
                            <Popover.Content>
                              Set TradingView candle interval.
                            </Popover.Content>
                          </Popover>
                        }>
                        <Button
                          variant='link'
                          className='p-0 m-0 ml-1 text-info'>
                          <i className='fas fa-question-circle fa-sm'></i>
                        </Button>
                      </OverlayTrigger>
                    </Form.Label>
                    <Form.Control
                      size='sm'
                      as='select'
                      data-state-key={`${i}.interval`}
                      value={tradingView.interval}
                      onChange={this.handleInputChange}>
                      <option value={tradingView.interval}>
                        {tradingView.interval}
                      </option>
                      {remainingIntervals.map(interval => (
                        <option
                          key={`${i}.interval.${interval}`}
                          value={interval}>
                          {interval}
                        </option>
                      ))}
                    </Form.Control>
                  </Form.Group>
                </div>
                <div className='col-12'>
                  <p className='mb-0'>
                    Buy action
                    {isBuyTriggerActive === false ? (
                      <span className='text-warning font-weight-bold ml-3'>
                        This interval won't trigger the buy action.
                      </span>
                    ) : (
                      ''
                    )}
                  </p>
                </div>
                <div className='col-12'>
                  <Form.Group
                    controlId={
                      'field-tradingview-' + i + '-buy-when-strong-buy'
                    }
                    className='mb-0'>
                    <Form.Check size='sm'>
                      <Form.Check.Input
                        type='checkbox'
                        data-state-key={`${i}.buy.whenStrongBuy`}
                        checked={tradingView.buy.whenStrongBuy}
                        onChange={this.handleInputChange}
                      />
                      <Form.Check.Label>
                        Allow buy trigger when recommendation is{' '}
                        <code>Strong buy</code>{' '}
                        <OverlayTrigger
                          trigger='click'
                          key={
                            'field-tradingview-' +
                            i +
                            '-buy-when-strong-buy-overlay'
                          }
                          placement='bottom'
                          overlay={
                            <Popover
                              id={
                                'field-tradingview-' +
                                i +
                                '-buy-when-strong-buy-overlay-right'
                              }>
                              <Popover.Content>
                                If enabled, the bot will use TradingView
                                recommendation to trigger the buy. If the buy
                                trigger price is reached, the bot will check
                                TradingView recommendation and if it is not
                                `Strong buy`, then the bot will not place a buy
                                order.
                              </Popover.Content>
                            </Popover>
                          }>
                          <Button
                            variant='link'
                            className='p-0 m-0 ml-1 text-info'>
                            <i className='fas fa-question-circle fa-sm'></i>
                          </Button>
                        </OverlayTrigger>
                      </Form.Check.Label>
                    </Form.Check>
                  </Form.Group>
                </div>
                <div className='col-12'>
                  <Form.Group
                    controlId={'field-tradingview-' + i + '-buy-when-buy'}
                    className='mb-0'>
                    <Form.Check size='sm'>
                      <Form.Check.Input
                        type='checkbox'
                        data-state-key={`${i}.buy.whenBuy`}
                        checked={tradingView.buy.whenBuy}
                        onChange={this.handleInputChange}
                      />
                      <Form.Check.Label>
                        Allow buy trigger when recommendation is{' '}
                        <code>Buy</code>{' '}
                        <OverlayTrigger
                          trigger='click'
                          key={
                            'field-tradingview-' + i + '-buy-when-buy-overlay'
                          }
                          placement='bottom'
                          overlay={
                            <Popover
                              id={
                                'field-tradingview-' +
                                i +
                                '-buy-when--buy-overlay-right'
                              }>
                              <Popover.Content>
                                If enabled, the bot will use TradingView
                                recommendation to trigger the buy. If the buy
                                trigger price is reached, the bot will check
                                TradingView recommendation and if it is not
                                `Buy`, then the bot will not place a buy order.
                              </Popover.Content>
                            </Popover>
                          }>
                          <Button
                            variant='link'
                            className='p-0 m-0 ml-1 text-info'>
                            <i className='fas fa-question-circle fa-sm'></i>
                          </Button>
                        </OverlayTrigger>
                      </Form.Check.Label>
                    </Form.Check>
                  </Form.Group>
                </div>

                <div className='col-12'>
                  <p className='mb-0'>
                    Sell action
                    {isForceSellTriggerActive === false ? (
                      <span className='text-warning font-weight-bold ml-3'>
                        This interval won't trigger the force sell action.
                      </span>
                    ) : (
                      ''
                    )}
                  </p>
                </div>

                <div className='col-12'>
                  <Form.Group
                    controlId={
                      'field-tradingview-' +
                      i +
                      '-sell-force-sell-over-zero-below-trigger-price-when-neutral'
                    }
                    className='mb-0'>
                    <Form.Check size='sm'>
                      <Form.Check.Input
                        type='checkbox'
                        data-state-key={`${i}.sell.forceSellOverZeroBelowTriggerPrice.whenNeutral`}
                        checked={
                          tradingView.sell.forceSellOverZeroBelowTriggerPrice
                            .whenNeutral
                        }
                        onChange={this.handleInputChange}
                      />
                      <Form.Check.Label>
                        Force sell at the market price when recommendation is{' '}
                        <code>Neutral</code> and the profit is between{' '}
                        <code>0</code> to <code>trigger price</code>{' '}
                        <OverlayTrigger
                          trigger='click'
                          key={
                            'field-tradingview-' +
                            i +
                            '-sell-force-sell-over-zero-below-trigger-price-when-neutral-overlay'
                          }
                          placement='bottom'
                          overlay={
                            <Popover
                              id={
                                'field-tradingview-' +
                                i +
                                '-sell-force-sell-over-zero-below-trigger-price-when-neutral-overlay-right'
                              }>
                              <Popover.Content>
                                If enabled, the bot will use TradingView
                                recommendation to sell the coin at the market
                                price if the profit is over 0 but under the
                                trigger price. When the condition is met and the
                                TradingView recommendation is `Neutral`, then
                                the bot will place a market sell order
                                immediately. If the auto-buy trigger is enabled,
                                then it will place a buy order later. Note that
                                this action can cause loss if the profit is less
                                than commission.
                              </Popover.Content>
                            </Popover>
                          }>
                          <Button
                            variant='link'
                            className='p-0 m-0 ml-1 text-info'>
                            <i className='fas fa-question-circle fa-sm'></i>
                          </Button>
                        </OverlayTrigger>
                      </Form.Check.Label>
                    </Form.Check>
                  </Form.Group>
                </div>
                <div className='col-12'>
                  <Form.Group
                    controlId={
                      'field-tradingview-' +
                      i +
                      '-sell-force-sell-over-zero-below-trigger-price-when-sell'
                    }
                    className='mb-0'>
                    <Form.Check size='sm'>
                      <Form.Check.Input
                        type='checkbox'
                        data-state-key={`${i}.sell.forceSellOverZeroBelowTriggerPrice.whenSell`}
                        checked={
                          tradingView.sell.forceSellOverZeroBelowTriggerPrice
                            .whenSell
                        }
                        onChange={this.handleInputChange}
                      />
                      <Form.Check.Label>
                        Force sell at the market price when recommendation is{' '}
                        <code>Sell</code> and the profit is between{' '}
                        <code>0</code> to <code>trigger price</code>{' '}
                        <OverlayTrigger
                          trigger='click'
                          key={
                            'field-tradingview-' +
                            i +
                            '-sell-force-sell-over-zero-below-trigger-price-when-sell-overlay'
                          }
                          placement='bottom'
                          overlay={
                            <Popover
                              id={
                                'field-tradingview-' +
                                i +
                                '-sell-force-sell-over-zero-below-trigger-price-when-sell-overlay-right'
                              }>
                              <Popover.Content>
                                If enabled, the bot will use TradingView
                                recommendation to sell the coin at the market
                                price if the profit is over 0 but under the
                                trigger price. When the condition is met and the
                                TradingView recommendation is `Sell`, then the
                                bot will place a market sell order immediately.
                                If the auto-buy trigger is enabled, then it will
                                place a buy order later. Note that this action
                                can cause loss if the profit is less than
                                commission.
                              </Popover.Content>
                            </Popover>
                          }>
                          <Button
                            variant='link'
                            className='p-0 m-0 ml-1 text-info'>
                            <i className='fas fa-question-circle fa-sm'></i>
                          </Button>
                        </OverlayTrigger>
                      </Form.Check.Label>
                    </Form.Check>
                  </Form.Group>
                </div>
                <div className='col-12'>
                  <Form.Group
                    controlId={
                      'field-tradingview-' +
                      i +
                      '-sell-force-sell-over-zero-below-trigger-price-when-strong-sell'
                    }
                    className='mb-0'>
                    <Form.Check size='sm'>
                      <Form.Check.Input
                        type='checkbox'
                        data-state-key={`${i}.sell.forceSellOverZeroBelowTriggerPrice.whenStrongSell`}
                        checked={
                          tradingView.sell.forceSellOverZeroBelowTriggerPrice
                            .whenStrongSell
                        }
                        onChange={this.handleInputChange}
                      />
                      <Form.Check.Label>
                        Force sell at the market price when recommendation is{' '}
                        <code>Strong sell</code> and the profit is between{' '}
                        <code>0</code> to <code>trigger price</code>{' '}
                        <OverlayTrigger
                          trigger='click'
                          key={
                            'field-tradingview-' +
                            i +
                            '-sell-force-sell-over-zero-below-trigger-price-when-strong-sell-overlay'
                          }
                          placement='bottom'
                          overlay={
                            <Popover
                              id={
                                'field-tradingview-' +
                                i +
                                '-sell-force-sell-over-zero-below-trigger-price-when-strong-sell-overlay-right'
                              }>
                              <Popover.Content>
                                If enabled, the bot will use TradingView
                                recommendation to sell the coin at the market
                                price if the profit is over 0 but under the
                                trigger price. When the condition is met and the
                                TradingView recommendation is `Strong sell`,
                                then the bot will place a market sell order
                                immediately. If the auto-buy trigger is enabled,
                                then it will place a buy order later. Note that
                                this action can cause loss if the profit is less
                                than commission.
                              </Popover.Content>
                            </Popover>
                          }>
                          <Button
                            variant='link'
                            className='p-0 m-0 ml-1 text-info'>
                            <i className='fas fa-question-circle fa-sm'></i>
                          </Button>
                        </OverlayTrigger>
                      </Form.Check.Label>
                    </Form.Check>
                  </Form.Group>
                </div>
              </div>
            </td>
          </tr>
        </React.Fragment>
      );
    });

    return (
      <Accordion defaultActiveKey='0'>
        <Card className='mt-1'>
          <Card.Header className='px-2 py-1'>
            <Accordion.Toggle
              as={Button}
              variant='link'
              eventKey='0'
              className='p-0 fs-7 text-uppercase'>
              TradingView
            </Accordion.Toggle>
          </Card.Header>
          <Accordion.Collapse eventKey='0'>
            <Card.Body className='px-2 py-1'>
              <div className='row pb-2'>
                <div className='col-12'>
                  What is{' '}
                  <a
                    href='https://www.tradingview.com/symbols/BTCUSDT/technicals/'
                    target='_blank'
                    rel='noreferrer'>
                    TradingView
                  </a>
                  ?{' '}
                  <OverlayTrigger
                    trigger='click'
                    key='bot-options-auto-trigger-buy-conditions-tradingview-when-strong-buy-overlay'
                    placement='bottom'
                    overlay={
                      <Popover id='bot-options-auto-trigger-buy-conditions-tradingview-when-strong-buy-overlay-right'>
                        <Popover.Content>
                          TradingView is the service that provides technical
                          analysis based on various indicators such as
                          oscillators and moving averages. The bot is integrated
                          with TradingView summary recommendation to control the
                          buy/sell actions.
                        </Popover.Content>
                      </Popover>
                    }>
                    <Button variant='link' className='p-0 m-0 ml-1 text-info'>
                      <i className='fas fa-question-circle fa-sm'></i>
                    </Button>
                  </OverlayTrigger>
                  <br />
                  - At least one condition must be checked to activate the
                  TradingView interval. If the interval's conditions are not
                  checked, then the TradingView recommendation of the interval
                  will be ignored. <br />
                  - Buy trigger must be satisfied with all intervals'
                  recommendations.
                  <br />
                  - Force sell will be executed if satisfy any recommendation.
                  <br />
                  - A maximum of three intervals can add to avoid massive
                  traffic to TradingView.
                  <br />
                  <br />
                  For more detailed information,{' '}
                  <a
                    href='https://github.com/chrisleekr/binance-trading-bot/wiki/TradingView'
                    target='_blank'
                    rel='noreferrer'>
                    please check out the Wiki page
                  </a>
                  .
                </div>
              </div>
              <div className='row'>
                <div className='col-12'>
                  <Table striped bordered hover size='sm'>
                    <tbody>{tradingViewRows}</tbody>
                  </Table>
                </div>
              </div>
              <div className='row'>
                <div className='col-12 text-right'>
                  <button
                    type='button'
                    className='btn btn-sm btn-add-new-tradingview'
                    disabled={canAddTradingView === false}
                    onClick={this.onAddTradingView}>
                    Add new TrdingView
                  </button>
                </div>
              </div>
            </Card.Body>
          </Accordion.Collapse>
        </Card>
      </Accordion>
    );
  }
}
