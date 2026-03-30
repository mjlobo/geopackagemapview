const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const PYTHON_SCRIPT = path.join(__dirname, "scripts", "extract_geojson.py");

function resolveDataFile() {
  if (process.env.DATA_FILE) {
    return path.resolve(process.env.DATA_FILE);
  }

  const gpkgFiles = fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".gpkg"))
    .map((entry) => path.join(DATA_DIR, entry.name))
    .sort();

  if (gpkgFiles.length === 0) {
    throw new Error(`No .gpkg file found in ${DATA_DIR}`);
  }

  return gpkgFiles[0];
}

let currentDataFile = resolveDataFile();

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range,X-File-Name");
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, message) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

async function getFileInfo() {
  const stats = await fs.promises.stat(currentDataFile);

  return {
    fileName: path.basename(currentDataFile),
    absolutePath: currentDataFile,
    sizeBytes: stats.size,
    sizeMB: Number((stats.size / (1024 * 1024)).toFixed(2)),
    lastModified: stats.mtime.toISOString()
  };
}

async function runSql(sql) {
  const { stdout } = await execFileAsync("sqlite3", [
    "-json",
    currentDataFile,
    sql
  ]);

  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function getTables() {
  try {
    return await runSql(`
      SELECT
        table_name,
        data_type,
        identifier,
        description
      FROM gpkg_contents
      ORDER BY table_name
    `);
  } catch (error) {
    return runSql(`
      SELECT
        name AS table_name,
        type AS data_type
      FROM sqlite_master
      WHERE type IN ('table', 'view')
      ORDER BY name
    `);
  }
}

async function getMetadata() {
  const [fileInfo, tables] = await Promise.all([getFileInfo(), getTables()]);

  return {
    ...fileInfo,
    tableCount: tables.length,
    tables
  };
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function serveStaticFile(res, filePath) {
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stats = await fs.promises.stat(normalizedPath);
    const target = stats.isDirectory() ? path.join(normalizedPath, "index.html") : normalizedPath;
    const finalStats = stats.isDirectory() ? await fs.promises.stat(target) : stats;

    setCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": getMimeType(target),
      "Content-Length": finalStats.size
    });
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    sendText(res, 404, "Not found");
  }
}

async function extractGeoJson(params) {
  const args = [PYTHON_SCRIPT, "--file", currentDataFile, "--layer", params.layer];

  if (params.limit) {
    args.push("--limit", String(params.limit));
  }

  if (params.bbox) {
    args.push("--bbox", params.bbox);
  }

  const { stdout } = await execFileAsync("python3", args, {
    maxBuffer: 50 * 1024 * 1024
  });

  return JSON.parse(stdout);
}

async function streamFile(req, res) {
  const stats = await fs.promises.stat(currentDataFile);
  const rangeHeader = req.headers.range;
  const fileName = path.basename(currentDataFile);

  setCorsHeaders(res);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "application/geopackage+sqlite3");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);

  if (!rangeHeader) {
    res.writeHead(200, { "Content-Length": stats.size });
    fs.createReadStream(currentDataFile).pipe(res);
    return;
  }

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    sendText(res, 416, "Invalid Range header");
    return;
  }

  const start = match[1] === "" ? 0 : Number(match[1]);
  const end = match[2] === "" ? stats.size - 1 : Number(match[2]);

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end >= stats.size ||
    start > end
  ) {
    sendText(res, 416, "Requested range not satisfiable");
    return;
  }

  res.writeHead(206, {
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stats.size}`
  });

  fs.createReadStream(currentDataFile, { start, end }).pipe(res);
}

function sanitizeUploadFileName(fileName) {
  const normalized = path.basename(fileName || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!normalized || !normalized.toLowerCase().endsWith(".gpkg")) {
    return null;
  }

  return normalized;
}

async function uploadGeoPackage(req, res) {
  const headerValue = req.headers["x-file-name"];
  const fileName = sanitizeUploadFileName(Array.isArray(headerValue) ? headerValue[0] : headerValue);

  if (!fileName) {
    sendJson(res, 400, { error: "A valid .gpkg filename is required in the X-File-Name header." });
    return;
  }

  await fs.promises.mkdir(DATA_DIR, { recursive: true });

  const tempPath = path.join(DATA_DIR, `${fileName}.uploading`);
  const targetPath = path.join(DATA_DIR, fileName);

  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(tempPath);

    req.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);
    req.pipe(writeStream);
  });

  try {
    await execFileAsync("sqlite3", [tempPath, "SELECT name FROM sqlite_master LIMIT 1;"]);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    sendJson(res, 400, { error: "The uploaded file is not a readable SQLite/GeoPackage file." });
    return;
  }

  await fs.promises.rename(tempPath, targetPath);
  currentDataFile = targetPath;

  sendJson(res, 200, {
    ok: true,
    fileName,
    currentFile: currentDataFile
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendText(res, 400, "Missing request URL");
    return;
  }

  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/file-info") {
      sendJson(res, 200, await getFileInfo());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tables") {
      sendJson(res, 200, await getTables());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/metadata") {
      sendJson(res, 200, await getMetadata());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/features") {
      const layer = url.searchParams.get("layer");
      if (!layer) {
        sendJson(res, 400, { error: "Missing required query parameter: layer" });
        return;
      }

      const limit = Math.min(Number(url.searchParams.get("limit") || 500), 5000);
      const bbox = url.searchParams.get("bbox");
      const geojson = await extractGeoJson({ layer, limit, bbox });
      sendJson(res, 200, geojson);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/file") {
      await streamFile(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/upload") {
      await uploadGeoPackage(req, res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/public/"))) {
      const relativePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/public\//, "");
      await serveStaticFile(res, path.join(PUBLIC_DIR, relativePath));
      return;
    }

    sendJson(res, 404, {
      error: "Not found",
      endpoints: [
        "GET /",
        "GET /api/health",
        "GET /api/file-info",
        "GET /api/tables",
        "GET /api/metadata",
        "GET /api/features?layer=batiment_construction&limit=500&bbox=minLon,minLat,maxLon,maxLat",
        "GET /api/file",
        "POST /api/upload"
      ]
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Internal server error",
      message: error.message
    });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Backend listening on http://${HOST}:${PORT}`);
    console.log(`Serving data file: ${currentDataFile}`);
  });
}

module.exports = {
  getCurrentDataFile: () => currentDataFile,
  getFileInfo,
  getTables,
  getMetadata,
  server
};
