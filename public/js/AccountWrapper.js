/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class AccountWrapper extends React.Component {
  render() {
    const { accountInfo, dustTransfer, sendWebSocket, isAuthenticated, symbolEstimates } =
      this.props;

    const assets = accountInfo.balances.map((balance, index) => {
      return (
        <AccountWrapperAsset
          key={`account-wrapper-` + index}
          balance={balance}></AccountWrapperAsset>
      );
    });

    let groupedEstimates = {};
    symbolEstimates.forEach((symbol) => {
      if (!Object.keys(groupedEstimates).includes(symbol.quoteAsset)) {
        groupedEstimates[symbol.quoteAsset] = {};
        groupedEstimates[symbol.quoteAsset]['value'] = 0;
        groupedEstimates[symbol.quoteAsset]['quotePrecision'] = parseFloat(symbol.tickSize) === 1 ? 0 : symbol.tickSize.indexOf(1) - 1;
      }

      groupedEstimates[symbol.quoteAsset]['value'] += symbol.estimatedValue;
    });

    console.log(groupedEstimates);

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
                <span className="pr-2">Account Balance</span>
                <br className="d-block d-sm-none" />
                <span className="text-success">
                  {Object.keys(groupedEstimates).map((key) => `[${key}: ${parseFloat(groupedEstimates[key]['value']).toFixed(groupedEstimates[key]['quotePrecision'])}]`).join(' ')}
                </span>
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
      </div >
    );
  }
}
