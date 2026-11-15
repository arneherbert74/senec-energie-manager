'use strict';

/**
 * Zustandsautomat fuer eine Force-Lade-Sitzung (HANDOFF.md, Abschnitt 7).
 *
 *   IDLE -> STARTING -> ACTIVE -> RELEASING -> IDLE
 *
 * Die Sitzung schaltet nur, was sie selbst gestartet hat. Sie wird von aussen
 * getrieben: onStatus() bei jedem erfolgreichen Poll, tick() regelmaessig
 * (auch wenn der Speicher nicht erreichbar ist), damit die Frist immer greift.
 *
 * Abhaengigkeiten sind injizierbar (Uhr, Schlafen, Client, Speicher), damit
 * jede Sicherung ohne echte Zeit und ohne Geraet testbar ist.
 */

const STATES = Object.freeze({
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  ACTIVE: 'ACTIVE',
  RELEASING: 'RELEASING',
});

const REASONS = Object.freeze({
  TARGET: 'ziel_erreicht',
  TIMEOUT: 'zeit_abgelaufen',
  MANUAL: 'manuell',
  BY_STORAGE: 'vom_speicher_beendet',
  RESTART: 'app_neustart',
  ERROR: 'fehler',
});

const LIMITS = Object.freeze({
  TARGET_MIN: 50,
  TARGET_MAX: 100,
  TARGET_DEFAULT: 80,
  MINUTES_MIN: 1,
  MINUTES_MAX: 180, // harte Obergrenze, egal was der Flow uebergibt
  MINUTES_DEFAULT: 120,
});

const DEFAULTS = Object.freeze({
  graceMs: 15000, // Karenz nach Start, bevor "nicht aktiv" als Ende gilt
  retryBaseMs: 2000,
  retryMaxMs: 60000,
});

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampTarget(v) {
  return clamp(v, LIMITS.TARGET_MIN, LIMITS.TARGET_MAX, LIMITS.TARGET_DEFAULT);
}

function clampMinutes(v) {
  return clamp(v, LIMITS.MINUTES_MIN, LIMITS.MINUTES_MAX, LIMITS.MINUTES_DEFAULT);
}

class ForceChargeSession {

  /**
   * @param {object} deps
   * @param {{readStatus:Function, startForceCharge:Function, release:Function}} deps.client
   * @param {{load:Function, save:Function}} deps.store persistenter Speicher (Device-Store)
   * @param {Function} [deps.now] liefert ms seit Epoch
   * @param {Function} [deps.sleep] (ms) => Promise
   * @param {Function} [deps.log]
   * @param {Function} [deps.onEnded] ({reason, soc, durationMin}) => void
   * @param {Function} [deps.onChange] (snapshot) => void
   * @param {object} [deps.options] graceMs, retryBaseMs, retryMaxMs
   */
  constructor({
    client, store, now = Date.now, sleep, log = () => {}, onEnded = () => {}, onChange = () => {}, options = {},
  }) {
    this.client = client;
    this.store = store;
    this.now = now;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = log;
    this.onEnded = onEnded;
    this.onChange = onChange;
    this.opts = { ...DEFAULTS, ...options };

    this.state = STATES.IDLE;
    this.session = null; // { startedAt, deadline, target, startCmdAt, graceFrom, releaseReason }
    this.lastSoc = null;
    this.foreignActive = false;
    this.releaseFailures = 0;
    this.stopped = false;
    this._releaseLoop = null;
    this._queue = Promise.resolve();
  }

  // ------------------------------------------------------------------ public

  /**
   * Nach dem Start der App aufrufen (Sicherungen 4 und 5).
   * @param {object|null} status erster Status vom Speicher oder null, falls nicht lesbar
   */
  init(status) {
    return this._exclusive(async () => {
      if (status) this._noteStatus(status);
      const stored = await this.store.load();

      if (!stored) {
        if (status && status.forceRunning) {
          this.foreignActive = true;
          this.log('Force-Laden laeuft, aber ohne eigene Sitzung – vermutlich vom Speicher selbst. Es wird nichts geschaltet.');
        }
        this._changed();
        return;
      }

      this.session = { ...stored, graceFrom: this.now() };

      if (stored.state === STATES.RELEASING) {
        this.log(`Freigabe war vor dem Neustart nicht abgeschlossen (${stored.releaseReason}) – wird fortgesetzt.`);
        this._beginRelease(stored.releaseReason || REASONS.RESTART);
        return;
      }

      const expired = this.now() >= stored.deadline;
      const reached = this.lastSoc !== null && this.lastSoc >= stored.target;
      if (expired || reached) {
        this.log(`Sitzung nach Neustart beendet (${expired ? 'Frist abgelaufen' : 'Ziel erreicht'}).`);
        this._beginRelease(REASONS.RESTART);
        return;
      }

      this.state = STATES.ACTIVE;
      await this._persist();
      this.log(`Sitzung nach Neustart fortgesetzt: Ziel ${stored.target} %, Frist ${new Date(stored.deadline).toISOString()}.`);
      this._changed();
    });
  }

  /**
   * Startet eine Sitzung (Sicherungen 1, 9, 10).
   * @returns {Promise<{started:boolean, updated?:boolean, reason?:string, target:number, maxMinutes:number}>}
   */
  start({ targetSoc, maxMinutes } = {}) {
    const target = clampTarget(targetSoc);
    const minutes = clampMinutes(maxMinutes);

    return this._exclusive(async () => {
      this._assertRunning();
      if (this.state === STATES.RELEASING) {
        return {
          started: false, reason: 'wird_freigegeben', target, maxMinutes: minutes,
        };
      }

      // Eigene Sitzung laeuft schon: Parameter neu setzen, Frist ab jetzt, weiter hart begrenzt.
      if (this.state === STATES.ACTIVE) {
        this.session.target = target;
        this.session.deadline = this.now() + minutes * 60000;
        await this._persist();
        this.log(`Laufende Sitzung angepasst: Ziel ${target} %, ${minutes} min.`);
        this._changed();
        return {
          started: true, updated: true, target, maxMinutes: minutes,
        };
      }

      const status = await this.client.readStatus();
      this._noteStatus(status);

      if (status.forceRunning) {
        this.foreignActive = true;
        this.log('Force-Laden laeuft bereits ohne eigene Sitzung – nichts gesendet.');
        this._changed();
        return {
          started: false, reason: 'bereits_aktiv', target, maxMinutes: minutes,
        };
      }
      if (status.soc !== null && status.soc >= target) {
        this.log(`Ladestand ${status.soc} % liegt schon auf/ueber dem Ziel ${target} % – nichts gesendet.`);
        return {
          started: false, reason: 'ziel_bereits_erreicht', target, maxMinutes: minutes,
        };
      }

      const t = this.now();
      this.session = {
        startedAt: t,
        deadline: t + minutes * 60000,
        target,
        startCmdAt: t,
        graceFrom: t,
        releaseReason: null,
      };
      this.state = STATES.STARTING;
      // Erst speichern, dann senden: stuerzt die App mitten im Start ab, raeumt init() auf.
      await this._persist();
      this._changed();

      try {
        await this.client.startForceCharge();
      } catch (err) {
        // Unklar, ob der Befehl angekommen ist -> sicherheitshalber freigeben.
        this.log(`Startbefehl fehlgeschlagen: ${err.message} – gebe sicherheitshalber frei.`);
        this._beginRelease(REASONS.ERROR);
        throw err;
      }

      this.state = STATES.ACTIVE;
      this.foreignActive = false;
      await this._persist();
      this.log(`Force-Laden gestartet: Ziel ${target} %, hoechstens ${minutes} min.`);
      this._changed();
      return { started: true, target, maxMinutes: minutes };
    });
  }

  /**
   * Freigabe auf ausdruecklichen Wunsch (Flow-Karte, Schalter aus).
   * Gibt auch frei, wenn keine eigene Sitzung laeuft, der Speicher aber laedt –
   * das ist eine bewusste Entscheidung des Nutzers.
   *
   * Das Promise erfuellt sich, wenn die Freigabe durch ist. Bei einer eigenen
   * Sitzung kann das wegen der Wiederholungen dauern – der Aufrufer begrenzt
   * die Wartezeit selbst; die Freigabe laeuft im Hintergrund weiter.
   */
  async release() {
    const res = await this._exclusive(async () => {
      this._assertRunning();
      if (this.state === STATES.RELEASING) return { loop: this._releaseLoop };
      if (this.session) return { loop: this._beginRelease(REASONS.MANUAL) };

      // Keine eigene Sitzung: nur senden, wenn der Speicher tatsaechlich laedt.
      let running = true;
      try {
        running = (await this.client.readStatus()).forceRunning;
      } catch (err) {
        this.log(`Status vor Freigabe nicht lesbar (${err.message}) – sende Freigabe trotzdem.`);
      }
      if (!running) {
        this.log('Force-Laden war nicht aktiv – nichts gesendet.');
        return null;
      }
      await this.client.release();
      this.foreignActive = false;
      this.log('Fremdes Force-Laden auf Wunsch freigegeben.');
      this._changed();
      return null;
    });
    // Ausserhalb der Warteschlange warten, damit Polls weiterlaufen.
    if (res && res.loop) await res.loop;
  }

  /** Bei jedem erfolgreichen Poll aufrufen (Sicherungen 2, 3, 7). */
  onStatus(status) {
    return this._exclusive(async () => {
      if (this.stopped) return;
      this._noteStatus(status);

      if (this.state !== STATES.ACTIVE) {
        if (this.state === STATES.IDLE) {
          const foreign = !!status.forceRunning;
          if (foreign !== this.foreignActive) {
            this.foreignActive = foreign;
            if (foreign) this.log('Force-Laden laeuft ohne eigene Sitzung – es wird nichts geschaltet.');
            this._changed();
          }
        }
        return;
      }

      const s = this.session;
      if (status.soc !== null && status.soc >= s.target) {
        this._beginRelease(REASONS.TARGET);
        return;
      }
      if (this.now() >= s.deadline) {
        this._beginRelease(REASONS.TIMEOUT);
        return;
      }
      if (!status.forceRunning && this.now() - s.graceFrom >= this.opts.graceMs) {
        // Speicher hat selbst beendet: nichts senden, nicht neu starten.
        this.log('Speicher meldet Force-Laden nicht mehr aktiv – Sitzung beendet.');
        await this._finish(REASONS.BY_STORAGE);
      }
    });
  }

  /** Regelmaessig aufrufen, unabhaengig vom Poll-Erfolg (Sicherung 3). */
  tick() {
    return this._exclusive(async () => {
      if (this.stopped) return;
      if (this.state === STATES.ACTIVE && this.now() >= this.session.deadline) {
        this._beginRelease(REASONS.TIMEOUT);
      }
    });
  }

  /**
   * Beim Beenden der App oder Loeschen des Geraets (Sicherung 6).
   * Ein Freigabeversuch nach bestem Bemuehen. Schlaegt er fehl, bleibt die
   * Sitzung gespeichert, damit init() nach dem Neustart freigibt.
   * @param {object} [opts]
   * @param {boolean} [opts.forget=false] Store immer leeren (Geraet wird geloescht)
   */
  async shutdown({ forget = false } = {}) {
    this.stopped = true;
    await this._queue.catch(() => {});
    const owned = this.session && this.state !== STATES.IDLE;
    if (owned) {
      try {
        await this.client.release();
        this.log('Eigene Sitzung beim Beenden freigegeben.');
        this.session = null;
        this.state = STATES.IDLE;
        await this.store.save(null);
      } catch (err) {
        this.log(`Freigabe beim Beenden fehlgeschlagen: ${err.message}`);
      }
    }
    if (forget) await this.store.save(null);
  }

  /** Momentaufnahme fuer Anzeige, Bedingungskarte und Tests. */
  snapshot() {
    const s = this.session;
    return {
      state: this.state,
      active: this.state === STATES.STARTING || this.state === STATES.ACTIVE,
      target: s ? s.target : null,
      startedAt: s ? s.startedAt : null,
      deadline: s ? s.deadline : null,
      remainingMs: s && this.state === STATES.ACTIVE ? Math.max(0, s.deadline - this.now()) : null,
      foreignActive: this.foreignActive,
      releaseFailures: this.releaseFailures,
      warning: this.state === STATES.RELEASING && this.releaseFailures > 0
        ? `Freigabe fehlgeschlagen (${this.releaseFailures}x) – neuer Versuch laeuft`
        : null,
      lastSoc: this.lastSoc,
    };
  }

  /** Wartet, bis eine laufende Freigabe abgeschlossen ist (fuer Tests). */
  async settled() {
    await this._queue.catch(() => {});
    if (this._releaseLoop) await this._releaseLoop;
  }

  // ----------------------------------------------------------------- intern

  _exclusive(fn) {
    const result = this._queue.then(fn, fn);
    this._queue = result.catch(() => {});
    return result;
  }

  _assertRunning() {
    if (this.stopped) throw new Error('Sitzung ist beendet (App faehrt herunter)');
  }

  _noteStatus(status) {
    if (status && typeof status.soc === 'number') this.lastSoc = status.soc;
  }

  async _persist() {
    if (!this.session) {
      await this.store.save(null);
      return;
    }
    const { graceFrom, ...rest } = this.session;
    await this.store.save({ ...rest, state: this.state });
  }

  /**
   * Wechselt nach RELEASING und startet die Wiederholschleife (Sicherung 8).
   * Gibt das Promise der Schleife zurueck, wartet aber nicht darauf, damit
   * die Warteschlange nicht blockiert.
   */
  _beginRelease(reason) {
    if (this.state === STATES.RELEASING && this._releaseLoop) return this._releaseLoop;
    this.state = STATES.RELEASING;
    if (this.session) this.session.releaseReason = reason;
    this.releaseFailures = 0;
    this._changed();
    this._releaseLoop = this._runReleaseLoop(reason).finally(() => {
      this._releaseLoop = null;
    });
    return this._releaseLoop;
  }

  async _runReleaseLoop(reason) {
    await this._persist().catch((err) => this.log(`Speichern fehlgeschlagen: ${err.message}`));
    let delay = this.opts.retryBaseMs;
    for (;;) {
      if (this.stopped) return;
      try {
        await this._releaseOnce();
        await this._finish(reason);
        return;
      } catch (err) {
        this.releaseFailures++;
        this.log(`Freigabe fehlgeschlagen (${this.releaseFailures}x): ${err.message} – neuer Versuch in ${Math.round(delay / 1000)} s.`);
        this._changed();
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, this.opts.retryMaxMs);
    }
  }

  async _releaseOnce() {
    // Wie ha-senec-v3: Ist-Zustand lesen, nur senden, wenn noetig.
    // Ausnahme: kurz nach dem eigenen Startbefehl kann der Speicher noch
    // "nicht aktiv" melden, obwohl er gleich startet -> dann immer senden.
    const s = this.session;
    const recentStart = s && s.startCmdAt && this.now() - s.startCmdAt < this.opts.graceMs;
    let running = true;
    if (!recentStart) {
      try {
        const st = await this.client.readStatus();
        this._noteStatus(st);
        running = st.forceRunning;
      } catch (err) {
        running = true; // unbekannt -> sicherheitshalber senden
      }
    }
    if (running) await this.client.release();
  }

  async _finish(reason) {
    const s = this.session;
    const durationMin = s ? Math.round(((this.now() - s.startedAt) / 60000) * 10) / 10 : 0;
    this.session = null;
    this.state = STATES.IDLE;
    this.releaseFailures = 0;
    await this.store.save(null);
    this.log(`Force-Laden beendet: ${reason}, Ladestand ${this.lastSoc ?? '?'} %, ${durationMin} min.`);
    this._changed();
    try {
      this.onEnded({ reason, soc: this.lastSoc, durationMin });
    } catch (err) {
      this.log(`onEnded-Fehler: ${err.message}`);
    }
  }

  _changed() {
    try {
      this.onChange(this.snapshot());
    } catch (err) {
      this.log(`onChange-Fehler: ${err.message}`);
    }
  }

}

module.exports = {
  ForceChargeSession, STATES, REASONS, LIMITS, clampTarget, clampMinutes,
};
