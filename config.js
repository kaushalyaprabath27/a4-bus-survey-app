// Settings for this deployment. Edit here, not in app.js.
window.A4BUS_CONFIG = {
    // Google Apps Script Web App URL (Deploy > Manage deployments, ends in /exec).
    // Until this is set, records are kept safely on the device and are NOT sent.
    appsScriptUrl: '',

    projectName: 'A4 Godagama – Avissawella widening (feasibility study)',

    // O-D survey stations (from OD_Survey_Locations_Map.kmz).
    stations: [
        { id: 'OD 1', road: 'A8 Panadura – Ratnapura Hwy', place: 'Near Ingiriya junction (Ratnapura side)', lat: 6.743821, lon: 80.172584 },
        { id: 'OD 2', road: 'AB10 Hanwella – Kaduwela Rd', place: 'Near Hanwella junction (west)', lat: 6.910904, lon: 80.087843 },
        { id: 'OD 3', road: 'A4 Colombo – Avissawella Hwy', place: 'West of Meepe junction', lat: 6.857184, lon: 80.089935 },
        { id: 'OD 4', road: 'A4 Colombo – Avissawella Hwy', place: 'Between Kosgama and Puwakpitiya', lat: 6.939288, lon: 80.163000 },
        { id: 'OD 5', road: 'B240 Kotte – Bope Rd', place: 'Between Padukka and Godagama', lat: 6.843412, lon: 80.061190 },
        { id: 'OD 6', road: 'A4 Colombo – Avissawella Hwy', place: 'Near Godagama junction (east)', lat: 6.852403, lon: 80.035360 },
        { id: 'OD 7', road: 'A7 Avissawella – Hatton Hwy', place: 'Near Talduwa junction (east)', lat: 6.956524, lon: 80.221443 }
    ],

    // Bus routes offered as suggestions: [route no, end A, end B, stations it passes].
    // Each route can be recorded in both directions (A → B and B → A). Routes the
    // enumerators add are shared to every phone through the Google Sheet.
    // Sources: SLTB Avissawella and Homagama depot route lists, Wikipedia (A4 road,
    // Padukka). Numbers can change: enumerators can add or correct routes in the app.
    routes: [
        ['122', 'Colombo', 'Avissawella', ['OD 6', 'OD 3', 'OD 4']],
        ['122', 'Colombo', 'Ratnapura', ['OD 6', 'OD 3', 'OD 4']],
        ['122/1', 'Ratmalana', 'Avissawella', ['OD 6', 'OD 3', 'OD 4']],
        ['122/2', 'Colombo', 'Kosgama', ['OD 6', 'OD 3']],
        ['122/3', 'Colombo', 'Kaluaggala', ['OD 6', 'OD 3']],
        ['122/4', 'Colombo', 'Homagama', []],
        ['99', 'Colombo', 'Badulla', ['OD 6', 'OD 3', 'OD 4']],
        ['18/2', 'Colombo', 'Hatton', ['OD 6', 'OD 3', 'OD 4', 'OD 7']],
        ['23', 'Colombo', 'Maskeliya', ['OD 6', 'OD 3', 'OD 4', 'OD 7']],
        ['23/1', 'Avissawella', 'Maskeliya', ['OD 7']],
        ['69/5', 'Kandy', 'Avissawella', ['OD 7']],
        ['674/3', 'Kegalle', 'Avissawella', ['OD 7']],
        ['67', 'Colombo', 'Rakwana', ['OD 6', 'OD 3', 'OD 4']],
        ['470', 'Avissawella', 'Balangoda', []],
        ['470/2', 'Avissawella', 'Ratnapura', []],
        ['124', 'Colombo', 'Ihala Bope', ['OD 6', 'OD 5']],
        ['125', 'Colombo', 'Ingiriya', ['OD 6', 'OD 5']],
        ['125/1', 'Colombo', 'Idangoda', ['OD 6', 'OD 5']],
        ['125/3', 'Colombo', 'Kudauduwa', ['OD 6', 'OD 5']],
        ['125/4', 'Colombo', 'Dambara', ['OD 6', 'OD 5']],
        ['125/5', 'Colombo', 'Padukka', ['OD 6', 'OD 5']],
        ['126', 'Colombo', 'Avissawella (via Padukka)', ['OD 6', 'OD 5']],
        ['126/1', 'Avissawella', 'Ingiriya (via Padukka)', []],
        ['143', 'Colombo', 'Hanwella (via Kaduwela)', ['OD 2']],
        ['293', 'Homagama', 'Hanwella', ['OD 6', 'OD 3']],
        ['182', 'Padukka', 'Hanwella', []],
        ['239', 'Avissawella', 'Padukka', []],
        ['239/1', 'Padukka', 'Madakada', []],
        ['315', 'Horana', 'Meepe', []],
        ['315/182/1', 'Horana', 'Kandy', []],
        ['3', 'Homagama', 'Kataragama (via Ingiriya)', ['OD 1']],
        ['', 'Panadura', 'Ratnapura', ['OD 1']],
        ['', 'Horana', 'Ratnapura', ['OD 1']]
    ],

    // Shared routes are re-read from the sheet this often while online.
    routeRefreshMinutes: 5
};
