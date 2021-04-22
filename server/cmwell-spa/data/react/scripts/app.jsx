define((require, exports, module) => {

let Components = module.config().components
    
let { Router, Route, Link, browserHistory } = ReactRouter
let { Header, Types, SearchBar, Breadcrumbs, HomePage, InfotonsList, Infoton, Footer } = Components

class App extends React.Component {
    constructor(props) {
        super(props)
        this.state = {
            currentHasChildren: true
        }
        
        browserHistory.push(new URLSearchParams(location.search).get('path') || '/')
    }
    
    componentDidMount() {
        $('#content').show()
        $('.spinner-container, #loading-status').fadeOut(250)
        
        // fetching common meta-data
        AppUtils.fetchDisplayNames(data => this.setState({ displayNames: data }))
        AppUtils.cachedGet('/?op=stream').then(paths => this.setState({ rootFolders: paths.split`\n` }))
    }
    
    render() {
        AppUtils.debug('App.render')

        return (
            <div id="app-container">
                
                <Header/>
                
                <SearchBar
                    currentHasChildren={this.state.currentHasChildren}
                    rootFolders={this.state.rootFolders}
                />
                
                <Breadcrumbs
                    lastBreadcrumbDisplayName={this.state.lastBreadcrumbDisplayName}
                    parts={this.state.overrideBcParts}
                />
                
                { this.state.currentHasChildren ? <Types location={this.props.location} /> : null }
                
                <InfotonsList
                    location={this.props.location}
                    isRoot={true}
                    hasChildrenCb={hasChildren => this.setState({ currentHasChildren: hasChildren })}
                    displayNames={this.state.displayNames}
                    updateBreadcrumbsParts={parts => parts!=this.state.overrideBcParts && this.setState({ overrideBcParts: parts })}
                    infotonIsEmpty={this.state.infotonIsEmpty}
                />
                
                <Infoton
                    location={this.props.location}
                    rootFolders={this.state.rootFolders}
                    displayNames={this.state.displayNames}
                    displayNameUpdateCb={dn => dn && this.state.lastBreadcrumbDisplayName!=dn && this.setState({ lastBreadcrumbDisplayName: dn })}
                    updateBreadcrumbsParts={parts => this.setState(prev => parts!=prev.overrideBcParts && { overrideBcParts: parts })}
                    isEmptyCb={isEmpty => this.state.infotonIsEmpty!=isEmpty && this.setState({ infotonIsEmpty: isEmpty })}
                />
                
                <Footer/>
                
            </div>
        )
    }
}

ReactDOM.render((
  <Router history={browserHistory}>
    <Route path="*" component={App}/>
  </Router>
), document.getElementById('content'))

})
