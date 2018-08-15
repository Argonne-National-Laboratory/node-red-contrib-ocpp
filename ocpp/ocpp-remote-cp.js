'use strict';

module.exports = function(RED) {
  function OcppRemoteCPNode(n) {
    RED.nodes.createNode(this, n);
    this.cbId = n.cbId;
    this.url = n.url;
    this.name = n.name || n.cbId;
    this.ocppver = n.ocppver;
  }

  function OcppRemotejCPNode(n) {
    RED.nodes.createNode(this, n);
    this.cbId = n.cbId;
    this.name = n.name || n.cbId;
    this.ocppver = n.ocppver;
  }

  RED.nodes.registerType('ocpp-remote-cp', OcppRemoteCPNode);
  RED.nodes.registerType('ocpp-remotej-cp', OcppRemotejCPNode);
};
