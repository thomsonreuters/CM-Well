let { SliderToggle, SystemFields, ActionsBar, ErrorMsg, LoadingSpinner } = CommonComponents
let { Link } = ReactRouter
let DInfoton = Domain.Infoton

class FavStar extends React.Component {
    constructor(props) {
        super(props)

        this.storageKey = `FavStar$${this.props.fieldName}`
        
        this.state = {
            selected: this.props.selected || localStorage.getBoolean(this.storageKey)
        }
    }
    
    handleClick() {
        let newValue = !this.state.selected
        this.setState({ selected: newValue })
        localStorage.setBoolean(this.storageKey, newValue)
        if(this.props.callback)
            this.props.callback(this.props.fieldName)
    }
    
    componentWillReceiveProps(newProps) {
        this.setState({ selected: newProps.selected })
    }
    
    render() {
        let className = `fav-star${this.state.selected ? '' : ' greyed-out'}`
        return <img className={className} src="/meta/app/react/images/fav-star.svg" onClick={this.handleClick.bind(this)} />
    }
}

class FileInfoton extends React.Component {
    render() {
        AppUtils.debug('FileInfoton.render')
        
        // todo do we want to use a Proxy to access content fields, something like   prop => this.system[`${prop}.content`]   ???
        let sysFields = this.props.infoton.system
        let textualData = sysFields['data.content']
        let binaryData = sysFields['base64-data.content']
        
        let mkDataUrlString = (payload,enc) => `data:${sysFields['mimeType.content']}${enc?';base64':''},${payload}`
        let downloadUrl = textualData ? mkDataUrlString(textualData) : (binaryData ? mkDataUrlString(binaryData, true) : sysFields.path)
        
        return <div className="file-infoton-content">
            <a href={downloadUrl} download={AppUtils.lastPartOfUrl(sysFields.path)}><img src="/meta/app/react/images/download.svg"/>Download</a><br/>
            { textualData ? <textarea value={textualData}></textarea> : null }
            </div>
    }
}

class Infoton extends React.Component {
    constructor(props) {
        super(props)
        this.state = {
            errMsg: null
        }
    }

    componentWillMount() {
        if(this.props.infoton)
            this.updateStateWithInfoton(this.props.infoton)
            
        this.props.infoton = undefined // we only needed it once.
    }
    
    componentWillReceiveProps(newProps) { // not using componentDidMount, because we want to ajax and re-render each time path changes
        if(AppUtils.isSameLocation(this.props.location, newProps.location) && this.props.displayNames)
          return // no need to reload current page, unless we still didn't get displayNames

        if(newProps.location.state) {
            this.updateStateWithInfoton(newProps.location.state, newProps.displayNames)
        } else {
            this.setState({ loading: true })
            AppUtils.cachedGet(`${newProps.location.pathname}?format=jsonl`)
                .always(t => this.setState({ loading: false }))
                .then(i => this.updateStateWithInfoton(new DInfoton(JSON.fromJSONL(i))), newProps.displayNames)
                .fail(r => this.setState({ errMsg: AppUtils.ajaxErrorToString(r) }))
        }
    }
    
    updateStateWithInfoton(infoton, displayNames) {
        if(location.pathname.indexOf('/ii/')===0) { 
          infoton.path && this.props.updateBreadcrumbsParts(infoton.path.substr(1).split`/`)
        } else {
            this.props.updateBreadcrumbsParts(null)
        }
        
        let wasSelected = field => !!+localStorage.getItem(`FavStar$${field}`)
        let fields = _(infoton ? infoton.fields || {} : {}).chain().map((v,k) => [k,{values:v,metadata:{selected:wasSelected(k)}}]).object().value()
        let displayName = new DInfoton(infoton, this.props.displayNames||displayNames).displayName
        infoton = { type: infoton.type, system: infoton.system }
        
        if(this.props.isEmptyCb) this.props.isEmptyCb(_.isEmpty(fields))
        
        if(infoton && infoton.system && infoton.system['length.content'] > AppUtils.constants.fileInfotonInMemoryThreshold) {
            // removing too large payloads from memory
            infoton.system = _(infoton.system).omit('data.content','base64-data.content')
        }

        this.setState({ infoton, fields, displayName, errMsg: null })
        this.props.displayNameUpdateCb && this.props.displayNameUpdateCb(displayName)
        
    }
    
    
    handleSilderToggleEvent(newValue) {
        this.setState({ onlyFav: newValue })
    }
    
    handleFavStarClick(fieldName) {
        let fields = this.state.fields
        fields[fieldName].metadata.selected = !fields[fieldName].metadata.selected
        this.setState({ fields })
    }
    
    render() {
        
        AppUtils.debug('Infoton.render')
        
        if(this.state.loading)
            return <LoadingSpinner/>
        
        let dataFields = this.state.fields
        
        let makeLink = (url, className, children) => _(this.props.rootFolders).some(rf => url.indexOf(rf)>-1) ?
                <Link to={url.replace('http:/','').replace('https:/','').replace('%','%25').replace('#','%23')} className={className}>{children || url}</Link> :
                <a href={url} className={className} target="_blank">{children || url}</a>
        
        let renderFieldValue = fv => {
            let isUri = fv.type === AppUtils.constants.anyURI
            return <span>
                { isUri ? makeLink(fv.value, 'value') : <span className="value">{''+fv.value}</span> }
                { fv.quad ? makeLink(fv.quad, 'quad', <img src="/meta/app/react/images/quad.svg" title={fv.quad} />) : null }
            </span>
        }
        
        let renderField = (data, key) => (<tr key={key}>
            <td className="fav-star-container">
                <FavStar fieldName={key} selected={data.metadata.selected} callback={this.handleFavStarClick.bind(this)} />
            </td>
            <td className="field-name-container">
                <div className="human-readable field-name">{AppUtils.toHumanReadableFieldName(key)}</div>
                <div className="field-name">{key.replace(/\.nn$/,'')}</div>
            </td>
            <td className="field-value">
                <ul>{data.values.map(v => <li>{renderFieldValue(v)}</li>)}</ul>
            </td>
        </tr>)
        
        let iconSrc = `/meta/app/react/images/${this.state.infoton && this.state.infoton.type === 'FileInfoton' ? 'file' : 'infoton'}-icon.svg`
        let fieldsNum = _(dataFields).keys().length;
        let favFieldsNum = _(dataFields).filter((v,k) => v.metadata.selected).length
        let onlyFav = this.state.onlyFav
        let visibleFields = _(dataFields).chain().pairs().filter(p => !onlyFav || p[1].metadata.selected).sortBy(p=>p[0]).object().value()
        let name = this.state.infoton && this.state.infoton.system ? AppUtils.lastPartOfUrl(this.state.infoton.system.path) : ''
        let fileContents = this.state.infoton && this.state.infoton.type === 'FileInfoton' ? <FileInfoton infoton={this.state.infoton}/> : null
        
        let errMsg = this.state.errMsg ? <ErrorMsg>{this.state.errMsg}</ErrorMsg> : null
        
        if(errMsg)
            return errMsg
        
        // todo refactor. it's not DRY having to keep asking !_.isEmpty(dataFields) 
        
        return _.isEmpty(dataFields) && !fileContents ? (this.state.infoton && this.state.infoton.system ? <SystemFields data={this.state.infoton.system} hasNoDataFields={true} /> : null) : (<div>
            <div className="infoton-title">
                <img src={iconSrc} />
                <div className="names">
                    <div className="displayName">{ this.state.displayName || name }</div>
                    { this.state.displayName && name != this.state.displayName ? <div className="name">{name}</div> : null }
                </div>
                <img src="/meta/app/react/images/alerts-icon.svg" className="alerts-icon" title="Get alerts" />
            </div>
            <ActionsBar forInfoton isFiltering={onlyFav} fields={_(visibleFields).keys()} />
            {fileContents}
            { !_.isEmpty(dataFields) ? <div className="fav-toggle">Show All ({fieldsNum}) <SliderToggle id="infoton-fav-fields" callback={this.handleSilderToggleEvent.bind(this)}/> Only Favorites ({favFieldsNum})</div> : null }
            
            { !_.isEmpty(dataFields) ? <table className="infoton-data">
                 <FlipMove className="flip-move-fields" duration={250} easing="ease-out">
                    <tr key="_header"><th className="th-fav">FAV.</th><th className="th-field">FIELD</th><th>VALUES</th></tr>
                    { _(visibleFields).map(renderField) }
                </FlipMove>
            </table> : null }
                
            <SystemFields data={this.state.infoton.system} />
        </div>)
    }
}

define([], () => Infoton)
