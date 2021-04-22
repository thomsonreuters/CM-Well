if(typeof cmwell === "undefined") cmwell = {};


/**********************

 cmwell.LightWeightTemplateEngine (why? because we can.)

    Example:
        Markup: <span class="code">Your URL is {{ cmwellUrl }}</span>
        Script: cmwell.LightWeightTemplateEngine.tmpl('.code');

**********************/

(function(){

    // todo take the datasource to an external file for friendly update by upload?
    var datasource = {

        cmwellUrl: location.host,

        // ... more variables are welcome

    }

    , materializePlaceHolders = function(text) {
        return text.replace(/{{(.*?)}}/g, function(m, c) { return datasource[c.trim()] || ''; });
    };

    cmwell.LightWeightTemplateEngine = {
        tmpl: function(selector) {
            var $el = $(selector);
            if(!$el.length) return;

            $el.html(materializePlaceHolders($el.html()));
        },
        strTmpl: function(text) {
            return materializePlaceHolders(text);
        }
    };

})();