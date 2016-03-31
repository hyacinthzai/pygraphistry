'use strict';

var _       = require('underscore');
var graphlib = require('graphlib');
var Graph = graphlib.Graph;

var util    = require('./util.js');
var ComputedColumnSpec = require('./ComputedColumnSpec.js');

//////////////////////////////////////////////////////////////////////////////
// DEFAULT ENCODINGS (TODO: Should these move into another file?)
//////////////////////////////////////////////////////////////////////////////

// Required fields in an encoding
//
// key: name of resulting local buffer
// arrType: constructor for typed array
// numberPerGraphComponent: Number of elements in resulting array relative to number
//      of input graphComponentType. E.g., edge colors have twice as many as number of edges
// graphComponentType: 'point' | 'edge'
// dependencies: What buffers the encoding needs to construct itself. Represented as
//      an array of arrays, showing namespace + name. These will be passed into the
//      generator function.
// generatorFunc: Function to produce encoded buffer. Takes in dependencies as arguments,
//      numberOfGraphElements, and index requested
//      then an output array of the appropriate size, and the number of graphType elements.
//

// TODO: Treat encodings as separate from computed columns as far as dataframe
// stacking goes. Adding/changing computed col should impact only the newest dataframe
// frame, but changing encoding should impact everything.

// TODO: Replace aggregate dependencies that point to "raw" dataset with
// some sort of pointer to a base dataframe view

// Only aggregates can point to specific dataframe view (otherwise indexing doesn't make sense);
// TODO: Implement aggregates across computed columns too.

var defaultLocalBuffers = {

    logicalEdges: new ComputedColumnSpec({
        arrType: Uint32Array,
        type: 'number',
        numberPerGraphComponent: 2,
        graphComponentType: 'edge',
        version: 0,
        dependencies: [
            ['forwardsEdges', 'hostBuffer']
        ],
        computeAllValues: function (forwardsEdges, outArr, numGraphElements) {
            for (var i = 0; i < outArr.length; i++) {
                outArr[i] = forwardsEdges.edgesTyped[i];
            }
            return outArr;
        }
    }),

    forwardsEdgeStartEndIdxs: new ComputedColumnSpec({
        arrType: Uint32Array,
        type: 'number',
        numberPerGraphComponent: 2,
        graphComponentType: 'point',
        version: 0,
        dependencies: [
            ['forwardsEdges', 'hostBuffer']
        ],
        computeAllValues: function (forwardsEdges, outArr, numGraphElements) {
            for (var i = 0; i < outArr.length; i++) {
                outArr[i] = forwardsEdges.edgeStartEndIdxsTyped[i];
            }
            return outArr;
        }
    }),

    backwardsEdgeStartEndIdxs: new ComputedColumnSpec({
        arrType: Uint32Array,
        type: 'number',
        numberPerGraphComponent: 2,
        graphComponentType: 'point',
        version: 0,
        dependencies: [
            ['backwardsEdges', 'hostBuffer']
        ],
        computeAllValues: function (backwardsEdges, outArr, numGraphElements) {
            for (var i = 0; i < outArr.length; i++) {
                outArr[i] = backwardsEdges.edgeStartEndIdxsTyped[i];
            }
            return outArr;
        }
    }),

    pointColors: new ComputedColumnSpec({
        arrType: Uint32Array,
        type: 'color',
        filterable: true,
        numberPerGraphComponent: 1,
        graphComponentType: 'point',
        version: 0,
        dependencies: [
            ['__pointCommunity', 'point']
        ],

        computeSingleValue: function (pointCommunity, idx, numGraphElements) {

            var palette = util.palettes.qual_palette2;
            var pLen = palette.length;
            var color = palette[pointCommunity % pLen];

            return color;
        }

    }),

    edgeColors: new ComputedColumnSpec({
        arrType: Uint32Array,
        type: 'color',
        filterable: true,
        numberPerGraphComponent: 2,
        graphComponentType: 'edge',
        version: 0,
        dependencies: [
            ['forwardsEdges', 'hostBuffer'],
            ['pointColors', 'localBuffer']
        ],

        computeAllValues: function (forwardsEdges, pointColors, outArr, numGraphElements) {

            var edgesTyped = forwardsEdges.edgesTyped;

            for (var idx = 0; idx < outArr.length; idx++) {
                var nodeIdx = edgesTyped[idx];
                outArr[idx] = pointColors[nodeIdx];
            }

            return outArr;
        }

    }),

    pointSizes: new ComputedColumnSpec({
        arrType: Uint8Array,
        type: 'number',
        filterable: true,
        numberPerGraphComponent: 1,
        graphComponentType: 'point',
        version: 0,
        dependencies: [['__defaultPointSize', 'point']],
        computeSingleValue: function (defaultPointSize, idx, numGraphElements) {
            return defaultPointSize;
        }
    }),

    edgeHeights: new ComputedColumnSpec({
        arrType: Float32Array,
        type: 'number',
        filterable: true,
        index: 'sortedEdge',
        numberPerGraphComponent: 2,
        graphComponentType: 'edge',
        version: 0,
        dependencies: [

        ],
        computeSingleValue: function (idx, numGraphElements) {
            // TODO: Do we need this?
            return 0;
        }
    })

};


var defaultHostBuffers = {

    forwardsEdgeWeights: new ComputedColumnSpec({
        arrType: Float32Array,
        type: 'number',
        filterable: true,
        numberPerGraphComponent: 1,
        graphComponentType: 'edge',
        version: 0,
        dependencies: [
        ],
        computeAllValues: function (outArr, numGraphElements) {
            for (var i = 0; i < outArr.length; i++) {
                outArr[i] = 1.0;
            }
            return outArr;
        }
    }),

    backwardsEdgeWeights: new ComputedColumnSpec({
        arrType: Float32Array,
        type: 'number',
        filterable: true,
        numberPerGraphComponent: 1,
        graphComponentType: 'edge',
        version: 0,
        dependencies: [
        ],
        computeAllValues: function (outArr, numGraphElements) {
            for (var i = 0; i < outArr.length; i++) {
                outArr[i] = 1.0;
            }
            return outArr;
        }
    }),

};

// TODO: Allow users to specify which view to pull dependencies from.
var defaultColumns = {
    hostBuffer: defaultHostBuffers
};

var defaultEncodingColumns = {
    localBuffer: defaultLocalBuffers
};

//////////////////////////////////////////////////////////////////////////////
// Constructor
//////////////////////////////////////////////////////////////////////////////

function ComputedColumnManager () {
    // We maintain a depenency graph between columns. dependency -> CC
    this.dependencyGraph = new Graph();
    this.activeComputedColumns = {};

    // TODO FIXME HACK: Computed Column Manager should not understand logic of
    // knowing which specs to swap between, or even what defaults are.
    // Until we have a proper encodings manager, it will be a storing place for
    // that kind of basic information.
    this.overlayBufferSpecs = {};
}

//////////////////////////////////////////////////////////////////////////////
// Loading / Adding functions
//////////////////////////////////////////////////////////////////////////////

function keyFromColumn (columnType, columnName) {
    var key = '' + columnType + ':' + columnName;
    return key;
}

function typeAndNameFromKey (key) {
    var parts = key.split(':');
    return {
        columnType: parts[0],
        columnName: parts[1]
    };
}

// TODO: No special function name for local buffer
ComputedColumnManager.prototype.loadDefaultLocalBuffer = function (dataframe, name) {
    if (defaultLocalBuffers[name]) {
        this.addComputedColumn(dataframe, 'localBuffer', name, defaultLocalBuffers[name]);
    } else {
        throw new Error('Attempted to reset a local buffer that does not exist');
    }
};

ComputedColumnManager.prototype.bumpVersionsOnDependencies = function (columnType, columnName) {
    var columnKey = keyFromColumn(columnType, columnName);

    var keysToBump = [columnKey];
    // Walk through all dependencies of the provided column, to make sure they're also bumped
    var queue = [columnKey]; // push, shift
    while (queue.length > 0) {
        var workingKey = queue.shift();
        var outEdges = this.dependencyGraph.outEdges(workingKey);

        var newNodeKeys = _.pluck(outEdges, 'w');
        _.each(newNodeKeys, (key) => {
            keysToBump.push(key);
            queue.push(key);
        });
    }

    _.each(keysToBump, (key) => {
        var {columnType, columnName} = typeAndNameFromKey(key);
        var spec = this.getComputedColumnSpec(columnType, columnName);
        spec.bumpVersion();
    });
};

ComputedColumnManager.prototype.removeComputedColumnInternally = function (columnType, columnName) {
    var columnKey = keyFromColumn(columnType, columnName);

    // Check if there's something that depends on this column.
    // In the dependency graph, that's represented by an outgoing edge
    var outEdges = this.dependencyGraph.outEdges(columnKey);
    if (outEdges.length > 0) {
        throw new Error('Attempted to remove computed column that is required for another');
    }

    delete this.activeComputedColumns[columnType][columnName];

    // Remove node from graph.
    // TODO: Do we want to deal with dangling nodes in the graph at all,
    // or is it a non concern (since they won't be reachable)
    this.dependencyGraph.removeNode(columnKey);
};

// Remove edges in dependency graph for a given columns dependencies.
ComputedColumnManager.prototype.removeInwardColumnDependencyEdges = function (columnType, columnName) {

    var columnKey = keyFromColumn(columnType, columnName);
    var inEdges = this.dependencyGraph.inEdges(columnKey);

    _.each(inEdges, (edge) => {
        this.dependencyGraph.removeEdge(edge.v, edge.w);
    });

};

ComputedColumnManager.prototype.loadComputedColumnSpecInternally = function (columnType, columnName, spec) {
    // TODO: Validate that we don't form a cycle

    // Check to see if we're updating an existing one, or simply adding a new one.
    // This is mostly for internal dependency bookkeeping.
    var hasColumn = this.hasColumn(columnType, columnName);

    if (hasColumn) {
        this.removeInwardColumnDependencyEdges(columnType, columnName);
        // this.removeComputedColumnInternally(columnType, columnName);
    }

    var columnKey = keyFromColumn(columnType, columnName);
    var dependencyGraph = this.dependencyGraph;

    this.activeComputedColumns[columnType] = this.activeComputedColumns[columnType] || {};
    this.activeComputedColumns[columnType][columnName] = spec;

    // Add to graph
    dependencyGraph.setNode(columnKey);

    // Add dependencies to graph if they're not already there.
    // Add edge from dependency to this column
    _.each(spec.dependencies, function (dep) {
        var depKey = keyFromColumn(dep[1], dep[0]);

        if (!dependencyGraph.hasNode(depKey)) {
            dependencyGraph.setNode(depKey);
        }

        dependencyGraph.setEdge(depKey, columnKey);
    });

    // Assert that no dependency cycles were created
    if (!graphlib.alg.isAcyclic(dependencyGraph)) {
        throw new Error('Attempted to add a computed column that created a cycle');
    }

    // Walk through dependency tree and bump versions based on this change
    this.bumpVersionsOnDependencies(columnType, columnName);
};

// Public facing function, because it handles registering with the dataframe too.
ComputedColumnManager.prototype.addComputedColumn = function (dataframe, columnType, columnName, desc) {
    this.loadComputedColumnSpecInternally(columnType, columnName, desc);
    dataframe.registerNewComputedColumn(this, columnType, columnName);
};


ComputedColumnManager.prototype.loadDefaultColumns = function () {
    var that = this;

    // copy in defaults. Copy so we can recover defaults when encodings change
    _.each(defaultColumns, function (cols, colType) {
        _.each(cols, function (colDesc, name) {
            that.loadComputedColumnSpecInternally(colType, name, colDesc);
        });
    });

};


ComputedColumnManager.prototype.loadEncodingColumns = function () {
    var that = this;

    // copy in defaults. Copy so we can recover defaults when encodings change
    _.each(defaultEncodingColumns, function (cols, colType) {
        _.each(cols, function (colDesc, name) {
            that.loadComputedColumnSpecInternally(colType, name, colDesc);
        });
    });

};

//////////////////////////////////////////////////////////////////////////////
// Lightweight Getters
//////////////////////////////////////////////////////////////////////////////

ComputedColumnManager.prototype.getComputedColumnSpec = function (columnType, columnName) {
    return this.activeComputedColumns[columnType][columnName];
};

ComputedColumnManager.prototype.getActiveColumns = function () {
    return this.activeComputedColumns;
};

ComputedColumnManager.prototype.getColumnVersion = function (columnType, columnName) {
    return this.activeComputedColumns[columnType][columnName].version;
};

ComputedColumnManager.prototype.hasColumn = function (columnType, columnName) {
    if (this.activeComputedColumns[columnType] && this.activeComputedColumns[columnType][columnName]) {
        return true;
    }
    return false;
};

//////////////////////////////////////////////////////////////////////////////
// Value Getters (where the magic happens)
//////////////////////////////////////////////////////////////////////////////

ComputedColumnManager.prototype.getValue = function (dataframe, columnType, columnName, idx) {

    var columnDesc = this.activeComputedColumns[columnType][columnName];
    // Check to see if we have have column registered
    if (!columnDesc || !columnDesc.isCompletelyDefined()) {
        throw new Error('Invalid column creation function for: ', columnType, columnName);
    }

    // Check if the computation can't be done on a single one (quickly)
    // E.g., requires an aggregate, so might as well compute all.
    if (!columnDesc.computeSingleValue) {
        var resultArray = this.getDenseMaterializedArray(dataframe, columnType, columnName);
        if (columnDesc.numberPerGraphComponent === 1) {
            return resultArray[idx];
        } else {
            var returnArr = new columnDesc.arrType(columnDesc.numberPerGraphComponent);
            for (var j = 0; j < columnDesc.numberPerGraphComponent; j++) {
                returnArr[j] = resultArray[idx*columnDesc.numberPerGraphComponent + j];
            }
            return returnArr;
        }
    }

    // Nothing precomputed -- recompute
    // TODO: Cache these one off computations?

    var dependencies = _.map(columnDesc.dependencies, function (dep) {
        var columnName = dep[0];
        var columnType = dep[1];
        // TODO: Impl
        return dataframe.getCell(idx, columnType, columnName);
    });

    dependencies.push(idx);
    dependencies.push(dataframe.getNumElements(columnDesc.graphComponentType));

    if (columnDesc.computeSingleValue) {
        return columnDesc.computeSingleValue.apply(this, dependencies);
    } else {
        throw new Error('No computed column creation function');
    }
};



ComputedColumnManager.prototype.getDenseMaterializedArray = function (dataframe, columnType, columnName, optionalArray) {

    var columnDesc = this.activeComputedColumns[columnType][columnName];

    // Check to see if we have have column registered
    if (!columnDesc || !columnDesc.isCompletelyDefined()) {
        throw new Error('Invalid column creation function for: ', columnType, columnName);
    }

    // Get dependencies
    var dependencies = _.map(columnDesc.dependencies, function (dep) {
        var columnName = dep[0];
        var columnType = dep[1];
        // TODO: Impl
        // TODO: Should this be an iterator instead of a raw array?
        return dataframe.getColumnValues(columnName, columnType);
    });

    var numGraphElements = dataframe.getNumElements(columnDesc.graphComponentType);
    var outputSize = columnDesc.numberPerGraphComponent * numGraphElements;
    var outputArr = new columnDesc.arrType(outputSize);

    // Check if an explicit function is provided to compute all
    if (columnDesc.computeAllValues) {
        dependencies.push(outputArr);
        dependencies.push(numGraphElements);
        return columnDesc.computeAllValues.apply(this, dependencies) || outputArr;

    } else if (columnDesc.computeSingleValue) {
        // Compute each individually using single function
        // dependencies.push(0);
        // dependencies.push(numGraphElements);

        var singleDependencies = _.map(dependencies, function () {
            return 0;
        });
        singleDependencies.push(0);
        singleDependencies.push(numGraphElements);


        for (var i = 0; i < numGraphElements; i++) {

            // set dependencies for this call
            _.each(dependencies, function (arr, idx) {
                if (columnDesc.numberPerGraphComponent === 1) {
                    singleDependencies[idx] = arr[i];

                } else {
                    var valueArray = new arr.constructor(columnDesc.numberPerGraphComponent);
                    for (var j = 0; j < columnDesc.numberPerGraphComponent; j++) {
                        valueArray[j] = arr[i*columnDesc.numberPerGraphComponent + j];
                    }
                    singleDependencies[idx] = valueArray;
                }
            });
            singleDependencies[singleDependencies.length - 2] = i;

            if (columnDesc.numberPerGraphComponent === 1) {
                outputArr[i] = columnDesc.computeSingleValue.apply(this, singleDependencies);
            } else {
                var res = columnDesc.computeSingleValue.apply(this, singleDependencies);
                for (var j = 0; j < columnDesc.numberPerGraphComponent; j++) {
                    outputArr[i*columnDesc.numberPerGraphComponent + j] = res[j];
                }
            }
        }
        return outputArr;

    } else {
        throw new Error('No computed column creation function');
    }

};



module.exports = ComputedColumnManager;
