'use strict';

var path = require('path');
var soap = require('soap');
//const { v4: uuidv4 } = require('uuid');
//
//Use node built-in crypto for uuid
const crypto = require('crypto');

const Logger = require('./utils/logdata');


const debug = require('debug')('anl:ocpp:req');


module.exports = function(RED) {
  function OcppRequestNode(config) {
    RED.nodes.createNode(this, config);

    var node = this;

    this.remotecb = RED.nodes.getNode(config.remotecb);

    this.url = this.remotecb.url;
    this.cbId = this.remotecb.cbId;
    this.ocppVer = this.remotecb.ocppver;
    this.name = config.name || this.remotecb.name;
    this.command = config.command;
    this.cmddata = config.cmddata;
    this.logging = config.log;
    this.pathlog = config.pathlog;

    node.status({fill: 'blue', shape: 'dot', text: `waiting to send: ${node.cbId}`});

    const logger = new Logger(this, this.pathlog, this.name);
    logger.enabled = (this.logging && (typeof this.pathlog === 'string') && this.pathlog !== '');

    this.on('input', function(msg) {

      // set up soap requests for SOAP 1.2 headers
      var wsdlOptions = {
        forceSoap12Headers: true,
      };

      // create the client
      let wsdlFile = (node.ocppVer == '1.5s') ? 'ocpp_chargepointservice_1.5_final.wsdl' : 'OCPP_ChargePointService_1.6.wsdl';
      soap.createClient(path.join(__dirname, wsdlFile), wsdlOptions, function(err, client){
        if (err) node.error(err);
        else {

          var cbId = node.cbId;

          msg.ocpp = {};
          msg.ocpp.command = msg.payload.command || node.command;
          msg.ocpp.MessageId = msg.payload.MessageId || crypto.randomUUID();
          msg.ocpp.chargeBoxIdentity = cbId;
          msg.ocpp.url = node.url;
          msg.ocpp.ocppVer = node.ocppVer;
          let cmddata;
          if (node.cmddata){
            cmddata = JSON.parse(node.cmddata);
          }
          msg.ocpp.data = msg.payload.data || cmddata;

          if (!msg.ocpp.command){
            let errmsg = 'Missing Command in SOAP request message';
            node.error(errmsg);
            debug(errmsg);
            return;
          } else if (!msg.ocpp.data){
            let errmsg = 'Missing Data in SOAP request message';
            node.error(errmsg);
            debug(errmsg);
            return;
          }

          // set up or target charge point
          client.setEndpoint(msg.ocpp.url);

          // add headers that are specific to OCPP specification
          let addressing = 'http://www.w3.org/2005/08/addressing';

          client.addSoapHeader({'tns:chargeBoxIdentity': msg.ocpp.chargeBoxIdentity});

          client.addSoapHeader({To: msg.ocpp.url}, null, null, addressing);

          // if (node.ocppVer != "1.5s"){
          let act = `<Action xmlns="${addressing}" soap:mustUnderstand="true">/${msg.ocpp.command}</Action>`;
          client.addSoapHeader(act);
          // }
          let repto = `<ReplyTo xmlns="${addressing}"><Address>http://www.w3.org/2005/08/addressing/anonymous</Address></ReplyTo>`;
          client.addSoapHeader(repto);
          let msgid = `<MessageID xmlns="${addressing}">${msg.ocpp.MessageId}</MessageID>`;
          client.addSoapHeader(msgid);

          if (msg.ocpp && msg.ocpp.command){
            node.status({fill: 'green', shape: 'dot', text: `request out: ${msg.ocpp.command}`});
            debug(`request out: ${msg.ocpp.command}`);
          } else {
            node.status({fill: 'red', shape: 'dot', text: 'MISSING COMMAND'});
            debug('MISSING COMMAND');
          }
          if (node.pathlog == '') node.logging = false;
          if (node.logging){
            client.on('request', function(xmlSoap, xchgId){
              logger.log('request', xmlSoap);
            });

            client.on('response', function(xmlSoap, fullinfo, xchgId){
              logger.log('replied', xmlSoap);
            });

            client.on('soapError', function(err, xchgId){
              debug(`got SOAP error: ${err.message}`);
              //logData('error', err);
            });

          }
          // client.addSoapHeader({Action: '/' + msg.ocpp.command||node.command }, null, null, 'http://www.w3.org/2005/08/addressing');

          // send the specific OCPP message

          client[msg.ocpp.command](msg.ocpp.data, function(err, response){
            if (err) {
              // report any errors
              node.error(err);
              msg.payload = err;
              node.send(msg);
            } else {
              // put the response to the request in the message payload and send it out the flow
              msg.payload.data = response;
              node.status({fill: 'green', shape: 'dot', text: `response in: ${msg.ocpp.command}`});
              debug(`response in: ${msg.ocpp.command}`);
              node.send(msg);
            }
          });

        }
      });

    });

  }
  // register our node
  RED.nodes.registerType('CS request SOAP', OcppRequestNode);
};
