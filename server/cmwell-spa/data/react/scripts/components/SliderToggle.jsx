class SliderToggle extends React.Component {
    constructor(props) {
        super(props)
        
        this.storageKey = `SliderToggle$${this.props.id}`
        
        let persistedValue = localStorage.getBoolean(this.storageKey)
        
        if(persistedValue && this.props.callback)
            this.props.callback(true)

        this.state = {
            right: persistedValue
        }
    }

    handleClick() {
        let newState = !this.state.right
        this.setState({ right: newState })
        localStorage.setBoolean(this.storageKey, newState)
        if(this.props.callback)
            this.props.callback(newState)
    }
    
    render() {
        AppUtils.debug('SliderToggle.render')
        
        let handleClassName = `slider-toggle handle${this.state.right?' right':''}`
        return <span className="slider-toggle box" onClick={this.handleClick.bind(this)}>
            <span className={handleClassName}>
                <img src="/meta/app/react/images/slider-toggle-handle.svg"/>
            </span>
        </span>
    }
}

define([], () => SliderToggle)