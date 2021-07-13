/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class PastTradesWrapper extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      canUpdate: true,
      pastTrades: {}
    };

    this.setUpdate = this.setUpdate.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update, when the canUpdate is true.
    const { canUpdate } = this.state;
    if (
      canUpdate === true &&
      _.get(nextProps, 'symbols', null) !== null &&
      _.isEqual(_.get(nextProps, 'symbols', null), this.state.symbols) === false
    ) {


      console.log("Can update")

    }
  }

  setUpdate(newStatus) {
    this.setState({
      canUpdate: newStatus
    });
  }

  render() {
    const { jsonStrings, pastTrades } = this.props;

    if (_.isEmpty(jsonStrings)) {
      return '';
    }
    const { profit_loss_wrapper, common_strings } = jsonStrings;

    let finalProfit = 0;

    const trades = Object.values(pastTrades).map((trade, index) => {

      const profitIsNegative = Math.sign(trade.profit);
      let classNameExtension = '';
      if (profitIsNegative === 1) {
        classNameExtension = ' past-trades-profit'
      }
      if (profitIsNegative === -1) {
        classNameExtension = ' past-trades-loss'
      }
      finalProfit += parseFloat(trade.profit);
      return (
        <div
          key={`past-trade-` + index}
          className='profit-loss-wrapper pt-2 pl-2 pr-2 pb-0'>
          <div className={'profit-loss-wrapper-body' + classNameExtension}>
            <span className='profit-loss-asset'>{trade.symbol}</span>
            <span className='profit-loss-value'>
              {profitIsNegative == 1 ? (
                "+ " + parseFloat(trade.profit).toFixed(3)
              ) : (
                [profitIsNegative == -1 ? (
                  parseFloat(trade.profit).toFixed(3)
                ) : (
                  ''
                )]
              )}
            </span>
          </div>
        </div>
      );
    });


    return (
      <div className='accordion-wrapper profit-loss-accordion-wrapper'>
        <Accordion defaultActiveKey='0'>
          <Card>
            <Card.Header className='px-2 py-1'>
              <div className='d-flex flex-row justify-content-between'>
                <div className='flex-column-left'>
                  <div className='btn-profit-loss text-uppercase font-weight-bold'>
                    Past Trades {' '}
                  </div>
                </div>
                <div className='flex-column-right pt-2'>
                  <span className='profit-loss-asset'>Overall Profit: {finalProfit.toFixed(3)} $</span>
                </div>
              </div>
            </Card.Header>
            <Accordion.Collapse eventKey='0'>
              <Card.Body className='d-flex flex-column py-2 px-0 card-body'>
                <div className='profit-loss-wrappers info-wrapper d-flex flex-row flex-wrap justify-content-start'>
                  {_.isEmpty(pastTrades) ? (
                    <div className='text-center w-100'>
                      <Spinner animation='border' role='status'>
                        <span className='sr-only'>Not trades yet...</span>
                      </Spinner>
                    </div>
                  ) : (
                    trades
                  )}
                </div>
              </Card.Body>
            </Accordion.Collapse>
          </Card>
        </Accordion>
      </div>
    );
  }
}
