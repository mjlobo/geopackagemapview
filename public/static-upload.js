const { GeoPackageAPI, setSqljsWasmLocateFile } = window.GeoPackage;

setSqljsWasmLocateFile((file) => `https://unpkg.com/@ngageoint/geopackage@4.2.6/dist/${file}`);

const fileInput = document.getElementById("fileInput");
const layerSelect = document.getElementById("layerSelect");
const limitInput = document.getElementById("limitInput");
const loadLayerButton = document.getElementById("loadLayerButton");
const fileName = document.getElementById("fileName");
const featureCount = document.getElementById("featureCount");
const statusText = document.getElementById("statusText");

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
      }
    },
    layers: [
      {
        id: "carto",
        type: "raster",
        source: "carto"
      }
    ]
  },
  center: [2.35, 48.85],
  zoom: 12
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

let geoPackage = null;

function ensureDataSource() {
  if (!map.getSource("upload-features")) {
    map.addSource("upload-features", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
  }

  if (!map.getLayer("upload-feature-fill")) {
    map.addLayer({
      id: "upload-feature-fill",
      type: "fill",
      source: "upload-features",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": "#0f766e",
        "fill-opacity": 0.28
      }
    });
  }

  if (!map.getLayer("upload-feature-line")) {
    map.addLayer({
      id: "upload-feature-line",
      type: "line",
      source: "upload-features",
      paint: {
        "line-color": "#0b5d57",
        "line-width": 1
      }
    });
  }

  if (!map.getLayer("upload-feature-circle")) {
    map.addLayer({
      id: "upload-feature-circle",
      type: "circle",
      source: "upload-features",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 4,
        "circle-color": "#b45309",
        "circle-stroke-width": 1,
        "circle-stroke-color": "#fff7ed"
      }
    });
  }
}

function setLayerControlsEnabled(enabled) {
  layerSelect.disabled = !enabled;
  loadLayerButton.disabled = !enabled;
}

function getGeoJsonBounds(features) {
  const bounds = new maplibregl.LngLatBounds();
  let hasGeometry = false;

  function visitCoordinates(coordinates) {
    if (!Array.isArray(coordinates)) {
      return;
    }

    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      bounds.extend([coordinates[0], coordinates[1]]);
      hasGeometry = true;
      return;
    }

    coordinates.forEach(visitCoordinates);
  }

  features.forEach((feature) => visitCoordinates(feature.geometry?.coordinates));
  return hasGeometry ? bounds : null;
}

async function openGeoPackage(file) {
  statusText.textContent = `Opening ${file.name}...`;
  const arrayBuffer = await file.arrayBuffer();

  if (geoPackage && typeof geoPackage.close === "function") {
    geoPackage.close();
  }

  geoPackage = await GeoPackageAPI.open(new Uint8Array(arrayBuffer));
  const featureTables = geoPackage.getFeatureTables();

  layerSelect.innerHTML = "";
  featureTables.forEach((table) => {
    const option = document.createElement("option");
    option.value = table;
    option.textContent = table;
    layerSelect.appendChild(option);
  });

  fileName.textContent = file.name;
  setLayerControlsEnabled(featureTables.length > 0);
  featureCount.textContent = "0";
  map.getSource("upload-features").setData({ type: "FeatureCollection", features: [] });

  statusText.textContent =
    featureTables.length > 0
      ? `Loaded ${featureTables.length} feature layer${featureTables.length === 1 ? "" : "s"}`
      : "No feature layers found in this GeoPackage.";
}

async function loadSelectedLayer() {
  if (!geoPackage) {
    statusText.textContent = "Upload a GeoPackage first.";
    return;
  }

  const table = layerSelect.value;
  if (!table) {
    statusText.textContent = "No feature layer selected.";
    return;
  }

  const limit = Math.max(100, Math.min(10000, Number(limitInput.value) || 3000));
  statusText.textContent = `Loading ${table}...`;

  const features = [];
  const resultSet = geoPackage.queryForGeoJSONFeatures(table);
  let count = 0;

  try {
    for (const feature of resultSet) {
      features.push(feature);
      count += 1;
      if (count >= limit) {
        break;
      }
    }
  } finally {
    resultSet.close();
  }

  const collection = { type: "FeatureCollection", features };
  map.getSource("upload-features").setData(collection);
  featureCount.textContent = String(features.length);

  const bounds = getGeoJsonBounds(features);
  if (bounds) {
    map.fitBounds(bounds, { padding: 40, duration: 0 });
  }

  statusText.textContent = `Showing ${features.length} feature${features.length === 1 ? "" : "s"} from ${table}`;
}

map.on("load", () => {
  ensureDataSource();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    return;
  }

  try {
    await openGeoPackage(file);
  } catch (error) {
    setLayerControlsEnabled(false);
    statusText.textContent = error.message;
  }
});

loadLayerButton.addEventListener("click", loadSelectedLayer);
