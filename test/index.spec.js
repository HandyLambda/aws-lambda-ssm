//Declare the variable within the suite's scope
const chai = require("chai");
const sinon = require("sinon");
const sinonChai = require("sinon-chai");
const expect = chai.expect;
const proxyquire = require('proxyquire');
chai.use(sinonChai);

const mock_lambda_req = {};
let ssmLambda;

describe('lambda-ssm', () => {
  beforeEach(() => {
    process.env.SSM_DOCUMENT = 'say-hello-to-everyone';
    process.env.INSTANCE_IDS = 'i-111,i-222';
  });
  beforeEach(() => {
    const ssmStub = {
      "sendCommand": (args, cb) => {
        cb(undefined, { Command: { CommandId: 'commandid1' } })
      },
      "getCommandInvocation": (args, cb) => {
        cb(undefined, {Status: "Success", ResponseCode: 0, StandardOutputContent: 'Cmd Successful'})
      }
    };
    ssmLambda = proxyquire("./../index.js", {
      "aws-sdk": { "SSM": sinon.stub().returns(ssmStub) }
    });

    console.info = sinon.spy();
  });

  it('should complete successfully when all ssm commands return complete', done =>
    ssmLambda.handler(mock_lambda_req, {}, () => {
      expect(console.info).to.have.been.calledWith('InstanceId: i-111 Status: Success ResponseCode: 0 StandardOutputContent: Cmd Successful');
      expect(console.info).to.have.been.calledWith('InstanceId: i-222 Status: Success ResponseCode: 0 StandardOutputContent: Cmd Successful');
      done();
    })
  );
});
