# CLAUDE.md

**Vor der Arbeit `HANDOFF.md` lesen.** Sie beschreibt den Fork (Force-Laden mit Ladeziel, Zeitlimit und Sicherungen) und gilt zusätzlich zu dieser Datei. Nutzerdoku: `README.md`, Testablauf am Homey: `TESTANLEITUNG.md`.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homey app (SDK v3, Homey Compose) for SENEC batteries. Reads the battery locally via `lala.cgi` and charges it from the grid safely (target, time limit, safeguards). It never decides *when* to charge: Homey Flows with the Tibber and PV Forecast apps do that and use this app's flow cards.

## Development Commands

- `npm test` – node:test suite (no Homey, no battery needed: mock `lala.cgi` + fake Homey)
- `npm run lint` – ESLint (eslint-config-athom); also `npx eslint lib test drivers app.js widgets`
- `homey app validate` – builds `app.json` from compose files and validates
- `homey app run --remote` – run on Homey Pro (without `--remote` the CLI uses Docker)
- `homey app install` – install permanently

`app.json` is generated. Edit `.homeycompose/`, `drivers/*/driver.compose.json`, `drivers/*/driver.flow.compose.json`, `widgets/*/widget.compose.json` instead.

## Architecture

- `lib/LalaClient.js` – transport: HTTPS first, HTTP fallback, form-urlencoded headers exactly as tested on the device, serialized requests, 10 s timeout, decoding of `typ_hex` values. Commands are fixed strings (see HANDOFF.md §5).
- `lib/ForceChargeSession.js` – state machine `IDLE → STARTING → ACTIVE → RELEASING → IDLE` with all ten safeguards; clock, sleep, client and store are injected. Every change here needs a test.
- `lib/senecData.js` – one poll request for energy + wallbox, `parsePoll()`.
- `lib/senecStates.js`, `lib/chargeText.js` – display texts, switch state.
- `drivers/senec-battery/device.js` – wires polling (3 s, backoff to 60 s), session (store key `forceChargeSession`), capability `onoff` + custom `force_charge_status`, notifications, warnings, dashboard state. Emits `senec-data` on the app for the solar/grid/consumption devices.
- `drivers/senec-battery/driver.js` – registers flow cards `force_charge_start`, `force_charge_release`, `force_charge_active`; device triggers `force_charge_ended`.
- `app.js` – registry of the battery device, data and actions for widgets.
- `widgets/energy-flow`, `widgets/grid-charge` – dashboard widgets, polling their `api.js` every 5 s.

## Rules

- Only release charges the app started itself; never touch a SENEC safety charge (HANDOFF.md, decisions of 15.11.2026).
- No IP addresses, serial numbers or credentials in the repo.
- Commits use the GitHub noreply address of the repo owner.
