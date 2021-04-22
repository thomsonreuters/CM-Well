angular.module('cmwellAngApp.services', [])

.factory('infotonService', function($http) {

    return {
        getInfoton: function(path) {
            if(path[0]=='/') path = path.substr(1);
            return $http.get('/' + path + '?format=jsonl').then(function(resp){ return cmwell.utils.normalize(resp.data); });
        }

        , getFolder: function(path, offset, length) {
            if(path[0]=='/') path = path.substr(1);
            offset = offset ? '&offset='+offset : '';
            length = length || cmwell.constants.compoundInfotonResultsLength;
            return $http.get('/' + path + '?format=json&length='+length +offset);
        }

        , bulkGetInfotons: function(identifiers, usePaths) { // identifiers by default are uuids, but you can usePaths
            var payload = usePaths ? identifiers.join('\n') : _(identifiers).map(function(uuid) { return '/ii/'+uuid; }).join('\n');
            return $.ajax({ url: '/_out?format=json', type: "POST", data: payload, contentType: "text/plain", headers: cmwell.token }).then(function(res) {
                return _(res.infotons).map(function(i) { return cmwell.utils.normalize(i, true); });
            });
        }

        , getFieldAggr: function(path, field) {
            var lastPartOfUriPath = function(uri) {
                    var lastIndexOf = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('#'));
                    return uri.substr(lastIndexOf+1);
                };
            return $http.get(path+'?op=aggregate&recursive&ap=type:term,field::'+field+',size:1024&format=json')
                .then(function (resp){
                    if(!resp.data || !resp.data.AggregationResponse) return [];
                    return resp.data.AggregationResponse[0].buckets.map(function (bucket) {
                        return {
                            name: lastPartOfUriPath(bucket.key),
                            fullName: bucket.key, 
                            link: path + '?op=search&recursive&qp=' + field + '::' + bucket.key,
                            amount: bucket.objects || ''
                        };
                    });
                });
        }

        , getFolderBySearch: function(path, qp, length) {
            if(path[0]=='/') path = path.substr(1);
            length = length || cmwell.constants.compoundInfotonResultsLength;
            return $http.get('/' + path + '?op=search&qp=' + qp + '&recursive&length='+length+'&format=json');
        }

    };
  })
;