/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconBotOptionsTradingView extends React.Component {
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
              TradingView
            </Accordion.Toggle>
          </Card.Header>
          <Accordion.Collapse eventKey='0'>
            <Card.Body className='px-2 py-1'>
              <div className='row'>
                <div className='col-12 col-md-6'>
                  <Form.Group
                    controlId='field-bot-options-tradingview-options-use-only-within'
                    className='mb-2'>
                    <Form.Label className='mb-0'>
                      Use data only updated within
                      <OverlayTrigger
                        trigger='click'
                        key='tradingview-options-use-only-within-overlay'
                        placement='bottom'
                        overlay={
                          <Popover id='tradingview-options-use-only-within-overlay-right'>
                            <Popover.Content>
                              Set the minutes to allow to use TradingView
                              technical analysis data. If the data is older than
                              configured minutes, the bot will ignore the
                              TradingView technical analysis data.
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

                    <InputGroup size='sm'>
                      <Form.Control
                        type='number'
                        placeholder='Enter minutes'
                        required
                        min='1'
                        step='1'
                        data-state-key='tradingViewOptions.useOnlyWithin'
                        value={botOptions.tradingViewOptions.useOnlyWithin}
                        onChange={this.props.handleInputChange}
                      />
                      <InputGroup.Append>
                        <InputGroup.Text>minutes</InputGroup.Text>
                      </InputGroup.Append>
                    </InputGroup>
                  </Form.Group>
                </div>
                <div className='col-12 col-md-6'>
                  <Form.Group
                    controlId='field-bot-options-tradingview-options-if-expires'
                    className='mb-2'>
                    <Form.Label className='mb-0'>
                      If data passed allowed updated
                      <OverlayTrigger
                        trigger='click'
                        key='bot-options-tradingview-options-if-expires-overlay'
                        placement='bottom'
                        overlay={
                          <Popover id='bot-options-tradingview-options-if-expires-overlay-right'>
                            <Popover.Content>
                              Set an action method if the TradingView technical
                              analysis data is passed allowed minutes.
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
                      data-state-key='tradingViewOptions.ifExpires'
                      value={botOptions.tradingViewOptions.ifExpires}
                      onChange={this.props.handleInputChange}>
                      <option value='ignore'>Ignore data</option>
                      <option value='do-not-buy'>Do not buy</option>
                    </Form.Control>
                  </Form.Group>
                </div>
              </div>
            </Card.Body>
          </Accordion.Collapse>
        </Card>
      </Accordion>
    );
  }
}
