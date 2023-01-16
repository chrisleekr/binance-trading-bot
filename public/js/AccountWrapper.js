/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class AccountWrapper extends React.Component {
  constructor(props) {
    super(props);

    this.accordion = null;

    this.setFilter = this.setFilter.bind(this);
  }

  setFilter(asset) {
    this.props.setSearchKeyword(asset);

    this.accordion.click();

    const orderStatsEl = document.querySelector('.order-stats-wrapper');
    if (orderStatsEl)
      setTimeout(function () {
        orderStatsEl.scrollIntoView({
          behavior: 'smooth'
        });
      }, 750);
  }

  render() {
    const {
      accountInfo,
      dustTransfer,
      sendWebSocket,
      isAuthenticated,
      totalProfitAndLoss
    } = this.props;

    const assets = accountInfo.balances.map((balance, index) => {
      return (
        <AccountWrapperAsset
          key={`account-wrapper-` + index}
          balance={balance}
          isQuoteAsset={
            totalProfitAndLoss.find(
              profitAndLoss => profitAndLoss.asset === balance.asset
            ) !== undefined
          }
          setFilter={this.setFilter}></AccountWrapperAsset>
      );
    });

    return (
      <div className='accordion-wrapper account-wrapper'>
        <Accordion>
          <Card bg='dark'>
            <Accordion.Toggle
              ref={element => (this.accordion = element)}
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
                <div className='account-balance-assets-wrapper px-2'>
                  {assets}
                </div>
                <div className='d-flex flex-row flex-wrap justify-content-end'>
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
