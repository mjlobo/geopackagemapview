# GeoPackage Map Viewer

This repository contains two ways to view GeoPackages with MapLibre.

## 1. Backend-driven viewer

This is the main application. It uses the Node.js backend in [server.js](/Users/mjlobo/Code/bdmapvis2/server.js) to:
- read a GeoPackage from `data/`
- upload a new GeoPackage to the server
- expose metadata and features to the frontend

### Run it

```bash
npm start
```

Open:

```text
http://127.0.0.1:3000/
```

### Notes

- If there is no `.gpkg` in `data/`, the app starts in an empty state and waits for upload.
- You can upload a GeoPackage from the UI.
- This mode includes the richer workflow: selection, filters, summary stats, and selected-features table.

## 2. Static upload viewer

This is a separate browser-only page. It does not use the backend API to read the GeoPackage. Instead, it loads a `.gpkg` directly in the browser using `@ngageoint/geopackage`.

### Open it

If the backend is running, open:

```text
http://127.0.0.1:3000/public/static-upload.html
```

### Notes

- This page is implemented in:
  - [public/static-upload.html](/Users/mjlobo/Code/bdmapvis2/public/static-upload.html)
  - [public/static-upload.js](/Users/mjlobo/Code/bdmapvis2/public/static-upload.js)
  - [public/static-upload.css](/Users/mjlobo/Code/bdmapvis2/public/static-upload.css)
- It is intended for static hosting scenarios where users upload the GeoPackage themselves.
- It is simpler than the main app and currently focuses on browsing uploaded layers on the map.

## Project structure

- [server.js](/Users/mjlobo/Code/bdmapvis2/server.js): Node backend
- [public/index.html](/Users/mjlobo/Code/bdmapvis2/public/index.html): main backend-driven frontend
- [public/static-upload.html](/Users/mjlobo/Code/bdmapvis2/public/static-upload.html): browser-only static upload frontend
- [data](/Users/mjlobo/Code/bdmapvis2/data): local GeoPackage storage
