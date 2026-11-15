'use strict';

module.exports = {
  async getState({ homey }) {
    return homey.app.getDashboard();
  },

  async start({ homey }) {
    return homey.app.startFromWidget();
  },

  async release({ homey }) {
    return homey.app.releaseFromWidget();
  },
};
