/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class Status extends React.Component {
  render() {
    const { apiInfo, jsonStrings } = this.props;

    if (_.isEmpty(jsonStrings)) {
      return '';
    }

    const { commonStrings } = jsonStrings;

    if (!apiInfo) {
      return '';
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
                {commonStrings.status}
              </button>
            </Accordion.Toggle>
            <Accordion.Collapse eventKey='0'>
              <Card.Body className='status-wrapper-body p-3 card-body'>
                <ul className='status-wrapper-ul list-unstyled d-flex flex-row mb-0'>
                  <li>
                    {commonStrings.used_weight}:{' '}
                    <HightlightChange className='coin-info-value'>
                      {apiInfo.spot.usedWeight1m}
                    </HightlightChange>
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
