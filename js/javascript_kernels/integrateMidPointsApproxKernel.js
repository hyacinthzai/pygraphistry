var Kernel = require('../kernel.js'),
    Q = require('q'),
    debug = require("debug")("graphistry:graph-viz:cl:barensKernels"),
    _     = require('underscore'),
    cljs  = require('../cl.js');
    util = require('../util.js'),
    ArgsType = require('./ArgsType.js');

var integrateMidPointsApproxKernel = function (clContext) {


this.argsIntegrateMidPointsApprox = [
    'numMidPoints', 'tau', 'inputPositions', 'curForces', 'swings',
    'tractions', 'outputPositions'
];

    this.faIntegrate = new Kernel('faIntegrateMidPointsApprox', this.argsIntegrateMidPointsApprox,
                               ArgsType, 'forceAtlas2/faIntegrateMidPointsApprox.cl', clContext);


    this.kernels = [this.faIntegrate];

    this.setPhysics = function(cfg, mask) {
        _.each(this.kernels, function (k) {
            k.set(_.pick(cfg, k.argNames))
        })
        //this.faIntegrate.set({flags: mask});
    };




    this.execKernels = function(simulator) {
      var buffers = simulator.buffers;

      this.faIntegrate.set({
        numMidPoints: simulator.numMidPoints,
        inputPositions: buffers.curMidPoints.buffer,
        curForces: buffers.curForces.buffer,
        swings: buffers.swings.buffer,
        tractions: buffers.tractions.buffer,
        outputPositions: buffers.nextMidPoints.buffer
      });

      var resources = [
        buffers.curPoints,
        buffers.forwardsDegrees,
        buffers.backwardsDegrees,
          buffers.curForces,
          buffers.swings,
            buffers.tractions,
            buffers.nextPoints
      ];

      simulator.tickBuffers(['nextPoints']);

    debug('Running kernel faIntegrateApprox');
    return this.faIntegrate.exec([simulator.numMidPoints], resources)
      .fail(util.makeErrorHandler('Executing IntegrateApprox failed'));
    }

}

module.exports = integrateMidPointsApproxKernel;
