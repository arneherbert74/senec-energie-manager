'use strict';

/* eslint max-classes-per-file: ["error", 2] -- Device und leerer Driver */

// Minimaler Nachbau der Homey-SDK-Teile, die das Speicher-Geraet nutzt.
// Ersetzt require('homey'), damit device.js ohne Homey testbar ist.

const EventEmitter = require('events');
const Module = require('module');
const path = require('path');

const de = require('../../locales/de.json');

function translate(key, tokens = {}) {
  const value = key.split('.').reduce((o, k) => (o ? o[k] : undefined), de);
  if (typeof value !== 'string') return key;
  return value.replace(/__(\w+)__/g, (_, k) => (k in tokens ? String(tokens[k]) : `__${k}__`));
}

class Device {

  constructor({ settings = {}, store = {}, homey }) {
    this._settings = { ...settings };
    this._store = { ...store };
    this._caps = {};
    this._capList = new Set(['onoff', 'measure_battery', 'measure_current', 'measure_voltage']);
    this._listeners = {};
    this._available = true;
    this.warnings = [];
    this.homey = homey;
    this.logs = [];
  }

  log(...a) {
    this.logs.push(a.join(' '));
  }

  error(...a) {
    this.logs.push(`ERR ${a.join(' ')}`);
  }

  getSetting(k) {
    return this._settings[k];
  }

  getStoreValue(k) {
    return this._store[k];
  }

  async setStoreValue(k, v) {
    this._store[k] = v;
  }

  hasCapability(c) {
    return this._capList.has(c);
  }

  async addCapability(c) {
    this._capList.add(c);
  }

  getCapabilityValue(c) {
    return this._caps[c] ?? null;
  }

  async setCapabilityValue(c, v) {
    this._caps[c] = v;
  }

  registerCapabilityListener(c, fn) {
    this._listeners[c] = fn;
  }

  /** Wie die Homey-App: Listener aufrufen, bei Fehler den alten Wert behalten. */
  async userSet(c, v) {
    await this._listeners[c](v);
    this._caps[c] = v;
  }

  getAvailable() {
    return this._available;
  }

  async setAvailable() {
    this._available = true;
  }

  async setUnavailable() {
    this._available = false;
  }

  async setWarning(w) {
    this.warnings.push(w);
  }

  async unsetWarning() {
    this.warnings.push(null);
  }

}

function createHomey() {
  const app = new EventEmitter();
  app.batteries = new Set();
  app.registerBattery = (d) => app.batteries.add(d);
  app.unregisterBattery = (d) => app.batteries.delete(d);

  const triggers = [];
  const sent = [];
  const timers = new Set();
  return {
    app,
    triggers,
    sent,
    __: translate,
    // Polling und Tick ruft der Test selbst auf; lange Timer feuern nie.
    setTimeout(fn, ms) {
      if (ms >= 3000) return { never: true };
      const t = setTimeout(fn, ms);
      timers.add(t);
      return t;
    },
    clearTimeout(t) {
      if (!t.never) clearTimeout(t);
    },
    setInterval() {
      return { never: true };
    },
    clearInterval() {},
    flow: {
      getDeviceTriggerCard: (id) => ({
        trigger: async (device, tokens) => {
          triggers.push({ id, tokens });
        },
      }),
    },
    notifications: {
      createNotification: async ({ excerpt }) => {
        sent.push(excerpt);
      },
    },
  };
}

let installed = false;
function installHomeyStub() {
  if (installed) return;
  installed = true;
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') return { Device, App: EventEmitter, Driver: class {} };
    return original.call(this, request, parent, isMain);
  };
}

function loadDevice() {
  installHomeyStub();
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(__dirname, '..', '..', 'drivers', 'senec-battery', 'device.js'));
}

module.exports = { createHomey, loadDevice, translate };
