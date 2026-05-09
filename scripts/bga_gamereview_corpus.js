#!/usr/bin/env node
/*
 * Read-only BGA gamereview corpus runner.
 *
 * Allowed: navigate authorized Chrome/CDP to public/visible gamereview pages,
 * read document text, parse visible log rows, and write local evidence.
 * Forbidden: gameplay moves, game-action clicks, hidden BGA APIs.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const model = require('../extension/src/cardModel.js');

const PROJECT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT, 'Evidence', 'Corpus-Runs');
const PORT = process.env.BGA_CDP_PORT || '9222';
const HILL218_GAMESTATS_URL = 'https://boardgamearena.com/gamestats?game_id=1110';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function cdpSocket(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            reject(new Error(`CDP timeout after 20000ms: ${method}`));
          }, 20000);
          pending.set(id, {
            resolve(value) {
              clearTimeout(timeout);
              resolve(value);
            },
            reject(error) {
              clearTimeout(timeout);
              reject(error);
            },
          });
        });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', reject);
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function waitForReady(cdp) {
  for (let i = 0; i < 80; i += 1) {
    const state = await evaluate(cdp, 'document.readyState').catch(() => 'loading');
    if (state === 'complete') return state;
    await sleep(250);
  }
  return evaluate(cdp, 'document.readyState').catch(() => 'unknown');
}

async function navigateTo(cdp, url) {
  await cdp.send('Page.stopLoading').catch(() => null);
  try {
    await cdp.send('Page.navigate', { url });
    return { ok: true, error: '' };
  } catch (error) {
    const message = error.message || String(error);
    await cdp.send('Page.stopLoading').catch(() => null);
    await evaluate(cdp, `location.href = ${JSON.stringify(url)}`).catch(() => null);
    return { ok: false, error: message };
  }
}

async function waitForReviewLogText(cdp) {
  let latest = '';
  for (let i = 0; i < 80; i += 1) {
    latest = await evaluate(cdp, 'document.body?.innerText || document.body?.textContent || ""').catch(() => '');
    if (/\bGame log\b/i.test(latest) && /\b(?:placed|returned|has drawn|attacked|Air Strike)\b/i.test(latest)) return latest;
    await sleep(500);
  }
  return latest;
}

async function ensureGamereviewViewpoint(cdp) {
  const clicked = await evaluate(cdp, `(() => {
    const bodyText = document.body?.innerText || document.body?.textContent || "";
    if (/\\b(?:placed|returned|has drawn|attacked|Air Strike)\\b/i.test(bodyText)) return false;
    const link = document.querySelector('a[id^="choosePlayerLink_"], .choosePlayerLink');
    if (!link) return false;
    link.scrollIntoView({ block: 'center' });
    link.click();
    return true;
  })()`).catch(() => false);
  if (clicked) {
    await sleep(3500);
    await waitForReady(cdp);
  }
  return clicked;
}

function normalizeLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

function tableIdFrom(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/[?&]table=(\d+)/) || text.match(/\b(\d{6,})\b/);
  return match ? match[1] : '';
}

function tableIdFromReviewText(text) {
  const value = String(text || '');
  const match = value.match(/\bReplay\s+The Battle for Hill 218\s+#(\d+)\b/i)
    || value.match(/\btable=(\d{6,})\b/i);
  return match ? match[1] : '';
}

function gamereviewUrl(tableId) {
  return `https://boardgamearena.com/gamereview?table=${tableId}`;
}

function extractHill218CandidateIdsFromLinks(links = []) {
  const ids = [];
  for (const link of links) {
    const text = normalizeLine(link?.text || '');
    const href = String(link?.href || '');
    if (!/\bThe Battle for Hill 218\b/i.test(text)) continue;
    const tableId = tableIdFrom(href);
    if (tableId && !ids.includes(tableId)) ids.push(tableId);
  }
  return ids;
}

function extractReviewPlayersFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const players = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:1st|2nd|3rd|4th)$/.test(lines[index])) continue;
    const name = lines[index + 1] || '';
    if (name && !/^\(|choose this player$/i.test(name)) players.push(name);
    if (players.length >= 2) break;
  }
  return players;
}

function isReviewActionLine(line) {
  return /\b(?:placed|played\s+an?\s+Air Strike|has drawn|returned\s+\d+\s+cards?|attacked\s+the)\b/i.test(line);
}

function collectReviewLogEventsFromText(text) {
  const start = String(text || '').search(/\bGame log\b/i);
  if (start < 0) return [];
  const tail = String(text || '').slice(start);
  const end = tail.search(/\b(?:End of game|Thinking time evolution)\b/i);
  const logText = end >= 0 ? tail.slice(0, end) : tail;
  const lines = logText.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const events = [];
  let move = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const moveMatch = lines[index].match(/^Move\s+(\d+)\s*:?\s*$/i);
    if (moveMatch) {
      move = Number(moveMatch[1]);
      continue;
    }
    if (!isReviewActionLine(lines[index])) continue;
    events.push({
      id: `review-move-${move || 'unknown'}-${index}`,
      text: lines[index],
      source: 'review-game-log',
    });
  }
  return events;
}

function repeatedPlacementCases(events) {
  const counts = new Map();
  for (const event of events) {
    const parsed = model.parseBgaLogLine(event);
    if (!parsed || parsed.type !== 'place') continue;
    const key = `${parsed.actor}|${parsed.card}|${parsed.location?.x},${parsed.location?.y}`;
    const item = counts.get(key) || { actor: parsed.actor, card: parsed.card, location: parsed.location, count: 0, lines: [] };
    item.count += 1;
    item.lines.push(parsed.line);
    counts.set(key, item);
  }
  return [...counts.values()].filter((item) => item.count > 1);
}

function cardOveruseWarnings(summary) {
  const warnings = [];
  for (const role of ['own', 'opponent']) {
    const used = role === 'own' ? summary.ownUsed : summary.opponentUsed;
    for (const [card, count] of Object.entries(used)) {
      if (count > model.DECK[card].total) warnings.push(`${role} ${card} overused: ${count}/${model.DECK[card].total}`);
    }
  }
  return warnings;
}

function analyzeReviewText({ tableId = '', url = '', text = '' } = {}) {
  const markers = pageMarkers(text);
  const players = extractReviewPlayersFromText(text);
  const events = collectReviewLogEventsFromText(text);
  const summary = model.parseBgaLogLines(events, {
    ownNames: players[0] ? [players[0]] : undefined,
    opponentNames: players[1] ? [players[1]] : undefined,
  });
  const unknownSpent = Object.values(summary.unknownUsed).reduce((sum, value) => sum + value, 0);
  const parseCoverage = events.length ? summary.events.length / events.length : 0;
  const blockers = [
    ...(markers.hasReplayRateLimit ? ['BGA replay rate limit reached'] : []),
    ...(players.length < 2 ? ['could not identify two review players'] : []),
    ...(events.length === 0 ? ['no gamereview action rows found'] : []),
    ...(summary.events.length !== events.length ? [`parse drift: ${summary.events.length}/${events.length} action rows parsed`] : []),
    ...(unknownSpent > 0 ? [`unknown spent-card events: ${unknownSpent}`] : []),
    ...cardOveruseWarnings(summary),
  ];
  const repeatedPlacements = repeatedPlacementCases(events);
  return {
    tableId,
    url,
    players,
    eventRows: events.length,
    parsedEvents: summary.events.length,
    parseCoverage,
    actionableCoverage: summary.metrics.actionableCoverage,
    unknownSpent,
    totals: summary.replayLedger.totals,
    deckComplete: summary.replayLedger.totals.own.used === 26 && summary.replayLedger.totals.opponent.used === 26,
    perCard: {
      own: summary.ownUsed,
      opponent: summary.opponentUsed,
    },
    repeatedPlacements,
    blockers,
    ok: blockers.length === 0,
  };
}

function blockedTableResult({ tableId = '', url = '', error = '' } = {}) {
  return {
    tableId,
    url,
    players: [],
    eventRows: 0,
    parsedEvents: 0,
    parseCoverage: 0,
    actionableCoverage: 0,
    unknownSpent: 0,
    totals: {
      own: { used: 0, left: 26 },
      opponent: { used: 0, left: 26 },
      unknown: { used: 0, left: 26 },
    },
    deckComplete: false,
    perCard: {
      own: model.emptyCounts(),
      opponent: model.emptyCounts(),
    },
    repeatedPlacements: [],
    blockers: [error || 'table could not be read'],
    ok: false,
  };
}

function compactEvidence(text, maxLength = 180) {
  return normalizeLine(text).slice(0, maxLength);
}

function fixtureSafeName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function writeGamereviewTextCache({ cacheDir = '', tableId = '', title = '', url = '', currentUrl = '', text = '' } = {}) {
  if (!cacheDir) return '';
  fs.mkdirSync(cacheDir, { recursive: true });
  const id = fixtureSafeName(tableId || tableIdFromReviewText(text) || tableIdFrom(url) || tableIdFrom(currentUrl) || 'unknown');
  const filePath = path.join(cacheDir, `${id}.txt`);
  fs.writeFileSync(filePath, [
    title ? `# ${title}` : '',
    url ? `Source URL: ${url}` : '',
    currentUrl && currentUrl !== url ? `Current URL: ${currentUrl}` : '',
    '',
    text,
    '',
  ].filter((line, index, rows) => line || index < rows.length - 2).join('\n'));
  return filePath;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function pageMarkers(text) {
  const value = String(text || '');
  return {
    hasReplay: /\bReplay The Battle for Hill 218\b/i.test(value),
    hasOtherReplayGame: /\bReplay\s+(?!The Battle for Hill 218\b)[^\n#]+#\d+/i.test(value),
    hasChooseViewpoint: /\bChoose your point of view\b/i.test(value),
    hasGameLog: /\bGame log\b/i.test(value),
    hasEndOfGame: /\bEnd of game\b/i.test(value),
    hasThinkingTime: /\bThinking time evolution\b/i.test(value),
    hasAccessDenied: /\b(?:access denied|not authorized|not allowed|permission|please log in|you must be logged)\b/i.test(value),
    hasNotFound: /\b(?:not found|does not exist|no such table|game not found)\b/i.test(value),
    hasNeverStarted: /\b(?:game never started|never started and cannot be replayed)\b/i.test(value),
    hasInProgress: /\b(?:game is in progress|game has not ended|table is still running|current game)\b/i.test(value),
    hasArchiveNotReady: /\b(?:Searching for the game archive|Please wait a few|archive is being|archive.*not.*ready)\b/i.test(value),
    hasReplayRateLimit: /\b(?:reached a limit\s*\(replay\)|replay limit|too many replays)(?=\W|$)/i.test(value),
    hasNavigationReadError: /\b(?:CDP timeout|Page\.navigate|Runtime\.evaluate failed|navigation\/read error)\b/i.test(value),
  };
}

function classifyGamereviewPage({ tableId = '', url = '', currentUrl = '', title = '', text = '', navigationError = '' } = {}) {
  const markers = pageMarkers(`${title}\n${text}`);
  const players = extractReviewPlayersFromText(text);
  const events = collectReviewLogEventsFromText(text);
  let classification = 'unknown-empty-page';
  const evidence = [];

  if (events.length > 0) {
    classification = 'readable-gamereview';
    evidence.push(`${events.length} action rows found`);
  } else if (markers.hasAccessDenied) {
    classification = 'access-blocked';
    evidence.push('access/login marker found');
  } else if (markers.hasNotFound) {
    classification = 'not-found';
    evidence.push('not-found marker found');
  } else if (markers.hasNeverStarted) {
    classification = 'never-started';
    evidence.push('game never started marker found');
  } else if (markers.hasArchiveNotReady) {
    classification = 'archive-not-ready';
    evidence.push('archive-not-ready marker found');
  } else if (markers.hasReplayRateLimit) {
    classification = 'replay-rate-limited';
    evidence.push('BGA replay rate limit marker found');
  } else if (markers.hasOtherReplayGame) {
    classification = 'wrong-game';
    evidence.push('replay page is not The Battle for Hill 218');
  } else if (markers.hasInProgress) {
    classification = 'unfinished-or-live-table';
    evidence.push('in-progress marker found');
  } else if (navigationError || markers.hasNavigationReadError) {
    classification = 'navigation-read-error';
    evidence.push(`navigation/read error: ${compactEvidence(navigationError || text || title, 120)}`);
  } else if (markers.hasReplay && markers.hasChooseViewpoint && players.length >= 2 && !markers.hasGameLog) {
    classification = 'review-shell-without-game-log';
    evidence.push('replay shell and players visible, but no Game log section');
  } else if (markers.hasGameLog && events.length === 0) {
    classification = 'game-log-without-action-rows';
    evidence.push('Game log section visible, but no recognized action rows');
  } else if (!markers.hasReplay && !markers.hasGameLog && players.length === 0) {
    classification = 'redirect-or-generic-page';
    evidence.push('no replay title, players, or Game log markers');
  }

  if (players.length) evidence.push(`players: ${players.join(' vs ')}`);
  if (title) evidence.push(`title: ${compactEvidence(title, 90)}`);
  return {
    tableId,
    requestedUrl: url || gamereviewUrl(tableId),
    currentUrl,
    title,
    classification,
    players,
    actionRows: events.length,
    textLength: String(text || '').length,
    navigationError,
    markers,
    evidence,
    sample: compactEvidence(text, 260),
  };
}

function classifyFixtureText({ fixturePath = '', text = '' } = {}) {
  const titleMatch = String(text || '').match(/^\s*#\s*(.+)$/m);
  const title = titleMatch ? normalizeLine(titleMatch[1]) : '';
  const tableId = tableIdFromReviewText(text) || tableIdFrom(fixturePath) || 'fixture';
  return classifyGamereviewPage({
    tableId,
    url: fixturePath,
    currentUrl: fixturePath,
    title,
    text,
  });
}

function auditFixtureText({ fixturePath = '', text = '' } = {}) {
  const classification = classifyFixtureText({ fixturePath, text });
  const analysis = classification.classification === 'readable-gamereview'
    ? analyzeReviewText({ tableId: classification.tableId, url: fixturePath, text })
    : null;
  return {
    fixturePath,
    tableId: classification.tableId,
    sha256: sha256(text),
    bytes: Buffer.byteLength(String(text || ''), 'utf8'),
    lines: String(text || '').split(/\r?\n/).length,
    classification: classification.classification,
    players: classification.players,
    actionRows: classification.actionRows,
    parseOk: analysis ? analysis.ok : false,
    parsedEvents: analysis ? analysis.parsedEvents : 0,
    eventRows: analysis ? analysis.eventRows : classification.actionRows,
    blockers: analysis ? analysis.blockers : classification.evidence,
    duplicateOf: '',
  };
}

function buildFixtureManifestRecords(items = []) {
  const firstByHash = new Map();
  const firstByTable = new Map();
  const records = items.map((item) => {
    const record = auditFixtureText(item);
    if (firstByHash.has(record.sha256)) record.duplicateOf = firstByHash.get(record.sha256);
    else firstByHash.set(record.sha256, record.fixturePath);
    if (record.tableId && !firstByTable.has(record.tableId)) firstByTable.set(record.tableId, record.fixturePath);
    return record;
  });
  const tableCounts = records.reduce((acc, record) => {
    acc[record.tableId] = (acc[record.tableId] || 0) + 1;
    return acc;
  }, {});
  const aggregate = records.reduce((acc, record) => {
    acc.fixtures += 1;
    acc.bytes += record.bytes;
    acc.byClassification[record.classification] = (acc.byClassification[record.classification] || 0) + 1;
    if (record.classification === 'readable-gamereview') acc.readable += 1;
    if (record.parseOk) acc.parseOk += 1;
    if (record.duplicateOf) acc.duplicateFiles += 1;
    return acc;
  }, {
    fixtures: 0,
    uniqueHashes: firstByHash.size,
    duplicateFiles: 0,
    readable: 0,
    parseOk: 0,
    uniqueTables: Object.keys(tableCounts).filter(Boolean).length,
    duplicateTableIds: Object.values(tableCounts).filter((count) => count > 1).length,
    bytes: 0,
    byClassification: {},
  });
  return { aggregate, results: records };
}

function buildFixtureIntakePlan({ intakeItems = [], existingItems = [], promoteDir = '' } = {}) {
  const existing = buildFixtureManifestRecords(existingItems);
  const existingHashes = new Map(existing.results.map((record) => [record.sha256, record.fixturePath]));
  const existingTables = new Map(existing.results.filter((record) => record.tableId).map((record) => [record.tableId, record.fixturePath]));
  const seenHashes = new Map();
  const seenTables = new Map();
  const results = intakeItems.map((item) => {
    const record = auditFixtureText(item);
    let status = 'PROMOTE';
    const reasons = [];
    if (record.classification !== 'readable-gamereview') {
      status = 'BLOCKED';
      reasons.push(`classification=${record.classification}`);
    }
    if (!record.parseOk) {
      status = 'BLOCKED';
      reasons.push(record.blockers.join('; ') || 'parser not OK');
    }
    if (existingHashes.has(record.sha256)) {
      status = 'SKIP_DUPLICATE_HASH';
      reasons.push(`same hash as ${existingHashes.get(record.sha256)}`);
    } else if (seenHashes.has(record.sha256)) {
      status = 'SKIP_DUPLICATE_HASH';
      reasons.push(`same hash as staged ${seenHashes.get(record.sha256)}`);
    }
    if (status === 'PROMOTE' && record.tableId && existingTables.has(record.tableId)) {
      status = 'SKIP_DUPLICATE_TABLE';
      reasons.push(`same table as ${existingTables.get(record.tableId)}`);
    } else if (status === 'PROMOTE' && record.tableId && seenTables.has(record.tableId)) {
      status = 'SKIP_DUPLICATE_TABLE';
      reasons.push(`same table as staged ${seenTables.get(record.tableId)}`);
    }
    seenHashes.set(record.sha256, record.fixturePath);
    if (record.tableId) seenTables.set(record.tableId, record.fixturePath);
    const targetName = `${fixtureSafeName(record.tableId || path.basename(record.fixturePath, path.extname(record.fixturePath)) || record.sha256.slice(0, 12))}.txt`;
    return {
      ...record,
      intakeStatus: status,
      intakeReasons: reasons,
      promoteTarget: status === 'PROMOTE' && promoteDir ? path.join(promoteDir, targetName) : '',
    };
  });
  const aggregate = results.reduce((acc, record) => {
    acc.intakeFixtures += 1;
    acc.byStatus[record.intakeStatus] = (acc.byStatus[record.intakeStatus] || 0) + 1;
    if (record.intakeStatus === 'PROMOTE') acc.promotable += 1;
    if (record.intakeStatus === 'BLOCKED') acc.blocked += 1;
    if (record.intakeStatus === 'SKIP_DUPLICATE_HASH') acc.duplicateHash += 1;
    if (record.intakeStatus === 'SKIP_DUPLICATE_TABLE') acc.duplicateTable += 1;
    return acc;
  }, {
    intakeFixtures: 0,
    existingFixtures: existing.aggregate.fixtures,
    promotable: 0,
    blocked: 0,
    duplicateHash: 0,
    duplicateTable: 0,
    byStatus: {},
  });
  return { aggregate, existing: existing.aggregate, results };
}

function hasReplayRateLimitResult(result = {}) {
  if (result.classification === 'replay-rate-limited') return true;
  if (result.markers?.hasReplayRateLimit) return true;
  if ((result.blockers || []).some((blocker) => /\breplay rate limit\b|\bBGA replay rate limit\b/i.test(blocker))) return true;
  return false;
}

function parseArgs(argv) {
  const tables = [];
  let file = '';
  let limit = 0;
  let fixture = '';
  let fixtureDir = '';
  let cacheDir = '';
  let allowBlocked = false;
  let classifyBlocked = false;
  let fixtureManifest = false;
  let fixtureIntake = false;
  let promoteDir = path.join(OUT_DIR, 'fixtures');
  let sourceGamestats = false;
  let sourceClicks = 3;
  let delayMs = 0;
  let stopOnRateLimit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--table' || arg === '--url') tables.push(argv[++index]);
    else if (arg === '--tables-file') file = argv[++index];
    else if (arg === '--limit') limit = Number(argv[++index]) || 0;
    else if (arg === '--fixture-text') fixture = argv[++index];
    else if (arg === '--fixture-dir' || arg === '--fixtures-dir') fixtureDir = argv[++index];
    else if (arg === '--cache-dir') cacheDir = argv[++index];
    else if (arg === '--allow-blocked') allowBlocked = true;
    else if (arg === '--classify-blocked') classifyBlocked = true;
    else if (arg === '--fixture-manifest' || arg === '--audit-fixtures') fixtureManifest = true;
    else if (arg === '--fixture-intake' || arg === '--intake-fixtures') fixtureIntake = true;
    else if (arg === '--promote-dir') promoteDir = argv[++index];
    else if (arg === '--source-gamestats') sourceGamestats = true;
    else if (arg === '--source-clicks') sourceClicks = Number(argv[++index]) || sourceClicks;
    else if (arg === '--delay-ms' || arg === '--pace-ms') delayMs = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === '--stop-on-rate-limit') stopOnRateLimit = true;
    else if (/^https?:|^\d{6,}$/.test(arg)) tables.push(arg);
  }
  return { tables, file, limit, fixture, fixtureDir, cacheDir, allowBlocked, classifyBlocked, fixtureManifest, fixtureIntake, promoteDir, sourceGamestats, sourceClicks, delayMs, stopOnRateLimit };
}

function loadTableIds({ tables = [], file = '', limit = 0 } = {}) {
  const values = [...tables];
  if (file) {
    values.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  const ids = [...new Set(values.map(tableIdFrom).filter(Boolean))];
  return limit > 0 ? ids.slice(0, limit) : ids;
}

function loadFixturePaths({ fixture = '', fixtureDir = '', limit = 0 } = {}) {
  const paths = [];
  if (fixture) paths.push(fixture);
  if (fixtureDir) {
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (/\.(?:txt|md|log)$/i.test(entry.name)) paths.push(fullPath);
      }
    };
    visit(fixtureDir);
  }
  const unique = [...new Set(paths)].sort();
  return limit > 0 ? unique.slice(0, limit) : unique;
}

async function connectCdp() {
  const version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
  if (!version) throw new Error(`CDP is not available on port ${PORT}. Run npm run bga:cdp:launch first.`);
  const tabs = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
  const tab = tabs.find((item) => item.type === 'page' && String(item.url || '').includes('boardgamearena.com')) || tabs.find((item) => item.type === 'page');
  if (!tab) throw new Error('No page tab found via CDP.');
  const cdp = await cdpSocket(tab.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { cdp, browser: version.Browser };
}

async function readGamereviewText(cdp, tableId) {
  const url = gamereviewUrl(tableId);
  const navigation = await navigateTo(cdp, url);
  await sleep(3000);
  await waitForReady(cdp);
  await ensureGamereviewViewpoint(cdp);
  const text = await waitForReviewLogText(cdp);
  const title = await evaluate(cdp, 'document.title || ""').catch(() => '');
  return { tableId, url, title, text, navigationError: navigation.error };
}

async function readGamereviewPageForClassification(cdp, tableId) {
  const url = gamereviewUrl(tableId);
  const navigation = await navigateTo(cdp, url);
  await sleep(3000);
  await waitForReady(cdp);
  await ensureGamereviewViewpoint(cdp);
  let text = '';
  for (let index = 0; index < 24; index += 1) {
    text = await evaluate(cdp, 'document.body?.innerText || document.body?.textContent || ""').catch(() => '');
    const markers = pageMarkers(text);
    const actionRows = collectReviewLogEventsFromText(text).length;
    if (actionRows > 0) break;
    if (markers.hasAccessDenied || markers.hasNotFound || markers.hasNeverStarted || markers.hasInProgress || markers.hasArchiveNotReady) break;
    if (markers.hasReplay && markers.hasChooseViewpoint && !markers.hasGameLog && index >= 4) break;
    await sleep(500);
  }
  const title = await evaluate(cdp, 'document.title || ""').catch(() => '');
  const currentUrl = await evaluate(cdp, 'location.href || ""').catch(() => '');
  return { tableId, url, currentUrl, title, text, navigationError: navigation.error };
}

function writeCorpusReport(results, meta = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `${stamp}-bga-gamereview-corpus.json`);
  const mdPath = path.join(OUT_DIR, `${stamp}-bga-gamereview-corpus.md`);
  const aggregate = {
    tables: results.length,
    ok: results.filter((result) => result.ok).length,
    blocked: results.filter((result) => !result.ok).length,
    deckComplete: results.filter((result) => result.deckComplete).length,
    repeatedPlacementTables: results.filter((result) => result.repeatedPlacements.length).length,
  };
  const report = { generatedAt: new Date().toISOString(), meta, aggregate, results };
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const rows = results.map((result) => [
    result.ok ? 'OK' : 'BLOCKED',
    result.tableId,
    result.players.join(' vs ') || 'unknown',
    `${result.parsedEvents}/${result.eventRows}`,
    `${result.totals.own.used}/${result.totals.own.left}`,
    `${result.totals.opponent.used}/${result.totals.opponent.left}`,
    result.deckComplete ? 'yes' : 'no',
    String(result.repeatedPlacements.length),
    result.blockers.join('; ') || '-',
  ]);
  fs.writeFileSync(mdPath, [
    `# BGA Gamereview Corpus ${stamp}`,
    '',
    `- Tables: ${aggregate.tables}`,
    `- OK: ${aggregate.ok}`,
    `- Blocked: ${aggregate.blocked}`,
    `- Deck complete: ${aggregate.deckComplete}`,
    `- Tables with repeated placements: ${aggregate.repeatedPlacementTables}`,
    '',
    '| Status | Table | Players | Parsed | Own used/left | Opp used/left | Deck complete | Repeats | Blockers |',
    '| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |',
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ')} |`),
    '',
    `JSON: \`${jsonPath}\``,
    '',
  ].join('\n'));
  return { mdPath, jsonPath, aggregate };
}

function writeClassificationReport(results, meta = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `${stamp}-bga-gamereview-blocker-classification.json`);
  const mdPath = path.join(OUT_DIR, `${stamp}-bga-gamereview-blocker-classification.md`);
  const aggregate = results.reduce((acc, result) => {
    acc.tables += 1;
    acc.byClassification[result.classification] = (acc.byClassification[result.classification] || 0) + 1;
    if (result.actionRows > 0) acc.readable += 1;
    return acc;
  }, { tables: 0, readable: 0, byClassification: {} });
  const report = { generatedAt: new Date().toISOString(), meta, aggregate, results };
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const rows = results.map((result) => [
    result.tableId,
    result.classification,
    result.players.join(' vs ') || 'unknown',
    result.actionRows,
    result.markers.hasGameLog ? 'yes' : 'no',
    result.markers.hasReplay ? 'yes' : 'no',
    result.evidence.join('; ') || '-',
  ]);
  fs.writeFileSync(mdPath, [
    `# BGA Gamereview Blocker Classification ${stamp}`,
    '',
    `- Tables: ${aggregate.tables}`,
    `- Readable action-row pages: ${aggregate.readable}`,
    `- Classification counts: ${Object.entries(aggregate.byClassification).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    '',
    '| Table | Classification | Players | Action rows | Game log | Replay shell | Evidence |',
    '| --- | --- | --- | ---: | --- | --- | --- |',
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ')} |`),
    '',
    `JSON: \`${jsonPath}\``,
    '',
  ].join('\n'));
  return { mdPath, jsonPath, aggregate };
}

function writeCandidateReport({ candidates = [], sourceUrl = HILL218_GAMESTATS_URL, clicks = 0, browser = '' } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const txtPath = path.join(OUT_DIR, `${stamp}-hill218-candidates.txt`);
  const jsonPath = path.join(OUT_DIR, `${stamp}-hill218-candidates.json`);
  const mdPath = path.join(OUT_DIR, `${stamp}-hill218-candidates.md`);
  const unique = [...new Set(candidates.map(tableIdFrom).filter(Boolean))];
  fs.writeFileSync(txtPath, `${unique.join('\n')}\n`);
  const report = {
    generatedAt: new Date().toISOString(),
    meta: { source: 'chrome-cdp-gamestats-visible-history', sourceUrl, clicks, browser },
    aggregate: { candidates: unique.length },
    candidates: unique,
    txtPath,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, [
    `# BGA Hill 218 Candidate Tables ${stamp}`,
    '',
    `- Source: ${sourceUrl}`,
    `- Visible history clicks: ${clicks}`,
    `- Candidate ids: ${unique.length}`,
    '',
    '| # | Table | Gamereview |',
    '| ---: | --- | --- |',
    ...unique.map((id, index) => `| ${index + 1} | ${id} | ${gamereviewUrl(id)} |`),
    '',
    `TXT: \`${txtPath}\``,
    `JSON: \`${jsonPath}\``,
    '',
  ].join('\n'));
  return { mdPath, jsonPath, txtPath, aggregate: report.aggregate };
}

function writeFixtureManifestReport({ aggregate, results }, meta = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `${stamp}-bga-fixture-manifest.json`);
  const mdPath = path.join(OUT_DIR, `${stamp}-bga-fixture-manifest.md`);
  const report = { generatedAt: new Date().toISOString(), meta, aggregate, results };
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const rows = results.map((result) => [
    result.duplicateOf ? 'DUPLICATE' : 'UNIQUE',
    result.tableId,
    result.classification,
    result.players.join(' vs ') || 'unknown',
    `${result.parsedEvents}/${result.eventRows}`,
    result.parseOk ? 'yes' : 'no',
    result.sha256.slice(0, 12),
    result.bytes,
    result.duplicateOf || '-',
    path.relative(PROJECT, result.fixturePath),
  ]);
  fs.writeFileSync(mdPath, [
    `# BGA Fixture Manifest ${stamp}`,
    '',
    `- Fixtures: ${aggregate.fixtures}`,
    `- Unique hashes: ${aggregate.uniqueHashes}`,
    `- Duplicate files: ${aggregate.duplicateFiles}`,
    `- Unique table ids: ${aggregate.uniqueTables}`,
    `- Duplicate table ids: ${aggregate.duplicateTableIds}`,
    `- Readable gamereviews: ${aggregate.readable}`,
    `- Parser OK fixtures: ${aggregate.parseOk}`,
    `- Classification counts: ${Object.entries(aggregate.byClassification).map(([key, value]) => `${key}=${value}`).join(', ') || '-'}`,
    `- Total bytes: ${aggregate.bytes}`,
    '',
    '| Status | Table | Classification | Players | Parsed | Parser OK | SHA256 | Bytes | Duplicate of | Fixture |',
    '| --- | --- | --- | --- | ---: | --- | --- | ---: | --- | --- |',
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ')} |`),
    '',
    `JSON: \`${jsonPath}\``,
    '',
  ].join('\n'));
  return { mdPath, jsonPath, aggregate };
}

function runFixtureManifest({ fixture = '', fixtureDir = '', limit = 0 } = {}) {
  const fixturePaths = loadFixturePaths({ fixture, fixtureDir, limit });
  if (!fixturePaths.length) throw new Error('No fixture files provided. Use --fixture-text path or --fixture-dir path.');
  const manifest = buildFixtureManifestRecords(fixturePaths.map((fixturePath) => ({
    fixturePath,
    text: fs.readFileSync(fixturePath, 'utf8'),
  })));
  return writeFixtureManifestReport(manifest, {
    source: 'fixture-text-manifest',
    fixture,
    fixtureDir,
    fixtureCount: fixturePaths.length,
  });
}

function writeFixtureIntakeReport({ aggregate, existing, results }, meta = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `${stamp}-bga-fixture-intake.json`);
  const mdPath = path.join(OUT_DIR, `${stamp}-bga-fixture-intake.md`);
  const report = { generatedAt: new Date().toISOString(), meta, aggregate, existing, results };
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const rows = results.map((result) => [
    result.intakeStatus,
    result.tableId,
    result.classification,
    result.players.join(' vs ') || 'unknown',
    `${result.parsedEvents}/${result.eventRows}`,
    result.sha256.slice(0, 12),
    result.intakeReasons.join('; ') || '-',
    result.promoteTarget ? path.relative(PROJECT, result.promoteTarget) : '-',
    path.relative(PROJECT, result.fixturePath),
  ]);
  fs.writeFileSync(mdPath, [
    `# BGA Fixture Intake ${stamp}`,
    '',
    `- Intake fixtures: ${aggregate.intakeFixtures}`,
    `- Existing clean fixtures: ${aggregate.existingFixtures}`,
    `- Promotable: ${aggregate.promotable}`,
    `- Blocked: ${aggregate.blocked}`,
    `- Duplicate hash skips: ${aggregate.duplicateHash}`,
    `- Duplicate table skips: ${aggregate.duplicateTable}`,
    `- Status counts: ${Object.entries(aggregate.byStatus).map(([key, value]) => `${key}=${value}`).join(', ') || '-'}`,
    '',
    '| Intake status | Table | Classification | Players | Parsed | SHA256 | Reasons | Promote target | Intake fixture |',
    '| --- | --- | --- | --- | ---: | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ')} |`),
    '',
    `JSON: \`${jsonPath}\``,
    '',
  ].join('\n'));
  return { mdPath, jsonPath, aggregate };
}

function runFixtureIntake({ fixture = '', fixtureDir = '', promoteDir = path.join(OUT_DIR, 'fixtures'), limit = 0 } = {}) {
  const intakePaths = loadFixturePaths({ fixture, fixtureDir, limit });
  if (!intakePaths.length) throw new Error('No intake fixture files provided. Use --fixture-text path or --fixture-dir path.');
  const existingPaths = fs.existsSync(promoteDir) ? loadFixturePaths({ fixtureDir: promoteDir }) : [];
  const plan = buildFixtureIntakePlan({
    intakeItems: intakePaths.map((fixturePath) => ({ fixturePath, text: fs.readFileSync(fixturePath, 'utf8') })),
    existingItems: existingPaths.map((fixturePath) => ({ fixturePath, text: fs.readFileSync(fixturePath, 'utf8') })),
    promoteDir,
  });
  return writeFixtureIntakeReport(plan, {
    source: 'fixture-intake-plan',
    fixture,
    fixtureDir,
    promoteDir,
    fixtureCount: intakePaths.length,
    existingCount: existingPaths.length,
  });
}

function shouldFailForBlockedAggregate(args = {}, aggregate = {}) {
  if (args.allowBlocked) return false;
  if (args.sourceGamestats || args.classifyBlocked || args.fixtureManifest || args.fixtureIntake) return false;
  return Number(aggregate.blocked || 0) > 0;
}

async function runCorpus({ tableIds = [], fixture = '', fixtureDir = '', cacheDir = '', limit = 0, delayMs = 0, stopOnRateLimit = false } = {}) {
  const fixturePaths = loadFixturePaths({ fixture, fixtureDir, limit });
  if (fixturePaths.length) {
    const results = fixturePaths.map((fixturePath) => {
      const text = fs.readFileSync(fixturePath, 'utf8');
      return analyzeReviewText({ tableId: tableIdFromReviewText(text) || tableIdFrom(fixturePath) || 'fixture', url: fixturePath, text });
    });
    return writeCorpusReport(results, {
      source: 'fixture-text',
      fixture,
      fixtureDir,
      fixtureCount: fixturePaths.length,
      delayMs,
      stopOnRateLimit,
    });
  }
  if (!tableIds.length) throw new Error('No table ids provided. Use --table 845846846 or --tables-file path.');
  const { cdp, browser } = await connectCdp();
  const results = [];
  try {
    for (let index = 0; index < tableIds.length; index += 1) {
      const tableId = tableIds[index];
      try {
        const page = await readGamereviewText(cdp, tableId);
        const cachePath = writeGamereviewTextCache({ cacheDir, ...page });
        const result = analyzeReviewText(page);
        if (cachePath) result.cachePath = cachePath;
        results.push(result);
        if (stopOnRateLimit && hasReplayRateLimitResult(result)) break;
      } catch (error) {
        const result = blockedTableResult({
          tableId,
          url: gamereviewUrl(tableId),
          error: error.message || String(error),
        });
        results.push(result);
        if (stopOnRateLimit && hasReplayRateLimitResult(result)) break;
      }
      if (delayMs > 0 && index < tableIds.length - 1) await sleep(delayMs);
    }
  } finally {
    cdp.close();
  }
  return writeCorpusReport(results, { source: 'chrome-cdp-gamereview', browser, cacheDir, delayMs, stopOnRateLimit });
}

async function runClassification({ tableIds = [], fixture = '', fixtureDir = '', limit = 0, cacheDir = '', delayMs = 0, stopOnRateLimit = false } = {}) {
  const fixturePaths = loadFixturePaths({ fixture, fixtureDir, limit });
  if (fixturePaths.length) {
    const results = fixturePaths.map((fixturePath) => classifyFixtureText({
      fixturePath,
      text: fs.readFileSync(fixturePath, 'utf8'),
    }));
    return writeClassificationReport(results, {
      source: 'fixture-text-classifier',
      fixture,
      fixtureDir,
      fixtureCount: fixturePaths.length,
      delayMs,
      stopOnRateLimit,
    });
  }
  if (!tableIds.length) throw new Error('No table ids or fixtures provided. Use --table 845846846, --tables-file path, --fixture-text path, or --fixture-dir path.');
  const { cdp, browser } = await connectCdp();
  const results = [];
  try {
    for (let index = 0; index < tableIds.length; index += 1) {
      const tableId = tableIds[index];
      try {
        const page = await readGamereviewPageForClassification(cdp, tableId);
        const cachePath = writeGamereviewTextCache({ cacheDir, ...page });
        const result = classifyGamereviewPage(page);
        if (cachePath) result.cachePath = cachePath;
        results.push(result);
        if (stopOnRateLimit && hasReplayRateLimitResult(result)) break;
      } catch (error) {
        const result = classifyGamereviewPage({
          tableId,
          url: gamereviewUrl(tableId),
          title: 'navigation/read error',
          text: error.message || String(error),
        });
        results.push(result);
        if (stopOnRateLimit && hasReplayRateLimitResult(result)) break;
      }
      if (delayMs > 0 && index < tableIds.length - 1) await sleep(delayMs);
    }
  } finally {
    cdp.close();
  }
  return writeClassificationReport(results, { source: 'chrome-cdp-gamereview-classifier', browser, cacheDir, delayMs, stopOnRateLimit });
}

async function runGamestatsSource({ limit = 25, clicks = 3 } = {}) {
  const { cdp, browser } = await connectCdp();
  try {
    await cdp.send('Page.navigate', { url: HILL218_GAMESTATS_URL });
    await sleep(5000);
    await waitForReady(cdp);
    let candidates = [];
    let performedClicks = 0;
    for (let index = 0; index <= clicks; index += 1) {
      const links = await evaluate(cdp, `(() => [...document.querySelectorAll('a[href]')]
        .map(a => ({ text: (a.innerText || a.textContent || '').trim(), href: a.href })))()`).catch(() => []);
      candidates = extractHill218CandidateIdsFromLinks(links);
      if ((limit > 0 && candidates.length >= limit) || index === clicks) break;
      const clicked = await evaluate(cdp, `(() => {
        const el = document.querySelector('#see_more_tables');
        if (!el) return false;
        el.scrollIntoView();
        el.click();
        return true;
      })()`).catch(() => false);
      if (!clicked) break;
      performedClicks += 1;
      await sleep(4500);
    }
    const selected = limit > 0 ? candidates.slice(0, limit) : candidates;
    return writeCandidateReport({ candidates: selected, clicks: performedClicks, browser });
  } finally {
    cdp.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tableIds = loadTableIds({ tables: args.tables, file: args.file, limit: args.limit });
  const result = args.sourceGamestats
    ? await runGamestatsSource({ limit: args.limit || 25, clicks: args.sourceClicks })
    : args.fixtureIntake
      ? runFixtureIntake({ fixture: args.fixture, fixtureDir: args.fixtureDir, promoteDir: args.promoteDir, limit: args.limit })
    : args.fixtureManifest
      ? runFixtureManifest({ fixture: args.fixture, fixtureDir: args.fixtureDir, limit: args.limit })
      : args.classifyBlocked
      ? await runClassification({ tableIds, fixture: args.fixture, fixtureDir: args.fixtureDir, limit: args.limit, cacheDir: args.cacheDir, delayMs: args.delayMs, stopOnRateLimit: args.stopOnRateLimit })
      : await runCorpus({ tableIds, fixture: args.fixture, fixtureDir: args.fixtureDir, cacheDir: args.cacheDir, limit: args.limit, delayMs: args.delayMs, stopOnRateLimit: args.stopOnRateLimit });
  console.log(JSON.stringify({
    ok: args.sourceGamestats || args.classifyBlocked || args.fixtureManifest || args.fixtureIntake ? true : result.aggregate.blocked === 0,
    allowBlocked: args.allowBlocked,
    classifyBlocked: args.classifyBlocked,
    fixtureManifest: args.fixtureManifest,
    fixtureIntake: args.fixtureIntake,
    promoteDir: args.promoteDir,
    sourceGamestats: args.sourceGamestats,
    cacheDir: args.cacheDir,
    delayMs: args.delayMs,
    stopOnRateLimit: args.stopOnRateLimit,
    aggregate: result.aggregate,
    mdPath: result.mdPath,
    jsonPath: result.jsonPath,
    txtPath: result.txtPath,
  }, null, 2));
  if (shouldFailForBlockedAggregate(args, result.aggregate)) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}

module.exports = {
  tableIdFrom,
  tableIdFromReviewText,
  parseArgs,
  loadTableIds,
  loadFixturePaths,
  fixtureSafeName,
  writeGamereviewTextCache,
  extractHill218CandidateIdsFromLinks,
  extractReviewPlayersFromText,
  collectReviewLogEventsFromText,
  repeatedPlacementCases,
  analyzeReviewText,
  blockedTableResult,
  classifyGamereviewPage,
  classifyFixtureText,
  auditFixtureText,
  buildFixtureManifestRecords,
  buildFixtureIntakePlan,
  shouldFailForBlockedAggregate,
  hasReplayRateLimitResult,
  writeCorpusReport,
  writeClassificationReport,
  writeFixtureManifestReport,
  writeFixtureIntakeReport,
  writeCandidateReport,
};
