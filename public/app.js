const statusText = document.getElementById("statusText");
const fileName = document.getElementById("fileName");
const featureCount = document.getElementById("featureCount");
const selectedCount = document.getElementById("selectedCount");
const layerSelect = document.getElementById("layerSelect");
const limitInput = document.getElementById("limitInput");
const reloadButton = document.getElementById("reloadButton");
const selectionToggleButton = document.getElementById("selectionToggleButton");
const selectionSummaryContent = document.getElementById("selectionSummaryContent");
const panelToggleButton = document.getElementById("panelToggleButton");
const datasetPanelSection = document.getElementById("datasetPanelSection");

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

let currentFeatureCollection = { type: "FeatureCollection", features: [] };
let pendingRequest = 0;
let selectionModeEnabled = false;
let dragSelection = null;
let datasetPanelHidden = false;
let suppressNextMoveEnd = false;

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function buildHistogram(values, min, max) {
  if (values.length === 0) {
    return "";
  }

  const bucketCount = Math.min(12, Math.max(6, Math.ceil(Math.sqrt(values.length))));
  const buckets = new Array(bucketCount).fill(0);

  if (min === max) {
    buckets[Math.floor(bucketCount / 2)] = values.length;
  } else {
    values.forEach((value) => {
      const ratio = (value - min) / (max - min);
      const index = Math.min(bucketCount - 1, Math.floor(ratio * bucketCount));
      buckets[index] += 1;
    });
  }

  const maxBucket = Math.max(...buckets, 1);
  const barWidth = 100 / bucketCount;

  const bars = buckets
    .map((bucket, index) => {
      const height = (bucket / maxBucket) * 100;
      const x = index * barWidth;
      const width = Math.max(3, barWidth - 1.5);

      return `
        <rect
          x="${x.toFixed(2)}"
          y="${(100 - height).toFixed(2)}"
          width="${width.toFixed(2)}"
          height="${height.toFixed(2)}"
          rx="1.5"
          ry="1.5"
        />
      `;
    })
    .join("");

  return `
    <div class="histogram-cell">
      <svg class="histogram" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${bars}
      </svg>
    </div>
  `;
}

function clearSelection() {
  const empty = { type: "FeatureCollection", features: [] };
  map.getSource("selected-features").setData(empty);
  selectedCount.textContent = "0";
  selectionSummaryContent.innerHTML = "No selection yet.";
}

function resetDragSelection() {
  if (!dragSelection) {
    return;
  }

  dragSelection.box.remove();
  dragSelection = null;
  map.dragPan.enable();
}

function updateSelectionSummary(features) {
  selectedCount.textContent = String(features.length);

  if (features.length === 0) {
    selectionSummaryContent.innerHTML = "No selection yet.";
    return;
  }

  const numericStats = new Map();
  const nullCounts = new Map();

  features.forEach((feature) => {
    const properties = feature.properties || {};

    Object.entries(properties).forEach(([key, value]) => {
      if (value === null || value === undefined) {
        nullCounts.set(key, (nullCounts.get(key) || 0) + 1);
        return;
      }

      if (!isFiniteNumber(value)) {
        return;
      }

      const stats = numericStats.get(key) || {
        count: 0,
        min: value,
        max: value,
        sum: 0,
        values: []
      };

      stats.count += 1;
      stats.sum += value;
      stats.min = Math.min(stats.min, value);
      stats.max = Math.max(stats.max, value);
      stats.values.push(value);
      numericStats.set(key, stats);
    });
  });

  const numericRows = [...numericStats.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, stats]) => {
      const mean = stats.sum / stats.count;
      const nullCount = nullCounts.get(key) || 0;

      return `
        <tr>
          <td>${escapeHtml(key)}</td>
          <td>${stats.count}</td>
          <td>${nullCount}</td>
          <td>${stats.min.toFixed(2)}</td>
          <td>${stats.max.toFixed(2)}</td>
          <td>${mean.toFixed(2)}</td>
          <td>${buildHistogram(stats.values, stats.min, stats.max)}</td>
        </tr>
      `;
    })
    .join("");

  const nullOnlyRows = [...nullCounts.entries()]
    .filter(([key]) => !numericStats.has(key))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, count]) => `<li><strong>${escapeHtml(key)}</strong>: ${count}</li>`)
    .join("");

  selectionSummaryContent.innerHTML = `
    <p class="summary-kpi">${features.length} selected feature${features.length === 1 ? "" : "s"}</p>
    ${
      numericRows
        ? `<div class="summary-table-wrap">
            <table class="summary-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Values</th>
                  <th>NULLs</th>
                  <th>Min</th>
                  <th>Max</th>
                  <th>Mean</th>
                  <th>Distribution</th>
                </tr>
              </thead>
              <tbody>${numericRows}</tbody>
            </table>
          </div>`
        : "<p>No numeric attributes found in the current selection.</p>"
    }
    ${
      nullOnlyRows
        ? `<div class="null-only-block">
            <h2>Fields with only NULL values in the selection</h2>
            <ul>${nullOnlyRows}</ul>
          </div>`
        : ""
    }
  `;
}

function setSelectedFeatures(features) {
  map.getSource("selected-features").setData({
    type: "FeatureCollection",
    features
  });
  updateSelectionSummary(features);
}

function getFeatureBoundingBox(geometry) {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity
  };

  function visitCoordinates(coordinates) {
    if (!Array.isArray(coordinates)) {
      return;
    }

    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      bounds.minX = Math.min(bounds.minX, coordinates[0]);
      bounds.minY = Math.min(bounds.minY, coordinates[1]);
      bounds.maxX = Math.max(bounds.maxX, coordinates[0]);
      bounds.maxY = Math.max(bounds.maxY, coordinates[1]);
      return;
    }

    coordinates.forEach(visitCoordinates);
  }

  visitCoordinates(geometry?.coordinates);

  if (!Number.isFinite(bounds.minX)) {
    return null;
  }

  return bounds;
}

function isFeatureInsideSelection(feature, selectionBounds) {
  if (!feature.geometry) {
    return false;
  }

  if (feature.geometry.type === "Point") {
    const [x, y] = feature.geometry.coordinates;
    return (
      x >= selectionBounds.minX &&
      x <= selectionBounds.maxX &&
      y >= selectionBounds.minY &&
      y <= selectionBounds.maxY
    );
  }

  const featureBounds = getFeatureBoundingBox(feature.geometry);
  if (!featureBounds) {
    return false;
  }

  return (
    featureBounds.minX >= selectionBounds.minX &&
    featureBounds.maxX <= selectionBounds.maxX &&
    featureBounds.minY >= selectionBounds.minY &&
    featureBounds.maxY <= selectionBounds.maxY
  );
}

function getSelectionBounds(startPoint, endPoint) {
  const startLngLat = map.unproject(startPoint);
  const endLngLat = map.unproject(endPoint);

  return {
    minX: Math.min(startLngLat.lng, endLngLat.lng),
    minY: Math.min(startLngLat.lat, endLngLat.lat),
    maxX: Math.max(startLngLat.lng, endLngLat.lng),
    maxY: Math.max(startLngLat.lat, endLngLat.lat)
  };
}

function setSelectionMode(enabled) {
  if (!enabled) {
    resetDragSelection();
  }

  selectionModeEnabled = enabled;
  selectionToggleButton.textContent = enabled
    ? "Disable rectangle selection"
    : "Enable rectangle selection";
  selectionToggleButton.classList.toggle("is-active", enabled);
  map.getCanvas().style.cursor = enabled ? "crosshair" : "";
  statusText.textContent = enabled
    ? "Selection mode enabled. Drag a rectangle on the map."
    : `Showing ${currentFeatureCollection.features.length} features`;
}

function setDatasetPanelHidden(hidden) {
  datasetPanelHidden = hidden;
  datasetPanelSection.classList.toggle("is-hidden", hidden);
  panelToggleButton.textContent = hidden
    ? "Show dataset controls"
    : "Hide dataset controls";
}

function startSelection(event) {
  if (!selectionModeEnabled || event.originalEvent.button !== 0) {
    return;
  }

  event.preventDefault();
  map.dragPan.disable();

  const canvas = map.getCanvasContainer();
  const startPoint = { x: event.point.x, y: event.point.y };
  const box = document.createElement("div");
  box.className = "selection-box";
  box.style.left = `${startPoint.x}px`;
  box.style.top = `${startPoint.y}px`;
  canvas.appendChild(box);

  dragSelection = { startPoint, box };
}

function updateSelection(event) {
  if (!dragSelection) {
    return;
  }

  const currentPoint = { x: event.point.x, y: event.point.y };
  const minX = Math.min(dragSelection.startPoint.x, currentPoint.x);
  const minY = Math.min(dragSelection.startPoint.y, currentPoint.y);
  const width = Math.abs(dragSelection.startPoint.x - currentPoint.x);
  const height = Math.abs(dragSelection.startPoint.y - currentPoint.y);

  dragSelection.currentPoint = currentPoint;
  dragSelection.box.style.left = `${minX}px`;
  dragSelection.box.style.top = `${minY}px`;
  dragSelection.box.style.width = `${width}px`;
  dragSelection.box.style.height = `${height}px`;
}

function endSelection() {
  if (!dragSelection) {
    return;
  }

  const { startPoint, currentPoint } = dragSelection;
  resetDragSelection();

  if (!currentPoint) {
    return;
  }

  suppressNextMoveEnd = true;

  const selectionBounds = getSelectionBounds(startPoint, currentPoint);
  const selectedFeatures = currentFeatureCollection.features.filter((feature) =>
    isFeatureInsideSelection(feature, selectionBounds)
  );

  setSelectedFeatures(selectedFeatures);
  statusText.textContent = `Selected ${selectedFeatures.length} features`;
}

function ensureDataLayers() {
  if (!map.getSource("features")) {
    map.addSource("features", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
  }

  if (!map.getSource("selected-features")) {
    map.addSource("selected-features", {
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

  if (!map.getLayer("selected-feature-fill")) {
    map.addLayer({
      id: "selected-feature-fill",
      type: "fill",
      source: "selected-features",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": "#ea580c",
        "fill-opacity": 0.4
      }
    });
  }

  if (!map.getLayer("selected-feature-line")) {
    map.addLayer({
      id: "selected-feature-line",
      type: "line",
      source: "selected-features",
      paint: {
        "line-color": "#9a3412",
        "line-width": 2
      }
    });
  }

  if (!map.getLayer("selected-feature-circle")) {
    map.addLayer({
      id: "selected-feature-circle",
      type: "circle",
      source: "selected-features",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#ea580c",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#fff7ed"
      }
    });
  }
}

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

    currentFeatureCollection = data;
    map.getSource("features").setData(data);
    featureCount.textContent = String(data.features.length);
    clearSelection();
    statusText.textContent = selectionModeEnabled
      ? `Showing ${data.features.length} features. Drag to select.`
      : `Showing ${data.features.length} features`;
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

  map.on("moveend", () => {
    if (suppressNextMoveEnd) {
      suppressNextMoveEnd = false;
      return;
    }

    loadFeatures();
  });
  map.on("mousedown", startSelection);
  map.on("mousemove", updateSelection);
  map.on("mouseup", endSelection);
  map.on("mouseleave", endSelection);

  reloadButton.addEventListener("click", loadFeatures);
  layerSelect.addEventListener("change", loadFeatures);
  panelToggleButton.addEventListener("click", () => {
    setDatasetPanelHidden(!datasetPanelHidden);
  });
  selectionToggleButton.addEventListener("click", () => {
    setSelectionMode(!selectionModeEnabled);
    if (!selectionModeEnabled) {
      clearSelection();
    }
  });

  setDatasetPanelHidden(false);
});

function showFeaturePopup(event) {
  const feature = event.features?.[0];
  if (!feature || selectionModeEnabled) {
    return;
  }

  new maplibregl.Popup()
    .setLngLat(event.lngLat)
    .setHTML(formatProperties(feature.properties || {}))
    .addTo(map);
}

map.on("click", "feature-fill", showFeaturePopup);
map.on("click", "feature-line", showFeaturePopup);
map.on("click", "feature-circle", showFeaturePopup);
