/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconBotOptionsOrderLimit extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      botOptions: {}
    };
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      _.isEmpty(nextProps.botOptions) === false &&
      _.isEqual(nextProps.botOptions, this.state.botOptions) === false
    ) {
      const { botOptions } = nextProps;

      this.setState({
        botOptions
      });
    }
  }

  render() {
    const { botOptions } = this.state;

    if (_.isEmpty(botOptions)) {
      return '';
    }

    return (
      <Accordion defaultActiveKey='0'>
        <Card className='mt-1'>
          <Card.Header className='px-2 py-1'>
            <Accordion.Toggle
              as={Button}
              variant='link'
              eventKey='0'
              className='p-0 fs-7 text-uppercase'>
              Order Limit
            </Accordion.Toggle>
          </Card.Header>
          <Accordion.Collapse eventKey='0'>
            <Card.Body className='px-2 py-1'>
              <div className='row'>
                <div className='col-12'>
                  <Form.Group
                    controlId='field-bot-options-order-limit-enabled'
                    className='mb-2'>
                    <Form.Check size='sm'>
                      <Form.Check.Input
                        type='checkbox'
                        data-state-key='orderLimit.enabled'
                        checked={botOptions.orderLimit.enabled}
                        onChange={this.props.handleInputChange}
                      />
                      <Form.Check.Label>
                        Enabled{' '}
                        <OverlayTrigger
                          trigger='click'
                          key='bot-options-order-limit-enabled-overlay'
                          placement='bottom'
                          overlay={
                            <Popover id='bot-options-order-limit-enabled-overlay-right'>
                              <Popover.Content>
                                If enabled, the bot will not place orders if the
                                conditions meet.
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
                  <div className='row'>
                    <div className='col-12 col-sm-6'>
                      <Form.Group
                        controlId='field-bot-options-order-limit-max-buy-open-orders'
                        className='mb-2'>
                        <Form.Label className='mb-0'>
                          Max. Buy Open Orders
                          <OverlayTrigger
                            trigger='click'
                            key='max-buy-open-orders-overlay'
                            placement='bottom'
                            overlay={
                              <Popover id='max-buy-open-orders-overlay-right'>
                                <Popover.Content>
                                  Set the maximum number of concurrent open
                                  orders for buying. If set 3, then the bot will
                                  not place more than 3 buy open orders.
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
                          type='number'
                          placeholder='Enter maximum number of buy open orders'
                          required
                          min='1'
                          step='1'
                          data-state-key='orderLimit.maxBuyOpenOrders'
                          value={botOptions.orderLimit.maxBuyOpenOrders}
                          onChange={this.props.handleInputChange}
                        />
                      </Form.Group>
                    </div>
                    <div className='col-12 col-sm-6'>
                      <Form.Group
                        controlId='field-bot-options-order-limit-max-open-trades'
                        className='mb-2'>
                        <Form.Label className='mb-0'>
                          Max. Open Trades
                          <OverlayTrigger
                            trigger='click'
                            key='max-open-trades-overlay'
                            placement='bottom'
                            overlay={
                              <Popover id='max-open-trades-overlay-right'>
                                <Popover.Content>
                                  Set the maximum number of open trades. If set
                                  5,, then the bot will not place a buy order
                                  when there are 5 symbols recorded with the
                                  last buy price.
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
                          type='number'
                          placeholder='Enter maximum number of open trades'
                          required
                          min='1'
                          step='1'
                          data-state-key='orderLimit.maxOpenTrades'
                          value={botOptions.orderLimit.maxOpenTrades}
                          onChange={this.props.handleInputChange}
                        />
                      </Form.Group>
                    </div>
                  </div>
                </div>
              </div>
            </Card.Body>
          </Accordion.Collapse>
        </Card>
      </Accordion>
    );
  }
}
