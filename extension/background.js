// Service worker: связь с локальным helper'ом (Native Messaging), управление
// chrome.proxy, обновление подписок и очередь замеров пинга.
// Прокси меняется ТОЛЬКО в Chrome (scope: "regular"), система не затрагивается.

import { fetchSubscription, isSubscriptionUrl } from "./subscription.js";
import { parseVless } from "./vless.js";
import {
  loadAll, mutate, withLock, migrate, createSub, hostName, sanitizeSettings,
  serverKey, looseKey, pingId, findServer, serverMetadata, subName
} from "./store.js";

const HOST_NAME = "com.vless.eevee.helper";
const ALARM = "subs-tick";
const TICK_MINUTES = 15;            // как часто проверяем, не пора ли обновить подписки
const RETRY_MS = 15 * 60 * 1000;    // после неудачи повторяем не чаще
const LATENCY_TIMEOUT_MS = 20000;
const SPEED_SETUP_TIMEOUT_MS = 5000;

let nativePort = null; // держит service worker живым, пока соединение открыто (Chrome 116+)
let pending = new Map(); // id -> resolve
let msgId = 0;
let syncTimer = null;

// ---------- helper (Native Messaging) ----------

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

// ---------- прокси и состояние ----------

async function applyProxy(port) {
  const { settings } = await loadAll();
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "socks5", host: "127.0.0.1", port },
        bypassList: proxyBypassList(settings.bypassHosts)
      }
    },
    scope: "regular"
  });
}

function proxyBypassList(hosts) {
  const entries = ["localhost", "127.0.0.1"];
  for (const host of hosts) {
    entries.push(host);
    const isIP = host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    if (!isIP && host.includes(".")) entries.push(`*.${host}`);
  }
  return [...new Set(entries)];
}

async function updateProxyRules() {
  const { state = {} } = await chrome.storage.local.get("state");
  if (!state.connected || !state.socksPort) return { ok: true, active: false };
  await applyProxy(state.socksPort);
  return { ok: true, active: true };
}

async function clearProxy() {
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
  } catch (_) { /* ignore */ }
}

async function setState(patch) {
  const { state = {} } = await chrome.storage.local.get("state");
  if (Object.keys(patch).every((key) => JSON.stringify(state[key]) === JSON.stringify(patch[key]))) {
    updateBadge(state);
    return state;
  }
  const next = { ...state, ...patch };
  await chrome.storage.local.set({ state: next });
  updateBadge(next);
  return next;
}

function updateBadge(state) {
  const connected = !!state?.connected;
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2f9e6e" });
  chrome.action.setTitle({
    title: connected
      ? state.server?.name ? `vless-eevee — ${state.server.name}` : "vless-eevee — подключено"
      : "vless-eevee — выключено"
  });
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

// ---------- подключение ----------

// config → helper получает готовый конфиг xray, link → соберёт его из vless://
async function doConnect({ config, link, server, ref }) {
  const payload = config ? { config } : { link };
  payload.server = server;
  const res = await callHelper("start", payload);
  if (res.ok && res.port) {
    await applyProxy(res.port);
    const shown = res.server || server || null;
    await setState({ connected: true, socksPort: res.port, server: shown, error: null });
    startSyncTimer();
    if (ref) await chrome.storage.local.set({ lastConnected: ref });
    return { ok: true, port: res.port, server: shown };
  }
  const error = res.error || "неизвестная ошибка";
  await clearProxy();
  await setState({ connected: false, socksPort: null, server: null, error });
  return { ok: false, error };
}

async function doDisconnect() {
  const res = await callHelper("stop");
  await clearProxy();
  await setState({
    connected: false,
    socksPort: null,
    server: res.server || null,
    error: res.ok ? null : res.error || "не удалось отключиться"
  });
  return { ok: res.ok, error: res.error || null, server: res.server || null };
}

async function autoConnect() {
  const { lastConnected } = await chrome.storage.local.get("lastConnected");
  const server = findServer(await loadAll(), lastConnected);
  if (!server) return;
  await doConnect({
    config: server.kind === "config" ? server.config : undefined,
    link: server.kind === "config" ? undefined : server.raw,
    server: serverMetadata(server),
    ref: lastConnected
  });
}

// ---------- подписки ----------

const refreshJobs = new Map(); // id -> Promise
let subscriptionResetGeneration = 0;

function publishRefreshing() {
  return chrome.storage.session.set({ refreshing: [...refreshJobs.keys()] });
}

const fetchViaHelper = (url) => callHelper("fetchSub", { url }, 20000);

// Обновляет одну подписку. Параллельные вызовы для одной подписки склеиваются.
function refreshSub(id) {
  if (refreshJobs.has(id)) return refreshJobs.get(id);
  const generation = subscriptionResetGeneration;
  const job = doRefresh(id, generation).finally(() => {
    refreshJobs.delete(id);
    publishRefreshing();
  });
  refreshJobs.set(id, job);
  publishRefreshing();
  return job;
}

async function doRefresh(id, generation) {
  if (generation !== subscriptionResetGeneration) {
    return { ok: false, error: "данные сброшены" };
  }
  const { subs } = await loadAll();
  const sub = subs.find((s) => s.id === id);
  if (!sub) return { ok: false, error: "подписка не найдена" };

  try {
    const parsed = await fetchSubscription(sub.url, fetchViaHelper);
    if (generation !== subscriptionResetGeneration) {
      return { ok: false, error: "данные сброшены" };
    }
    const now = Date.now();
    await mutate(["subs", "selected"], (d) => {
      const s = d.subs.find((x) => x.id === id);
      if (!s) return;
      const prevSel = d.selected?.src === id
        ? s.servers.find((sv) => serverKey(sv) === d.selected.key)
        : null;

      s.servers = parsed.servers;
      s.updatedAt = now;
      s.lastAttemptAt = now;
      s.error = "";
      s.info = parsed.meta.info;
      s.skipped = parsed.skipped;
      s.total = parsed.total;
      // название: #фрагмент ссылки → profile-title → домен
      s.autoName = s.fragment || parsed.meta.title || hostName(s.url);

      // выбор пользователя переживает обновление; при переименовании ищем по host:port
      if (d.selected?.src === id) {
        const same =
          s.servers.find((sv) => serverKey(sv) === d.selected.key) ||
          (prevSel && s.servers.find((sv) => looseKey(sv) === looseKey(prevSel)));
        d.selected = same ? { src: id, key: serverKey(same) } : null;
      }
    });
    return { ok: true, count: parsed.servers.length, skipped: parsed.skipped, total: parsed.total };
  } catch (e) {
    const error = e?.message || String(e);
    await mutate(["subs"], (d) => {
      const s = d.subs.find((x) => x.id === id);
      if (s) {
        s.error = error;
        s.lastAttemptAt = Date.now();
      }
    });
    return { ok: false, error };
  }
}

async function addSub(raw) {
  if (!isSubscriptionUrl(raw)) return { ok: false, error: "Нужна ссылка вида https://…" };
  const fresh = createSub(raw);

  // Подписка появляется в списке сразу (развёрнутой), пока идёт загрузка.
  const existing = await mutate(["subs", "ui"], (d) => {
    const found = d.subs.find((s) => s.url === fresh.url);
    if (found) {
      d.ui.expanded[found.id] = true;
      return { id: found.id, hadServers: (found.servers || []).length > 0 };
    }
    d.subs.push(fresh);
    d.ui.expanded[fresh.id] = true;
    return null;
  });

  const existingId = existing?.id || null;
  const id = existingId || fresh.id;
  const res = await refreshSub(id);

  if (!res.ok && (!existingId || !existing.hadServers)) {
    // Пустая или неудачно загруженная запись не считается валидной подпиской.
    // Удаляем её, чтобы повторная попытка с тем же URL была новой, а не "уже добавленной".
    await mutate(["subs", "ui"], (d) => {
      d.subs = d.subs.filter((s) => s.id !== id);
      delete d.ui.expanded[id];
    });
    return res;
  }
  const sub = (await loadAll()).subs.find((s) => s.id === id);
  return { ...res, id, existed: !!existingId && !!existing.hadServers, name: sub ? subName(sub) : "" };
}

async function refreshAll({ onlyDue }) {
  const { subs, settings } = await loadAll();
  const now = Date.now();
  const interval = settings.intervalHours * 3600 * 1000;
  const ids = subs
    .filter((s) =>
      !onlyDue ||
      (now - (s.updatedAt || 0) >= interval && now - (s.lastAttemptAt || 0) >= RETRY_MS))
    .map((s) => s.id);

  const results = [];
  for (const id of ids) results.push(await refreshSub(id)); // по очереди — helper не заваливаем
  return { ok: true, results };
}

async function autoUpdateTick() {
  const { settings } = await loadAll();
  if (!settings.autoUpdate) return;
  await refreshAll({ onlyDue: true });
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM);
  if (!alarm) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: TICK_MINUTES });
}

// ---------- очередь замеров пинга ----------
// Замеры идут в фоне: popup можно закрыть, результаты лежат в storage.session.

let pingsP = null;
let speedsP = null;
let measurementQueue = [];
let measurementLoopRunning = false;
let activeMeasurement = null;

function getPings() {
  pingsP ||= (async () => {
    const d = await chrome.storage.session.get("pings");
    return resetUnfinishedTests(d.pings || { running: false, results: {} });
  })();
  return pingsP;
}

function getSpeeds() {
  speedsP ||= (async () => {
    const d = await chrome.storage.session.get("speeds");
    return resetUnfinishedTests(d.speeds || { running: false, results: {} });
  })();
  return speedsP;
}

function resetUnfinishedTests(state) {
  state.running = false;
  for (const [id, result] of Object.entries(state.results)) {
    if (result.state === "measuring" || result.state === "queued") delete state.results[id];
  }
  return state;
}

const savePings = (p) => chrome.storage.session.set({ pings: p });
const saveSpeeds = (s) => chrome.storage.session.set({ speeds: s });

async function enqueueMeasurements(kind, refs) {
  const state = kind === "speed" ? await getSpeeds() : await getPings();
  let added = false;
  for (const ref of refs) {
    const id = pingId(ref);
    if (
      state.results[id]?.state === "measuring" ||
      measurementQueue.some((item) => item.kind === kind && pingId(item.ref) === id)
    ) continue;
    measurementQueue.push({ kind, ref });
    state.results[id] = { state: "queued" };
    added = true;
  }
  if (!added) return;
  state.running = true;
  await saveMeasurementState(kind, state);
  if (!measurementLoopRunning) runMeasurementLoop();
}

async function saveMeasurementState(kind, state) {
  return kind === "speed" ? saveSpeeds(state) : savePings(state);
}

async function getMeasurementState(kind) {
  return kind === "speed" ? getSpeeds() : getPings();
}

async function runMeasurementLoop() {
  measurementLoopRunning = true;
  try {
    while (measurementQueue.length) {
      const { kind, ref } = measurementQueue.shift();
      activeMeasurement = { kind, ref };
      const id = pingId(ref);
      const state = await getMeasurementState(kind);
      const currentData = await loadAll();
      const server = findServer(currentData, ref);
      if (!server) {
        delete state.results[id];
        activeMeasurement = null;
        state.running = measurementQueue.some((item) => item.kind === kind);
        await saveMeasurementState(kind, state);
        continue;
      }
      state.results[id] = { state: "measuring" };
      await saveMeasurementState(kind, state);

      const payload = {
        ...(server.kind === "config"
          ? { config: server.config, server: serverMetadata(server) }
          : { link: server.raw }),
        ...(kind === "speed"
          ? {
              speedTestMB: currentData.settings.speedTestMB,
              speedTimeoutSeconds: currentData.settings.speedTimeoutSeconds
            }
          : {})
      };
      const timeoutMs = kind === "speed"
        ? currentData.settings.speedTimeoutSeconds * 1000 + SPEED_SETUP_TIMEOUT_MS
        : LATENCY_TIMEOUT_MS;
      const res = await callHelper(
        kind === "speed" ? "speed" : "latency",
        payload,
        timeoutMs
      );
      activeMeasurement = null;
      state.results[id] = kind === "speed"
        ? res.ok && Number.isFinite(res.speedMbps) && res.speedMbps > 0
          ? { state: "done", mbps: res.speedMbps, at: Date.now() }
          : { state: "error", err: res.error || "нет ответа" }
        : res.ok && typeof res.ms === "number"
          ? { state: "done", ms: Math.round(res.ms), at: Date.now() }
          : { state: "error", err: res.error || "нет ответа" };
      state.running = measurementQueue.some((item) => item.kind === kind);
      await saveMeasurementState(kind, state);
    }
  } finally {
    activeMeasurement = null;
    measurementLoopRunning = false;
    for (const kind of ["ping", "speed"]) {
      const state = await getMeasurementState(kind);
      state.running = measurementQueue.some((item) => item.kind === kind);
      await saveMeasurementState(kind, state);
    }
    if (measurementQueue.length && !measurementLoopRunning) runMeasurementLoop();
  }
}

async function stopMeasurements(kind) {
  const state = await getMeasurementState(kind);
  measurementQueue = measurementQueue.filter((item) => {
    if (item.kind !== kind) return true;
    delete state.results[pingId(item.ref)];
    return false;
  });
  state.running = activeMeasurement?.kind === kind || measurementQueue.some((item) => item.kind === kind);
  await saveMeasurementState(kind, state);
}

// ---------- резервная копия и сброс ----------

async function importBackup(data) {
  if (!data || data.app !== "vless-eevee") {
    return { ok: false, error: "Это не резервная копия vless-eevee" };
  }
  let addedSubs = 0;
  let addedManual = 0;

  await mutate(["subs", "manual", "favorites", "settings", "ui"], (d) => {
    for (const item of data.subs || []) {
      if (!item || !isSubscriptionUrl(item.url)) continue;
      const sub = createSub(item.url);
      if (d.subs.some((s) => s.url === sub.url)) continue;
      sub.customName = String(item.customName || "").slice(0, 60);
      d.subs.push(sub);
      d.ui.expanded[sub.id] = false;
      addedSubs++;
    }
    for (const link of data.manual || []) {
      const parsed = parseVless(link);
      if (!parsed || d.manual.some((m) => m.raw === parsed.raw)) continue;
      d.manual.push({ ...parsed, kind: "link", protocol: "vless" });
      addedManual++;
    }
    d.favorites = [...new Set([...d.favorites, ...(Array.isArray(data.favorites) ? data.favorites : [])])];
    if (data.settings) d.settings = sanitizeSettings({ ...d.settings, ...data.settings });
  });

  if (addedSubs) refreshAll({ onlyDue: false }); // подтянуть серверы новых подписок
  return { ok: true, addedSubs, addedManual };
}

async function resetAll() {
  subscriptionResetGeneration++;
  refreshJobs.clear();
  await withLock(() =>
    chrome.storage.local.remove([
      "subs", "manual", "selected", "favorites", "settings", "ui",
      "lastConnected", "state"
    ])
  );
  await stopMeasurements("ping");
  await stopMeasurements("speed");
  const p = await getPings();
  p.results = {};
  await savePings(p);
  const s = await getSpeeds();
  s.results = {};
  await saveSpeeds(s);
  await chrome.storage.session.remove("refreshing");
  return { ok: true };
}

// ---------- сообщения из popup ----------

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  handleMessage(req).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: e?.message || String(e) })
  );
  return true; // async response
});

async function handleMessage(req) {
  switch (req.cmd) {
    case "connect":
      return doConnect({ config: req.config, link: req.link, server: req.server, ref: req.ref });
    case "disconnect":
      return doDisconnect();
    case "helperStatus": {
      const res = await callHelper("status", {}, 4000);
      await syncGlobalState(res);
      if (res.ok) startSyncTimer();
      return res;
    }
    case "componentVersions": {
      const helper = await callHelper("version", {}, 4000);
      return {
        ok: helper.ok,
        helperVersion: helper.version || "",
        extensionVersion: chrome.runtime.getManifest().version,
        error: helper.error || ""
      };
    }
    case "addSub":
      return addSub(req.url);
    case "refreshSub":
      return refreshSub(req.id);
    case "refreshAll":
      return refreshAll({ onlyDue: false });
    case "pingStart":
      await enqueueMeasurements("ping", req.refs || []);
      return { ok: true };
    case "pingStop":
      await stopMeasurements("ping");
      return { ok: true };
    case "speedStart":
      await enqueueMeasurements("speed", req.refs || []);
      return { ok: true };
    case "speedStop":
      await stopMeasurements("speed");
      return { ok: true };
    case "updateProxyRules":
      return updateProxyRules();
    case "importBackup": {
      const res = await importBackup(req.data);
      if (res.ok) await updateProxyRules();
      return res;
    }
    case "resetAll": {
      const res = await resetAll();
      if (res.ok) await updateProxyRules();
      return res;
    }
    case "fetchSub":
      return callHelper("fetchSub", { url: req.url }, 20000);
    case "latency":
      return callHelper(
        "latency",
        req.config ? { config: req.config, server: req.server } : { link: req.link },
        LATENCY_TIMEOUT_MS
      );
    default:
      return { ok: false, error: "unknown cmd" };
  }
}

// ---------- жизненный цикл ----------

async function startupRoutine() {
  await migrate();
  await reportExtensionVersion();
  const status = await syncGlobalState(); // общий helper мог остаться подключённым
  if (status.ok) startSyncTimer();

  const { settings } = await loadAll();
  const { state = {} } = await chrome.storage.local.get("state");
  if (status.ok && !state.connected && settings.autoConnect) await autoConnect();
  if (settings.autoUpdate && settings.updateOnStart) await refreshAll({ onlyDue: false });
}

async function reportExtensionVersion() {
  const res = await callHelper("extensionVersion", {
    version: chrome.runtime.getManifest().version
  }, 5000);
  if (!res.ok) console.warn("Не удалось сообщить helper версию расширения:", res.error);
}

chrome.runtime.onStartup.addListener(() => {
  startupRoutine().catch((e) => console.error("startup:", e));
});

chrome.runtime.onInstalled.addListener(() => {
  migrate().catch(() => {});
  ensureAlarm();
  reportExtensionVersion().catch((e) => console.error("extension version:", e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) autoUpdateTick().catch((e) => console.error("auto-update:", e));
});

// Включили автообновление или сократили интервал — проверяем сразу.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const o = sanitizeSettings(changes.settings.oldValue);
  const n = sanitizeSettings(changes.settings.newValue);
  if (n.autoUpdate && (!o.autoUpdate || n.intervalHours < o.intervalHours)) {
    autoUpdateTick().catch(() => {});
  }
});

// Будильники Chrome не обязаны переживать перезапуск браузера — проверяем при каждом пробуждении.
ensureAlarm();
migrate().catch(() => {});
