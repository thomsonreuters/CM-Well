const scrollChunkSize = 50

let { Link } = ReactRouter
let { Infoton } = Domain
let { ActionsBar, ErrorMsg } = CommonComponents

class InfotonsList extends React.Component {
  constructor(props) {
    super(props)
    
    this.position = null
    this.onAirAjax = []
    this.cancelledAjaxes = []
    
    this.loadingSpinnerItem = <li className="infoton-list-item" key="loading">
                                  <img className="bullet" src="/meta/app/react/images/infoton-icon.svg" />
                                  <span className="names">
                                      <span className="display-name loading">Loading more Infotons...</span>
                                  </span>
                              </li>
        
    this.state = {
      isEmpty: true,
      noData: false,
      errMsg: null,
      infotons: [],
      initialContent: [],
      total: null,
      active: true
    }
  }

  doFetch(path = this.props.location.pathname, qp = this.props.location.query.qp) {
      if(path.indexOf("/ii/")===0) {
          this.props.hasChildrenCb && this.props.hasChildrenCb(false)
          return
      } else {
          this.props.updateBreadcrumbsParts(null)
      }
      qp = qp && qp!='None' ? `&recursive&qp=${qp.replace('%','%25').replace('#','%23')}` : ''
      let createConsumerUrl = `${path}?op=create-consumer${qp}`
      
      if(_(this.onAirAjax).contains(createConsumerUrl))
          return
      
      if(!this.position) {
          this.onAirAjax.push(createConsumerUrl)
          AppUtils.cachedGet(createConsumerUrl).always((resp,rt,jqXhr) => {
              this.onAirAjax = _(this.onAirAjax).without(createConsumerUrl)
              if(_(this.cancelledAjaxes).contains(createConsumerUrl)) return
              if(resp.status !== undefined && resp.status !== 200) {
                  this.setState({ isInfiniteLoading: false, errMsg: AppUtils.ajaxErrorToString(resp) })
                  return
              }

              this.position = this._getHeader(jqXhr, resp, 'position')
              this.doFetch()
          })
          return
      }
      
      // Once we have position, we fire two ajaxes in parallel. First is _consume as TSV, other is _consume as JSONL
      // The idea is to first show a list of Infotons quickly to show them to user, while in the meantime fetch their displayNames
      
      if(this.state.infotons.length === 0 && this.state.initialContent.length === 0) {
          let tsvLineToSkeletonInfoton = tsv => {
              let s = tsv.split('\t')
              return { system: { path: s[0], uuid: s[2] }, fields: {} }
          }
          
          let consumeUrlTsv = `/_consume?position=${this.position}&format=tsv`

          if(!_(this.onAirAjax).contains(consumeUrlTsv)) {
              this.onAirAjax.push(consumeUrlTsv)
              AppUtils.cachedGet(consumeUrlTsv)
                  .always((resp,rt,jqXhr) => {
                    this.onAirAjax = _(this.onAirAjax).without(consumeUrlTsv)
                    if(_(this.cancelledAjaxes).contains(consumeUrlTsv)) return
                    if(!resp) return
                    let initialContent = resp.trim().split`\n`.map(tsvLineToSkeletonInfoton)
                    let isEmpty = !initialContent.length
                    this.setState({
                        errMsg: null,
                        isInfiniteLoading: false,
                        isEmpty,
                        noData: isEmpty,
                        total: this.state.total || initialContent.length + +this._getHeader(jqXhr, resp, 'n-left'),                        
                        initialContent
                    })
                  })
          }
      }
      
      
      let consumeUrl = `/_consume?position=${this.position}&format=jsonl`
      
      if(_(this.onAirAjax).contains(consumeUrl))
          return      
      
      this.onAirAjax.push(consumeUrl)
      AppUtils.cachedGet(consumeUrl).always((resp,rt,jqXhr) => {
          this.onAirAjax = _(this.onAirAjax).without(consumeUrl)
          if(_(this.cancelledAjaxes).contains(consumeUrl)) return
          
          if(resp && resp.status !== undefined && (resp.status !== 200 && resp.status !== 206)) {
              this.setState({ isInfiniteLoading: false, errMsg: AppUtils.ajaxErrorToString(resp) })
              return
          }
          
          let jsonls = (jqXhr && jqXhr.status === 204) ? '' : (jqXhr ? jqXhr.responseText : resp.responseText).split`\n`
          let newChunk = _(jsonls).compact().map(jsonl => JSON.fromJSONL(JSON.parse(jsonl)))

          let isEmpty = newChunk.length + this.state.infotons.length + this.state.initialContent.length === 0
          this.props.hasChildrenCb && this.props.hasChildrenCb(!isEmpty)

          this.position = this._getHeader(jqXhr, resp, 'position')
          
          this.setState({
              errMsg: null,
              isInfiniteLoading: false,
              isEmpty,
              noData: isEmpty,
              total: this.state.total || newChunk.length + +this._getHeader(jqXhr, resp, 'n-left'),
              infotons: this.state.infotons.concat(newChunk)
          })
      })
  }    

  _getHeader(jqXhr,resp, header) {
      return jqXhr ? jqXhr.getResponseHeader(`x-cm-well-${header}`) : resp.getResponseHeader(`x-cm-well-${header}`)
  }
    
  handleInfiniteLoad() {
      this.setState({ isInfiniteLoading: true })
      this.doFetch()
  }

  componentDidMount() {
      this._resetStateAndDoFetch(this.props)
  }
    
  componentWillReceiveProps(newProps) {
    if(AppUtils.isSameLocation(this.props.location, newProps.location))
      return // no need to reload current page

      this.cancelledAjaxes = Array.from(this.onAirAjax)
      this._resetStateAndDoFetch(newProps)
  }
    
  _resetStateAndDoFetch(props) {
    this.position = null
      
    this.state = {
      isEmpty: true,
      noData: false,
      errMsg: null,
      infotons: [],
      initialContent: [],
      total: null,
      active: true
    }      
      
    this.doFetch(props.location.pathname, props.location.query.qp || 'None')      
  }
  
  render() {

    AppUtils.debug('InfotonsList.render')
      
    let containerClassName = 'infotons-list-container' + (this.props.isRoot ? ' root' : '') + (this.props.infotonIsEmpty ? '' : ' autoWidth')
    let className = 'infotons-list' + (this.props.isRoot ? ' root' : '') + (this.state.active && !this.state.isEmpty ? ' active' : '')
    let containerHeight = this.props.isRoot || !this.state.active ? window.innerHeight-AppUtils.heightOverhead+58 : 330

    // todo once we will figure out how Infoton and InfotonsLists can live in peace side by side, perhaps that ugly guard won't be neccassery
    let title = this.props.location.pathname !== '/' && this.state.total && this.props.isRoot ? <div className="infotons-list-title">
            <img src="/meta/app/react/images/folder-box.svg"/>{AppUtils.lastPartOfUrl(this.props.location.pathname.replace('%25', '%'))} ({this.state.total.toLocaleString()} result{this.state.total==1?'':'s'})
          </div> : null
    
    let emptyDiv = <div className={containerClassName + ' empty'}></div>

    let errMsg = this.state.errMsg ? <ErrorMsg>{this.state.errMsg}</ErrorMsg> : null
    
    if(errMsg)
        return errMsg
    
    let infotons = (this.state.infotons.length ? this.state.infotons : this.state.initialContent).map(i => new Infoton(i, this.props.displayNames))
      
    return this.state.isEmpty && this.props.isRoot ? emptyDiv : (
        <div className={containerClassName}>
          {title}
          { this.state.noData ? <div className="no-children">no infotons under this path</div> : null }
          <Infinite className={className}
                         elementHeight={43}
                         containerHeight={containerHeight}
                         infiniteLoadBeginEdgeOffset={10}
                         onInfiniteLoad={this.handleInfiniteLoad.bind(this)}
                         loadingSpinnerDelegate={this.loadingSpinnerItem}
                         isInfiniteLoading={this.state.isInfiniteLoading}
                         >
            { infotons.map(i => <InfotonListItem key={i.uuid||i.path} infoton={i} toggleCollapseCb={this.toggleState.bind(this, 'active')} />) }
            </Infinite>
        </div>
    )
  }
}

class InfotonListItem extends React.Component {
    constructor(props) {
        super(props)
        this.state = { }
    }
    
    onChildrenBulletClick() {
        this.toggleState('expanded')
        this.props.toggleCollapseCb && this.props.toggleCollapseCb()
    }
    
    render() {
        AppUtils.debug('InfotonListItem.render')

        let { path, name, displayName, type, uuid } = this.props.infoton
        let classname = `infoton-list-item ${type}`

        let locationObj = { pathname: path, query: { } } // this is a temp hack. the InfotonList component should accept both location objects and simple paths as well
        let children = this.state.expanded ? <InfotonsList location={locationObj} /> : null
        let childrenBulletClassName = `triangle${this.state.expanded?' down':''}`
        let hasData = !_.isEmpty(this.props.infoton.fields)
        let bulletSrc = `/meta/app/react/images/${type === 'FileInfoton' ? 'file-icon.svg' : 'infoton-icon.svg'}`
        let linkClassName = hasData || type === 'FileInfoton' ? 'display-name' : 'display-name empty-data'

        // ReactRouter uses localStorage to transfer state between routes. let's not explode it...
        let isTooLargeFileInfoton = this.props.infoton.system['length.content'] > AppUtils.constants.fileInfotonInMemoryThreshold
        let stateByRoute = isTooLargeFileInfoton || !hasData ? undefined : this.props.infoton

        return (
            <li className={classname} key={uuid||path}>
                <img className="bullet" src={bulletSrc} />
                <span className="names">
                    <Link to={path.replace('%','%25').replace('#','%23')} className={linkClassName} state={stateByRoute}>{displayName}</Link>
                    { displayName != name ? <span className="name">{name}</span> : null }
                </span>
                <span className={childrenBulletClassName} onClick={this.onChildrenBulletClick.bind(this)}><img src="/meta/app/react/images/gt-blue.svg"/></span>
                <br/>
                {children}
            </li>
        )
    }
}

define([], () => InfotonsList)
