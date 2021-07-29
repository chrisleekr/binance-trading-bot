/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperChart extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false,
      symbolInfo: {},
      oldData: {}
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      this.state.showModal === true &&
      _.isEmpty(nextProps.symbolInfo) === false &&
      _.isEqual(nextProps.symbolInfo, this.state.symbolInfo) === false &&
      _.isEqual(
        nextProps.symbolInfo.buy.prediction.predictedValues,
        this.state.oldData
      ) === false
    ) {
      const {
        buy: { prediction }
      } = nextProps.symbolInfo;

      if (prediction === undefined) {
        return '';
      }

      console.log(this.state.oldData);
      if (this.state.oldData !== prediction.predictedValues) {
        var graph = {
          labels: prediction.predictedValues, // 12
          datasets: [
            {
              label: 'Dados primários',
              fillColor: '#00a1e0',
              strokeColor: '#00a1e0',
              pointColor: '#d1c975',
              pointStrokeColor: '#d1c975',
              pointHighlightFill: '#d1c975',
              pointHighlightStroke: '#4d90fe',
              data: prediction.predictedValues // 12
            }
          ]
        };
        if (document.getElementById('Graph') !== null) {
          var ctx = document.getElementById('Graph').getContext('2d');
          new Chart(ctx, {
            type: 'line',
            data: graph,
            options: {
              tooltips: {
                enabled: false
              },
              legend: {
                display: false
              },
              pointDot: false,
              scales: {
                xAxes: [
                  {
                    display: false
                  }
                ],
                yAxes: [
                  {
                    display: false
                  }
                ]
              }
            }
          });
        }
      }

      this.setState({
        symbolInfo: nextProps.symbolInfo,
        oldData: prediction.predictedValues
      });
    }
  }

  handleModalShow() {
    this.setState({
      showModal: true
    });
  }

  handleModalClose() {
    this.setState({
      showModal: false
    });
  }

  render() {
    const {
      symbolInfo,
      jsonStrings: { coin_wrapper, common_strings }
    } = this.props;

    return (
      <div className='chart-icon-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0'
          onClick={this.handleModalShow}>
          <i className='fa fa-edit'></i>
        </button>
        <Modal show={this.state.showModal} onHide={this.handleModalClose}>
          <Form onSubmit={this.handleFormSubmit}>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>Chart of {symbolInfo.symbol}TR</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <canvas className='graph' id='Graph'></canvas>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant='secondary'
                size='sm'
                onClick={this.handleModalClose}>
                CloseTR
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>
      </div>
    );
  }
}
