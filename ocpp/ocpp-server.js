"use strict";

//const http = require('http');
const express = require('express');
const soap = require('soap');
const fs = require('fs');
const path = require('path');
const events = require('events');
const uuidv4 = require('uuid/v4');
// const uuid = require('node-uuid');

const EventEmitter = events.EventEmitter;

let ee;

// override the soap envelope to add an additional header to support soap 1.2
// NOTE: If the npm soap module used by this evolves to support 1.2 on the server side, this code
// could be removed
//

soap.Server.prototype.__envelope = soap.Server.prototype._envelope;

soap.Server.prototype._envelope = function(body, includeTimestamp){
    //var xml = ""
    var xml = this.__envelope(body, includeTimestamp);
    xml = xml.replace(' xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"', '');
    //xml = xml.replace(' xmlns:tns="urn://Ocpp/Cs/2012/06/"','');
    return xml.replace("http://schemas.xmlsoap.org/soap/envelope/","http://www.w3.org/2003/05/soap-envelope");
}
// end envelope header modifications

////////////////////////////////////
// Node-Red stuff
///////////////////////////////////        

module.exports = function(RED) {

    // Create a server node for monitoring incoming soap messages
    function OCPPServerNode(config) {

        // console.log('starting Server Node')
        
        RED.nodes.createNode(this, config);
        var node = this;
 
        node.status({fill: "blue", shape: "ring", text: "Waiting..."})                    
        
        ee = new EventEmitter();

        ee.on('error', (err) => {
            node.error('EMITTER ERROR: ' + err);
        })


        // make local copies of our configuration
        this.svcPort = config.port;
        this.svcPath = config.path;

        // read in the soap definition
        let xml = fs.readFileSync( path.join(__dirname, "ocpp_centralsystemservice_1.5_final.wsdl.txt"),'utf8');

        // console.log('About to start....')

        // define the default ocpp soap function for the server
        let ocppFunc = function(args, cb, headers){
            // console.log('in Heartbeat');

            // create a unique id for each message to identify responses
            let id = uuidv4();
            // console.log("start:", id);

            // Set a timout for each event response so they do not pile up if not responded to
            let to = setTimeout( function(id){
                // node.log("kill:" + id);
                if (ee.listenerCount(id) > 0){
                    let evList = ee.listeners(id);
                    ee.removeListener(id,evList[0]);
                }
            }, 120 * 1000, id);

            // This makes the response async so that we pass the responsibility onto the response node
            ee.once(id, function(returnMsg){
                // console.log("send:", id);
                clearTimeout(to);
                cb(returnMsg);                        
            });

            // Add custom headers to the soap package
            addHeaders(headers);


            var cbi = headers.chargeBoxIdentity||"Unknown";
            let action = headers.Action.$value||headers.Action

            node.status({fill: "green", shape: "ring", text: cbi + ": " + action })
            // Send the message out to the rest of the flow
            sendMsg(id, args,headers);

        }

        
        // define our services and the functions they call.
        // Future: should be able to define this by parsing the soap xml file read in above.
        let ocppService = {
            CentralSystemService: {
                CentralSystemServiceSoap12: {
                    Heartbeat: function(args, cb, headers){ ocppFunc(args, cb, headers); },
                    Authorize: function(args, cb, headers){ ocppFunc(args, cb, headers); },
                    BootNotification: function(args, cb, headers){ ocppFunc(args, cb, headers); },
                    MeterValues: function(args, cb, headers){ ocppFunc(args, cb, headers); },
                    StatusNotification: function(args, cb, headers){ ocppFunc(args, cb, headers); },
                    StartTransaction: function(args, cb, headers){ ocppFunc(args, cb, headers); },
                    StopTransaction: function(args, cb, headers){ ocppFunc(args, cb, headers); }
                }
            }
        }

        var expressServer = express();
        var soapServer;

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
        expressServer.use(function(req,res,next){
            // console.log('In middleware #########')
            if (req.method == "POST" && typeof req.headers['content-type'] !== "undefined") {
                if (req.headers['content-type'].toLowerCase().includes('action')){
                    // console.log(req.headers)
                    var ctstr = req.headers['content-type'];
                    var ctarr = ctstr.split(";");
                    // console.log("before: ", ctarr);
                    ctarr = ctarr.filter(function(ctitem){
                        return ! ctitem.toLowerCase().includes('action')
                    })
                    // console.log("after: ", ctarr.join(";"));
                    req.headers['content-type'] = ctarr.join(";");
                }
            }
            next();
        });

        const server = expressServer.listen(this.svcPort, function(){
            soapServer = soap.listen(expressServer,{ path: node.svcPath, services: ocppService, xml: xml} );            
            // soapServer.log = function(type, data) {
            //     console.log('type:', type);
            //     if (type == 'replied'){
            //         // console.log('Sent: ', data);
            //     }
            // }
        });

        this.on('close', function(){
             // console.log('About to stop the server...');
            ee.removeAllListeners();
            
            server.close();
             // console.log('Server closed?...');
            
        });




        // Creates the custom headers for our soap messages
        const addHeaders = function(headers){
            let addressing = 'http://www.w3.org/2005/08/addressing';
            soapServer.clearSoapHeaders();
            //soapServer.addSoapHeader({'tns:chargeBoxIdentity': headers.chargeBoxIdentity });
            let action = headers.Action.$value||headers.Action;
            if (action){
                action = action + 'Response';
                soapServer.addSoapHeader({Action: action }, null, null, addressing);
            }else{
                node.log('ERROR: No Action Found- '+ JSON.stringify(headers));
            }
            let resp = '<RelatesTo RelationshipType="http://www.w3.org/2005/08/addressing/reply" xmlns="http://www.w3.org/2005/08/addressing">' + headers.MessageID + "</RelatesTo>"
            //soapServer.addSoapHeader({ RelatesTo: headers.MessageID}, null, null, addressing)
            soapServer.addSoapHeader(resp);
            soapServer.addSoapHeader({ To: "http://www.w3.org/2005/08/addressing/anonymous"}, null, null, addressing)
        }

        // Creates the message any payload for sending out into the flow and sends it.
        const sendMsg = function(msgId, args,headers){

            // msg {
            //  msgId
            //  ocpp {
            //      MessageId
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
            msg.msgId = msgId;

            // parse the action into a command
            let action = headers.Action.$value||headers.Action
            if (action){
                action = action.replace(/^\//g,"");
                msg.ocpp.command = action;
            }else{
                msg.ocpp.command = "Unknown";
            }
            // idenitfy which chargebox the message originated from
            msg.ocpp.chargeBoxIdentity = headers.chargeBoxIdentity||"Unknown";

            if(headers.From){
                if(headers.From.Address){
                    msg.ocpp.From = headers.From.Address;                    
                }
            }

            // We don't use the given soap MessageID to identify our message since it may
            // be missing or repeated across messages. It is used in the return soap message however
            msg.ocpp.MessageID = headers.MessageID||"Unknown";

            // repeat the command in the payload for convienience
            msg.payload.command = msg.ocpp.command;
    
            // this provide the body of the command with all the arguments
            if (args){
                msg.payload.data = args;
            }

            node.send(msg);
        }

    }

    // Create a "resonse" node for returning messages to soap
    function OCPPResponseNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;
        // console.log('starting Response Node')
        
        this.on('input', function(msg) {
            var x = 0;
            if(msg.msgId){
                // we simply return the payload of the message and emit a node message based on the unique 
                // id we created when we recieved the soap event.
                // console.log("emit msg...");
                var command = msg.ocpp.command;
                    var x = ee.emit(msg.msgId,msg.payload);
                    if (x){
                        node.status({fill: "green", shape: "ring", text: command + " sent" })
                    }else{
                        node.status({fill: "red", shape: "ring", text: "message failed"})                    
                    }
    
            }
            else{
                node.log('ERROR: missing msgId for return target');
            }
        });

        this.on('close', function(removed, done){
            if (!removed){
                this.status({fill: "red", shape: "ring", text: "stopped"})                                    
            }
            done();
        })
    }


    RED.nodes.registerType("ocpp server",OCPPServerNode);
    RED.nodes.registerType("ocpp response", OCPPResponseNode);
}