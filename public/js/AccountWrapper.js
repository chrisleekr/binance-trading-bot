/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class AccountWrapper extends React.Component {
  render() {
    const {
      accountInfo,
      dustTransfer,
      sendWebSocket,
      isAuthenticated,
      quoteEstimates
    } = this.props;

    const assets = accountInfo.balances.map((balance, index) => {
      let quoteEstimate = quoteEstimates.filter(
        elem => elem.baseAsset === balance.asset
      );

      if (quoteEstimate.length == 1) {
        quoteEstimate = {
          quote: quoteEstimate[0]['quoteAsset'],
          estimate: quoteEstimate[0]['estimatedValue']
        };
      } else {
        quoteEstimate = null;
      }

      return (
        <AccountWrapperAsset
          key={`account-wrapper-` + index}
          balance={balance}
          quoteEstimate={quoteEstimate}></AccountWrapperAsset>
      );
    });

    return (
      <div className='accordion-wrapper account-wrapper'>
        <Accordion>
          <Card bg='dark'>
            <Accordion.Toggle
              as={Card.Header}
              eventKey='0'
              className='px-2 py-1'>
              <button
                type='button'
                className='btn btn-sm btn-link btn-account-balance text-uppercase font-weight-bold text-left'>
                <span className='pr-2'>Account Balance</span>
              </button>
            </Accordion.Toggle>
            <Accordion.Collapse eventKey='0'>
              <Card.Body className='d-flex flex-column py-2 px-0'>
                <div className='account-balance-assets-wrapper d-flex flex-row flex-wrap justify-content-start'>
                  {assets}
                </div>
                <div className='account-balance-assets-wrapper d-flex flex-row flex-wrap justify-content-end'>
                  <DustTransferIcon
                    isAuthenticated={isAuthenticated}
                    dustTransfer={dustTransfer}
                    sendWebSocket={sendWebSocket}
                  />
                </div>
              </Card.Body>
            </Accordion.Collapse>
          </Card>
        </Accordion>
      </div>
    );
  }
}
