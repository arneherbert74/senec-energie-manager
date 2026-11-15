'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parsePoll, wallboxStateText, POLL_REQUEST } = require('../lib/senecData');
const { stateText } = require('../lib/senecStates');
const { statusKey, switchOn } = require('../lib/chargeText');
const { STATES } = require('../lib/ForceChargeSession');

describe('parsePoll', () => {
  // Werte wie am 15.11.2026 vom echten Speicher gelesen (bereits dekodiert)
  const live = {
    ENERGY: {
      STAT_STATE: 16,
      GUI_BAT_DATA_FUEL_CHARGE: 23.04,
      GUI_BAT_DATA_POWER: -1069.6,
      GUI_BAT_DATA_VOLTAGE: 51.66,
      GUI_BAT_DATA_CURRENT: -20.7,
      GUI_INVERTER_POWER: 0,
      GUI_HOUSE_POW: 1033.2,
      GUI_GRID_POW: -36.9,
      SAFE_CHARGE_RUNNING: 0,
    },
    WALLBOX: {
      APPARENT_CHARGING_POWER: [0, 0, 0, 0],
      STATE: [161, 0, 0, 0],
      EV_CONNECTED: [0, 0, 0, 0],
    },
    WIZARD: { SETUP_NUMBER_WALLBOXES: 1 },
  };

  test('echte Antwort', () => {
    assert.deepEqual(parsePoll(live), {
      statState: 16,
      soc: 23,
      batteryPower: -1070,
      batteryVoltage: 51.7,
      batteryCurrent: -20.7,
      pvPower: 0,
      housePower: 1033,
      gridPower: -37,
      forceRunning: false,
      wallbox: { power: 0, state: 161, connected: false },
    });
  });

  test('ohne Wallbox', () => {
    const r = parsePoll({ ...live, WIZARD: { SETUP_NUMBER_WALLBOXES: 0 } });
    assert.equal(r.wallbox, null);
  });

  test('unbekannte Felder werden null', () => {
    const r = parsePoll({ ENERGY: { GUI_BAT_DATA_FUEL_CHARGE: 50, GUI_GRID_POW: 'VARIABLE_NOT_FOUND' } });
    assert.equal(r.gridPower, null);
    assert.equal(r.forceRunning, false);
    assert.equal(r.wallbox, null);
  });

  test('ohne Ladestand ist die Antwort unbrauchbar', () => {
    assert.throws(() => parsePoll({ ENERGY: {} }), /Ladestand/);
    assert.throws(() => parsePoll(null), /Ladestand/);
  });

  test('Abfrage enthaelt die Felder fuer Sitzung und Wallbox', () => {
    assert.ok('SAFE_CHARGE_RUNNING' in POLL_REQUEST.ENERGY);
    assert.ok('GUI_BAT_DATA_FUEL_CHARGE' in POLL_REQUEST.ENERGY);
    assert.ok('APPARENT_CHARGING_POWER' in POLL_REQUEST.WALLBOX);
  });
});

describe('Texte', () => {
  test('Wallbox-Status', () => {
    assert.equal(wallboxStateText(161), 'Warte auf Fahrzeug');
    assert.equal(wallboxStateText(194, 'en'), 'Vehicle charging');
    assert.equal(wallboxStateText(999), 'Status 999');
    assert.equal(wallboxStateText(null), null);
  });

  test('Speicher-Status', () => {
    assert.equal(stateText(8), 'Man. Sicherheitsladung');
    assert.equal(stateText(21), 'Eigenverbrauch');
    assert.equal(stateText(500), 'Status 500');
  });

  test('Status der Netzladung', () => {
    assert.deepEqual(statusKey({ state: STATES.IDLE, foreignActive: false }), { key: 'status.idle', tokens: {} });
    assert.deepEqual(statusKey({ state: STATES.IDLE, foreignActive: true }), { key: 'status.foreign', tokens: {} });
    assert.deepEqual(
      statusKey({ state: STATES.ACTIVE, target: 80, remainingMs: 61000 }),
      { key: 'status.active', tokens: { target: 80, minutes: 2 } },
    );
    assert.equal(statusKey({ state: STATES.RELEASING, warning: 'x' }).key, 'status.releasing_retry');
  });

  test('Schalterstellung', () => {
    assert.equal(switchOn({ state: STATES.ACTIVE, active: true }), true);
    assert.equal(switchOn({ state: STATES.RELEASING, active: false }), false);
    assert.equal(switchOn({ state: STATES.IDLE, active: false, foreignActive: true }), true);
    assert.equal(switchOn({ state: STATES.IDLE, active: false, foreignActive: false }), false);
  });
});
