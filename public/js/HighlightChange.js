/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class HightlightChange extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      changed: false,
      children: null
    };
  }

  componentWillUnmount() {
    if (this.timerID) {
      clearTimeout(this.timerID);
      this.timerID = null;
    }
  }

  static getDerivedStateFromProps(newProps, state) {
    if (_.isEqual(state.children, newProps.children) === false) {
      return {
        changed: true,
        children: newProps.children
      };
    }
    return null;
  }

  render() {
    if (this.state.changed) {
      this.timerID = setTimeout(() => {
        if (this.timerID) {
          this.setState({ changed: false });
          this.timerID = null;
        }
      }, 500);
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
