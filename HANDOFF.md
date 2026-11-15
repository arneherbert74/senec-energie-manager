# Übergabe: SENEC-Netzladung für Homey Pro

Kontextdatei für Claude Code. Ziel: eine sichere Force-Lade-Steuerung für einen SENEC-Speicher als Homey-Pro-App bauen, aufbauend auf einem bestehenden Open-Source-Projekt.

Stand: 14.11.2026. Alles unter „Verifiziert" ist geprüft — am Quellcode zweier unabhängiger Projekte oder am echten Gerät. Alles unter „Offen" ist es nicht.

---

## 1. Auftrag in einem Satz

Den Homey-Connector `Dbone29/senec-connector` forken und so erweitern, dass sich das Laden des Speichers aus dem Netz **aus Homey-Flows heraus mit Ladeziel und Zeitlimit** steuern lässt — und dass der Speicher **unter keinen Umständen** dauerhaft im Lademodus hängen bleibt.

## 2. Arbeitsweise mit mir

- Deutsch, knapp, direkt. Kernaussage zuerst, nächster Schritt am Ende.
- Keine langen Einleitungen, kein Weichspülen. Sag, was du denkst.
- Bremse mich, wenn ich zu schnell entscheide oder Geld ausgeben will, bevor die Fakten da sind.
- Bevor du etwas Unumkehrbares tust (Push, Veröffentlichung, Installation auf dem Homey), frag.

## 3. Umgebung

| | |
|---|---|
| Speicher | SENEC.Home **V3 hybrid duo**, Batteriemodule bereits gegen **10 kWh LFP** getauscht |
| Steuerzentrale | **Homey Pro (2026)**, bestellt, noch nicht da |
| Entwicklungsrechner | Microsoft Surface, **Windows auf ARM64** |
| Stromtarif | Tibber Smart Dynamic, ab 01.11.2026 |
| Smart Meter | über Tibber bestellt, Anbindung per LAN, **noch nicht verbaut** |
| Werkzeuge | Node.js ab 24, Homey CLI (`npm install -g homey`), Athom-Konto |

Bis der Homey da ist: lokal entwickeln, mit Unit-Tests und dem Mock-Server aus Abschnitt 9.

## 4. Ausgangsbasis: `senec-connector`

- Repo: https://github.com/Dbone29/senec-connector — **MIT-Lizenz**, Copyright-Hinweis beibehalten
- Homey SDK v3, `platforms: ["local"]`, Treiber für `senec-battery`, `senec-solar`, `senec-grid`, `senec-consumption`
- Das Repo hat bereits eine eigene `CLAUDE.md` — **nicht überschreiben**, diese Datei ergänzt sie

**Was dort heute passiert** (`drivers/senec-battery/device.js`):

- Pollt alle 3 s mit exponentiellem Backoff bis 60 s
- Die Capability `onoff` („Zwangsladen") schickt bei an `SAFE_CHARGE_FORCE: 'u8_01'`, bei aus `SAFE_CHARGE_PROHIBIT: 'u8_01'`
- Der Listener ruft `forceCharge()` **ohne `await`** auf — Fehler gehen verloren
- **Keine Flow-Karten, kein Zeitlimit, kein Ladeziel, keine Prüfung des Ist-Zustands**
- Sendet mit `Content-Type: application/json` und nur dem einen Feld, ausschließlich HTTPS
- Pairing über IP-Eingabe; die Geräte-ID ist die IP (`TODO: replace with mac` im Code)

Der Kern des Problems: Wer heute in Homey auf „an" tippt, lädt den Speicher unbegrenzt aus dem Netz, bis jemand von Hand ausschaltet.

## 5. Verifiziert: das Protokoll der lokalen Schnittstelle

Quellen: `marq24/ha-senec-v3` (Home Assistant, `custom_components/senec/pysenec_ha/senec_lala.py`, `util.py`, `constants.py`) und `senec-connector`. Beide stimmen überein.

### Endpunkt

- `POST https://<ip>/lala.cgi`, ältere Firmware: `http://<ip>/lala.cgi`
- **Selbstsigniertes Zertifikat** → Prüfung abschalten, nur für diesen Agent, nicht global
- **Keine Authentifizierung.** Wer im Netz ist, kann schreiben.

### Request-Form, die am echten Gerät funktioniert hat

So hat es das Testskript `senec_test.py` gemacht, und der Speicher des Nutzers hat darauf reagiert. **Diese Variante verwenden**, nicht die von `senec-connector`:

```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Accept: application/json, text/javascript, */*; q=0.01
X-Requested-With: XMLHttpRequest
Origin: https://<ip>
Referer: https://<ip>/
```

Body: **der rohe JSON-String**, nicht URL-kodiert.

### Befehle — exakt so

```json
// Zustand lesen
{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}

// Force-Laden starten
{"ENERGY":{"SAFE_CHARGE_FORCE":"u8_01","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}

// Freigeben (zurück in den Normalbetrieb)
{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"u8_01","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":""}}
```

`ha-senec-v3` liest vor jedem Schaltbefehl erst den Ist-Zustand und sendet nur, wenn er sich vom Soll unterscheidet. Übernehmen.

### Messwerte lesen

```json
{"ENERGY":{"STAT_STATE":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_BAT_DATA_POWER":"","GUI_GRID_POW":"","GUI_INVERTER_POWER":"","GUI_HOUSE_POW":"","SAFE_CHARGE_RUNNING":""}}
```

Unbekannte Felder kommen als `"VARIABLE_NOT_FOUND"` zurück.

### Werte-Kodierung

| Präfix | Bedeutung | Dekodieren |
|---|---|---|
| `fl_43E26188` | Float, IEEE 754, Big Endian | 4 Bytes aus Hex, `readFloatBE` |
| `u8_01`, `u1_…`, `u3_…`, `i3_…` | Ganzzahl | `parseInt(hex, 16)` |
| `st_…` | String | Rest nach dem ersten `_` |
| ohne `_` | unkodiert | so lassen |

Am Präfix nur am **ersten** `_` trennen.

### Vorzeichen

- `GUI_BAT_DATA_POWER`: **positiv = lädt**, negativ = entlädt
- `GUI_GRID_POW`: **positiv = Bezug**, negativ = Einspeisung
- `GUI_BAT_DATA_FUEL_CHARGE`: Ladestand in Prozent als Float (`senec-connector` nimmt stattdessen `BMS.SYSTEM_SOC / 10`, beides geht)
- `SAFE_CHARGE_RUNNING`: `1` = Force-Laden aktiv

### Wichtige Statuscodes (`STAT_STATE`)

| Code | Bedeutung |
|---|---|
| 8 | MAN. SICHERHEITSLADUNG — **das ist unser Force-Laden** |
| 9 | SICHERHEITSLADUNG FERTIG |
| 13 | AKKU VOLL |
| 14 | LADEN |
| 16 | ENTLADEN |
| 21 | EIGENVERBRAUCH — Normalbetrieb |
| 25 | SICHERHEITSLADUNG — **vom System selbst ausgelöst**, nicht von uns |
| 61, 62 | (MAN.) SICHERHEITSLADUNG FEHLER |

Vollständige Tabelle (DE und EN): `SYSTEM_STATE_NAME` in `ha-senec-v3/.../pysenec_ha/constants.py`.

### Verhalten

- Der SENEC reagiert **nicht sofort**. `ha-senec-v3` überschreibt den gelesenen Zustand nach einem Schaltbefehl 5 Sekunden lang mit dem Sollwert.
- Nicht hämmern: Requests serialisieren, Polling-Intervall ab 3 s.

## 6. Verifiziert am echten Gerät

Am 14.11.2026 mit `senec_test.py` getestet:

- Der V3 **nimmt den Startbefehl an**, Force-Laden geht auf aktiv. Der Nutzer berichtet: „scheint zu funktionieren".
- Nach 10 Minuten war es wieder aus. Das war der **Auto-Stopp des Skripts** (Standard 10 min) — vom Nutzer am 15.11.2026 bestätigt.

`senec_test.py` liegt beim Nutzer und ist die funktionierende Referenzimplementierung für Protokoll und Sicherungslogik. Bitte ins Repo unter `tools/senec_test.py` übernehmen.

## 7. Was gebaut werden soll

### Flow-Karten

| Typ | ID | Argumente / Tokens |
|---|---|---|
| Aktion | `force_charge_start` — „Force-Laden bis [Ziel %], höchstens [Minuten]" | `target_soc` Zahl 50–100, Standard **80** · `max_minutes` Zahl 1–180, Standard **120** |
| Aktion | `force_charge_release` — „Speicher freigeben" | — |
| Bedingung | `force_charge_active` — „Force-Laden ist (nicht) aktiv" | — |
| Auslöser | `force_charge_ended` — „Force-Laden beendet" | Token `reason` (Text), `soc` (Zahl), `duration_min` (Zahl) |

Mögliche Werte für `reason`: `ziel_erreicht`, `zeit_abgelaufen`, `manuell`, `vom_speicher_beendet`, `app_neustart`, `fehler`.

Texte auf Deutsch und Englisch in `locales/`.

### Die Capability `onoff`

Bleibt als Schalter erhalten, aber **an** startet jetzt eine Sitzung mit den Standardwerten (80 %, 120 min) statt unbegrenzt zu laden. **Aus** gibt frei.

### Die Sicherungen — nicht verhandelbar, jede mit Test

1. **Jeder Start hat ein Ladeziel und ein Zeitlimit.** Werte auf die erlaubten Bereiche begrenzen. **Harte Obergrenze 180 Minuten**, egal was der Flow übergibt.
2. **Freigabe, sobald der Ladestand das Ziel erreicht.**
3. **Freigabe, sobald die Frist abläuft.**
4. **Sitzung persistent speichern** (Start, Frist, Ziel) im Device-Store. Nach einem Neustart der App: ist die Frist abgelaufen oder das Ziel erreicht → freigeben und `force_charge_ended` mit `app_neustart` auslösen; sonst die Sitzung fortsetzen.
5. **Nur freigeben, was die App selbst gestartet hat.** Ist `SAFE_CHARGE_RUNNING` beim Start der App aktiv, ohne dass eine eigene Sitzung gespeichert ist, nichts schalten — das kann eine vom System ausgelöste Sicherheitsladung sein (Status 25). Nur loggen und anzeigen.
6. **Beim Beenden der App (`onUninit`) und beim Löschen des Geräts:** laufende eigene Sitzung freigeben, nach bestem Bemühen.
7. **Zeigt der Speicher mitten in einer Sitzung „nicht aktiv"** — nach einer Karenzzeit von etwa 15 s nach dem Start —, die Sitzung beenden mit `vom_speicher_beendet`. **Nicht automatisch neu starten.** Der Flow entscheidet.
8. **Schlägt die Freigabe fehl**, mit Backoff wiederholen, bis sie durchgeht. Die Sitzung bleibt so lange im Zustand „wird freigegeben", das Gerät zeigt eine Warnung.
9. **Vor dem Start den Ist-Zustand lesen**; läuft bereits Force-Laden, nichts senden.
10. Alle Schaltbefehle mit `await` und sauberer Fehlerbehandlung — kein Fire-and-forget.

### Vorschlag für die Struktur

- `lib/LalaClient.js` — Transport: HTTPS zuerst, HTTP als Rückfall, eigener Agent mit abgeschalteter Zertifikatsprüfung, Header wie oben, Requests serialisiert, Timeout 10 s, Kodierung und Dekodierung
- `lib/ForceChargeSession.js` — Zustandsautomat `IDLE → STARTING → ACTIVE → RELEASING → IDLE`; wird bei jedem Poll mit dem aktuellen Status ausgewertet; Uhr und Client injizierbar, damit testbar
- `drivers/senec-battery/device.js` — verdrahtet Polling, Sitzung, Flow-Karten und `onoff`
- Flow-Karten über Homey Compose, voraussichtlich `drivers/senec-battery/driver.flow.compose.json` — gegen die aktuelle SDK-Doku prüfen

### Bewusst nicht im Umfang

- **Keine Preislogik in der App.** Die kommt aus der Tibber-App und Homey-Flows.
- **Keine Entladesperre.** Nicht zuverlässig belegt.
- **Keine Cloud-API** von SENEC — nur lokal.
- **Keine Store-Veröffentlichung** vorerst; Installation per `homey app install`.

## 8. Testplan

1. **Unit-Tests** mit `node:test`, ohne Zusatzabhängigkeiten: Dekodierung, Kodierung, Begrenzung der Argumente und jede Sicherung aus Abschnitt 7 mit künstlicher Uhr und Fake-Client.
2. **Integrationstest** gegen den Mock-Server aus Abschnitt 9, über HTTPS mit selbstsigniertem Zertifikat und über HTTP.
3. **Am echten Homey:** `homey app run` mit kurzen Fristen (2 min), abends ohne PV, damit der Netzbezug eindeutig ist. Prüfen: Start, Freigabe bei Frist, Freigabe bei Ziel, Verhalten nach App-Neustart mitten in einer Sitzung.
4. Erst danach `homey app install` für den Dauerbetrieb.

`homey app run` deinstalliert die App beim Beenden mit Strg+C. `homey app install` bleibt installiert, auch ohne offenes Terminal.

## 9. Mock-Server für Tests

Getestet, bildet das Verhalten der lala.cgi nach. Ohne Zertifikatsargumente läuft er per HTTP.

```python
"""Minimaler Nachbau der SENEC lala.cgi fuer Tests.
Start HTTPS:  python mock_senec.py 18443 cert.pem key.pem
Start HTTP:   python mock_senec.py 18443
Zertifikat:   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=senec"
GET /  liefert den Zustand und alle empfangenen Requests (Testhilfe)."""
import json, ssl, struct, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"soc": 42.5, "safe": 0, "posts": []}
LOCK = threading.Lock()

def fl(v): return "fl_" + struct.pack(">f", v).hex().upper()
def u8(v): return "u8_%02X" % v

def energy_values():
    safe = STATE["safe"]
    return {
        "STAT_STATE": u8(8 if safe else 21),
        "GUI_BAT_DATA_FUEL_CHARGE": fl(STATE["soc"]),
        "GUI_BAT_DATA_POWER": fl(2500.0 if safe else -350.0),
        "GUI_GRID_POW": fl(2850.0 if safe else 12.0),
        "GUI_INVERTER_POWER": fl(0.0),
        "GUI_HOUSE_POW": fl(362.0),
        "SAFE_CHARGE_RUNNING": u8(safe),
        "SAFE_CHARGE_FORCE": u8(0), "SAFE_CHARGE_PROHIBIT": u8(0),
        "LI_STORAGE_MODE_START": u8(0), "LI_STORAGE_MODE_STOP": u8(0),
        "LI_STORAGE_MODE_RUNNING": u8(0),
    }

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"])).decode()
        req = json.loads(body)
        with LOCK:
            STATE["posts"].append({"ct": self.headers.get("Content-Type"), "body": req})
            e = req.get("ENERGY", {})
            if e.get("SAFE_CHARGE_FORCE") == "u8_01": STATE["safe"] = 1
            if e.get("SAFE_CHARGE_PROHIBIT") == "u8_01": STATE["safe"] = 0
            vals = energy_values()
            resp = {"ENERGY": {k: vals.get(k, "VARIABLE_NOT_FOUND") for k in e}}
        out = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
    def do_GET(self):
        with LOCK: out = json.dumps({"safe": STATE["safe"], "posts": STATE["posts"]}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

srv = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H)
if len(sys.argv) > 3:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(sys.argv[2], sys.argv[3])
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
```

Sinnvolle Erweiterung für die Tests: Ladestand während Force-Laden hochzählen lassen, damit „Ziel erreicht" testbar wird, und einen Modus, in dem der Mock `SAFE_CHARGE_RUNNING` von sich aus auf 0 setzt.

## 10. Sicherheit

- Die lala.cgi hat **keine Anmeldung**. Der Speicher darf **niemals** aus dem Internet erreichbar sein.
- Beim Nutzer bestand eine **Portweiterleitung zum SENEC** — soll entfernt sein. Fernzugriff nur per VPN (WireGuard im Router).
- Keine IP-Adressen, Seriennummern oder Zugangsdaten ins Repo committen.

## 11. Offene Punkte

| Frage | Warum wichtig |
|---|---|
| ~~Hat das Skript nach 10 min freigegeben oder der SENEC selbst?~~ **Geklärt 15.11.2026: Das Skript hat freigegeben** (Auto-Stopp). Wie lange der SENEC ohne Freigabe von sich aus lädt, ist weiter unbekannt. | Sicherung 7 bleibt nötig, greift aber vermutlich selten |
| Was macht der SENEC, wenn er im Force-Laden voll wird — bleibt `SAFE_CHARGE_RUNNING` auf 1? Geht der Status auf 9? | Bestimmt, ob er danach das Haus wieder versorgt, ohne dass wir freigeben |
| Netzbezug im Force-Laden noch nicht abends ohne PV bestätigt | Eindeutiger Beweis, dass aus dem Netz geladen wird |
| Firmware-Version des V3 | Für die Doku und falls sich das Protokoll unterscheidet |
| IP des SENEC | Vom Nutzer erfragen, **nicht** ins Repo |
| Später als Pull Request an das Original zurückgeben? | Erst wenn es stabil läuft |

## 12. Gesamtbild — spätere Phasen, nicht jetzt bauen

- **Abrechnung:** Bis der Smart Meter läuft, rechnet Tibber über das Standardlastprofil ab. **Netzladung kostet bis dahin nur Geld** (rund 10 % Speicherverluste, kein Preisvorteil). Preisgesteuerte Flows erst nach der Umstellung auf Viertelstunden-Abrechnung.
- **Tibber:** fertige Homey-App mit Preis-Flows — nicht selbst bauen.
- **Bosch Smart Home:** Controller II als Matter-Bridge. Kommen durch: Heizkörper- und Raumthermostate, Tür-/Fensterkontakte, Bewegungsmelder, Zwischenstecker, Dimmer, Relais. Nicht: Rollläden, Twinguard, Rauchmelder.
- **Wärmepumpe:** Viessmann Vitocal 200 von 2011, **kein SG-Ready**. Sperren über den **EVU-Sperrkontakt** der Vitotronic 200, Klemmen **X3.6/X3.7**, potentialfrei. Ansteuerung später per Shelly mit Trockenkontakt, Anschluss durch Elektrofachkraft. Laut Viessmann nicht zusammen mit einer PV-Eigenverbrauchssteuerung verdrahten. Jahresverbrauch der Wärmepumpe unbekannt — erst messen.
- **E-Auto:** Mercedes GLC 400 mit EQ Technology, mit Tibber verbunden; Ladestrom wird über ein Messkabel mit dem Arbeitgeber abgerechnet. Nicht Teil dieser App.
- **§ 14a EnWG Modul 1** noch nicht angemeldet.

## 13. Erster Schritt in Claude Code

1. Repo forken und lokal klonen
2. Diese Datei als `HANDOFF.md` ins Repo-Wurzelverzeichnis legen, `senec_test.py` nach `tools/`
3. In der vorhandenen `CLAUDE.md` eine Zeile ergänzen: *„Vor der Arbeit `HANDOFF.md` lesen."*
4. Erst `lib/LalaClient.js` mit Tests, dann `lib/ForceChargeSession.js` mit Tests — bevor irgendetwas an `device.js` geändert wird
