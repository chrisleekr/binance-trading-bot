/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class AccountWrapper extends React.Component {
  render() {
    const { accountInfo } = this.props;

    const assets = accountInfo.balances.map((balance, index) => {
      return (
        <AccountWrapperAsset
          key={index}
          balance={balance}></AccountWrapperAsset>
      );
    });

    return (
      <div className='account-wrapper'>
        <Accordion>
          <Card bg='dark'>
            <Accordion.Toggle
              as={Card.Header}
              eventKey='0'
              className='px-2 py-1'>
              <button
                type='button'
                className='btn btn-sm btn-link btn-account-balance'>
                Account Balance
              </button>
            </Accordion.Toggle>
            <Accordion.Collapse eventKey='0'>
              <Card.Body className='account-wrapper-assets pt-0 pl-0 pr-0 pb-2'>
                {assets}
              </Card.Body>
            </Accordion.Collapse>
          </Card>
        </Accordion>
      </div>
    );
  }
}
