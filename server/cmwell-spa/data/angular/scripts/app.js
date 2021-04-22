if(typeof cmwell === "undefined") cmwell = { }

cmwell.boot = function() {
    cmwell.app = angular.module('cmwellAngApp', [
        'ngRoute',
        'ngSanitize',
        'cmwellAngApp.controllers',
        'cmwellAngApp.services',
        'ui.bootstrap'
    ])


        .filter('isArray', function () {
            return function (input) {
                return angular.isArray(input);
            };
        })

        // usage: for arrays of objects, only return those which has isWhat
        .filter('is', function () {
            return function (arr, what) {
                return _(arr).filter(function(item){return item['is'+what];});
            };
        })

        .filter('isEmptyObj', function () {
            return function (obj) {
                return _(obj).isEmpty();
            }
        })

        .filter('toFloatyMarkup', function () {

            var tooltips = {
                rss: 'RSS',
                'with-history': 'History',
                'diff-view': 'History (Diff. View)',
                markdown: 'Markdown',
                'plain-text': 'Plain Text',
                view: 'Use this WebApp'
            };

            return function (data) {
                return _(data).map(function (icon) {
                    return '<span title="' + tooltips[icon] + '" class="floaty-icon ' + icon + '"></span>';
                }).join('');
            };
        })

        .filter('markdownToHtml', function ($sce) {
            return function (markdown) {
                return $sce.trustAsHtml(cmwell.utils.toMarkdown(markdown));
            };
        })

        .filter('rdfValueToHtml', function ($sce) {
            return function (rdfValue) {
                var extendsQuadCacheIfNeeded = function() {
                        cmwell.utils.whenOrResult(cmwell.cache.quads.getOrAdd(rdfValue.quad), function(quadObj) {
                            if(!_.isEmpty(quadObj))
                                $('.quad[data-quad=\''+rdfValue.quad+'\']').text(quadObj.alias).addClass('tag');
                        });
                    }
                , q = rdfValue.quad
                , markup = rdfValue.value +
                    (q ? '<span class="quad" data-quad="'+q+'" title="'+q+'"><img width="18px" src="/meta/app/angular/images/graph.svg"/></span>' : '');
                    // + (rdfValue.type ? '<span class="tag" title="Type='    + rdfValue.type + '">'+rdfValue.type+'</span>' : '')
                    // + (rdfValue.lang ? '<span class="tag" title="Lang='    + rdfValue.lang + '">'+rdfValue.lang+'</span>' : '')

                if(q) _.defer(extendsQuadCacheIfNeeded);

                return $sce.trustAsHtml(markup);
            };
        })

        .filter('visibleSystemFields', function() {
            return function(sysObj) {
                if(!sysObj) return;
                var res = {};
                _(['lastModified','parent','path','uuid','size']).each(function(k){ if(sysObj[k]) res[k]= sysObj[k]; });
                return res;
            };
        })

        .filter('asDate', function() { return function(d) { return new Date(d||0).toISOString(); } })

        .filter('toHtml', function ($sce) {
            return function (html) {
                return $sce.trustAsHtml(html);
            };
        })

        .directive('ellipsis', function () { // usage: <span ellipsis> content </span> OR: <span ellipsis="50"> content </span>
            return {
                link: function (scope, element, attrs) {
                    var text = scope.$eval(element.text().replace(/[\{\}]/g, ''))
                        , size = +attrs.ellipsis || cmwell.constants.ellipsisLength;

                    if (text.length > size) {
                        element.attr('title', text);
                        element.text(text.substr(0, size) + '...');
                    }
                }
            };
        })

        .directive('cmwellPager', function () {
            return {
                scope: false, // use outer $scope
                templateUrl: '/meta/app/angular/views/pager.html?override-mimetype=text/html'
            };
        })

        .directive('cmwellNaviFields', function () {
            return {
                scope: false, // use outer $scope
                templateUrl: '/meta/app/angular/views/fields-navi.html?override-mimetype=text/html'
            };
        })

        .directive('vitalSign', function () {
            return { template: '<!-- spa_vital_sign -->' };
        })
    ;

    var recording = false;
    $(document).keypress(function (e) {
        var key = e.charCode
            , equals = 61
            , slash = 47
            , backSlash = 92
            , enter = 13
            , minus = 45
            , i = 105
            , f = 102
            , div = $('.typed-url');
        
        if(key==i) {
            $('#ignore-errors').parent().fadeIn();
        }

        if(key==f) {
            $('#use-the-force').parent().fadeIn();
        }

        if(key==minus) {
            var linksNavigationCurrentRootNode = d3.select('.o-tree:not(.disabled) .node.root').node();
                if(linksNavigationCurrentRootNode && d3.selectAll('.node')[0].length>2)
                    linksNavigationCurrentRootNode.__onclick(true);
        }

        if ((key == slash || key == backSlash) && !_(['text','textarea']).contains(e.target.type))
            recording = true;

        if (recording) {
            if (key == equals) { // backspace replacement
                var text = div.text();
                div.text(text.substring(0, text.length - 1));

                if (!div.text())
                    recording = false;

                return;
            }
            div.append(String.fromCharCode(key === backSlash ? slash : key));

            if (key == enter) {
                if(div.text().trim()==='/_R') { // todo: is this feature broken?
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', '/?recursive&op=stream', true);
                    xhr.send(null);
                    setTimeout(function() {
                        var lines = _.compact(xhr.responseText.split('\n'));
                        if(xhr.readyState == XMLHttpRequest.DONE) {
                            cmwell.utils.navigate(lines[lines.length*Math.random()|0]);
                        } else {
                            xhr.abort();
                            cmwell.utils.navigate(lines[lines.length-1]);
                        }
                    }, 100+Math.random()*1400);
                } else {
                    cmwell.utils.navigate(div.text());
                }
                div.empty();
                recording = false;
            }
        }
    });

    $(document).keydown(function (e) {
        if (e.keyCode == 27) { // ESC
            $('.typed-url').empty();
            recording = false;

            $('.ui-dialog-content').dialog('close').remove();
            $('.qtip').remove();
        }
    });

    // Markdown Converter initialization
    cmwell.markdownConverter = new Markdown.Converter();
    Markdown.Extra.init(cmwell.markdownConverter);
    
    // allow drop-files-to-upload
    $('body')
    .on('drag dragstart dragend dragover dragenter dragleave drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
      })
    .on('dragover', function() { $('.status-bar').html('DROP TO UPLOAD');  })
    .on('dragend drop dragleave', function() { $('.status-bar').empty(); })
    .on('drop', function(e) {
        var fl = e.originalEvent.dataTransfer.files;
        _.range(fl.length).map(function(i){ return fl.item(i); }).forEach(function(file) { 
            $.ajax({
                url: location.pathname + '/' + file.name,
                type: "POST",
                headers: { 'x-cm-well-type': 'file' },
                contentType: file.type,
                data: file,
                processData: false
            })
            .then(function(){ cmwell.utils.showStatus('Uploading ' + file.name + ' completed!', 1500, 'green'); })
            .fail(function(){ cmwell.utils.showStatus('Failed uploading ' + file.name + '.', 1500, 'maroon'); });
        });
    });
    
    
};
