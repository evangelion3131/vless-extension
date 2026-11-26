// Общее хранилище для popup и service worker.
//
// Схема chrome.storage.local (v2):
//   subs       [{ id, url, fragment, autoName, customName, servers, updatedAt,
//                 lastAttemptAt, error, info, skipped, total }]
//   manual     [server]            — серверы, добавленные вручную (vless://)
//   selected   { src, key } | null — src: id подписки или "manual"
//   favorites  [serverKey]
//   settings   см. DEFAULT_SETTINGS
//   ui         { expanded: { [id]: bool } }
//   state, lastConnected           — пишет background.js
//
// Все «прочитал → изменил → записал» идут через mutate(): Web Locks общие для
// popup и service worker, поэтому они не затирают изменения друг друга.

export const DEFAULT_SETTINGS = {
  autoUpdate: true,
  intervalHours: 4,
  updateOnStart: true,
  autoConnect: false,
  showTech: true,
  sort: "default", // "default" | "ping" | "speed"
  bypassHosts: []
};

export const INTERVALS = [1, 2, 4, 6, 12, 24];

const KEYS = ["subs", "manual", "selected", "favorites", "settings", "ui"];

export function sanitizeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, bypassHosts: [] };
  if (!s || typeof s !== "object") return out;
  for (const k of ["autoUpdate", "updateOnStart", "autoConnect", "showTech"]) {
    if (typeof s[k] === "boolean") out[k] = s[k];
  }
  if (INTERVALS.includes(Number(s.intervalHours))) out.intervalHours = Number(s.intervalHours);
  if (s.sort === "ping" || s.sort === "speed" || s.sort === "default") out.sort = s.sort;
  if (Array.isArray(s.bypassHosts)) {
    out.bypassHosts = [...new Set(s.bypassHosts.map(normalizeBypassHost).filter(Boolean))];
  }
  return out;
}

export function normalizeBypassHost(value) {
  const input = String(value || "").trim();
  if (!input || /[\s*]/.test(input)) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input);
  const hasPort = /^[^/:?#\s]+:\d+(?:[/?#]|$)/.test(input);
  const urlInput = hasScheme && !hasPort ? input : `http://${input}`;
  let url;
  try {
    url = new URL(urlInput);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return host || null;
}

export function withLock(fn) {
  return navigator.locks.request("vless-eevee-store", fn);
}

export async function loadAll() {
  const d = await chrome.storage.local.get(KEYS);
  const ui = d.ui || {};
  return {
    subs: d.subs || [],
    manual: d.manual || [],
    selected: d.selected || null,
    favorites: d.favorites || [],
    settings: sanitizeSettings(d.settings),
    ui: { ...ui, expanded: ui.expanded || {} }
  };
}

// keys — какие поля записать обратно (остальные остаются как были).
export function mutate(keys, fn) {
  return withLock(async () => {
    const data = await loadAll();
    const result = await fn(data);
    const patch = {};
    for (const k of keys) patch[k] = data[k];
    await chrome.storage.local.set(patch);
    return result;
  });
}

// ---------- ключи серверов ----------

// Полный ключ: отличает серверы с одинаковым host:port, но разным именем.
export function serverKey(s) {
  return [s.kind || "link", s.protocol || "vless", s.host, s.port, s.name, s.uuid || ""].join("|");
}

// Мягкий ключ: чтобы пережить переименование сервера провайдером.
export function looseKey(s) {
  if (s.configProfile) return ["xray-profile", s.name].join("|");
  return [s.protocol || "vless", s.host, Number(s.port)].join("|");
}

// Ключ по метаданным подключения (state.server их и хранит).
export function metaKey(s) {
  return [s.protocol || "vless", s.host, Number(s.port), s.name].join("|");
}

export function pingId(ref) {
  return `${ref.src}::${ref.key}`;
}

export function serverMetadata(server) {
  return {
    name: server.name,
    host: server.host,
    port: server.port,
    protocol: server.protocol || "vless",
    outboundTag: server.outboundTag,
    outboundIndex: server.outboundIndex,
    nodeKey: server.nodeKey,
    nodeIndex: server.nodeIndex,
    configProfile: !!server.configProfile
  };
}

export function findServer(data, ref) {
  if (!ref) return null;
  const list = ref.src === "manual"
    ? data.manual
    : data.subs.find((s) => s.id === ref.src)?.servers;
  return list?.find((s) => serverKey(s) === ref.key) || null;
}

// ---------- подписки ----------

function uid() {
  return crypto.randomUUID().slice(0, 8);
}

// https://host/path#Имя → { url: "https://host/path", fragment: "Имя" }
export function splitSubUrl(raw) {
  const t = String(raw || "").trim();
  const i = t.indexOf("#");
  const url = i >= 0 ? t.slice(0, i) : t;
  let fragment = "";
  if (i >= 0) {
    const f = t.slice(i + 1);
    try { fragment = decodeURIComponent(f).trim(); } catch { fragment = f.trim(); }
  }
  return { url, fragment };
}

export function hostName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function createSub(rawUrl) {
  const { url, fragment } = splitSubUrl(rawUrl);
  return {
    id: uid(),
    url,
    fragment,
    autoName: fragment || hostName(url),
    customName: "",
    servers: [],
    updatedAt: 0,
    lastAttemptAt: 0,
    error: "",
    info: null,
    skipped: 0,
    total: 0
  };
}

export const subName = (sub) => sub.customName || sub.autoName || hostName(sub.url);

// Перенос данных со старой схемы (одна подписка + servers/selectedIdx).
export function migrate() {
  return withLock(async () => {
    const old = await chrome.storage.local.get([
      "schemaVersion", "servers", "selectedIdx", "subscription", "subs"
    ]);
    if (old.schemaVersion >= 2) return false;

    const patch = { schemaVersion: 2 };
    if (!old.subs && (old.servers?.length || old.subscription?.url)) {
      const all = old.servers || [];
      const sub = old.subscription?.url ? createSub(old.subscription.url) : null;
      const strip = ({ fromSub, ...rest }) => rest;
      if (sub) {
        sub.servers = all.filter((s) => s.fromSub).map(strip);
        sub.updatedAt = old.subscription.updatedAt || 0;
      }
      patch.subs = sub ? [sub] : [];
      patch.manual = all.filter((s) => !(sub && s.fromSub)).map(strip);
      patch.ui = { expanded: sub ? { [sub.id]: true } : {} };
      const cur = all[old.selectedIdx];
      if (cur) {
        patch.selected = { src: sub && cur.fromSub ? sub.id : "manual", key: serverKey(cur) };
      }
    }
    await chrome.storage.local.set(patch);
    await chrome.storage.local.remove(["servers", "selectedIdx", "subscription"]);
    return true;
  });
}
