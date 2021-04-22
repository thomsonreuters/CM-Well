(function(){

    
if(/^\/proc$|^\/proc\//.test(location.pathname)) location.href+='?webapp=angular';
    
var status = function(msg, noellip) { document.getElementById('loading-status').innerHTML = msg?msg+(noellip?'':'...'):''; }
    , token = 'S2lsbGluZyB6b21iaWVz;RmVlZGluZyBjYXRz;RWF0aW5nIGJ1cmdlcnM=;QnV5aW5nIGEgYm9hdA==;Q29tcG9zaW5nIGEgcHJlbHVkZQ==;UmlkaW5nIGEgdW5pY29ybg==;V2VhcmluZyBzdW5nbGFzc2Vz;UGxheWluZyBjaGVzcw==;Q2FsY3VsYXRpbmcgdGhlIG1lYW5pbmcgb2YgdW5pdmVyc2U=;V2Fsa2luZyBvbiB3YXRlcg==;U2tpaW5n;RGV2ZWxvcGluZyBjb25zY2lvdXNuZXNz;TGVhcm5pbmcgUGVybA==;SW52ZXN0aWdhdGluZyBvdXRlciBzcGFjZQ==;VHJhdmVsbGluZyB0byBub3J0aCBwb2xl;QmFraW5nIGEgY2FrZQ=='.split(';'), empty = atob(token[(Math.random()*token.length)|0]);

require.config({
  waitSeconds: 120,
  paths: { // Settings for requirejs-react-jsx plugin
     "babel": '/meta/app/react/scripts/lib/babel-5.8.34.min'
    ,"jsx":   '/meta/app/react/scripts/lib/jsx'
    ,"text":  '/meta/app/react/scripts/lib/text'
  }
});

requirejs.onError = function(err) {
    var errMsg = err.requireType ? 'There was a "'+err.requireType.replace('error',' error')+'"' : (err.message ? 'The following error has occured:<br/>' + err.message.split('\n')[0] : 'Unkonwn error has occured.');
    status('Oops! ' + errMsg + '<br/>while loading ' + err.requireModules +
           '<br/>CM-Well WebApp cannot start.', true);
    document.getElementsByClassName('spinner-container')[0].style.display = 'none';
    throw err;
};
    
status('Loading infrastructure');
define('react', ['/meta/app/react/scripts/lib/react.min.js'], function(React) {
    window.React = React;
    return React;
});

define('react-dom', ['/meta/app/react/scripts/lib/react-dom.min.js'], function(ReactDOM) {
    window.ReactDOM = ReactDOM;
    return ReactDOM;
});

require(["react", "react-dom"], function() {
    status('Loading libraries');
    require([
         '/meta/app/react/scripts/lib/ReactRouter.min.js'
        ,'/meta/app/react/scripts/lib/react-flip-move.min.js'
        ,'/meta/app/react/scripts/lib/react-infinite.min.js'
        ,'/meta/app/react/scripts/lib/jquery.min.js'
        ,'/meta/app/react/scripts/lib/underscore-min.js'
        ,'/meta/app/react/scripts/lib/md5.js'
        ,'/meta/app/react/scripts/lib/mousetrap.min.js'
    ], function(ReactRouter, FlipMove) {
        status('Loading transpiler and base components');
        
        window.FlipMove = FlipMove;
        window.ReactRouter = ReactRouter;
        
        require([ // base components
            'jsx!./components/SliderToggle.jsx'
           ,'jsx!./components/SystemFields.jsx'
           ,'jsx!./components/ActionsBar.jsx'
           ,'jsx!./components/ErrorMsg.jsx'
           ,'jsx!./components/Spinner.jsx'
           ,'jsx!./components/Qotd.jsx'
           ,'jsx!./domain.jsx'
        ], function(sliderToggle, sysFields, actionsBar, errMsg, loadingSpinner, qotd, domain) {
            status('Loading app components');

            window.CommonComponents = {
                SliderToggle: sliderToggle,
                SystemFields: sysFields,
                ActionsBar: actionsBar,
                ErrorMsg: errMsg,
                LoadingSpinner: loadingSpinner,
                Qotd: qotd
            }
            
            window.Domain = domain
            
            require([ // app componets
                 'jsx!./components/Header.jsx'
                ,'jsx!./components/Types.jsx'
                ,'jsx!./components/HomePage.jsx'
                ,'jsx!./components/InfotonsList.jsx'
                ,'jsx!./components/Infoton.jsx'
                ,'jsx!./components/Footer.jsx'
                ,'jsx!./utils'
            ], function(header, types, homePage, infotonsList, infoton, footer) {
                status(empty);
                setTimeout(function(){
                    status('Starting App', true);

                    var components = header;
                    components.Types = types;
                    components.HomePage = homePage;
                    components.InfotonsList = infotonsList;
                    components.Infoton = infoton;
                    components.Footer = footer;
                    requirejs.config({ config: { app: { components: components } } });

                    require(['jsx!./app']);
                    
                    console.info('We know ApplicationCache is going to be deprecated. We are waiting for https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers to be stable.');
                }, 500);
            });
        });
    });
});

    
})();
