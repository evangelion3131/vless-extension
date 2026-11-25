// Service worker: связь с локальным helper'ом (Native Messaging) и управление chrome.proxy.
// Прокси меняется ТОЛЬКО в Chrome (scope: "regular"), система не затрагивается.

const HOST_NAME = "com.vless.eevee.helper";

let nativePort = null; // держит service worker живым, пока соединение открыто (Chrome 116+)
let pending = new Map(); // id -> resolve
let msgId = 0;
let syncTimer = null;

function connectHelper() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST_NAME);

  nativePort.onMessage.addListener((msg) => {
    if (msg && msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  nativePort.onDisconnect.addListener(async () => {
    const err = chrome.runtime.lastError?.message || "helper disconnected";
    nativePort = null;
    clearInterval(syncTimer);
    syncTimer = null;
    for (const resolve of pending.values()) resolve({ ok: false, error: err });
    pending.clear();
    // Helper упал/закрылся — снимаем прокси, чтобы браузер не остался без сети
    await clearProxy();
    await setState({ connected: false, socksPort: null, server: null, error: err });
  });

  return nativePort;
}

function callHelper(cmd, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let port;
    try {
      port = connectHelper();
    } catch (e) {
      resolve({ ok: false, error: String(e) });
      return;
    }
    const id = ++msgId;
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, error: "helper не отвечает (таймаут)" });
      }
    }, timeoutMs);
    try {
      port.postMessage({ id, cmd, ...payload });
    } catch (e) {
      pending.delete(id);
      resolve({ ok: false, error: "не удалось отправить команду helper'у: " + String(e) });
    }
  });
}

async function applyProxy(port) {
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "socks5", host: "127.0.0.1", port },
        bypassList: ["localhost", "127.0.0.1"]
      }
    },
    scope: "regular"
  });
}

async function clearProxy() {
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
  } catch (_) { /* ignore */ }
}

async function setState(patch) {
  const { state = {} } = await chrome.storage.local.get("state");
  if (Object.keys(patch).every((key) => JSON.stringify(state[key]) === JSON.stringify(patch[key]))) {
    updateBadge(state.connected);
    return state;
  }
  const next = { ...state, ...patch };
  await chrome.storage.local.set({ state: next });
  updateBadge(next.connected);
  return next;
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2f9e6e" });
}

function startSyncTimer() {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    syncGlobalState().catch((e) => console.error("Не удалось синхронизировать подключение:", e));
  }, 3000);
}

async function syncGlobalState(res) {
  res ||= await callHelper("status", {}, 4000);
  if (!res.ok) {
    await clearProxy();
    await setState({ connected: false, socksPort: null, server: null, error: res.error || null });
    return res;
  }

  const clientConnected =
    typeof res.clientConnected === "boolean"
      ? res.clientConnected
      : res.state === "running";
  const connected = clientConnected && !!res.port;
  const { state = {} } = await chrome.storage.local.get("state");
  const server = res.server || null;
  const changed =
    state.connected !== connected ||
    state.socksPort !== (connected ? res.port : null) ||
    JSON.stringify(state.server || null) !== JSON.stringify(server);

  if (connected) {
    if (changed) await applyProxy(res.port);
    await setState({ connected: true, socksPort: res.port, server, error: null });
  } else {
    if (state.connected || state.socksPort != null) await clearProxy();
    await setState({ connected: false, socksPort: null, server, error: null });
  }
  return res;
}

// --- Команды из popup ---

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  (async () => {
    switch (req.cmd) {
      case "connect": {
        // server.kind === "config" → отдаём helper'у готовый конфиг xray,
        // server.kind === "link"   → helper соберёт конфиг из vless:// ссылки
        const payload = req.config ? { config: req.config } : { link: req.link };
        payload.server = req.server;
        const res = await callHelper("start", payload);
        if (res.ok && res.port) {
          await applyProxy(res.port);
          await setState({ connected: true, socksPort: res.port, server: res.server || req.server || null, error: null });
          startSyncTimer();
          sendResponse({ ok: true, port: res.port, server: res.server || req.server || null });
        } else {
          await clearProxy();
          await setState({ connected: false, socksPort: null, server: null, error: res.error || "неизвестная ошибка" });
          sendResponse({ ok: false, error: res.error || "неизвестная ошибка" });
        }
        break;
      }
      case "disconnect": {
        const res = await callHelper("stop");
        await clearProxy();
        await setState({
          connected: false,
          socksPort: null,
          server: res.server || null,
          error: res.ok ? null : res.error || "не удалось отключиться"
        });
        sendResponse({
          ok: res.ok,
          error: res.error || null,
          server: res.server || null
        });
        break;
      }
      case "helperStatus": {
        const res = await callHelper("status", {}, 4000);
        await syncGlobalState(res);
        if (res.ok) {
          startSyncTimer();
        }
        sendResponse(res);
        break;
      }
      case "fetchSub": {
        // Подписку качает helper (ходит в сеть как curl), а не браузер —
        // так антибот-прокси провайдера (DDoS-Guard) её не блокирует.
        const res = await callHelper("fetchSub", { url: req.url }, 20000);
        sendResponse(res);
        break;
      }
      case "latency": {
        // helper поднимает временный xray и мерит задержку через туннель.
        const payload = req.config ? { config: req.config } : { link: req.link };
        const res = await callHelper("latency", payload, 15000);
        sendResponse(res);
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown cmd" });
    }
  })();
  return true; // async response
});

// При старте браузера восстанавливаем состояние общего helper'а.
chrome.runtime.onStartup.addListener(async () => {
  const res = await syncGlobalState();
  if (res.ok) startSyncTimer();
});
