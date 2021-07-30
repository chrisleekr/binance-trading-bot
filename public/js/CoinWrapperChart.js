/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperChart extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      collapsed: true,
      symbolInfo: {},
      oldData: {}
    };

    this.toggleCollapse = this.toggleCollapse.bind(this);
  }

  componentDidUpdate(nextProps) {
    if (
      _.isEmpty(nextProps.symbolInfo.buy.prediction) ||
      nextProps.symbolInfo.buy.prediction.predictedValues === undefined ||
      nextProps.symbolInfo.buy.prediction.realCandles === undefined
    ) {
      return '';
    }

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

      const minPredicted = _.min(prediction.predictedValues);
      const minReal = _.min(prediction.realCandles);
      const maxPredicted = _.max(prediction.predictedValues);
      const maxReal = _.max(prediction.realCandles);
      const labels = [];
      const pointPredictedColors = [];
      const pointRealColors = [];
      for (let index = 0; index < prediction.predictedValues.length; index++) {
        labels.push('Prediction Nº' + (index + 1));

        if (prediction.predictedValues[index] === minPredicted) {
          pointPredictedColors.push('red');
        } else if (prediction.predictedValues[index] === maxPredicted) {
          pointPredictedColors.push('#04d820');
        } else {
          pointPredictedColors.push('#00a1e0');
        }

        if (prediction.realCandles[index] === minReal) {
          pointRealColors.push('red');
        } else if (prediction.realCandles[index] === maxReal) {
          pointRealColors.push('#04d820');
        } else {
          pointRealColors.push('#d1c975');
        }
      }

      if (this.state.oldData !== prediction.predictedValues) {
        var graph = {
          labels,
          datasets: [
            {
              label: 'Predict',
              backgroundColor: 'rgba(55, 153, 250, 0.35)',
              pointBackgroundColor: pointPredictedColors,
              color: '#cfcfcf',
              borderColor: '#00a1e0',
              data: prediction.predictedValues
            },
            {
              label: 'Real',
              backgroundColor: 'rgba(250, 250, 55, 0.35)',
              pointBackgroundColor: pointRealColors,
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
              ticks: {
                min: 0,
                max: 3.05,
                stepSize: 1,
                suggestedMin: 0,
                suggestedMax: 3.05
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
                    display: true
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
          <canvas className='graph' id={'Graph' + symbolInfo.symbol}></canvas>
        </div>
      </div>
    );
  }
}
