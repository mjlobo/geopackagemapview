const statusText = document.getElementById("statusText");
const fileName = document.getElementById("fileName");
const featureCount = document.getElementById("featureCount");
const selectedCount = document.getElementById("selectedCount");
const layerSelect = document.getElementById("layerSelect");
const limitInput = document.getElementById("limitInput");
const reloadButton = document.getElementById("reloadButton");
const selectionToggleButton = document.getElementById("selectionToggleButton");
const selectionSummaryContent = document.getElementById("selectionSummaryContent");
const selectedFeaturesTableContent = document.getElementById("selectedFeaturesTableContent");
const selectedFeaturesPanel = document.getElementById("selectedFeaturesPanel");
const selectedFeaturesPanelHandle = document.getElementById("selectedFeaturesPanelHandle");
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
let baseSelectedFeatures = [];
let activeNumericFilters = new Map();
let activeCategoricalFilters = new Map();
let selectionOverlay = null;
let moveSelectionState = null;
let histogramBrushState = null;
let tablePanelDragState = null;

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

function formatAttributeValue(value) {
  if (value === null || value === undefined) {
    return "<span class=\"null-value\">NULL</span>";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return escapeHtml(value);
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

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "";
  }

  if (Math.abs(value) >= 1000 || Number.isInteger(value)) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function buildHistogram(field, values, min, max) {
  if (values.length === 0) {
    return "";
  }

  const bucketCount = Math.min(12, Math.max(6, Math.ceil(Math.sqrt(values.length))));
  const buckets = new Array(bucketCount).fill(0).map((_, index) => ({
    count: 0,
    index,
    rangeMin: min,
    rangeMax: max
  }));

  if (min === max) {
    buckets[Math.floor(bucketCount / 2)].count = values.length;
  } else {
    const span = max - min;

    values.forEach((value) => {
      const ratio = (value - min) / span;
      const index = Math.min(bucketCount - 1, Math.floor(ratio * bucketCount));
      buckets[index].count += 1;
    });

    buckets.forEach((bucket) => {
      bucket.rangeMin = min + (span * bucket.index) / bucketCount;
      bucket.rangeMax =
        bucket.index === bucketCount - 1
          ? max
          : min + (span * (bucket.index + 1)) / bucketCount;
    });
  }

  const maxBucket = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const activeFilter = activeNumericFilters.get(field);

  const bars = buckets
    .map((bucket) => {
      const overlapsActiveFilter =
        activeFilter &&
        bucket.rangeMax >= activeFilter.min &&
        bucket.rangeMin <= activeFilter.max;

      return `
        <button
          type="button"
          class="histogram-bar${overlapsActiveFilter ? " is-active" : ""}"
          data-field="${escapeHtml(field)}"
          data-index="${bucket.index}"
          data-min="${bucket.rangeMin}"
          data-max="${bucket.rangeMax}"
          data-original-max="${max}"
          title="${escapeHtml(
            `${field}: ${formatNumber(bucket.rangeMin)} to ${formatNumber(bucket.rangeMax)} (${bucket.count})`
          )}"
          aria-label="${escapeHtml(
            `${field}: ${formatNumber(bucket.rangeMin)} to ${formatNumber(bucket.rangeMax)}`
          )}"
          style="height:${Math.max(8, (bucket.count / maxBucket) * 100)}%"
        ></button>
      `;
    })
    .join("");

  return `
    <div class="histogram-cell">
      <div class="histogram-axis">
        <span>${formatNumber(min)}</span>
        <span>${formatNumber(max)}</span>
      </div>
      <div class="histogram" data-field="${escapeHtml(field)}">
        ${bars}
      </div>
    </div>
  `;
}

function getHistogramBars(histogramElement) {
  return [...histogramElement.querySelectorAll(".histogram-bar")];
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function startTablePanelDrag(event) {
  if (window.innerWidth <= 900 || event.button !== 0) {
    return;
  }

  const rect = selectedFeaturesPanel.getBoundingClientRect();
  tablePanelDragState = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top
  };

  selectedFeaturesPanel.style.left = `${rect.left}px`;
  selectedFeaturesPanel.style.top = `${rect.top}px`;
  selectedFeaturesPanel.style.right = "auto";
  event.preventDefault();
}

function moveTablePanel(clientX, clientY) {
  if (!tablePanelDragState || window.innerWidth <= 900) {
    return;
  }

  const panelRect = selectedFeaturesPanel.getBoundingClientRect();
  const maxLeft = Math.max(16, window.innerWidth - panelRect.width - 16);
  const maxTop = Math.max(16, window.innerHeight - panelRect.height - 16);
  const left = clamp(clientX - tablePanelDragState.offsetX, 16, maxLeft);
  const top = clamp(clientY - tablePanelDragState.offsetY, 16, maxTop);

  selectedFeaturesPanel.style.left = `${left}px`;
  selectedFeaturesPanel.style.top = `${top}px`;
}

function endTablePanelDrag() {
  tablePanelDragState = null;
}

function getHistogramBrushRange(histogramElement, startIndex, endIndex) {
  const bars = getHistogramBars(histogramElement);
  const start = Math.max(0, Math.min(startIndex, endIndex));
  const end = Math.min(bars.length - 1, Math.max(startIndex, endIndex));
  return { bars, start, end };
}

function getHistogramBarIndex(histogramElement, clientX) {
  const bars = getHistogramBars(histogramElement);
  if (bars.length === 0) {
    return -1;
  }

  const rect = histogramElement.getBoundingClientRect();
  const ratio = Math.min(0.999999, Math.max(0, (clientX - rect.left) / rect.width));
  return Math.floor(ratio * bars.length);
}

function ensureHistogramBrushElement(histogramElement) {
  let brush = histogramElement.querySelector(".histogram-brush");
  if (!brush) {
    brush = document.createElement("div");
    brush.className = "histogram-brush";
    histogramElement.appendChild(brush);
  }
  return brush;
}

function updateHistogramBrushPreview(histogramElement, startIndex, endIndex) {
  const { bars, start, end } = getHistogramBrushRange(histogramElement, startIndex, endIndex);
  if (bars.length === 0) {
    return;
  }

  const firstRect = bars[start].getBoundingClientRect();
  const lastRect = bars[end].getBoundingClientRect();
  const histogramRect = histogramElement.getBoundingClientRect();
  const brush = ensureHistogramBrushElement(histogramElement);

  brush.style.left = `${firstRect.left - histogramRect.left}px`;
  brush.style.width = `${lastRect.right - firstRect.left}px`;
  brush.classList.add("is-visible");
}

function clearHistogramBrushPreview(histogramElement) {
  const brush = histogramElement?.querySelector(".histogram-brush");
  if (brush) {
    brush.classList.remove("is-visible");
  }
}

function clearSelection() {
  baseSelectedFeatures = [];
  activeNumericFilters.clear();
  activeCategoricalFilters.clear();
  removeSelectionOverlay();
  const empty = { type: "FeatureCollection", features: [] };
  map.getSource("selected-features").setData(empty);
  selectedCount.textContent = "0";
  selectionSummaryContent.innerHTML = "No selection yet.";
  selectedFeaturesTableContent.innerHTML = "No selection yet.";
}

function resetDragSelection() {
  if (!dragSelection) {
    return;
  }

  dragSelection.box.remove();
  dragSelection = null;
  map.dragPan.enable();
}

function removeSelectionOverlay() {
  if (!selectionOverlay) {
    return;
  }

  selectionOverlay.box.remove();
  selectionOverlay = null;
}

function createSelectionOverlayBox() {
  const box = document.createElement("div");
  box.className = "selection-box is-fixed";
  box.addEventListener("mousedown", (event) => {
    if (!selectionModeEnabled || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!selectionOverlay) {
      return;
    }

    map.dragPan.disable();
    moveSelectionState = {
      startPoint: { x: event.clientX, y: event.clientY },
      startProjectedBounds: getProjectedSelectionBounds(selectionOverlay.bounds)
    };
  });

  map.getCanvasContainer().appendChild(box);
  return box;
}

function getProjectedSelectionBounds(bounds) {
  const topLeft = map.project([bounds.minX, bounds.maxY]);
  const bottomRight = map.project([bounds.maxX, bounds.minY]);

  return {
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y
  };
}

function renderSelectionOverlay() {
  if (!selectionOverlay) {
    return;
  }

  const projected = getProjectedSelectionBounds(selectionOverlay.bounds);
  const left = Math.min(projected.left, projected.right);
  const top = Math.min(projected.top, projected.bottom);
  const width = Math.abs(projected.right - projected.left);
  const height = Math.abs(projected.bottom - projected.top);

  selectionOverlay.box.style.left = `${left}px`;
  selectionOverlay.box.style.top = `${top}px`;
  selectionOverlay.box.style.width = `${width}px`;
  selectionOverlay.box.style.height = `${height}px`;
}

function setSelectionOverlay(bounds) {
  if (!selectionOverlay) {
    selectionOverlay = {
      bounds,
      box: createSelectionOverlayBox()
    };
  } else {
    selectionOverlay.bounds = bounds;
  }

  renderSelectionOverlay();
}

function updateSelectedFeaturesFromBounds(bounds, { preserveFilters = true } = {}) {
  if (!preserveFilters) {
    activeNumericFilters.clear();
    activeCategoricalFilters.clear();
  }

  baseSelectedFeatures = currentFeatureCollection.features.filter((feature) =>
    isFeatureInsideSelection(feature, bounds)
  );
  renderSelectedFeatures();
}

function getFilteredSelectedFeatures() {
  if (activeNumericFilters.size === 0 && activeCategoricalFilters.size === 0) {
    return baseSelectedFeatures;
  }

  return baseSelectedFeatures.filter((feature) => {
    const properties = feature.properties || {};

    for (const [field, range] of activeNumericFilters.entries()) {
      const value = properties[field];
      if (!isFiniteNumber(value)) {
        return false;
      }

      const isLastBucket = range.max === range.originalMax;
      const inRange = isLastBucket
        ? value >= range.min && value <= range.max
        : value >= range.min && value < range.max;

      if (!inRange) {
        return false;
      }
    }

    for (const [field, selectedValue] of activeCategoricalFilters.entries()) {
      const value = properties[field];
      if (value === null || value === undefined) {
        return false;
      }

      if (String(value) !== selectedValue) {
        return false;
      }
    }

    return true;
  });
}

function updateSelectionSummary(features) {
  selectedCount.textContent = String(features.length);

  if (baseSelectedFeatures.length === 0) {
    selectionSummaryContent.innerHTML = "No selection yet.";
    return;
  }

  const numericStats = new Map();
  const nullCounts = new Map();
  const categoricalStats = new Map();

  features.forEach((feature) => {
    const properties = feature.properties || {};

    Object.entries(properties).forEach(([key, value]) => {
      if (value === null || value === undefined) {
        nullCounts.set(key, (nullCounts.get(key) || 0) + 1);
        return;
      }

      if (!isFiniteNumber(value)) {
        const normalizedValue = String(value);
        const entry = categoricalStats.get(key) || new Map();
        entry.set(normalizedValue, (entry.get(normalizedValue) || 0) + 1);
        categoricalStats.set(key, entry);
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
          <td>${buildHistogram(key, stats.values, stats.min, stats.max)}</td>
          <td>${stats.count}</td>
          <td>${nullCount}</td>
          <td>${stats.min.toFixed(2)}</td>
          <td>${stats.max.toFixed(2)}</td>
          <td>${mean.toFixed(2)}</td>
        </tr>
      `;
    })
    .join("");

  const nullOnlyRows = [...nullCounts.entries()]
    .filter(([key]) => !numericStats.has(key))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, count]) => `<li><strong>${escapeHtml(key)}</strong>: ${count}</li>`)
    .join("");

  const categoricalFilterRows = [...categoricalStats.entries()]
    .filter(([, values]) => values.size > 1)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([field, values]) => {
      const currentValue = activeCategoricalFilters.get(field) || "";
      const options = [...values.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(
          ([value, count]) => `
            <option value="${escapeHtml(value)}" ${currentValue === value ? "selected" : ""}>
              ${escapeHtml(value)} (${count})
            </option>
          `
        )
        .join("");

      return `
        <label class="categorical-filter">
          <span>${escapeHtml(field)}</span>
          <select data-action="categorical-filter" data-field="${escapeHtml(field)}">
            <option value="">All values</option>
            ${options}
          </select>
        </label>
      `;
    })
    .join("");

  const numericFilterTags = [...activeNumericFilters.entries()].map(
    ([field, range]) => `
        <button
          type="button"
          class="filter-tag"
          data-action="clear-numeric-filter"
          data-field="${escapeHtml(field)}"
        >
          ${escapeHtml(field)}: ${formatNumber(range.min)} - ${formatNumber(range.max)} x
        </button>
      `
  );

  const categoricalFilterTags = [...activeCategoricalFilters.entries()].map(
    ([field, value]) => `
      <button
        type="button"
        class="filter-tag"
        data-action="clear-categorical-filter"
        data-field="${escapeHtml(field)}"
      >
        ${escapeHtml(field)}: ${escapeHtml(value)} x
      </button>
    `
  );

  const activeFilterTags = [...numericFilterTags, ...categoricalFilterTags].join("");

  selectionSummaryContent.innerHTML = `
    <div class="summary-toolbar">
      <p class="summary-kpi">${features.length} selected feature${features.length === 1 ? "" : "s"}</p>
      ${
        activeNumericFilters.size > 0 || activeCategoricalFilters.size > 0
          ? `<button type="button" class="clear-filters-button" data-action="clear-all-filters">
              Clear value filters
            </button>`
          : ""
      }
    </div>
    ${
      categoricalFilterRows
        ? `<div class="categorical-filters">
            <p class="filter-section-title">Categorical filters</p>
            <div class="categorical-filter-grid">${categoricalFilterRows}</div>
          </div>`
        : ""
    }
    ${
      activeFilterTags
        ? `<div class="active-filters">${activeFilterTags}</div>`
        : ""
    }
    ${
      numericRows
        ? `<div class="summary-table-wrap">
            <table class="summary-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Distribution</th>
                  <th>Values</th>
                  <th>NULLs</th>
                  <th>Min</th>
                  <th>Max</th>
                  <th>Mean</th>
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

function updateSelectedFeaturesTable(features) {
  if (baseSelectedFeatures.length === 0) {
    selectedFeaturesTableContent.innerHTML = "No selection yet.";
    return;
  }

  if (features.length === 0) {
    selectedFeaturesTableContent.innerHTML = "No features match the current filters.";
    return;
  }

  const columns = new Set(["feature_id"]);
  features.forEach((feature) => {
    Object.keys(feature.properties || {}).forEach((key) => columns.add(key));
  });

  const orderedColumns = [...columns];
  const headerRow = orderedColumns
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join("");

  const bodyRows = features
    .map((feature) => {
      const cells = orderedColumns
        .map((column) => {
          const value =
            column === "feature_id" ? feature.id ?? "" : feature.properties?.[column];
          return `<td>${formatAttributeValue(value)}</td>`;
        })
        .join("");

      return `<tr>${cells}</tr>`;
    })
    .join("");

  selectedFeaturesTableContent.innerHTML = `
    <p class="summary-kpi">${features.length} row${features.length === 1 ? "" : "s"}</p>
    <div class="feature-table-wrap">
      <table class="feature-table">
        <thead>
          <tr>${headerRow}</tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

function renderSelectedFeatures() {
  const filteredFeatures = getFilteredSelectedFeatures();
  map.getSource("selected-features").setData({
    type: "FeatureCollection",
    features: filteredFeatures
  });
  updateSelectionSummary(filteredFeatures);
  updateSelectedFeaturesTable(filteredFeatures);
  if (baseSelectedFeatures.length > 0) {
    const filterCount = activeNumericFilters.size + activeCategoricalFilters.size;
    statusText.textContent =
      filterCount > 0
        ? `Selected ${filteredFeatures.length} features after filters`
        : `Selected ${filteredFeatures.length} features`;
  }
}

function setSelectedFeatures(features) {
  baseSelectedFeatures = features;
  activeNumericFilters.clear();
  activeCategoricalFilters.clear();
  renderSelectedFeatures();
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
    moveSelectionState = null;
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
  removeSelectionOverlay();

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

  const { startPoint, currentPoint, box } = dragSelection;
  dragSelection = null;
  map.dragPan.enable();

  if (!currentPoint) {
    box.remove();
    return;
  }

  suppressNextMoveEnd = true;

  const selectionBounds = getSelectionBounds(startPoint, currentPoint);
  box.remove();
  setSelectionOverlay(selectionBounds);
  updateSelectedFeaturesFromBounds(selectionBounds, { preserveFilters: false });
}

function moveSelectionOverlay(clientX, clientY) {
  if (!moveSelectionState || !selectionOverlay) {
    return;
  }

  const deltaX = clientX - moveSelectionState.startPoint.x;
  const deltaY = clientY - moveSelectionState.startPoint.y;
  const projectedBounds = moveSelectionState.startProjectedBounds;

  const topLeft = map.unproject([projectedBounds.left + deltaX, projectedBounds.top + deltaY]);
  const bottomRight = map.unproject([
    projectedBounds.right + deltaX,
    projectedBounds.bottom + deltaY
  ]);

  selectionOverlay.bounds = {
    minX: Math.min(topLeft.lng, bottomRight.lng),
    minY: Math.min(bottomRight.lat, topLeft.lat),
    maxX: Math.max(topLeft.lng, bottomRight.lng),
    maxY: Math.max(bottomRight.lat, topLeft.lat)
  };

  renderSelectionOverlay();
  updateSelectedFeaturesFromBounds(selectionOverlay.bounds);
}

function endOverlayMove() {
  if (!moveSelectionState) {
    return;
  }

  moveSelectionState = null;
  map.dragPan.enable();
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

function handleSummaryClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;

  if (action === "clear-all-filters") {
    activeNumericFilters.clear();
    activeCategoricalFilters.clear();
    renderSelectedFeatures();
    return;
  }

  if (action === "clear-numeric-filter") {
    activeNumericFilters.delete(button.dataset.field);
    renderSelectedFeatures();
    return;
  }

  if (action === "clear-categorical-filter") {
    activeCategoricalFilters.delete(button.dataset.field);
    renderSelectedFeatures();
    return;
  }

}

function handleSummaryChange(event) {
  const select = event.target.closest("select[data-action='categorical-filter']");
  if (!select) {
    return;
  }

  const field = select.dataset.field;
  const value = select.value;

  if (!value) {
    activeCategoricalFilters.delete(field);
  } else {
    activeCategoricalFilters.set(field, value);
  }

  renderSelectedFeatures();
}

function startHistogramBrush(event) {
  const histogram = event.target.closest(".histogram");
  if (!histogram || event.button !== 0) {
    return;
  }

  const startIndex = getHistogramBarIndex(histogram, event.clientX);
  if (startIndex < 0) {
    return;
  }

  event.preventDefault();

  histogramBrushState = {
    field: histogram.dataset.field,
    histogram,
    startIndex,
    currentIndex: startIndex
  };

  updateHistogramBrushPreview(histogram, startIndex, startIndex);
}

function moveHistogramBrush(event) {
  if (!histogramBrushState) {
    return;
  }

  const currentIndex = getHistogramBarIndex(histogramBrushState.histogram, event.clientX);
  if (currentIndex < 0) {
    return;
  }

  histogramBrushState.currentIndex = currentIndex;
  updateHistogramBrushPreview(
    histogramBrushState.histogram,
    histogramBrushState.startIndex,
    histogramBrushState.currentIndex
  );
}

function endHistogramBrush() {
  if (!histogramBrushState) {
    return;
  }

  const { histogram, field, startIndex, currentIndex } = histogramBrushState;
  const { bars, start, end } = getHistogramBrushRange(histogram, startIndex, currentIndex);
  clearHistogramBrushPreview(histogram);
  histogramBrushState = null;

  if (bars.length === 0) {
    return;
  }

  const min = Number(bars[start].dataset.min);
  const max = Number(bars[end].dataset.max);
  const originalMax = Number(bars[end].dataset.originalMax);
  const current = activeNumericFilters.get(field);

  if (
    current &&
    Number(current.min) === min &&
    Number(current.max) === max &&
    Number(current.originalMax) === originalMax
  ) {
    activeNumericFilters.delete(field);
  } else {
    activeNumericFilters.set(field, { min, max, originalMax });
  }

  renderSelectedFeatures();
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
  selectionSummaryContent.addEventListener("click", handleSummaryClick);
  selectionSummaryContent.addEventListener("change", handleSummaryChange);
  selectionSummaryContent.addEventListener("mousedown", startHistogramBrush);

  setDatasetPanelHidden(false);
});

document.addEventListener("mousemove", (event) => {
  moveSelectionOverlay(event.clientX, event.clientY);
  moveHistogramBrush(event);
  moveTablePanel(event.clientX, event.clientY);
});

document.addEventListener("mouseup", () => {
  endOverlayMove();
  endHistogramBrush();
  endTablePanelDrag();
});

map.on("move", () => {
  renderSelectionOverlay();
});

selectedFeaturesPanelHandle.addEventListener("mousedown", startTablePanelDrag);

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
