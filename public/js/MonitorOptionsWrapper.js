/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class MonitorOptionsWrapper extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    const { jsonStrings, searchKeyword, sortSymbols } = this.props;

    if (_.isEmpty(jsonStrings)) {
      return '';
    }
    const { profit_loss_wrapper, common_strings } = jsonStrings;

    return (
      <div className='accordion-wrapper profit-loss-accordion-wrapper'>
        <Accordion>
          <Card>
            <Card.Header className='px-2 py-1'>
              <div className='d-flex flex-row justify-content-between'>
                <div className='flex-column-center monitor'>
                  <SearchIcon searchKeyword={searchKeyword} />
                </div>
                <div className='flex-column-right pt-2 monitor-sm'>
                  <SortIcon sortSymbols={sortSymbols} />
                </div>
              </div>
            </Card.Header>
          </Card>
        </Accordion>
      </div>
    );
  }
}
