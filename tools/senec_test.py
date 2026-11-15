#!/usr/bin/env python3
"""
SENEC Force-Lade-Test
=====================

Kleine lokale Weboberflaeche, um beim SENEC.Home V3 (auch V2) die
"Sicherheitsladung" - also Laden des Speichers aus dem Netz - zu starten
und wieder freizugeben. Nutzt die lokale lala.cgi-Schnittstelle des Speichers.

Aufruf (im Heimnetz, auf einem Rechner im selben Netz wie der SENEC):

    python senec_test.py 192.168.178.50

Danach im Browser oeffnen:  http://localhost:8080

Optionen:
    --port 8080          Port der lokalen Oberflaeche
    --max-minuten 10     Auto-Stopp: Force-Laden wird spaetestens nach dieser
                         Zeit automatisch wieder freigegeben (max. 60)

Nur Python-Standardbibliothek, keine Installation noetig.

WICHTIG
- Die lala.cgi ist eine inoffizielle, undokumentierte Schnittstelle. Die Befehle
  stammen aus den Community-Projekten ha-senec-v3 (Home Assistant) und
  senec-connector (Homey). Nutzung auf eigenes Risiko.
- Waehrend des Force-Ladens bezieht der Speicher Strom aus dem Netz.
- Beenden immer ueber den Button "Freigeben" oder mit Strg+C im Konsolenfenster,
  NICHT durch Schliessen des Fensters - nur dann wird garantiert wieder
  freigegeben.
"""

import argparse
import json
import signal
import ssl
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# SENEC-Schnittstelle
# --------------------------------------------------------------------------

# Felder, die fuer die Anzeige gelesen werden
READ_REQUEST = json.dumps({
    "ENERGY": {
        "STAT_STATE": "",
        "GUI_BAT_DATA_FUEL_CHARGE": "",
        "GUI_BAT_DATA_POWER": "",
        "GUI_GRID_POW": "",
        "GUI_INVERTER_POWER": "",
        "GUI_HOUSE_POW": "",
        "SAFE_CHARGE_RUNNING": "",
    }
}, separators=(",", ":"))

# Exakt die Befehle, die ha-senec-v3 und senec-connector senden
CMD_START = ('{"ENERGY":{"SAFE_CHARGE_FORCE":"u8_01","SAFE_CHARGE_PROHIBIT":"",'
             '"SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"",'
             '"LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}')
CMD_RELEASE = ('{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"u8_01",'
               '"SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"",'
               '"LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}')
CMD_STATE = ('{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"",'
             '"SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"",'
             '"LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}')

STATE_NAMES = {
    0: "INITIALZUSTAND", 1: "KEINE KOMMUNIKATION LADEGERAET",
    2: "FEHLER LEISTUNGSMESSGERAET", 3: "RUNDSTEUEREMPFAENGER", 4: "ERSTLADUNG",
    5: "WARTUNGSLADUNG", 6: "WARTUNGSLADUNG FERTIG", 7: "WARTUNG NOTWENDIG",
    8: "MAN. SICHERHEITSLADUNG", 9: "SICHERHEITSLADUNG FERTIG", 10: "VOLLLADUNG",
    11: "AUSGLEICHSLADUNG: LADEN", 12: "SULFATLADUNG: LADEN", 13: "AKKU VOLL",
    14: "LADEN", 15: "AKKU LEER", 16: "ENTLADEN", 17: "PV + ENTLADEN",
    18: "NETZ + ENTLADEN", 19: "PASSIV", 20: "AUSGESCHALTET", 21: "EIGENVERBRAUCH",
    22: "NEUSTART", 23: "MAN. AUSGLEICHSLADUNG: LADEN", 24: "MAN. SULFATLADUNG: LADEN",
    25: "SICHERHEITSLADUNG", 26: "AKKU-SCHUTZBETRIEB", 27: "EG FEHLER", 28: "EG LADEN",
    29: "EG ENTLADEN", 30: "EG PASSIV", 31: "EG LADEN VERBOTEN", 32: "EG ENTLADEN VERBOTEN",
    33: "NOTLADUNG", 34: "SOFTWAREAKTUALISIERUNG", 35: "FEHLER: NA-SCHUTZ",
    36: "FEHLER: NA-SCHUTZ NETZ", 37: "FEHLER: NA-SCHUTZ HARDWARE",
    38: "KEINE SERVERVERBINDUNG", 39: "BMS FEHLER", 40: "WARTUNG: FILTER",
    41: "ABSCHALTUNG LITHIUM", 42: "WARTE AUF UEBERSCHUSS", 43: "KAPAZITAETSTEST: LADEN",
    44: "KAPAZITAETSTEST: ENTLADEN", 45: "MAN. SULFATLADUNG: WARTEN",
    46: "MAN. SULFATLADUNG: FERTIG", 47: "MAN. SULFATLADUNG: FEHLER",
    48: "AUSGLEICHSLADUNG: WARTEN", 49: "NOTLADUNG: FEHLER",
    50: "MAN: AUSGLEICHSLADUNG: WARTEN", 51: "MAN: AUSGLEICHSLADUNG: FEHLER",
    52: "MAN: AUSGLEICHSLADUNG: FERTIG", 53: "AUTO: SULFATLADUNG: WARTEN",
    54: "LADESCHLUSSPHASE", 55: "BATTERIETRENNSCHALTER AUS", 56: "PEAK-SHAVING: WARTEN",
    57: "FEHLER LADEGERAET", 58: "NPU-FEHLER", 59: "BMS OFFLINE",
    60: "WARTUNGSLADUNG FEHLER", 61: "MAN. SICHERHEITSLADUNG FEHLER",
    62: "SICHERHEITSLADUNG FEHLER", 63: "KEINE MASTERVERBINDUNG",
    64: "LITHIUM SICHERHEITSMODUS AKTIV", 65: "LITHIUM SICHERHEITSMODUS BEENDET",
    66: "FEHLER BATTERIESPANNUNG", 67: "BMS DC AUSGESCHALTET", 68: "NETZINITIALISIERUNG",
    69: "NETZSTABILISIERUNG", 70: "FERNABSCHALTUNG", 71: "OFFPEAK-LADEN",
    72: "FEHLER HALBBRUECKE", 73: "BMS: FEHLER BETRIEBSTEMPERATUR",
    74: "FACTORY SETTINGS NICHT GEFUNDEN", 75: "NETZERSATZBETRIEB",
    76: "NETZERSATZBETRIEB AKKU LEER", 77: "NETZERSATZBETRIEB FEHLER", 78: "INITIALISIERUNG",
    79: "INSTALLATIONSMODUS", 80: "NETZAUSFALL", 81: "BMS UPDATE ERFORDERLICH",
    82: "BMS KONFIGURATION ERFORDERLICH", 83: "ISOLATIONSTEST", 84: "SELBSTTEST",
    85: "EXTERNE STEUERUNG", 86: "TEMPERATUR SENSOR FEHLER",
    87: "NETZBETREIBER: LADEN GESPERRT", 88: "NETZBETREIBER: ENTLADEN GESPERRT",
    89: "RESERVEKAPAZITAET", 90: "SELBSTTEST FEHLER", 91: "ISOLATIONSFEHLER",
    92: "PV-MODUS", 93: "FERNABSCHALTUNG NETZBETREIBER", 94: "FEHLER DRM0",
    95: "BATTERIEDIAGNOSE", 96: "BALANCING", 97: "SICHERHEITSENTLADUNG",
    98: "BMS FEHLER - MODULUNGLEICHGEWICHT", 99: "AUFWACHLADUNG", 100: "SOX-KALIBRIERUNG",
}


def decode_value(value):
    """SENEC liefert Werte als 'typ_hex', z.B. fl_43E26188 oder u8_01."""
    if not isinstance(value, str) or "_" not in value:
        return value
    prefix, rest = value.split("_", 1)
    try:
        if prefix == "fl":
            return struct.unpack(">f", bytes.fromhex(rest))[0]
        if prefix in ("u1", "u3", "u6", "u8", "i1", "i3", "i8"):
            return int(rest, 16)
        if prefix == "st":
            return rest
    except ValueError:
        pass
    return value  # z.B. VARIABLE_NOT_FOUND


def decode_tree(obj):
    if isinstance(obj, dict):
        return {k: decode_tree(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [decode_tree(v) for v in obj]
    return decode_value(obj)


class Senec:
    def __init__(self, host, timeout=10):
        self.host = host
        self.timeout = timeout
        self.scheme = None  # wird beim ersten Kontakt ermittelt
        self.lock = threading.Lock()
        # Der SENEC nutzt ein selbstsigniertes Zertifikat
        self.ctx = ssl.create_default_context()
        self.ctx.check_hostname = False
        self.ctx.verify_mode = ssl.CERT_NONE

    def post(self, body):
        with self.lock:
            schemes = [self.scheme] if self.scheme else ["https", "http"]
            last_error = None
            for scheme in schemes:
                base = f"{scheme}://{self.host}"
                req = urllib.request.Request(
                    f"{base}/lala.cgi",
                    data=body.encode("utf-8"),
                    method="POST",
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "X-Requested-With": "XMLHttpRequest",
                        "Origin": base,
                        "Referer": f"{base}/",
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    self.scheme = scheme
                    return decode_tree(data)
                except (urllib.error.URLError, OSError, ValueError) as err:
                    last_error = err
            raise ConnectionError(f"SENEC unter {self.host} nicht erreichbar: {last_error}")


# --------------------------------------------------------------------------
# Steuerung mit Auto-Stopp
# --------------------------------------------------------------------------

class Controller:
    def __init__(self, senec, max_minutes):
        self.senec = senec
        self.max_seconds = max_minutes * 60
        self.started_by_us = False
        self.deadline = None
        self.log = deque(maxlen=40)
        self.mutex = threading.Lock()
        self._stop_event = threading.Event()
        threading.Thread(target=self._watchdog, daemon=True).start()

    def note(self, text):
        line = f"{datetime.now():%H:%M:%S}  {text}"
        self.log.appendleft(line)
        print(line, flush=True)

    def _running(self):
        data = self.senec.post(CMD_STATE)
        return data.get("ENERGY", {}).get("SAFE_CHARGE_RUNNING") == 1

    def status(self):
        e = self.senec.post(READ_REQUEST).get("ENERGY", {})
        code = e.get("STAT_STATE")
        remaining = None
        if self.deadline:
            remaining = max(0, int(self.deadline - time.time()))
        return {
            "soc": e.get("GUI_BAT_DATA_FUEL_CHARGE"),
            "battery_w": e.get("GUI_BAT_DATA_POWER"),
            "grid_w": e.get("GUI_GRID_POW"),
            "pv_w": e.get("GUI_INVERTER_POWER"),
            "house_w": e.get("GUI_HOUSE_POW"),
            "state_code": code,
            "state_name": STATE_NAMES.get(code, f"Unbekannt ({code})") if isinstance(code, int) else str(code),
            "force_running": e.get("SAFE_CHARGE_RUNNING") == 1,
            "started_by_us": self.started_by_us,
            "auto_stop_in_s": remaining,
            "scheme": self.senec.scheme,
            "log": list(self.log),
        }

    def start(self):
        with self.mutex:
            if self._running():
                self.note("Force-Laden laeuft bereits - nichts gesendet.")
                return
            self.senec.post(CMD_START)
            self.started_by_us = True
            self.deadline = time.time() + self.max_seconds
            self.note(f"Force-Laden GESTARTET (Auto-Stopp in {self.max_seconds // 60:.0f} min).")

    def release(self, reason="Button"):
        with self.mutex:
            running = False
            try:
                running = self._running()
            except ConnectionError as err:
                self.note(f"Status vor Freigabe nicht lesbar ({err}) - sende Freigabe trotzdem.")
                running = True
            if running or self.started_by_us:
                self.senec.post(CMD_RELEASE)
                self.note(f"FREIGEGEBEN - Normalbetrieb ({reason}).")
            else:
                self.note(f"Force-Laden war nicht aktiv - nichts gesendet ({reason}).")
            self.started_by_us = False
            self.deadline = None

    def _watchdog(self):
        while not self._stop_event.wait(1):
            if self.deadline and time.time() >= self.deadline:
                try:
                    self.release("Auto-Stopp")
                except ConnectionError as err:
                    self.note(f"Auto-Stopp fehlgeschlagen: {err} - neuer Versuch in 1 s.")

    def shutdown(self):
        self._stop_event.set()
        if self.started_by_us:
            for attempt in range(3):
                try:
                    self.release("Programmende")
                    return
                except ConnectionError as err:
                    self.note(f"Freigabe beim Beenden fehlgeschlagen ({err}), Versuch {attempt + 1}/3.")
                    time.sleep(2)
            print("\n!!! ACHTUNG: Freigabe konnte nicht gesendet werden. Programm neu starten "
                  "und 'Freigeben' druecken, oder in der SENEC-Weboberflaeche freigeben. !!!\n",
                  flush=True)


# --------------------------------------------------------------------------
# Lokale Weboberflaeche
# --------------------------------------------------------------------------

PAGE = r"""<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SENEC Force-Lade-Test</title>
<style>
  :root {
    --bg: #f2f3f5; --card: #ffffff; --ink: #16181d; --muted: #5c6474; --line: #d9dde3;
    --accent: #0d6b6e; --warn: #9a5b0c; --warn-bg: #f6ead6; --stop: #9c3826;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121419; --card: #1b1e24; --ink: #e8eaef; --muted: #959cab; --line: #2c3139;
      --accent: #5cc2c2; --warn: #d8a650; --warn-bg: #33291a; --stop: #e48a73;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: grid; gap: 1.25rem; }
  h1 { margin: 0; font-size: 1.5rem; }
  .sub { color: var(--muted); font-size: .9rem; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .75rem; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: .9rem 1rem; }
  .label { font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .value { font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .hint { font-size: .85rem; color: var(--muted); }
  .state { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 1rem;
           display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; align-items: baseline; }
  .pill { display: inline-block; padding: .2rem .6rem; border-radius: 999px; font-weight: 600; font-size: .9rem;
          background: var(--line); }
  .pill.on { background: var(--warn-bg); color: var(--warn); }
  .buttons { display: flex; flex-wrap: wrap; gap: .75rem; }
  button { font: inherit; font-weight: 600; padding: .75rem 1.25rem; border-radius: 6px; border: 0; cursor: pointer; }
  button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  #start { background: var(--warn); color: #fff; }
  #release { background: var(--accent); color: #fff; }
  button:disabled { opacity: .45; cursor: default; }
  .warnbox { background: var(--warn-bg); color: var(--ink); border-left: 4px solid var(--warn);
             padding: .75rem 1rem; border-radius: 0 6px 6px 0; font-size: .9rem; }
  .err { color: var(--stop); font-weight: 600; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: .75rem 1rem;
        margin: 0; font-size: .82rem; overflow-x: auto; min-height: 3rem; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
  <header>
    <h1>SENEC Force-Lade-Test</h1>
    <div class="sub" id="conn">Verbinde …</div>
  </header>

  <div class="warnbox">
    Force-Laden laedt den Speicher <strong>aus dem Netz</strong>. Es endet automatisch nach
    <strong id="maxmin">–</strong> Minuten. Beenden immer ueber <em>Freigeben</em> oder Strg+C in der Konsole,
    nicht durch Schliessen des Fensters.
  </div>

  <section class="tiles">
    <div class="tile"><div class="label">Ladestand</div><div class="value" id="soc">–</div></div>
    <div class="tile"><div class="label">Speicher</div><div class="value" id="bat">–</div><div class="hint" id="bathint">&nbsp;</div></div>
    <div class="tile"><div class="label">Netz</div><div class="value" id="grid">–</div><div class="hint" id="gridhint">&nbsp;</div></div>
    <div class="tile"><div class="label">PV</div><div class="value" id="pv">–</div></div>
    <div class="tile"><div class="label">Haus</div><div class="value" id="house">–</div></div>
  </section>

  <section class="state">
    <div><span class="label">Force-Laden</span><br><span class="pill" id="force">–</span></div>
    <div><span class="label">Status SENEC</span><br><strong id="state">–</strong></div>
    <div><span class="label">Auto-Stopp in</span><br><strong id="countdown">–</strong></div>
  </section>

  <section class="buttons">
    <button id="start">Force-Laden starten</button>
    <button id="release">Freigeben (Normalbetrieb)</button>
  </section>

  <section>
    <div class="label" style="margin-bottom:.4rem">Protokoll</div>
    <pre id="log"></pre>
  </section>
</main>
<script>
const $ = id => document.getElementById(id);
const w = v => (typeof v === "number") ? Math.round(v).toLocaleString("de-DE") + " W" : "–";
let busy = false;

async function refresh() {
  try {
    const r = await fetch("/api/status");
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || r.statusText);
    $("conn").textContent = "Verbunden mit SENEC (" + s.scheme + ") · aktualisiert " + new Date().toLocaleTimeString("de-DE");
    $("conn").className = "sub";
    $("soc").textContent = (typeof s.soc === "number") ? s.soc.toFixed(1) + " %" : "–";
    $("bat").textContent = w(s.battery_w);
    $("bathint").textContent = s.battery_w > 20 ? "laedt" : (s.battery_w < -20 ? "entlaedt" : "ruht");
    $("grid").textContent = w(s.grid_w);
    $("gridhint").textContent = s.grid_w > 20 ? "Bezug" : (s.grid_w < -20 ? "Einspeisung" : "neutral");
    $("pv").textContent = w(s.pv_w);
    $("house").textContent = w(s.house_w);
    $("state").textContent = s.state_name;
    $("force").textContent = s.force_running ? "AKTIV" : "aus";
    $("force").className = "pill" + (s.force_running ? " on" : "");
    if (s.auto_stop_in_s !== null) {
      const m = Math.floor(s.auto_stop_in_s / 60), sec = s.auto_stop_in_s % 60;
      $("countdown").textContent = m + ":" + String(sec).padStart(2, "0") + " min";
    } else {
      $("countdown").textContent = "–";
    }
    $("log").textContent = s.log.join("\n");
    $("start").disabled = busy || s.force_running;
    $("release").disabled = busy;
  } catch (e) {
    $("conn").textContent = "Keine Verbindung: " + e.message;
    $("conn").className = "sub err";
  }
}

async function send(path) {
  busy = true; $("start").disabled = true; $("release").disabled = true;
  try {
    const r = await fetch(path, { method: "POST", headers: { "X-Senec-Test": "1" } });
    const s = await r.json();
    if (!r.ok) alert("Fehler: " + (s.error || r.statusText));
  } catch (e) {
    alert("Fehler: " + e.message);
  } finally {
    busy = false;
    setTimeout(refresh, 1500);
  }
}

$("start").onclick = () => {
  if (confirm("Speicher jetzt aus dem Netz laden? Das bezieht Strom vom Netz.")) send("/api/start");
};
$("release").onclick = () => send("/api/release");

fetch("/api/config").then(r => r.json()).then(c => { $("maxmin").textContent = c.max_minutes; });
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
"""


def make_handler(controller, max_minutes):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SenecTest/1.0"

        def log_message(self, fmt, *args):  # Konsole ruhig halten
            pass

        def _host_ok(self):
            host = (self.headers.get("Host") or "").split(":")[0]
            return host in ("localhost", "127.0.0.1")

        def _json(self, code, obj):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._host_ok():
                return self._json(403, {"error": "Nur ueber localhost erreichbar."})
            if self.path == "/":
                body = PAGE.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/api/status":
                try:
                    self._json(200, controller.status())
                except ConnectionError as err:
                    self._json(502, {"error": str(err)})
            elif self.path == "/api/config":
                self._json(200, {"max_minutes": max_minutes})
            else:
                self._json(404, {"error": "Nicht gefunden"})

        def do_POST(self):
            # Schutz gegen fremde Webseiten im selben Browser
            if not self._host_ok() or self.headers.get("X-Senec-Test") != "1":
                return self._json(403, {"error": "Nicht erlaubt."})
            try:
                if self.path == "/api/start":
                    controller.start()
                elif self.path == "/api/release":
                    controller.release("Button")
                else:
                    return self._json(404, {"error": "Nicht gefunden"})
                self._json(200, {"ok": True})
            except ConnectionError as err:
                controller.note(f"FEHLER: {err}")
                self._json(502, {"error": str(err)})

    return Handler


def main():
    parser = argparse.ArgumentParser(description="SENEC Force-Lade-Test (lokale Weboberflaeche)")
    parser.add_argument("host", help="IP-Adresse des SENEC-Speichers, z.B. 192.168.178.50")
    parser.add_argument("--port", type=int, default=8080, help="Port der lokalen Oberflaeche (Standard 8080)")
    parser.add_argument("--max-minuten", type=float, default=10.0,
                        help="Auto-Stopp nach so vielen Minuten (Standard 10, max. 60)")
    args = parser.parse_args()

    max_minutes = min(max(args.max_minuten, 0.05), 60.0)
    senec = Senec(args.host)

    print(f"Pruefe Verbindung zu SENEC {args.host} …", flush=True)
    try:
        first = senec.post(READ_REQUEST).get("ENERGY", {})
    except ConnectionError as err:
        print(f"\n{err}\nIP-Adresse pruefen und ob dieser Rechner im selben Netz ist.", flush=True)
        sys.exit(1)
    print(f"OK ({senec.scheme}). Ladestand: {first.get('GUI_BAT_DATA_FUEL_CHARGE')} %", flush=True)

    controller = Controller(senec, max_minutes)
    controller.note(f"Verbunden mit {args.host} ({senec.scheme}).")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(controller, max_minutes))

    def _terminate(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _terminate)

    print(f"\nOberflaeche:  http://localhost:{args.port}\nBeenden mit Strg+C.\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBeende …", flush=True)
    finally:
        server.server_close()
        controller.shutdown()


if __name__ == "__main__":
    main()
