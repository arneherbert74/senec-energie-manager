'use strict';

/**
 * Messwerte des SENEC: eine Abfrage fuer alles, was Geraete, Widgets und
 * die Lade-Sitzung brauchen. Die Antwort kommt bereits dekodiert vom LalaClient.
 */

const POLL_REQUEST = {
  ENERGY: {
    STAT_STATE: '',
    GUI_BAT_DATA_FUEL_CHARGE: '',
    GUI_BAT_DATA_POWER: '',
    GUI_BAT_DATA_VOLTAGE: '',
    GUI_BAT_DATA_CURRENT: '',
    GUI_INVERTER_POWER: '',
    GUI_HOUSE_POW: '',
    GUI_GRID_POW: '',
    SAFE_CHARGE_RUNNING: '',
  },
  WALLBOX: {
    APPARENT_CHARGING_POWER: '',
    STATE: '',
    EV_CONNECTED: '',
  },
  WIZARD: {
    SETUP_NUMBER_WALLBOXES: '',
  },
};

// Quelle: marq24/ha-senec-v3, constants.py (WALLBOX_STATE_NAME)
const WALLBOX_STATES = {
  de: {
    161: 'Warte auf Fahrzeug',
    162: 'Warte auf Fahrzeug, Ladepunkt gesperrt',
    177: 'Fahrzeug fragt Ladung an',
    178: 'Fahrzeug kann geladen werden',
    193: 'Fahrzeug fragt Ladung an, Ladepunkt gesperrt',
    194: 'Fahrzeug lädt',
    195: 'Lädt mit verringertem Strom',
    196: 'Lädt mit verringertem Strom (Schieflast)',
    224: 'Wallbox deaktiviert',
    227: 'Warte auf Kommunikation mit dem Speicher',
  },
  en: {
    161: 'Waiting for vehicle',
    162: 'Waiting for vehicle, charge point locked',
    177: 'Vehicle requests charging',
    178: 'Vehicle can be charged',
    193: 'Vehicle requests charging, charge point locked',
    194: 'Vehicle charging',
    195: 'Charging with reduced current',
    196: 'Charging with reduced current (unbalanced load)',
    224: 'Wallbox deactivated',
    227: 'Waiting for communication with the battery',
  },
};

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function round(v, digits = 0) {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * @param {object} decoded dekodierte Antwort auf POLL_REQUEST
 * @returns {object} Messwerte; nicht lesbare Felder sind null
 */
function parsePoll(decoded) {
  const e = (decoded && decoded.ENERGY) || {};
  const w = (decoded && decoded.WALLBOX) || {};
  const wz = (decoded && decoded.WIZARD) || {};

  const wallboxCount = num(wz.SETUP_NUMBER_WALLBOXES) ?? 0;
  const wbPower = num(first(w.APPARENT_CHARGING_POWER));
  const wbState = num(first(w.STATE));
  const wbConnected = num(first(w.EV_CONNECTED));

  const status = {
    statState: num(e.STAT_STATE),
    soc: round(num(e.GUI_BAT_DATA_FUEL_CHARGE), 1),
    batteryPower: round(num(e.GUI_BAT_DATA_POWER)),
    batteryVoltage: round(num(e.GUI_BAT_DATA_VOLTAGE), 1),
    batteryCurrent: round(num(e.GUI_BAT_DATA_CURRENT), 2),
    pvPower: round(num(e.GUI_INVERTER_POWER)),
    housePower: round(num(e.GUI_HOUSE_POW)),
    gridPower: round(num(e.GUI_GRID_POW)),
    forceRunning: e.SAFE_CHARGE_RUNNING === 1,
    wallbox: wallboxCount > 0 ? {
      // APPARENT_CHARGING_POWER in W (laut ha-senec-v3); am Geraet mit ladendem Auto pruefen
      power: round(wbPower),
      state: wbState,
      connected: wbConnected === null ? null : wbConnected === 1,
    } : null,
  };

  if (status.soc === null) throw new Error('Ladestand nicht lesbar');
  return status;
}

function wallboxStateText(state, lang = 'de') {
  if (state === null || state === undefined) return null;
  const table = WALLBOX_STATES[lang] || WALLBOX_STATES.en;
  return table[state] || (lang === 'de' ? `Status ${state}` : `State ${state}`);
}

module.exports = {
  POLL_REQUEST, parsePoll, wallboxStateText,
};
