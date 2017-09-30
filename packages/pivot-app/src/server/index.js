import path from 'path';
import express from 'express';
import bodyParser from 'body-parser';
import { VError, WError } from 'verror';
import createLogger from 'pivot-shared/logger';
import configureRenderMiddleware from './render';
import { createAppModel } from 'pivot-shared/models';
import configureServices from 'pivot-shared/services';
import configureFalcorRouter from 'pivot-app/router/falcor';
import configureSocketListeners from 'pivot-app/server/socket';
import configureFalcorModelFactory from 'pivot-app/router/model';
import { HealthChecker, authenticateMiddleware } from './middleware';

const log = createLogger(__filename);
const io = global.__graphistry_socket_io__;
const convict = global.__graphistry_convict_conf__;

const app = new express.Router();
const pivotDataPath = convict.get('pivotApp.dataDir');
const pivotPath = path.resolve(pivotDataPath, 'pivots');
const investigationPath = path.resolve(pivotDataPath, 'investigations');
const buildNum = __BUILDNUMBER__ === undefined ? 'local build' : `build #${__BUILDNUMBER__}`;
const buildDesc = {branch:__GITBRANCH__, commit:__GITCOMMIT__, build:__BUILDNUMBER__, builton: __BUILDDATE__};

log.info(buildDesc, `Starting ${buildNum}`);

let services, getDataSource, servicesConfig = {
    pivotPath,
    investigationPath,
    app: createAppModel(),
    investigationsByIdCache: {}
};

getDataSource = configureFalcorRouter(
     services = configureServices(convict, servicesConfig));

// Hot reload the Falcor Router services
if (module.hot) {
    require('./hot-server.js');
    module.hot.accept('pivot-shared/services', () => {
        let nextConfigureServices = require('pivot-shared/services').default; // eslint-disable-line global-require
        getDataSource = configureFalcorRouter(
             services = nextConfigureServices(convict, servicesConfig));
    });
}

configureSocketListeners(io, (req) => getDataSource(req, { streaming: true }));

// Install healthcheck route
app.get(`/healthcheck`, ((healthcheck) => (req, res) => {
    const health = healthcheck();
    log.info({...health, req, res}, 'healthcheck');
    res.status(health.clear.success ? 200 : 500).json({...health.clear});
})(HealthChecker()));

// Use authentication middleware
app.use(authenticateMiddleware(convict));
app.use(express.static(path.join(process.cwd(), './www/public')));
app.use('/public', express.static(path.join(process.cwd(), './www/public')));

const renderPageRouter = new express.Router();
const renderPageMiddleware = configureRenderMiddleware(
    convict, configureFalcorModelFactory(
        (req) => getDataSource(req, { streaming: false })));

// Add render routes
['', ':activeScreen', ':activeScreen/:investigationId'].forEach((renderPath) => {
    renderPageRouter.get(`/${renderPath}`, renderPageHandler);
});

app.use(renderPageRouter);

export default app;

function renderPageHandler(req, res) {
    renderPageMiddleware(req, res).subscribe({
        error: requestErrorHandler.bind(null, req, res),
        next({ status, payload }) {
            if(convict.get('env') === 'development') {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            }
            res.status(status).send(payload);
        },
    });
}

function requestErrorHandler(req, res, err) {
    log.warn({ req, res, err }, 'An error occured while processing the HTTP request. Responding to the request with an error code and message, if possible.');
    if(res.headersSent) {
        log.info({ req, res }, 'requestErrorHandler not sending error to client, because headers (and likely data) has already been sent to the client. The error will only be logged server-side, and the request will be ended in its current state.');
        res.end();
        return;
    }
    const { httpStatus = 500 } = VError.info(err);
    // Whether the client prefers JSON over text/HTML, given any `Accepts` headers in the request
    const wantsJsonResponse = req.is('json') || req.accepts([
        'text/html', 'text/*', 'application/json'
    ]) === 'application/json';

    res.status(httpStatus).send(wantsJsonResponse && { success: false, msg: err.message } || err.message);
}
