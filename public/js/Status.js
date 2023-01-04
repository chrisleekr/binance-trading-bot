/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class Status extends React.Component {
  render() {
    const {
      apiInfo,
      monitoringSymbolsCount,
      cachedMonitoringSymbolsCount,
      streamsCount
    } = this.props;

    if (!apiInfo) {
      return '';
    }

    let monitoringSymbolsStatus = '';

    if (monitoringSymbolsCount < cachedMonitoringSymbolsCount) {
      monitoringSymbolsStatus = (
        <OverlayTrigger
          trigger='click'
          key='monitoring-symbols-status-alert-overlay'
          placement='top'
          overlay={
            <Popover id='monitoring-symbols-status-alert-overlay-bottom'>
              <Popover.Content>
                You are currently monitoring <b>{monitoringSymbolsCount}</b>{' '}
                symbols. However, the symbols you have in your frontend is equal
                to <b>{cachedMonitoringSymbolsCount}</b>. That means you added
                some symbols in your <b>Global Settings</b> and after that you
                removed them. These symbols will remain exists in your frontend
                and you can see them but they are not monitored. You can remove
                them by clicking on the cross icon.
              </Popover.Content>
            </Popover>
          }>
          <Button
            variant='link'
            className='p-0 m-0 ml-1 d-inline-block'
            style={{ lineHeight: '14px' }}>
            <i className='fas fa-exclamation-circle mx-1 text-warning'></i>
          </Button>
        </OverlayTrigger>
      );
    }

    return (
      <div className='accordion-wrapper status-wrapper'>
        <Accordion defaultActiveKey='0'>
          <Card bg='dark'>
            <Accordion.Toggle
              as={Card.Header}
              eventKey='0'
              className='px-2 py-1'>
              <button
                type='button'
                className='btn btn-sm btn-link btn-status text-uppercase font-weight-bold'>
                Status
              </button>
            </Accordion.Toggle>
            <Accordion.Collapse eventKey='0'>
              <Card.Body className='status-wrapper-body p-3 card-body'>
                <ul className='status-wrapper-ul list-unstyled mb-0'>
                  <li>
                    Used Weight (1m):{' '}
                    <HightlightChange className='coin-info-value'>
                      {apiInfo.spot.usedWeight1m}
                    </HightlightChange>
                    /1200
                  </li>
                  <li>
                    Streams Count (Max: 1024):{' '}
                    <HightlightChange className='coin-info-value'>
                      {streamsCount}
                    </HightlightChange>
                  </li>
                  <li>
                    Monitoring Symbols:{' '}
                    <HightlightChange className='coin-info-value'>
                      {monitoringSymbolsCount}
                    </HightlightChange>
                    {monitoringSymbolsStatus}
                  </li>
                </ul>
              </Card.Body>
            </Accordion.Collapse>
          </Card>
        </Accordion>
      </div>
    );
  }
}
