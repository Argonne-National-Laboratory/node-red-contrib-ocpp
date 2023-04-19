'use strict';

const Websocket = require('ws');

const events = require('events');
const EventEmitter = events.EventEmitter;
const Logger = require('./utils/logdata');
const debug = require('debug')('anl:ocpp:cp:server:json');
const crypto = require('crypto');

const url = require('node:url');
const path = require('node:path');

let ee = new EventEmitter();
let NetStatus = 'OFFLINE';

const WSTOMIN_DEF = 5;
const WSTOMAX_DEF = 360;
const WSTOINC_DEF = 5;

const OCPPPROTOCOL = ['ocpp1.6'];

module.exports = function(RED) {
  function OCPPChargePointJNode(config) {
    RED.nodes.createNode(this, config);

    debug('Starting CP client JSON node');

    const CALL = 2;
    const CALLRESULT = 3;
    const CONTROL = 99;

    // for logging...
    const msgTypeStr = ['unknown', 'unknown', 'received', 'replied', 'error'];

    const msgType = 0;
    const msgId = 1;
    const msgAction = 2;
    const msgCallPayload = 3;
    const msgResPayload = 2;

    this.remotecs = RED.nodes.getNode(config.remotecs);

    this.csms_url = this.remotecs.url.endsWith('/') ? this.remotecs.url.slice(0, -1) : this.remotecs.url;
    this.cbId = config.cbId;
    this.ocppVer = this.ocppver;
    this.name = config.name || this.remotecs.name;
    this.command = config.command;
    this.cmddata = config.cmddata;
    this.logging = config.log || false;
    this.pathlog = config.pathlog;

    this.auto_connect = config.wsdelayconnect || false;
    this.wstomin = (isNaN(Number.parseInt(config.wstomin))) ? WSTOMIN_DEF : Number.parseInt(config.wstomin);
    let _wstomax = (isNaN(Number.parseInt(config.wstomax))) ? WSTOMAX_DEF : Number.parseInt(config.wstomax);
    this.wstomax = parseInt((_wstomax >= this.wstomin)? _wstomax : this.wstomin);
    this.wstoinc = (isNaN(Number.parseInt(config.wstoinc))) ? WSTOINC_DEF : Number.parseInt(config.wstoinc);
    // this.wstomin = 30;
    // this.wstomax = 360;
    // this.wstoinc = 5;

    const node = this;

    node.status({ fill: 'blue', shape: 'ring', text: 'OCPP CS 1.6' });

    node.reqKV = {};

    const logger = new Logger(this, this.pathlog, this.name);
    logger.enabled = (this.logging && (typeof this.pathlog === 'string') && this.pathlog !== '');

    let csmsURL;
    let ws;
    let wsreconncnt = 0;
    let wstocur = parseInt(node.wstomin);
    let conto;
    let wsnoreconn = false;

    // We attemt to verify that we have a valid CMSM URL
    // If not, we skip doing an autoconnect at startup
    // Otherwise, connecting will cause NR to crash
    //
    try {
      debug(`startup CSMS URL: ${node.csms_url}`);
      csmsURL = new URL(node.csms_url);
      csmsURL.pathname = path.join(csmsURL.pathname, node.cbId)
      
      debug(`CSMS URL: ${csmsURL.href}`);
      logger.log('info', `Making websocket connection to ${csmsURL.href}`);
      
    } catch(error) {
      node.status( { fill: 'red', shape: 'ring', text: error });
      debug(`URL error: ${error}`);
      // this.wsdelayconnect = true;
      // return;
    }


    // Add a ping timer handle
    let hPingTimer = null;

    const ws_options = {
      // WebSocket: Websocket, // custom WebSocket constructor
      connectionTimeout: 5000,
      handshaketimeout: 5000,
      // startClosed: this.wsdelayconnect,
      //maxRetries: 10,  //default to infinite retries
    };

    // Not sure that either one of these will get called since using the
    // websockets-reconnect
    let ws_ping = function(){
      debug('Got Ping');
      ws.pong();
    };
    let ws_pong = function(){
      debug('Got Pong');
    };

    let ws_open = function(){
      let msg = {};
      msg.ocpp = {};
      // msg.payload = {};
      node.status({fill: 'green', shape: 'dot', text: 'Connected...'});
      node.wsconnected = true;
      msg.ocpp.websocket = 'ONLINE';
      debug(`Websocket open to URL: ${csmsURL.href}`);
      if (NetStatus != msg.ocpp.websocket) {
        node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }
      // Add a ping intervale timer
      hPingTimer = setInterval(() => { ws.ping(); }, 3000);
    };
    
    let ws_close = function(code, reason){
      let msg = {};
      msg.ocpp = {};
      // msg.payload = {};
      logger.log('info', `Closing websocket connection to ${csmsURL.href}`);
      node.debug(code);
      debug(`Websocket closed code: ${code.code}`);
      debug(`Websocket closed reason: ${reason}`);
      debug(JSON.stringify(code));
      node.status({fill: 'red', shape: 'dot', text: 'Closed...'});
      node.wsconnected = false;
      msg.ocpp.websocket = 'OFFLINE';
      if (NetStatus != msg.ocpp.websocket) {
        node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }
      // Stop the ping timer
      if (hPingTimer != null){
        clearInterval(hPingTimer);
        hPingTimer = null;
      }

      ws.removeEventListener('open',ws_open);
      ws.removeEventListener('close',ws_open);
      ws.removeEventListener('error',ws_open);
      ws.removeEventListener('message',ws_open);
      ws.removeEventListener('ping',ws_ping);
      ws.removeEventListener('pong',ws_pong);

      if (!wsnoreconn){
        wsreconncnt += 1;
        node.status( { fill: 'red', shape: 'dot', text: `(${wsreconncnt}) Reconnecting` });
        conto = setTimeout( () => ws_connect(), wstocur * 1000);
        debug(`ws reconnect timeout: ${wstocur}`);
        wstocur += +node.wstoinc;
        wstocur = (wstocur >= node.wstomax) ? node.wstomax : wstocur;
      } else {
        node.status({ fill: 'red', shape: 'dot', text: 'Closed' });
      }
    };


    let ws_error = function(err){
      node.log('Websocket error:', {err});
      debug('Websocket error:', {err});
    };

    let ws_message = function(event){
      debug('Got a message ');
      let msgIn = event.data;
      let msg = {};
      msg.ocpp = {};
      msg.payload = {};

      msg.ocpp.ocppVersion = '1.6j';

      let response = [];
      let id = crypto.randomUUID();

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

        msg.ocpp.websocket = (node.wsconnected)? 'ONLINE' : 'OFFLINE';

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

    };

    function ws_connect(){
      try {
        ws = new Websocket(csmsURL.href, OCPPPROTOCOL, ws_options);
        ws.timeout = 5000;
        debug(`${node.cbId} ws_connect()`);
        ws.addEventListener('open',ws_open);
        ws.addEventListener('close',ws_close);
        ws.addEventListener('error',ws_error);
        ws.addEventListener('message',ws_message);
        ws.addEventListener('ping',ws_ping);
        ws.addEventListener('pong',ws_pong);
      }catch(error){
        debug(`Websocket Error: ${error}`);
        return;
      }
    };

    function ws_reconnect(){
      debug('Clearing Timeout');
      clearTimeout(conto);
      try {
        if (ws){
          ws.removeEventListener('open',ws_open);
          ws.removeEventListener('close',ws_close);
          ws.removeEventListener('error',ws_error);
          ws.removeEventListener('message',ws_message);
          ws.removeEventListener('ping',ws_ping);
          ws.removeEventListener('pong',ws_pong);
          ws.close();
        }
        clearTimeout(conto);
        ws_connect();
      }catch(error){
        debug(`Websocket Error: ${error}`);
        return;
      }
    };

    // Only do this if auto-connect is enabled
    //
    if (node.auto_connect && csmsURL){
      node.status({fill: 'blue', shape: 'dot', text: `Connecting...`});
      ws_connect();
    }


    ////////////////////////////////////////////
    // This section is for input from a the   //
    // Node itself                            //
    ////////////////////////////////////////////

    this.on('input', function(msg) {

      let request = [];
      let messageTypeStr = ['unknown', 'unknown', 'request', 'replied', 'error'];

      debug(JSON.stringify(msg));

      request[msgType] = msg.payload.msgType || CALL;
      request[msgId] = msg.payload.MessageId || crypto.randomUUID();

      if (request[msgType] == CONTROL){

        request[msgAction] = msg.payload.command || node.command;

        if (!request[msgAction]){
          const errStr = 'ERROR: Missing Control Command in JSON request message';
          node.error(errStr);
          debug(errStr);
          return;
        }

        switch (request[msgAction].toLowerCase()){
          case 'connect':
            if (msg.payload.data && msg.payload.data.hasOwnProperty('cbId')){
              this.cbId = msg.payload.data.cbId;
              debug(`Injected cbId: ${this.cbId}`);
            }
            if (msg.payload.data && msg.payload.data.hasOwnProperty('csmsUrl')){
              this.csms_url = msg.payload.data.csmsUrl.endsWith('/') ? msg.payload.data.csmsUrl.slice(0, -1) : msg.payload.data.csmsUrl;
              debug(`Injected csmsURL: ${this.csms_url}`);
            }
            try {
              if (! csmsURL){
                csmsURL = new URL(node.csms_url);
              }else{
                csmsURL.href = node.csms_url;
              }
              csmsURL.pathname = path.join(csmsURL.pathname, node.cbId);
              debug(`connecting to URL: ${csmsURL.href}`);
            }catch(error){
              node.status({ fill: 'red', shape: 'ring', text: error });
              debug(`URL error: ${error}`);
              return;
            }
            wsnoreconn = false;
            ws_reconnect();
            break;
          case 'close':
            wsnoreconn = true;
            if (ws){
              clearTimeout(conto);
              ws.close();
              node.status( { fill: 'red', shape: 'dot', text: 'Closed' });
            }
            break;
          case 'ws_state':
            msg = {};
            msg.ocpp = {};
            msg.ocpp.websocket = (node.wsconnected)? 'ONLINE' : 'OFFLINE';
            if (csmsURL) msg.ocpp.csmsUrl = csmsURL.href;
            node.send(msg);
            break;
          default:
            break;
        }


        logger.log(messageTypeStr[request[msgType]], JSON.stringify(request).replace(/,/g, ', '));

      } else if (node.wsconnected == true){
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
      if (NetStatus != msg.ocpp.websocket) {
        node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }
      ws.close();
    });

  }
  // register our node
  RED.nodes.registerType('CP client JSON', OCPPChargePointJNode);
};
