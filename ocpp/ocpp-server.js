"use strict";

//const http = require('http');
const express = require('express');
const soap = require('soap');
const fs = require('fs');
const path = require('path');
const events = require('events');
const uuidv4 = require('uuid/v4');
const xmlconvert = require('xml-js');
const os = require('os');
// const uuid = require('node-uuid');

const EventEmitter = events.EventEmitter;

let ee;

ee = new EventEmitter();

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
 
        node.status({fill: "blue", shape: "dot", text: "Waiting..."})                    
        
        // ee = new EventEmitter();

        ee.on('error', (err) => {
            node.error('EMITTER ERROR: ' + err);
        })


        // make local copies of our configuration
        this.svcPort = config.port;
        this.svcPath15 = config.path15;
        this.svcPath16 = config.path16;
        this.enabled15 = config.enabled15;
        this.enabled16 = config.enabled16;
        this.log = config.log;
        this.pathlog = config.pathlog;

        if (!this.enabled16 && !this.enabled15){
            node.status({fill: "red", shape: "dot", text: "Disabled"})                                
        }
        // read in the soap definition
        let wsdl15 = fs.readFileSync( path.join(__dirname, "ocpp_centralsystemservice_1.5_final.wsdl"),'utf8');
        let wsdl16 = fs.readFileSync( path.join(__dirname, "OCPP_CentralSystemService_1.6.wsdl"),'utf8');
        

        // define the default ocpp soap function for the server
        let ocppFunc = function(ocppVer, command, args, cb, headers){
            // create a unique id for each message to identify responses
            let id = uuidv4();

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
                        
            var soapSvr = (ocppVer == "1.5") ? soapServer15 : soapServer16;

            addHeaders(ocppVer, headers, soapSvr);


            var cbi = headers.chargeBoxIdentity||"Unknown";


            // let action = headers.Action.$value||headers.Action
            let action = command;

            node.status({fill: "green", shape: "ring", text: cbi + ": " + action })
            // Send the message out to the rest of the flow
            sendMsg(ocppVer,command, id, args,headers);

        }

        let wsdljs;
        let wsdlservice;
        let wsdlport;
        let wsdlops;
        let ocppService15 = {};
        let ocppService16 = {};
        
        // define our services and the functions they call.
        // Future: should be able to define this by parsing the soap xml file read in above.

        wsdljs = xmlconvert.xml2js(wsdl15, {compact: true, spaces: 4});
        wsdlservice = wsdljs['wsdl:definitions']['wsdl:service']._attributes.name;
        wsdlport = wsdljs['wsdl:definitions']['wsdl:service']['wsdl:port']._attributes.name;
        ocppService15 = {};
        ocppService15[wsdlservice] = {};
        ocppService15[wsdlservice][wsdlport] = {};

        wsdlops = wsdljs['wsdl:definitions']['wsdl:portType']['wsdl:operation'];


        wsdlops.forEach(function(op) {
            ocppService15[wsdlservice][wsdlport][op._attributes.name] = function(args, cb, headers){ ocppFunc("1.5",op._attributes.name, args, cb, headers); };            
        }, this);

        wsdljs = xmlconvert.xml2js(wsdl16, {compact: true, spaces: 4});
        wsdlservice = wsdljs['wsdl:definitions']['wsdl:service']._attributes.name;
        wsdlport = wsdljs['wsdl:definitions']['wsdl:service']['wsdl:port']._attributes.name;
        ocppService16 = {};
        ocppService16[wsdlservice] = {};
        ocppService16[wsdlservice][wsdlport] = {};

        wsdlops = wsdljs['wsdl:definitions']['wsdl:portType']['wsdl:operation'];

        wsdlops.forEach(function(op) {
            ocppService16[wsdlservice][wsdlport][op._attributes.name] = function(args, cb, headers){ ocppFunc("1.6",op._attributes.name ,args, cb, headers); };            
        }, this);

        
        var expressServer = express();
        var soapServer15, soapServer16;

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
            var log_file;
            if (node.pathlog == "") node.log = false;
            if (node.log){
                log_file = fs.createWriteStream(node.pathlog, {flags : 'w+'});
                log_file.on('error', (err) => { node.error('Log file Error: ' + err); log_file.end(); node.log = false;})                                        
            }
            if (node.enabled15){
                soapServer15 = soap.listen(expressServer,{ path: node.svcPath15, services: ocppService15, xml: wsdl15} );
                if (node.log){
                    soapServer15.log = function(type, data) {
                        if (node.log){  // only log if no errors w/ log file
                            var date = new Date().toLocaleString();
                            log_file.write( date + '\t type: ' + type + '\t' + ' data: ' + data + os.EOL);                                                        
                        }
                        else { // this stops attempting to log if there was an error with the log file.
                            soapServer15.log = "";
                        }
                    }
                }
        
            }
            if (node.enabled16){
                soapServer16 = soap.listen(expressServer,{ path: node.svcPath16, services: ocppService16, xml: wsdl16} );            

                if (node.log){
                    soapServer16.log = function(type, data) {
                        if (node.log){  // only log if no errors w/ log file
                            var date = new Date().toLocaleString();
                            log_file.write( date + '\t type: ' + type + '\t' + ' data: ' + data + os.EOL);                                                        
                        }
                        else { // this stops attempting to log if there was an error with the log file.
                            soapServer16.log = "";
                        }
                    }
                }
            }                

        });

        this.on('close', function(){
             // console.log('About to stop the server...');
            ee.removeAllListeners();
            
            server.close();
            this.status({fill: "grey", shape: "dot", text: "stopped"})                                    
            // console.log('Server closed?...');
            
        });

        // Creates the custom headers for our soap messages
        const addHeaders = function(ocppVer, headers, soapServer){
            let addressing = 'http://www.w3.org/2005/08/addressing';
            soapServer.clearSoapHeaders();
            //soapServer.addSoapHeader({'tns:chargeBoxIdentity': headers.chargeBoxIdentity });
            if (headers.Action){
                let action = headers.Action.$value||headers.Action;
                if (action){
                    action = action + 'Response';
                    //soapServer.addSoapHeader({Action: action }, null, null, addressing);
                    let act = '<Action xmlns="' + addressing + '" soap:mustUnderstand="true">' + action + '</Action>';
                    soapServer.addSoapHeader(act);
                }else{
                    //node.log('ERROR: No Action Found- '+ JSON.stringify(headers));
                }
    
            }
            if (headers.MessageID){
                let resp = '<RelatesTo RelationshipType="http://www.w3.org/2005/08/addressing/reply" xmlns="http://www.w3.org/2005/08/addressing">' + headers.MessageID + "</RelatesTo>"
                soapServer.addSoapHeader(resp);                
            }
            soapServer.addSoapHeader({ To: "http://www.w3.org/2005/08/addressing/anonymous"}, null, null, addressing);
            // let cbid = '<tns:chargeBoxIdentity soap:mustUnderstand="true">' + headers.chargeBoxIdentity + '</tns:chargeBoxIdentity>';
            
            let cbid = '<tns:chargeBoxIdentity';
            // We are only adding teh mustUnderstand to 1.6 since some CP implementations do not support having that 
            // attribute in the chargeBoxIdentity field.
            if (ocppVer != "1.5"){
                cbid = cbid + ' soap:mustUnderstand="true"';
            }
            cbid = cbid + '>' + headers.chargeBoxIdentity + '</tns:chargeBoxIdentity>';

            soapServer.addSoapHeader(cbid);
        }

        // Creates the message any payload for sending out into the flow and sends it.
        const sendMsg = function( ocppVer, command, msgId, args, headers){

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
            msg.msgId = msgId;


            msg.ocpp.command = command;

            // idenitfy which chargebox the message originated from
            msg.ocpp.chargeBoxIdentity = headers.chargeBoxIdentity||"Unknown";
            msg.ocpp.ocppVersion = ocppVer||"Unknown";

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
        
        node.status({fill: "blue", shape: "dot", text: "Waiting..."})                    
        
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
                this.status({fill: "grey", shape: "dot", text: "stopped"})                                    
            }
            done();
        })
    }


    function OCPPChargePointServerNode(config) {
        
        // console.log('starting Server Node')
        
        RED.nodes.createNode(this, config);
        var node = this;
    
        node.status({fill: "blue", shape: "dot", text: "Waiting..."})                    
        
        ee.on('error', (err) => {
            node.error('EMITTER ERROR: ' + err);
        })


        // make local copies of our configuration
        this.svcPort = config.port;
        this.svcPath15 = config.path15;
        this.svcPath16 = config.path16;
        this.enabled15 = config.enabled15;
        this.enabled16 = config.enabled16;

        if (!this.enabled16 && !this.enabled15){
            node.status({fill: "red", shape: "dot", text: "Disabled"})                                
        }
        // read in the soap definition
        let wsdl15 = fs.readFileSync( path.join(__dirname, "ocpp_chargepointservice_1.5_final.wsdl"),'utf8');
        let wsdl16 = fs.readFileSync( path.join(__dirname, "OCPP_ChargePointService_1.6.wsdl"),'utf8');
        

        // define the default ocpp soap function for the server
        let ocppFunc = function(ocppVer, command, args, cb, headers){
            // create a unique id for each message to identify responses
            let id = uuidv4();

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
            
            
            var soapSvr = (ocppVer == "1.5") ? soapServer15 : soapServer16;

            addHeaders(headers, soapSvr);


            var cbi = headers.chargeBoxIdentity||"Unknown";
            // let action = headers.Action.$value||headers.Action
            let action = command;

            node.status({fill: "green", shape: "ring", text: cbi + ": " + action })
            // Send the message out to the rest of the flow
            sendMsg(ocppVer,command, id, args,headers);

        }

        let wsdljs;
        let wsdlservice;
        let wsdlport;
        let wsdlops;
        let ocppService15 = {};
        let ocppService16 = {};
        
        // define our services and the functions they call.
        // Future: should be able to define this by parsing the soap xml file read in above.

        wsdljs = xmlconvert.xml2js(wsdl15, {compact: true, spaces: 4});
        wsdlservice = wsdljs['wsdl:definitions']['wsdl:service']._attributes.name;
        wsdlport = wsdljs['wsdl:definitions']['wsdl:service']['wsdl:port']._attributes.name;
        ocppService15 = {};
        ocppService15[wsdlservice] = {};
        ocppService15[wsdlservice][wsdlport] = {};

        wsdlops = wsdljs['wsdl:definitions']['wsdl:portType']['wsdl:operation'];


        wsdlops.forEach(function(op) {
            ocppService15[wsdlservice][wsdlport][op._attributes.name] = function(args, cb, headers){ ocppFunc("1.5",op._attributes.name, args, cb, headers); };            
        }, this);

        wsdljs = xmlconvert.xml2js(wsdl16, {compact: true, spaces: 4});
        wsdlservice = wsdljs['wsdl:definitions']['wsdl:service']._attributes.name;
        wsdlport = wsdljs['wsdl:definitions']['wsdl:service']['wsdl:port']._attributes.name;
        ocppService16 = {};
        ocppService16[wsdlservice] = {};
        ocppService16[wsdlservice][wsdlport] = {};

        wsdlops = wsdljs['wsdl:definitions']['wsdl:portType']['wsdl:operation'];

        wsdlops.forEach(function(op) {
            ocppService16[wsdlservice][wsdlport][op._attributes.name] = function(args, cb, headers){ ocppFunc("1.6",op._attributes.name ,args, cb, headers); };            
        }, this);

        
        var expressServer = express();
        var soapServer15, soapServer16;

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
            if (node.enabled15){
                soapServer15 = soap.listen(expressServer,{ path: node.svcPath15, services: ocppService15, xml: wsdl15} );
            }
            if (node.enabled15){
                soapServer16 = soap.listen(expressServer,{ path: node.svcPath16, services: ocppService16, xml: wsdl16} );            
            }                

            // soapServer15.log = function(type, data) {
            //     console.log('type:', type);
            //     console.log('data', data)
            //     if (type == 'replied'){
            //         // console.log('Sent: ', data);
            //     }
            // }
        });

        this.on('close', function(){
                // console.log('About to stop the server...');
            ee.removeAllListeners();
            
            server.close();
            this.status({fill: "grey", shape: "dot", text: "stopped"})                                    
            // console.log('Server closed?...');
            
        });




        // Creates the custom headers for our soap messages
        const addHeaders = function(headers, soapServer){
            let addressing = 'http://www.w3.org/2005/08/addressing';
            soapServer.clearSoapHeaders();
            //soapServer.addSoapHeader({'tns:chargeBoxIdentity': headers.chargeBoxIdentity });
            if (headers.Action){
                let action = headers.Action.$value||headers.Action;
                if (action){
                    action = action + 'Response';
                    //soapServer.addSoapHeader({Action: action }, null, null, addressing);
                    let act = '<Action xmlns="' + addressing + '" soap:mustUnderstand="true">' + action + '</Action>';
                    soapServer.addSoapHeader(act);
                }else{
                    //node.log('ERROR: No Action Found- '+ JSON.stringify(headers));
                }
    
            }
            let resp = '<RelatesTo RelationshipType="http://www.w3.org/2005/08/addressing/reply" xmlns="http://www.w3.org/2005/08/addressing">' + headers.MessageID + "</RelatesTo>"
            //soapServer.addSoapHeader({ RelatesTo: headers.MessageID}, null, null, addressing)
            soapServer.addSoapHeader(resp);
            soapServer.addSoapHeader({ To: "http://www.w3.org/2005/08/addressing/anonymous"}, null, null, addressing);
            let cbid = '<tns:chargeBoxIdentity soap:mustUnderstand="true">' + headers.chargeBoxIdentity + '</tns:chargeBoxIdentity>';
            soapServer.addSoapHeader(cbid);
        }

        // Creates the message any payload for sending out into the flow and sends it.
        const sendMsg = function( ocppVer, command, msgId, args, headers){

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
            msg.msgId = msgId;
            msg.ee = ee;

            msg.ocpp.command = command;

            // idenitfy which chargebox the message originated from
            msg.ocpp.chargeBoxIdentity = headers.chargeBoxIdentity||"Unknown";
            msg.ocpp.ocppVersion = ocppVer||"Unknown";

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
        
    RED.nodes.registerType("ocpp server",OCPPServerNode);
    RED.nodes.registerType("ocpp chargepoint server",OCPPChargePointServerNode);
    RED.nodes.registerType("ocpp response", OCPPResponseNode);
}