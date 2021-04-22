class SystemFields extends React.Component {
    constructor(props) {
        super(props)
        
        this.visibleSystemFields = ['uuid','lastModified','path']
        
        this.state = {
            expanded: false
        }
    }
    
    render() {
        AppUtils.debug('SystemFields.render')
        
        let className = (this.state.expanded ? "system-fields-container" : "system-fields-container collapsed") + (this.props.hasNoDataFields ? '' : ' higher')
        let secrets = k => k === 'lastModified' && this.props.data.indexTime ? `indexTime: ${new Date(this.props.data.indexTime).toISOString()}` : ''
        let data = _(this.props.data).chain().pairs().filter(p=>_(this.visibleSystemFields).contains(p[0])).object().value()
        
        return <div className={className}>
            <div className="system-fields-handle" onClick={this.toggleState.bind(this, 'expanded')} title={this.state.expanded?'':'System Information'}>
                <img className="info" width="18" height="18" src="/meta/app/react/images/info.svg" />
                <span className="title">SYSTEM INFORMATION</span>
                <img className="gt" width="18" height="18" src="/meta/app/react/images/gt.svg"/>
            </div>
            <div className="system-fields-data">
                <dl>
                    {_(data).map((v,k) => <span><dt>{k}</dt><dd title={secrets(k)}>{v}&nbsp;&nbsp;</dd></span>)}
                </dl>
            </div>
            <div className="border-eraser">&nbsp;</div>
        </div>
    }
}

define([], () => SystemFields)