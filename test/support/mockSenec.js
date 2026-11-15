'use strict';

// Nachbau der SENEC lala.cgi fuer Tests (Node-Port des Python-Mocks aus HANDOFF.md, Abschnitt 9).
// Zusaetzlich: Ladestand steigt waehrend Force-Laden, Speicher kann Force-Laden selbst beenden,
// Zaehler fuer gleichzeitige Requests, kuenstliche Verzoegerung.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function fl(v) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v);
  return `fl_${b.toString('hex').toUpperCase()}`;
}

function u8(v) {
  return `u8_${v.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.tls=false]
 * @param {number} [opts.soc=42.5]
 * @param {number} [opts.socStepPerStatusRead=0] Ladestand-Zuwachs je Statusabfrage waehrend Force-Laden
 * @param {number} [opts.delayMs=0] Antwortverzoegerung
 * @param {boolean} [opts.hang=false] nie antworten (Timeout-Test)
 * @param {number} [opts.failNext=0] so viele Requests mit HTTP 500 beantworten
 */
async function startMockSenec(opts = {}) {
  const state = {
    soc: opts.soc ?? 42.5,
    safe: 0,
    statOverride: null,
    posts: [],
    inFlight: 0,
    maxInFlight: 0,
    failNext: opts.failNext ?? 0,
  };

  function energyValues() {
    const { safe } = state;
    return {
      STAT_STATE: u8(state.statOverride ?? (safe ? 8 : 21)),
      GUI_BAT_DATA_FUEL_CHARGE: fl(state.soc),
      GUI_BAT_DATA_POWER: fl(safe ? 2500.0 : -350.0),
      GUI_GRID_POW: fl(safe ? 2850.0 : 12.0),
      GUI_INVERTER_POWER: fl(0.0),
      GUI_HOUSE_POW: fl(362.0),
      SAFE_CHARGE_RUNNING: u8(safe),
      SAFE_CHARGE_FORCE: u8(0),
      SAFE_CHARGE_PROHIBIT: u8(0),
      LI_STORAGE_MODE_START: u8(0),
      LI_STORAGE_MODE_STOP: u8(0),
      LI_STORAGE_MODE_RUNNING: u8(0),
    };
  }

  const handler = (req, res) => {
    if (req.method === 'GET') {
      res.end(JSON.stringify({ safe: state.safe, posts: state.posts }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      if (opts.hang) return;

      setTimeout(() => {
        state.inFlight--;
        if (state.failNext > 0) {
          state.failNext--;
          res.writeHead(500);
          res.end('error');
          return;
        }
        const parsed = JSON.parse(body);
        state.posts.push({ headers: req.headers, raw: body, body: parsed });
        const e = parsed.ENERGY || {};
        if (e.SAFE_CHARGE_FORCE === 'u8_01') state.safe = 1;
        if (e.SAFE_CHARGE_PROHIBIT === 'u8_01') state.safe = 0;
        if ('GUI_BAT_DATA_FUEL_CHARGE' in e && state.safe && opts.socStepPerStatusRead) {
          state.soc = Math.min(100, state.soc + opts.socStepPerStatusRead);
        }
        const vals = energyValues();
        const out = { ENERGY: {} };
        for (const k of Object.keys(e)) out.ENERGY[k] = vals[k] ?? 'VARIABLE_NOT_FOUND';
        const json = JSON.stringify(out);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
        res.end(json);
      }, opts.delayMs ?? 0);
    });
  };

  const server = opts.tls
    ? https.createServer({
      key: fs.readFileSync(path.join(FIXTURES, 'key.pem')),
      cert: fs.readFileSync(path.join(FIXTURES, 'cert.pem')),
    }, handler)
    : http.createServer(handler);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    state,
    /** Speicher beendet Force-Laden von sich aus. */
    stopBySystem() { state.safe = 0; },
    /** Speicher startet eine eigene Sicherheitsladung (Status 25). */
    startBySystem() { state.safe = 1; state.statOverride = 25; },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startMockSenec, fl, u8 };
