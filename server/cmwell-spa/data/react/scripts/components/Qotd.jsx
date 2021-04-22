class Qotd extends React.Component {
    constructor(props) {
        super(props)
        
        this.state = {
            hidden: true,
            quotes: []
        }
    }
    
    fetchRandomQuote() {
        let pathsFut = this.state.quotes.length===0 ? AppUtils.cachedGet('/qotd.tr.com/quotes?op=stream').then(r => r.split`\n`) : $.when(this.state.quotes)
        pathsFut.then(paths => {
            let quotePath = _(paths).shuffle()[0]
            if(quotePath) {
                AppUtils.cachedGet(`${quotePath}?xg=spokenByCharacter.schema&format=json`).then(boi => {
                    let quote = _(boi.infotons).find(i => i.fields['type.rdf'][0] === 'http://schema.org/Quotation')
                    let persons = _(boi.infotons).filter(i => i.fields['type.rdf'][0] === 'http://schema.org/Person')
                    
                    let activeQuoteText = quote.fields["text.schema"][0]
                    let activeQuoteOf = persons.map(p => p.fields["name.schema"][0] || p.fields["givenName.schema"][0]).join`, `
                    
                    this.setState({ hidden: false, activeQuoteText, activeQuoteOf })
                })
            }
        })
    }
    
    componentDidMount() {
        Mousetrap.bind('"', () => {
            this.setState({hidden: false})
            this.fetchRandomQuote()
        })
        
        Mousetrap.bind('?', () => { if(location.pathname==='/meta/ns') location.href='/meta/app/metansmonitor/index.html' })
    }
    
    render() {
        AppUtils.debug('Qotd.render')
        return <div className="qotd-container">
            { this.state.hidden ? null : <div className="qotd">
        
            <div className="quote-text">{this.state.activeQuoteText || ""}</div>
            <div className="quote-of">{this.state.activeQuoteOf || "Unknown"}</div>
        
        </div> }
        </div>
    }
}

define([], () => Qotd)