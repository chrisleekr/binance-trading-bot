/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class FilterIcon extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      filter: 'showFilterModal'
    };

    this.state = {
      showFilterModal: false,
      selectedSortOption: 'default',
      searchKeyword: ''
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
    this.setSortOption = this.setSortOption.bind(this);
    this.setSearchKeyword = this.setSearchKeyword.bind(this);
    this.handleApply = this.handleApply.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (this.state.showFilterModal === false) {
      if (
        _.isEmpty(nextProps.selectedSortOption) === false &&
        _.isEqual(
          nextProps.selectedSortOption,
          this.state.selectedSortOption
        ) === false
      ) {
        const { selectedSortOption } = nextProps;

        this.setState({
          selectedSortOption
        });
      }

      if (
        _.isEmpty(nextProps.searchKeyword) === false &&
        _.isEqual(nextProps.searchKeyword, this.state.searchKeyword) === false
      ) {
        const { searchKeyword } = nextProps;

        this.setState({
          searchKeyword
        });
      }
    }
  }

  handleModalShow(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: true
    });
  }

  handleModalClose(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: false
    });
  }

  setSortOption(newSortOption) {
    this.setState({
      selectedSortOption: newSortOption
    });
    this.props.setSortOption(newSortOption);
    // Save to local storage
    localStorage.setItem('selectedSortOption', newSortOption);
  }

  setSearchKeyword(event) {
    const value = event.target.value;

    this.setState({
      searchKeyword: value
    });
    this.props.setSearchKeyword(value);
  }

  handleApply(e) {
    e.preventDefault();
    this.handleModalClose('filter');
  }

  render() {
    const { availableSortOptions, isAuthenticated } = this.props;

    if (isAuthenticated === false) {
      return '';
    }

    const { selectedSortOption, searchKeyword } = this.state;

    const sortingOptionWrappers = availableSortOptions.map((option, index) => {
      return (
        <div className='col-xs-12 col-sm-6' key={'sort-option-' + index}>
          <Button
            variant={
              option.sortBy === selectedSortOption ? 'primary' : 'secondary'
            }
            size='sm'
            className='btn-block mb-1'
            onClick={() => this.setSortOption(option.sortBy)}>
            {option.label}
          </Button>
        </div>
      );
    });

    return (
      <div className='header-column-icon-wrapper sort-wrapper'>
        <button
          type='button'
          className={`btn btn-sm btn-link p-0 pl-1 pr-1 ${
            searchKeyword !== '' ? 'has-search-keyword' : ''
          }`}
          onClick={() => this.handleModalShow('filter')}>
          <i className='fas fa-filter'></i>
        </button>
        <Modal
          show={this.state.showFilterModal}
          onHide={() => this.handleModalClose('filter')}
          size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>Filter</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Accordion defaultActiveKey='0'>
              <Card className='mt-1' style={{ overflow: 'visible' }}>
                <Card.Header className='px-2 py-1'>
                  <Accordion.Toggle
                    as={Button}
                    variant='link'
                    eventKey='0'
                    className='p-0 fs-7 text-uppercase'>
                    Search symbols
                  </Accordion.Toggle>
                </Card.Header>
                <Accordion.Collapse eventKey='0'>
                  <Card.Body className='px-2 pt-3 pb-1'>
                    <Form.Group controlId='field-candles-interval'>
                      <Form.Control
                        size='sm'
                        type='search'
                        placeholder='Enter keyword...'
                        defaultValue={searchKeyword}
                        onChange={this.setSearchKeyword}
                      />
                    </Form.Group>
                  </Card.Body>
                </Accordion.Collapse>
              </Card>
            </Accordion>
            <Accordion defaultActiveKey='0'>
              <Card className='mt-1' style={{ overflow: 'visible' }}>
                <Card.Header className='px-2 py-1'>
                  <Accordion.Toggle
                    as={Button}
                    variant='link'
                    eventKey='0'
                    className='p-0 fs-7 text-uppercase'>
                    Sort symbols
                  </Accordion.Toggle>
                </Card.Header>
                <Accordion.Collapse eventKey='0'>
                  <Card.Body className='px-2 py-1'>
                    <div className='row'>{sortingOptionWrappers} </div>
                  </Card.Body>
                </Accordion.Collapse>
              </Card>
            </Accordion>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={() => this.handleModalClose('filter')}>
              Close
            </Button>
            <Button
              type='button'
              variant='danger'
              size='sm'
              onClick={this.handleApply}>
              Apply
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
