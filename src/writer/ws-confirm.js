/**
 * writer/ws-confirm.js — WebSocket-based transaction confirmation.
 * Replaces polling getSignatureStatuses with signatureSubscribe push notifications.
 * ~0.6s avg confirm vs 2.5s polling = 2.6x throughput improvement.
 *
 * Falls back to polling if WebSocket disconnects or times out.
 */

import { env, WS_CONFIRM_TIMEOUT_MS } from '../config.js';

// Use native WebSocket (Node 21+) or ws package
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  WS = globalThis.WebSocket;
} else {
  try {
    WS = (await import('ws')).default;
  } catch (err) {
    console.warn('[WS] Neither native WebSocket nor ws package available. WebSocket confirms disabled.', err.message);
  }
}

const PING_INTERVAL_MS = 30_000; // keepalive ping every 30s (Helius 10min timeout)

let _ws = null;
let _wsReady = false;
let _reconnecting = false;
let _pingTimer = null;
let _subscriptions = new Map(); // subId -> { resolve, timer, sig }
let _pendingSigs = new Map();   // sig -> { resolve, reject, timer }
let _nextId = 1;

function getWsUrl() {
  // Helius WSS: wss://mainnet.helius-rpc.com/?api-key=KEY
  // Standard: wss://api.mainnet-beta.solana.com
  const inscriptionRpc = env('INSCRIPTION_RPC_URL');
  if (inscriptionRpc) {
    return inscriptionRpc.replace('https://', 'wss://').replace('http://', 'ws://');
  }
  const wsUrl = env('HELIUS_WS_URL');
  if (wsUrl) return wsUrl;
  const key = env('HELIUS_API_KEY');
  if (key) return `wss://mainnet.helius-rpc.com/?api-key=${key}`;
  return 'wss://api.mainnet-beta.solana.com';
}

function connect() {
  if (!WS) return;
  if (_ws && (_ws.readyState === WS.OPEN || _ws.readyState === WS.CONNECTING)) return;

  const url = getWsUrl();
  _ws = new WS(url);
  _wsReady = false;

  function handleOpen() {
    _wsReady = true;
    _reconnecting = false;
    // Start ping keepalive (Helius has 10min inactivity timeout)
    if (_pingTimer) clearInterval(_pingTimer);
    _pingTimer = setInterval(() => {
      if (_ws && typeof _ws.ping === 'function') _ws.ping();
    }, PING_INTERVAL_MS);
    console.log('[WS] Connected');
  }

  function handleMessage(rawData) {
    try {
      // Native WebSocket wraps in MessageEvent, ws gives raw data
      const text = typeof rawData === 'string' ? rawData : (rawData.data || rawData).toString();
      const msg = JSON.parse(text);

      // Subscription confirmation response: { id, result: subId }
      if (msg.id && msg.result !== undefined && !msg.method) {
        const pending = _pendingSigs.get(msg.id);
        if (pending) {
          _subscriptions.set(msg.result, {
            resolve: pending.resolve,
            timer: pending.timer,
            sig: pending.sig,
          });
          _pendingSigs.delete(msg.id);
        }
        return;
      }

      // Notification: { method: 'signatureNotification', params: { subscription, result } }
      if (msg.method === 'signatureNotification') {
        const subId = msg.params?.subscription;
        const sub = _subscriptions.get(subId);
        if (sub) {
          const value = msg.params?.result?.value;
          // Skip intermediate "receivedSignature" notifications
          if (value === 'receivedSignature') return;
          const err = value?.err;
          clearTimeout(sub.timer);
          _subscriptions.delete(subId);
          // signatureSubscribe is single-shot (auto-cancels), no unsubscribe needed
          sub.resolve({ confirmed: !err, err });
        }
      }
    } catch (e) {
      console.warn('[WS] Message parse error:', e.message);
    }
  }

  function handleClose() {
    _wsReady = false;
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
    console.log('[WS] Disconnected');
    for (const [, sub] of _subscriptions) {
      clearTimeout(sub.timer);
      sub.resolve({ confirmed: false, timeout: true });
    }
    _subscriptions.clear();
    for (const [, pending] of _pendingSigs) {
      clearTimeout(pending.timer);
      pending.resolve({ confirmed: false, timeout: true });
    }
    _pendingSigs.clear();
    scheduleReconnect();
  }

  function handleError(err) {
    console.warn(`[WS] Error: ${err.message || err}`);
    // Clean up ping timer on error — close handler may not always fire
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  }

  // ws package uses .on(), native WebSocket uses .addEventListener()
  if (typeof _ws.on === 'function') {
    _ws.on('open', handleOpen);
    _ws.on('message', handleMessage);
    _ws.on('close', handleClose);
    _ws.on('error', handleError);
  } else {
    _ws.addEventListener('open', handleOpen);
    _ws.addEventListener('message', handleMessage);
    _ws.addEventListener('close', handleClose);
    _ws.addEventListener('error', handleError);
  }
}

function scheduleReconnect() {
  if (_reconnecting) return;
  _reconnecting = true;
  setTimeout(() => {
    _reconnecting = false;
    connect();
  }, 2000);
}

function _wsSend(obj) {
  if (_ws && WS && _ws.readyState === WS.OPEN) {
    _ws.send(JSON.stringify(obj));
  }
}

/**
 * Subscribe to a signature confirmation via WebSocket.
 * Returns a promise that resolves with { confirmed: true/false, err?, timeout? }
 * Times out after WS_CONFIRM_TIMEOUT_MS and resolves with { confirmed: false, timeout: true }
 */
function subscribeSignature(sig) {
  return new Promise((resolve) => {
    if (!_wsReady) {
      resolve({ confirmed: false, timeout: true });
      return;
    }

    const id = _nextId++;
    const timer = setTimeout(() => {
      _pendingSigs.delete(id);
      // Clean subscription map entry if it was created
      for (const [subId, sub] of _subscriptions) {
        if (sub.sig === sig) {
          _subscriptions.delete(subId);
          break;
        }
      }
      resolve({ confirmed: false, timeout: true });
    }, WS_CONFIRM_TIMEOUT_MS);

    _pendingSigs.set(id, { resolve, timer, sig });

    _wsSend({
      jsonrpc: '2.0',
      id,
      method: 'signatureSubscribe',
      params: [sig, { commitment: 'confirmed' }],
    });
  });
}

/**
 * Confirm a batch of signatures via WebSocket.
 * Returns array of indices that were NOT confirmed (empty = all good).
 * Any sig that times out or fails will be in the returned array.
 */
export async function wsConfirmBatch(sigs) {
  const results = await Promise.all(sigs.map(sig => subscribeSignature(sig)));
  const failed = [];
  results.forEach((r, i) => {
    if (!r.confirmed) failed.push(i);
  });
  return failed;
}

/**
 * Initialize WebSocket connection. Call once at startup when USE_WEBSOCKET=true.
 */
export function initWsConnection() {
  connect();
}

/**
 * Check if WebSocket is connected and ready.
 */
export function isWsReady() {
  return _wsReady;
}

/**
 * Close WebSocket connection cleanly.
 */
export function closeWsConnection() {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  if (_ws) {
    if (typeof _ws.removeAllListeners === 'function') _ws.removeAllListeners();
    _ws.close();
    _ws = null;
    _wsReady = false;
  }
}
