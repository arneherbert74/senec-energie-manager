'use strict';

const Homey = require('homey');

class SenecApp extends Homey.App {

  async onInit() {
    this.batteries = new Set();
    this.log('SenecApp has been initialized');
  }

  registerBattery(device) {
    this.batteries.add(device);
  }

  unregisterBattery(device) {
    this.batteries.delete(device);
  }

  /** Erstes Speicher-Geraet; die App ist fuer einen Speicher pro Homey gedacht. */
  getBattery() {
    const [first] = this.batteries;
    return first || null;
  }

  /** Daten fuer die Dashboard-Widgets. */
  getDashboard() {
    const battery = this.getBattery();
    if (!battery) return { configured: false };
    return { configured: true, ...battery.getDashboardState() };
  }

  async startFromWidget() {
    const battery = this.getBattery();
    if (!battery) throw new Error(this.homey.__('errors.no_device'));
    const { charge } = battery.getDashboardState();
    const result = await battery.startCharge({
      targetSoc: charge.defaultTarget, maxMinutes: charge.defaultMinutes,
    }, 'widget');
    if (!result.started) throw new Error(this.homey.__(`errors.${result.reason}`));
    return result;
  }

  async releaseFromWidget() {
    const battery = this.getBattery();
    if (!battery) throw new Error(this.homey.__('errors.no_device'));
    const result = await battery.releaseCharge();
    if (!result.released && result.reason === 'fremde_ladung') {
      throw new Error(this.homey.__('errors.fremde_ladung'));
    }
    return result;
  }

}

module.exports = SenecApp;
