Monitor your SENEC battery storage system in Homey and charge it from the grid safely.

Features:
- Real-time monitoring of battery, solar production, grid power, home consumption and wallbox
- Grid charging with a target charge level and a time limit (at most 180 minutes); the app releases the battery automatically
- Safety first: only charges started by this app are ever stopped, a SENEC safety charge is never touched, a running charge survives app restarts
- Flow cards: charge from grid to a target, release battery, condition "grid charging is active", trigger "grid charging ended" with reason, charge level and duration
- Notifications when grid charging starts and ends
- Dashboard widgets: energy flow and grid charging
- Energy Tab integration with cumulative energy meters
- Local LAN connection, updates every 3 seconds

Supported devices:
- SENEC Battery: charge level, voltage, current, power, grid charging switch and status
- SENEC Solar/Inverter: solar power and energy generated
- SENEC Grid Connection: grid import/export power and energy
- SENEC Home Consumption: house power and energy

Requirements:
- Homey Pro with firmware 12.3 or higher
- SENEC battery system reachable in your local network (do not expose it to the internet)

Setup:
1. Add the SENEC Battery device and enter the IP address of your SENEC system
2. Optionally add the Solar, Grid and Consumption devices
3. Adjust target and maximum duration for the grid charging switch in the device settings
