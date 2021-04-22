if(typeof cmwell === "undefined") cmwell = {};

Storage.prototype.setObj = function(key, obj) { this[key] = JSON.stringify(obj); };
Storage.prototype.getObj = function(key) { return JSON.parse(this[key]||"null"); };

(function(){
var tokenKey = 'X-CM-WELL-TOKEN2';

cmwell.utils = {
    addHrefsToUrls: function(obj) {
        var res = {}
            , isURL = function(s) {
                return _.isString(s) && s.indexOf(' ')==-1 && s.indexOf('://')>-1;
            }
            , bendback = function(url) {
                var domain = (url.match(/:\/\/(.+?)\//)||[])[1]
                    , found = _(cmwell.bendback.data).contains(domain)
                    , withoutProtocol = url.substr(url.indexOf('://')+3)
                    , isCmwellProtocol = url.indexOf('cmwell://')>-1
                    , resultUrl = found ? '/'+withoutProtocol : url;

                resultUrl = (isCmwellProtocol ? url.replace('cmwell://','/') : resultUrl).replace('%','%25').replace('#','%23');

                return {
                    isBendback: found,
                    isCmwellProtocol: isCmwellProtocol,
                    url: resultUrl
                };
            }
            , simpleMakeLink = function(path) {
                return '<a href="' + path + '">' + path + '</a>';
            }
            , makeLink = function(url) {
                var bbObj = bendback(url)
                    , outLink = bbObj.isBendback ? '<a class="link-out-icon" href="'+url+'" target="_blank"></a>' : '';
                return '<a ' + (bbObj.isCmwellProtocol?'class="red-link" ':'') + 'href="'+bbObj.url+'"'+(bbObj.isBendback?'':' target="_blank"')+'>'+url+outLink+'</a>';
            };

        _(obj).each(function(v, k) {
            if(_.isArray(v)) {
                res[k] = _(v).map(function(e) {
                    if(isURL(e.value))
                        e.value = makeLink(e.value);
                    else if(e.type === cmwell.constants.anyUri)
                        e.value = simpleMakeLink(e.value);
                    return e;
                });
            } else {
                v.value = isURL(v.value) ? makeLink(v.value) : v.value;
                res[k] = v;
            }
        });
        return res;

    }

    , navigate: function(url) {
        // hack to launch Angular's Routing, instead of simply assigning URL to location.href
        $('<a class="not-displayed" href="'+url+'">').appendTo('#app-container').click();
    }

    //, genericObjToTabularView: function(obj) { // LINQPad's .Dump() style
    //    var flat = function(value) {
    //        if(_.isArray(value)) return _(value).map(function(el) { return cmwell.utils.objToTabularView(el) + '<br/>'; }).join('');
    //        if (_.isObject(value)) return cmwell.utils.objToTabularView(value);
    //        return value;
    //    };
    //
    //    return '<table>'+_(obj).map(function(v,k) { return '<tr><td><b>'+k+'</b></td><td>'+flat(v)+'</td></tr>'; }).join('')+'<table>';
    //}

    , objToTabularView: function(arr, cols) {
        cols = cols || _(arr[0]).keys();
        return '<table><tr>'+_(cols).mkString('<th>','</th>')+'</tr>'+_(arr).map(function(e){ return '<tr>'+_(cols).map(function(c){ return '<td>'+e[c]+'</td>'; }).join('')+'</tr>'; }).join('')+'</table>';
    }

    , extractDataFromAggregationResponse: function(aggrResp) {
        return _(aggrResp.AggregationsResponse).map(function(resp) {
            var res = { type: resp.type };
            switch(resp.type) {
                case cmwell.enums.AggregationResponseType.SignificantTerms: // fallthrough
                case cmwell.enums.AggregationResponseType.Histogram: // fallthrough
                case cmwell.enums.AggregationResponseType.Term:
                    res.data = _(resp.buckets).chain().map(function(b) { return [b.key, b.docCount]; }).object().value();
                    break;
                case cmwell.enums.AggregationResponseType.Cardinality:
                    res.data = { cardinality: resp.count };
                    break;
                case cmwell.enums.AggregationResponseType.Stats:
                    res.data = resp.results;
                    break;
            }
            return res;
        });
    }

    , generateTabsHtml: function(tabsData) {
        if(tabsData.length === 1)
            return tabsData[0].content;

        var ul = '', divs = '';
        _(tabsData).each(function(tabData) {
            ul += '<li><a href='+location.href+'#'+tabData.title+'">'+tabData.title+'</a></li>'; // location.href to convince .tabs() it's local content. otherwise it will ajax and angular will navigate and will blow up the entire app
            divs += '<div id="'+tabData.title+'">'+tabData.content+'</div>';
        });
        return '<div class="tabs-in-dialog"><ul>' + ul + '</ul>' + divs + '</div>';
    }

    , isTextual: function(mimetype) {
        mimetype = mimetype.toLowerCase();
        return _(['text','javascript','xml','json','markdown']).some(function(s) { return mimetype.indexOf(s)>-1; });
    }

    , sortDomElements: function(selector) {
        var elem = $(selector), children = $(selector).children();
        elem.empty();
        _(children).chain().sortBy(function(c) { return $(c).text(); }).each(function(c) { elem.append(c); });
    }

    //, hexDumpFromBase64: function(base64str, container) {
    //    $(container).append('<pre id="hexdump"></pre>');
    //    var options = { container: 'hexdump', base: 'hexadecimal', width: 16, ascii: true, byteGrouping: 1, html: true, lineNumber: true, style: {lineNumberLeft: '', lineNumberRight: ':', stringLeft: '|', stringRight: '|', hexLeft: '', hexRight: '', hexNull: '.g', stringNull: '.'} };
    //    new Hexdump(atob(base64str), options);
    //}

    , onOutside: function(containers, callback, evt) { // based on http://stackoverflow.com/a/7385673/4244787
        evt = evt || 'click';

        $(document).on(evt, function (e) {
            var isOutside = function(container) {
                container = $(container);
                return !container.is(e.target) && container.has(e.target).length === 0;
            };

            if(_(containers).every(isOutside))
                callback();
        });
    }

    , normalize: function(infoton, alreadyJson) {
        //todo actually this method should be a CTOR of a cmwell.Infoton prototype. invocations will be replaced with instantiations.

        if(!alreadyJson)
            infoton = JSON.fromJSONL(infoton);

        infoton.type = infoton.type || infoton.system.type;
        infoton.path = infoton.system.path;

        if(infoton.type === cmwell.enums.InfotonType.FileInfoton) {
            infoton.system.size = cmwell.utils.humanizeFileSize(infoton.system['length.content']);
        }

        infoton.fields = cmwell.utils.addHrefsToUrls(infoton.fields);

        return infoton;
    }

    , toMarkdown: function(mdSrc) {
        var html = cmwell.markdownConverter.makeHtml(mdSrc)
            , $html = $(html)
            , tmplResult;
        $html.find('code').each(function(k, v) { hljs.highlightBlock(v); });
        tmplResult = cmwell.LightWeightTemplateEngine.strTmpl(_($html).outerHtml());
        return tmplResult;
    }

    , updateToken: function(token) {
        cmwell.token[tokenKey] = token;
        cmwell.loggedInUser = JSON.parse(atob(token.split('.')[1])).sub;

         // not overriding token cookie, it should not be sliding but once set expired after 23hrs, s.t. expired token will never be used
        if(!cmwell.utils.getCookies()[tokenKey])
            document.cookie = tokenKey + "=" + token + '; expires=' + new Date(+new Date()+23*3600*1000).toGMTString() + '; path=/';

        var tokenObj = {};
        tokenObj[tokenKey] = token;
//        localStorage.setObj("cmwell.token", tokenObj);
    }

    , clearToken: function() {
        cmwell.token = {};
        cmwell.loggedInUser = null;
//        localStorage.removeItem("cmwell.token");
        document.cookie=tokenKey+'=;expires='+new Date(0);
    }

    , showStatus: function(msg, ttl, color) {
        color = color ? ' style=color:'+color : '';
        $('.status-bar').append('<span'+color+'>'+msg+'</span>');
        if(ttl)
            setTimeout(function() { $('.status-bar span:last').fadeOut(); }, ttl);
    }

    , checkCapslock: function(selector, cb) {
        $(selector).on({ keypress: function(e) {
            // CapsLock is on iff. the keystroke is lowercase while shift is held, (or the other way around)
            var isCapslockOn = !!(e.shiftKey ^ (e.keyCode>=65 && e.keyCode<=90));
            cb(isCapslockOn);
        } });
    }

    , _doCheckConnectivity: function(forced) {
        if(cmwell.utils.idleManager.isAppIdle() && !forced)
            return;

        var qTipOptions = {
            content: { text: 'You are disconnected.' },
            position: { target: 'mouse', adjust: { x: 10 } },
            style: { classes: 'qtip-red', tip: false },
            hide: { effect: function() { $(this).fadeOut(300); }}
        }, greyOut = 'grayscale(100%) blur(1px)';

        $.getJSON('/proc?anybody_home').then(function() {
            $('.logo').css({'-webkit-filter': '', 'filter': '' });
            var qTip = $('.logo').qtip('api');
            if(qTip) qTip.destroy(true);
        }).fail(function() {
            $('.logo').css({'-webkit-filter': greyOut, 'filter': greyOut }).qtip(qTipOptions);
        });
    }

    , _checkConnectivityTask: function() {
        $(document).on('mousemove', function() {
            if(cmwell.utils.idleManager.isAppIdle())
                cmwell.utils._doCheckConnectivity(true); // when App becomes active from idle state -> doCheckConnectivity right away, don't wait for interval

            cmwell.utils.idleManager.reset();
        });

        setInterval(cmwell.utils._doCheckConnectivity, cmwell.constants.checkConnInterval);
    }

    , idleManager: {
        _lastActivity: +(new Date),
        reset: function() { cmwell.utils.idleManager._lastActivity = +(new Date); },
        isAppIdle: function() { return +(new Date) - cmwell.utils.idleManager._lastActivity >= cmwell.constants.appIdleThreshold; }
    }

    , humanize: function(ms) {
        var s=ms/1000|0,m=s/60|0,h=m/60|0;s-=m*60;m-=h*60;
        return (h?h+'hr ':'')+(m?m+'min ':'')+(s?s+'sec':'');
    }

    , metaQuadInfotonToQuadObject: function(infoton) {
        return { alias: infoton.fields.alias[0], path: infoton.system.path, fullName: infoton.fields.graph[0] };
    }

    , getLastUrlPart: function(url) {
        return _(url).isString() ? url.substr(url.lastIndexOf('/')+1) : url;
    }

    , getCookies: function() {
        var res = {};
        document.cookie.split(';').forEach(function(kv) { var s=kv.split('='); res[s[0]]=s[1]; });
        return res;
    }

    , fetchAndVisualizeRdf: function(paths) {
        if(!paths.length) return;

        var addFormatJsonL = function(path) {
                var pathWithoutFormat = path.replace(/&?format=.*?(&|$)/i,'');
                return pathWithoutFormat + (pathWithoutFormat.indexOf('?')>-1?'&':'?') + 'format=jsonl';
            }
            , pathsForAjax = _.compact(paths.split('\n')).map(addFormatJsonL)
            , ajaxes = pathsForAjax.map(function(url) { return $.get(url); })
            , infotons = []
            , SPOs = []
            , addOrUpdateSPO = function(spo) {
                var equals = function(existingSpo) { return spo.s == existingSpo.s && spo.p == existingSpo.p && spo.o == existingSpo.o; }
                    , existingOne = _(SPOs).find(equals);

                if (existingOne) {
                    existingOne.g = _(existingOne.g).union(spo.g);
                } else {
                    SPOs.push(spo);
                }
            };

        if(ajaxes.length<2) ajaxes.push(ajaxes[0]); // hack to handle the case of a single URL.

        $.when.apply(null, ajaxes).then(function() { //todo can we use cmwell.utils.multipleAjaxes ?
            var self = this
                , responses = Array.prototype.slice.call(arguments).map(function(a){return a[0];});
            responses.forEach(function(resp, i){
                var addSrc = function() { for (var j=0;j<arguments.length;j++) arguments[j].src = this[i].url; }
                    , infotonsToAdd = [];

                if(resp['@id.sys']) infotonsToAdd = [resp];
                if(resp.infotons) infotonsToAdd = resp.infotons;
                if(resp.results) infotonsToAdd = resp.results.infotons;

                infotonsToAdd = infotonsToAdd.map(JSON.fromJSONL);
                addSrc.apply(self, infotonsToAdd);
                infotons = infotons.concat(infotonsToAdd);
            });
            infotons = _(infotons).uniq(function(infoton) { return infoton.system.path; });

            infotons.forEach(function(infoton){
                _(infoton.fields).each(function(v,k) {
                    v.forEach(function(value){
                        var spo = {
                            s: infoton.system.path,
                            p: k,
                            o: { value: value.value, type: value.type },
                            g: value.quad ? [value.quad] : ['defaultGraph'],
                            src: infoton.src
                        };

                        // stripping object's protocol to only have "bare" path, for consistency with subjects:
                        if(spo.o.type === cmwell.constants.anyUri)
                            spo.o.value = spo.o.value.replace(/\w*:\//,'');

                        addOrUpdateSPO(spo);
                    });
                });
            });

            cmwell.rdfToVisualGraph(SPOs, '#app-container');
        });
    }

    , findAndShowIncomingInfotons: function(subject, append, direction) {
        subject = subject || location.pathname;
        cmwell.utils.allPredicates = cmwell.utils.allPredicates ||
            $.get('/proc/fields?format=json')
                .then(function(mappingsInfoton){ return cmwell.utils.allPredicates = mappingsInfoton.fields.fields; }); // yo dawg I heard you like fields...

        $.when(cmwell.utils.allPredicates).then(function(predicates) {
            var urls = predicates.map(function(pred){ return "/?op=search&qp="+pred+"::http:/"+subject+"&format=json&recursive"; });

            if(direction && direction!==cmwell.enums.EdgeDirection.Incoming) predicates = urls = [];

            cmwell.utils.multipleAjaxes(urls, function(responsesZippedWithPredicates) {

                var incomingData = [], outgoingData = [];

                incomingData = _(responsesZippedWithPredicates).chain()
                    .map(function(pair) { return [pair[0].results.infotons, pair[1]]; })
                    .filter(function(pair) { return pair[0].length; })
                    .map(function(pair) { return _(pair[0]).map(function(i) { return { name: cmwell.utils.getLastUrlPart(i.system.path), path: i.system.path, edge: pair[1], direction: cmwell.enums.EdgeDirection.Incoming }; }); })
                    .flatten(true)
                    .value();

                var outgoingFetch = (direction && direction!==cmwell.enums.EdgeDirection.Outgoing) ? { } : $.get(subject+'?format=jsonl');

                $.when(outgoingFetch).then(function(resp) {
                    var infoton = resp["@id.sys"] ? cmwell.utils.normalize(resp) : { fields: [] };
                    _(infoton.fields).each(function(fieldValues,fieldName) {
                        _(fieldValues).chain()
                            .filter(function (v) { return v.type === cmwell.constants.anyUri; })
                            .map(function(v) { return $(v.value).text(); })
                            .each(function(v){ outgoingData.push({ name: cmwell.utils.getLastUrlPart(v), path: v.replace('http:/',''), edge: fieldName, direction: cmwell.enums.EdgeDirection.Outgoing }); });
                    });

                    var data = { name: cmwell.utils.getLastUrlPart(subject), path: subject.replace('http:/',''), iChildren: incomingData, oChildren: outgoingData };
                    cmwell.treeDataToCollapsibleGraph(data, '#app-container', append);
                });
            }, predicates);
        });
    }

    , findAndShowIncomingInfotons2: function(subject, virtParent, virtParentPred, virtParentPredRev, viewerObj, offsetXY, promise) { // todo settings pattern
         subject = subject || location.pathname;

        var parent = cmwell.utils.getLastUrlPart(subject);

        cmwell.utils.allPredicates = cmwell.utils.allPredicates ||
             $.get('/proc/fields?format=json')
                 .then(function(mappingsInfoton){ return cmwell.utils.allPredicates = mappingsInfoton.fields.fields; }); // yo dawg I heard you like fields...

        $.when(cmwell.utils.allPredicates).then(function(predicates) {
             var urls = predicates.map(function(pred){ return "/?op=search&qp="+pred+"::http:/"+subject+"&format=json&recursive"; });

             cmwell.utils.multipleAjaxes(urls, function(responsesZippedWithPredicates) {

                 var incomingData = [], outgoingData = [];

                 incomingData = _(responsesZippedWithPredicates).chain()
                     .map(function(pair) { return [pair[0].results.infotons, pair[1]]; })
                     .filter(function(pair) { return pair[0].length; })
                     .map(function(pair) { return _(pair[0]).map(function(i) { return { rev:true, parent: parent, name: cmwell.utils.getLastUrlPart(i.system.path), path: i.system.path, predicate: pair[1] }; }); })
                     .flatten(true)
                     .value();

                 $.get(subject+'?format=jsonl').then(function(resp) {
                     var infoton = cmwell.utils.normalize(resp);
                     _(infoton.fields).each(function(fieldValues,fieldName) {
                         _(fieldValues).chain()
                             .filter(function (v) { return v.type === cmwell.constants.anyUri; })
                             .map(function(v) { return $(v.value).text(); })
                             .each(function(v){ outgoingData.push({ parent: parent, name: cmwell.utils.getLastUrlPart(v), path: v.replace('http:/',''), predicate: fieldName }); });
                     });


                     if(virtParent) {
                         // filtering out the source - it is already shown on graph...
                         incomingData = _(incomingData).filter(function(ch) { return ch.name !== virtParent.name; });
                         outgoingData = _(outgoingData).filter(function(ch) { return ch.name !== virtParent.name; });
                     }

                     // in case of 0 children, d3.layout.tree prefers null children rather than 0 children
                     incomingData = incomingData.length ? incomingData : null;
                     outgoingData = outgoingData.length ? outgoingData : null;

                     var data = {
                         iData: {
                             "_parent": virtParent,
                             predicate: virtParentPred,
                             rev: virtParentPredRev,
                             name: parent,
                             path: subject.replace('http:/',''),
                             children: incomingData,
                             _children: incomingData ? null : []
                         },
                         oData: {
                             "_parent": virtParent,
                             predicate: virtParentPred,
                             rev: virtParentPredRev,
                             name: parent,
                             path: subject.replace('http:/',''),
                             children: outgoingData,
                             _children: outgoingData ? null : []
                         }
                     };

                     if(viewerObj)
                         viewerObj.add(data, offsetXY);
                     else
                         new cmwell.TreeDataToCollapsibleGraph2(data, '#app-container');

                     if(promise)
                         incomingData || outgoingData ? promise.resolve() : promise.reject();
                 })
                     .fail(function(){ if(promise) promise.reject(); });
             }, predicates);
         });
     }

    , multipleAjaxes: function(urls, cb, zipWith) {
        zipWith = zipWith || urls;
        $.when.apply(null, urls.map($.get)).then(function() {
            var responses = Array.prototype.slice.call(arguments).map(function(a){return a[0];});
            cb(_(responses).zip(zipWith));
        });
    }

    , toUrlSafeBase64: function(s) {
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // http://stackoverflow.com/a/20732091/4244787
    , humanizeFileSize: function(size) {
        var i = Math.floor(Math.log(size)/Math.log(1024));
        return (size/Math.pow(1024, i)).toFixed(2)*1 + ['B','KB','MB','GB','TB'][i];
    }
    
    , calculateDisplayName: function(infoton) {
        var typerdf = (infoton.fields['type.rdf'] || [])[0];
        if(!typerdf) return;
        
        var dnObj = cmwell.cache.displayNames.data[md5(typerdf)];
        if(!dnObj) return;

        var dnFuncsAndVals = _(dnObj).chain()
            .pairs()
            .reject(function(p) { return p[0] === 'forType'; })
            .sortBy(function(p) { return p[0]; })
            .map(function(p) { return p[1][0]; })
            .value();        
        
        // fieldsL and fields are to be used within `eval(code)` below
        var fieldsL = infoton.fields;
        var fields = _(infoton.fields).chain().pairs().map(function(p) { return [p[0],p[1][0]]; }).object().value();
        
        var apply = function(dnFuncOrVal) {
            if(dnFuncOrVal.indexOf('javascript:')===0) {
                var code = dnFuncOrVal.replace('javascript:','');
                try { return eval(code); } catch(e) { };
            } else {
                return fields[dnFuncOrVal];
            }
        }

        return _(dnFuncsAndVals).chain().map(apply).find(_.identity).value();
    }
    
    , whenOrResult: function(obj, cb) {
        obj.readyState ? obj.then(cb) : cb(obj);
    }
    
}
;

cmwell.utils.checkConnectivity = _.once(cmwell.utils._checkConnectivityTask);

// updating token from Cookie, if present
cmwell.token = {};
var cookieTokenValue = cmwell.utils.getCookies()[tokenKey];
if(cookieTokenValue) cmwell.token[tokenKey] = cookieTokenValue;
if(!_.isEmpty(cmwell.token)) cmwell.utils.updateToken(cmwell.token[tokenKey]);


// Enums, Constants

cmwell.enums = {
    InfotonType: {
        ObjectInfoton: 'ObjectInfoton',
        FileInfoton: 'FileInfoton',
        LinkInfoton: 'LinkInfoton'
    },

    ContainerType: {
        SearchResponse: 'SearchResponse',
        CompoundInfoton: 'CompoundInfoton',
        VirtualCompoundInfoton: 'VirtualCompoundInfoton'
    },

    AggregationResponseType : {
        SignificantTerms: 'SignificantTermsAggregationResponse',
        Term: 'TermsAggregationResponse',
        Stats: 'StatsAggregationResponse',
        Histogram: 'HistogramAggregationResponse',
        Cardinality: 'CardinalityAggregationResponse'
    },

    AggregationType: {
        SignificantTerms: 1,
        Distribution: 2,
        Histogram: 3,
        Stats: 4,
        Cardinality: 5
    },

    EdgeDirection: {
        Incoming: 1,
        Outgoing: 2
    }
};

cmwell.constants = {
    compoundInfotonResultsLength: 30,
    markdownMimeTypes: ['text/x-markdown', 'text/vnd.daringfireball.markdown'],
    cacheExpiry: 60*60*1000, // one hour
    ellipsisLength: 50,
    permissionsTemplate: {paths:[{id:"/",recursive:true,sign:"+",permissions:"r"},{id:"/labs",recursive:true,sign:"+",permissions:"rw"}],rev:0},
    anyUri: 'http://www.w3.org/2001/XMLSchema#anyURI',
    checkConnInterval: 20000,
    appIdleThreshold: 180000 // 3min
};


// Cache

var initCache = function() {
    cmwell.cache = {
        created: Date.now(),
        validate: function() {
            if(Date.now()-cmwell.cache.created>cmwell.constants.cacheExpiry)
                initCache();
        }
    };
};

initCache();

cmwell.formats = [
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
    //,{ value: 'tsv', displayName: 'TSV' },
    //,{ value: 'text', displayName: 'Paths Only' }
];

cmwell.bendback = {
    data: [],
    isReady: function () { return !!cmwell.bendback.data.length; } // todo inheritance?
};

cmwell.cache.quads = {
    data: {}
    , isReady: function () { return !_.isEmpty(cmwell.cache.quads.data); } // todo prototype!
    , add: function (quad) {
        if(_(cmwell.cache.quads.data).size()>=5000)
            cmwell.cache.quads.data = {};
        cmwell.cache.quads.data[quad.fullName] = quad;
        return quad;
    }

    , getOrAdd: function (fullName) {
        return cmwell.cache.quads.data[fullName] || (cmwell.cache.quads.data[fullName] = $.get('/meta/quad/'+cmwell.utils.toUrlSafeBase64(fullName)+'?format=json')
            .always(function(res) { return res.status === 404 ? {} : cmwell.utils.metaQuadInfotonToQuadObject(res); }));
    }
};

cmwell.cache.displayNames = {
    data: {}
    , isReady: function () { return !_.isEmpty(cmwell.cache.displayNames.data); } // todo prototype!
    , populate: function (jsonResp) {
        if(!jsonResp) return;
        
        if(jsonResp.results.infotons.length===0)
            cmwell.cache.displayNames.data.None='None'; // for isReady to return true even if no displayNames were ingested to /meta/dn
        
        _(jsonResp.results.infotons).each(function(i) {
            cmwell.cache.displayNames.data[cmwell.utils.getLastUrlPart(i.system.path)] = i.fields;
        });
        
        return cmwell.cache.displayNames.data;
    }
}
    
cmwell.domain = {
    InfotonsContainer: function(serverResp) {
        var self = this
            , init = function() {
                switch(serverResp.type) {
                    case cmwell.enums.ContainerType.CompoundInfoton:
                    case cmwell.enums.ContainerType.VirtualCompoundInfoton:
                        self.system = serverResp.system;
                        self.path = serverResp.system.path;
                        self.children = serverResp.children;
                        self.offset = serverResp.offset;
                        self.length = serverResp.length;
                        self.total = serverResp.total;
                        break;

                    case cmwell.enums.ContainerType.SearchResponse:
                        self.qp = serverResp.pagination.self.replace(location.origin,'');
                        self.children = serverResp.results.infotons;
                        self.offset = serverResp.results.offset;
                        self.length = serverResp.results.length;
                        self.total = serverResp.results.total;
                        break;

                    default:
                        if(serverResp.system) self.path = serverResp.system.path;

                }

                // getters
                self.source = self.path || self.qp;
                if(self.qp)
                    self.sourceDisplayName = self.source.substr(0,self.source.indexOf('?'));
            };

        this.path = '';
        this.qp = '';
        this.children = [];
        this.offset = 0;
        this.length = 0;
        this.total = 0;
        this.system = {};

        init();

        return this;
    }
};
    
String.prototype.isDate = function() { return _.isNaN(+this) && !_.isNaN(Date.parse(this)); };

String.prototype.hashCode=function(){var l=this.length,h=0;for(var i=0;i<l;i++)h=((h<<5)-h+this.charCodeAt(i))|0;return h;};

JSON.fromJSONL = function(jsonlObj) {
    var systemAndFieldsKeys = _(jsonlObj).chain().keys().partition(function(k) { return _.str.endsWith(k, "sys"); }).value()
        , mapObjectBy = function(o,f) { return _(o).chain().map(f).object().value(); };
    return {
        system: mapObjectBy(systemAndFieldsKeys[0], function(k) { return [k.substr(0,k.length-4), jsonlObj[k].length ? jsonlObj[k][0].value : '']; }),
        fields: mapObjectBy(systemAndFieldsKeys[1], function(k) { return [k,jsonlObj[k]]; })
    };
};

JSON.tryParse = function(s) { try { return JSON.parse(s); } catch(e) { } };

_.mixin({
    filterObj: function(obj, pred) {
        return _(obj).chain().pairs().filter(function(p){ return pred(p[1]); }).object().value();
    }
});


})();
