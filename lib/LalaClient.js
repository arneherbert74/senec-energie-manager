'use strict';

/* eslint max-classes-per-file: ["error", 2] -- LalaError gehoert zum Client */

const http = require('http');
const https = require('https');

// Befehle exakt wie in HANDOFF.md, Abschnitt 5 (am Geraet getestet).
const CMD_READ_FORCE_STATE = '{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}';
const CMD_FORCE_START = '{"ENERGY":{"SAFE_CHARGE_FORCE":"u8_01","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}';
const CMD_RELEASE = '{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"u8_01","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}';
const CMD_READ_STATUS = '{"ENERGY":{"STAT_STATE":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_BAT_DATA_POWER":"","GUI_GRID_POW":"","GUI_INVERTER_POWER":"","GUI_HOUSE_POW":"","SAFE_CHARGE_RUNNING":""}}';

const INT_PREFIXES = new Set(['u1', 'u3', 'u6', 'u8', 'i1', 'i3', 'i8']);
const HEX = /^[0-9A-Fa-f]+$/;

/**
 * Dekodiert einen SENEC-Wert der Form "<typ>_<hex>".
 * Unbekannte oder ungueltige Werte (z.B. "VARIABLE_NOT_FOUND") bleiben unveraendert.
 */
function decodeValue(value) {
  if (typeof value !== 'string') return value;
  const idx = value.indexOf('_');
  if (idx === -1) return value;
  const prefix = value.slice(0, idx);
  const rest = value.slice(idx + 1);

  if (prefix === 'st') return rest;
  if (prefix === 'fl') {
    if (rest.length !== 8 || !HEX.test(rest)) return value;
    return Buffer.from(rest, 'hex').readFloatBE(0);
  }
  if (INT_PREFIXES.has(prefix)) {
    if (!HEX.test(rest)) return value;
    return parseInt(rest, 16);
  }
  return value;
}

function decodeTree(obj) {
  if (Array.isArray(obj)) return obj.map(decodeTree);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = decodeTree(v);
    return out;
  }
  return decodeValue(obj);
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

class LalaError extends Error {

  constructor(message, cause) {
    super(message);
    this.name = 'LalaError';
    this.cause = cause;
  }

}

/**
 * Transport zur lokalen lala.cgi des SENEC.
 * - HTTPS zuerst, HTTP als Rueckfall; das funktionierende Schema wird gemerkt
 * - eigener Agent ohne Zertifikatspruefung (nur fuer diesen Client)
 * - Requests werden serialisiert, nie parallel
 */
class LalaClient {

  /**
   * @param {object} opts
   * @param {string} opts.host IP oder Hostname des Speichers
   * @param {number} [opts.port] nur fuer Tests; sonst Standardport des Schemas
   * @param {number} [opts.timeoutMs=10000]
   * @param {string[]} [opts.schemes=['https','http']]
   */
  constructor({
    host, port, timeoutMs = 10000, schemes = ['https', 'http'],
  }) {
    if (!host) throw new Error('host fehlt');
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.schemes = schemes;
    this.scheme = null;
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    this._queue = Promise.resolve();
  }

  /** Sendet einen Request (Objekt oder roher JSON-String) und liefert die dekodierte Antwort. */
  post(payload) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const run = () => this._postNow(body);
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  async _postNow(body) {
    const schemes = this.scheme ? [this.scheme] : this.schemes;
    let lastError;
    for (const scheme of schemes) {
      try {
        const data = await this._request(scheme, body);
        this.scheme = scheme;
        return decodeTree(data);
      } catch (err) {
        lastError = err;
      }
    }
    throw new LalaError(`SENEC unter ${this.host} nicht erreichbar: ${lastError && lastError.message}`, lastError);
  }

  _request(scheme, body) {
    const lib = scheme === 'https' ? https : http;
    const hostHeader = this.port ? `${this.host}:${this.port}` : this.host;
    const base = `${scheme}://${hostHeader}`;
    const options = {
      hostname: this.host,
      port: this.port,
      path: '/lala.cgi',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: base,
        Referer: `${base}/`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    if (scheme === 'https') options.agent = this.httpsAgent;

    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Ungueltiges JSON: ${raw.slice(0, 80)}`));
          }
        });
        res.on('error', reject);
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`Timeout nach ${this.timeoutMs} ms`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  /** @returns {Promise<{force:number|null, prohibit:number|null, running:boolean}>} */
  async readForceState() {
    const e = (await this.post(CMD_READ_FORCE_STATE)).ENERGY || {};
    return {
      force: numberOrNull(e.SAFE_CHARGE_FORCE),
      prohibit: numberOrNull(e.SAFE_CHARGE_PROHIBIT),
      running: e.SAFE_CHARGE_RUNNING === 1,
    };
  }

  /** Messwerte; nicht lesbare Felder sind null. Vorzeichen siehe HANDOFF.md. */
  async readStatus() {
    const e = (await this.post(CMD_READ_STATUS)).ENERGY || {};
    return {
      statState: numberOrNull(e.STAT_STATE),
      soc: numberOrNull(e.GUI_BAT_DATA_FUEL_CHARGE),
      batteryPower: numberOrNull(e.GUI_BAT_DATA_POWER),
      gridPower: numberOrNull(e.GUI_GRID_POW),
      inverterPower: numberOrNull(e.GUI_INVERTER_POWER),
      housePower: numberOrNull(e.GUI_HOUSE_POW),
      forceRunning: e.SAFE_CHARGE_RUNNING === 1,
    };
  }

  /** Sendet den Startbefehl. Pruefung des Ist-Zustands macht der Aufrufer. */
  async startForceCharge() {
    await this.post(CMD_FORCE_START);
  }

  /** Sendet die Freigabe (zurueck in den Normalbetrieb). */
  async release() {
    await this.post(CMD_RELEASE);
  }

  destroy() {
    this.httpsAgent.destroy();
  }

}

module.exports = {
  LalaClient,
  LalaError,
  decodeValue,
  decodeTree,
  commands: {
    CMD_READ_FORCE_STATE, CMD_FORCE_START, CMD_RELEASE, CMD_READ_STATUS,
  },
};
