var path = require('path');
var soap = require('soap');
var os = require('os');
var fs = require('fs');
const uuidv4 = require('uuid/v4');

module.exports = function(RED) {
    function OcppRequestNode(config) {
        RED.nodes.createNode(this, config);
        
        var node = this;

        this.remotecb = RED.nodes.getNode(config.remotecb);

        this.url = this.remotecb.url;
        this.cbId = this.remotecb.cbId;
        this.ocppVer = this.remotecb.ocppver;
        this.name = config.name||this.remotecb.name;
        this.command = config.command;
        this.cmddata = config.cmddata;
        this.logging = config.log;
        this.pathlog = config.pathlog;

        this.on('input', function(msg) {

            // set up soap requests for SOAP 1.2 headers
            var wsdlOptions = {
                forceSoap12Headers: true,
            }

            // create the client 
            let wsdlFile = (node.ocppVer == "1.5s")? "ocpp_chargepointservice_1.5_final.wsdl" : "OCPP_ChargePointService_1.6.wsdl"
            soap.createClient(path.join(__dirname,wsdlFile),wsdlOptions, function(err, client){
                if (err) node.error(err);
                else{

                    var cbId = node.cbId;

                    msg.ocpp = {};
                    msg.ocpp.command = msg.payload.command||node.command;
                    msg.ocpp.MessageId = msg.payload.MessageId||uuidv4();
                    msg.ocpp.chargeBoxIdentity = cbId;
                    msg.ocpp.url = node.url;
                    msg.ocpp.ocppVer = node.ocppVer;
                    let cmddata;
                    if (node.cmddata){
                        cmddata = JSON.parse(node.cmddata);
                    }
                    msg.ocpp.data = msg.payload.data||cmddata;

                    if (!msg.ocpp.command){
                        node.error('Missing Command in SOAP request message');
                        return;
                    }
                    else if (!msg.ocpp.data){
                        node.error('Missing Data in SOAP request message');
                        return;
                    }

                    // set up or target charge point
                    client.setEndpoint(msg.ocpp.url);

                    // add headers that are specific to OCPP specification
                    let addressing = 'http://www.w3.org/2005/08/addressing';

                    client.addSoapHeader({'tns:chargeBoxIdentity': msg.ocpp.chargeBoxIdentity});

                    client.addSoapHeader({To: msg.ocpp.url},null,null,addressing);

                    // if (node.ocppVer != "1.5s"){
                        let act = `<Action xmlns="${addressing}" soap:mustUnderstand="true">/${msg.ocpp.command}</Action>`;
                        client.addSoapHeader(act);
                    // }
                    let repto = `<ReplyTo xmlns="${addressing}"><Address>http://www.w3.org/2005/08/addressing/anonymous</Address></ReplyTo>`;
                    client.addSoapHeader(repto);
                    let msgid = `<MessageID xmlns="${addressing}">${msg.ocpp.MessageId}</MessageID>`;
                    client.addSoapHeader(msgid);
                    
                    // Setup logging
                    var log_file;
                    if (node.pathlog == "") node.logging = false;
                    if (node.logging){
                        client.on('request', function(xmlSoap, xchgId){
                            logData('request', xmlSoap);
                        });
    
                        client.on('response', function(xmlSoap, fullinfo, xchgId){
                            logData('replied', xmlSoap);
                        });
    
                        client.on('soapError', function(err, xchgId){
                            console.log('got error:', err.message);
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
                        }
                        else {
                            // put the response to the request in the message payload and send it out the flow
                            msg.payload.data = response;
                            node.send(msg);
                        }
                    });

                }
            });
 
        });

        function logData(type, data) {
            if (node.logging === true){  // only log if no errors w/ log file
                // set a timestamp for the logged item
                let date = new Date().toLocaleString();
                // create the logged info from a template
                var xdata = data||'<no data>';
                let logInfo = `${date} \t node: ${node.name} \t type: ${type} \t data: ${xdata.replace(/[\n\r]/g,"")} ${os.EOL}`;

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
    RED.nodes.registerType("CS request SOAP",OcppRequestNode);
}