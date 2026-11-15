'use strict';

const { Driver } = require('homey');

class SenecDriver extends Driver {

  async onInit() {
    this.log('SenecDriver initialized');

    // Flow-Karten: die Schnittstelle zwischen Homey-Flows und der Lade-Sitzung.
    this.homey.flow.getActionCard('force_charge_start')
      .registerRunListener(async ({ device, target_soc: targetSoc, max_minutes: maxMinutes }) => {
        const result = await device.startCharge({ targetSoc, maxMinutes }, 'flow');
        if (!result.started) throw new Error(this.homey.__(`errors.${result.reason}`));
      });

    this.homey.flow.getActionCard('force_charge_release')
      .registerRunListener(async ({ device }) => {
        const result = await device.releaseCharge();
        if (!result.released && result.reason === 'fremde_ladung') {
          throw new Error(this.homey.__('errors.fremde_ladung'));
        }
      });

    this.homey.flow.getConditionCard('force_charge_active')
      .registerRunListener(async ({ device }) => device.isChargeActive());
  }

  async onPair(session) {
    session.setHandler('check_ip_event', async (data) => {
      if (
        /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
          data.ip,
        )
      ) {
        // TODO: replace with mac
        session.emit('save_device', { mac: data.ip, ip: data.ip });
        return null;
      }
      return 'Invalid IP-address!';
    });
  }

}

module.exports = SenecDriver;
