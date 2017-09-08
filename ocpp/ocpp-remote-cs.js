module.exports = function(RED) {
    function OcppRemoteCSNode(n) {
        RED.nodes.createNode(this,n);
        this.cbId = n.cbId;
        this.url = n.url;
        this.name = n.name||n.cbId;
        this.ocppver = n.ocppver;
    }
    RED.nodes.registerType("ocpp-remote-cs", OcppRemoteCSNode);
}