/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperChart extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      collapsed: false,
      symbolInfo: {},
      oldData: {}
    };

    this.toggleCollapse = this.toggleCollapse.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      this.state.collapsed === false &&
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

      if (_.isEmpty(prediction) || !prediction.predictedValues) {
        return '';
      }

      if (this.state.oldData !== prediction.predictedValues) {
        var graph = {
          labels: prediction.predictedValues,
          datasets: [
            {
              label: 'Predict',
              backgroundColor: 'rgba(55, 153, 250, 0.43)',
              color: '#cfcfcf',
              borderColor: '#00a1e0',
              data: prediction.predictedValues
            },
            {
              label: 'Real',
              backgroundColor: 'rgba(250, 250, 55, 0.43)',
              color: '#cfcfcf',
              borderColor: '#d1c975',
              data: prediction.realCandles
            }
          ]
        };
        if (
          document.getElementById('Graph' + this.props.symbolInfo.symbol) !==
          null
        ) {
          var ctx = document
            .getElementById('Graph' + this.props.symbolInfo.symbol)
            .getContext('2d');
          new Chart(ctx, {
            type: 'line',
            data: graph,
            options: {
              tooltips: {
                enabled: true
              },
              legend: {
                display: true
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

  toggleCollapse() {
    this.setState({
      collapsed: !this.state.collapsed
    });
  }

  render() {
    const { collapsed } = this.state;
    const { symbolInfo } = this.props;

    if (_.isEmpty(symbolInfo)) {
      return '';
    }
    return (
      <div className='coin-info-sub-wrapper coin-info-sub-wrapper-setting'>
        <div className='coin-info-column coin-info-column-title coin-info-column-title-setting'>
          <div className='coin-info-label'>
            <div className='mr-1'>Chart</div>
          </div>

          <button
            type='button'
            className='btn btn-sm btn-link p-0 ml-1'
            onClick={this.toggleCollapse}>
            <i
              className={`fa ${
                collapsed ? 'fa-arrow-right' : 'fa-arrow-down'
              }`}></i>
          </button>
        </div>
        <div
          className={`coin-info-content-setting ${collapsed ? 'd-none' : ''}`}>
          <div className='col-12'>
            <canvas id={'Graph' + symbolInfo.symbol}></canvas>
          </div>
        </div>
      </div>
    );
  }
}
