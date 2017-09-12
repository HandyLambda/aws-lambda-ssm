'use strict';

const AWS = require('aws-sdk');
const ssm = new AWS.SSM();
const INSTANCE_IDS = process.env.INSTANCE_IDS.split(',')
  .filter(i => !!i);
const SSM_DOCUMENT = process.env.SSM_DOCUMENT;
const MAX_SSM_WAIT_RETRIES = process.env.MAX_SSM_WAIT_RETRIES || 50;

exports.handler = (event, context, callback) => {
  if (!SSM_DOCUMENT || !INSTANCE_IDS) {
    return reportFailure('SSM_DOCUMENT and INSTANCE_IDS must be set', callback);
  }
  return runCommand(SSM_DOCUMENT, INSTANCE_IDS, callback);
};

const reportFailure = (message, callback) => {
  const error = JSON.stringify(message);
  console.error(message);
  return callback(new Error(error));
};

const ssmGetCommmandInvocation = params => new Promise((resolve, reject) =>
  ssm.getCommandInvocation(params, (err, data) => {
    if (err) reject(err);
    else resolve(Object.assign(data, params));
  })
);

const promiseTimeout = time => new Promise((resolve) => setTimeout(resolve, time));

const waitTillSsmCommandIsComplete = ({ params, maxRetries }) => {
  const _waitTillSsmCommandIsComplete = ({ params, maxRetries, resolve, reject }) => {
    ssmGetCommmandInvocation(params)
      .then(r => {
        if (r.Status === 'Success') {
          return resolve(r);
        }
        else if (r.Status === 'InProgress' && maxRetries > 0) return promiseTimeout(300)
          .then(waitTillSsmCommandIsComplete({
            params,
            maxRetries: maxRetries - 1,
            resolve,
            reject
          }));
        else if (maxRetries <= 0) reject('max retries');
        else reject('Command status was not in the expected state after max retries');
      })
      .catch(e => reject(e));
  };

  return new Promise((resolve, reject) =>
    _waitTillSsmCommandIsComplete({ params, maxRetries, resolve, reject })
  );
};

const waitTillSsmCommandsComplete = (instances, commandId) => Promise.all(
  instances.map(i => waitTillSsmCommandIsComplete({
    params: {
      CommandId: commandId,
      InstanceId: i
    }, maxRetries: MAX_SSM_WAIT_RETRIES
  }))
);

const runCommand = (ssmDocument, instances, callback) => {
  ssm.sendCommand({
    DocumentName: ssmDocument,
    InstanceIds: instances,
    TimeoutSeconds: 60
  }, (err, data) => {
    if (err) {
      return reportFailure(err, callback);
    }
    const commandId = data && data.Command && data.Command.CommandId;
    if (!commandId) {
      return reportFailure("could not retrieve commandId from sendCommand", callback);
    }

    waitTillSsmCommandsComplete(instances, commandId)
      .then(data => {
        data.forEach(i =>
          console.info(`InstanceId: ${i.InstanceId} Status: ${i.Status} ResponseCode: ${i.ResponseCode} StandardOutputContent: ${i.StandardOutputContent}`)
        );
        return callback();
      })
      .catch(e => reportFailure(e, callback));
  });
};
