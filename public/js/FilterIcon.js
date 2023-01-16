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
      selectedSortOption: {
        sortBy: 'default',
        sortByDesc: false,
        hideInactive: false
      },
      searchKeyword: ''
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
    this.setSortOption = this.setSortOption.bind(this);
    this.setHideOption = this.setHideOption.bind(this);
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

  setHideOption(newHideOption) {
    const newSortOption = {
      ...this.state.selectedSortOption,
      hideInactive: newHideOption.target.checked
    };

    this.setState({
      selectedSortOption: newSortOption
    });
    this.props.setSortOption(newSortOption);
    // Save to local storage
    localStorage.setItem('selectedSortOption', JSON.stringify(newSortOption));
  }

  setSortOption(newSortOption) {
    const mergedSortOption = {
      ...newSortOption,
      hideInactive: this.state.selectedSortOption.hideInactive
    };

    this.setState({
      selectedSortOption: mergedSortOption
    });
    this.props.setSortOption(mergedSortOption);
    // Save to local storage
    localStorage.setItem(
      'selectedSortOption',
      JSON.stringify(mergedSortOption)
    );
  }

  setSearchKeyword(event) {
    const value = event.target.value;

    this.setState({
      searchKeyword: value
    });
  }

  handleApply(e) {
    e.preventDefault();
    this.props.setSearchKeyword(this.state.searchKeyword);

    this.handleModalClose('filter');
  }

  render() {
    const { availableSortOptions, isAuthenticated } = this.props;

    if (isAuthenticated === false) {
      return '';
    }

    const { selectedSortOption, searchKeyword } = this.state;

    const { hideInactive } = selectedSortOption;

    const sortingOptionWrappers = availableSortOptions.map((option, index) => {
      return (
        <div className='col-xs-12 col-sm-6' key={'sort-option-' + index}>
          <Button
            variant={
              option.sortBy === selectedSortOption.sortBy &&
              option.sortByDesc === selectedSortOption.sortByDesc
                ? 'primary'
                : 'secondary'
            }
            size='sm'
            className='btn-block mb-1'
            onClick={() => this.setSortOption(option)}>
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
            hideInactive ? 'has-search-keyword' : ''
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
                    <Form.Group
                      controlId='field-hide-inactive-enabled'
                      className='mb-2'>
                      <Form.Check size='sm'>
                        <Form.Check.Input
                          type='checkbox'
                          data-state-key='hide-inactive.enabled'
                          checked={hideInactive ? 1 : 0}
                          onChange={this.setHideOption}
                        />
                        <Form.Check.Label>
                          Hide temporarily disabled symbols{' '}
                          <OverlayTrigger
                            trigger='click'
                            key='hide-inactive.enabled'
                            placement='bottom'
                            overlay={
                              <Popover id='hide-inactive.enabled-right'>
                                <Popover.Content>
                                  If enabled, the dashboard won't show coins for
                                  which buy and sell tradings are both
                                  temporarily disabled, but are still been
                                  monitored.
                                </Popover.Content>
                              </Popover>
                            }>
                            <Button
                              variant='link'
                              className='p-0 m-0 ml-1 text-info'>
                              <i className='fas fa-question-circle fa-sm'></i>
                            </Button>
                          </OverlayTrigger>
                        </Form.Check.Label>
                      </Form.Check>
                    </Form.Group>
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
