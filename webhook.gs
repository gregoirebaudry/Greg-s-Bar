const WEBHOOK_SECRET = '#szKNEN?PgQ5d97ayjGEA#i?ojjzjD4rJ@rTyJ8Q';

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function getOrdersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ensureSheet_(ss, 'Orders', [
    'sessionLabel',
    'barman',
    'guestName',
    'cocktailName',
    'orderedDate',
    'orderedTime',
    'servedDate',
    'servedTime'
  ]);
}

function getOrderEventsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ensureSheet_(ss, 'OrderEvents', [
    'orderId',
    'eventType',
    'sessionLabel',
    'barman',
    'guestName',
    'cocktailName',
    'eventDate',
    'eventTime',
    'createdAtIso'
  ]);
}

function getSubscriptionsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ensureSheet_(ss, 'Subscriptions', [
    'endpoint',
    'p256dh',
    'auth',
    'barman',
    'createdAt',
    'updatedAt'
  ]);
}

function getBarStateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ensureSheet_(ss, 'BarState', [
    'key',
    'value',
    'updatedAt'
  ]);
}

function readSubscriptions_() {
  const sheet = getSubscriptionsSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  return values
    .filter((row) => row[0] && row[1] && row[2])
    .map((row) => ({
      endpoint: row[0],
      keys: {
        p256dh: row[1],
        auth: row[2]
      },
      barman: row[3] || null
    }));
}

function upsertSubscription_(subscription) {
  const sheet = getSubscriptionsSheet_();
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys.p256dh;
  const auth = subscription.keys.auth;
  const barman = subscription.barman || '';
  const now = new Date().toISOString();
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const endpoints = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < endpoints.length; i++) {
      if (endpoints[i][0] === endpoint) {
        const createdAt = sheet.getRange(i + 2, 5).getValue();
        sheet.getRange(i + 2, 1, 1, 6).setValues([[endpoint, p256dh, auth, barman, createdAt, now]]);
        return;
      }
    }
  }

  sheet.appendRow([endpoint, p256dh, auth, barman, now, now]);
}

function removeSubscription_(endpoint) {
  const sheet = getSubscriptionsSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const endpoints = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = endpoints.length - 1; i >= 0; i--) {
    if (endpoints[i][0] === endpoint) {
      sheet.deleteRow(i + 2);
    }
  }
}

function appendOrders_(orders) {
  if (!orders || !orders.length) return;

  const sheet = getOrdersSheet_();
  const rows = orders.map((order) => [
    order.sessionLabel || '',
    order.barman || '',
    order.guestName || '',
    order.cocktailName || '',
    order.orderedDate || '',
    order.orderedTime || '',
    order.servedDate || '',
    order.servedTime || ''
  ]);

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function appendOrderEvents_(events) {
  if (!events || !events.length) return;

  const sheet = getOrderEventsSheet_();
  const rows = events.map((event) => [
    event.orderId || '',
    event.eventType || '',
    event.sessionLabel || '',
    event.barman || '',
    event.guestName || '',
    event.cocktailName || '',
    event.eventDate || '',
    event.eventTime || '',
    event.createdAtIso || ''
  ]);

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function getBarStateValue_(key) {
  const sheet = getBarStateSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';

  const values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === key) {
      return values[i][1] || '';
    }
  }

  return '';
}

function setBarStateValue_(key, value) {
  const sheet = getBarStateSheet_();
  const now = new Date().toISOString();
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === key) {
        sheet.getRange(i + 2, 1, 1, 3).setValues([[key, value, now]]);
        return;
      }
    }
  }

  sheet.appendRow([key, value, now]);
}

function clearBarStateValues_() {
  const sheet = getBarStateSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 3).clearContent();
  }
}

function sanitizeBarState_(state) {
  state = state || {};

  return {
    isOpen: Boolean(state.isOpen),
    barman: state.barman || null,
    sessionId: state.sessionId || null,
    sessionStartedAt: state.sessionStartedAt || null,
    sessionOrders: Number(state.sessionOrders || 0),
    pendingOrders: Array.isArray(state.pendingOrders) ? state.pendingOrders : [],
    orderHistory: Array.isArray(state.orderHistory) ? state.orderHistory : [],
    adminSessionTokens: Array.isArray(state.adminSessionTokens) ? state.adminSessionTokens : [],
    updatedAt: state.updatedAt || new Date().toISOString()
  };
}

function getBarState_() {
  const raw = getBarStateValue_('barState');
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new Error('Stored barState is not valid JSON.');
  }
}

function upsertBarState_(state) {
  const safeState = sanitizeBarState_(state);
  setBarStateValue_('barState', JSON.stringify(safeState));
}

function clearBarState_() {
  clearBarStateValues_();
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || '{}');

    if (String(data.secret || '').trim() !== String(WEBHOOK_SECRET).trim()) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }

    const action = data.action || '';

    if (action === 'appendOrders') {
      appendOrders_(Array.isArray(data.orders) ? data.orders : []);
      return jsonResponse_({ ok: true });
    }

    if (action === 'appendOrderEvents') {
      appendOrderEvents_(Array.isArray(data.events) ? data.events : []);
      return jsonResponse_({ ok: true });
    }

    if (action === 'listSubscriptions') {
      return jsonResponse_({ ok: true, subscriptions: readSubscriptions_() });
    }

    if (action === 'upsertSubscription') {
      const subscription = data.subscription;
      if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
        return jsonResponse_({ ok: false, error: 'Invalid subscription' });
      }
      upsertSubscription_(subscription);
      return jsonResponse_({ ok: true });
    }

    if (action === 'removeSubscription') {
      const endpoint = data.endpoint || '';
      if (!endpoint) {
        return jsonResponse_({ ok: false, error: 'Missing endpoint' });
      }
      removeSubscription_(endpoint);
      return jsonResponse_({ ok: true });
    }

    if (action === 'getBarState') {
      return jsonResponse_({ ok: true, state: getBarState_() });
    }

    if (action === 'upsertBarState') {
      upsertBarState_(data.state || {});
      return jsonResponse_({ ok: true });
    }

    if (action === 'clearBarState') {
      clearBarState_();
      return jsonResponse_({ ok: true });
    }

    return jsonResponse_({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error) });
  }
}
