let { Link } = ReactRouter

class Type extends React.Component {
    constructor(props) {
        super(props)
        
        this.state = { }
    }

    render() {
        AppUtils.debug('Type.render')
        let href = this.props.uri ? `${location.pathname}?op=search&recursive&qp=type.rdf::${this.props.uri.replace('%','%25').replace('#','%23')}` : location.pathname
        let count = this.props.count ? ` (${this.props.count.toLocaleString()})` : ''
        let label = (this.props.label || AppUtils.lastPartOfUriPath(this.props.uri)) + count
        let isSelected = location.pathname + location.search === href
        return <span className="type" title={this.props.uri}>{ isSelected ? label : <Link to={href}>{label}</Link> }</span>
    }
}

class ExpandButton extends React.Component {
    constructor(props) {
        super(props)
        
        this.state = { }
    }

    clickCb() {
        this.props.clickCb && this.props.clickCb()
    }
    
    render() {
        let className = 'expand-button' + (this.props.isExpanded ? ' expanded' : '')
        return <img className={className} width="25" height="25" src="/meta/app/react/images/blue-down-arrow.svg" onClick={this.clickCb.bind(this)} />
    }
}

class Types extends React.Component {
    constructor(props) {
        super(props)
        
        this.state = { types: [] }
        this.separator = <span className="separator">|</span>
            
        this.fetchDataAndResetState()
    }
        
    componentWillReceiveProps() {
        this.fetchDataAndResetState()
    }
    
    // fetchDataAndResetState is invoked both from componentWillReceiveProps and CTOR to address all senarios of navigation 
    fetchDataAndResetState(full = false) {
        let size = full ? 1024 : 10
        AppUtils.cachedGet(`${this.props.location.pathname}?op=aggregate&recursive&ap=type:term,field::type.rdf,size:${size}&format=json`).then(resp => {
            resp.AggregationResponse && this.setState({ types: resp.AggregationResponse[0].buckets.map(bckt => { return { uri: bckt.key, count: bckt.objects } }) })
        })
        
        if(!full)
            this.setState({ expanded: false })
    }
    
    handleExpandClick() {
        this.toggleState('expanded')
        this.fetchDataAndResetState(true)
    }

    render() {
        AppUtils.debug('Types.render')
        let className = `types-container ${this.state.expanded ? 'expanded' : ''}`
        let types = [{ label: "All" }, ...this.state.types].map(t => <Type label={t.label} uri={t.uri} count={t.count} />)
                                                       
        let isExpandButtonNeeded = this.state.types.length > 5 // todo is hard-coding 5 the best we can do here?

        return <div className={className}>
            <div className="types">View by: { AppUtils.addSep(types, this.separator) }</div>
           { isExpandButtonNeeded ? <ExpandButton isExpanded={this.state.expanded} clickCb={this.handleExpandClick.bind(this)}/> : null }
        </div>
    }
}

define([], () => Types)
