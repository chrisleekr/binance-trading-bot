/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class ProfitLossWrapper extends React.Component {
  render() {
    const { totalPnL } = this.props;

    const quoteAssets = Object.values(totalPnL).map((pnl, index) => {
      const percentage =
        pnl.amount > 0 ? ((pnl.profit / pnl.amount) * 100).toFixed(2) : 0;
      return (
        <div
          key={`info-pnl-` + index}
          className='profit-loss-wrapper pt-2 pl-2 pr-2 pb-0'>
          <div className='profit-loss-wrapper-body'>
            <span className='profit-loss-asset'>{pnl.asset}</span>{' '}
            <span className='profit-loss-value'>
              {pnl.profit > 0 ? '+' : ''}
              {pnl.profit.toFixed(5)} ({percentage}%)
            </span>
          </div>
        </div>
      );
    });

    return (
      <div className='accordion-wrapper profit-loss-accordion-wrapper'>
        <Accordion defaultActiveKey='0'>
          <Card bg='dark'>
            <Card.Header className='px-2 py-1'>
              <div className='d-flex flex-row justify-content-between'>
                <div className='flex-column-left'>
                  <div className='btn-profit-loss text-uppercase font-weight-bold'>
                    Profit/Loss{' '}
                    <OverlayTrigger
                      trigger='click'
                      key='profit-loss-overlay'
                      placement='bottom'
                      overlay={
                        <Popover id='profit-loss-overlay-right'>
                          <Popover.Content>
                            This section displays the estimated profit/loss for
                            the list of assets that are currently open to
                            selling with the last buy price recorded. The
                            calculation is simply adding profit/loss values for
                            each quote asset. Note that it does not represent
                            the historical profit/loss.
                          </Popover.Content>
                        </Popover>
                      }>
                      <Button variant='link' className='p-0 m-0 ml-1 text-info'>
                        <i className='fa fa-question-circle'></i>
                      </Button>
                    </OverlayTrigger>
                  </div>
                </div>
                {/* <div className='flex-column-right pt-2'>
                  <ManualTradeIcon />
                </div> */}
              </div>
            </Card.Header>

            <Accordion.Collapse eventKey='0'>
              <Card.Body className='d-flex flex-column py-2 px-0 card-body'>
                <div className='profit-loss-wrappers info-wrapper d-flex flex-row flex-wrap justify-content-start'>
                  {quoteAssets}
                </div>
              </Card.Body>
            </Accordion.Collapse>
          </Card>
        </Accordion>
      </div>
    );
  }
}
