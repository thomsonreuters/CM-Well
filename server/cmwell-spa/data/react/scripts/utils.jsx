define([], () => {

    
/*
 *  
 * A few words about the design of this cache and its usage with the private function `retryGet` below:
 * It is an LRU Active Cache, user must provide the loadingFunc, and may provide other utility functions.
 * As to itself, it has nothing to do with async calls, but it is used with `retryGet` which returns a jQuery.Deferred instance.
 * 
 * So what is going on in practice is as follows: When `AppUtils.cachedGet` is invoked for a URL, the cache 
 * immediately store the Deferred ajax call, and returns it to the user which can add a `.then` or a `.always` etc.
 *
 * On the next time `AppUtils.cachedGet` will be invoked for same URL, it will use the given `rejectItemFunc` predicate to
 * invalidate that item from cache if needed. The `rejectItemFunc` that is being used will return true iff the ajax was completed with a failure.
 *  
 */
 
class LoadingCache {
    constructor({ loadingFunc, itemsLimit = 256, rejectItemFunc = v => false, itemIdFunc = _.identity }) {
        if(!_.isFunction(loadingFunc))
            throw new Error(`loadingFunc must be a function. ${loadingFunc} is not a function.`)

        this.itemsLimit = itemsLimit
        this.loadingFunc = loadingFunc
        this.rejectItemFunc = rejectItemFunc
        this.itemIdFunc = itemIdFunc
        this._cache = []
    }
    
    get(key) {
        key = this.itemIdFunc(key)
        let now = + new Date()
        let item = _(this._cache).findWhere({ key })
        
        if(item) {
            if(this.rejectItemFunc(item.value)) {
                this._cache = _(this._cache).reject({ key: item.key })
            } else {
                item.lastRead = now
                return item.value
            }
        }

        if(this._cache.length >= this.itemsLimit) {
            let lru = _(this._cache).min(item => item.lastRead)
            this._cache = _(this._cache).reject({ key: lru.key })
        }

        let value = this.loadingFunc.apply(null, arguments)
        this._cache.push({ key, value, lastRead: now })
        return value
    }
}

let retryGet = (url, numRetries = 3, delayMs = 500, retryOn = [503,504]) => {
    let promise = $.Deferred()
    let retry = n => $.get(url).then(promise.resolve).fail(r => n < numRetries && _(retryOn).contains(r.status) ? setTimeout(()=>retry(n+1), delayMs) : promise.reject(r))
    retry(1)
    return promise
}
    
let getCache = new LoadingCache({ loadingFunc: retryGet, rejectItemFunc: v => v.state()==='rejected' })

// an example of usage for $.ajax (currenly not needed)
// let ajaxCache = new LoadingCache({ loadingFunc: $.ajax, itemIdFunc: JSON.stringify })
    
window.AppUtils = {
      lastPartOfUrl: (url) => url.substr(url.lastIndexOf('/')+1)
    
    , lastPartOfUriPath: (uri) => uri.substr(Math.max(uri.lastIndexOf('/'),uri.lastIndexOf('#'))+1)
    
    , simpleFieldsProxy: (infoton) => new Proxy(infoton, {
        get (receiver, name) { return receiver.fields[name][0] }
    })
    
    , cachedGet: getCache.get.bind(getCache)
    
    , isSameLocation: (loc1,loc2) => loc1.pathname == loc2.pathname && loc1.search == loc2.search
    
    , toHumanReadableFieldName: (fieldName) => {
            let dotIdx = fieldName.indexOf('.')                           // e.g.:
            return (dotIdx===-1 ? fieldName : fieldName.substr(0,dotIdx)) // hasAKAName.mdass -> hasAKAName
               .replace(/([^A-Z])([A-Z])/g, '$1 $2')                      // hasAKAName -> has AKAName
               .replace(/^./, str=>str.toUpperCase())                     // has AKAName -> Has AKAName
               .replace(/([A-Z])([A-Z])([a-z])/g, '$1 $2$3')              // Has AKAName -> Has AKA Name
    }
    
    , addSep: (arr, sep) => _(arr).chain().map(i => [i,sep]).flatten().initial().value()
    
    , heightOverhead: 370
    
    , formats: [
         { value: 'json&pretty', displayName: 'json' }
        ,{ value: 'jsonl&pretty', displayName: 'jsonL' }
        ,{ value: 'jsonld&pretty', displayName: 'jsonLD', isRdf: true, fileExt: ['json','jsonld'] }
        ,{ value: 'jsonldq&pretty', displayName: 'jsonLDQ', isRdf: true }
        ,{ value: 'n3', displayName: 'RDF N3', isRdf: true, fileExt: 'n3' }
        ,{ value: 'ntriples', displayName: 'RDF NTriples', isRdf: true, fileExt: ['nt', 'ntriple', 'ntriples'] }
        ,{ value: 'nquads', displayName: 'RDF NQuads', isRdf: true, fileExt: ['nq', 'nquad', 'nquads'] }
        ,{ value: 'trig', displayName: 'RDF TriG', isRdf: true, fileExt: 'trig' }
        ,{ value: 'trix', displayName: 'RDF TriX', isRdf: true, fileExt: 'trix' }
        ,{ value: 'turtle', displayName: 'RDF Turtle', isRdf: true, fileExt: ['ttl', 'turtle'] }
        ,{ value: 'rdfxml', displayName: 'RDF Xml', isRdf: true, fileExt: ['xml', 'rdf', 'rdfxml'] }
        ,{ value: 'yaml', displayName: 'YAML' }
    ]
    
    , constants: {
         anyURI: 'http://www.w3.org/2001/XMLSchema#anyURI'
        ,fileInfotonInMemoryThreshold: 4096000
        ,breadcrumbs: {
             maxItems: 10
            ,maxPathLength: 64
        }
    }
    
    , ajaxErrorToString: r => {
        let errMsg = r.responseJSON ? r.responseJSON.error || r.responseJSON.message || 'Unknown error' : r.responseText
        if(errMsg && errMsg.indexOf('<html')!=-1) errMsg = 'Unexpected error'
        return r.status ? `HTTP ${r.status}: ${errMsg}` : 'An HTTP call did not return'
    }
    
    , debug: msg => window.debug && console.log(msg)
    
    , version: 1.0
}

AppUtils.fetchDisplayNames = cb => {
    AppUtils.cachedGet('/meta/dn?op=search&with-data&format=json').then(dnJsonResp => {
        let obj = {}
        dnJsonResp.results.infotons.forEach(i => obj[AppUtils.lastPartOfUrl(i.system.path)] = i.fields)
        cb(obj)
    })    
}


/* Overrides */

Storage.prototype.getBoolean = function(key) { return !!+this.getItem(key) }
Storage.prototype.setBoolean = function(key, value) { return this.setItem(key, +!!value) }

//JSON.tryParse = s => { try { return JSON.parse(s) } catch(e) { } }
                              
JSON.fromJSONL = jsonlObj => {
    let systemAndFieldsKeys = _(jsonlObj).chain().keys().partition(k => k.indexOf('sys') === k.length-3).value()
        , mapObjectBy = (o,f) => _(o).chain().map(f).object().value()
        , systemFields = _(systemAndFieldsKeys[0]).reject(k=>k=='@id.sys')
        , dataFields = systemAndFieldsKeys[1]
    
    return {
        system: mapObjectBy(systemFields, k => [k.substr(0,k.length-4), jsonlObj[k].length ? jsonlObj[k][0].value : '']),
        fields: mapObjectBy(dataFields, k => [k,jsonlObj[k]])
    }
}

React.Component.prototype.toggleState = function(prop) { this.setState({ [prop]: !this.state[prop] }) }

})
