/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

class SymbolGridTradeArchiveIcon extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      archive: 'showArchiveModal',
      deleteByKey: 'showDeleteByKeyModal',
      deleteAllBySymbol: 'showDeleteAllBySymbolModal'
    };

    this.state = {
      showArchiveModal: false,
      showDeleteByKeyModal: false,
      showDeleteAllBySymbolModal: false,
      loading: true,
      page: 1,
      limit: 20,
      period: 'a',
      start: null,
      end: null,
      rows: [],
      stats: {},
      selectedDeleteByKey: null
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);

    this.setPeriod = this.setPeriod.bind(this);

    this.setPage = this.setPage.bind(this);
  }

  handleModalShow(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: true
    });

    if (modal === 'archive') {
      this.loadGridTradeArchive();
    }
  }

  handleModalClose(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: false
    });
  }

  setPage(newPage) {
    this.setState(
      {
        page: newPage > 0 ? newPage : 1
      },
      () => this.loadGridTradeArchive()
    );
  }

  setPeriod(newPeriod) {
    let start = null;
    let end = null;

    const momentLocale = moment().locale(
      Intl.DateTimeFormat().resolvedOptions().locale
    );
    switch (newPeriod) {
      case 'd':
        start = momentLocale.startOf('day').toISOString();
        end = momentLocale.endOf('day').toISOString();
        break;
      case 'w':
        start = momentLocale.startOf('week').toISOString();
        end = momentLocale.endOf('week').toISOString();
        break;
      case 'm':
        start = momentLocale.startOf('month').toISOString();
        end = momentLocale.endOf('month').toISOString();
        break;
      case 'a':
      default:
    }

    this.setState({ page: 1, start, end, period: newPeriod }, () =>
      this.loadGridTradeArchive()
    );
  }

  loadGridTradeArchive() {
    const { symbol } = this.props;

    const { page, limit, start, end } = this.state;

    const authToken = localStorage.getItem('authToken') || '';

    this.setState({
      loading: true
    });

    return axios
      .post('/grid-trade-archive-get', {
        authToken,
        type: 'symbol',
        symbol,
        page,
        limit,
        start,
        end
      })
      .then(response => {
        // handle success
        const {
          data: {
            data: { stats, rows }
          }
        } = response;

        this.setState({
          loading: false,
          rows,
          stats
        });
      })
      .catch(e => {
        console.log(e);
        this.setState({
          loading: false
        });
      });
  }

  deleteGridTradeArchive(query) {
    const authToken = localStorage.getItem('authToken') || '';

    this.handleModalClose('deleteByKey');
    this.handleModalClose('deleteAllBySymbol');

    return axios
      .post('/grid-trade-archive-delete', {
        authToken,
        query
      })
      .then(_response => {
        return this.loadGridTradeArchive();
      });
  }

  render() {
    const { symbol, isAuthenticated, quoteAssetTickSize, quoteAsset } =
      this.props;
    const {
      loading,
      showArchiveModal,
      rows,
      stats,
      page,
      limit,
      period,
      start,
      end,
      selectedDeleteByKey
    } = this.state;

    if (isAuthenticated === false) {
      return '';
    }

    const tradeRows = rows.map((row, _index) => {
      return (
        <React.Fragment key={'symbol-grid-trade-row-' + row.key}>
          <tr>
            <td
              title={row.profit}
              className={`text-center align-middle ${
                row.profit > 0
                  ? 'buy-colour'
                  : row.profit < 0
                  ? 'sell-colour'
                  : ''
              } ${row.profit === 0 ? 'text-muted' : ''}`}>
              {parseFloat(row.profit).toFixed(quoteAssetTickSize)} {quoteAsset}
              <br />({parseFloat(row.profitPercentage).toFixed(2)}%)
            </td>
            <td
              title={
                'Buy via Grid Trade: ' +
                parseFloat(row.buyGridTradeQuoteQty).toFixed(
                  quoteAssetTickSize
                ) +
                '\n' +
                'Buy via Manual Trade: ' +
                parseFloat(row.buyManualQuoteQty).toFixed(quoteAssetTickSize)
              }
              className={`text-center align-middle ${
                row.totalBuyQuoteQty === 0 ? 'text-muted' : ''
              }`}>
              {parseFloat(row.totalBuyQuoteQty).toFixed(quoteAssetTickSize)}{' '}
              {quoteAsset}
            </td>
            <td
              title={
                'Sell via Grid Trade: ' +
                parseFloat(row.sellGridTradeQuoteQty).toFixed(
                  quoteAssetTickSize
                ) +
                '\n' +
                'Sell via Manual Trade: ' +
                parseFloat(row.sellManualQuoteQty).toFixed(quoteAssetTickSize) +
                '\n' +
                'Sell via Stop Loss: ' +
                parseFloat(row.stopLossQuoteQty).toFixed(quoteAssetTickSize)
              }
              className={`text-center align-middle ${
                row.totalSellQuoteQty === 0
                  ? 'text-muted'
                  : row.stopLossQuoteQty === 0
                  ? ''
                  : 'text-danger'
              }`}>
              {parseFloat(row.totalSellQuoteQty).toFixed(quoteAssetTickSize)}{' '}
              {quoteAsset}
            </td>
            <td
              className='text-center align-middle'
              title={moment(row.archivedAt).format()}>
              {moment(row.archivedAt).fromNow()}
            </td>
            <td className='text-center align-middle'>
              <button
                type='button'
                className='btn btn-sm btn-danger'
                onClick={() => {
                  this.setState(
                    {
                      selectedDeleteByKey: row.key
                    },
                    () => this.handleModalShow('deleteByKey')
                  );
                }}>
                Delete
              </button>
            </td>
          </tr>
        </React.Fragment>
      );
    });

    const paginationItems = [];

    const totalPages = Math.ceil(stats.trades / limit);
    // If total
    paginationItems.push(
      <Pagination.First
        key='first'
        disabled={page === 1 || totalPages === 1}
        onClick={() => this.setPage(1)}
      />
    );
    if (page === 1 || totalPages === 1) {
      paginationItems.push(
        <Pagination.Prev key='pagination-item-prev' disabled />
      );
    } else {
      paginationItems.push(
        <Pagination.Prev
          key='pagination-item-prev'
          onClick={() => this.setPage(page - 1)}
        />
      );
    }
    const maxButtons = 8;
    const buttons = Math.min(maxButtons, ~~totalPages);
    [...Array(buttons).keys()].forEach(x => {
      const pageNum = Math.min(
        Math.max(x + 1, page + x + 1 - Math.ceil(buttons / 2)),
        totalPages + x + 1 - buttons
      );
      paginationItems.push(
        <Pagination.Item
          active={pageNum === page}
          disabled={pageNum > totalPages}
          key={`pagination-item-${x}`}
          onClick={() => this.setPage(pageNum)}>
          {pageNum}
        </Pagination.Item>
      );
    });
    if (page === totalPages || page >= totalPages) {
      paginationItems.push(
        <Pagination.Next key='pagination-item-next' disabled />
      );
    } else {
      paginationItems.push(
        <Pagination.Next
          key='pagination-item-next'
          onClick={() => this.setPage(page + 1)}
        />
      );
    }
    const lastPage = totalPages;
    paginationItems.push(
      <Pagination.Last
        key='last'
        disabled={page === totalPages || page >= totalPages}
        onClick={() => this.setPage(lastPage)}
      />
    );

    return (
      <div className='coin-info-symbol-grid-trade-archive-wrapper'>
        <div className='coin-info-column coin-info-column-symbol-grid-trade-archive d-flex flex-row justify-content-start align-content-between border-bottom-0 mb-0 pb-0'>
          <button
            type='button'
            className='btn btn-sm btn-link mx-1 p-0 text-white'
            onClick={() => this.handleModalShow('archive')}>
            <i className='fas fa-list-alt'></i>
          </button>
        </div>
        <Modal
          show={showArchiveModal}
          onHide={() => this.handleModalClose('archive')}
          size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>Closed Trades for {symbol}</Modal.Title>
          </Modal.Header>
          <Modal.Body className='py-0'>
            {loading ? (
              <div className='text-center w-100'>
                <Spinner animation='border' role='status'>
                  <span className='sr-only'>Loading...</span>
                </Spinner>
              </div>
            ) : (
              <React.Fragment>
                <div className='trade-stats-wrapper'>
                  <Card className='border-0 trade-stat-wrapper'>
                    <Card.Body className='p-2 text-center'>
                      <Card.Title className='fs-7 font-weight-bold mb-0'>
                        Total Profit
                      </Card.Title>
                      <Card.Text
                        title={stats.profit}
                        className={
                          stats.profit > 0
                            ? 'text-success'
                            : stats.profit < 0
                            ? 'text-danger'
                            : 'text-muted'
                        }>
                        {parseFloat(stats.profit).toFixed(quoteAssetTickSize)}{' '}
                        {quoteAsset}
                        <br />({parseFloat(stats.profitPercentage).toFixed(2)}%)
                      </Card.Text>
                    </Card.Body>
                  </Card>
                  <Card className='border-0 trade-stat-wrapper'>
                    <Card.Body className='p-2 text-center'>
                      <Card.Title className='fs-7 font-weight-bold mb-0'>
                        Total Buy:
                      </Card.Title>
                      <Card.Text
                        title={stats.totalBuyQuoteQty}
                        className={`${
                          stats.totalBuyQuoteQty === 0 ? 'text-muted' : ''
                        }`}>
                        {parseFloat(stats.totalBuyQuoteQty).toFixed(
                          quoteAssetTickSize
                        )}{' '}
                        {quoteAsset}
                      </Card.Text>
                    </Card.Body>
                  </Card>
                  <Card className='border-0 trade-stat-wrapper'>
                    <Card.Body className='p-2 text-center'>
                      <Card.Title className='fs-7 font-weight-bold mb-0'>
                        Total Sell
                      </Card.Title>
                      <Card.Text
                        title={stats.totalSellQuoteQty}
                        className={`${
                          stats.totalSellQuoteQty === 0 ? 'text-muted' : ''
                        }`}>
                        {parseFloat(stats.totalSellQuoteQty).toFixed(
                          quoteAssetTickSize
                        )}{' '}
                        {quoteAsset}
                      </Card.Text>
                    </Card.Body>
                  </Card>
                  <Card className='border-0 trade-stat-wrapper'>
                    <Card.Body className='p-2 text-center'>
                      <Card.Title className='fs-7 font-weight-bold mb-0'>
                        Trades
                      </Card.Title>
                      <Card.Text
                        className={stats.trades === 0 ? 'text-muted' : ''}>
                        {stats.trades}
                      </Card.Text>
                    </Card.Body>
                  </Card>
                </div>
                <div className='row mb-1'>
                  <div className='col-sm-12 col-md-6'>
                    <strong>Period:</strong>{' '}
                    {period === 'a'
                      ? 'All time'
                      : `${moment(start).format('YYYY-MM-DD')} ~ ${moment(
                          end
                        ).format('YYYY-MM-DD')}`}
                  </div>
                  <div className='col-sm-12 col-md-6 text-right'>
                    <button
                      type='button'
                      className={`btn btn-period ml-1 btn-sm ${
                        period === 'd' ? 'btn-info' : 'btn-light'
                      }`}
                      onClick={() => this.setPeriod('d')}
                      title='Day'>
                      Day
                    </button>
                    <button
                      type='button'
                      className={`btn btn-period ml-1 btn-sm ${
                        period === 'w' ? 'btn-info' : 'btn-light'
                      }`}
                      onClick={() => this.setPeriod('w')}
                      title='W'>
                      Week
                    </button>
                    <button
                      type='button'
                      className={`btn btn-period ml-1 btn-sm ${
                        period === 'm' ? 'btn-info' : 'btn-light'
                      }`}
                      onClick={() => this.setPeriod('m')}
                      title='Month'>
                      Month
                    </button>
                    <button
                      type='button'
                      className={`btn btn-period ml-1 btn-sm ${
                        period === 'a' ? 'btn-info' : 'btn-light'
                      }`}
                      onClick={() => this.setPeriod('a')}>
                      All
                    </button>
                  </div>
                </div>
                {rows.length === 0 ? (
                  <div className='row'>
                    <div className='col-12 text-center p-3'>No trade found</div>
                  </div>
                ) : (
                  <React.Fragment>
                    <div className='row'>
                      <div className='d-flex w-100 flex-row justify-content-between px-3 mb-2'>
                        <Pagination
                          className='justify-content-center mb-0'
                          size='sm'>
                          {paginationItems}
                        </Pagination>
                      </div>
                      <Table striped bordered hover size='sm' responsive>
                        <thead>
                          <tr>
                            <th className='text-center'>Profit</th>
                            <th className='text-center'>Buy</th>
                            <th className='text-center'>Sell</th>
                            <th className='text-center'>Closed At</th>
                            <th className='text-center'>Action</th>
                          </tr>
                        </thead>
                        <tbody>{tradeRows}</tbody>
                      </Table>
                      <div className='d-flex w-100 flex-row justify-content-between px-3 mb-2'>
                        <Pagination
                          className='justify-content-center mb-0'
                          size='sm'>
                          {paginationItems}
                        </Pagination>
                        <div className='text-right'>
                          <button
                            type='button'
                            className='btn btn-sm btn-danger'
                            onClick={() =>
                              this.handleModalShow('deleteAllBySymbol')
                            }>
                            Delete all
                          </button>
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                )}
              </React.Fragment>
            )}
          </Modal.Body>
        </Modal>

        <Modal
          show={this.state.showDeleteByKeyModal}
          onHide={() => this.handleModalClose('deleteByKey')}
          size='md'>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>
              <span className='text-danger'>⚠ Delete Closed Trade</span>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            You are about to delete the existing closed grid trade.
            <br />
            <br />
            Do you want to delete the closed grid trade?
          </Modal.Body>

          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={() => this.handleModalClose('deleteByKey')}>
              Cancel
            </Button>
            <Button
              variant='danger'
              size='sm'
              onClick={() =>
                this.deleteGridTradeArchive({
                  key: selectedDeleteByKey
                })
              }>
              Delete
            </Button>
          </Modal.Footer>
        </Modal>

        <Modal
          show={this.state.showDeleteAllBySymbolModal}
          onHide={() => this.handleModalClose('deleteAllBySymbol')}
          size='md'>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>
              <span className='text-danger'>⚠ Delete All Closed Trade</span>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            You are about to delete the all closed grid trade.
            <br />
            <br />
            Do you want to delete the closed grid trade?
          </Modal.Body>

          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={() => this.handleModalClose('deleteAllBySymbol')}>
              Cancel
            </Button>
            <Button
              variant='danger'
              size='sm'
              onClick={() =>
                this.deleteGridTradeArchive({
                  symbol
                })
              }>
              Delete All
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
