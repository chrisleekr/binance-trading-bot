/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class HightlightChange extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      changed: false
    };
  }

  componentWillReceiveProps(newProps) {
    if (_.isEqual(this.props.children, newProps.children) === false) {
      this.setState({
        changed: true
      });
    }
  }

  render() {
    if (this.state.changed) {
      setTimeout(() => this.setState({ changed: false }), 1000);
    }

    return (
      <span
        title={this.props.title}
        className={`${this.props.className} ${
          this.state.changed ? 'blink' : ''
        }`}>
        {this.props.children}
      </span>
    );
  }
}
