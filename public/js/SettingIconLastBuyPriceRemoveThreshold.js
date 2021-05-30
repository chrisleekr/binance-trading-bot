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
        console.log('lastBuyPriceRemoveThreshold has changed', { lastBuyPriceRemoveThresholds });
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

    console.log(
      '_.set(lastBuyPriceRemoveThresholds, stateKey, value) => ',
        _.set(lastBuyPriceRemoveThresholds, stateKey, value)
    );

      const newLastBuyPriceRemoveThreshold = _.set(lastBuyPriceRemoveThresholds, stateKey, value);
    this.setState({
        lastBuyPriceRemoveThresholds: newLastBuyPriceRemoveThreshold
    });

      this.props.handleLastBuyPriceRemoveThresholdChange(lastBuyPriceRemoveThresholds);
  }

  render() {
    const { quoteAssets } = this.props;
    const { lastBuyPriceRemoveThresholds } = this.state;

    if (_.isEmpty(lastBuyPriceRemoveThresholds)) {
      return '';
    }

    return quoteAssets.map((quoteAsset, index) => {
      return (
        <div
          key={quoteAsset + '-' + index}
          className='coin-info-last-buy-threshold-wrapper'>
          <Form.Group
            controlId={'field-min-last-buy-limit-percentage-' + quoteAsset}
            className='mb-2'>
            <Form.Label className='mb-0'>
              Last Buy Threshold for {quoteAsset}{' '}
              <OverlayTrigger
                trigger='click'
                key={'last-buy-threshold-overlay-' + quoteAsset}
                placement='bottom'
                overlay={
                  <Popover
                    id={'last-buy-threshold-overlay-right' + quoteAsset}>
                    <Popover.Content>
                      Set the last buy threshold for symbols with quote asset "
                      {quoteAsset}". The last buy threshold will be applied to
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
              placeholder={'Enter last buy threshold for ' + quoteAsset}
              required
              min='1'
              step='0.0001'
              data-state-key={quoteAsset}
              value={lastBuyPriceRemoveThresholds[quoteAsset]}
              onChange={this.handleInputChange}
            />
          </Form.Group>
        </div>
      );
    });
  }
}
