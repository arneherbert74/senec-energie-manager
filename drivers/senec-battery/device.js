'use strict';

const Homey = require('homey');
const { LalaClient } = require('../../lib/LalaClient');
const { ForceChargeSession, clampTarget, clampMinutes } = require('../../lib/ForceChargeSession');
const { POLL_REQUEST, parsePoll } = require('../../lib/senecData');
const { statusKey, switchOn } = require('../../lib/chargeText');

const SESSION_STORE_KEY = 'forceChargeSession';
const LAST_ENDED_KEY = 'lastEnded';
const LAST_START_KEY = 'lastStart';
const RELEASE_WAIT_MS = 30000;
const TICK_MS = 5000;

class SenecDevice extends Homey.Device {

  async onInit() {
    this.log('SenecDevice wird gestartet');

    for (const cap of ['measure_power', 'meter_power.charged', 'meter_power.discharged', 'force_charge_status']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    this.chargedEnergy = this.getCapabilityValue('meter_power.charged') || 0;
    this.dischargedEnergy = this.getCapabilityValue('meter_power.discharged') || 0;
    this.lastPowerUpdate = Date.now();
    this.lastStatus = null;

    this.client = new LalaClient({ host: this.getSetting('ipAddress') });
    this.session = new ForceChargeSession({
      client: this.client,
      store: {
        load: async () => this.getStoreValue(SESSION_STORE_KEY) || null,
        save: async (value) => this.setStoreValue(SESSION_STORE_KEY, value),
      },
      log: (msg) => this.log(`[Netzladung] ${msg}`),
      onEnded: (event) => this._onChargeEnded(event),
      onChange: (snap) => this._onSessionChange(snap),
    });

    this.registerCapabilityListener('onoff', (value) => this._onSwitch(value));

    this.homey.app.registerBattery(this);

    // Erst die Sitzung wiederherstellen (Sicherungen 4 und 5), dann regelmaessig abfragen.
    this.ready = this._initSession();

    this.consecutiveErrors = 0;
    this.baseInterval = 3000;
    this.maxInterval = 60000;
    this._schedulePoll();
    this.tickInterval = this.homey.setInterval(() => this._tick(), TICK_MS);
  }

  // ------------------------------------------------------------ Sitzung

  async _initSession() {
    let status = null;
    try {
      status = await this._readStatus();
    } catch (err) {
      this.error('Erster Status nicht lesbar:', err.message);
    }
    await this.session.init(status);
  }

  async _tick() {
    try {
      await this.ready;
      await this.session.tick();
      this._onSessionChange(this.session.snapshot());
    } catch (err) {
      this.error('Tick fehlgeschlagen:', err.message);
    }
  }

  /** Schalter in der Homey-App. Ein Fehler setzt den Schalter zurueck und zeigt die Meldung. */
  async _onSwitch(value) {
    await this.ready;
    if (value) {
      const result = await this.startCharge({
        targetSoc: this.getSetting('default_target'),
        maxMinutes: this.getSetting('default_minutes'),
      }, 'switch');
      if (!result.started) throw new Error(this.homey.__(`errors.${result.reason}`));
      return;
    }
    const result = await this.releaseCharge();
    if (!result.released && result.reason === 'fremde_ladung') {
      throw new Error(this.homey.__('errors.fremde_ladung'));
    }
  }

  /**
   * Startet eine Ladung. Quelle: 'switch' | 'flow' | 'widget'.
   * @returns {Promise<{started:boolean, updated?:boolean, reason?:string, target:number, maxMinutes:number}>}
   */
  async startCharge({ targetSoc, maxMinutes }, source) {
    await this.ready;
    const result = await this.session.start({ targetSoc, maxMinutes });
    if (result.started && !result.updated) {
      await this.setStoreValue(LAST_START_KEY, { source, at: Date.now() }).catch(this.error);
      if (this.getSetting('notify_start') !== false) {
        this._notify(this.homey.__('notify.started', {
          target: result.target,
          minutes: result.maxMinutes,
          soc: this._socText(),
          source: this.homey.__(`source.${source}`),
        }));
      }
    }
    this._onSessionChange(this.session.snapshot());
    return result;
  }

  /**
   * Gibt die eigene Ladung frei. Wartet hoechstens 30 s; danach laeuft die
   * Freigabe im Hintergrund weiter (Sicherung 8).
   * @returns {Promise<{released:boolean, reason?:string, pending?:boolean}>}
   */
  async releaseCharge() {
    await this.ready;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.homey.setTimeout(() => resolve({ released: true, pending: true }), RELEASE_WAIT_MS);
    });
    try {
      return await Promise.race([this.session.release(), timeout]);
    } finally {
      this.homey.clearTimeout(timer);
      this._onSessionChange(this.session.snapshot());
    }
  }

  isChargeActive() {
    return this.session.snapshot().active;
  }

  async _onChargeEnded({ reason, soc, durationMin }) {
    const lastEnded = {
      reason, soc, durationMin, at: Date.now(),
    };
    await this.setStoreValue(LAST_ENDED_KEY, lastEnded).catch(this.error);

    const reasonText = this.homey.__(`reasons.${reason}`);
    this.homey.flow.getDeviceTriggerCard('force_charge_ended')
      .trigger(this, {
        reason, reason_text: reasonText, soc: soc ?? -1, duration_min: durationMin,
      })
      .catch(this.error);

    if (this.getSetting('notify_end') !== false) {
      this._notify(this.homey.__('notify.ended', {
        reason: reasonText, soc: this._socText(soc), minutes: durationMin,
      }));
    }
  }

  _onSessionChange(snap) {
    if (!this.hasCapability('force_charge_status')) return;
    const { key, tokens } = statusKey(snap);
    const text = this.homey.__(key, tokens);
    if (this.getCapabilityValue('force_charge_status') !== text) {
      this.setCapabilityValue('force_charge_status', text).catch(this.error);
    }
    const on = switchOn(snap);
    if (this.getCapabilityValue('onoff') !== on) {
      this.setCapabilityValue('onoff', on).catch(this.error);
    }
    if (snap.warning) {
      if (this._warnCount !== snap.releaseFailures) {
        this._warnCount = snap.releaseFailures;
        this.setWarning(this.homey.__('warning.release_failed', { count: snap.releaseFailures })).catch(this.error);
        if (snap.releaseFailures === 1) this._notify(this.homey.__('notify.release_failed'));
      }
    } else if (this._warnCount) {
      this._warnCount = 0;
      this.unsetWarning().catch(this.error);
    }
  }

  _notify(excerpt) {
    this.homey.notifications.createNotification({ excerpt }).catch(this.error);
  }

  _socText(soc) {
    const value = soc ?? (this.lastStatus && this.lastStatus.soc);
    return typeof value === 'number' && value >= 0 ? `${Math.round(value)}` : '?';
  }

  /** Daten fuer die Widgets. */
  getDashboardState() {
    const snap = this.session.snapshot();
    return {
      live: this.lastStatus,
      available: this.getAvailable(),
      charge: {
        ...snap,
        statusText: this.getCapabilityValue('force_charge_status'),
        lastEnded: this.getStoreValue(LAST_ENDED_KEY) || null,
        lastStart: this.getStoreValue(LAST_START_KEY) || null,
        defaultTarget: clampTarget(this.getSetting('default_target')),
        defaultMinutes: clampMinutes(this.getSetting('default_minutes')),
      },
    };
  }

  // ------------------------------------------------------------- Abfrage

  async _readStatus() {
    return parsePoll(await this.client.post(POLL_REQUEST));
  }

  _schedulePoll() {
    const delay = Math.min(this.baseInterval * (2 ** this.consecutiveErrors), this.maxInterval);
    this.pollTimeout = this.homey.setTimeout(async () => {
      await this.pollBatteryStatus();
      if (!this._stopped) this._schedulePoll();
    }, delay);
  }

  async pollBatteryStatus() {
    let status;
    try {
      status = await this._readStatus();
    } catch (error) {
      this.consecutiveErrors++;
      this.error('Abfrage fehlgeschlagen:', error.message);
      if (this.consecutiveErrors >= 3) {
        this.setUnavailable(this.homey.__('errors.unreachable')).catch(this.error);
      }
      return;
    }

    this.consecutiveErrors = 0;
    if (!this.getAvailable()) this.setAvailable().catch(this.error);
    this.lastStatus = { ...status, at: Date.now() };

    this._setCap('measure_battery', status.soc);
    this._setCap('measure_voltage', status.batteryVoltage);
    this._setCap('measure_current', status.batteryCurrent);
    if (status.batteryPower !== null) {
      // SENEC: positiv = laden, negativ = entladen; passt so fuer den Energie-Tab
      this._setCap('measure_power', status.batteryPower);
      this.updateEnergyMeters(status.batteryPower);
    }

    this.homey.app.emit('senec-data', {
      batteryPower: status.batteryPower,
      inverterPower: status.pvPower,
      gridPower: status.gridPower,
      housePower: status.housePower,
    });

    try {
      await this.ready;
      await this.session.onStatus(status);
      this._onSessionChange(this.session.snapshot());
    } catch (err) {
      this.error('Auswertung der Sitzung fehlgeschlagen:', err.message);
    }
  }

  _setCap(cap, value) {
    if (value === null || value === undefined) return;
    if (this.getCapabilityValue(cap) === value) return;
    this.setCapabilityValue(cap, value).catch(this.error);
  }

  updateEnergyMeters(batteryPower) {
    const now = Date.now();
    const timeDiffSeconds = (now - this.lastPowerUpdate) / 1000;
    this.lastPowerUpdate = now;
    const energyKwh = (Math.abs(batteryPower) * timeDiffSeconds) / 3600 / 1000;

    if (batteryPower > 0) {
      this.chargedEnergy = Math.round((this.chargedEnergy + energyKwh) * 10000) / 10000;
      this.setCapabilityValue('meter_power.charged', this.chargedEnergy).catch(this.error);
    } else if (batteryPower < 0) {
      this.dischargedEnergy = Math.round((this.dischargedEnergy + energyKwh) * 10000) / 10000;
      this.setCapabilityValue('meter_power.discharged', this.dischargedEnergy).catch(this.error);
    }
  }

  // ------------------------------------------------------- Lebenszyklus

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('ipAddress')) {
      this.client.destroy();
      this.client = new LalaClient({ host: newSettings.ipAddress });
      this.session.client = this.client;
      this.log('IP-Adresse geaendert, Verbindung neu aufgebaut');
    }
  }

  _stopTimers() {
    this._stopped = true;
    if (this.pollTimeout) this.homey.clearTimeout(this.pollTimeout);
    if (this.tickInterval) this.homey.clearInterval(this.tickInterval);
  }

  /** App wird beendet oder neu gestartet (Sicherung 6). */
  async onUninit() {
    this._stopTimers();
    await this.session.shutdown().catch(this.error);
    this.client.destroy();
  }

  /** Geraet wird geloescht (Sicherung 6). */
  async onDeleted() {
    this._stopTimers();
    await this.session.shutdown({ forget: true }).catch(this.error);
    this.client.destroy();
    this.homey.app.unregisterBattery(this);
  }

}

module.exports = SenecDevice;
