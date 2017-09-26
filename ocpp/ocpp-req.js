var path = require('path');
var soap = require('soap');
var os = require('os');
var fs = require('fs');

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
        this.log = config.log;
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
                    msg.ocpp.chargeBoxIdentity = cbId;
                    msg.ocpp.url = node.url;
                    msg.ocpp.ocppVer = node.ocppVer;
                    msg.ocpp.data = msg.payload.data||JSON.parse(node.cmddata);

                    // set up or target charge point
                    client.setEndpoint(msg.ocpp.url);

                    // add headers that are specific to OCPP specification
                    let addressing = 'http://www.w3.org/2005/08/addressing';

                    client.addSoapHeader({'tns:chargeBoxIdentity': msg.ocpp.chargeBoxIdentity});

                    client.addSoapHeader({To: msg.ocpp.url},null,null,addressing);

                    if (node.ocppVer != "1.5s"){
                        let act = '<Action xmlns="' + addressing + '" soap:mustUnderstand="true">' + msg.ocpp.command + '</Action>';
                        client.addSoapHeader(act);
                    }

                    // Setup logging
                    var log_file;
                    if (node.pathlog == "") node.log = false;
                    if (node.log){
                        //console.log('Request Opening Log File: ', node.pathlog);
                        
                        log_file = fs.createWriteStream(node.pathlog, {flags : 'w+'});
                        log_file.on('error', (err) => { node.error('Log file Error: (' + node.name +') ' + err); log_file.end(); node.log = false;})                                        
                    }        
                    if (node.log){
                        client.on('request', function(xmlSoap, xchgId){
                            var date = new Date().toLocaleString();
                            log_file.write(date 
                                        + '\t' + 'node: ' + node.name 
                                        + '\t' + 'type: request' 
                                        + '\t' + 'msgId: ' + xchgId
                                        + '\t' + xmlSoap
                                        + os.EOL);
                        });
    
                        client.on('response', function(xmlSoap, fullinfo, xchgId){
                            var date = new Date().toLocaleString();
                            log_file.write(date 
                                + '\t' + 'node: ' + node.name 
                                + '\t' + 'type: response' 
                                + '\t' + 'msgId: ' + xchgId
                                + '\t' + xmlSoap
                                + os.EOL);
                        });
    
                        client.on('soapError', function(err, xchgId){
                            var date = new Date().toLocaleString();
                            log_file.write(date 
                                + '\t' + 'node: ' + node.name 
                                + '\t' + 'type: error' 
                                + '\t' + 'msgId: ' + xchgId
                                + '\t' + err
                                + os.EOL);
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
                            msg.payload = response;
                            node.send(msg);
                        }
                    });

                }
            });
 
        });
    }
    // register our node
    RED.nodes.registerType("ocpp request",OcppRequestNode);
}