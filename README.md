# A4 Bus Survey

Offline-first web app (PWA) for the roadside bus survey of the
**Feasibility Study for Widening of the Godagama – Avissawella Road (A4) into 4 lanes**.
One record per bus passing the O-D station.

## What the recorder does

1. **Shift setup:** recorder name and the survey station, **OD 1 – OD 7** (from
   `OD_Survey_Locations_Map.kmz`). The phone's GPS marks the nearest station.
2. **For each bus:**
   1. **Route**: tap a quick pick (routes recorded most at this station and routes that
      pass it), or search by number or town (e.g. `122`, `Kosgama`). If it is not in the
      list, **add it** (route number, end A, end B).
   2. **Direction**: A → B or B → A (e.g. *Colombo → Avissawella* / *Avissawella → Colombo*).
   3. **Operator**: SLTB / Private.
   4. **Service type**: Normal, Semi-luxury, Luxury (A/C), Intercity / Expressway.
   5. **Bus size**: Large bus / Minibus.
   6. **Occupancy level**: less than half the seats taken, about half, all seats taken,
      all seats + some standing, crowded (full standing).
3. **Save bus.** Date, time, Record No. (e.g. `KW-20261103-0042`) and GPS are added
   automatically. Records are stored on the phone first and sent to the Google Sheet in
   batches whenever there is internet. **Undo** deletes the last bus if not yet sent.

## Shared bus routes

- `config.js → routes` holds the starting list (route number, both ends, stations it
  passes). Sources: SLTB Avissawella and Homagama depot route lists and Wikipedia
  (A4 road, Padukka). Route numbers change over time, so check them in the field.
- A route added on any phone is sent with its records to the sheet's **Routes** tab and
  appears in every phone's suggestions within a few minutes (and at start-up).
- You can also type routes straight into the **Routes** tab (Route No, End A, End B,
  Stations such as `OD 3, OD 4`), or delete a row to stop suggesting it.
- A route is the same whichever way round its ends are written.

## Setting up

1. **Backend:** follow the steps at the top of `backend/a4_bus_apps_script.js`
   (new Google Sheet in a personal Gmail account → Extensions → Apps Script → paste →
   run `setup` → deploy as a Web app, *Execute as: Me*, *Who has access: Anyone*).
2. Put the `/exec` URL in `config.js` → `appsScriptUrl`.
3. Bump `CACHE_NAME` in `sw.js` whenever app files change.

## In the Google Sheet

- `a4-bus-survey`: one row per bus.
- `Routes`: routes added by the enumerators (with stations and how often recorded).
- Menu **A4 Bus Survey → Build / refresh summary**: buses per station, route and
  direction by hour, plus the occupancy level mix.
