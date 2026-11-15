'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const {
  LalaClient, LalaError, decodeValue, decodeTree, commands,
} = require('../lib/LalaClient');
const { startMockSenec, fl } = require('./support/mockSenec');

describe('decodeValue', () => {
  test('Float, Big Endian', () => {
    assert.equal(decodeValue('fl_42280000'), 42);
    assert.equal(decodeValue('fl_C3AF0000'), -350);
    assert.equal(decodeValue(fl(2850)), 2850);
    assert.ok(Math.abs(decodeValue('fl_43E26188') - 452.762) < 0.001);
  });

  test('Ganzzahlen', () => {
    assert.equal(decodeValue('u8_01'), 1);
    assert.equal(decodeValue('u8_15'), 21);
    assert.equal(decodeValue('u3_0000000A'), 10);
    assert.equal(decodeValue('u1_00FF'), 255);
    assert.equal(decodeValue('i3_00000010'), 16);
  });

  test('String: nur am ersten Unterstrich trennen', () => {
    assert.equal(decodeValue('st_abc'), 'abc');
    assert.equal(decodeValue('st_a_b_c'), 'a_b_c');
  });

  test('unkodierte und ungueltige Werte bleiben unveraendert', () => {
    assert.equal(decodeValue('VARIABLE_NOT_FOUND'), 'VARIABLE_NOT_FOUND');
    assert.equal(decodeValue('abc'), 'abc');
    assert.equal(decodeValue('fl_ZZZZZZZZ'), 'fl_ZZZZZZZZ');
    assert.equal(decodeValue('fl_4228'), 'fl_4228');
    assert.equal(decodeValue('u8_'), 'u8_');
    assert.equal(decodeValue('xx_01'), 'xx_01');
    assert.equal(decodeValue(''), '');
    assert.equal(decodeValue(5), 5);
    assert.equal(decodeValue(null), null);
  });

  test('decodeTree dekodiert verschachtelt', () => {
    assert.deepEqual(
      decodeTree({ ENERGY: { A: 'u8_01', B: ['fl_42280000', 'st_x'] }, C: 'VARIABLE_NOT_FOUND' }),
      { ENERGY: { A: 1, B: [42, 'x'] }, C: 'VARIABLE_NOT_FOUND' },
    );
  });
});

describe('Befehle', () => {
  test('exakt wie in HANDOFF.md', () => {
    assert.deepEqual(JSON.parse(commands.CMD_FORCE_START).ENERGY, {
      SAFE_CHARGE_FORCE: 'u8_01',
      SAFE_CHARGE_PROHIBIT: '',
      SAFE_CHARGE_RUNNING: '',
      LI_STORAGE_MODE_START: '',
      LI_STORAGE_MODE_STOP: '',
      LI_STORAGE_MODE_RUNNING: '',
    });
    assert.deepEqual(JSON.parse(commands.CMD_RELEASE).ENERGY, {
      SAFE_CHARGE_FORCE: '',
      SAFE_CHARGE_PROHIBIT: 'u8_01',
      SAFE_CHARGE_RUNNING: '',
      LI_STORAGE_MODE_START: '',
      LI_STORAGE_MODE_STOP: '',
      LI_STORAGE_MODE_RUNNING: '',
    });
  });
});

describe('LalaClient gegen Mock', () => {
  test('HTTPS mit selbstsigniertem Zertifikat', async (t) => {
    const mock = await startMockSenec({ tls: true });
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port });
    t.after(async () => { client.destroy(); await mock.close(); });

    const s = await client.readStatus();
    assert.equal(client.scheme, 'https');
    assert.equal(s.statState, 21);
    assert.equal(s.soc, 42.5);
    assert.equal(s.batteryPower, -350);
    assert.equal(s.gridPower, 12);
    assert.equal(s.forceRunning, false);
  });

  test('HTTP als Rueckfall, Schema wird gemerkt', async (t) => {
    const mock = await startMockSenec({ tls: false });
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port });
    t.after(async () => { client.destroy(); await mock.close(); });

    await client.readForceState();
    assert.equal(client.scheme, 'http');
    await client.readForceState();
    assert.equal(mock.state.posts.length, 2);
  });

  test('Header und Body wie am Geraet getestet', async (t) => {
    const mock = await startMockSenec({ tls: true });
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port });
    t.after(async () => { client.destroy(); await mock.close(); });

    await client.startForceCharge();
    const [post] = mock.state.posts;
    assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8');
    assert.equal(post.headers.accept, 'application/json, text/javascript, */*; q=0.01');
    assert.equal(post.headers['x-requested-with'], 'XMLHttpRequest');
    assert.equal(post.headers.origin, `https://127.0.0.1:${mock.port}`);
    assert.equal(post.headers.referer, `https://127.0.0.1:${mock.port}/`);
    assert.equal(post.raw, commands.CMD_FORCE_START, 'roher JSON-String, nicht URL-kodiert');
  });

  test('Start und Freigabe schalten den Zustand', async (t) => {
    const mock = await startMockSenec({ tls: true });
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port });
    t.after(async () => { client.destroy(); await mock.close(); });

    await client.startForceCharge();
    assert.equal((await client.readForceState()).running, true);
    const s = await client.readStatus();
    assert.equal(s.statState, 8);
    assert.equal(s.batteryPower, 2500);
    await client.release();
    assert.equal((await client.readForceState()).running, false);
  });

  test('Requests werden serialisiert', async (t) => {
    const mock = await startMockSenec({ tls: false, delayMs: 30 });
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port, schemes: ['http'] });
    t.after(async () => { client.destroy(); await mock.close(); });

    await Promise.all([
      client.readStatus(), client.readForceState(), client.startForceCharge(), client.readStatus(),
    ]);
    assert.equal(mock.state.posts.length, 4);
    assert.equal(mock.state.maxInFlight, 1);
    assert.equal(mock.state.posts[2].raw, commands.CMD_FORCE_START, 'Reihenfolge bleibt erhalten');
  });

  test('ein Fehler blockiert die Warteschlange nicht', async (t) => {
    const mock = await startMockSenec({ tls: false, failNext: 1 });
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port, schemes: ['http'] });
    t.after(async () => { client.destroy(); await mock.close(); });

    const [first, second] = await Promise.allSettled([client.readStatus(), client.readStatus()]);
    assert.equal(first.status, 'rejected');
    assert.ok(first.reason instanceof LalaError);
    assert.match(first.reason.message, /HTTP 500/);
    assert.equal(second.status, 'fulfilled');
  });

  test('Timeout', async (t) => {
    const mock = await startMockSenec({ tls: false, hang: true });
    const client = new LalaClient({
      host: '127.0.0.1', port: mock.port, schemes: ['http'], timeoutMs: 150,
    });
    t.after(async () => { client.destroy(); await mock.close(); });

    await assert.rejects(client.readStatus(), /Timeout nach 150 ms/);
  });

  test('nicht erreichbar -> LalaError', async () => {
    const port = await freePort();
    const client = new LalaClient({ host: '127.0.0.1', port, timeoutMs: 500 });
    await assert.rejects(client.readStatus(), (err) => err instanceof LalaError && /nicht erreichbar/.test(err.message));
    assert.equal(client.scheme, null);
    client.destroy();
  });

  test('unbekannte Felder kommen als VARIABLE_NOT_FOUND zurueck', async (t) => {
    const mock = await startMockSenec({ tls: false });
    const client = new LalaClient({ host: '127.0.0.1', port: mock.port, schemes: ['http'] });
    t.after(async () => { client.destroy(); await mock.close(); });

    const res = await client.post({ ENERGY: { GIBT_ES_NICHT: '' } });
    assert.equal(res.ENERGY.GIBT_ES_NICHT, 'VARIABLE_NOT_FOUND');
  });
});

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
