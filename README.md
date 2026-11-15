# Senec Connector – mit sicherer Netzladung

Homey-App für SENEC-Speicher. Sie zeigt PV, Speicher, Hausverbrauch, Netz und Wallbox in Homey und lädt den Speicher auf Wunsch aus dem Netz, immer mit Ladeziel, Zeitlimit und Sicherungen.

Fork von [Dbone29/senec-connector](https://github.com/Dbone29/senec-connector) (MIT). Neu in diesem Fork: sichere Netzladung, Flow-Karten, Benachrichtigungen, Dashboard-Widgets und Wallbox-Werte.

> **Status:** Mit 68 automatischen Tests und gegen einen echten SENEC.Home V3 (nur lesend) geprüft. Der Test am echten Homey steht noch aus, siehe [TESTANLEITUNG.md](TESTANLEITUNG.md).

## Wofür die App da ist – und wofür nicht

Die App **führt aus**: Sie liest den Speicher und lädt sicher aus dem Netz. Sie **entscheidet nicht**, wann sich das lohnt. Das übernehmen Homey-Flows mit den fertigen Apps *Tibber* (Strompreise) und *PV Forecast* (PV-Prognose). Flows erreichen den Speicher nur über die Flow-Karten dieser App, deshalb gelten die Sicherungen auch für jeden Flow.

## Funktionen

### Geräte

| Gerät | Zeigt |
|---|---|
| Senec-Batterie | Ladestand, Leistung, Spannung, Strom, geladene und entladene Energie, Schalter und Status der Netzladung |
| Senec Solar/Wechselrichter | PV-Leistung, erzeugte Energie |
| Senec Netzanschluss | Bezug und Einspeisung, Leistung und Energie |
| Senec Hausverbrauch | Verbrauch, Leistung und Energie |

Alle Geräte erscheinen im Energie-Tab von Homey. Die Werte werden alle 3 Sekunden aktualisiert, lokal über das Heimnetz.

### Netzladung

- **Schalter „Netzladung“** am Batterie-Gerät: lädt mit den Standardwerten aus den Geräteeinstellungen (ab Werk 80 % und 120 min).
- **Flow-Karte** mit eigenen Werten (siehe unten).
- **Status als Text** am Gerät, zum Beispiel „Lädt bis 80 % · noch 98 min“, „Bereit“ oder „SENEC lädt selbst“.

### Sicherungen

1. Jede Ladung hat ein Ziel (50–100 %) und eine Höchstdauer, **hart begrenzt auf 180 Minuten**.
2. Freigabe, sobald das Ziel erreicht ist.
3. Freigabe, sobald die Zeit abgelaufen ist, auch wenn der Speicher gerade nicht antwortet.
4. Eine laufende Ladung übersteht einen Neustart von App oder Homey. Ist die Zeit danach um, wird freigegeben.
5. Die App beendet **nur Ladungen, die sie selbst gestartet hat**. Eine Sicherheitsladung des SENEC wird nie angefasst, auch nicht auf Wunsch.
6. Beim Beenden der App und beim Löschen des Geräts wird die eigene Ladung freigegeben.
7. Beendet der Speicher die Ladung selbst, endet auch die Sitzung, ohne Neustart.
8. Schlägt die Freigabe fehl, wird sie wiederholt, bis sie durchgeht. Das Gerät zeigt eine Warnung.
9. Vor jedem Start wird der Ist-Zustand gelesen. Läuft schon eine Ladung oder ist das Ziel erreicht, wird nichts gesendet.
10. Schlägt der Startbefehl fehl, wird sicherheitshalber sofort freigegeben.

Ein neuer Start während der eigenen Ladung übernimmt die neuen Werte, die Zeit läuft dann ab jetzt.

### Flow-Karten

| Karte | Art | Werte |
|---|---|---|
| Aus dem Netz laden bis [Ziel] %, höchstens [Minuten] min | Aktion | Ziel 50–100 %, Minuten 1–180. Schlägt mit Meldung fehl, wenn das Ziel erreicht ist oder der Speicher selbst lädt |
| Speicher freigeben | Aktion | Beendet die eigene Ladung |
| Netzladung ist / ist nicht aktiv | Bedingung | Zählt nur Ladungen dieser App |
| Netzladung beendet | Auslöser | `reason` (Code), `reason_text`, `soc` (Ladestand), `duration_min` |

Mögliche Gründe für `reason`: `ziel_erreicht`, `zeit_abgelaufen`, `manuell`, `vom_speicher_beendet`, `app_neustart`, `fehler`.

### Beispiel: Nachts günstig laden

Schwellen als Homey-Variablen anlegen (`Automatik_aktiv`, `Preis_max_ct`, `PV_Schwelle_kWh`, `Ladeziel_Prozent`, `Ladedauer_min`), dann:

1. **Wenn** (Tibber): Preis gehört zu den günstigsten Stunden zwischen 22 und 6 Uhr
2. **Und:** `Automatik_aktiv` ist Ja
3. **Und** (Tibber): aktueller Preis ≤ `Preis_max_ct`
4. **Und** (PV Forecast): Prognose für morgen < `PV_Schwelle_kWh`
5. **Und** (diese App): Netzladung ist nicht aktiv
6. **Dann** (diese App): Aus dem Netz laden bis `Ladeziel_Prozent` %, höchstens `Ladedauer_min` min

Die genauen Kartennamen von Tibber und PV Forecast können abweichen. Ohne Smart Meter mit Viertelstunden-Abrechnung bringt das keinen Preisvorteil. Bis dahin besser nur eine Benachrichtigung „würde jetzt laden“ schicken.

### Benachrichtigungen

- Netzladung gestartet, mit Quelle (Schalter, Flow, Dashboard), Ziel und Höchstdauer
- Netzladung beendet, mit Grund, Ladestand und Dauer
- Freigabe fehlgeschlagen (immer)

Start und Ende lassen sich in den Geräteeinstellungen abschalten.

### Dashboard-Widgets

| Widget | Inhalt |
|---|---|
| SENEC Energiefluss | PV, Speicher, Netz, Haus und Wallbox als Kreise mit Flusslinien, wie in der SENEC-App |
| SENEC Netzladung | Ladestand mit Ziel, Status, Restzeit, letzte Ladung, Knöpfe „Jetzt laden“ (mit Bestätigung) und „Freigeben“ |

### Geräteeinstellungen (Senec-Batterie)

| Einstellung | Standard | Bedeutung |
|---|---|---|
| IP-Adresse | – | Adresse des SENEC im Heimnetz |
| Ladeziel | 80 % | für den Schalter und das Widget |
| Höchstdauer | 120 min | für den Schalter und das Widget, höchstens 180 |
| Netzladung gestartet | an | Benachrichtigung |
| Netzladung beendet | an | Benachrichtigung |

### Wallbox

Ist eine Wallbox am SENEC angemeldet, zeigt das Energiefluss-Widget ihre Ladeleistung und ob ein Auto angeschlossen ist.

## Voraussetzungen

- Homey Pro mit Firmware **12.3 oder neuer** (Widgets)
- SENEC.Home V3 (V2 vermutlich ebenfalls), im Heimnetz erreichbar
- **Keine Portweiterleitung zum SENEC.** Die Schnittstelle `lala.cgi` hat keine Anmeldung. Fernzugriff nur per VPN.

## Installation und Entwicklung

```bash
npm install
npm test                 # 68 Tests, ohne Homey und ohne Speicher
npm run lint
homey app validate
homey app run --remote   # auf dem Homey Pro starten, Logs im Terminal
homey app install        # dauerhaft installieren
```

`--remote` ist auf dem Homey Pro (2023 und neuer) nötig, sonst will die CLI die App in Docker auf dem PC starten. Den Testablauf für den ersten Lauf beschreibt [TESTANLEITUNG.md](TESTANLEITUNG.md).

**Windows auf ARM:** Bricht die Homey CLI mit einer Meldung zu `sharp` ab, im Ordner `%APPDATA%\npm\node_modules\homey` einmal `npm install --no-save sharp@0.34` ausführen.

## Aufbau

```
lib/
  LalaClient.js          Verbindung zur lala.cgi: HTTPS mit Rückfall auf HTTP, Anfragen nacheinander, Dekodierung
  ForceChargeSession.js  Zustandsautomat der Netzladung mit allen Sicherungen
  senecData.js           eine Abfrage für alle Messwerte, Auswertung, Wallbox-Status
  senecStates.js         Klartexte der SENEC-Statuscodes
  chargeText.js          Status-Text und Schalterstellung
drivers/                 die vier Geräte; senec-battery verbindet Abfrage, Sitzung, Flow-Karten
widgets/                 Energiefluss und Netzladung
test/                    node:test, Mock der lala.cgi, nachgebauter Homey
tools/senec_test.py      Referenzskript, am Gerät getestet
HANDOFF.md               Hintergrund, Protokoll der Schnittstelle, Entscheidungen
```

Die App nutzt Homey Compose: `app.json` wird aus `.homeycompose/`, `drivers/*/driver*.compose.json` und `widgets/*/widget.compose.json` erzeugt und nicht von Hand bearbeitet.

## Quellen

Das Protokoll der `lala.cgi` stammt aus [marq24/ha-senec-v3](https://github.com/marq24/ha-senec-v3) und dem Original-Connector. Es ist inoffiziell und undokumentiert. Nutzung auf eigenes Risiko.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Original von Daniel Busenius.
