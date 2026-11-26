import { parseVless } from "./vless.js";

// Подписка (subscription URL). Провайдеры отдают её в разных форматах:
//   A) full config — готовый JSON-конфиг xray (dns/inbounds/outbounds/routing).
//      Именованные конфиги сохраняются как целые профили; безымянные делятся
//      на отдельные серверы по outbound'ам.
//   B) список ссылок — base64 (обычный или URL-safe) либо plain text построчно.
// Определяем формат по содержимому.
//
// Кроме серверов из ответа берём метаданные (как в Happ):
//   profile-title          — название подписки (текст или "base64:...")
//   subscription-userinfo  — "upload=..; download=..; total=..; expire=.."

export function isSubscriptionUrl(s) {
  return /^https?:\/\//i.test((s || "").trim());
}

// --- метаданные из заголовков ---

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(", ") : String(v ?? "");
  }
  return "";
}

function decodeBase64Utf8(b64) {
  let s = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export function parseTitle(raw) {
  if (!raw) return "";
  let v = String(raw).trim();
  if (/^base64:/i.test(v)) {
    try { v = decodeBase64Utf8(v.slice(7)); } catch { return ""; }
  } else if (/%[0-9a-f]{2}/i.test(v)) {
    try { v = decodeURIComponent(v); } catch { /* оставляем как есть */ }
  }
  return v.trim().slice(0, 80);
}

// → { used, total, expire } | null. total=0 — без лимита, expire=0 — бессрочно.
export function parseUserInfo(raw) {
  if (!raw) return null;
  const o = {};
  for (const part of String(raw).split(";")) {
    const [k, val] = part.split("=");
    if (!k || val == null) continue;
    const n = Number(val.trim());
    if (Number.isFinite(n)) o[k.trim().toLowerCase()] = n;
  }
  if (!("total" in o || "upload" in o || "download" in o || "expire" in o)) return null;
  return {
    used: (o.upload || 0) + (o.download || 0),
    total: o.total || 0,
    expire: o.expire || 0
  };
}

export function parseSubscriptionMeta(headers) {
  return {
    title: parseTitle(headerValue(headers, "profile-title")),
    info: parseUserInfo(headerValue(headers, "subscription-userinfo"))
  };
}

// --- A) full config xray ---

function isXrayConfig(o) {
  return o && typeof o === "object" && Array.isArray(o.outbounds);
}

// Выбираем «боевой» outbound, игнорируя служебные (freedom = прямой трафик,
// blackhole = блокировка, dns = перехват DNS).
const SERVICE = new Set(["freedom", "blackhole", "dns", "loopback"]);
const CONFIG_PROXY_PROTOCOLS = new Set([
  "vless", "vmess", "trojan", "shadowsocks", "socks", "http", "wireguard"
]);

function outboundNodes(outbound) {
  const settings = outbound.settings || {};
  if (Array.isArray(settings.vnext)) return { key: "vnext", nodes: settings.vnext };
  if (Array.isArray(settings.servers)) return { key: "servers", nodes: settings.servers };
  return { key: null, nodes: [] };
}

// Достаём адрес/порт/uuid из сервера outbound — структура зависит от протокола.
function outboundEndpoint(ob, node) {
  return {
    host: node.address || "",
    port: Number(node.port) || 0,
    uuid: node.users?.[0]?.id || node.password || node.id || ""
  };
}

function serversFromConfig(config) {
  const profileName = [config.remarks, config.name]
    .find((name) => typeof name === "string" && name.trim())?.trim();
  if (profileName) {
    const hasSupportedOutbound = config.outbounds.some((outbound) => {
      if (!outbound || !CONFIG_PROXY_PROTOCOLS.has(outbound.protocol)) return false;
      const { nodes } = outboundNodes(outbound);
      return nodes.some((node) => !!outboundEndpoint(outbound, node).host);
    });
    if (!hasSupportedOutbound) return [];
    return [{
      kind: "config",
      configProfile: true,
      name: profileName,
      protocol: "xray",
      host: "",
      port: 0,
      config
    }];
  }

  const servers = [];
  config.outbounds.forEach((ob, outboundIndex) => {
    if (!ob || SERVICE.has(ob.protocol) || !CONFIG_PROXY_PROTOCOLS.has(ob.protocol)) return;
    const { key, nodes } = outboundNodes(ob);
    nodes.forEach((node, nodeIndex) => {
      const ep = outboundEndpoint(ob, node);
      if (!ep.host) return;

      const stream = ob.streamSettings || {};
      const endpointName = `${ep.host}:${ep.port}`;
      const outboundName = ob.tag || config.remarks || config.name || endpointName;
      const name = nodes.length > 1
        ? `${outboundName} · ${endpointName}`
        : outboundName;

      servers.push({
        kind: "config",
        name: String(name),
        protocol: ob.protocol || "?",
        host: ep.host,
        port: ep.port,
        uuid: ep.uuid,
        network: stream.network || "tcp",
        security: stream.security || "none",
        outboundTag: ob.tag || "",
        outboundIndex,
        nodeKey: key,
        nodeIndex,
        config
      });
    });
  });
  return servers;
}

// --- B) список ссылок ---

function tryBase64(text) {
  const compact = text.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/\-_=]+$/.test(compact)) return null;
  try {
    let b64 = compact.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = atob(b64);
    return /:\/\//.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// Только строки, которые целиком являются ссылкой на прокси-конфиг.
// Важно: НЕ хватаем любые "://" внутри JSON (иначе DNS-адрес вроде
// https://8.8.8.8/dns-query принимается за конфиг).
const PROXY_SCHEME = /^(vless|vmess|trojan|ss|ssr|hy2|hysteria2?|tuic):\/\//i;

function extractLinks(text) {
  return text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => PROXY_SCHEME.test(l));
}

// --- основной вход ---

// fetchRaw(url) → { ok, body, headers?, error? }. Подписку качает helper, а не
// браузер: провайдер может прятаться за антибот-прокси (DDoS-Guard/Cloudflare),
// который блокирует fetch с браузерным User-Agent. Helper ходит в сеть обычным
// HTTP-клиентом (как curl), и антибот его пропускает.
export async function fetchSubscription(url, fetchRaw) {
  let res;
  try {
    res = await fetchRaw(url);
  } catch (e) {
    throw new Error("не удалось связаться с helper'ом: " + (e?.message || e));
  }
  if (!res || !res.ok) {
    throw new Error(res?.error || "не удалось скачать подписку");
  }

  const meta = parseSubscriptionMeta(res.headers);
  const body = (res.body || "").trim();
  if (!body) throw new Error("подписка пустая");

  // A) пробуем как JSON full config
  let json = null;
  try {
    json = JSON.parse(body);
  } catch { /* не JSON — идём дальше */ }

  if (json) {
    const configs = Array.isArray(json) ? json : [json];
    const valid = configs.filter(isXrayConfig);
    if (valid.length) {
      const servers = valid.flatMap(serversFromConfig);
      if (!servers.length) {
        throw new Error("конфиг xray получен, но в нём нет рабочего outbound'а");
      }
      return {
        servers,
        skipped: valid.length - servers.length,
        total: valid.length,
        format: "xray-config",
        meta
      };
    }
    throw new Error("получен JSON, но это не похоже на конфиг xray");
  }

  // B) список ссылок: base64 или plain text
  const links = extractLinks(tryBase64(body) ?? body);
  if (!links.length) {
    throw new Error("формат подписки не распознан (ни конфиг xray, ни список ссылок)");
  }

  const servers = [];
  const skippedSchemes = new Set();
  for (const link of links) {
    const parsed = parseVless(link);
    if (parsed) servers.push({ ...parsed, kind: "link", protocol: "vless" });
    else skippedSchemes.add((link.split("://")[0] || "?").toLowerCase());
  }

  if (!servers.length) {
    throw new Error(
      `в подписке ${links.length} конфиг(ов), протокол: ${[...skippedSchemes].join(", ")}. ` +
        `Из ссылок пока поддерживается только VLESS.`
    );
  }

  return {
    servers,
    skipped: links.length - servers.length,
    total: links.length,
    format: "links",
    meta
  };
}
