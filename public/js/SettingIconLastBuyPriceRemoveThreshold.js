/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconLastBuyPriceRemoveThreshold extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      lastBuyPriceRemoveThresholds: {}
    };

    this.handleInputChange = this.handleInputChange.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      _.isEmpty(nextProps.lastBuyPriceRemoveThresholds) === false &&
      _.isEqual(nextProps.lastBuyPriceRemoveThresholds, this.state.lastBuyPriceRemoveThresholds) ===
      false
    ) {
      const { lastBuyPriceRemoveThresholds } = nextProps;
      this.setState({
        lastBuyPriceRemoveThresholds
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

    const { lastBuyPriceRemoveThresholds } = this.state;

    const newLastBuyPriceRemoveThresholds = _.set(lastBuyPriceRemoveThresholds, stateKey, value);
    this.setState({
      lastBuyPriceRemoveThresholds: newLastBuyPriceRemoveThresholds
    });

    this.props.handleLastBuyPriceRemoveThresholdChange(lastBuyPriceRemoveThresholds);
  }

  render() {
    const { quoteAssets, jsonStrings } = this.props;
    const { lastBuyPriceRemoveThresholds } = this.state;

    if (_.isEmpty(lastBuyPriceRemoveThresholds) || _.isEmpty(jsonStrings)) {
      return '';
    }

    const { settingIcon, commonStrings } = jsonStrings;

    return quoteAssets.map((quoteAsset, index) => {
      return (
        <div
          key={'quote-asset-' + quoteAsset + '-' + index}
          className='coin-info-last-buy-remove-threshold-wrapper'>
          <Form.Group
            controlId={'field-min-last-buy-remove-threshold-limit-percentage-' + quoteAsset}
            className='mb-2'>
            <Form.Label className='mb-0'>
              {commonStrings.last_buy_price_remove_threshold}{' '}
              <OverlayTrigger
                trigger='click'
                key={'last-buy-remove-threshold-overlay-' + quoteAsset}
                placement='bottom'
                overlay={
                  <Popover
                    id={'last-buy-remove-threshold-overlay-right' + quoteAsset}>
                    <Popover.Content>
                      {settingIcon.last_buy_price_remove_threshold_description[1]} "
                      {quoteAsset}".

                      {settingIcon.last_buy_price_remove_threshold_description[2]}
                    </Popover.Content>
                  </Popover>
                }>
                <Button variant='link' className='p-0 m-0 ml-1 text-info'>
                  <i className='fa fa-question-circle'></i>
                </Button>
              </OverlayTrigger>
            </Form.Label>
            <Form.Label htmlFor='field-min-last-buy-remove-threshold-limit-percentage' srOnly>
              {commonStrings.quantity}
            </Form.Label>
            <InputGroup size='sm'>
              <FormControl
                size='sm'
                type='number'
                placeholder={settingIcon.placeholder_last_buy_remove_price_threshold}
                required
                min='0.0001'
                step='0.0001'
                data-state-key={quoteAsset}
                value={lastBuyPriceRemoveThresholds[quoteAsset]}
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
