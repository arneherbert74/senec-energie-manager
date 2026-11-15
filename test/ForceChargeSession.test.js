'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  ForceChargeSession, STATES, REASONS, clampTarget, clampMinutes,
} = require('../lib/ForceChargeSession');
const { LalaClient } = require('../lib/LalaClient');
const { startMockSenec } = require('./support/mockSenec');

const MIN = 60000;

// ------------------------------------------------------------------ Helfer

function fakeClient(init = {}) {
  const c = {
    running: false,
    soc: 60,
    failRead: 0,
    failStart: 0,
    failRelease: 0,
    startLag: false, // Speicher meldet nach Start noch "nicht aktiv"
    calls: [],
    async readStatus() {
      c.calls.push('read');
      if (c.failRead > 0) {
        c.failRead--; throw new Error('read kaputt');
      }
      return { soc: c.soc, forceRunning: c.running, statState: c.running ? 8 : 21 };
    },
    async startForceCharge() {
      c.calls.push('start');
      if (c.failStart > 0) {
        c.failStart--; throw new Error('start kaputt');
      }
      if (!c.startLag) c.running = true;
    },
    async release() {
      c.calls.push('release');
      if (c.failRelease > 0) {
        c.failRelease--; throw new Error('release kaputt');
      }
      c.running = false;
    },
    count(name) {
      return c.calls.filter((x) => x === name).length;
    },
  };
  return Object.assign(c, init);
}

function memStore(initial = null) {
  return {
    value: initial ? JSON.parse(JSON.stringify(initial)) : null,
    async load() {
      return this.value ? JSON.parse(JSON.stringify(this.value)) : null;
    },
    async save(v) {
      this.value = v ? JSON.parse(JSON.stringify(v)) : null;
    },
  };
}

function setup({ client = fakeClient(), store = memStore(), t0 = 1_700_000_000_000 } = {}) {
  const clock = { t: t0 };
  const ended = [];
  const sleeps = [];
  const logs = [];
  const session = new ForceChargeSession({
    client,
    store,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push({ ms, snapshot: session.snapshot(), stored: store.value });
      clock.t += ms;
    },
    log: (m) => logs.push(m),
    onEnded: (e) => ended.push(e),
  });
  return {
    session, client, store, clock, ended, sleeps, logs,
  };
}

async function status(session, client) {
  await session.onStatus(await client.readStatus());
  await session.settled();
}

// ------------------------------------------------------------------ Tests

describe('Sicherung 1: Ladeziel und Zeitlimit immer begrenzt', () => {
  test('clampTarget', () => {
    assert.equal(clampTarget(30), 50);
    assert.equal(clampTarget(120), 100);
    assert.equal(clampTarget(79.6), 80);
    assert.equal(clampTarget('90'), 90);
    assert.equal(clampTarget(undefined), 80);
    assert.equal(clampTarget(null), 80);
    assert.equal(clampTarget('abc'), 80);
    assert.equal(clampTarget(NaN), 80);
  });

  test('clampMinutes mit harter Obergrenze 180', () => {
    assert.equal(clampMinutes(0), 1);
    assert.equal(clampMinutes(-5), 1);
    assert.equal(clampMinutes(500), 180);
    assert.equal(clampMinutes(Infinity), 120);
    assert.equal(clampMinutes(undefined), 120);
    assert.equal(clampMinutes(45), 45);
  });

  test('Start ohne Argumente: 80 % und 120 min', async () => {
    const { session, clock } = setup();
    const r = await session.start();
    assert.deepEqual(r, { started: true, target: 80, maxMinutes: 120 });
    assert.equal(session.snapshot().deadline, clock.t + 120 * MIN);
  });

  test('Flow uebergibt 1000 min -> Frist 180 min', async () => {
    const { session, clock } = setup();
    await session.start({ targetSoc: 100, maxMinutes: 1000 });
    assert.equal(session.snapshot().deadline, clock.t + 180 * MIN);
  });

  test('Anpassen einer laufenden Sitzung bleibt begrenzt', async () => {
    const { session, client, clock } = setup();
    await session.start({ targetSoc: 70, maxMinutes: 30 });
    clock.t += 100 * MIN;
    const r = await session.start({ targetSoc: 90, maxMinutes: 999 });
    assert.equal(r.updated, true);
    assert.equal(session.snapshot().deadline, clock.t + 180 * MIN);
    assert.equal(session.snapshot().target, 90);
    assert.equal(client.count('start'), 1, 'kein zweiter Startbefehl');
  });
});

describe('Sicherung 2: Freigabe bei Ladeziel', () => {
  test('Ladestand erreicht Ziel', async () => {
    const { session, client, ended } = setup();
    client.soc = 70;
    await session.start({ targetSoc: 80, maxMinutes: 60 });
    await status(session, client);
    assert.equal(client.count('release'), 0);

    client.soc = 80;
    await status(session, client);
    assert.equal(client.count('release'), 1);
    assert.equal(client.running, false);
    assert.equal(session.state, STATES.IDLE);
    assert.equal(ended.length, 1);
    assert.equal(ended[0].reason, REASONS.TARGET);
    assert.equal(ended[0].soc, 80);
  });

  test('Ziel schon erreicht -> kein Start', async () => {
    const { session, client } = setup();
    client.soc = 85;
    const r = await session.start({ targetSoc: 80 });
    assert.equal(r.started, false);
    assert.equal(r.reason, 'ziel_bereits_erreicht');
    assert.equal(client.count('start'), 0);
  });
});

describe('Sicherung 3: Freigabe bei Fristablauf', () => {
  test('ueber Poll', async () => {
    const {
      session, client, clock, ended,
    } = setup();
    await session.start({ targetSoc: 100, maxMinutes: 10 });
    clock.t += 9 * MIN;
    await status(session, client);
    assert.equal(client.count('release'), 0);
    clock.t += MIN;
    await status(session, client);
    assert.equal(client.count('release'), 1);
    assert.equal(ended[0].reason, REASONS.TIMEOUT);
    assert.equal(ended[0].durationMin, 10);
  });

  test('ueber tick(), auch wenn Polls scheitern', async () => {
    const {
      session, client, clock, ended,
    } = setup();
    await session.start({ targetSoc: 100, maxMinutes: 5 });
    clock.t += 5 * MIN;
    client.failRead = 100; // Status nicht lesbar
    await session.tick();
    await session.settled();
    assert.equal(client.count('release'), 1, 'Freigabe trotz unlesbarem Status gesendet');
    assert.equal(ended[0].reason, REASONS.TIMEOUT);
  });
});

describe('Sicherung 4: Sitzung ueberlebt Neustart', () => {
  async function storedSession(minutes = 60, target = 80) {
    const a = setup();
    a.client.soc = 50;
    await a.session.start({ targetSoc: target, maxMinutes: minutes });
    return a;
  }

  test('Sitzung wird gespeichert', async () => {
    const { store, clock } = await storedSession(60, 80);
    assert.equal(store.value.state, STATES.ACTIVE);
    assert.equal(store.value.target, 80);
    assert.equal(store.value.deadline, clock.t + 60 * MIN);
  });

  test('Frist abgelaufen -> Freigabe mit app_neustart', async () => {
    const a = await storedSession(60);
    const b = setup({ client: a.client, store: a.store, t0: a.clock.t + 61 * MIN });
    await b.session.init(await b.client.readStatus());
    await b.session.settled();
    assert.equal(b.client.count('release'), 1);
    assert.equal(b.ended[0].reason, REASONS.RESTART);
    assert.equal(b.store.value, null);
  });

  test('Ziel erreicht -> Freigabe mit app_neustart', async () => {
    const a = await storedSession(60, 80);
    a.client.soc = 81;
    const b = setup({ client: a.client, store: a.store, t0: a.clock.t + 5 * MIN });
    await b.session.init(await b.client.readStatus());
    await b.session.settled();
    assert.equal(b.ended[0].reason, REASONS.RESTART);
    assert.equal(b.client.running, false);
  });

  test('noch gueltig -> wird fortgesetzt, nichts gesendet', async () => {
    const a = await storedSession(60, 80);
    const before = a.client.calls.length;
    const b = setup({ client: a.client, store: a.store, t0: a.clock.t + 5 * MIN });
    await b.session.init(await b.client.readStatus());
    assert.equal(b.session.state, STATES.ACTIVE);
    assert.deepEqual(a.client.calls.slice(before).filter((c) => c !== 'read'), []);
    // Frist laeuft vom urspruenglichen Start, nicht vom Neustart
    b.clock.t = a.clock.t + 60 * MIN;
    await b.session.tick();
    await b.session.settled();
    assert.equal(b.ended[0].reason, REASONS.TIMEOUT);
  });

  test('Status beim Neustart nicht lesbar -> Frist greift trotzdem', async () => {
    const a = await storedSession(60);
    const b = setup({ client: a.client, store: a.store, t0: a.clock.t + 61 * MIN });
    await b.session.init(null);
    await b.session.settled();
    assert.equal(b.client.count('release'), 1);
    assert.equal(b.ended[0].reason, REASONS.RESTART);
  });

  test('abgebrochene Freigabe wird nach Neustart fortgesetzt', async () => {
    const a = await storedSession(60);
    a.client.failRelease = 1000;
    a.clock.t += 61 * MIN;
    // Nach dem ersten Fehlversuch "abstuerzen"
    a.session.sleep = async () => {
      a.session.stopped = true;
    };
    await a.session.tick();
    await a.session.settled();
    assert.equal(a.client.count('release'), 1);
    assert.equal(a.store.value.state, STATES.RELEASING);

    a.client.failRelease = 0;
    const b = setup({ client: a.client, store: a.store, t0: a.clock.t });
    await b.session.init(await b.client.readStatus());
    await b.session.settled();
    assert.equal(b.client.running, false);
    assert.equal(b.ended[0].reason, REASONS.TIMEOUT, 'urspruenglicher Grund bleibt erhalten');
    assert.equal(b.store.value, null);
  });

  test('Absturz zwischen Speichern und Startbefehl wird aufgeraeumt', async () => {
    const store = memStore({
      state: STATES.STARTING, startedAt: 0, deadline: 10 * MIN, target: 80, startCmdAt: 0, releaseReason: null,
    });
    const client = fakeClient({ running: true });
    const b = setup({ client, store, t0: 20 * MIN });
    await b.session.init(await client.readStatus());
    await b.session.settled();
    assert.equal(client.running, false);
    assert.equal(b.ended[0].reason, REASONS.RESTART);
  });
});

describe('Sicherung 5: nur eigene Sitzungen schalten', () => {
  test('fremdes Force-Laden beim App-Start wird nicht angefasst', async () => {
    const client = fakeClient({ running: true });
    const { session, logs } = setup({ client });
    await session.init(await client.readStatus());
    assert.equal(session.snapshot().foreignActive, true);
    assert.equal(client.count('release'), 0);
    assert.ok(logs.some((l) => /ohne eigene Sitzung/.test(l)));
  });

  test('fremdes Force-Laden waehrend des Betriebs wird nur angezeigt', async () => {
    const { session, client, clock } = setup();
    await session.init(await client.readStatus());
    client.running = true; // Speicher startet selbst (Status 25)
    for (let i = 0; i < 5; i++) {
      clock.t += 200 * MIN;
      await status(session, client);
      await session.tick();
    }
    assert.equal(session.snapshot().foreignActive, true);
    assert.equal(client.count('release'), 0);
  });
});

describe('Sicherung 6: Freigabe beim Beenden', () => {
  test('eigene Sitzung wird freigegeben', async () => {
    const { session, client, store } = setup();
    await session.start({ targetSoc: 90 });
    await session.shutdown();
    assert.equal(client.count('release'), 1);
    assert.equal(client.running, false);
    assert.equal(store.value, null);
  });

  test('Freigabe schlaegt fehl -> Sitzung bleibt gespeichert', async () => {
    const { session, client, store } = setup();
    await session.start({ targetSoc: 90 });
    client.failRelease = 1;
    await session.shutdown();
    assert.notEqual(store.value, null, 'init() gibt nach dem Neustart frei');
  });

  test('fremdes Force-Laden wird beim Beenden nicht angefasst', async () => {
    const client = fakeClient({ running: true });
    const { session } = setup({ client });
    await session.init(await client.readStatus());
    await session.shutdown();
    assert.equal(client.count('release'), 0);
  });

  test('nach dem Beenden keine Aktionen mehr', async () => {
    const { session, client } = setup();
    await session.shutdown();
    await assert.rejects(session.start(), /beendet/);
    await session.onStatus(await client.readStatus());
    assert.equal(client.count('start'), 0);
  });
});

describe('Sicherung 7: Speicher beendet selbst', () => {
  test('innerhalb der Karenz kein Ende, danach vom_speicher_beendet, kein Neustart', async () => {
    const client = fakeClient({ startLag: true });
    const { session, clock, ended } = setup({ client });
    await session.start({ targetSoc: 90 });
    clock.t += 10000;
    await status(session, client);
    assert.equal(session.state, STATES.ACTIVE, 'Karenz laeuft noch');

    clock.t += 6000;
    await status(session, client);
    assert.equal(session.state, STATES.IDLE);
    assert.equal(ended[0].reason, REASONS.BY_STORAGE);
    assert.equal(client.count('release'), 0, 'nichts gesendet');
    assert.equal(client.count('start'), 1, 'nicht neu gestartet');
  });

  test('Speicher beendet mitten in der Sitzung', async () => {
    const {
      session, client, clock, ended,
    } = setup();
    await session.start({ targetSoc: 90 });
    clock.t += 5 * MIN;
    await status(session, client);
    client.running = false;
    clock.t += 3000;
    await status(session, client);
    assert.equal(ended[0].reason, REASONS.BY_STORAGE);
  });
});

describe('Sicherung 8: Freigabe wird wiederholt, bis sie durchgeht', () => {
  test('Backoff, Warnung, Zustand RELEASING gespeichert', async () => {
    const {
      session, client, clock, ended, sleeps,
    } = setup();
    await session.start({ targetSoc: 100, maxMinutes: 1 });
    client.failRelease = 7;
    clock.t += MIN;
    await session.tick();
    await session.settled();

    assert.deepEqual(sleeps.map((s) => s.ms), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    assert.ok(sleeps.every((s) => s.snapshot.state === STATES.RELEASING));
    assert.ok(sleeps.every((s) => s.stored.state === STATES.RELEASING));
    assert.match(sleeps[2].snapshot.warning, /Freigabe fehlgeschlagen \(3x\)/);
    assert.equal(client.count('release'), 8);
    assert.equal(ended.length, 1);
    assert.equal(ended[0].reason, REASONS.TIMEOUT);
    assert.equal(session.snapshot().warning, null);
  });

  test('waehrend der Freigabe kein neuer Start', async () => {
    const { session, client, clock } = setup();
    await session.start({ targetSoc: 100, maxMinutes: 1 });
    client.failRelease = 1000;
    clock.t += MIN;
    await session.tick();
    const r = await session.start({ targetSoc: 90 });
    assert.equal(r.started, false);
    assert.equal(r.reason, 'wird_freigegeben');
    session.stopped = true;
    await session.settled();
  });
});

describe('Sicherung 9: Ist-Zustand vor dem Start pruefen', () => {
  test('laeuft bereits -> nichts senden', async () => {
    const client = fakeClient({ running: true });
    const { session } = setup({ client });
    const r = await session.start({ targetSoc: 90 });
    assert.equal(r.started, false);
    assert.equal(r.reason, 'bereits_aktiv');
    assert.equal(client.count('start'), 0);
    assert.equal(session.state, STATES.IDLE);
  });

  test('Status nicht lesbar -> Start scheitert, nichts gesendet', async () => {
    const client = fakeClient({ failRead: 1 });
    const { session, store } = setup({ client });
    await assert.rejects(session.start(), /read kaputt/);
    assert.equal(client.count('start'), 0);
    assert.equal(store.value, null);
  });
});

describe('Sicherung 10: Fehler gehen nicht verloren', () => {
  test('Startbefehl scheitert -> Fehler an den Aufrufer und sicherheitshalber Freigabe', async () => {
    const client = fakeClient({ failStart: 1 });
    const { session, ended } = setup({ client });
    await assert.rejects(session.start({ targetSoc: 90 }), /start kaputt/);
    await session.settled();
    assert.equal(client.count('release'), 1);
    assert.equal(ended[0].reason, REASONS.ERROR);
    assert.equal(session.state, STATES.IDLE);
  });
});

describe('Manuelle Freigabe', () => {
  test('eigene Sitzung -> manuell', async () => {
    const { session, client, ended } = setup();
    await session.start({ targetSoc: 90 });
    assert.deepEqual(await session.release(), { released: true });
    assert.equal(client.running, false);
    assert.equal(ended[0].reason, REASONS.MANUAL);
  });

  test('nichts aktiv -> nichts senden', async () => {
    const { session, client } = setup();
    assert.deepEqual(await session.release(), { released: false, reason: 'keine_eigene_sitzung' });
    assert.equal(client.count('release'), 0);
  });

  test('vom Speicher gestartete Ladung wird auch auf Wunsch nicht beendet', async () => {
    const client = fakeClient({ running: true });
    const { session, ended } = setup({ client });
    await session.init(await client.readStatus());
    assert.deepEqual(await session.release(), { released: false, reason: 'fremde_ladung' });
    assert.equal(client.count('release'), 0);
    assert.equal(client.running, true);
    assert.equal(ended.length, 0);
  });

  test('Freigabe kurz nach Start wird immer gesendet, auch wenn der Speicher noch nicht aktiv meldet', async () => {
    const client = fakeClient({ startLag: true });
    const { session } = setup({ client });
    await session.start({ targetSoc: 90 });
    await session.release();
    assert.equal(client.count('release'), 1);
  });
});

describe('Integration mit Mock-SENEC', () => {
  test('Start, Ladestand steigt, Freigabe bei Ziel', async (t) => {
    const mock = await startMockSenec({ tls: true, soc: 76, socStepPerStatusRead: 1 });
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port });
    const store = memStore();
    const ended = [];
    const session = new ForceChargeSession({ client, store, onEnded: (e) => ended.push(e) });
    t.after(async () => {
      client.destroy(); await mock.close();
    });

    await session.init(await client.readStatus());
    const r = await session.start({ targetSoc: 80, maxMinutes: 5 });
    assert.equal(r.started, true);
    assert.equal(mock.state.safe, 1);

    for (let i = 0; i < 10 && ended.length === 0; i++) {
      await session.onStatus(await client.readStatus());
      await session.settled();
    }
    assert.equal(ended[0].reason, REASONS.TARGET);
    assert.equal(mock.state.safe, 0);
    const bodies = mock.state.posts.map((p) => p.body.ENERGY);
    assert.equal(bodies.filter((e) => e.SAFE_CHARGE_FORCE === 'u8_01').length, 1);
    assert.equal(bodies.filter((e) => e.SAFE_CHARGE_PROHIBIT === 'u8_01').length, 1);
  });

  test('vom Speicher gestartete Sicherheitsladung wird nicht freigegeben', async (t) => {
    const mock = await startMockSenec({ tls: false });
    mock.startBySystem();
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port, schemes: ['http'] });
    const session = new ForceChargeSession({ client, store: memStore() });
    t.after(async () => {
      client.destroy(); await mock.close();
    });

    await session.init(await client.readStatus());
    for (let i = 0; i < 3; i++) await session.onStatus(await client.readStatus());
    await session.tick();
    await session.shutdown();
    assert.equal(mock.state.safe, 1);
    assert.ok(mock.state.posts.every((p) => !p.body.ENERGY.SAFE_CHARGE_PROHIBIT));
  });
});
