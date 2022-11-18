/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconBotOptionsLogs extends React.Component {
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
              Logs
            </Accordion.Toggle>
          </Card.Header>
          <Accordion.Collapse eventKey='0'>
            <Card.Body className='px-2 py-1'>
              <div className='row'>
                <div className='col-12 col-md-6'>
                  <Form.Group
                    controlId='field-bot-options-logs-delete-after'
                    className='mb-2'>
                    <Form.Label className='mb-0'>
                      Delete after
                      <OverlayTrigger
                        trigger='click'
                        key='logs-delete-after-overlay'
                        placement='bottom'
                        overlay={
                          <Popover id='logs-delete-after-overlay-right'>
                            <Popover.Content>
                              Set the minutes to delete the log. If the log is
                              older than the configured minutes, the log will be
                              removed from the database.
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
                        min='0'
                        step='1'
                        data-state-key='logs.deleteAfter'
                        value={botOptions.logs.deleteAfter}
                        onChange={this.props.handleInputChange}
                      />
                      <InputGroup.Append>
                        <InputGroup.Text>minutes</InputGroup.Text>
                      </InputGroup.Append>
                    </InputGroup>
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
