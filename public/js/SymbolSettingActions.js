/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolSettingIconActions extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      resetGlobalSetting: 'showResetToGlobalSettingModal',
      resetGridTrade: 'showResetGridTradeModal'
    };

    this.state = {
      showResetToGlobalSettingModal: false,
      showResetGridTradeModal: false
    };
    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
  }

  handleModalShow(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: true
    });
  }

  handleModalClose(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: false
    });
  }

  render() {
    return (
      <React.Fragment>
        <SymbolSettingActionResetToGlobalSetting
          showResetToGlobalSettingModal={
            this.state.showResetToGlobalSettingModal
          }
          handleModalClose={this.handleModalClose}
          sendWebSocket={this.props.sendWebSocket}
          symbolInfo={this.props.symbolInfo}
        />

        <SymbolSettingActionResetGridTrade
          showResetGridTradeModal={this.state.showResetGridTradeModal}
          handleModalClose={this.handleModalClose}
          sendWebSocket={this.props.sendWebSocket}
          symbolInfo={this.props.symbolInfo}
        />

        <Accordion defaultActiveKey='0'>
          <Card className='mt-1'>
            <Card.Header className='px-2 py-1'>
              <Accordion.Toggle
                as={Button}
                variant='link'
                eventKey='0'
                className='p-0 fs-7 text-uppercase'>
                Actions
              </Accordion.Toggle>
            </Card.Header>
            <Accordion.Collapse eventKey='0'>
              <Card.Body className='px-2 py-2'>
                <div className='row'>
                  <div className='col-12'>
                    <Button
                      variant='danger'
                      size='sm'
                      type='button'
                      className='mr-2'
                      onClick={() =>
                        this.handleModalShow('resetGlobalSetting')
                      }>
                      Reset to Global Setting
                    </Button>

                    <Button
                      variant='danger'
                      size='sm'
                      type='button'
                      onClick={() => this.handleModalShow('resetGridTrade')}>
                      Reset Grid Trade
                    </Button>
                  </div>
                </div>
              </Card.Body>
            </Accordion.Collapse>
          </Card>
        </Accordion>
      </React.Fragment>
    );
  }
}
