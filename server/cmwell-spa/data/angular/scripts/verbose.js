if(typeof cmwell === "undefined") cmwell = {};
cmwell.utils = cmwell.utils || {};

cmwell.utils.VerboseServerLog = function(logNames, pretty) {
    new WebSocket('ws://' + location.hostname + ':9613/')
        .onmessage = function(msg) {
            var data = JSON.parse(msg.data);
            if(logNames && !_(logNames).contains(data.logName)) return; // filtered out
            console.log('[' + data.logName + '.' + data.component + '] ' + data.message);
        };
};

verbose = function(logNames) { // intentionally a *global* variable, to be visible in Browser's Console
    cmwell.utils.VerboseServerLog(logNames);
    verbose = undefined; // once you invoked me, I'm gone (not allowing more than one WebSocket connection)
};
