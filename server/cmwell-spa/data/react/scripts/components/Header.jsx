var { Link, browserHistory } = ReactRouter

class Header extends React.Component {
    constructor(props) {
        super(props)
        this.state = { versionName: '' }
    }

    componentWillMount() {
        $.get('/proc/node?format=json').then(procNode => {
            let data = AppUtils.simpleFieldsProxy(procNode)
            this.setState({
                versionName: data['cm-well_version'],
                releaseName: data['cm-well_release'],
                versionInfo: `Build Release: ${data['cm-well_release']}\n`+
                             `Build Version: ${data['cm-well_version']}\n`+ 
                             `Build Machine: ${data['build_machine']}\n`+
                             `Build Time: ${data['build_time']}`
            })
        })
    }
    
    handleOldUiClick(e) {
        if(e.shiftKey) localStorage.setItem('old-ui', 1)
        return true
    }
    
    render() {
        AppUtils.debug('Header.render')
        
        return (
            <div id="header" className="panel">
                <Link to="/"><img className="logo" src="/meta/app/react/images/logo-flat-inverted.svg"/></Link>
                <span className="version-info">{this.state.releaseName}</span>
                <a href={`${location.pathname}?old-ui`} className="old-ui-link" onClick={this.handleOldUiClick.bind(this)}>Use old UI</a>
                <a target="_blank" href="https://cm-well.github.io/CM-Well/" className="help-link"><img src="/meta/app/react/images/help-icon.svg"/>HELP</a>
            </div>
        )
    }
}

class SearchBar extends React.Component {
    constructor(props) {
        super(props)
        this.state = {
            term: '',
            path: location.pathname
        }
    }
    
    componentWillReceiveProps() {
        this.setState({path: location.pathname})
    }

    basicSearch(e) {
        e.preventDefault()
        browserHistory.push(`${this.state.path}?op=search&recursive&qp=_all:${this.state.term}`)
        return false
    }
    
    render() {
        AppUtils.debug('SearchBar.render')
        
        let currentPath = this.props.currentHasChildren && location.pathname

        return (
            <div className="search-bar panel">
                <div className="container">
                    <form className="search-form">
                        <input type="text" className="search-box" placeholder="Search" onChange={e=>this.setState({term:e.target.value})}/>
                        <select className="search-where-dropdown" onChange={e=>this.setState({path:e.target.value})} value={this.state.path}>
                            <option value="" key="/">Search all folders</option>
                            { currentPath ? <option selected value={currentPath} key={currentPath}>{currentPath.substr(1)}</option> : null }
                            {(this.props.rootFolders||[]).filter(rf => rf && rf!=currentPath).map(rf => <option value={rf} key={rf}>{rf.substr(1)}</option>)}
                        </select>
                        <button type="submit" className="search-button" onClick={this.basicSearch.bind(this)}>SEARCH</button>
                    </form>
                </div>
            </div>
        )
    }
}

class Breadcrumbs extends React.Component {
    constructor(props) {
        super(props)
    }
    
    render() {
        AppUtils.debug('Breadcrumbs.render')

        let parts = this.props.parts || (location.pathname === '/' ? [] : location.pathname.substr(1).split('/'))
        
        let qp = /[\?|&]qp=(.*)/.exec(location.search) || ''
        if(qp) qp=(qp[1]||'').replace(/_all:/, '') // todo in future when Advanced Search is implemented, replace _all with "All fields", not an empty string. Moreover, split`:` etc.
        
        let acc = '', breadcrumbs = []
        for(var part of parts) {
            acc = `${acc}/${part}`
            breadcrumbs.push({ title: part.replace('%23','#').replace('%25','%'), href: acc })
        }

        if(this.props.lastBreadcrumbDisplayName && breadcrumbs.length)
            _(breadcrumbs).last().title = this.props.lastBreadcrumbDisplayName
        
        if(qp) {
            var displayedQp = `"${qp}"`

            // type.rdf deserves a special treatment:
            if(qp.indexOf('type.rdf')===0)
                try { displayedQp = `type ${AppUtils.lastPartOfUriPath(qp.replace('%23','#').replace('%25','%').split('::')[1])}` } catch(e) { }
                
            breadcrumbs.push({ title: `Search results for ${displayedQp}`, searchIcon: true })
        }

        if(location.pathname.length > AppUtils.constants.breadcrumbs.maxPathLength && breadcrumbs.length > AppUtils.constants.breadcrumbs.maxItems)
            breadcrumbs = [..._(breadcrumbs).first(2), { title: '...' }, ..._(breadcrumbs).last(2)]
        
        let sep = <img src='/meta/app/react/images/gt.svg' width="24" height="24" />
        let rootLevelIcon = <img src='/meta/app/react/images/folder-box.svg' width="24" height="24" />
        let otherLevelsIcon = <img src='/meta/app/react/images/infoton-icon.svg' width="24" height="24" />
        let searchIcon = <img className="search-icon" src='/meta/app/react/images/search-icon.svg' width="24" height="24" />
            
        return <div className="breadcrumbs">
                    <Link className="breadcrumb" to="/"><img width="24" height="24" src="/meta/app/react/images/home-button.svg"/></Link>
                    { breadcrumbs.length ? sep : null }
                    { AppUtils.addSep(breadcrumbs.map((bc,i) => bc.href ?
                            <Link className="breadcrumb" to={bc.href}>{ i ? otherLevelsIcon : rootLevelIcon }{bc.title}</Link> :
                            <span className="breadcrumb">{bc.searchIcon ? searchIcon : null}{bc.title}</span>
                        ), sep) }
                </div>
    }
}

let exports = { Header, SearchBar, Breadcrumbs }
define([], () => exports)