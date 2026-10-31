// Фабрика Дверей: сайт + админка + API в одном Node-сервере.
// Без зависимостей, нужен Node 18+. Запуск: node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'catalog.json');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const MAXI = (+process.env.MAX_IMAGE_MB || 10) * 1e6;
const MAXV = (+process.env.MAX_VIDEO_MB || 100) * 1e6;
const UP = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
const PORT = +process.env.PORT || 3000;
const PASS = () => process.env.ADMIN_PASSWORD || '';
const SERVICES = ['Замер', 'Подбор дверей', 'Установка'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// ---------- вспомогательное ----------
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'x-content-type-options': 'nosniff', ...headers }); res.end(body); };
const J = (res, d, s = 200) => send(res, s, JSON.stringify(d), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const readBody = (req, max = 2e6) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on('data', (b) => { n += b.length; if (n > max) { no(new Error('big')); req.destroy(); } else c.push(b); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { ok({}); } });
  req.on('error', no);
});

// ---------- вход в админку (подписанный токен на 7 дней) ----------
const sign = (e) => createHmac('sha256', 'door:' + PASS()).update(String(e)).digest('hex');
const mkToken = () => { const e = Date.now() + 7 * 864e5; return e + '.' + sign(e); };
const valid = (t) => {
  if (!PASS() || !t) return false;
  const [e, h] = t.split('.');
  if (!e || !h || +e < Date.now()) return false;
  const a = Buffer.from(h), b = Buffer.from(sign(e));
  return a.length === b.length && timingSafeEqual(a, b);
};

// ---------- простой лимит запросов с одного IP ----------
const hits = new Map();
setInterval(() => hits.clear(), 36e5).unref();
const limited = (ip, key, max, ms) => {
  const k = key + ip, now = Date.now();
  const a = (hits.get(k) || []).filter((t) => now - t < ms); a.push(now); hits.set(k, a);
  return a.length > max;
};

// ---------- хранилище каталога (файл data/catalog.json) ----------
const readCatalog = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
const writeCatalog = (d) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, FILE);
};

// ---------- файлы из админки: фото и видео (папка data/uploads) ----------
function sendFile(req, res, file, type, cache) {
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, 'Not found');
    const h = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache, 'x-content-type-options': 'nosniff' };
    let a = 0, b = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) { // Range нужен для видео в Safari и перемотки
      if (m[1]) { a = +m[1]; if (m[2]) b = Math.min(+m[2], b); } else a = Math.max(0, st.size - +m[2]);
      if (a > b || a >= st.size) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
      code = 206; h['content-range'] = `bytes ${a}-${b}/${st.size}`;
    }
    h['content-length'] = b - a + 1;
    res.writeHead(code, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start: a, end: b }).pipe(res);
  });
}

function upload(req, res) {
  if (!valid((req.headers.authorization || '').slice(7))) return J(res, { error: 'auth' }, 401);
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = UP[type];
  if (!ext) return J(res, { error: 'Этот формат не поддерживается' }, 415);
  const max = type.startsWith('video/') ? MAXV : MAXI;
  const tooBig = { error: 'Файл больше ' + Math.round(max / 1e6) + ' МБ' };
  if ((+req.headers['content-length'] || 0) > max) return J(res, tooBig, 413);
  fs.mkdirSync(UP_DIR, { recursive: true });
  const name = randomBytes(8).toString('hex') + ext, tmp = path.join(UP_DIR, name + '.part');
  const out = fs.createWriteStream(tmp);
  let n = 0, over = false;
  req.on('data', (c) => {
    n += c.length;
    if (n > max && !over) { over = true; req.unpipe(out); out.destroy(); J(res, tooBig, 413); req.resume(); }
  });
  req.pipe(out);
  out.on('finish', () => { if (over) return; fs.renameSync(tmp, path.join(UP_DIR, name)); J(res, { url: '/uploads/' + name }); });
  out.on('close', () => { if (over) fs.unlink(tmp, () => {}); });
  out.on('error', (e) => { console.error(e); if (!res.headersSent) J(res, { error: 'Не удалось сохранить файл' }, 500); });
  req.on('error', () => out.destroy());
}

// удаляет загруженные файлы, на которые больше нет ссылок в каталоге (старше часа)
function cleanup(json) {
  try {
    for (const f of fs.readdirSync(UP_DIR)) {
      const p = path.join(UP_DIR, f);
      if (!json.includes(f) && Date.now() - fs.statSync(p).mtimeMs > 36e5) fs.unlinkSync(p);
    }
  } catch { /* папки ещё нет */ }
}

// ---------- API ----------
async function api(req, res, p, ip) {
  if (p === 'catalog' && req.method === 'GET') return J(res, readCatalog());

  if (p === 'login' && req.method === 'POST') {
    if (!PASS()) return J(res, { error: 'Не задан ADMIN_PASSWORD' }, 500);
    if (limited(ip, 'login', 10, 6e5)) return J(res, { error: 'Слишком много попыток. Подождите 10 минут' }, 429);
    const b = await readBody(req);
    return b.password === PASS() ? J(res, { token: mkToken() }) : J(res, { error: 'Неверный пароль' }, 401);
  }

  if (p === 'catalog' && req.method === 'PUT') {
    if (!valid((req.headers.authorization || '').slice(7))) return J(res, { error: 'auth' }, 401);
    const b = await readBody(req, 4e6);
    if (!Array.isArray(b.items) || !Array.isArray(b.cats) || b.items.length > 1000 || b.cats.length > 100) return J(res, { error: 'bad data' }, 400);
    const data = { cats: b.cats, items: b.items, video: String(b.video || '') };
    try { writeCatalog(data); cleanup(JSON.stringify(data)); }
    catch (e) { console.error(e); return J(res, { error: 'Не удалось сохранить на диск' }, 500); }
    return J(res, { ok: 1 });
  }

  if (p === 'upload' && req.method === 'POST') return upload(req, res);

  if (p === 'order' && req.method === 'POST') {
    if (limited(ip, 'order', 5, 6e5)) return J(res, { error: 'Слишком много заявок. Попробуйте позже' }, 429);
    const b = await readBody(req);
    if (b.website) return J(res, { ok: 1 }); // ловушка для ботов
    const name = String(b.name || '').trim().slice(0, 60);
    const phone = String(b.phone || '');
    const service = SERVICES.includes(b.service) ? b.service : 'Замер';
    const comment = String(b.comment || '').trim().slice(0, 300);
    if (name.length < 2 || !/^\+375 \d{2} \d{3}-\d{2}-\d{2}$/.test(phone)) return J(res, { error: 'Проверьте имя и телефон' }, 400);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chats = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!token || !chats.length) return J(res, { error: 'Бот не настроен' }, 500);
    const text = `🚪 <b>Новая заявка</b>\nУслуга: <b>${service}</b>\nИмя: ${esc(name)}\nТелефон: ${phone}\n` +
      (comment ? `Комментарий: ${esc(comment)}\n` : '') +
      `\n🕒 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}`;
    const sent = await Promise.all(chats.map((chat_id) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
      }).then((r) => r.ok).catch(() => false)));
    return sent.some(Boolean) ? J(res, { ok: 1 }) : J(res, { error: 'Не удалось отправить заявку' }, 502);
  }

  return J(res, { error: 'not found' }, 404);
}

// ---------- статические файлы из public/ ----------
function serve(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err) return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    if (st.isDirectory()) { res.writeHead(301, { location: pathname + '/' }); return res.end(); }
    const ext = path.extname(file).toLowerCase();
    const h = { 'content-type': MIME[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' };
    if (rel.startsWith('/admin')) h['x-robots-tag'] = 'noindex';
    const zip = /^\.(html|js|css|json|svg|txt)$/.test(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (zip) { h['content-encoding'] = 'gzip'; h.vary = 'Accept-Encoding'; } else h['content-length'] = st.size;
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(file);
    zip ? s.pipe(zlib.createGzip()).pipe(res) : s.pipe(res);
  });
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (u.pathname === '/healthz') return send(res, 200, 'ok');
    if (u.pathname.startsWith('/uploads/')) {
      const f = u.pathname.slice(9);
      if (!/^[a-f0-9]{16}\.[a-z0-9]{2,4}$/.test(f)) return send(res, 404, 'Not found');
      return sendFile(req, res, path.join(UP_DIR, f), MIME[path.extname(f)] || 'application/octet-stream', 'public, max-age=31536000, immutable');
    }
    if (u.pathname.startsWith('/api/')) return await api(req, res, u.pathname.slice(5).replace(/\/$/, ''), ip);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    serve(req, res, u.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) J(res, { error: 'server error' }, 500);
  }
}).listen(PORT, () => console.log('Сайт: http://localhost:' + PORT + '   Админка: http://localhost:' + PORT + '/admin/'));
