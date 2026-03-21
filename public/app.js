const statusText = document.getElementById("statusText");
const fileName = document.getElementById("fileName");
const featureCount = document.getElementById("featureCount");
const layerSelect = document.getElementById("layerSelect");
const limitInput = document.getElementById("limitInput");
const reloadButton = document.getElementById("reloadButton");

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

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function formatProperties(properties) {
  return Object.entries(properties)
    .slice(0, 8)
    .map(([key, value]) => `<div><strong>${key}</strong>: ${value ?? ""}</div>`)
    .join("");
}

function ensureDataLayers() {
  if (!map.getSource("features")) {
    map.addSource("features", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
  }

  if (!map.getLayer("feature-fill")) {
    map.addLayer({
      id: "feature-fill",
      type: "fill",
      source: "features",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": "#0f766e",
        "fill-opacity": 0.28
      }
    });
  }

  if (!map.getLayer("feature-line")) {
    map.addLayer({
      id: "feature-line",
      type: "line",
      source: "features",
      paint: {
        "line-color": "#0b5d57",
        "line-width": 1
      }
    });
  }

  if (!map.getLayer("feature-circle")) {
    map.addLayer({
      id: "feature-circle",
      type: "circle",
      source: "features",
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

let pendingRequest = 0;

async function loadFeatures() {
  const layer = layerSelect.value;
  if (!layer) {
    return;
  }

  const requestId = ++pendingRequest;
  const limit = Math.max(50, Math.min(5000, Number(limitInput.value) || 1000));
  const bounds = map.getBounds();
  const bbox = [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth()
  ].join(",");

  statusText.textContent = "Loading features";

  try {
    const data = await getJson(`/api/features?layer=${encodeURIComponent(layer)}&limit=${limit}&bbox=${bbox}`);
    if (requestId !== pendingRequest) {
      return;
    }

    map.getSource("features").setData(data);
    featureCount.textContent = String(data.features.length);
    statusText.textContent = `Showing ${data.features.length} features`;
  } catch (error) {
    statusText.textContent = error.message;
  }
}

async function initialize() {
  const metadata = await getJson("/api/metadata");
  fileName.textContent = `${metadata.fileName} (${metadata.sizeMB} MB)`;

  const layers = metadata.tables.filter((table) => table.data_type === "features");
  layers.forEach((layer) => {
    const option = document.createElement("option");
    option.value = layer.table_name;
    option.textContent = layer.table_name;
    layerSelect.appendChild(option);
  });

  if (layers.some((layer) => layer.table_name === "batiment_construction")) {
    layerSelect.value = "batiment_construction";
  }
}

map.on("load", async () => {
  ensureDataLayers();
  await initialize();
  await loadFeatures();

  map.on("moveend", loadFeatures);
  reloadButton.addEventListener("click", loadFeatures);
  layerSelect.addEventListener("change", loadFeatures);
});

map.on("click", "feature-fill", (event) => {
  const feature = event.features?.[0];
  if (!feature) {
    return;
  }

  new maplibregl.Popup()
    .setLngLat(event.lngLat)
    .setHTML(formatProperties(feature.properties || {}))
    .addTo(map);
});

map.on("click", "feature-circle", (event) => {
  const feature = event.features?.[0];
  if (!feature) {
    return;
  }

  new maplibregl.Popup()
    .setLngLat(event.lngLat)
    .setHTML(formatProperties(feature.properties || {}))
    .addTo(map);
});
