/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconMaxPurchaseAmount extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      maxPurchaseAmounts: {}
    };

    this.handleInputChange = this.handleInputChange.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      _.isEmpty(nextProps.maxPurchaseAmounts) === false &&
      _.isEqual(nextProps.maxPurchaseAmounts, this.state.maxPurchaseAmounts) ===
        false
    ) {
      const { maxPurchaseAmounts } = nextProps;

      this.setState({
        maxPurchaseAmounts
      });
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

    const { maxPurchaseAmounts } = this.state;

    const newMaxPurchaseAmounts = _.set(maxPurchaseAmounts, stateKey, value);
    this.setState({
      maxPurchaseAmounts: newMaxPurchaseAmounts
    });

    this.props.handleMaxPurchaeAmountChange(maxPurchaseAmounts);
  }

  render() {
    const { quoteAssets } = this.props;
    const { maxPurchaseAmounts } = this.state;

    if (_.isEmpty(maxPurchaseAmounts)) {
      return '';
    }

    return quoteAssets.map((quoteAsset, index) => {
      return (
        <div
          key={'quote-asset-' + quoteAsset + '-' + index}
          className='coin-info-max-purchase-amount-wrapper'>
          <Form.Group
            controlId={'field-max-limit-percentage-' + quoteAsset}
            className='mb-2'>
            <Form.Label className='mb-0'>
              Max purchase amount for {quoteAsset}{' '}
              <OverlayTrigger
                trigger='click'
                key={'max-purchase-amount-overlay-' + quoteAsset}
                placement='bottom'
                overlay={
                  <Popover
                    id={'max-purchase-amount-overlay-right' + quoteAsset}>
                    <Popover.Content>
                      Set max purchase amount for symbols with quote asset "
                      {quoteAsset}". The max purchase amount will be applied to
                      the symbols which ends with "{quoteAsset}" if not
                      configured the symbol configuration.
                    </Popover.Content>
                  </Popover>
                }>
                <Button variant='link' className='p-0 m-0 ml-1 text-info'>
                  <i className='fa fa-question-circle'></i>
                </Button>
              </OverlayTrigger>
            </Form.Label>
            <Form.Control
              size='sm'
              type='number'
              placeholder={'Enter max purchase amount for ' + quoteAsset}
              required
              min='0'
              step='0.0001'
              data-state-key={quoteAsset}
              value={maxPurchaseAmounts[quoteAsset]}
              onChange={this.handleInputChange}
            />
          </Form.Group>
        </div>
      );
    });
  }
}
