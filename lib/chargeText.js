'use strict';

const { STATES } = require('./ForceChargeSession');

/**
 * Uebersetzungs-Schluessel und Platzhalter fuer den Status der Netzladung.
 * Getrennt vom Geraet, damit es ohne Homey testbar ist.
 * @param {object} snap ForceChargeSession#snapshot()
 * @returns {{key:string, tokens:object}}
 */
function statusKey(snap) {
  switch (snap.state) {
    case STATES.STARTING:
      return { key: 'status.starting', tokens: {} };
    case STATES.ACTIVE:
      return {
        key: 'status.active',
        tokens: {
          target: snap.target,
          minutes: Math.max(0, Math.ceil((snap.remainingMs || 0) / 60000)),
        },
      };
    case STATES.RELEASING:
      return { key: snap.warning ? 'status.releasing_retry' : 'status.releasing', tokens: {} };
    default:
      return { key: snap.foreignActive ? 'status.foreign' : 'status.idle', tokens: {} };
  }
}

/** Schalter "an" zeigt: eigene Ladung laeuft oder der Speicher laedt selbst. */
function switchOn(snap) {
  if (snap.state === STATES.RELEASING) return false;
  if (snap.active) return true;
  return snap.state === STATES.IDLE && snap.foreignActive;
}

module.exports = { statusKey, switchOn };
