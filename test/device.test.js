'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createHomey, loadDevice } = require('./support/fakeHomey');
const { startMockSenec } = require('./support/mockSenec');

const SenecDevice = loadDevice();

async function setup(t, mockOpts = {}, settings = {}) {
  const mock = await startMockSenec({ tls: false, ...mockOpts });
  const homey = createHomey();
  const device = new SenecDevice({
    homey,
    settings: {
      ipAddress: `127.0.0.1:${mock.port}`,
      default_target: 80,
      default_minutes: 120,
      notify_start: true,
      notify_end: true,
      ...settings,
    },
  });
  await device.onInit();
  await device.ready;
  t.after(async () => {
    await device.onUninit();
    await mock.close();
  });
  return { mock, homey, device };
}

async function pollUntil(device, cond, max = 30) {
  for (let i = 0; i < max && !cond(); i++) {
    await device.pollBatteryStatus();
    await device.session.settled();
  }
}

describe('Speicher-Geraet mit Mock-SENEC', () => {
  test('Messwerte landen in den Capabilities und im Dashboard', async (t) => {
    const { device, homey } = await setup(t, { soc: 42.5 });
    const seen = [];
    homey.app.on('senec-data', (d) => seen.push(d));
    await device.pollBatteryStatus();

    assert.equal(device.getCapabilityValue('measure_battery'), 42.5);
    assert.equal(device.getCapabilityValue('measure_power'), -350);
    assert.equal(device.getCapabilityValue('force_charge_status'), 'Bereit');
    assert.equal(device.getCapabilityValue('onoff'), false);
    assert.equal(seen[0].gridPower, 12);
    const dash = device.getDashboardState();
    assert.equal(dash.live.soc, 42.5);
    assert.equal(dash.charge.defaultTarget, 80);
    assert.equal(homey.app.batteries.has(device), true);
  });

  test('Schalter an: laedt mit Standardwerten bis zum Ziel, dann Freigabe, Flow und Benachrichtigungen', async (t) => {
    const { device, homey, mock } = await setup(t, { soc: 76, socStepPerStatusRead: 1 }, { default_target: 80 });

    await device.userSet('onoff', true);
    assert.equal(mock.state.safe, 1);
    assert.match(device.getCapabilityValue('force_charge_status'), /^Lädt bis 80 %/);
    assert.match(homey.sent[0], /Netzladung gestartet \(Schalter\): bis 80 %, höchstens 120 min/);
    assert.equal(device.getStoreValue('lastStart').source, 'switch');

    await pollUntil(device, () => homey.triggers.length > 0);
    assert.equal(mock.state.safe, 0);
    assert.equal(homey.triggers[0].id, 'force_charge_ended');
    assert.equal(homey.triggers[0].tokens.reason, 'ziel_erreicht');
    assert.equal(homey.triggers[0].tokens.reason_text, 'Ziel erreicht');
    assert.ok(homey.triggers[0].tokens.soc >= 80);
    assert.match(homey.sent[1], /Netzladung beendet: Ziel erreicht/);
    assert.equal(device.getCapabilityValue('onoff'), false);
    assert.equal(device.getStoreValue('lastEnded').reason, 'ziel_erreicht');
  });

  test('Schalter aus gibt die eigene Ladung frei', async (t) => {
    const { device, homey, mock } = await setup(t);
    await device.userSet('onoff', true);
    await device.userSet('onoff', false);
    assert.equal(mock.state.safe, 0);
    assert.equal(homey.triggers[0].tokens.reason, 'manuell');
  });

  test('Benachrichtigungen lassen sich abschalten', async (t) => {
    const { device, homey } = await setup(t, {}, { notify_start: false, notify_end: false });
    await device.userSet('onoff', true);
    await device.userSet('onoff', false);
    assert.deepEqual(homey.sent, []);
    assert.equal(homey.triggers.length, 1, 'Flow-Ausloeser kommt trotzdem');
  });

  test('Ladung des Speichers selbst: Schalter zeigt sie, Aus wird abgelehnt', async (t) => {
    const { device, mock } = await setup(t);
    mock.startBySystem();
    await device.pollBatteryStatus();
    assert.equal(device.getCapabilityValue('onoff'), true);
    assert.equal(device.getCapabilityValue('force_charge_status'), 'SENEC lädt selbst');

    await assert.rejects(device.userSet('onoff', false), /lädt gerade selbst/);
    assert.equal(mock.state.safe, 1, 'nichts gesendet');
    await assert.rejects(device.userSet('onoff', true), /lädt bereits/);
  });

  test('Flow-Start mit eigenen Werten und harter Obergrenze', async (t) => {
    const { device, homey } = await setup(t, { soc: 50 });
    const r = await device.startCharge({ targetSoc: 95, maxMinutes: 999 }, 'flow');
    assert.equal(r.started, true);
    assert.equal(r.maxMinutes, 180);
    assert.match(homey.sent[0], /\(Flow\): bis 95 %, höchstens 180 min/);
    assert.equal(device.isChargeActive(), true);
  });

  test('App-Neustart waehrend einer Ladung: Sitzung wird fortgesetzt', async (t) => {
    const { device, mock, homey } = await setup(t);
    await device.userSet('onoff', true);
    const stored = device.getStoreValue('forceChargeSession');
    assert.equal(stored.state, 'ACTIVE');

    // "Neustart": neues Geraet mit demselben Store, ohne Freigabe beim Beenden
    device._stopTimers();
    const device2 = new SenecDevice({
      homey,
      settings: { ipAddress: `127.0.0.1:${mock.port}`, default_target: 80, default_minutes: 120 },
      store: { forceChargeSession: stored },
    });
    await device2.onInit();
    await device2.ready;
    t.after(() => device2.onUninit());
    assert.equal(device2.isChargeActive(), true);
    assert.equal(mock.state.safe, 1);
  });

  test('Beenden der App gibt die eigene Ladung frei', async (t) => {
    const { device, mock } = await setup(t);
    await device.userSet('onoff', true);
    await device.onUninit();
    assert.equal(mock.state.safe, 0);
  });

  test('Speicher nicht erreichbar: nach 3 Fehlversuchen nicht verfuegbar', async (t) => {
    const { device, mock } = await setup(t);
    await mock.close();
    for (let i = 0; i < 3; i++) await device.pollBatteryStatus();
    assert.equal(device.getAvailable(), false);
  });
});
