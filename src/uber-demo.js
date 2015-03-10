'use strict';

// FIXME: Move this to graph-viz repo -- it shouldn't be a part of the core StreamGL library

var debug   = require('debug')('graphistry:StreamGL:uber-demo');
var $       = window.$;
var Rx      = require('rx');
              require('./rx-jquery-stub');
var _       = require('underscore');

var interaction     = require('./interaction.js');
var renderer        = require('./renderer');
var poiLib          = require('./poi.js');
var marqueeFact     = require('./marquee.js');
var shortestpaths   = require('./shortestpaths.js');
var colorpicker     = require('./colorpicker.js');

var poi;



function sendLayoutSetting(socket, algo, param, value) {
    var update = {};
    var controls = {};

    update[param] = value;
    controls[algo] = update;

    var payload = {
        play: true,
        layout: true,
        simControls: controls,
    };

    debug('Sending layout settings', payload);
    socket.emit('interaction', payload);
}


var HIGHLIGHT_SIZE = 20;
var INTERACTION_INTERVAL = 50;


function makeErrorHandler(name) {
    return function (err) {
        console.error(name, err, (err || {}).stack);
    };
}


///////////////////////////////////////////////////////////////////////////////
// Event handler setup
///////////////////////////////////////////////////////////////////////////////

//Observable DOM
var labelHover = new Rx.Subject();

// $DOM * RendererState  -> ()
// Immediately reposition each label based on camera and curPoints buffer
var renderLabelsRan = false;
function renderPointLabels($labelCont, renderState, labelIdx) {

    debug('rendering labels');

    var curPoints = renderState.get('hostBuffers').curPoints;
    if (!curPoints) {
        console.warn('renderLabels called before curPoints available');
        return;
    }
    curPoints.take(1)
        .do(function (curPoints) {

            //first run: created the enlarged points for the sampler
            if (!renderLabelsRan) {
                renderLabelsRan = true;
                var allOn = renderer.localAttributeProxy(renderState)('allHighlighted');
                var amt = curPoints.buffer.byteLength / (4 * 2);
                for (var i = 0; i < amt; i++) {
                    allOn.write(i, HIGHLIGHT_SIZE);
                }
            }

            renderLabelsImmediate($labelCont, renderState, curPoints, labelIdx);

        })
        .subscribe(_.identity, makeErrorHandler('renderLabels'));
}


//RenderState * [ float ] * int -> ()
function renderCursor (renderState, points, idx, dim, sizes) {

    debug('Enlarging current mouseover point', idx);

    if (idx === undefined || idx < 0 || dim === 2) {
        $('#highlighted-point-cont').css({display: 'none'});
        return;
    }

    $('#highlighted-point-cont').css({display: 'block'});

    var camera = renderState.get('camera');
    var cnv = renderState.get('canvas');
    var mtx = camera.getMatrix();

    var pos = camera.canvasCoords(points[2 * idx], points[2 * idx + 1], cnv, mtx);
    var scalingFactor = camera.semanticZoom(sizes.length);
    var size = Math.max(5, Math.min(scalingFactor * sizes[idx], 50)); // Clamp like in pointculled shader
    var offset = size / 2.0;

    $('#highlighted-point-cont')
    .attr('pointIdx', idx)
    .css({
        top: pos.y,
        left: pos.x
    });
    $('.highlighted-point').css({
        'left' : -offset,
        'top' : -offset,
        'width': size,
        'height': size,
        'border-radius': size / 2
    });

    /* Ideally, highlighted-point-center would be a child of highlighted-point-cont
     * instead of highlighted-point. I ran into tricky CSS absolute positioning
     * issues when I tried that. */
    var csize = parseInt($('.highlighted-point-center').css('width'), 10);
    $('.highlighted-point-center').css({
        'left' : offset - csize / 2.0,
        'top' : offset - csize / 2.0
    });
}


function newLabelPositions(renderState, labels, points) {

    var camera = renderState.get('camera');
    var cnv = renderState.get('canvas');
    var mtx = camera.getMatrix();

    var newPos = new Float32Array(labels.length * 2);
    for (var i = 0; i < labels.length; i++) {
        var idx = labels[i].idx;
        var pos = camera.canvasCoords(points[2 * idx], points[2 * idx + 1], cnv, mtx);
        newPos[2 * i] = pos.x;
        newPos[2 * i + 1] = pos.y;
    }

    return newPos;
}

function effectLabels(toClear, toShow, labels, newPos, labelIdx) {

    //DOM effects: disable old, then move->enable new
    toClear.forEach(function (lbl) {
        lbl.elt.css('display','none');
    });

    labels.forEach(function (elt, i) {
        elt.elt.css('left', newPos[2 * i]).css('top', newPos[2 * i + 1]);
        elt.elt.removeClass('on');
    });

    if (labelIdx > -1) {
        poi.state.activeLabels[labelIdx].elt.addClass('on');
    }

    toShow.forEach(function (lbl) {
        lbl.elt.css('display', 'block');
    });

}

function renderLabelsImmediate ($labelCont, renderState, curPoints, labelIdx) {
    var points = new Float32Array(curPoints.buffer);

    var t0 = Date.now();

    var hits = poi.getActiveApprox(renderState, 'pointHitmapDownsampled');
    if (labelIdx > -1) {
        hits[labelIdx] = true;
    }
    var t1 = Date.now();

    var toClear = poi.finishApprox(poi.state.activeLabels, poi.state.inactiveLabels, hits, renderState, points);

    //select label elts (and make active if needed)
    var toShow = [];
    var labels = _.keys(hits)
        .map(function (idxStr) {
            var idx = parseInt(idxStr);
            if (poi.state.activeLabels[idx]) {
                //label already on, resuse
                var alreadyActiveLabel = poi.state.activeLabels[idx];
                toShow.push(alreadyActiveLabel);
                return alreadyActiveLabel;
            } else if ((_.keys(poi.state.activeLabels).length > poi.MAX_LABELS) && (labelIdx !== idx)) {
                //no label but too many on screen, don't create new
                return null;
            } else if (!poi.state.inactiveLabels.length) {
                //no label and no preallocated elts, create new
                var freshLabel = poi.genLabel($labelCont, idx);
                freshLabel.elt.on('mouseover', function () {
                    labelHover.onNext(this);
                });
                toShow.push(freshLabel);
                return freshLabel;
            } else {
                //no label and available inactive preallocated, reuse
                var lbl = poi.state.inactiveLabels.pop();
                lbl.idx = idx;
                lbl.setIdx(idx);
                toShow.push(lbl);
                return lbl;
            }
        })
        .filter(_.identity);

    poi.resetActiveLabels(_.object(labels.map(function (lbl) { return [lbl.idx, lbl]; })));

    var t2 = Date.now();

    var newPos = newLabelPositions(renderState, labels, points, toClear, toShow);

    var t3 = Date.now();

    effectLabels(toClear, toShow, labels, newPos, labelIdx);

    debug('sampling timing', t1 - t0, t2 - t1, t3 - t2, Date.now() - t3,
        'labels:', labels.length, '/', _.keys(hits).length, poi.state.inactiveLabels.length);

}


//render most of scene on refresh, but defer slow hitmap (readPixels)
var lastRender = new Rx.Subject();
function renderScene(renderer, currentState, data) {
    lastRender.onNext({renderer: renderer, currentState: currentState, data: data});
}

//Render gpu items, text on reqAnimFrame
//Slower, update the pointpicking sampler (does GPU->CPU transfer)
lastRender
    .bufferWithTime(10)
    .filter(function (arr) { return arr.length; })
    .map(function (arr) {
        var res = arr[arr.length - 1];
        _.extend(res.data,
            arr.reduce(
                function (acc, v) {
                    return {
                        renderTag: Math.max(v.renderTag, acc.renderTag),
                        labelTag: Math.max(v.labelTag, acc.labelTag)
                    };
                },
                {data: { renderTag: 0, labelTag: 0}}));
        return res;
    })
    .scan({prev: null, cur: null}, function (acc, v) { return {prev: acc.cur, cur: v}; })
    .do(function (pair) {
        var cfg = pair.cur;
        if (!pair.prev || (cfg.data.renderTag !== pair.prev.data.renderTag)) {
            cfg.renderer.render(cfg.currentState, undefined, undefined);
        }

        renderCursor(cfg.currentState, new Float32Array(cfg.data.curPoints.buffer),
                     cfg.data.highlightIdx, cfg.data.highlightDim, new Uint8Array(cfg.data.pointSizes.buffer));
    })
    .pluck('cur')
    .scan({prev: null, cur: null}, function (acc, v) { return {prev: acc.cur, cur: v}; })
    .bufferWithTime(80)
    .filter(function (arr) { return arr.length; })
    .map(function (arr) {
        var res = arr[arr.length - 1];
        _.extend(res.data,
            arr.reduce(
                function (acc, v) {
                    return {
                        renderTag: Math.max(v.renderTag, acc.renderTag),
                        labelTag: Math.max(v.labelTag, acc.labelTag)
                    };
                },
                {data: { renderTag: 0, labelTag: 0}}));
        return res;
    })
    .do(function (pair) {
        if (!pair.prev || pair.cur.data.renderTag !== pair.prev.data.renderTag) {
            pair.cur.renderer.render(pair.cur.currentState, ['pointpicking', 'edgepicking']);
        }
    })
    .subscribe(_.identity, makeErrorHandler('render effect'));


//move labels when camera moves or new highlight
//$DOM * Observable RenderState -> ()
function setupLabels ($labelCont, latestState, latestHighlightedObject) {

    latestState
        .flatMapLatest(function (currentState) {
            //wait until has samples
            return currentState.get('rendered')
                .flatMap(function () {
                    return latestHighlightedObject.map(function (latestHighlighted) {
                        return _.extend(latestHighlighted, {currentState: currentState});
                    });
                });
        })
        .do(function (pair) {
            var currentState = pair.currentState;
            var idx = pair.idx;
            var dim = pair.dim;
            if (!dim || dim === 1) {
                renderPointLabels($labelCont, currentState, idx);
            } else {
                // TODO: Actually render edges and update poi.
                renderPointLabels($labelCont, currentState, -1);
            }
        })
        .subscribe(_.identity, makeErrorHandler('setuplabels'));
}




//$DOM * RenderState * Observable DOM * textureName-> Observable int
//Changes either from point mouseover or a label mouseover
function getLatestHighlightedObject ($eventTarget, renderState, labelHover, textures) {
    var res = new Rx.ReplaySubject(1);
    res.onNext({idx: -1, dim: 0});

    interaction.setupMousemove($eventTarget, renderState, textures)
        .filter(function (v) { return v && v.idx > -1; })
        .merge($eventTarget.mousedownAsObservable()
            .filter(function (evt) {
                if (evt.target) {
                    if ($(evt.target).hasClass('graph-label') ||
                        $(evt.target).hasClass('highlighted-point') ||
                        $(evt.target).hasClass('highlighted-point-center')) {
                        return false;
                    }
                }
                return true;
            })
            .map(_.constant({dim: 0, idx: -1})))
        .merge(
            labelHover
                .map(function (elt) {
                    return _.values(poi.state.activeLabels)
                        .filter(function (lbl) { return lbl.elt.get(0) === elt; });
                })
                .filter(function (highlightedLabels) { return highlightedLabels.length; })
                // TODO: Tag this as a point properly
                .map(function (highlightedLabels) {
                    return {dim: 1, idx: highlightedLabels[0].idx};
                }))
        .map(function (hit) {
            //TODO: Get rid of this hacky bitshift and change the value
            //      returned by the shader.
            if (hit.dim === 2) {
                hit.idx = hit.idx >> 8;
            }
            return hit;
        })
        .subscribe(res, makeErrorHandler('getLatestHighlightedObject'));

    return res;
}


function setupDragHoverInteractions($eventTarget, renderState, bgColor) {
    //var currentState = renderState;

    var stateStream = new Rx.Subject();
    var latestState = new Rx.ReplaySubject(1);
    stateStream.subscribe(latestState, makeErrorHandler('bad stateStream'));
    stateStream.onNext(renderState);

    var camera = renderState.get('camera');
    var canvas = renderState.get('canvas');

    //pan/zoom
    //Observable Event
    var interactions;
    if(interaction.isTouchBased) {
        debug('Detected touch-based device. Setting up touch interaction event handlers.');
        var eventTarget = $eventTarget[0];
        interactions = interaction.setupSwipe(eventTarget, camera)
            .merge(interaction.setupPinch($eventTarget, camera));
    } else {
        debug('Detected mouse-based device. Setting up mouse interaction event handlers.');
        interactions = interaction.setupDrag($eventTarget, camera)
            .merge(interaction.setupScroll($eventTarget, canvas, camera));
    }
    interactions = Rx.Observable.merge(
        interactions,
        interaction.setupCenter($('#center'),
                                renderState.get('hostBuffers').curPoints,
                                camera),
        interaction.setupZoomButton($('#zoomin'), camera, 1 / 1.25),
        interaction.setupZoomButton($('#zoomout'), camera, 1.25)
    );

    // Picks objects in priority based on order.
    var hitMapTextures = [
        {name: 'pointHitmap', dim: 1},
        {name: 'edgeHitmap', dim: 2}
    ];
    var latestHighlightedObject = getLatestHighlightedObject($eventTarget, renderState, labelHover, hitMapTextures);

    var $labelCont = $('<div>').addClass('graph-label-container');
    $eventTarget.append($labelCont);
    setupLabels($labelCont, latestState, latestHighlightedObject);


    //TODO refactor this is out of place
    var stateWithColor =
        bgColor.map(function (rgb) {

            var currentState = renderState;

            var color = [[rgb.r/256, rgb.g/256, rgb.b/256,
                rgb.a === undefined ? 1 : rgb.a/256]];

            var config = currentState.get('config');
            var options = config.get('options');

            return currentState.set('config',
                    config.set('options',
                        options.set('clearColor', color)));
        });

    //render scene on pan/zoom (get latest points etc. at that time)
    //tag render changes & label changes
    var renderStateUpdates = interactions
        .flatMapLatest(function (camera) {
            return Rx.Observable.combineLatest(
                renderState.get('hostBuffers').curPoints,
                renderState.get('hostBuffers').pointSizes,
                stateWithColor,
                function (curPoints, pointSizes, renderState) {
                    return {renderTag: Date.now(),
                            camera: camera,
                            curPoints: curPoints,
                            pointSizes: pointSizes,
                            renderState: renderState};
                });
        })
        .flatMapLatest(function (data) {
            // TODO: pass in dim. Handle Dim.
            // Temporary hack -- ignore edges.
            return latestHighlightedObject.map(function (latestHighlighted) {
                return _.extend({labelTag: Date.now(), highlightIdx: latestHighlighted.idx, highlightDim: latestHighlighted.dim}, data);
            });
        })
        .do(function(data) {
            var currentState = renderer.setCameraIm(data.renderState, data.camera);
            stateStream.onNext(currentState);
            renderScene(renderer, currentState, data);
        })
        .pluck('renderState');

    return renderStateUpdates;
}


//Observable bool -> { ... }
function setupMarquee(isOn, renderState) {
    var camera = renderState.get('camera');
    var cnv = renderState.get('canvas');
    var transform = function (point) {
        return camera.canvas2WorldCoords(point.x, point.y, cnv);
    };

    var marquee = marqueeFact(renderState, $('#marquee'), isOn, {transform: transform});

    marquee.selections.subscribe(function (sel) {
        debug('selected bounds', sel);
    }, makeErrorHandler('bad marquee selections'));

    marquee.drags.subscribe(function (drag) {
        debug('drag action', drag.start, drag.end);
    }, makeErrorHandler('bad marquee drags'));

    return marquee;
}


// -> Observable DOM
//Return which mouse group element selected
//Side effect: highlight that element
function makeMouseSwitchboard() {

    var mouseElts = $('#marqueerectangle');

    //$DOM * Observable DOM -> ()
    //Highlight selected mouse menu button and disable rest
    var mouseSwitchboard = function (onElt) {
        mouseElts.each(function () {
            debug('toggle', this.id, onElt.id, this.id===onElt.id);
            $(this)[this.id === onElt.id ? 'addClass' : 'removeClass']('on');
        });
    };

    var onElt = Rx.Observable.merge.apply(Rx.Observable,
            mouseElts.get().map(function (elt) {
                return Rx.Observable.fromEvent(elt, 'click').map(_.constant(elt));
            }));

    onElt.subscribe(mouseSwitchboard, makeErrorHandler('mouseSwitchboard'));

    return onElt;
}

function createLegend($elt, urlParams) {
    if (!urlParams.legend) {
        return;
    }

    var legend;
    try {
        legend = JSON.parse(decodeURIComponent(urlParams.legend));
    } catch (err) {
        console.error('Error parsing legend', err);
        return;
    }

    var $title = $elt.children('.legend-title');
    if (legend.title) {
        $title.append(legend.title);
    }
    if (legend.subtitle) {
        $title.after(legend.subtitle);
    }
    if (legend.nodes) {
        $elt.find('.legend-nodes').append(legend.nodes);
    }
    if (legend.edges) {
        $elt.find('.legend-edges').append(legend.edges);
    }

    $elt.show();
}


function createControls(socket) {
    var rxControls = Rx.Observable.fromCallback(socket.emit, socket)('layout_controls', null)
        .map(function (res) {
            if (res && res.success) {
                debug('Received layout controls from server', res.controls);
                return res.controls;
            } else {
                throw new Error((res||{}).error || 'Cannot get layout_controls');
            }
        });

    var $anchor = $('#renderingItems').children('.form-horizontal').empty();
    rxControls.subscribe(function (controls) {
        // Assuming a single layout algorithm for now
        var la = controls[0];

        _.each(la.params, function (param) {
            var $input;
            if (param.type === 'continuous') {
                $input = $('<input>').attr({
                    class: 'menu-slider',
                    id: param.name,
                    type: 'text',
                    'data-slider-id': param.name + 'Slider',
                    'data-slider-min': 0,
                    'data-slider-max': 100,
                    'data-slider-step': 1,
                    'data-slider-value': param.value
                }).data('param', param);
            } else if (param.type === 'discrete') {
                $input = $('<input>').attr({
                    class: 'menu-slider',
                    id: param.name,
                    type: 'text',
                    'data-slider-id': param.name + 'Slider',
                    'data-slider-min': param.min,
                    'data-slider-max': param.max,
                    'data-slider-step': param.step,
                    'data-slider-value': param.value
                }).data('param', param);

            } else if (param.type === 'bool') {
                $input = $('<input>').attr({
                    id: param.name,
                    type: 'checkbox',
                    checked: param.value
                }).data('param', param);
            } else {
                console.warn('Ignoring param of unknown type', param);
                $input = $('<div>').text('Unknown setting type' + param.type);
            }
            var $col = $('<div>').addClass('col-xs-9').append($input);
            var $label = $('<label>').attr({
                for: param.name,
                class: 'control-label col-xs-3',
            }).text(param.prettyName);

            var $entry = $('<div>').addClass('form-group').append($label, $col);

            $anchor.append($entry);
        });

    }, makeErrorHandler('createControls'));

    return rxControls;
}

function setupInspector(inspections) {
    inspections.subscribe(function (res) {
        console.log('Inspector got', res);
    }, makeErrorHandler('inspector error'));
}

function testGrid() {
    var Backgrid = window.Backgrid;
    var Backbone = window.Backbone;
    var columns = [{
        name: 'id', // The key of the model attribute
        label: 'ID', // The name to display in the header
        editable: false, // By default every cell in a column is editable, but *ID* shouldn't be
        // Defines a cell type, and ID is displayed as an integer without the ',' separating 1000s.
        cell: Backgrid.IntegerCell.extend({
        orderSeparator: ''
        })
    }, {
        name: 'name',
        label: 'Name',
        // The cell type can be a reference of a Backgrid.Cell subclass, any Backgrid.Cell subclass instances like *id* above, or a string
        cell: 'string' // This is converted to "StringCell" and a corresponding class in the Backgrid package namespace is looked up
    }, {
        name: 'pop',
        label: 'Population',
        cell: 'integer' // An integer cell is a number cell that displays humanized integers
    }];

    var Territory = Backbone.Model.extend({
        defaults: {
            id: null,
            name: null,
            pop: 42
        }
    });

    var Territories = Backbone.Collection.extend({
        model: Territory,
    });

    var territories = new Territories();
    territories.add({id:1, name: 'First'});
    territories.add({id:2, name: 'Second', pop:34});


    // Initialize a new Grid instance
    var grid = new Backgrid.Grid({
        columns: columns,
        collection: territories
    });

    // Render the grid and attach the root to your HTML document
    $('#inspector').append(grid.render().el);
}

// ... -> Observable renderState
function init(socket, $elt, renderState, urlParams) {
    createLegend($('#graph-legend'), urlParams);

    poi = poiLib(socket);

    var onElt = makeMouseSwitchboard();

    var marqueeIsOn = false;
    var turnOnMarquee = onElt.map(function (elt) {
        if (elt === $('#marqueerectangle')[0]) {
            $(elt).children('i').toggleClass('toggle-on');
            marqueeIsOn = !marqueeIsOn;
        }
        return marqueeIsOn;
    });

    var marquee = setupMarquee(turnOnMarquee, renderState);

    var colors = colorpicker($('#foregroundColor'), $('#backgroundColor'), socket);
    var renderStateUpdates = setupDragHoverInteractions($elt, renderState, colors.backgroundColor);


    shortestpaths($('#shortestpath'), poi, socket);

    //trigger animation on server
    //socket.emit('interaction', {layout: true, play: true});


    $('#timeSlider').rangeSlider({
         bounds: {min: 0, max: 100},
         arrows: false,
         defaultValues: {min: 0, max: 30},
         valueLabels: 'hide', //show, change, hide
         //wheelMode: 'zoom'
      });



    var timeSlide = new Rx.Subject();
    //FIXME: replace $OLD w/ browserfied jquery+jqrangeslider
    $('#timeSlider').on('valuesChanging', function (e, data) {
            timeSlide.onNext({min: data.values.min, max: data.values.max});
            poi.invalidateCache();
        });

    timeSlide.sample(3)
        .do(function (when) {
            var payload = {
                play: true, layout: false,
                timeSubset: {min: when.min, max: when.max}
            };
            socket.emit('interaction', payload);
        })
        .subscribe(_.identity, makeErrorHandler('timeSlide'));

    createControls(socket).subscribe(function () {
        $('#renderingItems').find('[type=checkbox]').each(function () {
            var input = this;
            var param = $(input).data('param');
            $(input).onAsObservable('change').subscribe(
                function () {
                    sendLayoutSetting(socket, param.algoName, param.name, input.checked);
                },
                makeErrorHandler('menu checkbox')
            );
        });

        $('.menu-slider').each(function () {
            var $slider = $(this).bootstrapSlider({});
            var param = $slider.data('param');

            Rx.Observable.merge(
                $slider.onAsObservable('slide'),
                $slider.onAsObservable('slideStop')
            ).distinctUntilChanged()
            .sample(50)
            .subscribe(
                function () {
                    sendLayoutSetting(socket, param.algoName,
                                    param.name, Number($slider.val()));
                },
                makeErrorHandler('menu slider')
            );
        });
    },
    makeErrorHandler('bad controls'));

    Rx.Observable.zip(
        marquee.drags,
        marquee.drags.flatMapLatest(function () {
            return marquee.selections.take(1);
        }),
        function(a, b) { return {drag: a, selection: b}; }
    ).subscribe(function (move) {
        var payload = {play: true, layout: true, marquee: move};
        socket.emit('interaction', payload);
    }, makeErrorHandler('marquee error'));

    var inspections = new Rx.ReplaySubject(1);
    setupInspector(inspections);
    marquee.selections.subscribe(function (sel) {
        console.log(sel);

        Rx.Observable.fromCallback(socket.emit, socket)('inspect', sel).subscribe(
            inspections,
            makeErrorHandler('fetch data for inspector')
        );
    });


    var $tooltips = $('[data-toggle="tooltip"]');
    var $bolt = $('#simulate .fa');
    var $shrinkToFit = $('#center .fa');

    $tooltips.tooltip('show');
    $bolt.toggleClass('automode', true).toggleClass('toggle-on', true);
    $shrinkToFit.toggleClass('automode', true).toggleClass('toggle-on', true);

    var numTicks = urlParams.play || 0;

    //tick stream until canceled/timed out (end with 'false')
    var autoLayingOut =
        Rx.Observable.merge(
            Rx.Observable.return(Rx.Observable.interval(20)),
            Rx.Observable.merge(
                    $('#simulate').onAsObservable('click')
                        .filter(function (evt){ return evt.originalEvent !== undefined; }),
                    Rx.Observable.timer(numTicks))
                .take(1)
                .map(_.constant(Rx.Observable.return(false))))
        .flatMapLatest(_.identity);

    //tick stream until canceled/timed out (end with 'false')
    var autoCentering =
        Rx.Observable.merge(
            Rx.Observable.return(Rx.Observable.interval(1000)),
            Rx.Observable.merge(
                    Rx.Observable.merge(
                            Rx.Observable.fromEvent($('#center'), 'click'),
                            Rx.Observable.fromEvent($('#simulate'), 'click'),
                            $('#simulation').onAsObservable('mousewheel'),
                            $('#simulation').onAsObservable('mousedown'),
                            $('#zoomin').onAsObservable('click'),
                            $('#zoomout').onAsObservable('click'))
                        //skip events autoplay triggers
                        .filter(function (evt){ return evt.originalEvent !== undefined; }),
                    Rx.Observable.timer(numTicks))
                .take(1)
                .map(_.constant(Rx.Observable.return(false))))
        .flatMapLatest(_.identity);
    var isAutoCentering = new Rx.ReplaySubject(1);
    autoCentering.subscribe(isAutoCentering, makeErrorHandler('bad autocenter'));


    var runLayout =
        Rx.Observable.fromEvent($('#simulate'), 'click')
            .map(function () { return $bolt.hasClass('toggle-on'); })
            .do(function (wasOn) {
                $bolt.toggleClass('toggle-on', !wasOn);
            })
            .flatMapLatest(function (wasOn) {
                var isOn = !wasOn;
                return isOn ? Rx.Observable.interval(INTERACTION_INTERVAL) : Rx.Observable.empty();
            });

    runLayout
        .subscribe(
            function () { socket.emit('interaction', {play: true, layout: true}); },
            makeErrorHandler('Error stimulating graph'));

    autoLayingOut.subscribe(
        function (evt) {
            if (evt !== false) {
                var payload = {play: true, layout: true};
                socket.emit('interaction', payload);
            }
        },
        makeErrorHandler('autoLayingOut error'),
        function () {
            isAutoCentering.take(1).subscribe(function (v) {
                if (v !== false) {
                    $('#center').trigger('click');
                }
            });
            $tooltips.tooltip('hide');
            $bolt.removeClass('automode').removeClass('toggle-on');
        }
    );

    autoCentering.subscribe(
        function (count) {
            if (count === false || count < 3  ||
                (count % 2 === 0 && count < 10) ||
                count % 10 === 0) {
                $('#center').trigger('click');
            }
        },
        makeErrorHandler('autoCentering error'),
        function () {
            $shrinkToFit.toggleClass('automode', false).toggleClass('toggle-on', false);
        });

    return renderStateUpdates;
}


module.exports = init;
