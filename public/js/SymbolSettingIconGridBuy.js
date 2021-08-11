/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolSettingIconGridBuy extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      gridTrade: [],
      validation: []
    };

    this.handleInputChange = this.handleInputChange.bind(this);

    this.onAddGridTrade = this.onAddGridTrade.bind(this);
    this.onRemoveGridTrade = this.onRemoveGridTrade.bind(this);
    this.validateGridTrade = this.validateGridTrade.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      _.isEmpty(nextProps.gridTrade) === false &&
      _.isEqual(nextProps.gridTrade, this.state.gridTrade) === false
    ) {
      const { gridTrade } = nextProps;

      this.setState({
        gridTrade
      });
      this.validateGridTrade(gridTrade);
    }
  }

  handleInputChange(event) {
    const target = event.target;
    const value =
      target.type === 'checkbox'
        ? target.checked
        : target.type === 'number'
        ? +target.value
        : target.value;
    const stateKey = target.getAttribute('data-state-key');

    const { gridTrade } = this.state;

    const newGridTrade = _.set(gridTrade, stateKey, value);

    this.setState({
      gridTrade: newGridTrade
    });
    this.validateGridTrade(newGridTrade);

    this.props.handleGridTradeChange('buy', newGridTrade);
  }

  onAddGridTrade(_event) {
    const { minNotional } = this.props;
    const { gridTrade } = this.state;
    const lastGridTrade = _.cloneDeep(_.last(gridTrade));
    let newGridTrade;
    if (lastGridTrade) {
      lastGridTrade.executed = false;
      lastGridTrade.executedOrder = null;

      // If the grid trade has existing grid data, then use the last row to create new grid trade.
      newGridTrade = _.concat(gridTrade, lastGridTrade);
    } else {
      newGridTrade = _.concat(gridTrade, {
        triggerPercentage: gridTrade.length === 0 ? 1 : 0.8,
        stopPercentage: 1.03,
        limitPercentage: 1.031,
        maxPurchaseAmount: minNotional
      });
    }

    this.setState({
      gridTrade: newGridTrade
    });

    this.validateGridTrade(newGridTrade);
    this.props.handleGridTradeChange('buy', newGridTrade);
  }

  onRemoveGridTrade(index) {
    const { gridTrade } = this.state;

    _.pullAt(gridTrade, index);

    this.setState({
      gridTrade
    });
    this.validateGridTrade(gridTrade);
    this.props.handleGridTradeChange('buy', gridTrade);
  }

  /**
   * Validate grid trade for buying
   *
   *  - Only 1st trigger percentage can be above or equal to 1.
   *  - The stop price percentage cannot be higher than the stop price percentage.
   *  - Buy amount cannot be less than the minimum notional value.
   */
  validateGridTrade(gridTrade) {
    const { minNotional, quoteAsset } = this.props;

    const validation = [];

    let isValid = true;

    gridTrade.forEach((grid, index) => {
      const v = {
        messages: [],
        triggerPercentage: true,
        stopPercentage: true,
        limitPercentage: true,
        maxPurchaseAmount: true
      };

      const humanisedIndex = index + 1;

      if (index === 0 && grid.triggerPercentage < 1) {
        // If it is the first grid trade and the trigger percentage is less than 1,
        isValid = false;
        v.triggerPercentage = false;
        v.messages.push(
          `The trigger percentage for Grid #${humanisedIndex} cannot be less than 1.`
        );
      } else if (index !== 0 && grid.triggerPercentage >= 1) {
        // If it is not the first grid trade and the trigger percentage is more than 1,
        isValid = false;
        v.triggerPercentage = false;
        v.messages.push(
          `The trigger percentage for Grid #${humanisedIndex} cannot be equal or above 1.`
        );
      }

      // If the stop price percentage cannot be higher than the stop price percentage.
      if (grid.stopPercentage >= grid.limitPercentage) {
        isValid = false;
        v.limitPercentage = false;
        v.messages.push(
          `The stop price percentage cannot be equal or over the limit percentage.`
        );
      }

      // If the max purchase amount is less than the minimum notional value,
      if (parseFloat(grid.maxPurchaseAmount) < parseFloat(minNotional)) {
        isValid = false;
        v.maxPurchaseAmount = false;
        v.messages.push(
          `The max purchase amount for ${quoteAsset} cannot be less than the minimum notional value ${minNotional}.`
        );
      }

      validation.push(v);
    });

    this.setState({
      validation
    });
    this.props.handleSetValidation('gridBuy', isValid);
  }

  render() {
    const { quoteAsset } = this.props;
    const { gridTrade, validation } = this.state;

    const gridRows = gridTrade.map((grid, i) => {
      const validationText = _.get(validation, `${i}.messages`, []).reduce(
        (acc, message, k) => [
          ...acc,
          <div
            key={'error-message-' + i + '-' + k}
            className='field-error-message text-danger'>
            <i className='fas fa-exclamation-circle mx-1'></i>
            {message}
          </div>
        ],
        []
      );

      return (
        <React.Fragment key={'grid-row-buy-' + i}>
          <tr>
            <td className='align-middle font-weight-bold' width='90%'>
              Grid Trade #{i + 1}
            </td>
            <td className='align-middle text-center'>
              {i !== 0 && grid.executed !== true ? (
                <button
                  type='button'
                  className='btn btn-sm btn-link p-0'
                  onClick={() => this.onRemoveGridTrade(i)}>
                  <i className='fas fa-times-circle text-danger'></i>
                </button>
              ) : (
                ''
              )}
            </td>
          </tr>
          <tr>
            <td colSpan='2'>
              <div className='row'>
                <div className='col-xs-12 col-sm-6'>
                  <Form.Group
                    controlId={'field-grid-buy-' + i + '-trigger-percentage'}
                    className='mb-2'>
                    <Form.Label className='mb-0'>
                      Trigger percentage{' '}
                      <strong>
                        {i === 0
                          ? `based on the lowest price`
                          : `based on the last buy price`}
                      </strong>{' '}
                      <OverlayTrigger
                        trigger='click'
                        key={
                          'field-grid-buy-' + i + '-trigger-percentage-overlay'
                        }
                        placement='bottom'
                        overlay={
                          <Popover
                            id={
                              'field-grid-buy-' +
                              i +
                              '-trigger-percentage-overlay-right'
                            }>
                            <Popover.Content>
                              {i === 0 ? (
                                <React.Fragment>
                                  Set the trigger percentage for buying based on
                                  the lowest price. i.e. if set{' '}
                                  <code>1.01</code> and the lowest price is{' '}
                                  <code>$100</code>, then the bot will buy the
                                  coin when the current price reaches{' '}
                                  <code>$101</code>. You cannot set less than 1,
                                  because it will never reach the trigger price
                                  unless there is a deep decline before the next
                                  process.
                                </React.Fragment>
                              ) : (
                                <React.Fragment>
                                  Set the trigger percentage for buying based on
                                  the last buy price. i.e. if set{' '}
                                  <code>0.8</code> and the last buy price is{' '}
                                  <code>$100</code>, then the bot will buy the
                                  coin when the current price reaches{' '}
                                  <code>$80</code>. You cannot set higher than
                                  1.
                                </React.Fragment>
                              )}
                            </Popover.Content>
                          </Popover>
                        }>
                        <Button
                          variant='link'
                          className='p-0 m-0 ml-1 text-info'>
                          <i className='fas fa-question-circle fa-sm'></i>
                        </Button>
                      </OverlayTrigger>
                    </Form.Label>
                    <Form.Control
                      size='sm'
                      type='number'
                      placeholder='Enter trigger percentage'
                      required
                      min={i === 0 ? '1' : '0'}
                      max={i === 0 ? '1.9999' : '0.9999'}
                      step='0.0001'
                      isInvalid={
                        _.get(validation, `${i}.triggerPercentage`, true) ===
                        false
                      }
                      disabled={grid.executed}
                      data-state-key={`${i}.triggerPercentage`}
                      value={grid.triggerPercentage}
                      onChange={this.handleInputChange}
                    />
                  </Form.Group>
                </div>
                <div className='col-xs-12 col-sm-6'>
                  <Form.Group
                    controlId={'field-grid-buy-' + i + '-stop-percentage'}
                    className='mb-2'>
                    <Form.Label className='mb-0'>
                      Stop price percentage{' '}
                      <OverlayTrigger
                        trigger='click'
                        key={
                          'field-grid-buy-' +
                          i +
                          '-stop-price-percentage-overlay'
                        }
                        placement='bottom'
                        overlay={
                          <Popover
                            id={
                              'field-grid-buy-' +
                              i +
                              '-stop-price-percentage-overlay-right'
                            }>
                            <Popover.Content>
                              Set the percentage to calculate stop price. i.e.
                              if set <code>1.01</code> and current price{' '}
                              <code>$100</code>, stop price will be{' '}
                              <code>$101</code> for stop limit order.
                            </Popover.Content>
                          </Popover>
                        }>
                        <Button
                          variant='link'
                          className='p-0 m-0 ml-1 text-info'>
                          <i className='fas fa-question-circle fa-sm'></i>
                        </Button>
                      </OverlayTrigger>
                    </Form.Label>
                    <Form.Control
                      size='sm'
                      type='number'
                      placeholder='Enter stop price percentage'
                      required
                      min='0'
                      step='0.0001'
                      isInvalid={
                        _.get(validation, `${i}.stopPercentage`, true) === false
                      }
                      disabled={grid.executed}
                      data-state-key={`${i}.stopPercentage`}
                      value={grid.stopPercentage}
                      onChange={this.handleInputChange}
                    />
                  </Form.Group>
                </div>
                <div className='col-xs-12 col-sm-6'>
                  <Form.Group
                    controlId={'field-grid-buy-' + i + '-limit-percentage'}
                    className='mb-2'>
                    <Form.Label className='mb-0'>
                      Limit price percentage{' '}
                      <OverlayTrigger
                        trigger='click'
                        key={
                          'field-grid-buy-' + i + '-limit-percentage-overlay'
                        }
                        placement='bottom'
                        overlay={
                          <Popover
                            id={
                              'field-grid-buy-' +
                              i +
                              '-limit-percentage-overlay-right'
                            }>
                            <Popover.Content>
                              Set the percentage to calculate limit price. i.e.
                              if set <code>1.011</code> and current price{' '}
                              <code>$100</code>, limit price will be{' '}
                              <code>$101.10</code> for stop limit order.
                            </Popover.Content>
                          </Popover>
                        }>
                        <Button
                          variant='link'
                          className='p-0 m-0 ml-1 text-info'>
                          <i className='fas fa-question-circle fa-sm'></i>
                        </Button>
                      </OverlayTrigger>
                    </Form.Label>
                    <Form.Control
                      size='sm'
                      type='number'
                      placeholder='Enter limit price percentage'
                      required
                      min='0'
                      step='0.0001'
                      isInvalid={
                        _.get(validation, `${i}.limitPercentage`, true) ===
                        false
                      }
                      disabled={grid.executed}
                      data-state-key={`${i}.limitPercentage`}
                      value={grid.limitPercentage}
                      onChange={this.handleInputChange}
                    />
                  </Form.Group>
                </div>
                <div className='col-xs-12 col-sm-6'>
                  <Form.Group
                    controlId={'field-grid-buy-' + i + '-max-purchase-amount'}
                    className='mb-2'>
                    <Form.Label className='mb-0'>
                      Max purchase amount{' '}
                      <OverlayTrigger
                        trigger='click'
                        key={
                          'field-grid-buy-' + i + '-max-purchase-amount-overlay'
                        }
                        placement='bottom'
                        overlay={
                          <Popover
                            id={
                              'field-grid-buy-' +
                              i +
                              '-max-purchase-amount-overlay-right'
                            }>
                            <Popover.Content>
                              Set max purchase amount for symbols with quote
                              asset "{quoteAsset}". The max purchase amount will
                              be applied to the symbols which ends with "
                              {quoteAsset}" if not configured the symbol
                              configuration.
                            </Popover.Content>
                          </Popover>
                        }>
                        <Button
                          variant='link'
                          className='p-0 m-0 ml-1 text-info'>
                          <i className='fas fa-question-circle fa-sm'></i>
                        </Button>
                      </OverlayTrigger>
                    </Form.Label>
                    <Form.Control
                      size='sm'
                      type='number'
                      placeholder={'Enter max purchase amount'}
                      required
                      min='0'
                      step='0.0001'
                      isInvalid={
                        _.get(validation, `${i}.maxPurchaseAmount`, true) ===
                        false
                      }
                      disabled={grid.executed}
                      data-state-key={`${i}.maxPurchaseAmount`}
                      value={grid.maxPurchaseAmount}
                      onChange={this.handleInputChange}
                    />
                  </Form.Group>
                </div>
                {validationText !== '' ? (
                  <div className='col-12'>{validationText}</div>
                ) : (
                  ''
                )}
              </div>
            </td>
          </tr>
        </React.Fragment>
      );
    });

    return (
      <div className='coin-info-grid-trade-wrapper coin-info-grid-trade-buy-wrapper'>
        <Table striped bordered hover size='sm'>
          <tbody>{gridRows}</tbody>
        </Table>
        <div className='row'>
          <div className='col-12 text-right'>
            <button
              type='button'
              className='btn btn-sm btn-add-new-grid-trade-buy'
              onClick={this.onAddGridTrade}>
              Add new grid trade
            </button>
          </div>
        </div>
      </div>
    );
  }
}
