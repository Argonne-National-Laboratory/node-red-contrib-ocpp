const path = require('path');
const os = require('os');
const fs = require('fs');
const websocket = require('ws');
const uuidv4 = require('uuid/v4');
const events = require('events');
const EventEmitter = events.EventEmitter;

let ee = new EventEmitter();


module.exports = function(RED) {
    function OCPPChargePointJNode(config) {
        RED.nodes.createNode(this, config);

        const CALL = 2;
        const CALLRESULT = 3;
        const CALLERROR = 4;

        // for logging...
        const msgTypeStr = ['unknown','unknown','received', 'replied', 'error'];

        const msgType = 0;
        const msgId  = 1;
        const msgAction = 2;
        const msgCallPayload = 3;
        const msgResPayload = 2;

        var node = this;

        node.reqKV = {};

        this.remotecs = RED.nodes.getNode(config.remotecs);

        this.url = this.remotecs.url;
        this.cbId = config.cbId;
        this.ocppVer = this.ocppver;
        this.name = config.name||this.remotecs.name;
        this.command = config.command;
        this.cmddata = config.cmddata;
        this.logging = config.log||false;
        this.pathlog = config.pathlog;

        let csUrl =  `${this.remotecs.url}/${this.cbId}`;

        logData('info', `Making websocket connectio to ${csUrl}`);

        let ws = new websocket(csUrl, {"handshaketimeout": 5000});
        
        ws.on('open', function(){
            node.status({fill: "green", shape: "dot", text: "Connected..."})
            node.wsconnected = true;
        });
        ws.on('close', function(x){
            logData('info', `Closing websocket connectio to ${csUrl}`);            
            node.status({fill: "red", shape: "dot", text: "Closed..."})
            node.wsconnected = false;
        });
        
        ws.on('error', function(err){
            //console.log(`Websocket error: ${err}`);
            node.log(`Websocket error: ${err}`)
        });

        ws.on('message', function (msgIn) {

            let msg = {};
            msg.ocpp = {};
            msg.payload = {};

            msg.ocpp.ocppVersion = "1.6j";
            //msg.ocpp.chargeBoxIdentity = 'javadog';


            let response = [];
            let id = uuidv4();
            let currTime = new Date().toISOString();

            let msgParsed;


            if (msgIn[0] != '[') {
                msgParsed = JSON.parse('[' + msgIn + ']');
            }
            else {
                msgParsed = JSON.parse(msgIn);
            }


            logData(msgTypeStr[msgParsed[msgType]], JSON.stringify(msgParsed));

            if (msgParsed[msgType] == CALL) {
                // msg.msgId = msgParsed[msgId];
                msg.msgId = id;
                msg.ocpp.MessageId = msgParsed[msgId];
                msg.ocpp.msgType = CALL;
                msg.ocpp.command = msgParsed[msgAction];
                msg.payload.command = msgParsed[msgAction];
                msg.payload.data = msgParsed[msgCallPayload];

                let to = setTimeout(function (id) {
                    // node.log("kill:" + id);
                    if (ee.listenerCount(id) > 0) {
                        let evList = ee.listeners(id);
                        let x = evList[0];
                        ee.removeListener(id, x);
                    }
                }, 120 * 1000, id);

                // This makes the response async so that we pass the responsibility onto the response node
                ee.once(id, function (returnMsg) {
                    clearTimeout(to);
                    response[msgType] = CALLRESULT;
                    response[msgId] = msgParsed[msgId];
                    response[msgResPayload] = returnMsg;

                    logData(msgTypeStr[response[msgType]], JSON.stringify(response).replace(/,/g, ", "));
                    
                    ws.send(JSON.stringify(response));

                });

                node.send(msg);
            }
            else if (msgParsed[msgType] == CALLRESULT) {

                msg.msgId = msgParsed[msgId];
                msg.ocpp.MessageId = msgParsed[msgId];
                msg.ocpp.msgType = CALLRESULT;
                msg.payload.data = msgParsed[msgResPayload];

                if (node.reqKV.hasOwnProperty(msg.msgId)){
                    msg.ocpp.command = node.reqKV[msg.msgId];
                    delete node.reqKV[msg.msgId];                    
                }
                else{
                    msg.ocpp.command = 'unknown';
                }

                node.send(msg);

            }

        });
        
        ws.on('ping', function(){
            //console.log('JAVADOG: Got Ping');
            ws.send('pong');
        });
        ws.on('pong', function(){
            //console.log('JAVADOG: Got Pong');
        });
        

        this.on('input', function(msg) {

            if (node.wsconnected == true){

                let request = [];
                let messageTypeStr = ["unknown","unknown","request","replied","error"];
                
                request[msgType] = msg.payload.msgType||CALL;
                request[msgId] = msg.payload.MessageId||uuidv4();

                if (request[msgType] == CALL){
                    request[msgAction] = msg.payload.command;
                    request[msgCallPayload] = msg.payload.data||{};    
                    node.reqKV[request[msgId]] = request[msgAction];                    
                }
                else{
                    request[msgResPayload] = msg.payload.data||{};
                }

                logData(messageTypeStr[request[msgType]], JSON.stringify(request).replace(/,/g, ", "));
                
                ws.send(JSON.stringify(request));
            }
         });

         this.on('close', function(reason){
            node.status({fill: "red", shape: "dot", text: "Closed..."})
            logData('info', 'Websocket closed');
            //console.log(`WS STATUS: ${ws.readyState}`);
            ws.close();
            //if (ws.readyState == 1)
                //ws.close();
         });

         function logData(type, data) {
            if (node.logging === true){  // only log if no errors w/ log file
                // set a timestamp for the logged item
                let date = new Date().toLocaleString();
                let dataStr = '<no data>';
                if (typeof data === 'string'){
                    dataStr = data.replace(/[\n\r]/g,"");
                }
                // create the logged info from a template
                let logInfo = `${date} \t node: ${node.name} \t type: ${type} \t data: ${dataStr} ${os.EOL}`;

                // create/append the log info to the file
                fs.appendFile(node.pathlog,logInfo,(err) => {
                    if (err){
                        node.error(`Error writing to log file: ${err}`);
                        // If something went wrong then turn off logging
                        node.logging = false;    
                        if(node.log) node.log = null;
                    }
                });
            }
        }


    }
    // register our node
    RED.nodes.registerType("CP client JSON",OCPPChargePointJNode);
}