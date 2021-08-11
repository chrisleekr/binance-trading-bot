/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconBotOptions extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      botOptions: {}
    };

    this.handleInputChange = this.handleInputChange.bind(this);
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

    const newBotOptions = _.set(botOptions, stateKey, value);
    this.setState({
      botOptions: newBotOptions
    });

    this.props.handleBotOptionsChange(botOptions);
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
              Bot Options
            </Accordion.Toggle>
          </Card.Header>
          <Accordion.Collapse eventKey='0'>
            <Card.Body className='px-2 py-1'>
              <div className='row'>
                <div className='col-12'>
                  <Accordion defaultActiveKey='0'>
                    <Card className='mt-1'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          Authentication
                        </Accordion.Toggle>
                      </Card.Header>
                      <Accordion.Collapse eventKey='0'>
                        <Card.Body className='px-2 py-1'>
                          <div className='row'>
                            <div className='col-12'>
                              <Form.Group
                                controlId='field-bot-options-lock-list'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='authentication.lockList'
                                    checked={botOptions.authentication.lockList}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    Lock List{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='bot-options-lock-list-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='bot-options-lock-list-overlay-right'>
                                          <Popover.Content>
                                            If enabled, the bot will show the
                                            login screen before showing the
                                            list. If disabled, the bot will
                                            display the list, but all actions
                                            will be disabled. To unlock, click
                                            the icon{' '}
                                            <i className='fas fas-unlock-alt fa-xs'></i>{' '}
                                            on the top right.
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
                                <div className='col-6'>
                                  <Form.Group
                                    controlId='field-bot-options-lock-after'
                                    className='mb-2'>
                                    <Form.Label className='mb-0'>
                                      Lock after
                                      <OverlayTrigger
                                        trigger='click'
                                        key='limit-overlay'
                                        placement='bottom'
                                        overlay={
                                          <Popover id='limit-overlay-right'>
                                            <Popover.Content>
                                              Set the minutes to allow
                                              authentication. Once the time
                                              passes the configured minutes
                                              after login, the bot will be
                                              automatically locked.
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
                                      placeholder='Enter minutes'
                                      required
                                      min='1'
                                      step='1'
                                      data-state-key='authentication.lockAfter'
                                      value={
                                        botOptions.authentication.lockAfter
                                      }
                                      onChange={this.handleInputChange}
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

                  <Accordion defaultActiveKey='0'>
                    <Card className='mt-1'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          Auto Trigger Buy
                        </Accordion.Toggle>
                      </Card.Header>
                      <Accordion.Collapse eventKey='0'>
                        <Card.Body className='px-2 py-1'>
                          <div className='row'>
                            <div className='col-12'>
                              <Form.Group
                                controlId='field-bot-options-auto-trigger-buy-enabled'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='autoTriggerBuy.enabled'
                                    checked={botOptions.autoTriggerBuy.enabled}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    Enabled{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='bot-options-auto-trigger-buy-enabled-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='bot-options-auto-trigger-buy-enabled-overlay-right'>
                                          <Popover.Content>
                                            If enabled, the bot will trigger 1st
                                            grid trade for buying after removing
                                            the last buy price due to completed
                                            grid trades for selling. Note that
                                            this action may be triggered if you
                                            sell the coin in Binance directly
                                            and the last buy price was recorded.
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
                                <div className='col-6'>
                                  <Form.Group
                                    controlId='field-bot-options-auto-trigger-buy-trigger-after'
                                    className='mb-2'>
                                    <Form.Label className='mb-0'>
                                      Trigger after
                                      <OverlayTrigger
                                        trigger='click'
                                        key='limit-overlay'
                                        placement='bottom'
                                        overlay={
                                          <Popover id='limit-overlay-right'>
                                            <Popover.Content>
                                              Set the minutes to wait for
                                              triggering the grid trade for
                                              buying. Once the time passes the
                                              configured minutes, the bot will
                                              trigger the grid trade for buying.
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
                                      placeholder='Enter minutes'
                                      required
                                      min='1'
                                      step='1'
                                      data-state-key='autoTriggerBuy.triggerAfter'
                                      value={
                                        botOptions.autoTriggerBuy.triggerAfter
                                      }
                                      onChange={this.handleInputChange}
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
                </div>
              </div>
            </Card.Body>
          </Accordion.Collapse>
        </Card>
      </Accordion>
    );
  }
}
