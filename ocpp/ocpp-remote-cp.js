module.exports = function(RED) {
    function OcppRemoteCPNode(n) {
        RED.nodes.createNode(this,n);
        this.cbId = n.cbId;
        this.url = n.url;
        this.name = n.name||n.cbId;
    }
    RED.nodes.registerType("ocpp-remote-cp", OcppRemoteCPNode);
}