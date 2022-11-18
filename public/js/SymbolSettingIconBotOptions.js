/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolSettingIconBotOptions extends React.Component {
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
                  <SymbolSettingIconBotOptionsAutoTriggerBuy
                    botOptions={botOptions}
                    handleInputChange={this.handleInputChange}
                    handleBotOptionsChange={this.handleBotOptionsChange}
                  />
                </div>
              </div>
            </Card.Body>
          </Accordion.Collapse>
        </Card>
      </Accordion>
    );
  }
}
