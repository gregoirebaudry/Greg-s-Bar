const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const STATE_FILE = path.join(__dirname, 'bar-state.json');
const LOCAL_COCKTAILS_FILE = path.join(__dirname, 'cocktail.json');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:gregoire.baudry@gmail.com';

const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL || '';
const GOOGLE_SHEETS_WEBHOOK_SECRET = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET || '';

const COCKTAILS_GOOGLE_SHEET_SOURCE = process.env.COCKTAILS_GOOGLE_SHEET_SOURCE || '';
const COCKTAILS_GOOGLE_SHEET_GID = process.env.COCKTAILS_GOOGLE_SHEET_GID || '';
const COCKTAILS_GOOGLE_SHEET_SHEET = process.env.COCKTAILS_GOOGLE_SHEET_SHEET || '';
const ADMIN_REFRESH_SECRET = process.env.ADMIN_REFRESH_SECRET || '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('Web Push disabled: missing VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
}

const BARMEN = {
  Greg: {
    password: 'Tom Collins',
    title: "Greg's Bar order",
    summaryTitle: "Greg's Bar recap",
    openTitle: "Greg's Bar open",
    closeTitle: "Greg's Bar closed"
  },
  Clement: {
    password: 'Chartreuse',
    title: "Clement's Lounge order",
    summaryTitle: "Clement's Lounge recap",
    openTitle: "Clement's Lounge open",
    closeTitle: "Clement's Lounge closed"
  },
  Bastien: {
    password: 'Belle Bulle',
    title: 'Bar Stoss order',
    summaryTitle: 'Bar Stoss recap',
    openTitle: 'Bar Stoss open',
    closeTitle: 'Bar Stoss closed'
  }
};

const DEFAULT_STATE = {
  isOpen: false,
  barman: null,
  sessionId: null,
  sessionStartedAt: null,
  sessionOrders: 0,
  pendingOrders: [],
  orderHistory: [],
  adminSessionToken: null,
  updatedAt: new Date().toISOString()
};

let queue = Promise.resolve();
let cocktailsCache = [];
let cocktailsCacheUpdatedAt = null;
let cocktailsCacheSource = 'uninitialized';
let cocktailsCacheError = null;
let state = normalizeState(DEFAULT_STATE);

function normalizePendingOrders(rawOrders) {
  if (!Array.isArray(rawOrders)) return [];
  return rawOrders
    .map((order) => ({
      id: String(order && order.id ? order.id : crypto.randomUUID()),
      guestName: String(order && order.guestName ? order.guestName : '').trim(),
      cocktailName: String(order && order.cocktailName ? order.cocktailName : '').trim(),
      createdAt: String(order && order.createdAt ? order.createdAt : new Date().toISOString())
    }))
    .filter((order) => order.id && order.guestName && order.cocktailName);
}

function normalizeOrderHistory(rawOrders) {
  if (!Array.isArray(rawOrders)) return [];
  return rawOrders
    .map((order) => ({
      id: String(order && order.id ? order.id : crypto.randomUUID()),
      guestName: String(order && order.guestName ? order.guestName : '').trim(),
      cocktailName: String(order && order.cocktailName ? order.cocktailName : '').trim(),
      createdAt: String(order && order.createdAt ? order.createdAt : new Date().toISOString()),
      servedAt: order && order.servedAt ? String(order.servedAt) : null,
      sheetLoggedAt: order && order.sheetLoggedAt ? String(order.sheetLoggedAt) : null
    }))
    .filter((order) => order.id && order.guestName && order.cocktailName);
}

function normalizeState(raw) {
  const isOpen = Boolean(raw && raw.isOpen);
  const barman = raw && typeof raw.barman === 'string' && BARMEN[raw.barman] ? raw.barman : null;
  const sessionId = raw && typeof raw.sessionId === 'string' ? raw.sessionId : null;
  const sessionStartedAt = raw && raw.sessionStartedAt ? String(raw.sessionStartedAt) : null;
  const sessionOrders = Number.isFinite(Number(raw && raw.sessionOrders))
    ? Math.max(0, Math.floor(Number(raw && raw.sessionOrders)))
    : 0;
  const pendingOrders = normalizePendingOrders(raw && raw.pendingOrders);
  const orderHistory = normalizeOrderHistory(raw && raw.orderHistory);
  const adminSessionToken = raw && typeof raw.adminSessionToken === 'string' ? raw.adminSessionToken : null;

  return {
    isOpen: isOpen && Boolean(barman),
    barman: isOpen && barman ? barman : null,
    sessionId: isOpen && barman ? sessionId : null,
    sessionStartedAt: isOpen && barman ? sessionStartedAt : null,
    sessionOrders: isOpen && barman ? sessionOrders : 0,
    pendingOrders: isOpen && barman ? pendingOrders : [],
    orderHistory: isOpen && barman ? orderHistory : [],
    adminSessionToken: isOpen && barman ? adminSessionToken : null,
    updatedAt: raw && raw.updatedAt ? String(raw.updatedAt) : new Date().toISOString()
  };
}

function persistState(nextState) {
  state = normalizeState({ ...nextState, updatedAt: new Date().toISOString() });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    }
  } catch (error) {
    console.warn('Unable to read state file, using defaults.', error);
  }

  const initialState = normalizeState({ ...DEFAULT_STATE, updatedAt: new Date().toISOString() });
  fs.writeFileSync(STATE_FILE, JSON.stringify(initialState, null, 2));
  return initialState;
}

function buildPublicState(currentState) {
  return {
    isOpen: currentState.isOpen,
    barman: currentState.barman,
    sessionOrders: currentState.sessionOrders,
    pendingOrders: currentState.pendingOrders,
    updatedAt: currentState.updatedAt
  };
}

function isValidAdminToken(token) {
  return Boolean(token && state.isOpen && state.adminSessionToken && token === state.adminSessionToken);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function formatDateParts(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return { date: '', time: '' };
  }

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');

  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: `${hh}:${mi}:${ss}`
  };
}

function buildOrderEvent(sessionState, order, eventType, eventIso) {
  const when = formatDateParts(eventIso);
  return {
    orderId: order.id || '',
    eventType: eventType || '',
    sessionLabel: `${sessionState.barman || 'Unknown'} - ${sessionState.sessionId}`,
    barman: sessionState.barman || '',
    guestName: order.guestName || '',
    cocktailName: order.cocktailName || '',
    eventDate: when.date,
    eventTime: when.time,
    createdAtIso: eventIso
  };
}

function parseGoogleSheetId(input) {
  const value = String(input || '').trim();
  if (!value) return '';

  const idMatch = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (idMatch) return idMatch[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(value)) return value;

  return '';
}

function buildCocktailsSheetCsvUrl() {
  const sheetId = parseGoogleSheetId(COCKTAILS_GOOGLE_SHEET_SOURCE);
  if (!sheetId) {
    throw new Error('Missing or invalid COCKTAILS_GOOGLE_SHEET_SOURCE. Provide a public Google Sheet URL or Sheet ID.');
  }

  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/export`);
  url.searchParams.set('format', 'csv');

  if (COCKTAILS_GOOGLE_SHEET_GID) {
    url.searchParams.set('gid', COCKTAILS_GOOGLE_SHEET_GID);
  } else if (COCKTAILS_GOOGLE_SHEET_SHEET) {
    url.searchParams.set('sheet', COCKTAILS_GOOGLE_SHEET_SHEET);
  }

  return url.toString();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    if (ch === '\r') {
      continue;
    }

    cell += ch;
  }

  row.push(cell);
  const hasContent = row.some((value) => String(value || '').trim() !== '');
  if (hasContent) rows.push(row);
  return rows;
}

function sanitizeMultilineText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function parseTimesMadeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const cleaned = trimmed.replace(/[^0-9-]/g, '');
    if (!cleaned) return null;
    const parsed = Number.parseInt(cleaned, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
  }

  return null;
}

function getTimesMadeFromRecord(record) {
  if (!record || typeof record !== 'object') return 0;

  const candidates = [];
  Object.entries(record).forEach(([key, value]) => {
    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      normalizedKey === 'timesmade' ||
      normalizedKey === 'times' ||
      normalizedKey === 'made' ||
      normalizedKey === 'timesmadecount' ||
      normalizedKey === 'madecount' ||
      normalizedKey === 'orderscount' ||
      normalizedKey === 'ordercount' ||
      normalizedKey === 'timesordered' ||
      normalizedKey === 'numbermade'
    ) {
      candidates.push(value);
    }
  });

  for (const value of candidates) {
    const parsed = parseTimesMadeValue(value);
    if (parsed !== null) return parsed;
  }

  return 0;
}

function normalizeCocktailFromSheet(record, index) {
  const name = String(record.name || '').trim();
  const description = sanitizeMultilineText(record.description || '');
  const ingredients = sanitizeMultilineText(record.ingredients || '');
  const timesMade = getTimesMadeFromRecord(record);
  const image = String(record.image || record.images || record.img || '').trim();
  const id = String(record.id || name || `cocktail-${index + 1}`).trim();
  const abv = String(record.abv || '').trim();

  return { id, name, description, ingredients, timesMade, image, abv };
}

function normalizeCocktailFromLocalJson(record, index) {
  const name = String(record && record.name ? record.name : '').trim();
  const description = sanitizeMultilineText(record && record.description ? record.description : '');
  const ingredients = sanitizeMultilineText(record && record.ingredients ? record.ingredients : '');
  const timesMade = getTimesMadeFromRecord(record);
  const image = String(record && (record.image || record.images || record.img) ? (record.image || record.images || record.img) : '').trim();
  const id = String(record && (record.id || record.ID) ? (record.id || record.ID) : name || `cocktail-${index + 1}`).trim();

  return { id, name, description, ingredients, timesMade, image };
}

function loadCocktailsFromLocalJson() {
  if (!fs.existsSync(LOCAL_COCKTAILS_FILE)) {
    throw new Error('cocktail.json fallback file not found.');
  }

  const raw = JSON.parse(fs.readFileSync(LOCAL_COCKTAILS_FILE, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('cocktail.json fallback file is empty or invalid.');
  }

  const items = raw
    .map((record, index) => normalizeCocktailFromLocalJson(record, index))
    .filter((record) => record.name);

  if (items.length === 0) {
    throw new Error('cocktail.json fallback file contains no valid cocktails.');
  }

  return items;
}

async function fetchCocktailsFromGoogleSheet() {
  const csvUrl = buildCocktailsSheetCsvUrl();
  const response = await fetch(csvUrl, {
    method: 'GET',
    headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8' }
  });

  if (!response.ok) {
    throw new Error(`Google Sheet fetch failed (${response.status}). Make sure the sheet is shared for public viewing.`);
  }

  const csvText = await response.text();
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    throw new Error('The Google Sheet is empty or missing its header row.');
  }

  const rawHeaders = rows[0].map((header) => String(header || '').trim());
  const headerMap = rawHeaders.map((header) => header.toLowerCase().replace(/[^a-z0-9]/g, ''));

  const required = ['name', 'description', 'ingredients', 'timesmade'];
  const missing = required.filter((key) => !headerMap.includes(key));
  if (missing.length > 0) {
    throw new Error(`Missing required sheet column(s): ${missing.join(', ')}`);
  }

  return rows
    .slice(1)
    .map((cells) => {
      const record = {};
      headerMap.forEach((header, idx) => {
        record[header] = idx < cells.length ? cells[idx] : '';
      });
      return record;
    })
    .map((record, index) => normalizeCocktailFromSheet(record, index))
    .filter((record) => record.name);
}

async function refreshCocktailsCache(options = {}) {
  const reason = String(options && options.reason ? options.reason : 'manual');
  const allowFallback = options && options.allowFallback === false ? false : true;

  try {
    const cocktails = await fetchCocktailsFromGoogleSheet();
    cocktailsCache = cocktails;
    cocktailsCacheUpdatedAt = new Date().toISOString();
    cocktailsCacheSource = reason;
    cocktailsCacheError = null;

    return {
      items: cocktailsCache,
      updatedAt: cocktailsCacheUpdatedAt,
      source: cocktailsCacheSource,
      fallback: false,
      error: null
    };
  } catch (error) {
    cocktailsCacheError = error && error.message ? error.message : String(error);
    if (!allowFallback) throw error;

    const fallbackItems = loadCocktailsFromLocalJson();
    cocktailsCache = fallbackItems;
    cocktailsCacheUpdatedAt = new Date().toISOString();
    cocktailsCacheSource = `${reason}-local-fallback`;

    return {
      items: cocktailsCache,
      updatedAt: cocktailsCacheUpdatedAt,
      source: cocktailsCacheSource,
      fallback: true,
      error: cocktailsCacheError
    };
  }
}

async function getCocktailsCache() {
  if (Array.isArray(cocktailsCache) && cocktailsCache.length > 0) {
    return {
      items: cocktailsCache,
      updatedAt: cocktailsCacheUpdatedAt,
      source: cocktailsCacheSource,
      fallback: String(cocktailsCacheSource || '').includes('fallback'),
      error: cocktailsCacheError
    };
  }

  return refreshCocktailsCache({ reason: 'cold-start', allowFallback: true });
}

function hasRefreshAccess(body, req) {
  const token = String(body && body.token ? body.token : '').trim();
  const headerSecret = String(req && req.headers && req.headers['x-admin-secret'] ? req.headers['x-admin-secret'] : '').trim();

  if (token && isValidAdminToken(token)) return true;
  if (ADMIN_REFRESH_SECRET && headerSecret && headerSecret === ADMIN_REFRESH_SECRET) return true;

  return false;
}

async function callSheetsWebhook(payload) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL || !GOOGLE_SHEETS_WEBHOOK_SECRET) {
    throw new Error('Missing GOOGLE_SHEETS_WEBHOOK_URL or GOOGLE_SHEETS_WEBHOOK_SECRET');
  }

  const response = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: GOOGLE_SHEETS_WEBHOOK_SECRET,
      ...payload
    })
  });

  const text = await response.text().catch(() => '');
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { raw: text };
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Google Sheets webhook failed (${response.status})`);
  }

  return data;
}

async function getStoredSubscriptions() {
  const data = await callSheetsWebhook({ action: 'listSubscriptions' });
  return Array.isArray(data.subscriptions) ? data.subscriptions : [];
}

async function upsertStoredSubscription(subscription) {
  await callSheetsWebhook({ action: 'upsertSubscription', subscription });
}

async function removeStoredSubscription(endpoint) {
  await callSheetsWebhook({ action: 'removeSubscription', endpoint });
}

async function appendSingleOrderToSheet(sessionState, order) {
  const sessionLabel = `${sessionState.barman || 'Unknown'} - ${sessionState.sessionId}`;
  const ordered = formatDateParts(order.createdAt);
  const served = order.servedAt ? formatDateParts(order.servedAt) : { date: '', time: '' };

  await callSheetsWebhook({
    action: 'appendOrders',
    orders: [{
      sessionLabel,
      barman: sessionState.barman || '',
      guestName: order.guestName || '',
      cocktailName: order.cocktailName || '',
      orderedDate: ordered.date,
      orderedTime: ordered.time,
      servedDate: served.date,
      servedTime: served.time
    }]
  });
}

async function appendOrderEventToSheet(event) {
  await callSheetsWebhook({
    action: 'appendOrderEvents',
    events: [event]
  });
}

async function appendUnloggedOrders(sessionSnapshot) {
  const unlogged = sessionSnapshot.orderHistory.filter((order) => order.servedAt && !order.sheetLoggedAt);
  if (unlogged.length === 0) return;

  for (const order of unlogged) {
    await appendSingleOrderToSheet(sessionSnapshot, order);
  }
}

async function upsertRemoteBarState() {
  try {
    await callSheetsWebhook({
      action: 'upsertBarState',
      state
    });
  } catch (error) {
    console.warn('Unable to sync bar state to Google Sheets.', error && error.message ? error.message : error);
  }
}

async function clearRemoteBarState() {
  try {
    await callSheetsWebhook({ action: 'clearBarState' });
  } catch (error) {
    console.warn('Unable to clear remote bar state in Google Sheets.', error && error.message ? error.message : error);
  }
}

async function restoreStateFromRemote() {
  try {
    const data = await callSheetsWebhook({ action: 'getBarState' });
    if (data && data.state) {
      const restored = normalizeState(data.state);
      persistState(restored);
      console.log('Bar state restored from Google Sheets.');
    }
  } catch (error) {
    console.warn('No remote bar state restored.', error && error.message ? error.message : error);
  }
}

async function sendPushToAll(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  const subscriptions = await getStoredSubscriptions();
  if (subscriptions.length === 0) return;

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (error) {
      const statusCode = Number(error && error.statusCode);
      if (statusCode === 404 || statusCode === 410) {
        try {
          await removeStoredSubscription(subscription.endpoint);
        } catch (removeError) {
          console.warn('Failed to remove expired subscription from Google Sheets.', removeError && removeError.message ? removeError.message : removeError);
        }
      } else {
        console.warn('Push send failed but subscription kept.', error && error.message ? error.message : error);
      }
    }
  }
}

async function handleCocktailsRefresh(body, req) {
  if (!hasRefreshAccess(body, req)) {
    return { status: 401, payload: { error: 'Admin authorization required to refresh cocktails.' } };
  }

  try {
    const cache = await refreshCocktailsCache({ reason: 'manual-refresh' });
    return {
      status: 200,
      payload: {
        ok: true,
        updatedAt: cache.updatedAt,
        count: cache.items.length,
        items: cache.items
      }
    };
  } catch (error) {
    return { status: 500, payload: { error: error.message || 'Unable to refresh cocktails.' } };
  }
}

async function handleToggle(body) {
  const name = String(body && body.name ? body.name : '').trim();
  const password = String(body && body.password ? body.password : '');
  const config = BARMEN[name];

  if (!config || config.password !== password) {
    return { status: 401, payload: { error: 'Invalid credentials.' } };
  }

  if (state.isOpen) {
    const sessionSnapshot = {
      sessionId: state.sessionId,
      barman: state.barman,
      sessionStartedAt: state.sessionStartedAt,
      sessionEndedAt: new Date().toISOString(),
      orderHistory: state.orderHistory
    };

    await appendUnloggedOrders(sessionSnapshot);

    const closedState = persistState({
      isOpen: false,
      barman: null,
      sessionId: null,
      sessionStartedAt: null,
      sessionOrders: 0,
      pendingOrders: [],
      orderHistory: [],
      adminSessionToken: null
    });

    await clearRemoteBarState();

    return { status: 200, payload: { ok: true, state: buildPublicState(closedState) } };
  }

  try {
    const cache = await refreshCocktailsCache({ reason: 'open-bar', allowFallback: true });
    if (cache.fallback) {
      console.warn(`Bar opened with local cocktail fallback (${cache.items.length} cocktails). Google Sheet refresh failed: ${cache.error || 'unknown error'}`);
    } else {
      console.log(`Bar opened with refreshed cocktail cache (${cache.items.length} cocktails).`);
    }
  } catch (error) {
    console.warn('Unable to refresh cocktails while opening the bar.', error && error.message ? error.message : error);
  }

  const adminSessionToken = crypto.randomUUID();
  const openState = persistState({
    isOpen: true,
    barman: name,
    sessionId: crypto.randomUUID(),
    sessionStartedAt: new Date().toISOString(),
    sessionOrders: 0,
    pendingOrders: [],
    orderHistory: [],
    adminSessionToken
  });

  await upsertRemoteBarState();

  return {
    status: 200,
    payload: {
      ok: true,
      state: buildPublicState(openState),
      adminSessionToken,
      cocktailsUpdatedAt: cocktailsCacheUpdatedAt,
      cocktailsSource: cocktailsCacheSource
    }
  };
}

async function handleOrder(body) {
  const guestName = String(body && body.guestName ? body.guestName : '').trim();
  const cocktailName = String(body && body.cocktailName ? body.cocktailName : '').trim();

  if (!guestName || !cocktailName) {
    return { status: 400, payload: { error: 'guestName and cocktailName are required.' } };
  }

  if (!state.isOpen || !state.barman || !BARMEN[state.barman]) {
    return { status: 409, payload: { error: 'The bar is currently closed.' } };
  }

  const pendingOrder = {
    id: crypto.randomUUID(),
    guestName,
    cocktailName,
    createdAt: new Date().toISOString(),
    servedAt: null,
    sheetLoggedAt: null
  };

  const nextState = persistState({
    ...state,
    sessionOrders: state.sessionOrders + 1,
    pendingOrders: [...state.pendingOrders, pendingOrder],
    orderHistory: [...state.orderHistory, pendingOrder]
  });

  await upsertRemoteBarState();

  try {
    await appendOrderEventToSheet(
      buildOrderEvent(nextState, pendingOrder, 'ORDER_PLACED', pendingOrder.createdAt)
    );
  } catch (error) {
    console.error('Failed to log ORDER_PLACED event to Google Sheets.', error);
  }

  const pendingCount = nextState.pendingOrders.length;

  sendPushToAll({
    title: `${pendingCount} cocktail${pendingCount > 1 ? 's' : ''} waiting`,
    body: `${pendingOrder.guestName} ordered ${pendingOrder.cocktailName}`,
    tag: 'bar-order',
    renotify: true,
    url: './admin.html',
    icon: './icons/icon-512.png',
    badge: './icons/icon-192.png'
  }).catch((error) => console.warn('Unable to send push notifications.', error && error.message ? error.message : error));

  return { status: 200, payload: { ok: true, state: buildPublicState(nextState), order: pendingOrder } };
}

async function handleCompleteOrder(body) {
  const orderId = String(body && body.orderId ? body.orderId : '').trim();
  const token = String(body && body.token ? body.token : '').trim();

  if (!isValidAdminToken(token)) {
    return { status: 401, payload: { error: 'Admin session expired.' } };
  }

  if (!orderId) {
    return { status: 400, payload: { error: 'orderId is required.' } };
  }

  const existing = state.pendingOrders.find((order) => order.id === orderId);
  if (!existing) {
    return { status: 404, payload: { error: 'Order not found.' } };
  }

  const servedAt = new Date().toISOString();
  const completedOrder = {
    ...existing,
    servedAt
  };

  try {
    await appendSingleOrderToSheet(state, completedOrder);
    await appendOrderEventToSheet(
      buildOrderEvent(state, completedOrder, 'ORDER_SERVED', servedAt)
    );
    completedOrder.sheetLoggedAt = new Date().toISOString();
  } catch (error) {
    console.error('Failed to log order to Google Sheets.', error);
    return {
      status: 500,
      payload: { error: 'Failed to log cocktail to Google Sheets. Please try again.' }
    };
  }

  const nextState = persistState({
    ...state,
    pendingOrders: state.pendingOrders.filter((order) => order.id !== orderId),
    orderHistory: state.orderHistory.map((order) => (
      order.id === orderId ? completedOrder : order
    ))
  });

  await upsertRemoteBarState();

  return { status: 200, payload: { ok: true, state: buildPublicState(nextState) } };
}

async function handleCloseByToken(body) {
  const token = String(body && body.token ? body.token : '').trim();
  if (!isValidAdminToken(token)) {
    return { status: 401, payload: { error: 'Admin session expired.' } };
  }

  const sessionSnapshot = {
    sessionId: state.sessionId,
    barman: state.barman,
    sessionStartedAt: state.sessionStartedAt,
    sessionEndedAt: new Date().toISOString(),
    orderHistory: state.orderHistory
  };

  await appendUnloggedOrders(sessionSnapshot);

  const closedState = persistState({
    isOpen: false,
    barman: null,
    sessionId: null,
    sessionStartedAt: null,
    sessionOrders: 0,
    pendingOrders: [],
    orderHistory: [],
    adminSessionToken: null
  });

  await clearRemoteBarState();

  return { status: 200, payload: { ok: true, state: buildPublicState(closedState) } };
}

async function handlePushSubscribe(body) {
  const subscription = body && body.subscription;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return { status: 503, payload: { error: 'Push is not configured on the server.' } };
  }

  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return { status: 400, payload: { error: 'A valid push subscription is required.' } };
  }

  await upsertStoredSubscription(subscription);
  return { status: 200, payload: { ok: true } };
}

async function handlePushUnsubscribe(body) {
  const endpoint = String(body && body.endpoint ? body.endpoint : '').trim();
  if (!endpoint) return { status: 400, payload: { error: 'endpoint is required.' } };

  await removeStoredSubscription(endpoint);
  return { status: 200, payload: { ok: true } };
}

const server = http.createServer(async (req, res) => {
  if (!req.url) return sendJson(res, 404, { error: 'Not found' });
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  try {
    if (req.method === 'GET' && req.url === '/api/bar-state') {
      return sendJson(res, 200, { ok: true, state: buildPublicState(state) });
    }

    if (req.method === 'GET' && req.url === '/api/cocktails') {
      try {
        const cache = await getCocktailsCache();
        return sendJson(res, 200, {
          ok: true,
          updatedAt: cache.updatedAt,
          count: cache.items.length,
          source: cache.source,
          fallback: Boolean(cache.fallback),
          error: cache.error,
          items: cache.items
        });
      } catch (error) {
        return sendJson(res, 500, { error: error.message || 'Unable to load cocktails.' });
      }
    }

    if (req.method === 'POST' && req.url === '/api/cocktails/refresh') {
      const body = await readJsonBody(req);
      const result = await enqueue(() => handleCocktailsRefresh(body, req));
      return sendJson(res, result.status, result.payload);
    }

    if (req.method === 'GET' && req.url === '/api/push/public-key') {
      return sendJson(
        res,
        VAPID_PUBLIC_KEY ? 200 : 503,
        VAPID_PUBLIC_KEY ? { ok: true, publicKey: VAPID_PUBLIC_KEY } : { error: 'Push is not configured on the server.' }
      );
    }

    if (req.method === 'POST' && req.url === '/api/push/subscribe') {
      const body = await readJsonBody(req);
      const result = await enqueue(() => handlePushSubscribe(body));
      return sendJson(res, result.status, result.payload);
    }

    if (req.method === 'POST' && req.url === '/api/push/unsubscribe') {
      const body = await readJsonBody(req);
      const result = await enqueue(() => handlePushUnsubscribe(body));
      return sendJson(res, result.status, result.payload);
    }

    if (req.method === 'POST' && req.url === '/api/bar-state/toggle') {
      const body = await readJsonBody(req);
      const result = await enqueue(() => handleToggle(body));
      return sendJson(res, result.status, result.payload);
    }

    if (req.method === 'GET' && req.url.startsWith('/api/admin-session?token=')) {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
      return sendJson(res, 200, {
        ok: true,
        active: isValidAdminToken(token),
        state: isValidAdminToken(token)
          ? buildPublicState(state)
          : buildPublicState({
              isOpen: false,
              barman: null,
              sessionOrders: 0,
              pendingOrders: [],
              updatedAt: new Date().toISOString()
            })
      });
    }

    if (req.method === 'POST' && req.url === '/api/bar-state/close') {
      const body = await readJsonBody(req);
      const result = await enqueue(() => handleCloseByToken(body));
      return sendJson(res, result.status, result.payload);
    }

    if (req.method === 'POST' && req.url === '/api/order') {
      const body = await readJsonBody(req);
      const result = await enqueue(() => handleOrder(body));
      return sendJson(res, result.status, result.payload);
    }

    if (req.method === 'POST' && req.url === '/api/orders/complete') {
      const body = await readJsonBody(req);
      const result = await enqueue(() => handleCompleteOrder(body));
      return sendJson(res, result.status, result.payload);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || 'Server error' });
  }
});

async function bootstrap() {
  state = loadState();

  try {
    await restoreStateFromRemote();
  } catch (error) {
    console.warn('Remote state restore failed during bootstrap.', error && error.message ? error.message : error);
  }

  server.listen(PORT, HOST, () => {
    console.log(`Bar sync server listening on http://${HOST}:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error('Fatal bootstrap error:', error);
  process.exit(1);
});