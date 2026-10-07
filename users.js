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

if (ZONE_NAME === 'DONE') {
  console.log('✅ All zones and levels completely scanned!');
  process.exit(0);
}

const totalPixels = (END_X - START_X + 1) * (END_Y - START_Y + 1);
const RUN_DURATION_MS = parseEnvInt(process.env.RUN_DURATION_MINS, 330) * 60 * 1000; 

const CFG_TARGET_INTERVAL = parseEnvInt(process.env.TARGET_INTERVAL, 400);
const CFG_MIN_FLOOR = parseEnvInt(process.env.MIN_FLOOR, 210);
const CFG_PAUSE_SEC_429 = parseEnvInt(process.env.PAUSE_SEC_429, 321);
const CFG_PENALTY_MS_429 = parseEnvInt(process.env.PENALTY_MS_429, 400);
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

let tableHasHeader = false;

function logTable(logLine) {
  if (!tableHasHeader) {
    log(`- Scanned - | - Skipped - | - Total - | - Level -`);
    tableHasHeader = true;
  }
  log(logLine);
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

const tileCache = new Map();
async function getTileImage(tileX, tileY) {
  const key = `${tileX}_${tileY}`;
  if (tileCache.has(key)) return tileCache.get(key);

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

function isPixelForLevel(x, y, lvl) {
  if (lvl > 8) return false; 
  if (lvl === 1) return (x % 128 === 0) && (y % 128 === 0);
  
  const step = 128 / Math.pow(2, lvl - 1);
  const prevStep = 128 / Math.pow(2, lvl - 2);
  
  return (x % step === 0) && (y % step === 0) && !((x % prevStep === 0) && (y % prevStep === 0));
}

function isProcessedGlobal(x, y, ranges) {
  const rowRanges = ranges[y];
  if (!rowRanges) return false;
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

  let zoneProgress = { level: 1, scanned: 0, ranges: {} };
  if (fs.existsSync(GLOBAL_STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(GLOBAL_STATE_FILE, 'utf8'));
      if (data.zone_progress && data.zone_progress[ZONE_NAME]) {
        zoneProgress = data.zone_progress[ZONE_NAME];
        log(`Restored global state for region. Resuming level ${zoneProgress.level}.`);
      }
    } catch (err) {
      log(`Failed to parse global state. Assuming empty.`, 'warn');
    }
  }

  let currentLevel = zoneProgress.level || 1;

  const localDiscoveries = { 
    zone: ZONE_NAME,
    completed_levels: [],
    current_level: currentLevel,
    scanned_count: 0,
    users: {}, 
    ranges: {} 
  };
  
  let newPixelsScanned = 0;
  let skippedPixels = 0;

  function markProcessedLocal(x, y) {
    if (!localDiscoveries.ranges[y]) localDiscoveries.ranges[y] = [];
    const row = localDiscoveries.ranges[y];
    
    if (row.length > 0 && row[row.length - 1][1] === x - 1) {
      row[row.length - 1][1] = x;
    } else {
      row.push([x, x]);
    }
    localDiscoveries.scanned_count++;
  }

  let targetInterval = CFG_TARGET_INTERVAL;
  let minFloor = CFG_MIN_FLOOR;
  let consecutiveSuccesses = 0;

  const startTileX = Math.floor(minX / TILE_SIZE);
  const endTileX = Math.floor(maxX / TILE_SIZE);
  const startTileY = Math.floor(minY / TILE_SIZE);
  const endTileY = Math.floor(maxY / TILE_SIZE);

  while (currentLevel <= 8 && !isShuttingDown) {
    let levelFinishedCompletely = true;
    
    // Only apply global ranges if we are on the level that the global state left off on.
    // If we leveled up locally, global ranges no longer apply to this new level.
    const activeGlobalRanges = (currentLevel === zoneProgress.level) ? zoneProgress.ranges : {};

    for (let ty = startTileY; ty <= endTileY; ty++) {
      for (let tx = startTileX; tx <= endTileX; tx++) {
        
        const tMinX = Math.max(minX, tx * TILE_SIZE);
        const tMaxX = Math.min(maxX, (tx + 1) * TILE_SIZE - 1);
        const tMinY = Math.max(minY, ty * TILE_SIZE);
        const tMaxY = Math.min(maxY, (ty + 1) * TILE_SIZE - 1);

        for (let y = tMinY; y <= tMaxY; y++) {
          for (let x = tMinX; x <= tMaxX; x++) {
            if (isShuttingDown) { levelFinishedCompletely = false; break; }
            
            if (!isPixelForLevel(x, y, currentLevel)) continue;

            if (Date.now() - runStartTime >= RUN_DURATION_MS) {
              log(`Time limit reached. Yielding runner...`, 'warn');
              isShuttingDown = true;
              levelFinishedCompletely = false;
              break;
            }

            if (isProcessedGlobal(x, y, activeGlobalRanges)) {
              skippedPixels++;
              continue;
            }

            const { tileX, tileY, pixelX, pixelY } = getCoords(x, y);

            try {
              const png = await getTileImage(tileX, tileY);
              if (isPixelBlank(png, pixelX, pixelY)) {
                markProcessedLocal(x, y);
                skippedPixels++;
                continue; 
              }
            } catch (err) {
              log(`Failed to load tile map (${x}, ${y}): ${err.message}. Assuming painted.`, 'warn');
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

                if (newPixelsScanned % 100 === 0) {
                  logTable(`${newPixelsScanned.toString().padStart(12, ' ')}|${skippedPixels.toString().padStart(13, ' ')}|${totalPixels.toString().padStart(11, ' ')}|${currentLevel.toString().padStart(10, ' ')}`);
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

    if (levelFinishedCompletely && !isShuttingDown) {
      log(`Level ${currentLevel} completely scanned for zone ${ZONE_NAME}! Advancing to Level ${currentLevel + 1}...`, 'success');
      localDiscoveries.completed_levels.push(currentLevel);
      currentLevel++;
      localDiscoveries.current_level = currentLevel;
      localDiscoveries.ranges = {};
      localDiscoveries.scanned_count = 0;
      fs.writeFileSync(LOCAL_RESULTS_FILE, JSON.stringify(localDiscoveries));
    }
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