import { parseVless, shortUuid } from "./vless.js";
import { isSubscriptionUrl } from "./subscription.js";
import {
  DEFAULT_SETTINGS, loadAll, mutate, migrate, sanitizeSettings,
  serverKey, metaKey, pingId, findServer, subName, serverMetadata, normalizeBypassHost
} from "./store.js";

const $ = (id) => document.getElementById(id);
const statusDot = $("statusDot");
const settingsBtn = $("settingsBtn");
const appView = $("appView");
const settingsView = $("settingsView");
const onboard = $("onboard");
const toggleBtn = $("toggleBtn");
const heroStatus = $("heroStatus");
const heroName = $("heroName");
const heroMeta = $("heroMeta");
const ipBtn = $("ipBtn");
const ipResult = $("ipResult");
const siteBypassBtn = $("siteBypassBtn");
const siteBypassInfo = $("siteBypassInfo");
const errorLine = $("errorLine");
const linkInput = $("linkInput");
const addBtn = $("addBtn");
const listHead = $("listHead");
const sortSelect = $("sortSelect");
const refreshAllBtn = $("refreshAllBtn");
const pingAllBtn = $("pingAllBtn");
const speedAllBtn = $("speedAllBtn");
const serverList = $("serverList");
const toasts = $("toasts");
const obDownload = $("obDownload");
const obRecheck = $("obRecheck");
const obHint = $("obHint");
const obStepInstall = $("obStepInstall");
const obStepRestart = $("obStepRestart");
const optAutoUpdate = $("optAutoUpdate");
const optInterval = $("optInterval");
const optUpdateOnStart = $("optUpdateOnStart");
const optAutoConnect = $("optAutoConnect");
const optShowTech = $("optShowTech");
const optSpeedTestMB = $("optSpeedTestMB");
const optSpeedTimeoutSeconds = $("optSpeedTimeoutSeconds");
const bypassHostInput = $("bypassHostInput");
const bypassHostAddBtn = $("bypassHostAddBtn");
const bypassHostsList = $("bypassHostsList");
const refreshNowBtn = $("refreshNowBtn");
const exportBtn = $("exportBtn");
const importToggleBtn = $("importToggleBtn");
const importBox = $("importBox");
const importText = $("importText");
const importApplyBtn = $("importApplyBtn");
const resetBtn = $("resetBtn");
const helperVersionValue = $("helperVersionValue");
const extensionVersionValue = $("extensionVersionValue");
const versionWarning = $("versionWarning");

// ---------- состояние ----------

let data = {
  subs: [], manual: [], selected: null, favorites: [],
  settings: { ...DEFAULT_SETTINGS }, ui: { expanded: {} }
};
let pings = { running: false, results: {} }; // storage.session, пишет background
let speeds = { running: false, results: {} };
let refreshing = new Set();                  // id подписок, которые сейчас обновляются
let connected = false;
let activeServer = null;
let currentSiteHost = "";
let bypassBusy = false;
let busy = false;
let inSettings = false;
let renamingId = null;
let favSet = new Set();
let versionCheckId = 0;
let storageSyncId = 0;

// ---------- иконки ----------

const ICONS = {
  chevron: '<path d="M9 6l6 6-6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  sliders: '<path d="M4 7h10"/><circle cx="17" cy="7" r="2.5"/><path d="M20 17H10"/><circle cx="7" cy="17" r="2.5"/>',
  pencil: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/>',
  star: '<path d="M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7z"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  sort: '<path d="M8 5v14"/><path d="M5 16l3 3 3-3"/><path d="M16 19V5"/><path d="M13 8l3-3 3 3"/>',
  speed: '<path d="M3 13a9 9 0 1 1 18 0"/><path d="M12 13l4-4"/><path d="M5 18h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 6l-6 6 6 6"/>'
};

const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function iconBtn(name, title, cls, onClick) {
  const b = h("button", `icon-btn small ${cls || ""}`.trim());
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = icon(name);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

// ---------- мелкие помощники ----------

function plural(n, [one, few, many]) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function fmtBytes(n) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function rel(ts) {
  if (!ts) return "никогда";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн. назад`;
}

const sameRef = (a, b) => !!a && !!b && a.src === b.src && a.key === b.key;

async function send(msg) {
  try {
    return (await chrome.runtime.sendMessage(msg)) || { ok: false, error: "нет ответа от расширения" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function toast(text, { kind = "info", action = null, ms } = {}) {
  const el = h("div", `toast ${kind}`);
  el.append(h("span", "", text));
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (action) {
    const b = h("button", "toast-action", action.label);
    b.addEventListener("click", () => {
      action.run();
      close();
    });
    el.append(b);
  }
  toasts.append(el);
  while (toasts.children.length > 3) toasts.firstChild.remove();
  timer = setTimeout(close, ms ?? (kind === "error" ? 6500 : action ? 7000 : 3500));
}

// ---------- данные ----------

function groups() {
  const list = data.subs.map((sub) => ({
    id: sub.id, sub, name: subName(sub), servers: sub.servers || []
  }));
  if (data.manual.length) list.push({ id: "manual", sub: null, name: "Вручную", servers: data.manual });
  return list;
}

const selectedServer = () => findServer(data, data.selected);

// Если выбранного сервера нет (первый запуск, подписку удалили или обновили) — берём первый.
function ensureSelection() {
  if (selectedServer()) return;
  const g = groups().find((x) => x.servers.length);
  const ref = g ? { src: g.id, key: serverKey(g.servers[0]) } : null;
  if (sameRef(ref, data.selected) || (!ref && !data.selected)) return;
  data.selected = ref;
  mutate(["selected"], (d) => {
    if (!findServer(d, d.selected)) d.selected = ref;
  });
}

// ---------- запуск ----------

init();

async function init() {
  document.querySelectorAll("[data-icon]").forEach((n) => { n.innerHTML = icon(n.dataset.icon); });
  $("aboutVersion").textContent = "v" + chrome.runtime.getManifest().version;
  setupOnboarding();
  bindEvents();
  await checkHelperAndRoute();
}

// Определяем, установлен ли helper: "status" отвечает — значит есть.
async function checkHelperAndRoute() {
  const status = await send({ cmd: "helperStatus" });
  if (status.ok) await enterApp();
  else enterOnboarding();
}

async function enterApp() {
  onboard.hidden = true;
  settingsBtn.hidden = false;
  setView(inSettings ? "settings" : "main");

  await migrate();
  const [d, local, session] = await Promise.all([
    loadAll(),
    chrome.storage.local.get("state"),
    chrome.storage.session.get(["pings", "speeds", "refreshing"])
  ]);
  data = d;
  currentSiteHost = await readCurrentSiteHost();
  connected = !!local.state?.connected;
  activeServer = local.state?.server || null;
  errorLine.textContent = local.state?.error || "";
  pings = session.pings || pings;
  speeds = session.speeds || speeds;
  refreshing = new Set(session.refreshing || []);
  ensureSelection();
  render();
}

async function readCurrentSiteHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return normalizeBypassHost(tab?.url) || "";
  } catch (error) {
    console.error("Не удалось определить текущий сайт:", error);
    return "";
  }
}

function enterOnboarding() {
  appView.hidden = true;
  settingsView.hidden = true;
  onboard.hidden = false;
  settingsBtn.hidden = true;
}

function setView(name) {
  inSettings = name === "settings";
  appView.hidden = inSettings;
  settingsView.hidden = !inSettings;
  settingsBtn.setAttribute("aria-pressed", String(inSettings));
  settingsBtn.title = inSettings ? "Закрыть настройки" : "Настройки";
  if (inSettings) {
    syncSettingsUI();
    refreshComponentVersions();
  }
}

async function refreshComponentVersions() {
  const checkId = ++versionCheckId;
  const extensionVersion = chrome.runtime.getManifest().version;
  helperVersionValue.textContent = "Проверяю…";
  extensionVersionValue.textContent = `v${extensionVersion}`;
  versionWarning.hidden = true;
  const result = await send({ cmd: "componentVersions" });
  if (checkId !== versionCheckId || !inSettings) return;
  if (!result.ok || !result.helperVersion) {
    helperVersionValue.textContent = "не определена";
    versionWarning.textContent = `Не удалось получить версию helper: ${result.error || "нет ответа"}`;
    versionWarning.hidden = false;
    return;
  }
  helperVersionValue.textContent = `v${result.helperVersion}`;
  if (result.helperVersion !== extensionVersion) {
    versionWarning.textContent = "Версии helper и расширения не совпадают. Обновите компонент, версия которого отличается.";
    versionWarning.hidden = false;
  }
}

// Настраивает тексты/ссылку под ОС и вешает «Проверить снова».
function setupOnboarding() {
  const plat = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  const isWindows = /win/.test(plat);
  const isLinux = /linux|x11/.test(plat);

  obDownload.href = "https://github.com/evangelion3131/vless-extension/releases/latest";
  obDownload.textContent = isWindows
    ? "Скачать для Windows"
    : isLinux ? "Скачать для Linux" : "Скачать для macOS";
  obStepInstall.textContent = isWindows
    ? "Запустите install-windows.ps1 из папки."
    : isLinux
      ? "Запустите install-linux.sh из папки."
      : "Запустите install-macos.sh из папки.";
  obStepRestart.innerHTML = isWindows
    ? "<b>Перезапустите Chrome полностью</b> — закройте все окна и откройте заново, иначе helper не подхватится."
    : isLinux
      ? "<b>Перезапустите Chrome полностью</b> — закройте все окна и откройте заново, иначе helper не подхватится."
      : "<b>Перезапустите Chrome полностью</b> — <b>Cmd+Q</b> и откройте заново, иначе helper не подхватится.";

  obRecheck.addEventListener("click", async () => {
    obHint.textContent = "Проверяю…";
    obRecheck.disabled = true;
    const status = await send({ cmd: "helperStatus" });
    obRecheck.disabled = false;
    if (status.ok) {
      obHint.textContent = "";
      await enterApp();
    } else {
      obHint.textContent = "Helper пока не найден. Установили приложение и перезапустили Chrome?";
    }
  });
}

// ---------- отрисовка ----------

function render() {
  // пока пользователь переименовывает подписку, не пересоздаём поле ввода
  if (renamingId && document.activeElement?.classList.contains("rename-input")) return;
  renderStatus();
  renderList();
  if (inSettings) syncSettingsUI();
}

function renderStatus() {
  statusDot.classList.toggle("on", connected);
  const label = connected ? "Отключить" : "Подключить";
  toggleBtn.title = label;
  toggleBtn.setAttribute("aria-label", label);
  toggleBtn.classList.toggle("on", connected);
  toggleBtn.classList.toggle("busy", busy);

  const sel = selectedServer();
  toggleBtn.disabled = busy || (!connected && !sel);

  heroStatus.textContent = busy ? "Подождите…" : connected ? "Подключено" : "Не подключено";
  heroStatus.classList.toggle("on", connected && !busy);

  const cur = connected && activeServer ? activeServer : sel;
  heroName.textContent = cur ? cur.name : "Сервер не выбран";
  let meta = cur
    ? (cur.configProfile ? "Профиль Xray" : `${cur.host}:${cur.port}`)
    : groups().length ? "Выберите сервер справа" : "Добавьте подписку справа";
  const r = data.selected && pings.results[pingId(data.selected)];
  if (cur && sel && r?.state === "done" && metaKey(cur) === metaKey(sel)) meta += ` · ${r.ms} мс`;
  heroMeta.textContent = meta;

  renderSiteBypass();
}

function renderSiteBypass() {
  const host = currentSiteHost;
  const hosts = data.settings.bypassHosts;
  const inherited = host
    ? hosts.filter((entry) => host !== entry && host.endsWith(`.${entry}`)).sort((a, b) => b.length - a.length)[0]
    : "";
  const builtIn = host === "localhost" || host === "127.0.0.1" || host === "[::1]";

  if (!host) {
    siteBypassBtn.textContent = "Добавить текущий сайт в исключения";
    siteBypassBtn.disabled = true;
    siteBypassInfo.textContent = "Недоступно на служебных страницах браузера";
  } else if (builtIn || inherited) {
    siteBypassBtn.textContent = "Сайт уже идет напрямую";
    siteBypassBtn.disabled = true;
    siteBypassInfo.textContent = builtIn
      ? `${host} уже обходит прокси`
      : `Исключение настроено для ${inherited}`;
  } else {
    const exact = hosts.includes(host);
    siteBypassBtn.textContent = exact
      ? "Убрать сайт из исключений"
      : "Добавить текущий сайт в исключения";
    siteBypassBtn.disabled = bypassBusy;
    siteBypassInfo.textContent = exact
      ? `${host} и его поддомены идут напрямую`
      : `${host} и его поддомены будут идти напрямую`;
  }
  if (bypassBusy && host && !builtIn && !inherited) siteBypassBtn.disabled = true;
}

function renderList() {
  const gs = groups();
  favSet = new Set(data.favorites);

  listHead.hidden = !gs.length;
  sortSelect.value = data.settings.sort;

  const anyRefreshing = refreshing.size > 0;
  refreshAllBtn.classList.toggle("spin", anyRefreshing);
  refreshAllBtn.disabled = anyRefreshing || !data.subs.length;
  pingAllBtn.textContent = pings.running ? "Стоп" : "Пинг всех";
  pingAllBtn.disabled = !pings.running && !gs.some((g) => g.servers.length);
  speedAllBtn.textContent = speeds.running ? "Стоп" : "Скорость всех";
  speedAllBtn.disabled = !speeds.running && !gs.some((g) => g.servers.length);

  const top = serverList.scrollTop;
  if (!gs.length) {
    serverList.replaceChildren(emptyState());
    return;
  }
  serverList.replaceChildren(...gs.map(buildGroup));
  serverList.scrollTop = top;
}

function emptyState() {
  const d = h("div", "empty");
  d.append(
    h("strong", "", "Серверов пока нет"),
    document.createElement("br"),
    "Вставьте ссылку на подписку или vless:// в поле выше"
  );
  return d;
}

function buildGroup(g) {
  const open = !!data.ui.expanded[g.id];
  const root = h("div", "group" + (open ? " open" : ""));
  root.dataset.id = g.id;

  // --- заголовок ---
  const head = h("div", "group-head");
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", String(open));

  const chev = h("span", "chev");
  chev.innerHTML = icon("chevron");

  const info = h("div", "group-info");
  const title = h("div", "group-title");
  if (renamingId === g.id) {
    title.append(renameInput(g));
  } else {
    const name = h("span", "group-name", g.name);
    name.title = g.name;
    title.append(name);
  }
  const n = g.servers.length;
  title.append(h("span", "group-count", `${n} ${plural(n, ["сервер", "сервера", "серверов"])}`));

  const subLine = h("div", "group-sub");
  const sub = g.sub;
  if (!sub) {
    subLine.textContent = "Добавлены вручную";
  } else if (refreshing.has(sub.id)) {
    subLine.textContent = "Обновляется…";
  } else if (sub.error) {
    subLine.classList.add("error");
    subLine.textContent = `Не удалось обновить: ${sub.error}`;
    subLine.title = sub.error + (sub.updatedAt ? ` · последнее удачное обновление ${rel(sub.updatedAt)}` : "");
  } else {
    subLine.textContent =
      `Обновлено ${rel(sub.updatedAt)}` + (sub.skipped ? ` · пропущено ${sub.skipped} (не VLESS)` : "");
  }
  info.append(title, subLine);
  if (sub?.info) {
    const q = buildQuota(sub.info);
    if (q) info.append(q);
  }

  const actions = h("div", "group-actions");
  if (sub) {
    actions.append(iconBtn("pencil", "Переименовать", "", () => startRename(g.id)));
    const rb = iconBtn("refresh", "Обновить подписку", refreshing.has(sub.id) ? "spin" : "", () => refreshOne(sub.id));
    rb.disabled = refreshing.has(sub.id);
    actions.append(rb);
  }
  const pg = iconBtn("bolt", "Измерить задержку серверов группы", "", () =>
    pingRefs(g.servers.map((s) => ({ src: g.id, key: serverKey(s) })))
  );
  pg.disabled = !n;
  actions.append(pg);
  const sp = iconBtn("speed", "Измерить скорость серверов группы", "", () =>
    speedRefs(g.servers.map((s) => ({ src: g.id, key: serverKey(s) })))
  );
  sp.disabled = !n;
  actions.append(sp);
  if (sub) actions.append(iconBtn("trash", "Удалить подписку", "danger", () => deleteSub(sub.id)));

  head.append(chev, info, actions);
  head.addEventListener("click", () => toggleGroup(g.id, root, head));
  head.addEventListener("keydown", (e) => {
    if (e.target === head && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggleGroup(g.id, root, head);
    }
  });

  // --- список серверов ---
  const wrap = h("div", "group-body-wrap");
  const body = h("div", "group-body");
  const inner = h("div", "group-body-inner");
  if (!n) inner.append(h("div", "group-empty", sub ? "В подписке нет серверов" : "Пусто"));
  for (const s of sortedServers(g)) inner.append(buildRow(g, s));
  body.append(inner);
  wrap.append(body);

  root.append(head, wrap);
  return root;
}

function buildQuota(info) {
  const q = h("div", "quota");
  const used = info.used || 0;
  if (info.total > 0) {
    const pct = Math.min(100, (used / info.total) * 100);
    const bar = h("div", "quota-bar");
    const fill = h("div", "quota-fill");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    q.append(bar, h("span", "", `${fmtBytes(used)} из ${fmtBytes(info.total)}`));
    if (pct >= 100) q.classList.add("danger");
    else if (pct >= 85) q.classList.add("warn");
  } else if (used > 0) {
    q.append(h("span", "", `${fmtBytes(used)} · без лимита`));
  }
  if (info.expire > 0) {
    const days = Math.ceil((info.expire * 1000 - Date.now()) / 864e5);
    const e = h("span", "exp");
    if (days <= 0) {
      e.textContent = "срок истёк";
      e.classList.add("danger");
    } else {
      e.textContent = `ещё ${days} ${plural(days, ["день", "дня", "дней"])}`;
      if (days <= 3) e.classList.add("warn");
    }
    e.title = `Действует до ${new Date(info.expire * 1000).toLocaleDateString("ru-RU")}`;
    q.append(e);
  }
  return q.childElementCount ? q : null;
}

// Избранные — сверху; без замера серверы остаются после измеренных.
function sortedServers(g) {
  const sort = data.settings.sort;
  const list = g.servers.map((s, i) => {
    const id = pingId({ src: g.id, key: serverKey(s) });
    const ping = pings.results[id];
    const speed = speeds.results[id];
    return {
      s, i,
      fav: favSet.has(serverKey(s)),
      ms: ping?.state === "done" ? ping.ms : Infinity,
      mbps: speed?.state === "done" ? speed.mbps : -Infinity
    };
  });
  list.sort((a, b) =>
    (Number(b.fav) - Number(a.fav)) ||
    (sort === "ping" && a.ms !== b.ms ? (a.ms < b.ms ? -1 : 1) : 0) ||
    (sort === "speed" && a.mbps !== b.mbps ? (a.mbps > b.mbps ? -1 : 1) : 0) ||
    (a.i - b.i)
  );
  return list.map((x) => x.s);
}

function buildRow(g, s) {
  const key = serverKey(s);
  const ref = { src: g.id, key };
  const isSel = connected && activeServer
    ? metaKey(s) === metaKey(activeServer)
    : sameRef(data.selected, ref);

  const row = h("div", "server" + (isSel ? " selected" : ""));
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.title = s.name;
  row.append(h("span", "radio"));

  const info = h("div", "info");
  info.append(h("div", "name", s.name));
  if (data.settings.showTech) {
    if (s.configProfile) {
      info.append(h("div", "meta", "Полный профиль Xray"));
    } else {
      const proto = s.protocol || "vless";
      info.append(h("div", "meta",
        `${s.host}:${s.port} · ${proto}/${s.network}/${s.security}` +
        (s.uuid ? ` · ${shortUuid(s.uuid)}` : "")));
    }
  }
  row.append(info);

  const isFav = favSet.has(key);
  row.append(iconBtn("star", isFav ? "Убрать из избранного" : "В избранное",
    "fav-btn" + (isFav ? " on" : ""), () => toggleFavorite(key)));

  // плашка пинга показывается только при реальном результате (или пока идёт замер)
  const ping = h("button", "ping");
  const r = pings.results[pingId(ref)];
  if (r?.state === "done") {
    ping.textContent = String(r.ms);
    ping.classList.add(r.ms < 300 ? "good" : r.ms < 1000 ? "slow" : "bad");
    ping.title = `${r.ms} мс через туннель. Нажмите, чтобы измерить снова`;
  } else if (r?.state === "measuring" || r?.state === "queued") {
    ping.textContent = "…";
    ping.classList.add("wait");
    ping.disabled = true;
    ping.title = r.state === "queued" ? "В очереди на замер" : "Измеряю…";
  } else if (r?.state === "error") {
    ping.textContent = "×";
    ping.classList.add("bad");
    ping.title = (r.err || "Не удалось измерить") + ". Нажмите, чтобы повторить";
  } else {
    ping.classList.add("idle");
    ping.innerHTML = icon("bolt");
    ping.title = "Измерить задержку через туннель";
  }
  ping.addEventListener("click", (e) => {
    e.stopPropagation();
    pingRefs([ref]);
  });
  row.append(ping);

  const speed = h("button", "speed");
  const speedResult = speeds.results[pingId(ref)];
  if (speedResult?.state === "done") {
    speed.textContent = `${Number(speedResult.mbps).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} Мбит`;
    speed.classList.add("good");
    speed.title = "Скорость скачивания через туннель. Нажмите, чтобы измерить снова";
  } else if (speedResult?.state === "measuring" || speedResult?.state === "queued") {
    speed.textContent = "…";
    speed.classList.add("wait");
    speed.disabled = true;
    speed.title = speedResult.state === "queued" ? "В очереди на тест скорости" : "Измеряю скорость…";
  } else if (speedResult?.state === "error") {
    speed.textContent = "×";
    speed.classList.add("bad");
    speed.title = (speedResult.err || "Не удалось измерить скорость") + ". Нажмите, чтобы повторить";
  } else {
    speed.classList.add("idle");
    speed.innerHTML = icon("speed");
    speed.title = `Измерить скорость скачивания (${data.settings.speedTestMB} МБ)`;
  }
  speed.addEventListener("click", (e) => {
    e.stopPropagation();
    speedRefs([ref]);
  });
  row.append(speed);

  if (g.id === "manual") {
    row.append(iconBtn("close", "Удалить сервер", "danger", () => removeManual(s)));
  }

  row.addEventListener("click", () => selectServer(ref, s));
  row.addEventListener("keydown", (e) => {
    if (e.target === row && e.key === "Enter") selectServer(ref, s);
  });
  return row;
}

function toggleGroup(id, root, head) {
  const open = !root.classList.contains("open");
  root.classList.toggle("open", open); // анимация идёт на живом элементе
  head.setAttribute("aria-expanded", String(open));
  data.ui.expanded[id] = open;
  mutate(["ui"], (d) => { d.ui.expanded[id] = open; });
}

// ---------- переименование подписки ----------

function renameInput(g) {
  const inp = h("input", "rename-input");
  inp.type = "text";
  inp.value = g.name;
  inp.maxLength = 60;
  inp.spellcheck = false;
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(g.id, inp.value);
    } else if (e.key === "Escape") {
      cancelRename();
    }
  });
  inp.addEventListener("blur", () => commitRename(g.id, inp.value));
  return inp;
}

function startRename(id) {
  renamingId = id;
  render();
  const inp = serverList.querySelector(".rename-input");
  inp?.focus();
  inp?.select();
}

function commitRename(id, value) {
  if (renamingId !== id) return;
  renamingId = null;
  const name = value.trim();
  const sub = data.subs.find((s) => s.id === id);
  if (sub) sub.customName = !name || name === sub.autoName ? "" : name;
  render();
  mutate(["subs"], (d) => {
    const s = d.subs.find((x) => x.id === id);
    if (s) s.customName = !name || name === s.autoName ? "" : name;
  });
}

function cancelRename() {
  renamingId = null;
  render();
}

// ---------- действия со списком ----------

function toggleFavorite(key) {
  const on = !favSet.has(key);
  data.favorites = on ? [...data.favorites, key] : data.favorites.filter((k) => k !== key);
  render();
  mutate(["favorites"], (d) => {
    const set = new Set(d.favorites);
    if (on) set.add(key); else set.delete(key);
    d.favorites = [...set];
  });
}

function connectMessage(server, ref) {
  return {
    cmd: "connect",
    ...(server.kind === "config" ? { config: server.config } : { link: server.raw }),
    server: serverMetadata(server),
    ref
  };
}

async function selectServer(ref, server) {
  if (busy) return;
  data.selected = ref;
  const same = connected && activeServer && metaKey(server) === metaKey(activeServer);
  if (!connected || same) {
    render();
    mutate(["selected"], (d) => { d.selected = ref; });
    return;
  }
  // подключены к другому серверу — переключаемся сразу
  errorLine.textContent = "";
  busy = true;
  render();
  mutate(["selected"], (d) => { d.selected = ref; });
  try {
    const res = await send(connectMessage(server, ref));
    if (!res.ok) errorLine.textContent = res.error || "не удалось подключиться";
  } finally {
    busy = false;
    render();
  }
}

async function removeManual(s) {
  if (connected && activeServer && metaKey(s) === metaKey(activeServer)) {
    toast("Сначала отключитесь от этого сервера");
    return;
  }
  const key = serverKey(s);
  let idx = -1;
  let wasSelected = false;
  await mutate(["manual", "selected"], (d) => {
    idx = d.manual.findIndex((x) => serverKey(x) === key);
    if (idx < 0) return;
    d.manual.splice(idx, 1);
    if (d.selected?.src === "manual" && d.selected.key === key) {
      wasSelected = true;
      d.selected = null;
    }
  });
  if (idx < 0) return;
  toast(`Удалён: ${s.name}`, {
    action: {
      label: "Отменить",
      run: () => mutate(["manual", "selected"], (d) => {
        d.manual.splice(Math.min(idx, d.manual.length), 0, s);
        if (wasSelected && !d.selected) d.selected = { src: "manual", key };
      })
    }
  });
}

async function deleteSub(id) {
  const sub = data.subs.find((s) => s.id === id);
  if (!sub) return;
  const name = subName(sub);
  let idx = -1;
  let wasSelected = null;
  let wasOpen = false;
  await mutate(["subs", "selected", "ui"], (d) => {
    idx = d.subs.findIndex((s) => s.id === id);
    if (idx < 0) return;
    d.subs.splice(idx, 1);
    wasOpen = !!d.ui.expanded[id];
    delete d.ui.expanded[id];
    if (d.selected?.src === id) {
      wasSelected = d.selected;
      d.selected = null;
    }
  });
  if (idx < 0) return;
  toast(`Подписка «${name}» удалена`, {
    action: {
      label: "Отменить",
      run: () => mutate(["subs", "selected", "ui"], (d) => {
        d.subs.splice(Math.min(idx, d.subs.length), 0, sub);
        d.ui.expanded[id] = wasOpen;
        if (wasSelected && !d.selected) d.selected = wasSelected;
      })
    }
  });
}

async function refreshOne(id) {
  const res = await send({ cmd: "refreshSub", id });
  const sub = data.subs.find((s) => s.id === id);
  if (res.ok) {
    toast(`${sub ? subName(sub) : "Подписка"}: ${res.count} ${plural(res.count, ["сервер", "сервера", "серверов"])}` +
      (res.skipped ? `, пропущено ${res.skipped}` : ""), { kind: "success" });
  } else {
    toast(res.error || "Не удалось обновить подписку", { kind: "error" });
  }
}

async function refreshAll() {
  if (!data.subs.length) {
    toast("Подписок пока нет");
    return;
  }
  const res = await send({ cmd: "refreshAll" });
  if (!res.ok) {
    toast(res.error || "Не удалось обновить подписки", { kind: "error" });
    return;
  }
  const results = res.results || [];
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) {
    toast(`Обновлено подписок: ${results.length}`, { kind: "success" });
  } else {
    toast(`Не удалось обновить ${bad.length} из ${results.length}: ${bad[0].error}`, { kind: "error" });
  }
}

async function pingRefs(refs) {
  if (!refs.length) return;
  const res = await send({ cmd: "pingStart", refs });
  if (!res.ok) toast(res.error || "Не удалось запустить замер", { kind: "error" });
}

async function speedRefs(refs) {
  if (!refs.length) return;
  const res = await send({ cmd: "speedStart", refs });
  if (!res.ok) toast(res.error || "Не удалось запустить тест скорости", { kind: "error" });
}

// ---------- добавление ----------

async function addFromInput() {
  const value = linkInput.value.trim();
  if (!value) return;

  if (isSubscriptionUrl(value)) {
    addBtn.disabled = true;
    const res = await send({ cmd: "addSub", url: value });
    addBtn.disabled = false;
    if (res.ok) {
      const syncId = ++storageSyncId;
      const latest = await loadAll();
      if (syncId === storageSyncId) {
        data = latest;
        ensureSelection();
        render();
      }
      linkInput.value = "";
      toast(
        res.existed
          ? `Эта подписка уже добавлена — обновил список (${res.count})`
          : `Добавлена подписка «${res.name}»: ${res.count} ${plural(res.count, ["сервер", "сервера", "серверов"])}`,
        { kind: "success" }
      );
      setTimeout(() => {
        serverList.querySelector(`[data-id="${res.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 80);
    } else {
      toast(res.error || "Не удалось загрузить подписку", { kind: "error" });
    }
    return;
  }

  const parsed = parseVless(value);
  if (!parsed) {
    toast("Нужна ссылка-подписка (https://…) или vless://", { kind: "error" });
    return;
  }
  const server = { ...parsed, kind: "link", protocol: "vless" };
  const key = serverKey(server);
  let added = false;
  await mutate(["manual", "selected", "ui"], (d) => {
    if (d.manual.some((m) => m.raw === server.raw)) return;
    d.manual.push(server);
    d.selected = { src: "manual", key };
    d.ui.expanded.manual = true;
    added = true;
  });
  linkInput.value = "";
  toast(added ? `Добавлен: ${parsed.name}` : "Этот сервер уже добавлен", { kind: added ? "success" : "info" });
}

// ---------- подключение ----------

async function onToggle() {
  errorLine.textContent = "";
  busy = true;
  render();
  try {
    if (!connected) {
      const srv = selectedServer();
      if (!srv) return;
      const res = await send(connectMessage(srv, data.selected));
      if (res.ok) {
        connected = true;
        activeServer = res.server || serverMetadata(srv);
      } else {
        errorLine.textContent = res.error || "не удалось подключиться";
      }
    } else {
      const res = await send({ cmd: "disconnect" });
      connected = false;
      activeServer = res.server || activeServer;
      if (!res.ok) errorLine.textContent = res.error || "не удалось отключиться";
    }
  } finally {
    busy = false;
    render();
  }
}

async function checkIp() {
  ipResult.textContent = "проверяю…";
  try {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    const j = await r.json();
    ipResult.textContent = `Текущий IP браузера: ${j.ip}`;
  } catch {
    ipResult.textContent = "не удалось проверить IP";
  }
}

// ---------- настройки ----------

function syncSettingsUI() {
  const s = data.settings;
  optAutoUpdate.checked = s.autoUpdate;
  optInterval.value = String(s.intervalHours);
  optUpdateOnStart.checked = s.updateOnStart;
  optAutoConnect.checked = s.autoConnect;
  optShowTech.checked = s.showTech;
  optSpeedTestMB.value = String(s.speedTestMB);
  optSpeedTimeoutSeconds.value = String(s.speedTimeoutSeconds);

  for (const control of [optInterval, optUpdateOnStart]) {
    control.disabled = !s.autoUpdate;
    control.closest(".row").classList.toggle("disabled", !s.autoUpdate);
  }
  refreshNowBtn.disabled = refreshing.size > 0 || !data.subs.length;
  bypassHostInput.disabled = bypassBusy;
  bypassHostAddBtn.disabled = bypassBusy;
  renderBypassHosts();
}

function renderBypassHosts() {
  bypassHostsList.replaceChildren(...data.settings.bypassHosts.map((host) => {
    const row = h("div", "bypass-entry");
    const label = h("span", "bypass-host", host);
    label.title = `${host} и его поддомены`;
    const remove = iconBtn("trash", `Удалить исключение ${host}`, "bypass-remove", () => removeBypassHost(host));
    remove.disabled = bypassBusy;
    row.append(label, remove);
    return row;
  }));
}

function hasBypassCoverage(host, hosts) {
  return hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

async function persistBypassHosts(hosts, message) {
  if (bypassBusy) return false;
  bypassBusy = true;
  render();
  try {
    data.settings = await mutate(["settings"], (d) => {
      d.settings = sanitizeSettings({ ...d.settings, bypassHosts: hosts });
      return d.settings;
    });
    render();
    const res = await send({ cmd: "updateProxyRules" });
    if (!res.ok) {
      toast(`Список сохранён, но прокси не обновлён: ${res.error || "ошибка настройки"}`, { kind: "error" });
      return false;
    }
    toast(message, { kind: "success" });
    return true;
  } catch (error) {
    toast(`Не удалось сохранить исключения: ${error?.message || String(error)}`, { kind: "error" });
    return false;
  } finally {
    bypassBusy = false;
    render();
  }
}

async function toggleCurrentSiteBypass() {
  const host = currentSiteHost;
  if (!host || bypassBusy) return;
  const hosts = data.settings.bypassHosts;
  if (hosts.includes(host)) {
    await persistBypassHosts(hosts.filter((entry) => entry !== host), `Исключение удалено: ${host}`);
  } else if (!hasBypassCoverage(host, hosts)) {
    await persistBypassHosts([...hosts, host], `Добавлено исключение: ${host}`);
  }
}

async function addBypassHost() {
  const host = normalizeBypassHost(bypassHostInput.value);
  if (!host) {
    toast("Введите корректный домен или HTTP(S)-адрес", { kind: "error" });
    return;
  }
  if (hasBypassCoverage(host, data.settings.bypassHosts)) {
    toast(`${host} уже покрыт существующим исключением`);
    return;
  }
  const saved = await persistBypassHosts([...data.settings.bypassHosts, host], `Добавлено исключение: ${host}`);
  if (saved) bypassHostInput.value = "";
}

async function removeBypassHost(host) {
  if (bypassBusy) return;
  await persistBypassHosts(
    data.settings.bypassHosts.filter((entry) => entry !== host),
    `Исключение удалено: ${host}`
  );
}

function saveSetting(patch) {
  data.settings = sanitizeSettings({ ...data.settings, ...patch });
  render();
  mutate(["settings"], (d) => { d.settings = sanitizeSettings({ ...d.settings, ...patch }); });
}

function buildBackup() {
  return {
    app: "vless-eevee",
    version: 1,
    exportedAt: new Date().toISOString(),
    subs: data.subs.map((s) => ({
      url: s.fragment ? `${s.url}#${encodeURIComponent(s.fragment)}` : s.url,
      customName: s.customName || ""
    })),
    manual: data.manual.map((s) => s.raw).filter(Boolean),
    favorites: data.favorites,
    settings: data.settings
  };
}

async function copyBackup() {
  const text = JSON.stringify(buildBackup(), null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Резервная копия скопирована в буфер обмена", { kind: "success" });
}

async function applyBackup() {
  let parsed;
  try {
    parsed = JSON.parse(importText.value);
  } catch {
    toast("Не получилось прочитать копию: это не JSON", { kind: "error" });
    return;
  }
  const res = await send({ cmd: "importBackup", data: parsed });
  if (!res.ok) {
    toast(res.error || "Не удалось восстановить копию", { kind: "error" });
    return;
  }
  importText.value = "";
  importBox.hidden = true;
  toast(`Добавлено: подписок ${res.addedSubs}, серверов ${res.addedManual}`, { kind: "success" });
}

let resetArmed = false;
async function onReset() {
  if (!resetArmed) {
    resetArmed = true;
    resetBtn.textContent = "Точно сбросить?";
    resetBtn.classList.add("armed");
    setTimeout(() => {
      resetArmed = false;
      resetBtn.textContent = "Сбросить";
      resetBtn.classList.remove("armed");
    }, 4000);
    return;
  }
  resetArmed = false;
  resetBtn.textContent = "Сбросить";
  resetBtn.classList.remove("armed");
  const res = await send({ cmd: "resetAll" });
  if (res.ok) {
    storageSyncId++;
    data.subs = [];
    data.manual = [];
    data.selected = null;
    data.favorites = [];
    data.settings = { ...DEFAULT_SETTINGS };
    data.ui = { expanded: {} };
    connected = false;
    activeServer = null;
    errorLine.textContent = "";
    pings = { running: false, results: {} };
    speeds = { running: false, results: {} };
    refreshing = new Set();
    ensureSelection();
    render();
    toast("Данные сброшены", { kind: "success" });
  } else {
    toast(res.error || "Не удалось сбросить данные", { kind: "error" });
  }
}

// ---------- события ----------

function bindEvents() {
  toggleBtn.addEventListener("click", onToggle);
  ipBtn.addEventListener("click", checkIp);
  siteBypassBtn.addEventListener("click", toggleCurrentSiteBypass);
  bypassHostAddBtn.addEventListener("click", addBypassHost);
  bypassHostInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBypassHost();
  });
  addBtn.addEventListener("click", addFromInput);
  linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addFromInput(); });

  sortSelect.addEventListener("change", () => saveSetting({ sort: sortSelect.value }));
  refreshAllBtn.addEventListener("click", refreshAll);
  pingAllBtn.addEventListener("click", () => {
    if (pings.running) {
      send({ cmd: "pingStop" });
      return;
    }
    pingRefs(groups().flatMap((g) => g.servers.map((s) => ({ src: g.id, key: serverKey(s) }))));
  });
  speedAllBtn.addEventListener("click", () => {
    if (speeds.running) {
      send({ cmd: "speedStop" });
      return;
    }
    speedRefs(groups().flatMap((g) => g.servers.map((s) => ({ src: g.id, key: serverKey(s) }))));
  });

  settingsBtn.addEventListener("click", () => setView(inSettings ? "main" : "settings"));
  $("settingsBack").addEventListener("click", () => setView("main"));
  optAutoUpdate.addEventListener("change", () => saveSetting({ autoUpdate: optAutoUpdate.checked }));
  optInterval.addEventListener("change", () => saveSetting({ intervalHours: Number(optInterval.value) }));
  optUpdateOnStart.addEventListener("change", () => saveSetting({ updateOnStart: optUpdateOnStart.checked }));
  optAutoConnect.addEventListener("change", () => saveSetting({ autoConnect: optAutoConnect.checked }));
  optShowTech.addEventListener("change", () => saveSetting({ showTech: optShowTech.checked }));
  optSpeedTestMB.addEventListener("change", () => saveSetting({ speedTestMB: Number(optSpeedTestMB.value) }));
  optSpeedTimeoutSeconds.addEventListener("change", () => saveSetting({ speedTimeoutSeconds: Number(optSpeedTimeoutSeconds.value) }));
  refreshNowBtn.addEventListener("click", refreshAll);
  exportBtn.addEventListener("click", copyBackup);
  importToggleBtn.addEventListener("click", () => {
    importBox.hidden = !importBox.hidden;
    if (!importBox.hidden) importText.focus();
  });
  importApplyBtn.addEventListener("click", applyBackup);
  resetBtn.addEventListener("click", onReset);

  chrome.storage.onChanged.addListener(onStorageChanged);
}

async function onStorageChanged(changes, area) {
  if (area === "session") {
    if (changes.pings) pings = changes.pings.newValue || { running: false, results: {} };
    if (changes.speeds) speeds = changes.speeds.newValue || { running: false, results: {} };
    if (changes.refreshing) refreshing = new Set(changes.refreshing.newValue || []);
    render();
    return;
  }
  if (area !== "local") return;

  const syncId = ++storageSyncId;
  try {
    const [latest, local] = await Promise.all([
      loadAll(),
      chrome.storage.local.get("state")
    ]);
    if (syncId !== storageSyncId) return;

    data = latest;
    if (changes.state) {
      const state = local.state || {};
      connected = !!state.connected;
      activeServer = state.server || null;
      errorLine.textContent = state.error || "";
    }
    ensureSelection();
    render();
  } catch (error) {
    console.error("Не удалось синхронизировать хранилище:", error);
  }
}
