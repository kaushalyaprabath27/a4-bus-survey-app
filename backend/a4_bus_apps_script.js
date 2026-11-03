/**
 * A4 GODAGAMA - AVISSAWELLA WIDENING (FEASIBILITY STUDY) - ROADSIDE BUS SURVEY
 * APPS SCRIPT BACKEND
 *
 * One row per bus recorded at an O-D station (route, direction, operator,
 * service type, bus size, occupancy level). Bus routes added by enumerators
 * are kept in the "Routes" tab and served to every phone as suggestions.
 *
 * HOW TO DEPLOY:
 * 1. Create a new Google Sheet (e.g. "A4 Bus Survey Data") in a personal
 *    Gmail account (university accounts often cannot share with "Anyone").
 * 2. In that sheet: Extensions > Apps Script.
 * 3. Delete the sample code, paste ALL of this file, press Ctrl+S.
 * 4. Select the function "setup" in the toolbar and click Run once
 *    (approve the permissions). This creates the data and Routes tabs.
 * 5. Deploy > New deployment > type "Web app":
 *      Execute as: Me
 *      Who has access: Anyone
 *    Click Deploy and copy the Web app URL (ends in /exec).
 * 6. Paste that URL into config.js in the app (appsScriptUrl).
 *
 * UPDATING THE CODE LATER:
 *    Deploy > Manage deployments > Edit (pencil) > Version: "New version"
 *    > Deploy. The URL stays the same.
 *
 * ROUTES TAB: you can also type routes there yourself (Route No, End A,
 * End B; Stations optional, e.g. "OD 3, OD 4"). Phones pick them up within
 * a few minutes. Delete a row to stop suggesting that route.
 *
 * SUMMARY: menu "A4 Bus Survey" > Build / refresh summary writes a "Summary"
 * tab: buses per station, route and direction by hour, and the occupancy
 * level mix for each route and direction.
 */

const DATA_SHEET_NAME = "a4-bus-survey";
const ROUTES_SHEET_NAME = "Routes";
const SUMMARY_SHEET_NAME = "Summary";

// [sheet header, record field, type]
const COLUMNS = [
  ["Record No", "recordNo", "text"],
  ["Recorder", "name", "text"],
  ["Station", "station", "text"],
  ["Station Road", "stationRoad", "text"],
  ["Shift Start", "shiftStart", "text"],
  ["Date", "date", "text"],
  ["Time", "time", "text"],
  ["GPS Lat", "gpsLat", "num"],
  ["GPS Lon", "gpsLon", "num"],
  ["GPS Accuracy (m)", "gpsAccuracyM", "num"],
  ["GPS Status", "gpsStatus", "text"],
  ["Route No", "routeNo", "text"],
  ["Route End A", "routeA", "text"],
  ["Route End B", "routeB", "text"],
  ["Direction", "direction", "text"],
  ["From", "fromEnd", "text"],
  ["To", "toEnd", "text"],
  ["Operator", "operator", "text"],
  ["Service Type", "serviceType", "text"],
  ["Bus Size", "busSize", "text"],
  ["Occupancy Level", "occupancy", "text"],
  ["Route Source", "routeSource", "text"],
  ["EventID", "eventId", "text"]
];
const HEADERS = COLUMNS.map(function (c) { return c[0]; });
const EVENT_ID_COL = HEADERS.indexOf("EventID") + 1; // 1-based
const ROUTE_HEADERS = ["Route No", "End A", "End B", "Stations", "Added By", "Added At", "Times Recorded"];

const MAX_BATCH_SIZE = 200;
const GLOBAL_RATE_LIMIT_PER_MIN = 300;
const LOCK_WAIT_MS = 30000;

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------
function doPost(e) { return handleRequest(e); }
function doGet(e) { return handleRequest(e); }

function handleRequest(e) {
  if (!checkGlobalRateLimit()) {
    return responseJson({ status: "error", message: "Too many requests. Please try again shortly." });
  }
  try {
    let data = {};
    if (e && e.postData && e.postData.contents) {
      try { data = JSON.parse(e.postData.contents); } catch (err) {}
    }
    const params = (e && e.parameter) || {};
    for (const key in params) data[key] = params[key];

    const action = data.action;
    if (action === "submit_a4bus_v1") return handleSubmitBatch(data);
    if (action === "routes") return responseJson({ status: "success", routes: readRoutes() });
    if (!action) return responseJson({ status: "success", message: "A4 bus survey backend is running." });
    return responseJson({ status: "error", message: "Invalid action" });
  } catch (error) {
    return responseJson({ status: "error", message: error.toString() });
  }
}

// ---------------------------------------------------------------------
// Batch write (+ new routes into the Routes tab)
// ---------------------------------------------------------------------
function handleSubmitBatch(data) {
  const payload = Array.isArray(data.payload) ? data.payload : [];
  if (payload.length === 0) return responseJson({ status: "success", count: 0, duplicatesSkipped: 0 });
  if (payload.length > MAX_BATCH_SIZE) {
    return responseJson({ status: "error", message: "Batch too large (max " + MAX_BATCH_SIZE + ")." });
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return responseJson({ status: "error", message: "Server busy. The app will retry automatically." });
  }
  try {
    const sheet = getDataSheet();
    const existing = getExistingEventIds(sheet);
    const rows = [];
    const added = [];
    let duplicatesSkipped = 0;
    for (let i = 0; i < payload.length; i++) {
      const item = payload[i];
      if (!item || typeof item !== "object") continue;
      const id = item.eventId ? String(item.eventId) : "";
      if (id && existing[id]) { duplicatesSkipped++; continue; }
      if (id) existing[id] = true;
      rows.push(toRow(item));
      if (item.routeSource === "added" && item.routeA && item.routeB) added.push(item);
    }
    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    }
    if (added.length) addRoutes(added);
    SpreadsheetApp.flush();
    return responseJson({ status: "success", count: rows.length, duplicatesSkipped: duplicatesSkipped });
  } finally {
    lock.releaseLock();
  }
}

function toRow(item) {
  return COLUMNS.map(function (c) {
    const v = item[c[1]];
    if (c[2] === "num") return num(v);
    return text(v, 300);
  });
}

// ---------------------------------------------------------------------
// Routes tab: one row per route added by an enumerator (or typed in by you)
// ---------------------------------------------------------------------
function normRoute(s) {
  return String(s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9\/]+/g, " ").trim();
}
function routeKey(no, a, b) { return [normRoute(no)].concat([normRoute(a), normRoute(b)].sort()).join("|"); }

function getRoutesSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(ROUTES_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(ROUTES_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, ROUTE_HEADERS.length).setValues([ROUTE_HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function addRoutes(items) {
  const sheet = getRoutesSheet();
  const last = sheet.getLastRow();
  const values = last > 1 ? sheet.getRange(2, 1, last - 1, ROUTE_HEADERS.length).getValues() : [];
  const index = {};
  values.forEach(function (r, i) { index[routeKey(r[0], r[1], r[2])] = i; });
  const newRows = [];
  items.forEach(function (it) {
    const k = routeKey(it.routeNo, it.routeA, it.routeB);
    if (k in index) {
      // Seen before (in the tab or earlier in this batch): count it and note the station.
      const i = index[k];
      const row = i < values.length ? values[i] : newRows[i - values.length];
      row[6] = (Number(row[6]) || 0) + 1;
      const st = String(row[3] || "");
      if (it.station && st.split(/\s*,\s*/).indexOf(it.station) === -1) row[3] = st ? st + ", " + it.station : it.station;
      return;
    }
    index[k] = values.length + newRows.length;
    newRows.push([text(it.routeNo, 40), text(it.routeA, 80), text(it.routeB, 80), text(it.station, 80), text(it.name, 80),
                  text((it.date || "") + " " + (it.time || ""), 40), 1]);
  });
  if (values.length) sheet.getRange(2, 1, values.length, ROUTE_HEADERS.length).setValues(values);
  if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, ROUTE_HEADERS.length).setValues(newRows);
}

function readRoutes() {
  const sheet = getRoutesSheet();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, ROUTE_HEADERS.length).getValues()
    .filter(function (r) { return String(r[1]).trim() && String(r[2]).trim(); })
    .map(function (r) {
      return {
        no: String(r[0]).trim(), a: String(r[1]).trim(), b: String(r[2]).trim(),
        stations: String(r[3] || "").split(/\s*,\s*/).filter(String)
      };
    });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function text(v, maxLen) {
  if (v === undefined || v === null) return "";
  let s = String(v).trim().slice(0, maxLen || 300);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // never run typed text as a formula
  return s;
}
function num(v) {
  if (v === "" || v === null || v === undefined) return "";
  const n = Number(v);
  return isFinite(n) ? n : "";
}

function getSpreadsheet() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("SHEET_ID");
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  const ss = SpreadsheetApp.create("A4 Bus Survey Data");
  props.setProperty("SHEET_ID", ss.getId());
  return ss;
}

function getDataSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (sheet && !hasCurrentHeaders(sheet)) {
    if (sheet.getLastRow() <= 1) sheet.clear();
    else {
      sheet.setName(DATA_SHEET_NAME + " (old " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HHmm") + ")");
      sheet = null;
    }
  }
  if (!sheet) sheet = ss.insertSheet(DATA_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function hasCurrentHeaders(sheet) {
  if (sheet.getLastRow() === 0) return true;
  if (sheet.getLastColumn() !== HEADERS.length) return false;
  const row = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  return row.every(function (v, i) { return String(v) === HEADERS[i]; });
}

function getExistingEventIds(sheet) {
  const seen = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return seen;
  const values = sheet.getRange(2, EVENT_ID_COL, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) if (values[i][0]) seen[String(values[i][0])] = true;
  return seen;
}

function responseJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkGlobalRateLimit() {
  const cache = CacheService.getScriptCache();
  const key = "global_rate_limit";
  const count = parseInt(cache.get(key) || "0", 10);
  if (count >= GLOBAL_RATE_LIMIT_PER_MIN) return false;
  cache.put(key, String(count + 1), 60);
  return true;
}

// Run once from the editor: creates the tabs and asks for the permissions.
function setup() {
  const sheet = getDataSheet();
  getRoutesSheet();
  Logger.log("Sheet ready: " + sheet.getParent().getUrl());
}

// ---------------------------------------------------------------------
// Summary (menu: A4 Bus Survey > Build / refresh summary)
// ---------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("A4 Bus Survey")
    .addItem("Build / refresh summary", "buildSummary")
    .addToUi();
}

function buildSummary() {
  const ss = getSpreadsheet();
  const data = getDataSheet().getDataRange().getValues();
  const col = {};
  HEADERS.forEach(function (h, i) { col[h] = i; });
  const OCC = ["Less than half the seats taken", "About half the seats taken", "All seats taken", "All seats + some standing", "Crowded (full standing)"];

  const hours = {};
  const groups = {}; // station|route|direction -> { hour -> n, total, occ -> n }
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const hour = String(row[col["Time"]] || "").slice(0, 2) || "??";
    hours[hour] = true;
    const route = [row[col["Route No"]], row[col["Route End A"]] + " – " + row[col["Route End B"]]].filter(String).join(" · ");
    const k = [row[col["Station"]], route, row[col["Direction"]] || "(no direction)"].join("|");
    const g = groups[k] = groups[k] || { total: 0, hours: {}, occ: {} };
    g.total++;
    g.hours[hour] = (g.hours[hour] || 0) + 1;
    const o = String(row[col["Occupancy Level"]] || "(blank)");
    g.occ[o] = (g.occ[o] || 0) + 1;
  }
  const hourList = Object.keys(hours).sort();
  const occList = OCC.concat(["(blank)"]);
  const head = ["Station", "Route", "Direction", "Total buses"].concat(hourList.map(function (h) { return h + ":00"; }), occList);
  const out = [head];
  Object.keys(groups).sort().forEach(function (k) {
    const g = groups[k];
    out.push(k.split("|").concat([g.total], hourList.map(function (h) { return g.hours[h] || 0; }), occList.map(function (o) { return g.occ[o] || 0; })));
  });

  let sheet = ss.getSheetByName(SUMMARY_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SUMMARY_SHEET_NAME);
  sheet.clear();
  sheet.getRange(1, 1, out.length, head.length).setValues(out);
  sheet.getRange(1, 1, 1, head.length).setFontWeight("bold");
  sheet.setFrozenRows(1);
  sheet.getRange(out.length + 2, 1).setValue("Buses recorded: " + (data.length - 1) +
    ". Hour columns count buses by the hour they passed; the last columns show the occupancy level mix.");
  sheet.autoResizeColumns(1, head.length);
}
