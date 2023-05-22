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
    const MSGTYPESTR = ['unknown', 'unknown', 'received', 'replied', 'error'];

    const MSGTYPE = 0;
    const MSGID = 1;
    const MSGACTION = 2;
    const MSGCALLPAYLOAD = 3;
    const MSGRESPAYLOAD = 2;

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

    const node = this;

    node.status({ fill: 'blue', shape: 'ring', text: 'OCPP CS 1.6' });

    node.req_map = new Map();

    const logger = new Logger(this, this.pathlog, this.name);
    logger.enabled = (this.logging && (typeof this.pathlog === 'string') && this.pathlog !== '');

    let csmsURL;
    let ws;
    let wsreconncnt = 0;
    let wstocur = parseInt(node.wstomin);
    let conto;
    let wsnoreconn = false;

    function reconn_debug() {
      debug(`wstomin: ${node.wstomin}`);
      debug(`wstomax: ${node.wstomax}`);
      debug(`wstoinc: ${node.wstoinc}`);
      debug(`wstocur: ${wstocur}`);
      debug(`wsreconncnt: ${wsreconncnt}`);
    }; 

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

    const wsOptions = {
      // WebSocket: Websocket, // custom WebSocket constructor
      connectionTimeout: 5000,
      handshaketimeout: 5000,
      // startClosed: this.wsdelayconnect,
      //maxRetries: 10,  //default to infinite retries
    };

    // Not sure that either one of these will get called since using the
    // websockets-reconnect
    const wsPing = function(){
      debug('Got Ping');
      ws.pong();
    };
    const wsPong = function(){
      debug('Got Pong');
    };

    const wsOpen = function(){
      let msg = {};
      msg.ocpp = {};
      // msg.payload = {};
      wsreconncnt = 0;
      wstocur = parseInt(node.wstomin);
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
    
    const wsClose = function(code, reason){
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

      ws.removeEventListener('open',wsOpen);
      ws.removeEventListener('close',wsClose);
      ws.removeEventListener('error',wsError);
      ws.removeEventListener('message',wsMessage);
      ws.removeEventListener('ping',wsPing);
      ws.removeEventListener('pong',wsPong);

      if (!wsnoreconn){
        wsreconncnt += 1;
        node.status( { fill: 'red', shape: 'dot', text: `(${wsreconncnt}) Reconnecting` });
        conto = setTimeout( () => wsConnect(), wstocur * 1000);
        debug(`ws reconnect timeout: ${wstocur}`);
        wstocur += +node.wstoinc;
        wstocur = (wstocur >= node.wstomax) ? node.wstomax : wstocur;
      } else {
        node.status({ fill: 'red', shape: 'dot', text: 'Closed' });
      }
    };


    const wsError = function(err){
      node.log('Websocket error:', {err});
      // debug('Websocket error:', {err});
    };

    const wsMessage = function(event){
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

      logger.log(MSGTYPESTR[msgParsed[MSGTYPE]], JSON.stringify(msgParsed));

      if (msgParsed[MSGTYPE] == CALL) {
        debug(`Got a CALL Message ${msgParsed[MSGID]}`);
        // msg.msgId = msgParsed[msgId];
        msg.msgId = id;
        msg.ocpp.MessageId = msgParsed[MSGID];
        msg.ocpp.msgType = CALL;
        msg.ocpp.command = msgParsed[MSGACTION];
        msg.payload.command = msgParsed[MSGACTION];
        msg.payload.data = msgParsed[MSGCALLPAYLOAD];

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
          response[MSGTYPE] = CALLRESULT;
          response[MSGID] = msgParsed[MSGID];
          response[MSGRESPAYLOAD] = returnMsg;

          logger.log(MSGTYPESTR[response[MSGTYPE]], JSON.stringify(response).replace(/,/g, ', '));

          ws.send(JSON.stringify(response));

        });
        node.status({fill: 'green', shape: 'dot', text: `message in: ${msg.ocpp.command}`});
        debug(`${ws.url} : message in: ${msg.ocpp.command}`);
        node.send(msg);
      } else if (msgParsed[MSGTYPE] == CALLRESULT) {
        debug(`Got a CALLRESULT msgId ${msgParsed[MSGID]}`);
        msg.msgId = msgParsed[MSGID];
        msg.ocpp.MessageId = msgParsed[MSGID];
        msg.ocpp.msgType = CALLRESULT;
        msg.payload.data = msgParsed[MSGRESPAYLOAD];

        msg.ocpp.websocket = (node.wsconnected)? 'ONLINE' : 'OFFLINE';

        if (node.req_map.has(msg.msgId)){
          msg.ocpp.command = node.req_map.get(msg.msgId);
          node.req_map.delete(msg.msgId);
        } else {
          msg.ocpp.command = 'unknown';
        }

        node.status({fill: 'green', shape: 'dot', text: `response in: ${msg.ocpp.command}`});
        debug(`response in: ${msg.ocpp.command}`);
        node.send(msg);

      }

    };

    const wsConnect = function() {
      reconn_debug();
      try {
        ws = new Websocket(csmsURL.href, OCPPPROTOCOL, wsOptions);
        ws.timeout = 5000;
        debug(`${node.cbId} wsConnect()`);
        ws.addEventListener('open',wsOpen);
        ws.addEventListener('close',wsClose);
        ws.addEventListener('error',wsError);
        ws.addEventListener('message',wsMessage);
        ws.addEventListener('ping',wsPing);
        ws.addEventListener('pong',wsPong);
      }catch(error){
        debug(`Websocket Error: ${error}`);
        return;
      }
    };

    const wsReconnect = function(){
      debug('Clearing Timeout');
      clearTimeout(conto);
      try {
        if (ws){
          ws.removeEventListener('open',wsOpen);
          ws.removeEventListener('close',wsClose);
          ws.removeEventListener('error',wsError);
          ws.removeEventListener('message',wsMessage);
          ws.removeEventListener('ping',wsPing);
          ws.removeEventListener('pong',wsPong);
          ws.close();
        }
        clearTimeout(conto);
        wsConnect();
      }catch(error){
        debug(`Websocket Error: ${error}`);
        return;
      }
    };

    // Only do this if auto-connect is enabled
    //
    if (node.auto_connect && csmsURL){
      node.status({fill: 'blue', shape: 'dot', text: `Connecting...`});
      wsConnect();
    }


    ////////////////////////////////////////////
    // This section is for input from a the   //
    // Node itself                            //
    ////////////////////////////////////////////

    this.on('input', function(msg) {

      let request = [];
      let messageTypeStr = ['unknown', 'unknown', 'request', 'replied', 'error'];

      debug(JSON.stringify(msg));

      request[MSGTYPE] = msg.payload.msgType || CALL;
      request[MSGID] = msg.payload.MessageId || crypto.randomUUID();

      if (request[MSGTYPE] == CONTROL) {

        request[MSGACTION] = msg.payload.command || node.command;

        if (!request[MSGACTION]){
          const errStr = 'ERROR: Missing Control Command in JSON request message';
          node.error(errStr);
          debug(errStr);
          return;
        }

        switch (request[MSGACTION].toLowerCase()){
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
            wsreconncnt = 0;
            wstocur = parseInt(node.wstomin);
            wsReconnect(); 
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


        logger.log(messageTypeStr[request[MSGTYPE]], JSON.stringify(request).replace(/,/g, ', '));

      } else if (node.wsconnected == true) {
        if (request[MSGTYPE] == CALL) {
          request[MSGACTION] = msg.payload.command || node.command;

          if (!request[MSGACTION]) {
            const errStr = 'ERROR: Missing Command in JSON request message';
            node.error(errStr);
            debug(errStr);
            return;
          }

          let cmddata;
          if (node.cmddata) {
            try {
              cmddata = JSON.parse(node.cmddata);
            } catch (e) {
              node.warn('OCPP JSON client node invalid payload.data for message (' + msg.ocpp.command + '): ' + e.message);
              return;
            }

          }

          request[MSGCALLPAYLOAD] = msg.payload.data || cmddata || {};
          if (!request[MSGCALLPAYLOAD]){
            const errStr = 'ERROR: Missing Data in JSON request message';
            node.error(errStr);
            debug(errStr);
            return;
          }

          node.req_map.set(request[MSGID], request[MSGACTION]);
          debug(`Sending message: ${request[MSGACTION]}, ${request}`);
          node.status({fill: 'green', shape: 'dot', text: `request out: ${request[MSGACTION]}`});

        } else { // This is a type 3 "response" message
          
          // Set the response message ID either users defined or original (preferred)
          if (msg.payload.MessageId) {
            request[MSGID] = msg.payload.MessageId;
          } else if (msg.ocpp && msg.ocpp.MessageId) {
            request[MSGID] = msg.ocpp.MessageId;
          };

          request[MSGRESPAYLOAD] = msg.payload.data || {};
          debug(`Sending response message: ${JSON.stringify(request[MSGRESPAYLOAD])}`);
          node.status({fill: 'green', shape: 'dot', text: 'sending response'});
        }

        logger.log(messageTypeStr[request[MSGTYPE]], JSON.stringify(request).replace(/,/g, ', '));

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
