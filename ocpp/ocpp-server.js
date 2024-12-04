"use strict";

const express = require("express");
const soap = require("soap");
const fs = require("fs");
const path = require("path");
const events = require("events");
//Use nodejs built-in crypto for uuid
const crypto = require("crypto");

const xmlconvert = require("xml-js");
const expressws = require("express-ws");

const Logger = require("./utils/logdata");
const debug_csserver = require("debug")("anl:ocpp:cs:server");
const debug_cpserver = require("debug")("anl:ocpp:cp:server:soap");
const debug_csresponse = require("debug")("anl:ocpp:cs:response");
const debug_csrequest = require("debug")("anl:ocpp:cs:request:json");

const EventEmitter = events.EventEmitter;
const REQEVTPOSTFIX = "::REQUEST";
const CBIDCONPOSTFIX = "::CONNECTED";

let ee;

ee = new EventEmitter();
const cb_map = new Map();

// override the soap envelope to add an additional header to support soap 1.2
// NOTE: If the npm soap module used by this evolves to support 1.2 on the
// server side, this code could be removed
//

soap.Server.prototype.__envelope = soap.Server.prototype._envelope;

soap.Server.prototype._envelope = function (body, includeTimestamp) {
  // var xml = ""

  let xml = this.__envelope(body, includeTimestamp);
  xml = xml.replace(
    ' xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"',
    "",
  );
  //xml = xml.replace(' xmlns:tns="urn://Ocpp/Cs/2012/06/"','');
  return xml.replace(
    "http://schemas.xmlsoap.org/soap/envelope/",
    "http://www.w3.org/2003/05/soap-envelope",
  );
};
// end envelope header modifications

let valid_evses = new Map();

valid_evses.set("evsesim1", "evsesim1");
valid_evses.set("evse-002", "EVSE-002");

function cmd_set_valid_evses(evse) {}

// Node-Red stuff
///////////////////////////////////

module.exports = function (RED) {
  // Create a server node for monitoring incoming soap messages
  function OCPPServerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.status({ fill: "blue", shape: "ring", text: "Waiting..." });

    // ee = new EventEmitter();

    ee.on("error", (err) => {
      node.error("EMITTER ERROR: " + err);
      debug_csserver(`Event Emitter Error: ${err}`);
    });

    // make local copies of our configuration
    this.portType = config.portType;
    this.svcPort = RED.util.evaluateNodeProperty(
      config.port,
      config.portType,
      node,
    );
    this.svcPath15 = config.path15;
    this.svcPath16 = config.path16;
    this.svcPath16j = config.path16j;
    this.enabled15 = config.enabled15;
    this.enabled16 = config.enabled16;
    this.enabled16j = config.enabled16j;
    this.logging = config.log || false;
    this.pathlog = config.pathlog;
    this.name = config.name || "OCPP Server Port " + this.svcPort;

    debug_csserver(
      `Starting CS Server Node. Listening on port ${this.svcPort}`,
    );

    if (!this.enabled16 && !this.enabled15 && !this.enabled16j) {
      node.status({ fill: "red", shape: "dot", text: "Disabled" });
    }

    // Setup the logger
    const logger = new Logger(this, this.pathlog, this.name);
    logger.enabled =
      this.logging && typeof this.pathlog === "string" && this.pathlog !== "";

    function logData(type, data) {
      logger.log(type, data);
    }

    function log_ocpp_msg(ocpp_msg, cbId, msgFrom) {
      let msg = {
        timestamp: Date.now(),
        cbId,
        msgFrom,
        payload: ocpp_msg,
      };
      node.send([null, msg]);
    }
    ////////////////////////////////////
    function ocppAthenticate(req) {
      const cbId = req.params.cbid || "";

      debug_csserver("CBID = " + cbId);

      if (valid_evses.has(cbId)) {
        return true;
      }

      return false;
    }

    // read in the soap definition
    let wsdl15 = fs.readFileSync(
      path.join(__dirname, "ocpp_centralsystemservice_1.5_final.wsdl"),
      "utf8",
    );
    let wsdl16 = fs.readFileSync(
      path.join(__dirname, "OCPP_CentralSystemService_1.6.wsdl"),
      "utf8",
    );

    // define the default ocpp soap function for the server
    let ocppFunc = function (ocppVer, command, args, cb, headers) {
      // create a unique id for each message to identify responses
      let id = crypto.randomUUID();

      // Set a timout for each event response so they do not pile up if not responded to
      let to = setTimeout(
        function (id) {
          // node.log("kill:" + id);
          if (ee.listenerCount(id) > 0) {
            let evList = ee.listeners(id);
            ee.removeListener(id, evList[0]);
            debug_csserver(`Removing stale event ${id}`);
          }
        },
        120 * 1000,
        id,
      );

      // This makes the response async so that we pass the responsibility onto the response node
      ee.once(id, function (returnMsg) {
        debug_csserver("Clearing Timeout...");
        clearTimeout(to);
        cb(returnMsg);
      });

      let cbi =
        headers.chargeBoxIdentity.$value ||
        headers.chargeBoxIdentity ||
        "Unknown";

      // let action = headers.Action.$value||headers.Action
      let action = command;

      node.status({ fill: "green", shape: "ring", text: cbi + ": " + action });
      // Send the message out to the rest of the flow
      sendMsg(ocppVer, command, id, args, headers);
    };

    let wsdljs;
    let wsdlservice;
    let wsdlport;
    let wsdlops;
    let ocppService15 = {};
    let ocppService16 = {};

    // define our services and the functions they call.
    // Future: should be able to define this by parsing the soap xml file read in above.

    wsdljs = xmlconvert.xml2js(wsdl15, { compact: true, spaces: 4 });
    wsdlservice = wsdljs["wsdl:definitions"]["wsdl:service"]._attributes.name;
    wsdlport =
      wsdljs["wsdl:definitions"]["wsdl:service"]["wsdl:port"]._attributes.name;
    ocppService15 = {};
    ocppService15[wsdlservice] = {};
    ocppService15[wsdlservice][wsdlport] = {};

    wsdlops = wsdljs["wsdl:definitions"]["wsdl:portType"]["wsdl:operation"];

    wsdlops.forEach(function (op) {
      ocppService15[wsdlservice][wsdlport][op._attributes.name] = function (
        args,
        cb,
        headers,
      ) {
        ocppFunc("1.5", op._attributes.name, args, cb, headers);
      };
    }, this);

    wsdljs = xmlconvert.xml2js(wsdl16, { compact: true, spaces: 4 });
    wsdlservice = wsdljs["wsdl:definitions"]["wsdl:service"]._attributes.name;
    wsdlport =
      wsdljs["wsdl:definitions"]["wsdl:service"]["wsdl:port"]._attributes.name;
    ocppService16 = {};
    ocppService16[wsdlservice] = {};
    ocppService16[wsdlservice][wsdlport] = {};

    wsdlops = wsdljs["wsdl:definitions"]["wsdl:portType"]["wsdl:operation"];

    wsdlops.forEach(function (op) {
      ocppService16[wsdlservice][wsdlport][op._attributes.name] = function (
        args,
        cb,
        headers,
      ) {
        ocppFunc("1.6", op._attributes.name, args, cb, headers);
      };
    }, this);

    const expressServer = express();

    // This checks that the subprotocol header for websockets is set to 'ocpp1.6'
    const wsOptions = {
      handleProtocols: function (protocols, request) {
        const requiredSubProto = "ocpp1.6";
        debug_csserver(`SubProtocols: [${protocols}]`);
        return protocols.includes(requiredSubProto) ? requiredSubProto : false;
      },
      clientTracking: true,
    };

    const expressWs = expressws(expressServer, null, { wsOptions });
    //const expressWs = expressws(expressServer);

    let wss = expressWs.getWss();
    // x.clients.forEach((ws) => {
    //     let eventName = ws.upgradeReq.params.cbid + REQEVTPOSTFIX;
    //     if (ee.eventNames().indexOf(eventName) != -1){
    //         console.log( `Event ${eventName} already exists`);
    //     }else {
    //         console.log( `Need to add event ${eventName}`);
    //     }
    // });
    let wsrequest;

    wss.on("connection", function connection(ws, req) {
      if (!ocppAthenticate(req)) {
        ws.terminate();
        return;
      }
      if (req.params) {
        debug_csserver(`Got a connection from ${req.params.cbid}...`);
        const cbid = req.params.cbid;
        let connname = cbid + CBIDCONPOSTFIX;
        const previous_connection = cb_map.get(cbid);
        if (previous_connection !== undefined) {
          debug_csserver(
            `There's an existing connection with ${req.params.cbid}, terminating the old one...`,
          );
          // We can only handle one connection at a time. Terminate the previous one.
          previous_connection.close(1002);
        }
        cb_map.set(cbid, ws);

        node.status({
          fill: "green",
          shape: "dot",
          text: `Connection from ${cbid}`,
        });

        // Announce connection

        ee.emit(connname, "connected");

        // Remove cbid from map when it closes and emit a message
        ws.on("close", function () {
          if (cb_map.get(cbid) === this) {
            cb_map.delete(cbid);
          }
          node.status({
            fill: "gray",
            shape: "dot",
            text: `Disconnected from ${cbid}`,
          });
          ee.emit(connname, "disconnected");
          debug_csserver(`Lost connection to ${cbid}`);
        });

        ws.on("message", function (msgIn) {
          debug_csserver(msgIn);
        });
      }
    });

    let soapServer15, soapServer16;

    // Insert middleware into the flow...
    // WHY: Because:
    //      * node-soap repeats back the incoming "Content-Type"
    //      * some OCPP implementors add an un-necessary ACTION= to the http header content-type
    //      * Only action = /<action>Resonse seems to be valid to those same vendors.
    //      * most vendors don't care about the returned content-type of action since it is depreciated
    //        for Soap 1.2
    //
    //  The following express.use middleware will intercept the http headers and remove the additional
    //  action="/<action>" from the content-type if it sees it. This had to be done with express since
    //  node-soap removes all 'request' listeners from the server, therefore making it hard to intercept
    //  the http headers via a listener. But express inserts the middleware long before node-soap gets
    //  the message.
    //
    expressServer.use(function (req, res, next) {
      if (
        req.method == "POST" &&
        typeof req.headers["content-type"] !== "undefined"
      ) {
        if (req.headers["content-type"].toLowerCase().includes("action")) {
          let ctstr = req.headers["content-type"];
          let ctarr = ctstr.split(";");
          ctarr = ctarr.filter(function (ctitem) {
            return !ctitem.toLowerCase().includes("action");
          });
          req.headers["content-type"] = ctarr.join(";");
        }
      }
      next();
    });

    const server = expressServer.listen(this.svcPort, function () {
      if (node.pathlog == "") node.logging = false;
      if (node.enabled15) {
        soapServer15 = soap.listen(expressServer, {
          path: node.svcPath15,
          services: ocppService15,
          xml: wsdl15,
        });
        soapServer15.addSoapHeader(function (methodName, args, headers) {
          return addHeaders(methodName, args, headers, 1.5);
        });

        soapServer15.log = node.logging ? logData : null;
      }

      if (node.enabled16) {
        soapServer16 = soap.listen(expressServer, {
          path: node.svcPath16,
          services: ocppService16,
          xml: wsdl16,
        });
        soapServer16.addSoapHeader(function (methodName, args, headers) {
          return addHeaders(methodName, args, headers, 1.6);
        });

        soapServer16.log = node.logging ? logData : null;
      }

      if (node.enabled16j) {
        const wspath = `${node.svcPath16j}/:cbid`;
        logger.log("info", `Ready to recieve websocket requests on ${wspath}`);
        debug_csserver(`ws (json) path = ${wspath}`);

        expressServer.ws(wspath, function (ws, req, next) {
          debug_csserver(`Got A connection from: ${req.params.cbid}`);

          const CALL = 2;
          const CALLRESULT = 3;
          const CALLERROR = 4;
          const msgTypeStr = ["received", "replied", "error"];

          const msgType = 0;
          const msgId = 1;
          const msgAction = 2;
          const msgCallPayload = 3;
          const msgResPayload = 2;

          const reqMsgIdToCmd = new Map();

          let msg = {};
          let cbId = req.params.cbid;

          msg.ocpp = {};
          msg.payload = {};
          msg.payload.data = {};

          msg.ocpp.ocppVersion = "1.6j";
          msg.ocpp.chargeBoxIdentity = req.params.cbid;

          node.status({
            fill: "green",
            shape: "dot",
            text: `Connected on ${node.svcPath16j}/${req.params.cbid}`,
          });

          // emit to other nodes the connection has been established
          let connname = req.params.cbid + CBIDCONPOSTFIX;

          let eventname = req.params.cbid + REQEVTPOSTFIX;

          logger.log(
            "info",
            `Websocket connecting to chargebox: ${req.params.cbid}`,
          );
          wsrequest = (data, cb) => {
            let err;
            let request = [];

            request[msgType] = CALL;
            request[msgId] = data.msgId || crypto.randomUUID();
            request[msgAction] = data.ocpp.command;
            request[msgCallPayload] = data.ocpp.data || {};

            logger.log("request", JSON.stringify(request).replace(/,/g, ", "));

            ee.once(request[msgId], (retData) => {
              cb(err, retData);
            });

            debug_csserver(ee.eventNames());

            reqMsgIdToCmd.set(request[msgId], request[msgAction]);
            debug_csserver(`Sending message: ${request[msgAction]} to CS`);
            let ocpprequest = JSON.stringify(request);
            ws.send(JSON.stringify(request));
            log_ocpp_msg(request, cbid, "CS");
          };

          debug_csserver(`Setting up callback for ${eventname}`);
          ee.on(eventname, wsrequest);

          let callMsgIdToCmd = [];
          let localcbid = req.params.cbid;

          debug_csserver(`Websocket connection to : ${localcbid}`);

          msg = {
            ocpp: {
              websocket: "ONLINE",
              chargeBoxIdentity: localcbid,
            },
          };
          node.send(msg);

          ws.on("close", function ws_close(code, reason) {
            msg = {
              ocpp: {
                websocket: "OFFLINE",
                chargeBoxIdentity: localcbid,
                code: code,
                reason: reason,
              },
            };

            node.send(msg);
          });

          ws.on("message", function (msgIn) {
            let response = [];

            debug_csserver("Yes, I did get a message");

            let id = crypto.randomUUID();

            let msgParsed;

            // Ensure msgIn is treated as a sring not a buffer
            msgIn = "" + msgIn;

            msg.ocpp = {};
            msg.payload = {};

            const cbid = localcbid || "unknown";

            msg.ocpp.chargeBoxIdentity = cbid;

            let eventName = cbid + REQEVTPOSTFIX;
            if (ee.eventNames().indexOf(eventName) == -1) {
              debug_csserver(`Need to add event ${eventName}`);
              ee.on(eventname, wsrequest);
            }

            try {
              if (msgIn[0] != "[") {
                msgParsed = JSON.parse("[" + msgIn + "]");
              } else {
                msgParsed = JSON.parse(msgIn);
              }

              logger.log(msgTypeStr[msgParsed[msgType] - CALL], msgIn);

              msg.ocpp.MessageId = msgParsed[msgId];
              msg.ocpp.msgType = msgParsed[msgType];

              debug_csserver(`Message from: ${cbid} ${msgParsed[msgAction]}`);

              log_ocpp_msg(msgParsed, cbid, "CS");

              if (msgParsed[msgType] == CALL) {
                msg.msgId = id;
                msg.ocpp.command = msgParsed[msgAction];
                msg.payload.command = msgParsed[msgAction];
                msg.payload.data = msgParsed[msgCallPayload];

                let to = setTimeout(
                  function (id) {
                    // node.log("kill:" + id);
                    if (ee.listenerCount(id) > 0) {
                      let evList = ee.listeners(id);
                      ee.removeListener(id, evList[0]);
                      debug_csserver(`Removed stale message id: ${id}`);
                    }
                  },
                  60 * 1000,
                  id,
                );

                callMsgIdToCmd.unshift({
                  msgId: msg.ocpp.MessageId,
                  command: msg.ocpp.command,
                });

                while (callMsgIdToCmd.length > 25) {
                  callMsgIdToCmd.pop();
                }
                // debug_csserver({callMsgIdToCmd});

                // This makes the response async so that we pass the responsibility onto the response node
                ee.once(id, function (returnMsg) {
                  clearTimeout(to);
                  response[msgType] = CALLRESULT;
                  response[msgId] = msgParsed[msgId];
                  response[msgResPayload] = returnMsg;

                  logger.log(
                    msgTypeStr[response[msgType] - CALL],
                    JSON.stringify(response).replace(/,/g, ", "),
                  );
                  ws.send(JSON.stringify(response));
                  log_ocpp_msg(response, cbid, "CSMS");
                });

                node.status({
                  fill: "green",
                  shape: "dot",
                  text: `Request: ${msg.ocpp.command}`,
                });

                node.send(msg);
              } else if (msgParsed[msgType] == CALLRESULT) {
                msg.msgId = msgParsed[msgId];
                msg.payload.data = msgParsed[msgResPayload];

                debug_csserver(`msg.msgId => ${msg.msgId}`);
                // Lookup the command name via the returned message ID
                reqMsgIdToCmd.forEach(function (key, val) {
                  debug_csserver("key: " + key + "value: " + val);
                });
                if (reqMsgIdToCmd.has(msg.msgId)) {
                  msg.ocpp.command = reqMsgIdToCmd.get(msg.msgId);
                  reqMsgIdToCmd.delete(msg.msgId);
                } else {
                  msg.ocpp.command = "unknown";
                }
                node.status({
                  fill: "blue",
                  shape: "dot",
                  text: `Result: ${msg.ocpp.command}`,
                });

                ee.emit(msg.msgId, msg);
              } else if (msgParsed[msgType] == CALLERROR) {
                msg.payload.ErrorCode = msgParsed[2];
                msg.payload.ErrorDescription = msgParsed[3];
                msg.payload.ErrorDetails = msgParsed[4];

                // search the command array for the command associated with the message id

                let findMsgId = { msgId: msg.ocpp.MessageId };

                let cmdIdx = callMsgIdToCmd.findIndex(getCmdIdx, findMsgId);

                if (cmdIdx != -1) {
                  msg.payload.command = callMsgIdToCmd[cmdIdx].command;
                  msg.ocpp.command = msg.payload.command;
                  delete callMsgIdToCmd.splice(cmdIdx, 1);
                } else {
                  msg.payload.command = "unknown";
                  msg.ocpp.command = msg.payload.command;
                }

                node.status({
                  fill: "red",
                  shape: "dot",
                  text: `ERROR: ${msg.payload.command}`,
                });

                debug_csserver(`Got an ERROR: ${msg}`);

                node.send(msg);
              }

              function getCmdIdx(cmds) {
                return cmds.msgId === this.msgId;
              }
            } catch (err) {
              logger.log("ERROR", err.message);
            }
          });

          next();
        });
      }
    });

    this.on("close", function () {
      debug_csserver("About to stop the server...");
      ee.removeAllListeners();
      expressWs.getWss().clients.forEach(function (ws) {
        debug_csserver("ws closing..", ws.readyState);
        if (ws.readyState === 1) {
          ws.close(1012, "Restarting Server");
        }
      });
      debug_csserver("calling server.close()");
      server.close();
      this.status({ fill: "grey", shape: "dot", text: "stopped" });
      debug_csserver("Server closed?...");
    });

    // Creates the custom headers for our soap messages
    const addHeaders = (methodName, args, headers, ocppVer) => {
      const local_debug = false;

      if (local_debug === true) {
        debug_csserver("<!--- SOAP1.6 HEADERS --->");

        debug_csserver("<!--- methodName --->");
        debug_csserver(`< ${methodName} />`);

        debug_csserver("<!--- args ---");
        debug_csserver(args);
        debug_csserver("--->");

        debug_csserver("<!--- REQUEST HEADER ----");
        debug_csserver(headers);
        debug_csserver("--->");
      }

      let addressing = "http://www.w3.org/2005/08/addressing";
      let full_hdr;

      const mustUnderstand =
        ocppVer === 1.5 ? "" : ' soap:mustUnderstand="true"';

      if (headers.Action) {
        let action = headers.Action.$value || headers.Action;

        if (action) {
          full_hdr = `<Action xmlns="${addressing}"${mustUnderstand}>${action}Response</Action>`;
        }
      }
      if (headers.MessageID) {
        full_hdr =
          full_hdr +
          `<RelatesTo RelationshipType="http://www.w3.org/2005/08/addressing/reply" xmlns="http://www.w3.org/2005/08/addressing">${headers.MessageID}</RelatesTo>`;
      }
      full_hdr =
        full_hdr +
        `<To xmlns="${addressing}" >http://www.w3.org/2005/08/addressing/anonymous</To>`;

      if (headers.chargeBoxIdentity) {
        let cb = headers.chargeBoxIdentity.$value || headers.chargeBoxIdentity;
        // We are only adding teh mustUnderstand to 1.6 since some CP implementations do not support having that
        // attribute in the chargeBoxIdentity field.
        let cbid = `<tns:chargeBoxIdentity${mustUnderstand}>${cb}</tns:chargeBoxIdentity>`;
        full_hdr = full_hdr + cbid;
      }
      if (local_debug === true) {
        debug_csserver("<!--- REPLY HEADER --->");
        debug_csserver(full_hdr);
      }

      return full_hdr;
    };

    // Creates the message and payload for sending out into the flow and sends it.
    const sendMsg = function (ocppVer, command, msgId, args, headers) {
      // msg {
      //  msgId
      //  ocpp {
      //      MessageId
      //      ocppVersion
      //      chargeBoxIdentity
      //      command
      //      From
      //  }
      //  payload {
      //      command
      //      data { args }
      //  }
      // }

      // NOTE: the incoming command is repeated twice in the message,
      // once for the ocpp object, and again in the payload, for convienience

      let msg = {};
      msg.ocpp = {};
      msg.payload = {};
      msg.payload.data = {};
      msg.msgId = msgId;

      msg.ocpp.command = command;
      msg.payload.command = command;

      // idenitfy which chargebox the message originated from
      msg.ocpp.chargeBoxIdentity =
        headers.chargeBoxIdentity.$value ||
        headers.chargeBoxIdentity ||
        "Unknown";
      msg.ocpp.ocppVersion = ocppVer || "Unknown";

      if (headers.From) {
        if (headers.From.Address) {
          msg.ocpp.From = headers.From.Address;
        }
      }

      // We don't use the given soap MessageID to identify our message since it may
      // be missing or repeated across messages. It is used in the return soap message however
      msg.ocpp.MessageID = headers.MessageID || "Unknown";

      // repeat the command in the payload for convienience
      msg.payload.command = msg.ocpp.command;

      // this provide the body of the command with all the arguments
      if (args) {
        msg.payload.data = args;
      }

      node.send(msg);
    };

    // function logData(type, data) {
    //   if (node.logging === true){ // only log if no errors w/ log file
    //     // set a timestamp for the logged item
    //     let date = new Date().toLocaleString();
    //     let dataStr = '<no data>';
    //     if (typeof data === 'string'){
    //       dataStr = data.replace(/[\n\r]/g, '');
    //     }
    //     // create the logged info from a template
    //     // let logInfo = `${date} \t node: ${node.name} \t type: ${type} \t data: ${data} ${os.EOL}`;
    //     let logInfo = `${date} \t node: ${node.name} \t type: ${type} \t data: ${dataStr} ${os.EOL}`;

    //     // create/append the log info to the file
    //     fs.appendFile(node.pathlog, logInfo, (err) => {
    //       if (err){
    //         node.error(`Error writing to log file: ${err}`);
    //         // If something went wrong then turn off logging
    //         node.logging = false;
    //         if (node.log) node.log = null;
    //       }
    //     });
    //   }
    // }
  }

  // Create a "resonse" node for returning messages to soap
  function OCPPResponseNode(config) {
    RED.nodes.createNode(this, config);

    let node = this;
    debug_csresponse("Starting CS Response Node");

    node.status({ fill: "blue", shape: "ring", text: "Waiting..." });

    this.on("input", function (msg) {
      // var x = 0;
      if (msg.msgId) {
        // we simply return the payload of the message and emit a node message based on the unique
        // id we created when we recieved the soap event.
        // console.log("emit msg...");
        let command = msg.ocpp.command;

        debug_csresponse(`Sending msgId ${msg.msgId}: command: ${command}`);
        let x = ee.emit(msg.msgId, msg.payload);

        if (x) {
          node.status({
            fill: "green",
            shape: "ring",
            text: command + " sent",
          });
        } else {
          node.status({ fill: "red", shape: "ring", text: "message failed" });
        }
        // let eventname = msg.ocpp.chargeBoxIdentity + '_REQUEST';
        // console.log('sending event:', eventname);
        // var y = ee.emit(eventname, msg.ocpp.command, function(rtnData){
        //     console.log('got this back: ', rtnData);
        // });
        // if (y)
        //     console.log('got y back:', y);
        // else
        //     console.log('no y return');
      } else {
        node.log("ERROR: missing msgId for return target");
      }
    });

    this.on("close", function (removed, done) {
      if (!removed) {
        this.status({ fill: "grey", shape: "dot", text: "stopped" });
      }
      done();
    });
  }

  function OCPPChargePointServerNode(config) {
    debug_cpserver("Starting CP Server Node");

    RED.nodes.createNode(this, config);
    const node = this;

    node.status({ fill: "blue", shape: "ring", text: "Waiting..." });

    ee.on("error", (err) => {
      node.error(`EMITTER ERROR: ${err}`);
      debug_cpserver(`EMITTER ERROR: ${err}`);
    });

    // make local copies of our configuration
    //this.svcPort = config.port;
    this.svcPort = config.prot;
    this.svcPath15 = config.path15;
    this.svcPath16 = config.path16;
    this.enabled15 = config.enabled15;
    this.enabled16 = config.enabled16;
    this.logging = config.log || false;
    this.pathlog = config.pathlog;
    this.name = config.name || "OCPP CP Server Port " + this.svcPort;

    if (!this.enabled16 && !this.enabled15) {
      node.status({ fill: "red", shape: "dot", text: "Disabled" });
    }

    const logger = new Logger(this, this.pathlog, this.name);
    logger.enabled =
      this.logging && typeof this.pathlog === "string" && this.pathlog !== "";

    function logData(type, data) {
      logger.log(type, data);
    }

    // read in the soap definition
    let wsdl15 = fs.readFileSync(
      path.join(__dirname, "ocpp_chargepointservice_1.5_final.wsdl"),
      "utf8",
    );
    let wsdl16 = fs.readFileSync(
      path.join(__dirname, "OCPP_ChargePointService_1.6.wsdl"),
      "utf8",
    );

    // define the default ocpp soap function for the server
    let ocppFunc = function (ocppVer, command, args, cb, headers) {
      // create a unique id for each message to identify responses
      let id = crypto.randomUUID();

      // Set a timout for each event response so they do not pile up if not responded to
      let to = setTimeout(
        function (id) {
          // node.log("kill:" + id);
          if (ee.listenerCount(id) > 0) {
            let evList = ee.listeners(id);
            ee.removeListener(id, evList[0]);
          }
        },
        120 * 1000,
        id,
      );

      // This makes the response async so that we pass the responsibility onto the response node
      ee.once(id, function (returnMsg) {
        clearTimeout(to);
        cb(returnMsg);
      });

      // Add custom headers to the soap package

      let soapSvr = ocppVer == "1.5" ? soapServer15 : soapServer16;

      addHeaders(headers, soapSvr);

      let cbi =
        headers.chargeBoxIdentity.$value ||
        headers.chargeBoxIdentity ||
        "Unknown";
      let action = command;

      node.status({ fill: "green", shape: "ring", text: cbi + ": " + action });
      // Send the message out to the rest of the flow
      sendMsg(ocppVer, command, id, args, headers);
    };

    let wsdljs;
    let wsdlservice;
    let wsdlport;
    let wsdlops;
    let ocppService15 = {};
    let ocppService16 = {};

    // define our services and the functions they call.
    // Future: should be able to define this by parsing the soap xml file read in above.

    wsdljs = xmlconvert.xml2js(wsdl15, { compact: true, spaces: 4 });
    wsdlservice = wsdljs["wsdl:definitions"]["wsdl:service"]._attributes.name;
    wsdlport =
      wsdljs["wsdl:definitions"]["wsdl:service"]["wsdl:port"]._attributes.name;
    ocppService15 = {};
    ocppService15[wsdlservice] = {};
    ocppService15[wsdlservice][wsdlport] = {};

    wsdlops = wsdljs["wsdl:definitions"]["wsdl:portType"]["wsdl:operation"];

    wsdlops.forEach(function (op) {
      ocppService15[wsdlservice][wsdlport][op._attributes.name] = function (
        args,
        cb,
        headers,
      ) {
        ocppFunc("1.5", op._attributes.name, args, cb, headers);
      };
    }, this);

    wsdljs = xmlconvert.xml2js(wsdl16, { compact: true, spaces: 4 });
    wsdlservice = wsdljs["wsdl:definitions"]["wsdl:service"]._attributes.name;
    wsdlport =
      wsdljs["wsdl:definitions"]["wsdl:service"]["wsdl:port"]._attributes.name;
    ocppService16 = {};
    ocppService16[wsdlservice] = {};
    ocppService16[wsdlservice][wsdlport] = {};

    wsdlops = wsdljs["wsdl:definitions"]["wsdl:portType"]["wsdl:operation"];

    wsdlops.forEach(function (op) {
      ocppService16[wsdlservice][wsdlport][op._attributes.name] = function (
        args,
        cb,
        headers,
      ) {
        ocppFunc("1.6", op._attributes.name, args, cb, headers);
      };
    }, this);

    let expressServer = express();
    let soapServer15, soapServer16;

    // Insert middleware into the flow...
    // WHY: Because:
    //      * node-soap repeats back the incoming "Content-Type"
    //      * some OCPP implementors add an un-necessary ACTION= to the http header content-type
    //      * Only action = /<action>Resonse seems to be valid to those same vendors.
    //      * most vendors don't care about the returned content-type of action since it is depreciated
    //        for Soap 1.2
    //
    //  The following express.use middleware will intercept the http headers and remove the additional
    //  action="/<action>" from the content-type if it sees it. This had to be done with express since
    //  node-soap removes all 'request' listeners from the server, therefore making it hard to intercept
    //  the http headers via a listener. But express inserts the middleware long before node-soap gets
    //  the message.
    //

    expressServer.use(function (req, res, next) {
      if (
        req.method == "POST" &&
        typeof req.headers["content-type"] !== "undefined"
      ) {
        if (req.headers["content-type"].toLowerCase().includes("action")) {
          let ctstr = req.headers["content-type"];
          let ctarr = ctstr.split(";");
          ctarr = ctarr.filter(function (ctitem) {
            return !ctitem.toLowerCase().includes("action");
          });
          req.headers["content-type"] = ctarr.join(";");
        }
      }
      next();
    });

    let server;

    try {
      server = expressServer.listen(node.svcPort, function () {
        if (node.pathlog == "") node.logging = false;

        if (node.enabled15) {
          soapServer15 = soap.listen(expressServer, {
            path: node.svcPath15,
            services: ocppService15,
            xml: wsdl15,
          });
          soapServer15.log = node.logging ? logData : null;
        }
        if (node.enabled16) {
          soapServer16 = soap.listen(expressServer, {
            path: node.svcPath16,
            services: ocppService16,
            xml: wsdl16,
          });
          soapServer16.log = node.logging ? logData : null;
        }
      });
    } catch (e) {
      console.log(`Error ${e}`);
    }

    this.on("close", function () {
      ee.removeAllListeners();
      debug_cpserver("Closing CP Server");
      server.close();
      this.status({ fill: "grey", shape: "dot", text: "stopped" });
    });

    // Creates the custom headers for our soap messages
    const addHeaders = function (headers, soapServer) {
      let addressing = "http://www.w3.org/2005/08/addressing";
      debug_cpserver("Clearing Soap Headers 2");
      soapServer.clearSoapHeaders();
      if (headers.Action) {
        let action = headers.Action.$value || headers.Action;
        if (action) {
          action = action + "Response";
          let act =
            '<Action xmlns="' +
            addressing +
            '" soap:mustUnderstand="true">' +
            action +
            "</Action>";
          soapServer.addSoapHeader(act);
        } else {
          //node.log('ERROR: No Action Found- '+ JSON.stringify(headers));
        }
      }
      let resp =
        '<RelatesTo RelationshipType="http://www.w3.org/2005/08/addressing/reply" xmlns="http://www.w3.org/2005/08/addressing">' +
        headers.MessageID +
        "</RelatesTo>";
      //soapServer.addSoapHeader({ RelatesTo: headers.MessageID}, null, null, addressing)
      soapServer.addSoapHeader(resp);
      soapServer.addSoapHeader(
        { To: "http://www.w3.org/2005/08/addressing/anonymous" },
        null,
        null,
        addressing,
      );
      let cbid =
        '<tns:chargeBoxIdentity soap:mustUnderstand="true">' +
          headers.chargeBoxIdentity.$value ||
        headers.chargeBoxIdentity ||
        "Unknown" + "</tns:chargeBoxIdentity>";
      soapServer.addSoapHeader(cbid);
    };

    // Creates the message any payload for sending out into the flow and sends it.
    const sendMsg = function (ocppVer, command, msgId, args, headers) {
      ///////////////////////////
      // PSEUDOCODE
      //
      // msg {
      //  msgId
      //  ocpp {
      //      MessageId
      //      ocppVersion
      //      chargeBoxIdentity
      //      command
      //      From
      //  }
      //  payload {
      //      command
      //      data { args }
      //  }
      // }
      //
      /////////////////////////////

      // NOTE: the incoming command is repeated twice in the message,
      // once for the ocpp object, and again in the payload, for convienience

      let msg = {};
      msg.ocpp = {};
      msg.payload = {};
      msg.payload.data = {};
      msg.msgId = msgId;
      msg.ee = ee;

      msg.ocpp.command = command;
      msg.payload.command = command;

      // idenitfy which chargebox the message originated from
      msg.ocpp.chargeBoxIdentity =
        headers.chargeBoxIdentity.$value ||
        headers.chargeBoxIdentity ||
        "Unknown";
      msg.ocpp.ocppVersion = ocppVer || "Unknown";

      if (headers.From) {
        if (headers.From.Address) {
          msg.ocpp.From = headers.From.Address;
        }
      }

      // We don't use the given soap MessageID to identify our message since it may
      // be missing or repeated across messages. It is used in the return soap message however
      msg.ocpp.MessageID = headers.MessageID || "Unknown";

      // repeat the command in the payload for convienience
      msg.payload.command = msg.ocpp.command;

      // this provide the body of the command with all the arguments
      if (args) {
        msg.payload.data = args;
      }

      node.send(msg);
    };
  }

  function OCPPRequestJNode(config) {
    RED.nodes.createNode(this, config);

    debug_csrequest("Starting CS request JSON Node");
    const node = this;

    this.remotecb = RED.nodes.getNode(config.remotecb);

    this.cbId = this.remotecb.cbId;
    this.name = config.name || "Request JSON";
    this.log = config.log;
    this.pathlog = config.pathlog;
    this.cmddata = config.cmddata || "error";
    this.command = config.command || "error";

    let eventname = node.cbId + REQEVTPOSTFIX;

    debug_csrequest("Event Names: " + ee.eventNames());

    // Change the node status to show connection status
    ee.on(node.cbId + CBIDCONPOSTFIX, function con_state(state) {
      let text;
      let fill;
      debug_csrequest(`State: ${state}`);
      if (state == "connected") {
        text = `Connected to ${node.cbId}`;
        fill = "green";
      } else {
        text = `Disconnected from ${node.cbId}`;
        fill = "gray";
      }
      node.status({
        fill,
        shape: "dot",
        text,
      });
    });

    if (ee.listenerCount(eventname) < 1) {
      node.status({
        fill: "blue",
        shape: "ring",
        text: `Waiting for ${node.cbId}`,
      });
    } else {
      node.status({
        fill: "green",
        shape: "dot",
        text: `Connected to ${node.cbId}`,
      });
    }

    this.on("input", function (msg) {
      msg.ocpp = {};

      msg.ocpp.chargeBoxIdentity = msg.payload.cbId || node.cbId;

      let eventname = msg.ocpp.chargeBoxIdentity + REQEVTPOSTFIX;
      let connname = msg.ocpp.chargeBoxIdentity + CBIDCONPOSTFIX;

      if (msg.ocpp?.command && msg.ocpp.command.startsWith("LOCAL_")) {
        debug_csrequest("Command: " + msg.ocpp.command);
        return;
      }

      debug_csrequest(ee.eventNames());

      if (cb_map.has(msg.ocpp.chargeBoxIdentity) == false) {
        node.status({
          fill: "grey",
          shape: "ring",
          text: `Not connected to ${msg.ocpp.chargeBoxIdentity}`,
        });
        debug_csrequest(
          `Attempt to send message to cbId ${msg.ocpp.chargeBoxIdentity} failed. Not connected yet.`,
        );
        return;
      }

      msg.ocpp.command = msg.payload.command || node.command;

      // We are only validating that there is some text for the command.
      // Currently not checking for a valid command.
      if (msg.ocpp.command === "error") {
        node.warn("OCPP JSON request node missing item: command");
        return;
      }

      // Check for the valid JSON formatted data.
      // msg.ocpp.data = msg.payload.data ||JSON.parse(node.cmddata);
      let datastr;
      if (msg.payload.data) {
        try {
          datastr = JSON.stringify(msg.payload.data);
          msg.ocpp.data = JSON.parse(datastr);
        } catch (e) {
          node.warn(
            "OCPP JSON request node invalid payload.data for message (" +
              msg.ocpp.command +
              "): " +
              e.message,
          );
          return;
        }
      } else if (node.cmddata != "error") {
        try {
          msg.ocpp.data = JSON.parse(node.cmddata);
        } catch (e) {
          node.warn(
            "OCPP JSON request node invalid message config data for message (" +
              msg.ocpp.command +
              "): " +
              e.message,
          );
          return;
        }
      } else {
        const errStr = `OCPP JSON request node missing data for message: ${msg.ocpp.command}`;
        debug_csrequest(errStr);
        node.warn(errStr);
        return;
      }

      if (msg.payload.MessageId) {
        msg.msgId = msg.payload.MessageId;
      } else if (msg.payload.MessageID) {
        // This is only here to cover for typo in the original documentation
        msg.msgId = msg.payload.MessageID;
      }

      msg.payload = {};

      node.status({
        fill: "green",
        shape: "dot",
        text: `${msg.ocpp.chargeBoxIdentity}:${msg.ocpp.command}`,
      });

      debug_csrequest(
        `event: ${eventname}, command: ${msg.ocpp.command}, msgId: ${msg.msgId}`,
      );

      ee.emit(eventname, msg, function (err, response) {
        if (err) {
          // report any errors
          node.error(err);
          msg.payload = err;
          node.send(msg);
        } else {
          // put the response to the request in the message payload and send it out the flow
          msg.ocpp = response.ocpp;
          msg.payload.data = response.payload.data;
          node.send(msg);
        }
      });
    });
  }

  RED.nodes.registerType("CS server", OCPPServerNode);
  RED.nodes.registerType("CP server SOAP", OCPPChargePointServerNode);
  RED.nodes.registerType("server response", OCPPResponseNode);
  RED.nodes.registerType("CS request JSON", OCPPRequestJNode);
};
