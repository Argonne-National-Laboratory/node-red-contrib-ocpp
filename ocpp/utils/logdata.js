'use strict';

const os = require('os');
const fs = require('fs');
const debug = require('debug')('anl:ocpp:utils:logdata');


class LogData {
  constructor(node, logpath, label = 'info') {
    this._label = label;
    this.logpath = logpath;
    this._enabled = true;
    this._node = node;
  }

  set enabled(val) {
    this._enabled = val;
  }

  get enabled() {
    return this._enabled;
  }

  set label(label) {
    this._label = label;
  }

  get label() {
    return this._label;
  }

  log(type, data) {
    if (this.enabled) {
      // set a timestamp for the logged item
      let date = new Date().toLocaleString();
      let dataStr = '<no data>';
      if (typeof data === 'string') {
        dataStr = data.replace(/[\n\r]/g, '');
      }
      // create the logged info from a template
      let logInfo = `${date} \t node: ${this.label} \t type: ${type} \t data: ${dataStr} ${os.EOL}`;

      // create/append the log info to the file
      fs.appendFile(this.logpath, logInfo, err => {
        if (err) {
          this._node.error(`Error writing to log file: ${err}`);
          debug(`Error writing to log file: ${err} from node ${this._node.name}`);
          // If something went wrong then turn off logging
          this.enabled = false;
        }
      });
    }
  }
}

module.exports = LogData;
