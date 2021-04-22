/**
 * Created by yaakov on 1/27/15.
 *
 * Scripts on this file are __experimental features__ written in __quick-n-dirty__ coding style. // Gloves off, game on!
 *
 */

if(typeof cmwell === "undefined") cmwell = {};

cmwell.historyViewer = {
    show: function(infotonPath) {
        var params = '?format=json&with-history&with-data'
            , chew = function(resp) {
                var toText = function(v) {
                        var removeOverhead = function(jsonText) {
                                return _(jsonText.split('\n')).chain().filter(function(line){
                                    return !_(['{','}','[',']','},']).contains(line.trim());
                                }).map(function(line){
                                    return line.replace('": [','').replace('",','').replace(/\"/g,'');
                                }).value().join('\n');
                            }
                        , sortedObj = v.fields ? _(v.fields).chain().keys().sortBy(_.identity).map(function(k){
                            var entry = {}; entry[k] = _(v.fields[k]).sortBy(_.identity); return entry;
                        }).value() : 'Infoton was deleted or uploaded without fields';
                        return {
                            text: removeOverhead(JSON.stringify(sortedObj,null,2)),
                            date: new Date(v.system.lastModified)
                        };
                    }
                    , versions = _(resp.versions).chain().sortBy(function(v) { return new Date(v.system.lastModified); }).map(toText).value()
                    , diffs = [];

                for(var i=1;i<versions.length;i++) diffs.push({old:versions[i-1].text,new:versions[i].text,oldWhen:versions[i-1].date,newWhen:versions[i].date});
                return diffs;
            }
            , render = function(diffs, selector) {
                _(diffs).each(function(diff){
                    var base = difflib.stringAsLines(diff.old)
                        , newtxt = difflib.stringAsLines(diff.new)
                        , sm = new difflib.SequenceMatcher(base, newtxt)
                        , opcodes = sm.get_opcodes(); // ha! did ya hear that? this little ui plugin is a machine-language-wannabe... well, aim for the sky they say :)

                    $(selector).append(diffview.buildView({
                        baseTextLines: base,
                        newTextLines: newtxt,
                        opcodes: opcodes,
                        baseTextName: diff.oldWhen,
                        newTextName: diff.newWhen,
                        viewType: 0 // "side by side" (not inline)
                    }));
                });

                // fine tuning ui stuff
                $(selector+' tbody').find('th').remove(); // remove line numbers
                $(selector+' thead').find('th:even').remove(); // ... and adjust headers

                // ok, here's the deal. the difflib yields a <table> per diff. We rather want a vector of N versions.
                // so once we have N-1 diff tables (such that for each i in 1..N-1: D[i].right==D[i+1].left),
                // we are going to simply hide the left column for each i in 2..N-1, and float:left everything with no spacing so it will look like a vector
                $(selector+' table:not(:first) tr').find('td:first,th:first').remove();

                // we want to make the field names bold, the only way I can distinct Fields from Values is textual... Values start with more than 4 spaces.
                var isFieldName = function() { return this.innerHTML.substr(0,5).trim(); };
                $(selector+' td').filter(isFieldName).css('font-weight','bold');

                // adding a scrollbar - since we have many tables which are float:left and we want overflow-x:scroll, we must programatically adjust width of a wrapper div :(
                var width = _.sum($('table.diff').map(function(){return $(this).width();})) + 10;
                $(selector).html('<div id="history-wrapper">' + $(selector).html() + '</div>');
                $('#history-wrapper').width(width);
            };

        $.getJSON(infotonPath+params).then(function(resp) {
            var diffs = chew(resp), divId='history-view', selector = '#'+divId;

            $(selector).remove(); // if was previous
            $('<div id="'+divId+'"></div>').appendTo($('body')).append('<h3>History view for '+infotonPath+'</h3><div class="close">X</div><div class="data"></div>');
            $(selector + ' .close').on('click', function() { $(selector).remove(); });

            if(diffs.length)
                render(diffs, selector+' .data');
            else
                $(selector).append('<p><i>No changes have been made since first upload</i></p>');

            $(selector).draggable({handle: "h3"});
        });
    }
};
