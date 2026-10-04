import fs from 'fs';
import { PNG } from 'pngjs';

function parseEnvInt(val, fallback) {
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const START_X = parseInt(process.env.START_X, 10);
const START_Y = parseInt(process.env.START_Y, 10);
const END_X = parseInt(process.env.END_X, 10);
const END_Y = parseInt(process.env.END_Y, 10);
const ZONE_NAME = process.env.ZONE_NAME || 'default';

const RUN_DURATION_MS = parseEnvInt(process.env.RUN_DURATION_MINS, 330) * 60 * 1000; 

const CFG_TARGET_INTERVAL = parseEnvInt(process.env.TARGET_INTERVAL, 500);
const CFG_MIN_FLOOR = parseEnvInt(process.env.MIN_FLOOR, 399);
const CFG_PAUSE_SEC_429 = parseEnvInt(process.env.PAUSE_SEC_429, 321);
const CFG_PENALTY_MS_429 = parseEnvInt(process.env.PENALTY_MS_429, 500);
const CFG_STEP_DOWN_MS = parseEnvInt(process.env.STEP_DOWN_MS, 21);
const CFG_STREAK_REQS = parseEnvInt(process.env.STREAK_REQS, 42);

const TILE_SIZE = 1000;
let isShuttingDown = false;
const shutdownController = new AbortController();

function log(msg, type = 'info') {
  const ts = new Date().toISOString().substring(11, 19);
  const prefix = `[${ts}] [${ZONE_NAME}]`;
  if (type === 'warn' || type === 'error') console.error(`${prefix} ⚠️ ${msg}`);
  else if (type === 'success') console.log(`${prefix} ✅ ${msg}`);
  else console.log(`${prefix} ℹ️ ${msg}`);
}

function getCoords(absX, absY) {
  return {
    tileX: Math.floor(absX / TILE_SIZE),
    tileY: Math.floor(absY / TILE_SIZE),
    pixelX: ((absX % TILE_SIZE) + TILE_SIZE) % TILE_SIZE,
    pixelY: ((absY % TILE_SIZE) + TILE_SIZE) % TILE_SIZE
  };
}

const wait = (ms, signal = null) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const onAbort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => {
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

// --- Memory-Efficient Tile Cache ---
const tileCache = new Map();
async function getTileImage(tileX, tileY) {
  const key = `${tileX}_${tileY}`;
  if (tileCache.has(key)) return tileCache.get(key);

  // Because of Tile-First traversal, we actually only need 1 tile in memory at a time!
  if (tileCache.size >= 2) {
    const firstKey = tileCache.keys().next().value;
    tileCache.delete(firstKey);
  }

  log(`Downloading tile map (${tileX}, ${tileY}) to filter blank pixels...`);
  const url = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png?t=${Date.now()}`;
  
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);
  
  const arrayBuffer = await res.arrayBuffer();
  const png = PNG.sync.read(Buffer.from(arrayBuffer));
  tileCache.set(key, png);
  return png;
}

function isPixelBlank(png, pixelX, pixelY) {
  const idx = (pixelY * TILE_SIZE + pixelX) * 4;
  return png.data[idx + 3] === 0;
}

// --- Official API Request ---
async function fetchPixelOfficial(tileX, tileY, pixelX, pixelY) {
  const url = `https://backend.wplace.live/s0/pixel/${tileX}/${tileY}?x=${pixelX}&y=${pixelY}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(15000), shutdownController.signal])
    });
    if (res.ok) {
      const data = await res.json();
      return { 
        success: true, 
        username: data?.paintedBy?.name || 'Blank / Unknown',
        discord: data?.paintedBy?.discord || null,
        allianceName: data?.paintedBy?.allianceName || null
      };
    }
    return { success: false, status: res.status };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { success: false, status: 408 };
    return { success: false, status: 0 };
  }
}

// --- High-Performance Range Checking ---
function isProcessedGlobal(x, y, globalRanges) {
  const rowRanges = globalRanges[y];
  if (!rowRanges) return false;
  // Check if X falls inside any of the already processed [start, end] ranges for this Y row
  for (const [start, end] of rowRanges) {
    if (x >= start && x <= end) return true;
  }
  return false;
}

const GLOBAL_STATE_FILE = 'global-state.json';
const LOCAL_RESULTS_FILE = `local-results-${ZONE_NAME}.json`;

async function run() {
  const minX = Math.min(START_X, END_X);
  const maxX = Math.max(START_X, END_X);
  const minY = Math.min(START_Y, END_Y);
  const maxY = Math.max(START_Y, END_Y);
  const runStartTime = Date.now();

  let globalRanges = {};
  if (fs.existsSync(GLOBAL_STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(GLOBAL_STATE_FILE, 'utf8'));
      globalRanges = data.processed_ranges || {};
      log(`Restored global state using Range compression.`);
    } catch (err) {
      log(`Failed to parse global state: ${err.message}. Assuming empty.`, 'warn');
    }
  }

  const localDiscoveries = { users: {}, processed_ranges: {} };
  let newPixelsScanned = 0;
  let skippedPixels = 0;

  function markProcessedLocal(x, y) {
    if (!localDiscoveries.processed_ranges[y]) {
      localDiscoveries.processed_ranges[y] = [];
    }
    const row = localDiscoveries.processed_ranges[y];
    
    // If this pixel is adjacent to the last range we recorded, just extend the range (+1 to end limit)
    if (row.length > 0 && row[row.length - 1][1] === x - 1) {
      row[row.length - 1][1] = x;
    } else {
      // Otherwise, create a new standalone range point
      row.push([x, x]);
    }
  }

  let targetInterval = CFG_TARGET_INTERVAL;
  let minFloor = CFG_MIN_FLOOR;
  let consecutiveSuccesses = 0;

  // --- TILE-FIRST TRAVERSAL (Massive Optimization) ---
  // Calculates the tiles we need to visit, so we clear an entire tile before moving to the next.
  const startTileX = Math.floor(minX / TILE_SIZE);
  const endTileX = Math.floor(maxX / TILE_SIZE);
  const startTileY = Math.floor(minY / TILE_SIZE);
  const endTileY = Math.floor(maxY / TILE_SIZE);

  for (let ty = startTileY; ty <= endTileY; ty++) {
    for (let tx = startTileX; tx <= endTileX; tx++) {
      
      // Determine exact scanning boundaries inside THIS specific tile
      const tMinX = Math.max(minX, tx * TILE_SIZE);
      const tMaxX = Math.min(maxX, (tx + 1) * TILE_SIZE - 1);
      const tMinY = Math.max(minY, ty * TILE_SIZE);
      const tMaxY = Math.min(maxY, (ty + 1) * TILE_SIZE - 1);

      for (let y = tMinY; y <= tMaxY; y++) {
        for (let x = tMinX; x <= tMaxX; x++) {
          if (isShuttingDown) break;
          if (Date.now() - runStartTime >= RUN_DURATION_MS) {
            log(`5.5 hour limit reached. Yielding runner...`, 'warn');
            isShuttingDown = true;
            break;
          }

          if (isProcessedGlobal(x, y, globalRanges)) {
            skippedPixels++;
            continue;
          }

          const { tileX, tileY, pixelX, pixelY } = getCoords(x, y);

          // Skip Blank Pixels using Image map
          try {
            const png = await getTileImage(tileX, tileY);
            if (isPixelBlank(png, pixelX, pixelY)) {
              markProcessedLocal(x, y);
              skippedPixels++;
              continue; 
            }
          } catch (err) {
            log(`Failed to load tile image to verify pixel (${x}, ${y}): ${err.message}. Assuming painted.`, 'warn');
          }

          let resolved = false;
          const reqStart = Date.now();

          while (!resolved && !isShuttingDown) {
            const res = await fetchPixelOfficial(tileX, tileY, pixelX, pixelY);
            const duration = Date.now() - reqStart;

            if (res.success) {
              consecutiveSuccesses++;
              resolved = true;
              
              if (res.username !== 'Blank / Unknown') {
                const key = res.discord || res.username;
                if (!localDiscoveries.users[key]) {
                  localDiscoveries.users[key] = { 
                    username: res.username, discord: res.discord, allianceName: res.allianceName, pixels_painted: 0 
                  };
                }
                localDiscoveries.users[key].pixels_painted++;
              }
              
              markProcessedLocal(x, y);
              newPixelsScanned++;

              if (CFG_STEP_DOWN_MS > 0 && consecutiveSuccesses >= CFG_STREAK_REQS && targetInterval > minFloor) {
                targetInterval = Math.max(minFloor, targetInterval - CFG_STEP_DOWN_MS);
              }

              if (newPixelsScanned % 500 === 0) {
                log(`Progress: Scanned ${newPixelsScanned} new pixels (Skipped ${skippedPixels} known/blank).`);
                fs.writeFileSync(LOCAL_RESULTS_FILE, JSON.stringify(localDiscoveries));
              }

              const sleepRemaining = Math.max(0, targetInterval - duration);
              if (sleepRemaining > 0) await wait(sleepRemaining, shutdownController.signal);

            } else if (res.status === 429) {
              consecutiveSuccesses = 0;
              minFloor = Math.max(minFloor, targetInterval + Math.max(10, CFG_STEP_DOWN_MS));
              targetInterval += CFG_PENALTY_MS_429;
              log(`Rate limited! Pausing for ${CFG_PAUSE_SEC_429}s...`, 'warn');
              await wait(CFG_PAUSE_SEC_429 * 1000, shutdownController.signal);
            } else {
              log(`HTTP ${res.status}. Retrying in 10s...`, 'error');
              consecutiveSuccesses = 0;
              targetInterval += Math.ceil(CFG_STEP_DOWN_MS);
              await wait(10000, shutdownController.signal);
            }
          }
        }
        if (isShuttingDown) break;
      }
      if (isShuttingDown) break;
    }
    if (isShuttingDown) break;
  }

  fs.writeFileSync(LOCAL_RESULTS_FILE, JSON.stringify(localDiscoveries));
  log(`Finished. Scanned ${newPixelsScanned} new pixels. Skipped ${skippedPixels} known/blank pixels.`, 'success');
  process.exit(0);
}

process.on('SIGINT', () => { isShuttingDown = true; shutdownController.abort(); });
process.on('SIGTERM', () => { isShuttingDown = true; shutdownController.abort(); });

run().catch((err) => {
  log(`Fatal error: ${err.message}`, 'error');
  process.exit(1);
});