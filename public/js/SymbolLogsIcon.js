/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolLogsIcon extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      logs: 'showLogsModal',
      logDetail: 'showLogDetailModal'
    };

    this.state = {
      showLogsModal: false,
      showLogDetailModal: false,
      loading: true,
      page: 1,
      limit: 20,
      rows: [],
      stats: {},
      logDetail: {}
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);

    this.setPage = this.setPage.bind(this);
  }

  handleModalShow(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: true
    });

    if (modal === 'logs') {
      this.loadGridTradeLogs();
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
      () => this.loadGridTradeLogs()
    );
  }

  loadGridTradeLogs() {
    const { symbol } = this.props;

    const { page, limit } = this.state;

    const authToken = localStorage.getItem('authToken') || '';

    this.setState({
      loading: true
    });

    return axios
      .post('/grid-trade-logs-get', {
        authToken,
        symbol,
        page,
        limit
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

  downloadLogs() {
    const { symbol } = this.props;
    const authToken = localStorage.getItem('authToken') || '';

    this.setState({
      loading: true
    });

    return axios
      .post('/grid-trade-logs-export', {
        authToken,
        symbol
      })
      .then(response => {
        const {
          data: {
            data: { fileName }
          }
        } = response;

        const filePath = `data/logs/${fileName}`;
        window.open(filePath, '_blank');

        this.setState({
          loading: false
        });
      })
      .catch(e => {
        console.log(e);
        this.setState({
          loading: false
        });
      });
  }

  render() {
    const { symbol, isAuthenticated } = this.props;

    if (isAuthenticated === false) {
      return '';
    }

    const {
      loading,
      showLogsModal,
      showLogDetailModal,
      rows,
      stats,
      page,
      limit,
      logDetail
    } = this.state;

    const paginationItems = [];

    const totalPages = Math.ceil(stats.rows / limit);
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

    const logRows = rows.map((row, _index) => {
      const uuid = _.get(row, ['data', 'correlationId'], '').split('-').pop();
      const step = _.get(row, ['data', 'stepName'], 'Unknown');
      let uuidBlock = '';
      if (uuid) {
        uuidBlock = (
          <div>
            <code>
              {uuid} - {step}
            </code>
          </div>
        );
      }

      return (
        <React.Fragment key={'symbol-grid-trade-log-' + row._id}>
          <tr>
            <td
              className='text-center align-top'
              title={moment(row.loggedAt).format()}>
              {moment(row.loggedAt).format('HH:mm:ss.SSS')}
            </td>
            <td>
              {uuidBlock}
              {row.msg}
            </td>
            <td className='text-center'>
              <button
                type='button'
                className='btn btn-sm btn-link p-0 mx-1 text-muted'
                onClick={() => {
                  this.setState(
                    {
                      logDetail: row
                    },
                    () => this.handleModalShow('logDetail')
                  );
                }}>
                <i className='fas fa-eye'></i>
              </button>
            </td>
          </tr>
        </React.Fragment>
      );
    });

    return (
      <div className='symbol-logs-icon-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0 mr-1'
          onClick={() => this.handleModalShow('logs')}>
          <i className='fas fa-history'></i>
        </button>

        <Modal
          show={showLogsModal}
          onHide={() => this.handleModalClose('logs')}
          size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>
              <div className='d-flex w-100 flex-row'>
                Logs for {symbol}{' '}
                <button
                  type='button'
                  className='btn btn-sm btn-link p-0 ml-1'
                  onClick={() => this.loadGridTradeLogs()}>
                  <i className='fas fa-sync-alt'></i>
                </button>
              </div>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body className='py-0'>
            <React.Fragment>
              {rows.length === 0 ? (
                <div className='row'>
                  <div className='col-12 text-center p-3'>No log found</div>
                </div>
              ) : (
                <React.Fragment>
                  <div className='row'>
                    <div className='d-flex w-100 flex-row justify-content-center px-3 my-2'>
                      <Pagination
                        className='justify-content-center mb-0'
                        size='sm'>
                        {paginationItems}
                      </Pagination>
                    </div>
                    <Table striped bordered hover size='sm' responsive>
                      <thead>
                        <tr>
                          <th className='text-center' width='12%'>
                            Logged At
                          </th>
                          <th className='text-center' width='80%'>
                            Message
                          </th>
                          <th className='text-center'>Data</th>
                        </tr>
                      </thead>
                      <tbody>{logRows}</tbody>
                    </Table>
                    <div className='d-flex w-100 flex-row justify-content-center px-3 my-2'>
                      <Pagination
                        className='justify-content-center mb-0'
                        size='sm'>
                        {paginationItems}
                      </Pagination>
                    </div>
                  </div>
                  <div className='row'>
                    <div className='d-flex w-100 flex-row justify-content-end px-3 mb-2'>
                      <button
                        type='button'
                        className='btn btn-sm btn-info'
                        disabled={loading}
                        onClick={() => this.downloadLogs()}>
                        <i className='fas fas-download'></i> Export logs
                      </button>
                    </div>
                  </div>
                </React.Fragment>
              )}
            </React.Fragment>
          </Modal.Body>
        </Modal>

        <Modal
          show={showLogDetailModal}
          onHide={() => this.handleModalClose('logDetail')}
          size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>Log</Modal.Title>
          </Modal.Header>
          <Modal.Body className='py-0'>
            <textarea
              className='w-100'
              style={{ height: '500px' }}
              value={logDetail ? JSON.stringify(logDetail, null, 2) : ''}
              readOnly></textarea>
          </Modal.Body>
        </Modal>
      </div>
    );
  }
}
