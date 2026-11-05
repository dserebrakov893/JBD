// JBD server: serves the website (../site) and takes requests from its forms (POST /lead):
// saves each one to DATA_DIR/leads.jsonl, then posts it to the Telegram bot.
// Node.js 18+, no dependencies. Railway runs it with `npm start`; settings come from environment variables (README.md).

import http from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const PORT = Number(process.env.PORT || 8787);
const BOT_TOKEN = process.env.BOT_TOKEN || "";            // from @BotFather
const CHAT_ID = process.env.CHAT_ID || "";                // your chat or group id with the bot
const ORIGINS = (process.env.ALLOW_ORIGIN || "https://justbusinessdarling.com,https://www.justbusinessdarling.com")
  .split(",").map(s => s.trim()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || "./data";
const TG_MODE = process.env.TG_MODE || "full";
const SITE_DIR = process.env.SITE_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "site");           // "full": the whole request in Telegram; "short": number and scope only, contacts stay on the server

const MAX_BODY = 20_000;
const LIMIT = { windowMs: 10 * 60_000, max: 5 };          // per IP
const hits = new Map();

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const rub = n => Number(n || 0).toLocaleString("ru-RU").replace(/ /g, " ") + " ₽";
const CH = { phone: "Звонок", tg: "Telegram", wa: "WhatsApp", max: "MAX", mail: "Почта", other: "Другое" };

function contactLink(ch, v) {
  const digits = v.replace(/\D/g, "");
  if (ch === "tg") {
    const u = v.replace(/^@|^https?:\/\/t\.me\//i, "");
    return /^[A-Za-z0-9_]{4,}$/.test(u) ? `<a href="https://t.me/${u}">@${esc(u)}</a>` : esc(v);
  }
  if (ch === "wa" && digits.length >= 10) return `<a href="https://wa.me/${digits}">${esc(v)}</a>`;
  if (ch === "phone" && digits.length >= 10) return `<a href="tel:+${digits}">${esc(v)}</a>`;
  if (ch === "mail") return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  return esc(v);
}

function clean(d) {
  const items = Array.isArray(d.items) ? d.items.slice(0, 40).map(x => ({
    name: clip(x.name, 160), price: Number(x.price) || 0, monthly: !!x.monthly, kind: x.kind === "bundle" ? "bundle" : "solution",
  })) : [];
  return {
    source: ["form", "about"].includes(d.source) ? d.source : "cart",
    name: clip(d.name, 120), channel: CH[d.channel] ? d.channel : (d.source === "form" ? "other" : "other"),
    contact: clip(d.contact, 200), comment: clip(d.comment ?? d.message, 3000),
    items, totals: { once: Number(d.totals?.once) || 0, monthly: Number(d.totals?.monthly) || 0 },
    promo: d.promo && d.promo.code ? { code: clip(d.promo.code, 40), pct: Number(d.promo.pct) || 0 } : null,
    lang: d.lang === "en" ? "en" : "ru", page: clip(d.page, 300), consent: d.consent === true,
  };
}

function message(id, x) {
  const head = x.source === "form" ? "Сообщение с сайта" : x.source === "about" ? "Заявка со страницы «О нас»" : "Заявка из корзины";
  const lines = [`<b>${head} #${id}</b>`];
  if (TG_MODE === "short") {
    if (x.items.length) lines.push(`Состав: ${x.items.length} поз., разово ${rub(x.totals.once)}${x.totals.monthly ? `, ежемесячно ${rub(x.totals.monthly)}` : ""}`);
    lines.push("Контакты сохранены на сервере, номер заявки выше.");
    return lines.join("\n");
  }
  lines.push(`<b>${esc(x.name)}</b> · ${esc(CH[x.channel] || "Контакт")}: ${contactLink(x.channel, x.contact)}`);
  if (x.items.length) {
    lines.push("", "<b>Состав</b>");
    x.items.forEach(i => lines.push(`• ${esc(i.name)} · от ${rub(i.price)}${i.monthly ? "/мес" : ""}`));
    const t = [];
    if (x.totals.once) t.push(`разово от ${rub(x.totals.once)}`);
    if (x.totals.monthly) t.push(`ежемесячно от ${rub(x.totals.monthly)}`);
    if (t.length) lines.push(`Итого: ${t.join(", ")}`);
    if (x.promo) lines.push(`Промокод: ${esc(x.promo.code)} (−${x.promo.pct}%)`);
  } else if (x.source === "cart") lines.push("", "Без состава: хочет разбор задачи");
  if (x.comment) lines.push("", `<b>Комментарий</b>`, esc(x.comment));
  lines.push("", `<i>${x.lang.toUpperCase()} · ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК</i>`);
  return lines.join("\n");
}

async function toTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("BOT_TOKEN or CHAT_ID is not set");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

// the site posts to its own host (custom domain or *.up.railway.app): always allowed; other sites only if listed
const allowed = req => { const o = req.headers.origin; if (!o) return true; try { if (new URL(o).host === req.headers.host) return true; } catch {} return ORIGINS.includes(o); };

function cors(req, res) {
  const o = req.headers.origin;
  if (o && allowed(req)) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < LIMIT.windowMs);
  list.push(now); hits.set(ip, list);
  return list.length > LIMIT.max;
}

/* ---------- the website ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".xml": "application/xml", ".webmanifest": "application/manifest+json" };
const cache = new Map();   // path -> { body, gz, type }: the site is a few files, keep them in memory, gzipped once
async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  if (!extname(path)) path += ".html";                       // /privacy -> privacy.html
  const rel = normalize(path).replace(/^([/\\])+/, "");
  if (rel.startsWith("..")) return send(res, 400, { ok: false });
  let f = cache.get(rel);
  if (!f) {
    let body; try { body = await readFile(join(SITE_DIR, rel)); } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found"); }
    const type = TYPES[extname(rel)] || "application/octet-stream";
    f = { body, type, gz: /text|javascript|svg|json|xml/.test(type) ? gzipSync(body, { level: 9 }) : null };
    cache.set(rel, f);
  }
  const h = { "Content-Type": f.type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Vary": "Accept-Encoding" };
  const useGz = f.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  if (useGz) h["Content-Encoding"] = "gzip";
  res.writeHead(200, h);
  res.end(req.method === "HEAD" ? undefined : (useGz ? f.gz : f.body));
}

const server = http.createServer(async (req, res) => {
  if ((req.method === "GET" || req.method === "HEAD") && req.url !== "/health") return serveStatic(req, res);
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || !req.url.startsWith("/lead")) return send(res, 404, { ok: false });
  if (!allowed(req)) return send(res, 403, { ok: false });

  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { ok: false, error: "too_many" });

  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) return send(res, 413, { ok: false }); }
  let d; try { d = JSON.parse(raw); } catch { return send(res, 400, { ok: false, error: "json" }); }
  if (d.website) return send(res, 200, { ok: true });                    // honeypot: bots fill the hidden field
  const x = clean(d);
  if (!x.name || !x.contact || !x.consent) return send(res, 422, { ok: false, error: "fields" });

  const id = Date.now().toString(36).toUpperCase();
  // 1) record in Russia first (152-FZ localisation), 2) then notify Telegram
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(join(DATA_DIR, "leads.jsonl"), JSON.stringify({ id, at: new Date().toISOString(), ip, ...x }) + "\n");
  } catch (e) { console.error("save failed", e); return send(res, 500, { ok: false }); }
  try { await toTelegram(message(id, x)); }
  catch (e) { console.error("telegram failed, lead", id, "is saved:", e.message); }
  send(res, 200, { ok: true, id });
});

server.listen(PORT, () => console.log(`JBD lead server on :${PORT}, origins: ${ORIGINS.join(", ")}`));
