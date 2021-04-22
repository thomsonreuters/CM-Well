angular.module('cmwellAngApp.controllers', [])

.controller('aggregationsController', function($scope, $modal) {

        $scope.openAggregationDialog = function(size) {
            $modal.open({
                templateUrl: 'dialog.html',
                size: size,
                controller: 'aggregationsDialogController'
            }).result.then(function(url){
                    console.log('done with url='+url);
                }, function () {
                    console.log('Modal dismissed.');
                });
        };
})

.controller('aggregationsDialogController', function ($scope, $modalInstance) {

    $scope.aggregationTypes = _(cmwell.enums.AggregationType).map(function(v,k) { return { name: k, value: v }; });

    $scope.ok = function () {
        $modalInstance.close($scope.selectedType);
    };

    $scope.cancel = function () {
        $modalInstance.dismiss('cancel');
    };
})

.controller('infotonsController', function($scope, $routeParams, $location, infotonService, $http) {

    if(cmwell.token) {
        $http.defaults.headers.get = cmwell.token;
        $http.defaults.headers.post = cmwell.token;
        $.ajaxSetup({ headers: cmwell.token });
    }

    $scope.login = function(landing) {
        var displayErrMsg = function() { cmwell.utils.showStatus('Failed to login', 2000, 'maroon'); }
        landing = landing ? '?landing='+landing : '';
        $.get("/_login").then(function(res) {
            if(res.token) {
                $http.defaults.headers.get = cmwell.token;
                $http.defaults.headers.post = cmwell.token;
                $.ajaxSetup({ headers: cmwell.token });

                cmwell.utils.updateToken(res.token);
                cmwell.utils.navigate('/_auth'+landing);
            } else {
               displayErrMsg();
            }
        }).fail(displayErrMsg);
    };

    // some auxiliary functions:
    var onError = function(data, status, headers, config) {
        NProgress.done();

        if((data.status === 403 || status === 403) && _(cmwell.token).isEmpty()) {
            $scope.login(location.pathname);
            return;
        }

        var url
            , showErrorMsg = function() {
                $scope.infoton = $scope.infotons = null;
                $scope.ajaxError = { statusCode: status, data: data, url: url };
            }
            , parseRespText = function(text) {
                if(text.indexOf('<html>'>-1))
                    return $('<span>').append(text).find('p').text();

                return text;
            };

        if(data.status) { // jQuery $.ajax error
            status = data.status;
            data = parseRespText(data.responseText);
            $scope.$apply(showErrorMsg);
        } else { // AngularJS $http error
            url = location.origin+config.url;
            showErrorMsg();
        }

        $('.ui-dialog-content').dialog('close').remove();
        $('.qtip').remove();
    }

    , onInfotonReady = function(resp) {
        NProgress.done();

        $scope.infoton = cmwell.cache.currentInfoton = resp;
        $scope.infotonName = _(resp.system.path.split('/')).last() || '';

        $('.status-bar').empty();

        if(resp.type===cmwell.enums.InfotonType.FileInfoton) {
            $scope.fileInfoton = {
                mimeType: resp.system["mimeType.content"],
                data: resp.system["data.content"]
            };
            if(_(cmwell.constants.markdownMimeTypes).contains(resp.system["mimeType.content"])) {
                $scope.fileInfoton.isMarkdown = true;
            }
            $scope.isFileInfotonTextual = cmwell.utils.isTextual(resp.system["mimeType.content"]);
        }

        // hook on titles to collapse parts

        $('.infoton-part-title').on('click', function() {

            var $self = $(this)
                , part = $self.next('.part')
                , rotateHandle = function(deg) { $self.find('.collapse-handle').css({ transform: 'rotate(' + deg + 'deg)' }); };

            if(part.is(':visible')) {
                part.slideUp();
                rotateHandle(0);
            } else {
                part.slideDown();
                rotateHandle(90);
            }
        });
    }

    , onCompoundInfotonReady = function(compoundInfoton, responseStatusCode) {
            NProgress.done();

            if(responseStatusCode === 206 /* HTTP 206 Partial Content */) {
                $scope.gracefulDegradation = true;
                return;
            }

            var container = new cmwell.domain.InfotonsContainer(compoundInfoton);


            // $scope.currentPath = makeBreadCrumbs(compoundInfoton.system.path);
            // $scope.pager = createPager(compoundInfoton);
            $scope.currentPath = makeBreadCrumbs(container.sourceDisplayName || container.source, $scope.currentNaviField);
            $scope.pager = createPager(container, +$routeParams.length, +$routeParams.offset);

            // var currentFloaties = 'Floaties_' + compoundInfoton.system.path + getOffset();
            var currentFloaties = 'Floaties_' + container.source + getOffset();
            cmwell.cache[currentFloaties] = cmwell.cache[currentFloaties] || {};
            cmwell.cache.additionalCssClasses = cmwell.cache.additionalCssClasses || {};

            // $scope.infotons = _(compoundInfoton.children).map(function (childInfoton) {
            $scope.infotons = _(container.children).map(function (childInfoton) {
                var path = childInfoton.system.path
                    , res = {
                        uuid: childInfoton.system.uuid,
                        path: path.replace('%','%25').replace('#','%23'),
                        displayName: '',
                        mimetype: getMimeType(childInfoton),
                        linkTo: (childInfoton.linkTo||'').replace('%','%25').replace('#','%23'),
                        type: childInfoton.type
                    };

                    // special case: making /proc's Floaties. ugly. I know.
                    // if(compoundInfoton.system.path==='/proc') {
                    if(container.source==='/proc') {
                        res.floaty = cmwell.cache[currentFloaties][childInfoton.system.path] = _(createFloaty(childInfoton)).without('rss');
                        res.additionalCssClasses = cmwell.cache.additionalCssClasses[childInfoton.system.path] = (childInfoton.type.replace('Virtual','') === cmwell.enums.InfotonType.FileInfoton ? ' file-infoton' : '') +
                            (childInfoton.content && cmwell.utils.isTextual(childInfoton.content.mimeType) ? ' textual'+(_(cmwell.constants.markdownMimeTypes).contains(childInfoton.content.mimeType) ? ' markdown' : '') : '');
                    }

                return res;
            });

            // hook add user
            $('#app-container').on('click', '.add-user-button', function() {
                var form = $('.add-user-form')
                    , pwObj
                    , fetchPassword = function() {
                        form.find('#password').html('<img src="/meta/app/angular/images/loading2.gif"/>');
                        $.getJSON('/_auth?op=generate-password').then(function(pwObjRes){
                            pwObj = pwObjRes;
                            form.find('#password').text(pwObj.password);
                        });
                    };
                var resetForm = function() {
                    $('.add-user-form').slideUp();
                    form.find('#username').val('');
                    onAjaxEnd();
                };
                var onAjaxEnd = function() {
                    form.find('img').remove();
                    form.find('.upload-user').show();
                    form.find('.cancel').show();
                };
                form.slideDown();
                fetchPassword();
                form.find('textarea').val(JSON.stringify(cmwell.constants.permissionsTemplate, null, 2));

                if(form.data('initialized'))
                    return;

                form.find('.reload').on('click', fetchPassword);
                form.find('.cancel').on('click', resetForm);
                form.find('.upload-user').on('click', function() {
                    var username = form.find('#username').val().trim();
                    if(!username) {
                        cmwell.utils.showStatus("Username is required!", 2000, 'maroon');
                        return;
                    }
                    var permissions = JSON.tryParse(form.find('textarea').val());
                    if(!permissions) {
                        cmwell.utils.showStatus("Permissions: Invalid JSON!", 2000, 'maroon');
                        return;
                    }
                    form.find('button').hide();
                    form.find('.loading').show();

                    permissions.digest = pwObj.encrypted;
                    permissions.digest2 = md5(username+":cmwell:"+pwObj.password);

                    permissions.roles = permissions.roles || [];
                    $.ajax({type:'POST',url:'/meta/auth/users/'+username, data: JSON.stringify(permissions), contentType: 'application/json', headers: {'X-CM-WELL-Type':'File'}}).then(function(){
                        cmwell.utils.showStatus("User " + username + " was created", 3000, 'green');
                        resetForm();
                    }).fail(function (error) {
                        error = JSON.parse(error.responseText);
                        error = error.error || error.message;
                        cmwell.utils.showStatus("Add User failed: " + error, 3000, 'maroon');
                        onAjaxEnd();
                    });
                    ;
                });
                form.data('initialized', 'yup.');
            });

            $scope.qp = $routeParams.qp;
            if($scope.infotons.length)
                setTimeout(getFieldsAndValuesData, 200);
        }

    , makeBreadCrumbs = function(path, fields) {
        var acc = ''
            , lock = _(cmwell.token).isEmpty() ? '' : '<a href="/_auth/" class="lock" title="You are logged in as '+cmwell.loggedInUser+'"></a>';

        fields = fields ? '<span class="separator"></span><a class="link-out-icon type-breadcrumb" href="'+location.href+'" target="_blank">'+fields+'</a>' : '';

        return lock + '<a class="home-link" href="/"></a>' + (path==='/' ? '' :
                _(path.split('/')).chain().compact().map(function(bc){ return '<span class="separator"></span><a href="'+(acc+=bc.replace('%','%25').replace('#','%23')+'/')+'">'+bc+'</a>'; }).value().join('')) + fields;
    }

    , createFloaty = function(infoton) {
        var floaty = [];

        switch(infoton.type.replace('Virtual','')) {
            case cmwell.enums.InfotonType.LinkInfoton: // fallthrough
            case cmwell.enums.InfotonType.ObjectInfoton:
                // todo we do not have a way to determine if CompoundInfoton has more than 0 children without an additional AJAX - so now all infotons get RSS icon
                floaty.push('rss');
                if(infoton.fields)
                    floaty.push('with-history', 'diff-view');
                break;
            case cmwell.enums.InfotonType.FileInfoton:
                if(cmwell.utils.isTextual(infoton.content.mimeType))
                    floaty.push('plain-text');
                if(_(cmwell.constants.markdownMimeTypes).contains(infoton.content.mimeType))
                    floaty.push('markdown');
                if(infoton.path && infoton.path.indexOf('index.html')>-1)
                    floaty.push('view');
                break;
        }

        return floaty;
    }

    , fileInfotonOnClick = function(e) {
        e.preventDefault();

        var elem = $(e.target).closest('a')
            , isTextual = elem.hasClass('textual')
            , isMarkdown = elem.hasClass('markdown')
            , src = elem.data('path')
            , alreadyExpanded = elem.next().hasClass('file-infoton-content')
            , editable = cmwell.editMode && !isMarkdown
            , textBoxKind = editable ? 'textarea' : 'pre';

        var addMarkup = function(src) { elem.after('<div class="file-infoton-content">' + src + '</div>'); };

        $scope.$apply(function(){if($scope.parentInfoton) $scope.infoton = $scope.parentInfoton;});
        $('.file-infoton-content').remove();
        if(alreadyExpanded) return;

        $.getJSON(src+'?format=jsonl&override-mimetype=text/plain%3Bcharset=utf-8').then(function (fileInfoton) {
            fileInfoton = cmwell.utils.normalize(fileInfoton);
            $scope.parentInfoton = $scope.infoton;
            $scope.$apply(function(){$scope.infoton = fileInfoton;});

            var mime = fileInfoton.system["mimeType.content"]
                , isImage = !!mime.match(/image\/.*/);

            if(isTextual && !isImage) {
                addMarkup('<'+textBoxKind+'></'+textBoxKind+'>');
                var textBox = elem.next().find(textBoxKind);
                textBox.text(fileInfoton.system["data.content"]);

                if(isMarkdown) {
                    textBox.html(cmwell.utils.toMarkdown(fileInfoton.system["data.content"]));
                } else {
                    textBox.text(fileInfoton.system["data.content"]);
                }

                if(editable) {
                    textBox.width('97%').height('200px');
                    elem.next().append('<button id="save">Save</button>');

                    // toggle pretty
                    var jsonContent = JSON.tryParse(fileInfoton.system["data.content"]);
                    if(jsonContent) {
                        elem.next().append('<button id="pretty">Toggle Pretty</button>');
                        elem.next().find('#pretty').on('click', function() {
                            var curVal = JSON.tryParse($('textarea').val())
                                , state = $(this).data('pretty')==='true';

                            if(!curVal) { // invalid json
                                $('textarea').css('color', 'maroon');
                                return;
                            }

                            $('textarea').css('color', 'black').val(JSON.stringify(curVal, null, state?0:2));
                            $(this).data('pretty',''+!state);
                        });
                    }

                    elem.next().find('#save').on('click', function() {
                        //todo refactor: 1. move ajax calls to services.js, 2. get rid of some callback-hell
                        $(this).prop('disabled', true).text('(uploading...)');
                        var data = textBox.val()
                            , fileInfotonPath = elem.data('path')
                            , infoton = _($scope.infotons).findWhere({path: fileInfotonPath})
                            , contentType = infoton ? infoton.mimetype : 'text/plain';

                        $.ajax({type: 'POST', url: fileInfotonPath, data: data, headers: {'X-CM-Well-Type': 'File', 'Content-Type': contentType}})
                            .done(function () {
                                elem.next().find('button').removeAttr('disabled').text('Save');
                                elem.next().append('<span style="color:darkgreen;"> Done</span>');
                            })
                            .fail(function (error) {
                                error = JSON.parse(error.responseText);
                                error = error.error || error.message;
                                elem.next().find('button').removeAttr('disabled').text('Save');
                                elem.next().append('<span style="color:maroon;"> '+error+'</span>');
                            });
                    });
                }
            } else {
                if(isImage) {
                    var isSvg = mime.indexOf('image/svg+xml') > -1 ;
                    if(isSvg) {
                        var content = fileInfoton.system["data.content"];
                        addMarkup(content);
                    } else {
                        var content = fileInfoton.system["base64-data.content"];
                        addMarkup('<img src="data:'+mime+';base64,'+content+'"/>');
                    }
                } else {
                    addMarkup('<a href="'+fileInfoton.path+'" target="_blank"><img style="margin:6px;" width="20" src="/meta/app/angular/images/download-icon.svg"/>Download</a>');
                }
            }
        });
    }

    , floatyOnClick = function(e) {
        e.preventDefault();
        var which = $(this).attr('class').replace('floaty-icon ','')
            , path = $(this).closest('a').data('path')
            , action = '';

        switch(which) {
            case 'diff-view':
                cmwell.historyViewer.show(path);
                return false;
            case 'with-history':
                action = 'with-history';
                break;
            case 'rss':
                action = 'format=atom&op=search&length=50';
                break;
            case 'markdown':
                action = 'pretty';
                break;
            case 'plain-text':
                action = 'override-mimetype=text/plain%3Bcharset=utf-8';
                break;
            case 'view':
                location.href = path;
                return false;
        }

        window.open(path + '?' + action);
        return false;
    }

    , getFieldsAndValuesData = function() {

        if((!$scope.infoton || !$scope.infoton.system) && !$scope.qp) return;

        $('.search-field-menu').html('<option class="not-displayed" value="" selected>Field</option>');

        cmwell.cache.validate();

        var cacheKeySuffix = (($scope.infoton && $scope.infoton.system) ? $scope.infoton.system.path : $scope.qp) + getOffset();
        
        var currentKeys = 'Keys_'+cacheKeySuffix
            , currentValues = 'Values_'+cacheKeySuffix
            , currentFloaties = 'Floaties_'+cacheKeySuffix
            , currentDisplayNames = 'DisplayNames_'+cacheKeySuffix;
        
        if(cmwell.cache[currentKeys]) {
            $('.search-field-menu span').remove();
            _(cmwell.cache[currentKeys]).chain().sortBy(_.identity).each(function(k) {
                $('.search-field-menu').append('<option class="cmw-row">' + k + '</option>');
            });
            $('.field-related-menus').toggle(!!cmwell.cache[currentKeys].length);
            $('.incoming-links').toggle(!cmwell.cache[currentKeys].length);

            $scope.$apply(function(){
                _($scope.infotons).each(function(scopeInfoton) {
                    scopeInfoton.floaty = cmwell.cache[currentFloaties][scopeInfoton.path];
                    scopeInfoton.additionalCssClasses = cmwell.cache.additionalCssClasses[scopeInfoton.path];
                    scopeInfoton.displayName = cmwell.cache[currentDisplayNames][scopeInfoton.path];
                });
            });

            return;
        }

        cmwell.cache.fieldTypes = cmwell.cache.fieldTypes || {};
        cmwell.cache.additionalCssClasses = cmwell.cache.additionalCssClasses || {};
        cmwell.cache[currentKeys] = [];
        cmwell.cache[currentValues] = {};
        cmwell.cache[currentFloaties] = {};
        cmwell.cache[currentDisplayNames] = {};
        
        var uuids = _($scope.infotons).pluck('uuid');

        infotonService.bulkGetInfotons(uuids).then(function(infotons) {
            _(infotons).each(function(infoton) {

                //side effect: populating floaties
                var scopeInfoton = _($scope.infotons).findWhere({ path: infoton.system.path });
                if(scopeInfoton)
                    $scope.$apply(function() {

                        scopeInfoton.floaty = cmwell.cache[currentFloaties][infoton.system.path] = createFloaty(infoton);
                        scopeInfoton.additionalCssClasses = cmwell.cache.additionalCssClasses[infoton.system.path] = (infoton.type === cmwell.enums.InfotonType.FileInfoton ? ' file-infoton' : '') +
                            (infoton.content && cmwell.utils.isTextual(infoton.content.mimeType) ? ' textual'+(_(cmwell.constants.markdownMimeTypes).contains(infoton.content.mimeType) ? ' markdown' : '') : '');
                        scopeInfoton.displayName = cmwell.cache[currentDisplayNames][infoton.system.path] = cmwell.utils.calculateDisplayName(infoton);
                    });

                _(infoton.fields).each(function (v,k) {
                    cmwell.cache.fieldTypes[k] = _.isString(v) && v.isDate() ? "date" : typeof v;
                    cmwell.cache[currentValues][k] = cmwell.cache[currentValues][k] || [];
                    cmwell.cache[currentValues][k] = cmwell.cache[currentValues][k] || [];
                    cmwell.cache[currentValues][k].push(v[0]);
                    if(!_(cmwell.cache[currentKeys]).contains(k)) {
                        cmwell.cache[currentKeys].push(k);
                        $('.search-field-menu').append('<option class="cmw-row">' + k + '</option>');
                    }
                });
            });

            $('.search-field-menu').find(':first-child').remove();
            cmwell.utils.sortDomElements('.search-field-menu');
            $('.search-field-menu').prepend('<option class="not-displayed" value="" selected>Field</option>');

            $('.field-related-menus').toggle(!!cmwell.cache[currentKeys].length);
        });

    }

    , getMsgOfTheDay = function() {
        return $.get('/meta/sys/motd?format=json')
        .always(function() { 
            cmwell.cache.motd = {};
        })
        .then(function(motdInfoton) {
            if(!motdInfoton.content.data) return;
            
            var $motd = $('.motd')
                defaultBgColor = 'rgb(255, 219, 111)';
            $motd.find('p').html(cmwell.utils.toMarkdown(motdInfoton.content.data));
            $motd.css('background', motdInfoton.fields && _.isArray(motdInfoton.fields.bgc) ? motdInfoton.fields.bgc[0] : defaultBgColor);
            $motd.find('.close-button').on('click', function() { $motd.slideUp(750); cmwell.cache.motd.closed = true; });
            var motdType = motdInfoton.fields && _.isArray(motdInfoton.fields.type) ? motdInfoton.fields.type[0] : undefined;
            cmwell.cache.motd = { type: motdType, msg: motdInfoton.content.data };
        });
    }

    , showMsgOfTheDayIfNeeded = function() {
        var $motd = $('.motd')
            , fut =  cmwell.cache.motd ? $.when([]) : getMsgOfTheDay();

        fut.then(function() {
            if(!cmwell.cache.motd.msg || cmwell.cache.motd.closed) return;

            if(cmwell.cache.motd.type === 'alert' || location.pathname === '/')
                $motd.slideDown(750);
            else
                $motd.slideUp(750);
        });
    }

    , getMimeType = function(infoton) {
        if(_.str.startsWith(infoton.type,'Virtual'))
            return 'active';

        if(infoton.type === cmwell.enums.InfotonType.LinkInfoton)
            return 'link';

        if(infoton.content)
            return infoton.content.mimeType;

        if(infoton.type === cmwell.enums.InfotonType.FileInfoton)
            return 'unknown';

        return 'folder';
    }

    , createPager = function(folder, qpLength, qpOffset) {
        var generateSlidingWindowPages = function(current, total, windowSize) {
            windowSize = windowSize || 3;

            if(current<=windowSize)
                return _.range(1,windowSize*2+2);

            if(current+windowSize>total)
                return _.range(total-windowSize*2,total+1);

            return _(_.range(-windowSize,windowSize+1)).chain().map(function(n){return n+current;}).value();
        };

        // sometimes folder.length != qpLength because computed Infotons
        var length = folder.length || qpLength || cmwell.constants.compoundInfotonResultsLength;
        var offset = qpOffset || folder.offset;

        var res = {
            active: !!(qpLength || (folder.system.path && (folder.offset > 0 || folder.total > folder.length))),
            totalPages: Math.floor(folder.total / length) + 1,
            currentPage: Math.ceil(offset / length) + 1,
            prevLink: location.href,
            prevClass: 'disabled',
            nextLink: location.href,
            nextClass: 'disabled',
            offset: offset,
            pageSize: length,
            total: folder.total,
            from: offset+1,
            until: Math.min(folder.total, (offset+length))
        };

        var swPages = generateSlidingWindowPages(res.currentPage, res.totalPages);
        res.slidingWindowPages = _(swPages).map(function(p) { return { num: p, href: folder.system.path + '?length=' + length + '&offset=' + ((p-1)*length) }; });

        if(offset >= length) {
            res.prevLink = folder.system.path + '?length=' + length + '&offset=' + (res.offset - length);
            res.prevClass = '';
        }
        
        if(offset+length < folder.total) {
            res.nextLink = folder.system.path + '?length=' + length + '&offset=' + (res.offset + length);
            res.nextClass = '';
        }

        return res;
    }

    , getUrl = function() {
        return location.href; // .replace(/_offset\/\d+\//, '');
    }

    , getOffset = function() {
        return $routeParams.offset || '';
    }

    , warmCachesIfNeededAndThen = function(cb) {
        $.when(
            cmwell.bendback.isReady() ? [] : $.getJSON('/?format=json&length=1024'),
            cmwell.cache.quads.isReady() ? [] : $.getJSON('/meta/quad?op=search&length=1000&with-data&format=json'),
            cmwell.cache.displayNames.isReady() ? [] : $.getJSON('/meta/dn?op=search&with-data&format=json')
        )
        .then(function(rootFolder, quadsMetaData, dnMetaData) {
            rootFolder = rootFolder[0];
            quadsMetaData = quadsMetaData[0];
            dnMetaData = dnMetaData[0];
            if(rootFolder) cmwell.bendback.data = _(rootFolder.children).chain().map(function(i) { return i.system.path.substr(1); }).filter(function(p) { return p!=='proc' && p!='meta'; }).value();
            if(quadsMetaData) cmwell.cache.quads.data = _(quadsMetaData.results.infotons).chain().map(cmwell.utils.metaQuadInfotonToQuadObject).indexBy('fullName').value();
            cmwell.cache.displayNames.populate(dnMetaData);
            cb();
        });
    }

    ;


    if($routeParams.qp) {
        var f = $routeParams.qp.split('::')[0]
            , v = $routeParams.qp.split('::')[1];
        v = v.substr(v.lastIndexOf('/')+1);
        $scope.currentNaviField = f + '::' + v;
    }

    var path = getUrl().replace(location.origin, '')
        , pathKey = path.replace(/\//g,'');
    cmwell.cache.fieldsNavi = cmwell.cache.fieldsNavi || {};

    if(cmwell.cache.fieldsNavi[pathKey])
        $scope.naviFields = cmwell.cache.fieldsNavi[pathKey];

    $scope.loadNaviFields = function() { 
        $scope.naviFieldsAreLoading = true;

        var path = getUrl().replace(location.origin, '')
            , pathKey = path.replace(/\//g,'');

        infotonService.getFieldAggr(path, 'type.rdf').then(function(results) { // yes, 'type.rdf' is hard-coded for now. to be continued...
            cmwell.cache.fieldsNavi[pathKey] = $scope.naviFields = results;
            $scope.naviFieldsAreLoading = false;
        });
    }

    
    if(location.href.indexOf('?angular') > -1)
        setTimeout(function(){ $('<a class="not-displayed" href="'+location.href.replace('?angular','')+'">').appendTo('.header').click(); }, 100);


    showMsgOfTheDayIfNeeded();

    $('svg').remove(); // temp - to recover from VLD mode

    $scope.formats = cmwell.formats;

    $scope.infoton = {};
    $scope.fileInfoton = null;

    NProgress.start();

    var queryToken = $routeParams.token;
    if(_(cmwell.token).isEmpty() && queryToken) {
        cmwell.utils.updateToken(queryToken);
        cmwell.utils.navigate(getUrl());
    }

    var md5Regex = /^[a-f0-9]{32}$/;
    if(md5Regex.test($location.hash()))
        location.href = '/ii/'+$location.hash();

    var path = ($routeParams.path || $routeParams.infotonPath || '').replace('%','%25').replace('#','%23')
        , offset = $routeParams.offset ? +$routeParams.offset : 0
        , length = $routeParams.length ? +$routeParams.length : cmwell.constants.compoundInfotonResultsLength
        // , field = $routeParams.field
        // , fieldValue = $routeParams.value ? atob($routeParams.value) : ''
        , doFetchInfoton = function() {

            if($routeParams.qp) {
                infotonService.getFolderBySearch(path, $routeParams.qp).error(onError).success(onCompoundInfotonReady);
            } else {
                infotonService.getInfoton(path).catch(onError).then(function(r) { onInfotonReady(r.data || r); });
                infotonService.getFolder(path, offset, length).error(onError).success(onCompoundInfotonReady);
            }
        };

    warmCachesIfNeededAndThen(doFetchInfoton);

    // Some UI Hooks (AKA Bindings with event listeners):

    // hook infotons list stuff
    $('#app-container').on('click', '.file-infoton', fileInfotonOnClick);
    $('#app-container').on('click', '.floaty-icon', floatyOnClick);

    // hook Atom
    $('.atom').parent().on('click', function() {
        window.open(getUrl() + '?format=atom&op=search&length=50');
    });

    //// hook view history
    //$('.view-with-history').parent().on('click', function() {
    //    cmwell.historyViewer.show(getUrl().replace(location.origin,''));
    //    //window.open(getUrl() + '?with-history');
    //});

    var restoreDropDownTitle = function() { $(this).val($(this).find(':first-child').text()); };

    // hook Format menu
    $('.format-menu').on('change', function() {
        window.open(getUrl() + '?format=' + $(this).val() + '&override-mimetype=text/plain%3Bcharset=utf-8');
        restoreDropDownTitle.call(this);
    });

    // hook History menu
    $('.history-menu').on('change', function() {
        var selection = $(this).val();
        if(selection==='diff') {
            cmwell.historyViewer.show(path);
        } else {
            if(selection) selection = '&format=' + selection + '&override-mimetype=text/plain%3Bcharset=utf-8';
            window.open(getUrl() + '?with-history' + selection);
        }
        restoreDropDownTitle.call(this);
    });

    // hook Links item
    $('.incoming-links').on('click', function() { cmwell.utils.findAndShowIncomingInfotons(); });

    // hook Analytical menu
    $('.analytical-menu').on('change', function() {

        var field = $('.search-field-menu').val()
            , ap
            , exactOperator = $('#exact').prop('checked') ? '::' : ':'
            , aggType = +$(this).val()
            , qp = $('#term').val();

        qp = qp ? '&qp=_all:'+qp : '';

        switch(aggType) {
            case cmwell.enums.AggregationType.SignificantTerms:
                ap = 'type:sig,field' + exactOperator + field + ',size:16';
                break;
            case cmwell.enums.AggregationType.Distribution:
                ap = 'type:term,field' + exactOperator + field + ',size:16';
                break;
            case cmwell.enums.AggregationType.Histogram:
                ap = 'type:hist,field:' + field + ',interval:' + (prompt('Histogram Interval', '5') || '5'); //todo nicer input UI
                break;
            case cmwell.enums.AggregationType.Stats:
                ap = 'type:stats,field:' + field;
                break;
            case cmwell.enums.AggregationType.Cardinality:
                ap = 'type:card,field:' + field;
                break;
        }

        var req = getUrl() + '?format=json&op=aggregate&ap='+ap+qp
            , dialogTitle = '<span class="chart-title">Analytics for <span class="var">' + field + '</span>:<br/><span class="qtip-links"><span class="raw-data">raw data</span><span class="tabular-view">tabular view</span></span></span>'
            , dialog = $('<div><img class="loading-image" title="loading..." src="/meta/app/angular/images/loading.gif"/></div>').appendTo('body').dialog({ position: { my: "top+42", at: "top" }, show: {effect: 'fade'}, hide: { effect: 'fade' }, width: '50%', close: function() { dialog.remove(); }});

        $('span.ui-dialog-title').html(dialogTitle);

        $.getJSON(req)
            .fail(onError)
            .then(function(resp) {

            var res = cmwell.utils.extractDataFromAggregationResponse(resp)
                , markupData = [], dataForGraphs = {}, markup;

            _(res).each(function(part) {
                 switch(part.type) {

                    // todo add case ALL TYPES ?

                     case cmwell.enums.AggregationResponseType.SignificantTerms:
                         var fontFactor = 100, max = _(part.data).max();
                         _(part.data).each(function (v, k) { part.data[k] = fontFactor*v/max; });
                         dataForGraphs.wordCloud = part.data;
                         markupData.push({ title: 'Significant Terms', content: '<div class="svg"></div>'  });
                         break;

                     case cmwell.enums.AggregationResponseType.Term:
                         dataForGraphs.pie = _(part.data).map(function (v,k) { return { label: k, value: v }; });
                         markupData.push({ title: 'Distribution', content: '<div class="pie"><svg></svg></div>'  });
                         break;
                     case cmwell.enums.AggregationResponseType.Cardinality:
                         var title = 'Cardinality';
                        // fallthrough
                     case cmwell.enums.AggregationResponseType.Stats:
                         dataForGraphs.stats = part.data;
                         markupData.push({ title: title||'Statistics', content: '<div class="stats"></div>' });
                         break;
                     case cmwell.enums.AggregationResponseType.Histogram:
                         dataForGraphs.hist = [{key:field, values: _(part.data).map(function (v,k) { return { label: k, value: v }; }) }];
                         markupData.push({ title: 'Histogram', content: '<div class="hist"><svg></svg></div>'  });
                         break;
                     default:
                         throw new Error('Not implemented Aggregation Type');
                 }
             });

            $('.loading-image').hide();
            markup = cmwell.utils.generateTabsHtml(markupData);
            dialog.html(markup);

            if(markupData.length>1) {
                $('.tabs-in-dialog').tabs().parent().width('100%');
            } else {
                $('.chart-title').html($('.chart-title').html().replace('Analytics ', markupData[0].title + ' '));
            }

            $('.raw-data').qtip({
                position: {my:'top center',at:'center center',adjust:{y:-20}},
                style: {tip:{corner:false}},
                content: {title:{text:'Raw Data',button:true},text:'<pre><b>Request:</b><br/><a target="_blank" href="'+req+'">'+req+'</a><br/><br/><b>Response:</b><br/>'+JSON.stringify(resp,undefined,2)+'</pre>'},
                events: { render: function(event, api) { $(this).draggable({ containment: 'window', handle: api.elements.titlebar }); } },
                show: {event:'click'},
                hide: {event:'click'}
            });

            if(resp.AggregationsResponse && resp.AggregationsResponse[0] && resp.AggregationsResponse[0].buckets)
                $('.tabular-view').qtip({
                    position: {my:'top center',at:'center center',adjust:{y:-20}},
                    style: {tip:{corner:false}},
                    content: {title:{text:'Tabular View',button:true},text:cmwell.utils.objToTabularView(resp.AggregationsResponse[0].buckets)},
                    events: { render: function(event, api) { $(this).draggable({ containment: 'window', handle: api.elements.titlebar }); } },
                    show: {event:'click'},
                    hide: {event:'click'}
                });
            else
                $('.tabular-view').hide();

            if(dataForGraphs.pie) {
                cmwell.nvd3.addPieChart(dataForGraphs.pie, null, '.pie');
            }

            if(dataForGraphs.wordCloud) {
                cmwell.cloudLayout(dataForGraphs.wordCloud, '.svg');
            }

            if(dataForGraphs.stats) {
                var format = _.identity;
                if(cmwell.cache.fieldTypes[field]==='date') {
                    format = function (v,k) {
                        if(k==='sum') return 'N/A';
                        if(k==='count'||k==='cardinality') return v;
                        return new Date(v).toISOString();
                    }
                }
                $('.stats').html(_(dataForGraphs.stats).map(function(v,k) {
                    return '<b>'+k+'</b>:&nbsp;'+format(v,k)+'<br/>';
                }).join(''));
            }

            if(dataForGraphs.hist) {
                cmwell.nvd3.addBarChart(dataForGraphs.hist, '.hist');
            }

        });

        restoreDropDownTitle.call(this);
    });


    // hook dropdown menu: Search
    var validate = function() {
        $('.search-icon').css('opacity', $('#term').val() ? 1 : 0.4);
    };

    $('#term').on('keyup', validate);

    // hook suggestions for search term
    $('.search-field-menu').on('change', function(e){
        var fieldName = $(this).val()
            , source = cmwell.cache['Values_'+$scope.infoton.system.path+getOffset()][fieldName]
            , sanitizedSource = _(source).chain().map(function(v) { return _.isString(v) ? v.replace(/<\/?a.*?>/g,'') : v; }).uniq().value(); // removing <a href> and </a>

        $('.analytical-menu').removeAttr('disabled');

        $('#term').autocomplete({ source: sanitizedSource, minLength: 0, select: function(e, ui) {
            $('#term').val(ui.item.value);
            validate();
        } }).bind('focus', function(){ $(this).autocomplete("search"); } );
    });

    $('.search-menu-title').on('click', function() {
        $('.search-menu').slideToggle();
        return false;
    });

    cmwell.utils.onOutside(['.search', '.ui-autocomplete'], function() { $('.search-menu').slideUp(); });

    $('.search-field-menu').on('change', function() {
        $('li.analytical').attr('title', '');
        var fieldName = $(this).val();
        if(_(["number","date"]).contains(cmwell.cache.fieldTypes[fieldName])) {
            $('.analytical-menu .numerical').removeAttr('disabled');
            $('#exact').attr('disabled', true).prop('checked', true);
            $('.toolbar .info').empty();
        } else {
            $('.analytical-menu .numerical').attr('disabled', 'disabled');
            $('.toolbar .info').text(fieldName + ' is non-numerical,\nsome operations are not applicable.');
            $('#exact').removeAttr('disabled');
        }

        validate();
    });

    // hook Search icon click
    $('.search-icon').on('click', function() {
        if($(this).css('opacity')!=1)
            return;

        var field = $('.search-field-menu').val() || '_all';
        var term = $('#term').val();
        window.open(getUrl() + '?op=search&qp=' + field + ':' + encodeURIComponent(term));
    });

    var watchDom = function(selector, action, anyway) {
        $scope.$watch(function() { return $(selector).length; }, function(newLength, oldLength) {
            var isNewDiv = newLength > oldLength;
            if(isNewDiv || anyway)
                action();
        });
    };

    // resizable
    watchDom('.file', function() {
        if($('.file').length) {
            $('.navigation').css('border-right', '3px double grey').resizable({handles: 'e'});
            $('.ui-resizable-handle').on('mousedown', function() {
                $('.infoton-part-title:not(.collapsed)').click();
            });
        } else {
            $('.navigation').css('border-right', 'none');
        }
    }, true);

    // hook on items in folder - showing Floaty on hover
    $('#app-container')
        .on('mouseover', '.navigation .cmw-row', function() { $(this).find('.floaty, .link-infoton-target').css('display', 'inline-block'); })
        .on('mouseout', '.navigation .cmw-row', function() { $(this).find('.floaty, .link-infoton-target').css('display', 'none'); });


    // hook inline edit
    var onRawEditDone = function() {
        $('.raw-text').remove();
        $('#infoton-fields').show();
        $('#raw-edit').show().val('Raw Edit...');
        $('#cancel').hide();
        $('.edit-controls .warn').show();
    };
    $('#app-container')
    .on('click', '#cancel', onRawEditDone)
    .on('change', '#raw-edit', function() {
        $('.edit-controls .result').remove();
        if($('.raw-text').length) {
            onRawEditDone();
            return;
        }

        var fmt = $('#raw-edit').val();
        $('.edit-controls .warn').hide();
        $(this).hide();
        $('#cancel').show();
        $('#infoton-fields').hide().parent().prepend('<textarea class="raw-text">(loading...)</textarea>');
        $.get($scope.infoton.path+'?format='+fmt+'&override-mimetype=text/plain%3Bcharset=utf-8').then(function(rdfText){
            //n3 = _(n3.split('\n')).filter(function(line){ return line.replace('@prefix','').trim().indexOf('sys:')!=0; }).join('\n');
            $('.raw-text').text(rdfText);
        });
    })
    .on('click', '#commit', function() {
        $('.edit-controls .result').remove();
        var rdfText = $('.raw-text');
        if(rdfText.length) {
            var fmt = $('#raw-edit').val();
            $.ajax({type: 'POST', url: '/_in?format='+fmt+'&replace-mode', data: rdfText.val(), contentType: 'text/plain'})
                .done(function() {
                    $('.edit-controls').prepend('<div class="result">Completed successfully</div>');
                    onRawEditDone();
                })
                .fail(function(error){
                    error = JSON.parse(error.responseText);
                    error = error.error || error.message;
                    $('.edit-controls').prepend('<div class="result err">Error: '+error+'</div>');
                });
        } else {

            var newObj = {};
            $('#infoton-fields tr:not(.new-value)').each(function(){
                var tds = $(this).find('td'), values=[];
                $(tds[1]).find('li').each(function(){values.push($(this).text());});
                newObj[$(tds[0]).text().split(".")[0]]=values;
            });

            var infoton = $scope.infoton || $scope.infotons[0];
            $.getJSON('/ii/'+(infoton.uuid||infoton.system.uuid)+'?format=jsonld').then(function(jsonLd) {
                jsonLd = { "@id": jsonLd["@id"],
                           "@context": _(jsonLd["@context"]).filterObj(function(v){return _(v).isString() && (v.indexOf("/meta/sys#")===-1 || v.indexOf("/meta/sys#path")!==-1); }),
                           path: jsonLd.path
                    };
                var data = _(jsonLd).extend(newObj);

                $.ajax({type: 'POST', url: '/_in?format=jsonld&replace-mode', data: JSON.stringify(data)})
                    .done(function(){
                        $('.edit-controls').prepend('<div class="result">Completed successfully</div>');
                    })
                    .fail(function(error){
                        error = JSON.parse(error.responseText);
                        error = error.error || error.message;
                        $('.edit-controls').prepend('<div class="result err">Error: '+error+'</div>');
                    });
            });
        }
    })
    .on('click', '.hidden-door', function() {
            cmwell.utils.showStatus('Edit Mode enabled');
            $(this).fadeOut();
            cmwell.editMode=true;
        });

    $scope.editMode = cmwell.editMode;

    if(cmwell.editMode) //todo refactor: 1. move ajax calls to services.js, 2. get rid of some callback-hell
        $(document).on('click', '.editable-value', function() {

        var $this=$(this);
        if($this.find('input').length || $this.text()==='...')
            return;

        $this.removeClass('err');

        var oldValue = $this.text()
        , done = function(e) {
            if(e.keyCode === 27) { // ESC
                $this.text(oldValue);
                return;
            }

            if (!(e.type === 'blur' || e.keyCode === 13)) // un-focus or Enter
                return;

            var newValue = this.value
                , key = $this.closest('tr').find('td:first').text();

            if(!newValue || oldValue===newValue) {
                $this.text(oldValue);
                return;
            }

            if(!key) {
                // user has entered a new key --> value is the new key, key is an empty string
                $this.text(newValue);
                return;
            }

            if($this.parent().hasClass('new-value'))
                $this.html('<ul><li>'+newValue+'</li></ul>').parent().removeClass('new-value').parent().append('<tr class="new-value"><td class="editable-value">+</td><td class="editable-value"></td></tr>');
            else
                $this.text(newValue);
        };

        var text = $this.text();
        if(text==='+') text = '';
        var hackToPlaceCursorAtEndOfInput = 'onfocus="this.value=this.value;"';
        $this.html('<input value="'+text+'" '+hackToPlaceCursorAtEndOfInput+'/>');
        $($this.find('input')).focus().on('keyup blur', done);
    });

    // hook quad click
    $('#app-container').on('click', '.quad', function() {
        var quad = cmwell.cache.quads.data[$(this).data('quad')];
        if(quad.path) {
            cmwell.utils.navigate(quad.path);
        } else {
            $('.copy-to-clipboard-util').remove();
            $(this).parent().append('<input class="copy-to-clipboard-util" value="'+$(this).data('quad')+'" style="font-size:smaller;width:100%;"/>'); $(this).parent().find('input').select();
        }
    });
    $('#app-container').on('keydown', '.copy-to-clipboard-util', function(e) {
        var ctrl=17
            , self = $(this);
        if(e.keyCode!==ctrl)
            setTimeout(function() { self.remove(); }, 100); // using setTimeout so at the time of CTRL+C click the text is still shown
    });

    // hook greyed lock click (AKA login button)
    $('#app-container').on('click', '.lock.greyed', function(e) {
        cmwell.utils.navigate('/_login');
    });

    // hook navi-fields more button
    $('#app-container').on('click', '.fields-navi .more', function() {
        $(this).fadeOut().parent().animate({ 'max-height': '256px' }, 613, function() { $(this).css({'overflow-y': 'scroll'}); });
    });

    cmwell.utils.checkConnectivity();
})

.controller('headerDataController', function($scope, infotonService) {
    $scope.headerData = {
        buildVersion: 'N/A',
        buildRelease: ''
    };

    infotonService.getInfoton('proc/node')
        .then(function(procNode) {
            var f = procNode.fields;
            if(!f) return;

            $scope.headerData = {
                buildVersion: f['cm-well_version.nn'][0].value,
                buildMachine: f['build_machine.nn'][0].value,
                buildTime:    f['build_time.nn'][0].value,
                buildRelease: f['cm-well_release.nn'][0].value
            };

            $('.release-name').fadeIn(500);
        });
})

.controller('dashboardController', function($scope, infotonService) {
    $scope.dashboardData = {
        a: "b"
    };

    $scope.cas = "Hello World";
    $scope.tableData = cmwell.utils.objToTabularView([{name:'Yaakov',age:29,email:'tms'},{name:'Michael',age:28,email:'tms1'}], ['age','name']);

//    infotonService.getInfoton('proc/node')
//        .success(function(procNode) {
//            var f = procNode.fields;
//            if(!f) return;
//
//            $scope.headerData = {
//                buildVersion: f['cm-well_version'],
//                buildMachine: f['build_machine'],
//                buildTime:    f['build_time']
//            };
//
//        });




})

.controller('authController', function($scope, $http, infotonService, $routeParams) {
    $scope.username = cmwell.loggedInUser;
    $scope.landing = $routeParams.landing || '';

    infotonService.getInfoton('meta/auth/users/'+$scope.username).then(function(resp) {
        $scope.permissions = JSON.parse(resp.system["data.content"]).paths;
        // todo add Roles, Operations...
    });

    $scope.changePassword = function() {
        var ajaxDone = function() { $scope.$apply(function(){ $scope.whenLoading = false; }); };

        $scope.whenLoading = true;
        $.get('/_auth?op=change-password&current='+$scope.current+'&new='+$scope.new1).then(function() {
            ajaxDone();
            cmwell.utils.showStatus('Password was changed successfully.', 3000, 'green');
        }).fail(function() {
            ajaxDone();
            cmwell.utils.showStatus('Something went wrong when trying to change password', 3000, 'maroon');
        });
    };

    $scope.toggleTextPassword = function() {
        $scope.textPasswordState = !$scope.textPasswordState;
        $('input').attr('type',$scope.textPasswordState?'text':'password');
    };

    $scope.logout = function() {
        cmwell.utils.clearToken();

        $http.defaults.headers.get = cmwell.token;
        $.ajaxSetup({ headers: cmwell.token });

        cmwell.utils.navigate('/');
    };

    cmwell.utils.checkCapslock('input[type=password]', function(capsLockStatus) { $scope.capsLock = capsLockStatus; });
})

//.controller('loginController', function($scope, $routeParams, $http) {
//    $scope.landing = $routeParams.landing;
////    var landing = $routeParams.landing ? '?landing='+$routeParams.landing : '';
//
//    var displayErrMsg = function() { cmwell.utils.showStatus('Failed to login', 2000, 'maroon'); }
//    , login = function(headers) {
//
//        $.ajax({ url: "/_login", type: "GET", headers: headers }).then(function(res) {
//            if(res.token) {
//                $http.defaults.headers.get = cmwell.token;
//                $http.defaults.headers.post = cmwell.token;
//                $.ajaxSetup({ headers: cmwell.token });
//
//                cmwell.utils.updateToken(res.token, $scope.rememberme);
//                cmwell.utils.navigate('/_auth'+landing);
//            } else {
//               displayErrMsg();
//            }
//        }).fail(displayErrMsg);
//    };
//
//    $scope.login = function() {
//        login({ "Authorization" : "Basic " + btoa($scope.username+":"+$scope.password) });
//    };
//
//    $scope.loginDigest = function() {
//        // server by default will return 401 WWW-Authenticate: "Digest ... <challenge>" and browser will calculate the hashed `response`.
//        login();
//    }
//
//    cmwell.utils.checkCapslock('input[type=password]', function(capsLockStatus) { $scope.capsLock = capsLockStatus; });
//
//})

.controller('uploadController', function($scope, $http) {
    $scope.formats = cmwell.formats;
    $scope.uploadProgress = 0;

    var text = $('textarea')
        , button = $('button')
        , formatDropdown = $('select')

    , enableUpload = function() {
        button.prop('disabled', '').removeAttr('title').text('Upload');
    }

    , handleFileSelect = function (evt) {
        evt = evt.originalEvent;

        evt.stopPropagation();
        evt.preventDefault();

        text.removeClass('hovered-with-file');

        formatDropdown.find('option').removeAttr('selected');
        formatDropdown.find('option[value=Format]').attr('selected', 'selected');
        button.prop('disabled', 'disabled').attr('title', 'Please choose format first');

        var file = evt.dataTransfer.files[0]
            , reader = new FileReader()
            , ext = file.name.substr(file.name.lastIndexOf('.')+1).toLowerCase();

         $scope.format = _(cmwell.formats).find(function(fmt) {
                return _.isArray(fmt.fileExt) ? _(fmt.fileExt).contains(ext) : fmt.fileExt === ext;
            });

        if($scope.format) {
            $scope.format = $scope.format.value;
            formatDropdown.find('option').removeAttr('selected');
            formatDropdown.find('option[value=' + $scope.format + ']').attr('selected', 'selected');
            enableUpload();
        };

        if(file.size > 1000*1024) { // more than 1MB
            text.val('The file ' + file.name + ' is too large to be displayed here, but will be uploaded.').css('color', 'purple');
            $scope.file = file;

            if(_(['ntriples','nquads']).contains($scope.format))
                $scope.chunkMode = true;

            return;
        }

        text.css('color', '');
        reader.onload = function(event) { text.val(event.target.result); };
        reader.readAsText(file, "UTF-8");
    }

    , uploadByChunks = function() {

        // *** assuming input file is sorted!!! ***

        // /_in should never receive more than one POST sharing the same Subject at a certain time window
        // so processChunk() below takes the tail of any chunk (but the last one), subject-wise, and concatenates it to the next chunk.
        // Moreover, chunks might cut a Triple or a Quad, and that is handled in that function as well.

        // logic:
        // use FileReader to read file chunk by chunk. for each chunk:
        // split('\n')
        // tail out the last subject and store it in a local variable (probably an infoton that was cut in the middle)
        // repeat for next chunk, and post that local variable + processed chunk
        // assuming last chunk size is smaller, do not cut its tail :) if you're asking what if it's exactly divisible by chunkSize, no worries, in that case the last post's payload will be a bit bigger. no big deal.

        // one last thing - note about async stuff:
        // $.ajax is async and I don't care about it, it's totally fine.
        // fileReader.readAsText is async, but I don't want the next chunk to be read from file until the current one is done,
        // so I used that handleChunk function below, which is a blocking call. Credit goes to this answer: http://stackoverflow.com/a/28318964/4244787

        // yet another one last thing - RAM consumption won't exceed chunkSize*maxParAjaxes.
        // Browsers limit the number of active ajaxes, but it won't stop JS from firing them into "Pending" state.
        // Each ajax data is kept in memory, so we must not read file as fast as we can from disk.
        // How is it implemented? Glad you asked:
        // fileReader won't ask for next chunk unless there less than maxParAjaxes at the moment.
        // you can think of it as a semaphore, or as a pushback pressure mechanism.

        // todo - One possible improvement is to take all this work into a Worker.
        // todo   Angular may use Workers encapsulated in a Service call, using promises.
        // todo   It might lower the CPU consumption, so it's worth give it a shot.


        var chunkSize = 100*1024 // 100KB
            , offset = 0
            , fileReader = new FileReader()
            , tail = []
            , wasErrorOccurred = false
            , ajaxes = []
            , maxParAjaxes = 7
            , done = false
            , elapsed = 0
            , started = +(new Date)
            , eta = 0
            , ignoreErrors = $('#ignore-errors').is(":checked")
            , forceParam = $('#use-the-force').is(":checked") ? '&force' : ''
            , updateEta = _.throttle(function(){ $scope.eta = cmwell.utils.humanize(eta); }, 2000)
            , processChunk = function(chunk, isLast) {

                chunk = (tail.join('\n')+chunk).split('\n');
                tail = [];

                if(!isLast) {
                    var sameSubject = true, index = chunk.length-1,
                        getSubject = function (tripleOrQuad) {
                            return tripleOrQuad.substr(1, tripleOrQuad.indexOf('> <') - 1);
                        };
                    while(sameSubject) {
                        var line = chunk[index--], corruptedLine = !line.endsWith(".");
                        tail.unshift(line);
                        sameSubject = corruptedLine || getSubject(chunk[index]) === getSubject(line);
                    }
                    chunk.splice(index+1);
                }

                ajaxes.push($http({ method: "POST", url: '/_in?format='+$scope.format+forceParam, data: chunk.join('\n'), headers: {'Content-Type': 'text/plain' } })
                    .success(function() {
                        ajaxes.pop();
                        var progressPercent = Math.min(100, offset*100/$scope.file.size).toFixed(2);
                        $scope.uploadProgress = progressPercent;
                        $('.upload-progress .bar').width(progressPercent+'%');

                        elapsed = +(new Date) - started;
                        eta = (elapsed/progressPercent)*(100-progressPercent);
                        updateEta();

                        if(ajaxes.length < maxParAjaxes && offset < $scope.file.size && !wasErrorOccurred && fileReader.readyState == FileReader.DONE)
                            getNextChunk();
                        else if(offset >= $scope.file.size && !done) {
                            done = true;
                            setTimeout(function () { onUploadComplete(wasErrorOccurred); }, 0);
                        }

                    }).error(function(data) {
                        ajaxes.pop();

                        if(ignoreErrors)
                            return;

                        $('.upload-progress .bar').css('background', 'red');
                        showAjaxError(data);
                        enableUpload();
                        wasErrorOccurred = true;
                    })
                );

            }
            , handleChunk = function(evt) {
                if (evt.target.error || fileReader.readyState != FileReader.DONE) {
                    cmwell.utils.showStatus('File read error', 5000, 'maroon');
                    enableUpload();
                    return;
                }

                offset += chunkSize;
                var isDone = offset >= $scope.file.size;
                processChunk(evt.target.result, isDone);

                if(ajaxes.length < maxParAjaxes && !isDone && !wasErrorOccurred)
                    getNextChunk();

            }
            , getNextChunk = function() {
                fileReader.readAsText($scope.file.slice(offset, offset+chunkSize), "UTF-8");
            };

        $('.upload-progress').show();
        fileReader.onloadend = handleChunk;
        getNextChunk();
    }

    , uploadTextOrFile = function() {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", "/_in?format="+$scope.format, true);
        _(cmwell.token).each(function(v,k) { xhr.setRequestHeader(k, v); });
        xhr.onerror = function() {
            cmwell.utils.showStatus('Upload could not be completed at this time.', null, 'maroon');
            // not resetting form, allowing user to modify inputs and try again
            enableUpload();
        };
        xhr.onload = function() {
            if(this.status!=200) {
                showAjaxError(this);
                enableUpload();
                return;
            }

            onUploadComplete();
        };
        xhr.send($scope.file || text.val());
    }

    , showAjaxError = function(err) {
        var errMsg = JSON.tryParse(err.responseText);
        errMsg = errMsg ? errMsg.error : err.responseText || err.error;
        cmwell.utils.showStatus(errMsg, null, 'maroon');
    }

    , onUploadComplete = function(failure) {
        if(!failure)
            cmwell.utils.showStatus('Upload completed successfully!', 6000, 'green');

        cmwell.utils.navigate('/_upload'); // ugly way to reset form
    };


    // hook events handlers:

    text.on({
        dragover: function() { text.addClass('hovered-with-file'); },
        dragleave: function() { text.removeClass('hovered-with-file'); },
        drop: handleFileSelect,
        keypress: function() {
            $scope.file = undefined;
            text.css('color', '');
        }
    });

    formatDropdown.on('change', function() {
        $scope.format = this.value;
        enableUpload();
    });

    button.on('click', function() {
        button.text('uploading...').prop('disabled', 'disabled');
        if($scope.chunkMode) uploadByChunks(); else uploadTextOrFile();
    });
})

.controller('jwtdebugController', function($scope) {
    $scope.parse = function(part) {
        if(!part) return '';
        try { return JSON.stringify(JSON.parse(atob(part)),null,2); } catch(e) { return '(JWT is invalid)'; }
    };

    $scope.asObj = function(part) {
        try { return JSON.parse(atob(part)); } catch(e) { return {}; }
    };

    $scope.toDate = function(value, title) {
        return value ? (title||'') + new Date(value) : '';
    };
})

.controller('spController', function($scope) {
    
    var yasqe = YASQE.fromTextArea($('#query')[0]);
    
    var root = $('.sp')
        , isChecked = function(checkboxId) {
            return root.find('#'+checkboxId).is(":checked");
        }
        , buildQueryString = function() {
            var format = root.find('#format').val()
                , keys = [ 'quads', 'verbose', 'show-graph' ];

            return '?format=' + format + keys.reduce(function(m,n) { return m+(isChecked(n)?'&'+n:''); }, '');
        };

    root.find('button').on('click', function(e) {
        var curlMode = e.shiftKey
            , url = '/_sp' + buildQueryString()
            , paths = root.find('#urls').val()
            , query = yasqe.getValue()
            , ql = root.find('#ql').val()
            , data;

        if(curlMode) query = query || 'SELECT * WHERE { ?s ?p ?o }';

        paths = paths.endsWith('\n') ? paths : paths+'\n';

        if(isChecked('visualize'))
            cmwell.utils.fetchAndVisualizeRdf(paths);

        data = 'PATHS\n'+paths+'\n'+ql+'\n'+query;

        if(curlMode) {
            root.find('.results textarea').show().text('curl -XPOST \'' + location.host + '/_sp' + buildQueryString() + '\' -H "Content-Type:text/plain" --data-binary \'' + data + '\'');
            return;
        }

        root.find('.results .loading').show();
        root.find('button').prop('disabled', 'disabled');

        var showResp = function(resp) {
            root.find('.results .loading').hide();
            root.find('button').prop('disabled', '');

            resp = resp.trim();

            root.find('.results textarea').show().text(resp).css('color', resp.startsWith("An error occurred:")?'maroon':'black');
            root.find('.pop-out').show();
        };

        $.ajax({type: 'POST', url: url, data: data, headers: { 'Content-Type': 'text/plain' } })
            .then(function(resp) { showResp(resp); })
            .fail(function(error) { showResp(error.responseText); });
    });

    var fixInput = function() {
        var paths = root.find('#urls').val();
        paths = paths.replace(new RegExp(location.origin,'g'),'');
        root.find('#urls').val(paths);
    }
        , debouncedFixInput = _.debounce(fixInput, 300)
        , onInputChange = function() { $('.results textarea, .results .pop-out').fadeOut(600); debouncedFixInput(); };


    root.find('textarea').on({ keydown: onInputChange, change: onInputChange, keyup: onInputChange, paste: onInputChange });
    root.find('.pop-out').on('click', function() {
        var w = window.open('about:blank'), d = w.document;
        d.write('<pre></pre>');
        $('pre', d).text(root.find('.results textarea').text());
    });
})








.controller('sparqlController', function($scope) {

    var root = $('.sp');

    var yasqe = YASQE.fromTextArea($('#query')[0], { viewPortMargin: Infinity });
    
    root.find('button').on('click', function(e) {
        var curlMode = e.shiftKey
            , url = '/_sparql'
            , query = yasqe.getValue();

        if(curlMode) query = query || 'SELECT * WHERE { ?s ?p ?o }';

        if(curlMode) {
            root.find('.results textarea').show().text('curl -XPOST \'' + location.host + '/_sp' + buildQueryString() + '\' -H "Content-Type:text/plain" --data-binary \'' + data + '\'');
            return;
        }

        root.find('.results .loading').show();
        root.find('button').prop('disabled', 'disabled');

        var showResp = function(resp) {
            root.find('.results .loading').hide();
            root.find('button').prop('disabled', '');

            resp = resp.trim();

            root.find('.results textarea').show().text(resp).css('color', resp.startsWith("An error occurred:")?'maroon':'black');
            root.find('.pop-out').show();
        };

        $.ajax({type: 'POST', url: url, data: query, headers: { 'Content-Type': 'text/plain' } })
            .then(function(resp) { showResp(resp); })
            .fail(function(error) { showResp(error.responseText); });
    });

    var fixInput = function() {
        var paths = root.find('#urls').val();
        paths = paths.replace(new RegExp(location.origin,'g'),'');
        root.find('#urls').val(paths);
    }
        , debouncedFixInput = _.debounce(fixInput, 300)
        , onInputChange = function() { $('.results textarea, .results .pop-out').fadeOut(600); debouncedFixInput(); };


    root.find('textarea').on({ keydown: onInputChange, change: onInputChange, keyup: onInputChange, paste: onInputChange });
    root.find('.pop-out').on('click', function() {
        var w = window.open('about:blank'), d = w.document;
        d.write('<pre></pre>');
        $('pre', d).text(root.find('.results textarea').text());
    });
})


.controller('adddnController', function($scope) {
    var isValid = function() { return $('#typerdf').val() && $('#dns').val(); }
        , $dns = $('#dns')
        , $typerdf = $('#typerdf')
        , $submit = $('#submit');
    
    $('#dns, #typerdf').on('keyup', function() {
        if(isValid())
            $submit.removeAttr('disabled');
        else
            $submit.attr('disabled', 'disabled');
    });
    
    $('#submit').on('click', function() {
        var type = $typerdf.val()
            , dns = _($dns.val().replace(/\r/g,'').split('\n')).compact()
            , path = '/meta/dn/'+md5(type)
            , dataObj = {};
        
        dns.forEach(function(e,i) { dataObj['displayName'+(i+1)] = e; });
        dataObj['forType'] = type;
        
        $.ajax({type: 'POST', url: path, data: JSON.stringify(dataObj), headers: { "X-CM-WELL-Type": "Obj" } })
            .then(function(resp)  { cmwell.utils.showStatus("Display Name was added.", 3000, 'green'); })
            .fail(function(error) { cmwell.utils.showStatus("Failed to add Display Name. Reason: " + error.responseText, 7000, 'maroon'); });
    });
})

.config(function($routeProvider, $locationProvider, $httpProvider) {
    var routeObj = {
       templateUrl: '/meta/app/angular/views/main.html?override-mimetype=text/html',
       controller: 'infotonsController'
    };

    var standardViewWithCtrlr = function(name) {
        return {
            templateUrl: '/meta/app/angular/views/'+name+'.html?override-mimetype=text/html',
            controller: name+'Controller'
        };
    };

    $httpProvider.defaults.headers.common['Accept'] = '*/*';

    $routeProvider
        .when('/_field/:field/:value', routeObj)
        .when('/_field/:field/:value/:infotonPath*', routeObj)
        .when('/:infotonPath*\?length=:length&offset=:offset*', routeObj)
        .when('/_auth/', standardViewWithCtrlr('auth'))
        .when('/_jwtdebug/', standardViewWithCtrlr('jwtdebug'))
        .when('/_upload/', standardViewWithCtrlr('upload'))
        .when('/_sp/', standardViewWithCtrlr('sp'))
        .when('/_sparql/', standardViewWithCtrlr('sparql'))
        .when('/_adddn/', standardViewWithCtrlr('adddn'))
        .when('/_vld/', {templateUrl: '/meta/app/angular/views/vld.html?override-mimetype=text/html' })
        .when('/_vld/:infotonPath*', {templateUrl: '/meta/app/angular/views/vld.html?override-mimetype=text/html' })
        .when('/dashboard', {templateUrl: '/meta/app/angular/views/dashboard.html?override-mimetype=text/html', controller: 'dashboardController' }) // might as well be standardViewWithCtrlr('dashboard')
        .when('/:infotonPath*\?op=search&qp=:qp*', routeObj)
        .when('/:infotonPath*', routeObj)
        .when('/', routeObj)

        ;

    $locationProvider.html5Mode(true);
  })

;
