#!/bin/bash -lex

### This is the launch script for Graphistry.
### There are many important shell parameters that govern behavior.
###
### $GRAPHISTRY_NETWORK is the name of the network it runs in. Override this with "staging", or "production", or "demo2".
### $DB_BACKUP_DIRECTORY is where Postgres backups end up. We are not yet doing backups; this is DEV-879.
### $PG_USER and $PG_PASS configure the database user that the app uses.
### $GRAPHISTRY_APP_CONFIG is the json override for app configuration, like '{"LOG_LEVEL": "DEBUG"}', that gets filtered through supervisord.
### $GRAPHISTRY_DATA_CACHE is where datasets get written to disk.
### $GRAPHISTRY_WORKBOOK_CACHE is where workbooks get written to disk.
### $NGINX_HTTP_PORT and $NGINX_HTTPS_PORT are where we expose our app to the host.


### 0. Ensure that we can get an OpenCL context.

nvidia-docker run --rm graphistry/central-and-vizservers:$1 clinfo

### 1. Ensure we have a network for our application to run in.

GRAPHISTRY_NETWORK=${GRAPHISTRY_NETWORK:-monolith-network}
docker network inspect $GRAPHISTRY_NETWORK || docker network create $GRAPHISTRY_NETWORK

### 2. Postgres.

DB_BACKUP_DIRECTORY=${DB_BACKUP_DIRECTORY:-../.pgbackup}
PG_USER=${PG_USER:-graphistry}
PG_PASS=${PG_PASS:-graphtheplanet}
PG_BOX_NAME=${GRAPHISTRY_NETWORK}-pg

if (docker exec $PG_BOX_NAME psql -c "select 'database is up' as healthcheck" postgresql://${PG_USER}:${PG_PASS}@${PG_BOX_NAME}:5432) ; then
  echo Keeping db.
else
  echo Bringing up db.
  docker run -d --restart=unless-stopped --net none --name ${PG_BOX_NAME} -e POSTGRES_USER=${PG_USER} -e POSTGRESS_PASSWORD=${PG_PASS} postgres:9.5
  if [ -z $DB_RESTORE ] ; then
    echo Nothing to restore.
  else
    echo Restoring db with the contents of ${DB_RESTORE}.
    for i in {1..100} ; do docker exec pg psql -U${PG_USER} -c "select 'database is up' as healthcheck" || sleep 5 ; done
    docker exec -i pg psql -U${PG_USER} < ${DB_RESTORE}
  fi
  docker network disconnect none pg
  docker network connect $GRAPHISTRY_NETWORK pg
fi

### 3. Cluster membership.

MONGO_BOX_NAME=${GRAPHISTRY_NETWORK}-mongo

docker rm -f -v $MONGO_BOX_NAME || true
docker run --net $GRAPHISTRY_NETWORK --restart=unless-stopped --name $MONGO_BOX_NAME -d mongo:2

for i in {1..10} ; do echo $i; docker exec $MONGO_BOX_NAME mongo --eval "2+2" || sleep $i ; done
MONGO_NAME=cluster
MONGO_USERNAME=graphistry
MONGO_PASSWORD=graphtheplanet
docker exec $MONGO_BOX_NAME bash -c "mongo --eval '2+2' -u $MONGO_USERNAME -p $MONGO_PASSWORD localhost/$MONGO_NAME || (mongo --eval \"db.createUser({user: '$MONGO_USERNAME', pwd: '$MONGO_PASSWORD', roles: ['readWrite']})\" localhost/$MONGO_NAME && mongo --eval 'db.gpu_monitor.createIndex({updated: 1}, {expireAfterSeconds: 30})'  -u $MONGO_USERNAME -p $MONGO_PASSWORD localhost/$MONGO_NAME && mongo --eval 'db.node_monitor.createIndex({updated: 1}, {expireAfterSeconds: 30})' -u $MONGO_USERNAME -p $MONGO_PASSWORD localhost/$MONGO_NAME )"

### 4. Stop app, make log directories, start app.

VIZAPP_BOX_NAME=${GRAPHISTRY_NETWORK}-viz

docker rm -f -v $VIZAPP_BOX_NAME || true

mkdir -p central-app worker graphistry-json clients reaper

stat ../httpd-config.json || (echo '{}' > ../httpd-config.json)
echo "${GRAPHISTRY_APP_CONFIG:-{\}}" > ./httpd-config.json

CENTRAL_MERGED_CONFIG=$(docker   run --rm -v `pwd`/../httpd-config.json:/tmp/box-config.json -v `pwd`/httpd-config.json:/tmp/local-config.json graphistry/central-and-vizservers:$1 bash -c 'mergeThreeFiles.js $graphistry_install_path/central-cloud-options.json    /tmp/box-config.json /tmp/local-config.json')
VIZWORKER_MERGED_CONFIG=$(docker run --rm -v `pwd`/../httpd-config.json:/tmp/box-config.json -v `pwd`/httpd-config.json:/tmp/local-config.json graphistry/central-and-vizservers:$1 bash -c 'mergeThreeFiles.js $graphistry_install_path/viz-worker-cloud-options.json /tmp/box-config.json /tmp/local-config.json')

nvidia-docker run --net $GRAPHISTRY_NETWORK --restart=unless-stopped --name $VIZAPP_BOX_NAME --link=${PG_BOX_NAME}:pg --link=${MONGO_BOX_NAME}:mongo  -e "GRAPHISTRY_CENTRAL_CONFIG=${CENTRAL_MERGED_CONFIG}" -e "GRAPHISTRY_VIZWORKER_CONFIG=${VIZWORKER_MERGED_CONFIG}" -d -v `pwd`/central-app:/var/log/central-app -v `pwd`/worker:/var/log/worker -v `pwd`/graphistry-json:/var/log/graphistry-json -v `pwd`/clients:/var/log/clients -v `pwd`/reaper:/var/log/reaper -v ${GRAPHISTRY_DATA_CACHE:-`pwd`/data_cache}:/tmp/graphistry/data_cache -v ${GRAPHISTRY_WORKBOOK_CACHE:-`pwd`/workbook_cache}:/tmp/graphistry/workbook_cache -v `pwd`/supervisor:/var/log/supervisor graphistry/central-and-vizservers:$1

### 5. Nginx, maybe with ssl.

NGINX_BOX_NAME=${GRAPHISTRY_NETWORK}-nginx
NGINX_HTTP_PORT=${NGINX_HTTP_PORT:-80}
NGINX_HTTPS_PORT=${NGINX_HTTPS_PORT:-443}

docker rm -f -v $NGINX_BOX_NAME || true

if [ -n "$SSLPATH" ] ; then
    SSL_MOUNT="-v ${SSLPATH}:/etc/graphistry/ssl:ro"
    NGINX_IMAGE_SUFFIX=""
else
    SSL_MOUNT=""
    NGINX_IMAGE_SUFFIX=".httponly"
fi

docker run --net $GRAPHISTRY_NETWORK -p 80:$NGINX_HTTP_PORT -p 443:$NGINX_HTTPS_PORT --link=${VIZAPP_BOX_NAME}:vizapp --restart=unless-stopped --name $NGINX_BOX_NAME -d -v `pwd`/nginx:/var/log/nginx $SSL_MOUNT graphistry/nginx-central-vizservers:1.4.0.32${NGINX_IMAGE_SUFFIX}

### 6. Splunk.

SPLUNK_BOX_NAME=${GRAPHISTRY_NETWORK}-splunk

docker rm -f -v $SPLUNK_BOX_NAME || true

if [ -n "$SPLUNK_PASSWORD" ] ; then
    docker run --name $SPLUNK_BOX_NAME --restart=unless-stopped -d -v /etc/graphistry/splunk/:/opt/splunkforwarder/etc/system/local -v `pwd`/central-app:/var/log/central-app -v `pwd`/worker:/var/log/worker -v `pwd`/graphistry-json:/var/log/graphistry-json -v `pwd`/clients:/var/log/clients -v `pwd`/reaper:/var/log/reaper -v `pwd`/supervisor:/var/log/supervisor -v `pwd`/nginx:/var/log/nginx graphistry/splunkfwd:6.4.1 bash -c "/opt/splunkforwarder/bin/splunk edit user admin -password $SPLUNK_PASSWORD -auth admin:$SPLUNK_ADMIN --accept-license --answer-yes ; /opt/splunkforwarder/bin/splunk start --nodaemon --accept-license --answer-yes"
fi

### Done.

### Patches.

docker exec $VIZAPP_BOX_NAME bash -c 'sed -i -e "s_http://localhost:3000/__" /var/graphistry/node_modules/@graphistry/central/assets/index.html && for f in /var/graphistry/node_modules/\@graphistry/central/assets/[A-Z]* ; do mv $f /tmp/graphistry/data_cache/$(basename $f).$(basename $f | tr -dc A-Za-z | shasum | cut -d " " -f 1) ; done' # to be removed once DEV-906 is fixed.

echo SUCCESS.
echo Graphistry has been launched, and should be up and running.
echo SUCCESS.
