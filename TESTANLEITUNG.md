# Testanleitung: SENEC-App auf dem Homey Pro

Ziel: Die App am echten Homey prüfen, bevor sie dauerhaft installiert wird. Dauer etwa 1 Stunde, am besten **abends ohne PV**, damit der Netzbezug eindeutig ist.

## Vorbereitung

1. **Homey einrichten** und die Firmware aktualisieren. Die App braucht **Homey 12.3 oder neuer** (Einstellungen → Allgemein → Software).
2. **Portweiterleitung zum SENEC** in der Fritzbox entfernen. `lala.cgi` hat keine Anmeldung.
3. Im Terminal im Ordner `senec-connector`:

   ```
   homey login
   homey select
   ```

   `homey select` fragt, welcher Homey genutzt wird.
4. Die App heißt „Senec Energie Manager“ und hat eine eigene App-ID. Sie läuft unabhängig von der Store-App „Senec Connector“. Ist diese installiert, besser entfernen, damit der Speicher nicht doppelt abgefragt wird.

## Starten

```
homey app run --remote
```

`--remote` ist nötig: Ohne läuft die App in Docker auf dem PC. Die Logs erscheinen im Terminal. **Strg+C beendet die App und entfernt sie vom Homey**, eine laufende Ladung wird dabei freigegeben.

## Tests

Nach jedem Schritt in der SENEC-App gegenprüfen.

| # | Schritt | Erwartet |
|---|---|---|
| 1 | Gerät hinzufügen: „Senec-Batterie“ mit der IP deines SENEC. Optional Solar, Netz, Hausverbrauch | Ladestand, Leistung und Status „Bereit“ stimmen mit der SENEC-App überein |
| 2 | Geräteeinstellungen: Höchstdauer **2 min** | – |
| 3 | Schalter **Netzladung an** | Benachrichtigung „Netzladung gestartet (Schalter)“. Status „Lädt bis 80 % · noch 2 min“. In der SENEC-App Netzbezug und Speicher lädt |
| 4 | Warten | Nach 2 min automatisch frei. Benachrichtigung „Netzladung beendet: Zeit abgelaufen“. Schalter aus |
| 5 | Höchstdauer 30 min, Ladeziel = aktueller Ladestand + 1. Schalter an | Freigabe, sobald das Ziel erreicht ist (ca. 3–5 min). Grund „Ziel erreicht“ |
| 6 | Schalter an, nach 1 min Schalter aus | Grund „Von Hand beendet“ |
| 7 | Flow anlegen: Wenn „Netzladung beendet“ → Benachrichtigung mit Grund und Ladestand | Benachrichtigung bei den nächsten Tests |
| 8 | Flow manuell starten: „Aus dem Netz laden bis 60 %, höchstens 2 min“ | Benachrichtigung „(Flow)“, Ende nach 2 min, Flow aus Schritt 7 meldet sich |
| 9 | Während der Flow aus Schritt 8 lädt: Flow mit 70 % und 5 min erneut starten | Neue Werte übernommen: „Lädt bis 70 % · noch 5 min“, kein zweiter Startbefehl, keine neue Benachrichtigung |
| 10 | Dashboard: Widgets „SENEC Energiefluss“ und „SENEC Netzladung“ hinzufügen | Werte wie in der SENEC-App, Wallbox „frei“. „Jetzt laden“ fragt einmal nach |
| 11 | Höchstdauer 2 min wieder auf 120 min stellen | – |

## Neustart-Test (nach `homey app install`)

```
homey app install
```

Die App bleibt dann installiert, auch ohne Terminal.

| # | Schritt | Erwartet |
|---|---|---|
| 12 | Höchstdauer 5 min, Schalter an | Ladung läuft |
| 13 | Homey-App → Einstellungen → Apps → Senec Energie Manager → **Neu starten** | Ladung wird beim Beenden freigegeben, nach dem Start Status „Bereit“ |
| 14 | Schalter an, dann den **Homey neu starten** (Strom kurz weg) | Nach dem Hochfahren: Frist noch nicht um → Ladung läuft weiter. Frist um → Freigabe, Grund „Nach Neustart der App beendet“ |

## Notfall

Lädt der Speicher und die App reagiert nicht:

1. Schalter „Netzladung“ aus.
2. Sonst `senec_test.py` starten und **Freigeben** drücken.
3. Sonst die SENEC-Weboberfläche unter `https://<SENEC-IP>`.

## Bekannt

- Homey CLI auf Windows ARM: Falls `homey` mit einer Meldung zu `sharp` abbricht (z. B. nach einem Update der CLI), im Ordner `%APPDATA%\npm\node_modules\homey` einmal `npm install --no-save sharp@0.34` ausführen.
- Wallbox-Leistung ist nur mit angeschlossenem, ladendem Auto prüfbar.
- Preis-Widget (A10) ist nicht gebaut. Erst prüfen, ob es ein fertiges gibt.
