'use strict';

const Websocket = require('ws');
let ReconnectingWebSocket = require('reconnecting-websocket');

const { v4: uuidv4 } = require('uuid');
const events = require('events');
const EventEmitter = events.EventEmitter;
const Logger = require('./utils/logdata');
const debug = require('debug')('anl:ocpp:cp:server:json');

let ee = new EventEmitter();
let NetStatus = 'OFFLINE';

module.exports = function(RED) {
  function OCPPChargePointJNode(config) {
    RED.nodes.createNode(this, config);

    debug('Starting CP client JSON node');

    const CALL = 2;
    const CALLRESULT = 3;

    // for logging...
    const msgTypeStr = ['unknown', 'unknown', 'received', 'replied', 'error'];

    const msgType = 0;
    const msgId = 1;
    const msgAction = 2;
    const msgCallPayload = 3;
    const msgResPayload = 2;

    var node = this;

    node.reqKV = {};

    this.remotecs = RED.nodes.getNode(config.remotecs);

    this.url = this.remotecs.url;
    this.cbId = config.cbId;
    this.ocppVer = this.ocppver;
    this.name = config.name || this.remotecs.name;
    this.command = config.command;
    this.cmddata = config.cmddata;
    this.logging = config.log || false;
    this.pathlog = config.pathlog;


    const logger = new Logger(this, this.pathlog, this.name);
    logger.enabled = (this.logging && (typeof this.pathlog === 'string') && this.pathlog !== '');

    let csUrl = `${this.remotecs.url}/${this.cbId}`;

    logger.log('info', `Making websocket connection to ${csUrl}`);

    // Add a ping timer handle
    let hPingTimer = null;

    const options = {
      WebSocket: Websocket, // custom WebSocket constructor
      connectionTimeout: 1000,
      handshaketimeout: 5000,
      //maxRetries: 10,  //default to infinite retries
  };

  let ws = new ReconnectingWebSocket(csUrl, ['ocpp1.6'], options);  

    ws.addEventListener('open', function(){
      let msg = {};      
      msg.ocpp = {};
      msg.payload = {};
      node.status({fill: 'green', shape: 'dot', text: 'Connected...'});
      node.wsconnected = true;      
      msg.ocpp.websocket = 'ONLINE';      
      if (NetStatus != msg.ocpp.websocket)  {
        node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }    
      // Add a ping intervale timer
      // Need to call websocket property of websockets-reconnect ( stored as _ws )
      hPingTimer = setInterval( () => { ws._ws.ping(); },30000);
    });

    ws.addEventListener('close', function(code,reason){
      let msg = {};      
      msg.ocpp = {};
      msg.payload = {};
      logger.log('info', `Closing websocket connection to ${csUrl}`);
      node.debug(code);
      debug('Websocket closed: code ',{code});
      node.status({fill: 'red', shape: 'dot', text: 'Closed...'});
      node.wsconnected = false;
      msg.ocpp.websocket = 'OFFLINE';
      if (NetStatus != msg.ocpp.websocket)  {
        node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }       
      // Stop the ping timer
      if (hPingTimer != null){
        clearInterval(hPingTimer);
        hPingTimer = null;
      }
            
    });

    ws.addEventListener('error', function(err){
      node.log('Websocket error:', {err});
      debug('Websocket error:', {err});
    });

    ws.addEventListener('message', function(event) {
      debug('Got a message ');
      let msgIn = event.data;   
      let msg = {};
      msg.ocpp = {};
      msg.payload = {};
      
      msg.ocpp.ocppVersion = '1.6j';

      let response = [];
      let id = uuidv4();

      let msgParsed;


      if (msgIn[0] != '[') {
        msgParsed = JSON.parse('[' + msgIn + ']');
      } else {
        msgParsed = JSON.parse(msgIn);
      }

      logger.log(msgTypeStr[msgParsed[msgType]], JSON.stringify(msgParsed));

      if (msgParsed[msgType] == CALL) {
        debug(`Got a CALL Message ${msgParsed[msgId]}`);
        // msg.msgId = msgParsed[msgId];
        msg.msgId = id;
        msg.ocpp.MessageId = msgParsed[msgId];
        msg.ocpp.msgType = CALL;
        msg.ocpp.command = msgParsed[msgAction];
        msg.payload.command = msgParsed[msgAction];
        msg.payload.data = msgParsed[msgCallPayload];

        let to = setTimeout(function(id) {
          // node.log("kill:" + id);
          if (ee.listenerCount(id) > 0) {
            let evList = ee.listeners(id);
            let x = evList[0];
            ee.removeListener(id, x);
          }
        }, 120 * 1000, id);

        // This makes the response async so that we pass the responsibility onto the response node
        ee.once(id, function(returnMsg) {
          clearTimeout(to);
          response[msgType] = CALLRESULT;
          response[msgId] = msgParsed[msgId];
          response[msgResPayload] = returnMsg;

          logger.log(msgTypeStr[response[msgType]], JSON.stringify(response).replace(/,/g, ', '));

          ws.send(JSON.stringify(response));

        });
        node.status({fill: 'green', shape: 'dot', text: `message in: ${msg.ocpp.command}`});
        debug(`${ws.url} : message in: ${msg.ocpp.command}`);
        node.send(msg);
      } else if (msgParsed[msgType] == CALLRESULT) {
        debug(`Got a CALLRESULT msgId ${msgParsed[msgId]}`);
        msg.msgId = msgParsed[msgId];
        msg.ocpp.MessageId = msgParsed[msgId];
        msg.ocpp.msgType = CALLRESULT;
        msg.payload.data = msgParsed[msgResPayload];

        if (node.wsconnected == true) {
          msg.ocpp.websocket = 'ONLINE'
        }
        else {
          msg.ocpp.websocket = 'OFFLINE'
        }

        if (node.reqKV.hasOwnProperty(msg.msgId)){
          msg.ocpp.command = node.reqKV[msg.msgId];
          delete node.reqKV[msg.msgId];
        } else {
          msg.ocpp.command = 'unknown';
        }

        node.status({fill: 'green', shape: 'dot', text: `response in: ${msg.ocpp.command}`});
        debug(`response in: ${msg.ocpp.command}`);
        node.send(msg);

      }

    });

    // Not sure that either one of these will get called since using the 
    // websockets-reconnect
    ws.addEventListener('ping', function(){
      debug('Got Ping');
      // Need to call websocket property of websockets-reconnect ( stored as _ws )
      ws._ws.pong();
    });
    ws.addEventListener('pong', function(){
      debug('Got Pong');
    });  

    this.on('input', function(msg) {

      if (node.wsconnected == true){

        let request = [];
        let messageTypeStr = ['unknown', 'unknown', 'request', 'replied', 'error'];

        debug(JSON.stringify(msg));

        request[msgType] = msg.payload.msgType || CALL;
        request[msgId] = msg.payload.MessageId || uuidv4();

        if (request[msgType] == CALL){
          request[msgAction] = msg.payload.command || node.command;

          if (!request[msgAction]){
            const errStr = 'ERROR: Missing Command in JSON request message';
            node.error(errStr);
            debug(errStr);
            return;
          }

          let cmddata;
          if (node.cmddata){
            try {
              cmddata = JSON.parse(node.cmddata);
            } catch (e){
              node.warn('OCPP JSON client node invalid payload.data for message (' + msg.ocpp.command + '): ' + e.message);
              return;
            }

          }

          request[msgCallPayload] = msg.payload.data || cmddata || {};
          if (!request[msgCallPayload]){
            const errStr = 'ERROR: Missing Data in JSON request message';
            node.error(errStr);
            debug(errStr);
            return;
          }

          node.reqKV[request[msgId]] = request[msgAction];
          debug(`Sending message: ${request[msgAction]}, ${request}`);
          node.status({fill: 'green', shape: 'dot', text: `request out: ${request[msgAction]}`});
        } else {
          request[msgResPayload] = msg.payload.data || {};
          debug(`Sending response message: ${JSON.stringify(request[msgResPayload])}`);
          node.status({fill: 'green', shape: 'dot', text: 'sending response'});
        }
        
        logger.log(messageTypeStr[request[msgType]], JSON.stringify(request).replace(/,/g, ', '));

        ws.send(JSON.stringify(request));
      }
    });

    this.on('close', function(){
      let msg = {};      
      msg.ocpp = {};
      msg.payload = {};
      node.status({fill: 'red', shape: 'dot', text: 'Closed...'});
      logger.log('info', 'Websocket closed');
      debug('Closing CP client JSON node..');      
      node.wsconnected = false;      
      msg.ocpp.websocket = 'OFFLINE';
      if (NetStatus != msg.ocpp.websocket)  {
        node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }     
      ws.close();
    });

  }
  // register our node
  RED.nodes.registerType('CP client JSON', OCPPChargePointJNode);
};
