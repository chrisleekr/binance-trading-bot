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
    const { quoteAssets, jsonStrings } = this.props;
    const { maxPurchaseAmounts } = this.state;

    if (_.isEmpty(maxPurchaseAmounts) || _.isEmpty(jsonStrings)) {
      return '';
    }

    const { setting_icon, common_strings } = jsonStrings;

    return quoteAssets.map((quoteAsset, index) => {
      return (
        <div
          key={'quote-asset-' + quoteAsset + '-' + index}
          className='coin-info-max-purchase-amount-wrapper'>
          <Form.Group
            controlId={'field-max-purchase-amount-percentage-' + quoteAsset}
            className='mb-2'>
            <Form.Label className='mb-0'>
              {setting_icon.max_purchase_amount_for}{' '}
              <OverlayTrigger
                trigger='click'
                key={'max-purchase-amount-overlay-' + quoteAsset}
                placement='bottom'
                overlay={
                  <Popover
                    id={'max-purchase-amount-overlay-right' + quoteAsset}>
                    <Popover.Content>
                      {setting_icon.max_purchase_amount_description} {quoteAsset}
                    </Popover.Content>
                  </Popover>
                }>
                <Button variant='link' className='p-0 m-0 ml-1 text-info'>
                  <i className='fa fa-question-circle'></i>
                </Button>
              </OverlayTrigger>
            </Form.Label>
            <Form.Label htmlFor='field-min-max-purchase-amount-percentage' srOnly>
              {common_strings._quantity}
            </Form.Label>
            <InputGroup size='sm'>
              <FormControl
                size='sm'
                type='number'
                placeholder={setting_icon.placeholder_max_purchase_amount}
                required
                min='0'
                step='0.0001'
                data-state-key={quoteAsset}
                value={maxPurchaseAmounts[quoteAsset]}
                onChange={this.handleInputChange}
              />
              <InputGroup.Append>
                <InputGroup.Text>
                  {quoteAsset}
                </InputGroup.Text>
              </InputGroup.Append>
            </InputGroup>
          </Form.Group>
        </div>
      );
    });
  }
}
