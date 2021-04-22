if(typeof cmwell === "undefined") cmwell = {};

cmwell.nvd3 = {

    addPieChart: function(data, callback, selector) {

        callback = callback || function() {};

        selector = (selector || '') + ' svg';

        nv.addGraph(function() {
          var chart = nv.models.pieChart()
              .x(function(d) { return d.label })
              .y(function(d) { return d.value })
              .showLabels(true)
              .labelThreshold(.05)
              .labelType("percent") //Can be "key", "value" or "percent"
              .donut(true)
              .donutRatio(0.35)
              ;

            d3.select(selector)
                .datum(data)
                .transition().duration(350)
                .call(chart)
                ;

          return chart;
        },

        function() {
            d3.selectAll(".nv-slice").on('click', function(el) {
                callback(el.data);
            });
        }

        );
    }

    , addBarChart: function(data, selector) {

        selector = (selector || '') + ' svg';

        nv.addGraph(function() {
            var chart = nv.models.discreteBarChart()
                    .x(function(d) { return d.label })
                    .y(function(d) { return d.value })
                    .staggerLabels(true)    //Too many bars and not enough room? Try staggering labels.
                    .tooltips(false)        //Don't show tooltips
                    .showValues(true)       //...instead, show the bar value right on top of each bar.
                    .transitionDuration(350)
                ;

            d3.select(selector)
                .datum(data)
                .call(chart);

            nv.utils.windowResize(chart.update);

            return chart;
        });

    }
};

cmwell.cloudLayout = function (data, selector) {
    var words = _(data).map(function(v, k) { return { text:k, size:v }; })
        , fill = d3.scale.category20()
        , draw = function(words) {
            d3.select(selector).append("svg")
                .attr("width", 700)
                .attr("height", 700)
                .append("g")
                .attr("transform", "translate(450,350)")
                .selectAll("text")
                .data(words)
                .enter().append("text")
                .style("font-size", function(d) { return d.size + "px"; })
                .style("font-family", "Impact")
                .style("fill", function(d, i) { return fill(i); })
                .attr("text-anchor", "middle")
                .attr("transform", function(d) {
                    return "translate(" + [d.x, d.y] + ")rotate(" + d.rotate + ")";
                })
                .text(function(d) { return d.text; });
            }

    d3.layout.cloud().size([700, 700])
        .words(words)
        .padding(5)
        .rotate(function() { return ~~(Math.random() * 2) * 90; })
        .font("Impact")
        .fontSize(function(d) { return d.size; })
        .on("end", draw)
        .start();

};

cmwell.rdfToVisualGraph = function(SPOs, selector, hidePaths, w, h) {
    var nodes = {}, edges = [], allQuads=[], allSrcs=[];

    hidePaths = true; // we don't support anymore labeling as full URLs.

    var hidePathIfNeeded = function(url) { return hidePaths ? cmwell.utils.getLastUrlPart(url) : url; };
    //var hidePathIfNeeded = function(url) { return _(url).isString() ? (hidePaths?url.substr(url.lastIndexOf('/')+1):url) : url; };

    $(selector).find('#rdf-visual-graph').remove();
    $(selector).append('<div id="rdf-visual-graph"></div>');
    selector += ' #rdf-visual-graph';

    SPOs.forEach(function(spo) {
        var src
            , trgt
            , s = hidePathIfNeeded(spo.s)
            , p = hidePathIfNeeded(spo.p)
            , o = hidePathIfNeeded(spo.o.value)
            , objectIsLiteral = spo.o.type !== cmwell.constants.anyUri
            , addOrUpdateNode = function(nodeName, data) {
                if (!nodes[nodeName]) {
                    var myPath = s===nodeName ? spo.s : spo.o.value;
                    nodes[nodeName] = { name: nodeName, index: _(nodes).size(), quads: [], data: {}, srcs: [], srcsHashes: [], paths:{}, path: myPath };
                }

                var node = nodes[nodeName];

                node.quads = _(node.quads).union(spo.g);
                node.srcs = _(node.srcs).union([spo.src]);
                node.srcsHashes = _(node.srcsHashes).union([spo.src.hashCode()]);
                _(node.data).extend(data);

                return node;
            };

        allQuads = _(allQuads).union(spo.g);
        allSrcs = _(allSrcs).union([spo.src]);

        if(objectIsLiteral) {
            var keyValueData = {};
            keyValueData[p] = o;
            addOrUpdateNode(s, keyValueData);
            return;
        }

        src = addOrUpdateNode(s).index;
        trgt = addOrUpdateNode(o).index;

        edges.push({source: src, label: p, target: trgt});
    });

    nodes = _(nodes).sortBy('index');


    // Graph Controls:

    if(allQuads.length>1) {
        $(selector).prepend('<div class="quads-buttons controls"></div>');
        $(selector).find('.quads-buttons').html(allQuads.reduce(function(m,n){return m+'<button id="'+n+'">'+n+'</button>';},'<b>Quads</b>: '));
        $(selector).find('.quads-buttons').append('&nbsp;<a href="#">clear</a>');
        $(selector).find('.quads-buttons a').on('click', function() { $('circle').css('opacity', '1.0'); });
        $(selector).find('button').on('click', function() {
            var selectedQuad = this.id;
            $('circle').css('opacity', '0.4');
            $('circle.'+selectedQuad).css('opacity', '1.0');
        });
    }

    if(allSrcs.length>1) {
        $(selector).prepend('<label class="controls"><input type="checkbox" checked id="toggle-show-groups">Show groups</label><br/>');
        $('#toggle-show-groups').on('change', function () { $('.hull').toggle($(this).is(':checked')); });
    }

    $(selector).prepend('<label class="controls"><input type="checkbox" id="toggle-show-qtips">Always show node labels</label><br/>');
    $('#toggle-show-qtips').on('change', function() { $('.node-label').toggle($(this).is(':checked')); });

    // todo move this override to utils or somewhere:
    d3.selection.prototype.moveToBack = function() {
        return this.each(function() {
            var firstChild = this.parentNode.firstChild;
            if (firstChild) {
                this.parentNode.insertBefore(this, firstChild);
            }
        });
    };

    w = w || 1200;
    h = h || 900;
    var linkDistance=130, radius = 13;
    var colors = d3.scale.category10();

    var nodeToHtml = function(node) {
        return '<span class="node-data"><span class="name">'+ node.name +
                '&nbsp;<a target="_blank" href="'+node.path+'"><img src="/meta/app/angular/images/link-out.svg"/></a>' +
                '</span><span class="fields">' + _(node.data).map(function(v,k){return k+': '+v;}).join('<br/>') + '</span></span>';
    };

    var dataset = {
        nodes: nodes,
        edges: edges
    };

    var svg = d3.select(selector).append("svg").attr({"width":w,"height":h,"class":'rdf'});

    var force = d3.layout.force()
        .nodes(dataset.nodes)
        .links(dataset.edges)
        .size([w,h])
        .linkDistance([linkDistance])
        .charge([-500])
        .theta(0.2)
        .gravity(0.05)
        .start();

    var edges = svg.selectAll("line")
        .data(dataset.edges)
        .enter()
        .append("line")
        .attr("id",function(d,i) {return 'edge'+i})
        .attr('marker-end','url(#arrowhead)')
        .style("stroke","#333")
        .style("pointer-events", "none");

    var nodes = svg.selectAll("circle")
        .data(dataset.nodes)
        .enter()
        .append("circle")
        .attr({"r":radius})
        .attr("class",function(d,i){ return 'node ' + d.quads.join(' '); })
        .attr("id", function(d){ return 'circle-'+ d.name; })
        .attr("data-nodedata", function(d){ return JSON.stringify(d); })
        .style("fill",function(d,i){return /*colors(i)*/'#FF7F04';})
        .call(force.drag);

    var nodelabels = svg.selectAll(".node-label")
        .data(dataset.nodes)
        .enter()
        .append('text')
        .attr({
            'class': 'node-label not-displayed',
            'font-family': "Helvetica",
            'font-size': 11,
            'fill': "#333",
            'style':'pointer-events: none',
            'dx': radius+1,
            'dy': radius+1
        })
        .text(function(d){return d.name;});

    var edgepaths = svg.selectAll(".edgepath")
        .data(dataset.edges)
        .enter()
        .append('path')
        .attr({'d': function(d) {return 'M '+d.source.x+' '+d.source.y+' L '+ d.target.x +' '+d.target.y},
            'class':'edgepath',
            'fill-opacity':0,
            'stroke-opacity':0,
            'fill':'blue',
            'stroke':'red',
            'id':function(d,i) {return 'edgepath'+i}})
        .style("pointer-events", "none");

    var edgelabels = svg.selectAll(".edgelabel")
        .data(dataset.edges)
        .enter()
        .append('text')
        .style("pointer-events", "none")
        .attr({'class':'edgelabel',
            'id':function(d,i){return 'edgelabel'+i},
            'dx':function(d){
                var center = linkDistance/2 - d.label.length*2.31;
                return Math.max(0,center);
            },
            'dy':0,
            'font-family':'Helvetica',
            'font-size':12,
            'fill':'#333'});

    edgelabels.append('textPath')
        .attr('xlink:href',function(d,i) {return '#edgepath'+i})
        .style("pointer-events", "none")
        .text(function(d){return d.label; });


    var hulls = allSrcs.length>1 ? allSrcs.map(function(src) {
        var hash = src.hashCode();
        return svg.append("path")
            .attr("class", "hull " + hash)
            .attr('fill', colors(hash))
            .attr("stroke", colors(hash))
            .attr("stroke-width", "42px") // the width is the answer
            .attr("stroke-alignment", "outer")
            .attr("stroke-linejoin", "round")
            .attr('opacity', Math.E/10); // because 0.2718 is the opacity I want
    }) : [];

    svg.append('defs').append('marker')
        .attr({'id':'arrowhead',
            'viewBox':'-0 -5 10 10',
            'refX':25,
            'refY':0,
            //'markerUnits':'strokeWidth',
            'orient':'auto',
            'markerWidth':10,
            'markerHeight':10,
            'xoverflow':'visible'})
        .append('svg:path')
        .attr('d', 'M 0,-5 L 10 ,0 L 0,5')
        .attr('fill', '#333')
        .attr('stroke','#333');


    force.on("tick", function(){

        var bound = function(limit) {
            // based on http://bl.ocks.org/mbostock/1129492
            return function(v) {
                return Math.max(radius, Math.min(limit-radius, v));
            }
        };

        nodes.attr({
            "cx":function(d){return bound(w)(d.x);},
            "cy":function(d){return bound(h)(d.y);}
        });

        nodelabels
            .attr("x", function(d) { return bound(w)(d.x); })
            .attr("y", function(d) { return bound(h)(d.y); });

        edges.attr({
            "x1": function(d){return bound(w)(d.source.x);},
            "y1": function(d){return bound(h)(d.source.y);},
            "x2": function(d){return bound(w)(d.target.x);},
            "y2": function(d){return bound(h)(d.target.y);}
        });

        edgepaths.attr('d', function(d) {
            var path='M '+bound(w)(d.source.x)+' '+bound(h)(d.source.y)+' L '+ bound(w)(d.target.x) +' '+bound(h)(d.target.y);
            return path;
        });

        edgelabels.attr('transform',function(d) {
            if (d.target.x<d.source.x){
                bbox = this.getBBox();
                rx = bbox.x+bbox.width/2;
                ry = bbox.y+bbox.height/2;
                return 'rotate(180 '+rx+' '+ry+')';
            }

            return 'rotate(0)';
        });

        hulls.forEach(function(hull) {

            var nodesCoords = _(dataset.nodes).chain()
                                    .filter(function(d) { return _(d.srcsHashes).contains(+hull.attr("class").replace('hull ',''));})
                                    .map(function(node){return [node.px,node.py];})
                                    .value();

            if(nodesCoords.length>2)
                hull
                    .datum(d3.geom.hull(nodesCoords))
                    .attr("d", function(d) {
                        return "M" + d.join("L") + "Z"; });
        });

        svg.selectAll("path").moveToBack();

    });

    $('svg').css('height', $('svg').attr('height')); // hack to fit in screen

    // qtips: node Data
    $('circle').each(function() {
        var $self=$(this);
        $self.qtip({
            content: { text: nodeToHtml($self.data('nodedata')) },
            position: { my: 'left center' },
            style: { classes: 'qtip-light', tip: false },
            hide: { event: 'mouseleave', target: $self, fixed: true, delay: 500, effect: function(){$(this).fadeOut(500);} },
            events: {
                show: function() {
                    var fieldsDiv = $(this).find('.fields');
                    setTimeout(function() { fieldsDiv.slideDown(400); }, 200);
                },
                hide: function() {
                    var fieldsDiv = $(this).find('.fields');
                    setTimeout(function() { fieldsDiv.hide(); }, 500);
                }
            }
        });
    });

    // toggle "selection". for now it is only UI, might be used later to "get all selected" or so.
    //$('circle').on('click', function() {
    //    var $this = $(this);
    //    if($this.attr('stroke'))
    //        $this.removeAttr('stroke');
    //    else
    //        $this.attr({ "stroke": '#FF8800', "stroke-width": '7px', "stroke-opacity": 0.5  });
    //});


    // hook collapse fields
    cmwell.rdfToVisualGraphHooks = cmwell.rdfToVisualGraphHooks || function() {
        $('body').on('click', '.node-data .name', function () {
            $(this).parent().find('.fields').slideToggle(400);
        });
        return true; // an ugly way to run it only once. could have used _.once we well, I guess
    }();
};

cmwell.treeDataToCollapsibleGraph = function(data, selector, appendMode) {

    var LEFT_BUTTON = 0, RIGHT_BUTTON = 2; // https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/button

    // todo add edge labels...!

    var radius = 12;
    var linkDistance = 120;

    if(!appendMode) {
        $(selector).find('#rdf-visual-graph').remove();
        $(selector).append('<div id="rdf-visual-graph">' +
            '<p style="margin-left: 18px;font-size: small;font-style: italic;">Left click to expand backward (infotons that link to me), right click to expand forward (infotons I link to)</p>' +
            '<img src="/meta/app/angular/images/rolling.gif" class="links-loading not-displayed" style="position:absolute;padding:30px;">' +
            '</div>');
        cmwell._treeDataToCollapsibleGraph_svg = null;

        $('.hr:last').hide();
        $('.flex-container').slideUp(800); // taking over regular view
    }
    selector += ' #rdf-visual-graph';

    var update = function() {

        var nodes, links;

        if(appendMode) {
            var existingNodesArray = cmwell._treeDataToCollapsibleGraph_force.nodes();
            var existingIds = _(existingNodesArray).pluck('id');
            var newNodes = flatten(data);
            newNodes.forEach(function(n) {
                var existingNode = _(existingNodesArray).findWhere({id: n.id});
                if (existingNode) {
                    _(n.iChildren).each(function(newChild) { existingNode.iChildren = existingNode.iChildren || []; if(!_(existingIds).contains(newChild.id)) existingNode.iChildren.push(newChild); });
                    _(n.oChildren).each(function(newChild) { existingNode.oChildren = existingNode.oChildren || []; if(!_(existingIds).contains(newChild.id)) existingNode.oChildren.push(newChild); });
                } else {
                    existingNodesArray.push(n);
                }
            });
            nodes = existingNodesArray;
        } else {
            nodes = flatten(root);
        }


        // Defining links:
        nodes.forEach(function(n){ n.children = _([]).union(n.iChildren, n.oChildren); }); // only to allow the line below do its magic.
        links = d3.layout.tree().links(nodes);
        // moving outgoing/incoming links from original nodes to proper virtual ones
        _(links).each(function(link) {
            var dir = link.target.direction;
            if(dir === cmwell.enums.EdgeDirection.Outgoing) {
                link.source = _(nodes).find(function(n){ return n.parent == link.source && n.id.indexOf('_o_')>-1; });
                link.target = _(nodes).find(function(n){ return n.parent == link.target && n.id.indexOf('_i_')>-1; });
            }
            if(dir === cmwell.enums.EdgeDirection.Incoming) {
                link.source = _(nodes).find(function(n){ return n.parent == link.source && n.id.indexOf('_i_')>-1; });
                link.target = _(nodes).find(function(n){ return n.parent == link.target && n.id.indexOf('_o_')>-1; });
            }
            link.target.direction = dir;
        });
        // adding links between each concrete node and its virtual nodes
        _(nodes).where({virtual: true}).forEach(function(virtualNode){ links.push({ source: virtualNode.parent, target: virtualNode }); });

        // Update links.
        link = link.data(links, function(d) { return d.source.id + "-" + d.target.id; });
        link.enter().insert("line", ".node")
            .filter(function(edge) { return edge.target.parent != edge.source; })
            .attr("class", "link")                     // todo this is not always true, logically, one must distinguish between source.direction and target.direction... or is he?
            .attr("marker-end",   function(d) { return (d.source.direction || d.target.direction) === cmwell.enums.EdgeDirection.Outgoing ? "url("+location.href+"#end-arrow)" : ''; })
            .attr("marker-start", function(d) { return (d.source.direction || d.target.direction) === cmwell.enums.EdgeDirection.Incoming ? "url("+location.href+"#start-arrow)" : ''; });
        link.exit().remove();

        // Update nodes.
        node = node.data(nodes, function(d) { return d.id; });
        var nodeEnter = node.enter().append("g")
            .attr("class", function(d) { return 'node' + (d.virtual ? ' virtual' : '') + (d.actualRoot ? ' root' : ''); })
            .on("click", click) // bind left mouse click
            .on("contextmenu", click) // bind right mouse click
            .call(cmwell._treeDataToCollapsibleGraph_force.drag);
        nodeEnter.append("circle")
            .attr("r", function(d) { return d.virtual ? 0 : radius; });
        nodeEnter.append("text")
            .attr("dy", ".35em")
            .text(function(d) { return d.name; });

        node.exit().remove();

        node.select("circle")
            .style("fill", '#FF7F04');

        node.select(".root circle")
            .style({"fill": "rgb(255, 127, 4)",
                    "stroke": "rgb(255, 127, 4)",
                    "stroke-width": "13px",
                    "stroke-opacity": "0.5"});

        cmwell._treeDataToCollapsibleGraph_force
            .nodes(nodes)
            .links(links)
            .start();
    };

    var tick = function() {
        link.attr("x1", function(d) { return d.source.x; })
            .attr("y1", function(d) { return d.source.y; })
            .attr("x2", function(d) { return d.target.x; })
            .attr("y2", function(d) { return d.target.y; });

        node.attr("transform", function(d) { return "translate(" + d.x + "," + d.y + ")"; });
    };

    var click = function(d) {
        if (d3.event.defaultPrevented) return; // ignore drag
        d3.event.preventDefault();

        if(d3.event.button !== LEFT_BUTTON && d3.event.button !== RIGHT_BUTTON) return;

        $('.links-loading').fadeIn();
        var dir = d3.event.button === LEFT_BUTTON ? cmwell.enums.EdgeDirection.Incoming : cmwell.enums.EdgeDirection.Outgoing;

        if(d['_'+dir]) return;
        d['_'+dir] = 'expanded';

        cmwell.utils.findAndShowIncomingInfotons(d.path, true, dir);
    };

    var flatten = function(root) {
        var nodes = [];

        if(!appendMode)
            root.actualRoot = true;

        function recurse(node) {
            if (node.iChildren)
                node.iChildren.forEach(recurse);

            if (node.oChildren)
                node.oChildren.forEach(recurse);

            node.id = node.id || node.path;

            nodes.push(node, { id: "_i_"+node.id, virtual: true, parent: node }, { id: "_o_"+node.id, virtual: true, parent: node });
        }

        recurse(root);

        return nodes;
    };


    var width = 960,
        height = 500,
        root = data;

    if(!appendMode)
        cmwell._treeDataToCollapsibleGraph_force = d3.layout.force()
            .linkDistance(function(edge) { return edge.target.parent != edge.source ? linkDistance : -10; })
            //.linkStrength(function(edge) { return edge.target.parent != edge.source ? linkDistance : 0; })
            .charge(-120)
            .gravity(.05)
            .size([width, height])
            .on("tick", tick);
    else
        cmwell._treeDataToCollapsibleGraph_force.on("tick", tick); // so it'd be in the right scope. todo - think of scopes. maybe rewrite the appedMode attitude. maybe use `function foo() {}` rather than `var foo = function() {}` ...


    var svg = cmwell._treeDataToCollapsibleGraph_svg || (cmwell._treeDataToCollapsibleGraph_svg = d3.select(selector).append("svg").attr({"width":width,"height":height,"class":'rdf'}));


    // define arrow markers for graph links
    svg.append('svg:defs').append('svg:marker')
        .attr('id', 'end-arrow')
        .attr('viewBox', '0 -5 10 10')
        //.attr('refX', radius*1.5-1)
        .attr('markerWidth', radius/2)
        .attr('markerHeight', radius/2)
        .attr('orient', 'auto')
        .append('svg:path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', '#ADADAD');
    svg.append('svg:defs').append('svg:marker')
        .attr('id', 'start-arrow')
        .attr('viewBox', '0 -5 10 10')
        //.attr('refX', -radius/2)
        .attr('markerWidth', radius/2)
        .attr('markerHeight', radius/2)
        .attr('orient', 'auto')
        .append('svg:path')
        .attr('d', 'M10,-5L0,0L10,5')
        .attr('fill', '#ADADAD');

    var node = svg.selectAll(".node")
        , link = svg.selectAll(".link");

    $('.links-loading').fadeOut(); // in case it was on
    update();
};

cmwell.TreeDataToCollapsibleGraph2 = function(data, selector) {

    // private
    var allRoots = [];
    var levelsCounter = 0;
    var MIDDLE_BUTTON = 1;

    function appendTree(data, offsetX, offsetY, i) { // i is for the i-tree

        var margin = {top: 20, right: i?480:120, bottom: 20, left: i?120:480},
            width = 960 - margin.right - margin.left,
            height = 500 - margin.top - margin.bottom;

        var root = data[0];

        var rootClassName = toUniqClassName(root);
        // todo allRoots should be an object rather than an array, i.e. allRoots[rootClassName] = allRoots[rootClassName] || ...
        if(!i && !_(allRoots).findWhere({name:rootClassName})) {
            var parentRoot = root._parent ? _(allRoots).findWhere({name:root._parent.name}) : null;
            var prevOffset = parentRoot ? parentRoot.offset : [0,0];
            allRoots.push({name: rootClassName, offset:[prevOffset[0]+offsetX,prevOffset[1]+offsetY]});
        }
        var className = (i ? "i" : "o") + "-tree" + " " + rootClassName;
        var classNameSelector = className.split(' ').map(function(c){return '.'+c;}).join('');

        var c = 0, duration = 400;

        var isTopLevelTree = !offsetX;

        var tree = d3.layout.tree()
            .size([height, width]);

        var diagonal = d3.svg.diagonal()
            .projection(function (d) {
                return [i?width-d.y:d.y, d.x];
            });

        var svg = d3.select("svg") // assuming <svg> element exists!
            .attr("width", width + margin.right + margin.left)
            .attr("height", height + margin.top + margin.bottom);

        if(i)
            svg=svg.insert("g", ".o-tree." + rootClassName); // oh yeah.
        else
            svg=svg.append("g");

        svg
            .attr("class", className)
            .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

        root.x0 = height / 2;
        root.y0 = width / 2;

        update(root);

        d3.select(self.frameElement).style("height", "500px");

        function update(source) {

            // Compute the new tree layout.
            var nodes = tree.nodes(root).reverse(),
                links = tree.links(nodes);

            // Normalize for fixed-depth.
            nodes.forEach(function (d) {
                d.y = d.depth * 180;
            });

            // Update the nodes…
            var node = svg.selectAll(classNameSelector+" g.node")
                .data(nodes, function (d) {
                    return d.id || (d.id = ++c);

                });

            // Enter any new nodes at the parent's previous position.
            var nodeEnter = node.enter().append("g")
                .attr("class", function(d) { return "node" + (d==root?" root"+(isTopLevelTree?" root-of-all":""):""); })
                .attr("transform", function (d) {
                    return "translate(" + (i?(width-source.y0):source.y0) + "," + source.x0 + ")";
                })
                .on("mouseover", mouseover)
                .on("mouseout", mouseout)
                .on("click", click);

            nodeEnter.append("circle")
                .attr("r", 0)
                .style("fill", function (d) {
                    return d._children ? "#FFDEA1" : "#fff";
                });

            nodeEnter.append("text")
                .filter(function(d) {
                    var invisibleRoot = i && !d.parent;
                    return !invisibleRoot;
                })
                .attr("x", function (d) {
                    if(d==root) return 23;
                    var minus = i ? -1 : 1;
                    return (d.children || d._children ? -13 : 13)*minus;
                })
                .attr("dy", function(d) { return d==root? 23 : ".35em"; })
                .attr("text-anchor", function (d) {
                    var s = i ? "start" : "end", e = i ? "end" : "start";
                    return d.children || d._children ? s : e;
                })
                .text(function (d) {
                    return d.name;
                })
                .style("fill-opacity", 1e-6);

            // Transition nodes to their new position.
            var nodeUpdate = node.transition()
                .duration(duration)
                .attr("transform", function (d) {
                    return "translate(" + (i?(width-d.y):d.y) + "," + d.x + ")";
                });

            nodeUpdate.select("circle")
                .filter(function(d) { return !i || d.parent; })
                .attr("r", 10)
                .style("fill", "#fff");

            nodeUpdate.select("text")
                .style("fill-opacity", function(d) {
                    var rootOfCollapsedSubTree = !d.parent && !isTopLevelTree && d._children;
                    return rootOfCollapsedSubTree ? 0 : 1;
                });


            // Transition exiting nodes to the parent's new position.
            var nodeExit = node.exit().transition()
                .duration(duration)
                .attr("transform", function () {
                    return "translate(" + (i?(width-source.y):source.y) + "," + source.x + ")";
                })
                .remove();

            nodeExit.select("circle")
                .attr("r", 1e-6);

            nodeExit.select("text")
                .style("fill-opacity", 1e-6);


            // Update the links...
            var link = svg.selectAll(classNameSelector+" g.link")
                .data(links, function (d) {
                    return d.target.id;
                });


            // Enter any new links at the parent's previous position.
            var linkEnter = link.enter().append("g")
                .attr("class", "link");

            linkEnter.append("path")
                .attr("d", function (d) {
                    var o = {x: source.x0, y: source.y0};
                    return diagonal({source: o, target: o});
                });

            linkEnter.append("text")
                .attr("y", function(d) { return (d.source.x+d.target.x)/2; })
                .attr("x", function(d) { var k=(d.source.y+d.target.y)/2; return i?(width-k):k; })
                .attr("dx", -10)
                .style({
                    "font-size": "10px",
                    "color": "#333",
                    "font-family": "Arial",
                    "fill-opacity": 1e-6
                })
                .text(function(d) { return d.target.predicate; });

            // Transition links to their new position.
            link.select("path").transition()
                .duration(duration)
                .attr("d", diagonal);

            link.select("text").transition()
                .duration(duration*2)
                .style("fill-opacity", 1);

            // Transition exiting nodes to the parent's new position.
            var linkExit = link.exit();

            linkExit.select("path")
                .transition()
                .duration(duration)
                .attr("d", function (d) {
                    var o = {x: source.x, y: source.y};
                    return diagonal({source: o, target: o});
                });

            linkExit.select('text')
                .style("fill-opacity", 1e-6);

            linkExit.transition().duration(duration).remove();

            // Stash the old positions for transition.
            nodes.forEach(function (d) {
                d.x0 = d.x;
                d.y0 = d.y;
            });

            d3.selectAll(".link").moveToBack();
        }

        function click(d) {
            if(d3.event && (d3.event.button===MIDDLE_BUTTON || d3.event.ctrlKey)) {
                window.open(d.path);
                return;
            }

            if(d3.select(this.parentNode).style("opacity")<1) return;

            var prevTreeName = d._parent ? toUniqClassName(d._parent) : '';

            //trigger click on the invisible root as well
            if(d == root && d3.event) {
                var node = d3.select(".i-tree."+rootClassName+" .node.root").node();
                if(node) node.__onclick();
            }

            if(!d.children && !d._children) {
                var xy = extractXYfromTransform(d3.select(this).attr("transform"))
                    , promise = new $.Deferred();

                if(i) xy[0]-=360;

                promise
                    .always(function() {
                        $('img#loading').fadeOut();
                    })
                    .then(function() {
                        d3.selectAll("." + rootClassName)
                            .addClass("disabled")
                            .transition().duration(duration*3).style("opacity", 0.25);

                        _(d.parent.children).chain().map(toUniqClassName).without(toUniqClassName(d)).each(function(c) {
                            d3.selectAll("." + c)
                                .addClass("disabled")
                                .transition().duration(duration * 3).style("opacity", 0.25);
                        });


                            zoomListener.event(d3.select("svg"));
                    });

                $('img#loading').fadeIn();
                cmwell.utils.findAndShowIncomingInfotons2(d.path, d.parent, d.predicate, d.rev, _this, xy, promise);
            }

            if (d.children) {
                d._children = d.children;
                d.children = null;

                if(d==root) {
                    // this will collapse expanded-in-pass children of this root
                    d._children.forEach(function(c) {
                        d3.selectAll(".o-tree."+toUniqClassName(c)+", .i-tree."+toUniqClassName(c)).remove();
                    });

                    if(prevTreeName) {
                        d3.selectAll("." + prevTreeName)
                            .removeClass("disabled")
                            .transition().duration(duration * 3).style("opacity", 1);

                        _(d._parent.children).chain().map(toUniqClassName).without(toUniqClassName(d)).each(function(c) {
                            d3.selectAll("." + c)
                                .removeClass("disabled")
                                .transition().duration(duration * 3).style("opacity", 1);

                        });
                    }
                }

            } else {
                d.children = d._children;
                d._children = null;

                if(d==root && prevTreeName) {
                    d3.selectAll("." + prevTreeName)
                        .addClass("disabled")
                        .transition().duration(duration * 3).style("opacity", 0.25);

                    _(d._parent.children).chain().map(toUniqClassName).without(toUniqClassName(d)).each(function(c) {
                        d3.selectAll("." + c)
                            .addClass("disabled")
                            .transition().duration(duration * 3).style("opacity", 0.25);
                    });
                }
            }
            update(d);
        }
    }



    ////////////// helper methods and stuff ////////////


    function extractXYfromTransform(attr) {
        return attr.substr(10, attr.indexOf(')')-10).split(',').map(function(c){return +c;});
    }


    function incTraslate(selector, dx, dy) {
        selector = d3.select(selector);

        if(!selector.node()) return;

        var attr = selector.attr("transform")
            , xy = extractXYfromTransform(attr)
            , scale = attr.indexOf('scale(')>-1 ? attr.substr(attr.indexOf('scale(')) : '';

        selector.attr("transform", "translate("+(xy[0]+dx)+","+(xy[1]+dy)+")"+scale /*+ "rotate(-10 "+(-(xy[0]+dx))+" "+(-(xy[1]+dy))+")"*/);
    }


    var zoomListener = d3.behavior.zoom().scaleExtent([0.1, 3]).on("zoom", function () {
        var scale = d3.event.scale
            , iTreePos = d3.event.translate
            , oTreePos = [(iTreePos[0]+360*scale), iTreePos[1]];

        d3.selectAll(".o-tree").attr("transform", "translate(" + oTreePos + ")scale(" + scale + ")");
        d3.selectAll(".i-tree").attr("transform", "translate(" + iTreePos + ")scale(" + scale + ")");

        allRoots.forEach(function(r) {
            incTraslate("."+r.name + ".i-tree", (r.offset[0]-10)*scale, r.offset[1]*scale);
            incTraslate("."+r.name + ".o-tree", (r.offset[0]-10)*scale, r.offset[1]*scale);
        });
    });

    function mouseover(d) {

        d3.select(this).select('circle').style('fill','orange');

        var path = [], c = d;
        while(c!=null) {
            path.push(c);
            c = c.parent || c._parent;
        }
        path.reverse();

        var pred = function(predName, direction) {
            predName = '-[' + predName + ']-';
            return direction ? '<'+predName : predName+'>';
        };

        var text = path.map(function(n,idx){ return (idx?pred(n.predicate,n.rev):'')+'('+ n.name+')'; }).join('');
        d3.select('#status-bar').text(text);
    }

    function mouseout() {
        d3.select(this).select('circle').style('fill','#fff');
        d3.select('#status-bar').text('');
    }

    // todo move this override to utils or somewhere:
    d3.selection.prototype.moveToBack = function() {
        return this.each(function() {
            var firstChild = this.parentNode.firstChild;
            if (firstChild) {
                this.parentNode.insertBefore(this, firstChild);
            }
        });
    };

    d3.selection.prototype.addClass = function(clazz) {
        return this.each(function() {
            var d3this = d3.select(this);
            d3this.attr("class", d3this.attr("class") + " " + clazz);
        });
    };

    d3.selection.prototype.removeClass = function(clazz) {
        return this.each(function() {
            var d3this = d3.select(this);
            d3this.attr("class", d3this.attr("class").replace(new RegExp(clazz, "g"), ''));
        });
    };

    function toUniqClassName(root) {
        return root.name.replace(/[^a-zA-Z]+/g, '');
    }

    // CTOR
    this.init = function(data, selector) {
        $('.hr:last').hide(); $('.flex-container').slideUp(800); // taking over regular view

        var wrapper = "links-navigation";

        $("#"+wrapper).remove();
        $(selector).append('<div id="'+wrapper+'">' +
            '<svg></svg>' +
            '<img width="32" id="loading" src="/meta/app/angular/images/rolling.gif"/>' +
            '<div id="status-bar"></div>' +
            '</div>');

        $('.breadcrumbs a.usage').remove();
        $('.breadcrumbs').append('<a class="usage">How to use this graph?</a>');
        $('a.usage').qtip({position:{my:"top left",at:"bottom left",adjust:{y:5}},style:{classes:'qtip-plain custom',tip:false},
            content:"* All edges directions are left-to-right<br>" +
            "* Left click on an Infoton to expand it (in a new layer)<br>" +
            "* To collapse - click again or hit the minus key<br>" +
            "* Middle-click / ctrl+click to open an Infoton on a new tab<br>" +
            "* Scroll to zoom, drag to pan"});

        d3.select("#"+wrapper + " svg").call(zoomListener);

        data.oData.level = data.iData.level = ++levelsCounter;

        appendTree([data.oData], 0, 0);
        appendTree([data.iData], 0, 0, true);

        zoomListener.event(d3.select("svg"));
    };

    this.init(data, selector);

     //public methods
    this.add = function(data, offsetXY) {

        data.oData.level = data.iData.level = ++levelsCounter;

        if(!data.oData.children && !data.iData.children)
            return;

        appendTree([data.oData], offsetXY[0], offsetXY[1]-230, false);
        appendTree([data.iData], offsetXY[0], offsetXY[1]-230, true);
    };

    var _this = this;


    // todo when there's no oChildren but only iChildren - things go wrong
    // todo - so, one option is not-adding oTree at all, but I don't like it. So we need to handle an oTree with 0 children!!!

    // todo when expanding a children of iTree it does not disabled collapsed-in-past children of the oTree (and vice versa)
    // todo - so, move that removeClass/addClass to a function, and use it for both "._parent"s


    // todo {opacity,rotation} by levels

};

