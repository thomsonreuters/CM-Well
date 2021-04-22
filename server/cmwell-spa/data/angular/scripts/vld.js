String.prototype.ellipsis = function(n) {
    n = n || 20;
    return this.length < n ? this : this.substr(0,n) + "...";
};

// d3.js is very possessive about its data arrays.
// thus, underscore.js or even native .filter() won't work!
// ... we must modify the data arrays IN PLACE.
Array.prototype.filterInPlace = function(filter) {
    for(var i=this.length;i--;)
        if(!filter(this[i]))
            this.splice(i, 1);
}

var vld = function() {

var maxNodesInLevel = 20;

var width = window.innerWidth-150
    , height = window.innerHeight-150
    , nodeHeight = 180
    , nodeWidth = 140
    , textPadding = 3;

var force = d3.layout.force()
    .size([width, height])
    .nodes([{x:width/2,y:height/2,path:"/"}])
    .charge(-300)
    .linkDistance(200)
    .on("tick", tick);

force.drag().on("dragstart", function(d) {
  d3.select(this).classed("fixed", d.fixed = true);
});

var svg = d3.select("body").append("svg")
    .attr("width", width)
    .attr("height", height);

// define the #dropshadow filter:
svg.html('<defs><filter id="dropshadow" height="130%"><feGaussianBlur in="SourceAlpha" stdDeviation="3"/><feOffset dx="2" dy="2" result="offsetblur"/><feComponentTransfer><feFuncA type="linear" slope="0.2"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>');

var nodes = force.nodes(),
    links = force.links(),
    node = svg.selectAll(".node"),
    link = svg.selectAll(".link"),
    group = svg.selectAll("g");

restart();

function tick() {
  link.attr("x1", function(d) { return d.source.x+nodeWidth/2; })
      .attr("y1", function(d) { return d.source.y+nodeHeight; })
      .attr("x2", function(d) { return d.target.x+nodeWidth/2; })
      .attr("y2", function(d) { return d.target.y+nodeHeight/2; });

  node.attr("x", function(d) { return d.x; })
      .attr("y", function(d) { return d.y; })
      .on("click", click);

  group.attr("x", function(d) { return d.x-nodeWidth/2; })
        .attr("y", function(d) { return d.y; });

  svg.selectAll("text").attr("x", function(d) { return d.x+textPadding; })
        .attr("y", function(d) { return d.y + textPadding + 15 + +d3.select(this).attr("data-height"); });

}

function restart() {

  link = link.data(links);
  link.exit().remove();
  link.enter().insert("line").attr("class", "link");

  node = node.data(nodes);
  node.exit().remove();
  node.enter().insert("rect");

  node.attr("class", "node").attr("width", nodeWidth).attr("height", nodeHeight).call(force.drag);

  group = group.data(nodes);
  group.exit().remove();
  group.enter().insert("g");

  svg.selectAll("text").remove();

  var f = function(k) { return function(d) { return d[k] ? (k.toUpperCase() + ": " + d[k]).ellipsis() : ''; } };
  var textLines = [f('type'), f('path'), f('uuid')];
  addText(group, textLines);

  force.start();
}

function click(node) {
    if(d3.event.defaultPrevented)
        return;

    force.stop();


    var expanded = d3.select(this).attr("data-expanded");

    if(!+expanded) {
        getChildren(node, d3.mouse(this));
    } else {
        // removing unrelated nodes and links:

        //todo This only works out for 1 level depth. need some recursive search here...
        //todo     example: click meta then click ROOT ==> meta subtree is hanging

        nodes.filterInPlace(function(nde) {
            return !_(links).chain()
                            .filter(function(l) { return l.source.uuid==node.uuid; })
                            .map(function(l) { return l.target.uuid; })
                            .contains(nde.uuid).value();
        });

        links.filterInPlace(function(lnk) { return lnk.source.uuid != node.uuid; });

        restart();
    }

    d3.select(this).attr("data-expanded", +expanded?0:1); // toggle state
}

function addText(element, lines) {
    var height = -15;
    lines.forEach(function(line) {
        element.insert("text").attr("data-height", height+=15).text(line);
    });
}

function getChildren(node, cursorPos) {
    // if AJAX takes more than 1sec - show loading gif
    var done = false;
    setTimeout(function(){ if(!done) $('.loading').fadeIn(); }, 1000);

    $.getJSON(node.path + '?format=json&length='+maxNodesInLevel).then(function(resp) {
        done = true;
        $('.loading').fadeOut();

        if(!resp.children)
            return;

        _(resp.children).each(function(childNode) {
            var newNode = { x:cursorPos[0], y:cursorPos[1], path: childNode.system.path, type: childNode.type, uuid: childNode.system.uuid };
            nodes.push(newNode);
            links.push({source: node, target: newNode });
        });

        restart();
    });
}

d3.select('.node').attr("data-expanded", 1);
getChildren(nodes[0], [width/2, height/2]); // getting Root's Children at startup

};
