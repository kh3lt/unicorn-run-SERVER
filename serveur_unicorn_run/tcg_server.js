// Unicorn Run : serveur du jeu (duels TCG en ligne + achats d'arcs-en-ciel)
// -----------------------------------------------------------------------------
// Aucune dépendance : il suffit de Node.js 18 ou plus.
//     node tcg_server.js
// Variables d'environnement (toutes facultatives) :
//   PORT               port d'écoute (les hébergeurs le donnent), sinon 8787
//   STRIPE_SECRET_KEY  clé secrète Stripe (sk_test_… pour essayer, sk_live_… pour de vrai) :
//                      sans elle, la boutique payante reste fermée
//   PUBLIC_URL         adresse publique du serveur (ex. https://mon-jeu.onrender.com), si les
//                      pages de retour après paiement ne trouvent pas la bonne adresse toutes seules
// Si le fichier platformer.html est posé à côté de ce fichier, le jeu est aussi
// servi à l'adresse du serveur : il s'y connecte alors tout seul, rien à régler.
// -----------------------------------------------------------------------------
// Duels : le serveur met deux joueurs en relation (salon à code ou partie rapide)
// puis relaie leurs messages ; les règles tournent sur le téléphone de l'hôte.
// Boutique : le serveur crée la page de paiement Stripe, vérifie auprès de Stripe
// que le paiement est bien passé, et ne crédite chaque paiement qu'une seule fois.
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 8787;
const GAME_FILE = path.join(__dirname, 'platformer.html');
const MAX_MSG = 512 * 1024;            // taille maximale d'un message (octets)
const MAX_RATE = 400;                  // messages maximum par joueur toutes les 10 s
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // sans I ni O (confusion avec 1 et 0)

const clients = new Set();
const rooms = new Map();               // code → {code, host, guest}
let quickWait = null;                  // joueur en attente d'une partie rapide
let nextId = 1;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- boutique : offres (le serveur fait foi)
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const STRIPE_API = process.env.STRIPE_API || 'https://api.stripe.com';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const PACKS = [
  {id: 'p1', rainbows: 500, cents: 99, bonus: 0},       // 0,99 €  : un coffre à chapeaux, ou un paquet de cartes
  {id: 'p2', rainbows: 1200, cents: 199, bonus: 20},    // 1,99 €  : +20 % offerts
  {id: 'p3', rainbows: 3500, cents: 499, bonus: 40},    // 4,99 €  : +40 % offerts
  {id: 'p4', rainbows: 8000, cents: 999, bonus: 60},    // 9,99 €  : +60 % offerts
];
const claimed = new Set(), claiming = new Set();
const ipHits = new Map();
function tooMany(ip, max) {
  const now = Date.now(), a = (ipHits.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now); ipHits.set(ip, a);
  return a.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of ipHits) if (!a.some((t) => now - t < 60000)) ipHits.delete(k); }, 300000);
function formEncode(obj, prefix, out) {
  out = out || [];
  for (const k of Object.keys(obj)) {
    const v = obj[k]; if (v === undefined || v === null) continue;
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (typeof v === 'object') formEncode(v, key, out); else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}
function stripe(method, path, params) {
  return new Promise((resolve, reject) => {
    const body = params && method !== 'GET' ? formEncode(params) : '';
    const u = new URL(STRIPE_API + path + (params && method === 'GET' ? '?' + formEncode(params) : ''));
    const req = (u.protocol === 'http:' ? http : https).request(u, {method: method, headers: {
      'Authorization': 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body)}}, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(d); } catch (e) { reject(new Error('réponse Stripe illisible')); return; }
        if (res.statusCode >= 400) { reject(new Error((j.error && j.error.message) || ('Stripe ' + res.statusCode))); return; }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Stripe ne répond pas')));
    req.end(body);
  });
}
const baseUrl = (req) => PUBLIC_URL || ((String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http')) + '://' + req.headers.host);
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
function readBody(req, max) {
  return new Promise((resolve) => {
    let d = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { req.destroy(); resolve(null); return; } d += c; });
    req.on('end', () => { let j = null; try { j = JSON.parse(d || '{}'); } catch (e) {} resolve(j); });
    req.on('error', () => resolve(null));
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(obj));
}
function page(res, title, text, emoji) {
  const back = fs.existsSync(GAME_FILE) ? '<a href="/">Retour au jeu</a>' : '<p class="s">Tu peux fermer cette page et revenir dans Unicorn Run.</p>';
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:linear-gradient(180deg,#3b1f80,#1d1050);color:#fff;text-align:center}' +
    'main{max-width:420px;padding:28px}h1{font-size:30px;margin:10px 0}p{font-size:17px;line-height:1.45}.e{font-size:64px}.s{opacity:.8;font-size:15px}' +
    'a{display:inline-block;margin-top:14px;padding:12px 22px;border-radius:14px;background:linear-gradient(180deg,#ffe985,#f0b400);color:#3a2400;font-weight:800;text-decoration:none}</style></head>' +
    '<body><main><div class="e">' + emoji + '</div><h1>' + title + '</h1><p>' + text + '</p>' + back + '</main></body></html>');
}
async function shopRoute(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400'});
    res.end(); return;
  }
  if (url === '/shop/packs') { sendJson(res, 200, {enabled: !!STRIPE_KEY, test: /^sk_test_/.test(STRIPE_KEY), currency: 'eur', packs: PACKS}); return; }
  if (url === '/shop/merci') { page(res, 'Merci !', 'Ton paiement est bien reçu. Retourne dans le jeu : tes arcs-en-ciel arrivent tout seuls dans quelques secondes.', '🌈'); return; }
  if (url === '/shop/annule') { page(res, 'Paiement annulé', 'Aucun débit n\'a été fait. Tu peux revenir dans le jeu.', '🦄'); return; }
  if (url === '/shop/checkout' && req.method === 'POST') {
    if (!STRIPE_KEY) { sendJson(res, 503, {e: 'off'}); return; }
    if (tooMany(clientIp(req), 12)) { sendJson(res, 429, {e: 'slow'}); return; }
    const b = await readBody(req, 2048), pk = b && PACKS.find((p) => p.id === b.pack);
    if (!pk) { sendJson(res, 400, {e: 'pack'}); return; }
    const base = baseUrl(req), en = b.lang === 'en';
    try {
      const s = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'payment', submit_type: 'pay', locale: en ? 'en' : 'fr',
        line_items: [{quantity: 1, price_data: {currency: 'eur', unit_amount: pk.cents,
          product_data: {name: pk.rainbows.toLocaleString('fr-FR') + (en ? ' rainbows' : ' arcs-en-ciel'), description: 'Unicorn Run'}}}],
        success_url: base + '/shop/merci?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: base + '/shop/annule',
        metadata: {pack: pk.id, rainbows: pk.rainbows},
        payment_intent_data: {metadata: {pack: pk.id, rainbows: pk.rainbows}},
      });
      log('paiement créé', s.id, pk.id);
      sendJson(res, 200, {id: s.id, url: s.url});
    } catch (e) { log('Stripe (création) :', e.message); sendJson(res, 502, {e: 'stripe'}); }
    return;
  }
  if (url === '/shop/claim') {
    if (!STRIPE_KEY) { sendJson(res, 503, {e: 'off'}); return; }
    if (tooMany(clientIp(req) + ':c', 60)) { sendJson(res, 429, {e: 'slow'}); return; }
    const b = req.method === 'POST' ? await readBody(req, 1024) : null;
    const id = String((b && b.id) || new URL(req.url, 'http://x').searchParams.get('id') || '');
    if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) { sendJson(res, 400, {e: 'id'}); return; }
    if (claimed.has(id)) { sendJson(res, 200, {e: 'claimed'}); return; }
    if (claiming.has(id)) { sendJson(res, 200, {pending: true}); return; }
    claiming.add(id);
    try {
      const s = await stripe('GET', '/v1/checkout/sessions/' + id, {expand: ['payment_intent']});
      const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
      const n = parseInt(s.metadata && s.metadata.rainbows, 10) || 0;
      if (s.payment_status !== 'paid' || !pi || !n) { sendJson(res, 200, s.status === 'expired' ? {e: 'expired'} : {pending: true}); return; }
      if (pi.metadata && pi.metadata.claimed === '1') { claimed.add(id); sendJson(res, 200, {e: 'claimed'}); return; }
      await stripe('POST', '/v1/payment_intents/' + pi.id, {metadata: {claimed: '1', claimed_at: new Date().toISOString()}});
      claimed.add(id);
      log('arcs-en-ciel livrés', id, n);
      sendJson(res, 200, {ok: true, rainbows: n, pack: s.metadata.pack});
    } catch (e) { log('Stripe (vérification) :', e.message); sendJson(res, 502, {e: 'stripe'}); }
    finally { claiming.delete(id); }
    return;
  }
  sendJson(res, 404, {e: 'route'});
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url.startsWith('/shop/')) { shopRoute(req, res, url).catch(() => { try { sendJson(res, 500, {e: 'server'}); } catch (e) {} }); return; }
  if (url === '/health') { res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'}); res.end('ok'); return; }
  if ((url === '/' || url === '/index.html' || url === '/platformer.html') && fs.existsSync(GAME_FILE)) {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'});
    fs.createReadStream(GAME_FILE).pipe(res); return;
  }
  res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
  res.end('Serveur Unicorn Run en ligne. Joueurs connectés : ' + clients.size + '\n');
});
server.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {} });

// ---------------------------------------------------------------- WebSocket (protocole RFC 6455, fait main)
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = new Client(socket);
  clients.add(c);
  log('+ joueur', c.id, '(' + clients.size + ' en ligne)');
});

class Client {
  constructor(sock) {
    this.id = nextId++; this.sock = sock; this.buf = Buffer.alloc(0); this.frags = []; this.fragLen = 0;
    this.alive = true; this.miss = 0; this.open = true; this.room = null; this.name = 'Joueur'; this.rate = 0;
    sock.setNoDelay(true);
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => this.gone());
    sock.on('end', () => this.gone());
    sock.on('error', () => this.gone());
  }
  frame(op, payload) {
    if (!this.open) return;
    const n = payload.length; let head;
    if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
    else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    head[0] = 0x80 | op;
    try { this.sock.write(Buffer.concat([head, payload])); } catch (e) { this.gone(); }
  }
  send(obj) { this.frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }
  close(code) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
    this.frame(0x8, p); this.open = false;
    try { this.sock.end(); } catch (e) {}
    setTimeout(() => { try { this.sock.destroy(); } catch (e) {} }, 1000);
    this.gone();
  }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1], fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; if (this.buf.readUInt32BE(2) !== 0) return this.close(1009); len = this.buf.readUInt32BE(6); off = 10; }
      if (len > MAX_MSG) return this.close(1009);
      if (!masked) return this.close(1002);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4), data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this.frame(0xA, data); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x2) { this.frags = [data]; this.fragLen = data.length; }
      else if (op === 0x0) { this.frags.push(data); this.fragLen += data.length; }
      else return this.close(1002);
      if (this.fragLen > MAX_MSG) return this.close(1009);
      if (fin) { const msg = Buffer.concat(this.frags).toString('utf8'); this.frags = []; this.fragLen = 0; this.alive = true; this.onText(msg); }
    }
  }
  onText(txt) {
    if (++this.rate > MAX_RATE) return;
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    handle(this, m);
  }
  gone() {
    if (this.dead) return;
    this.dead = true; this.open = false;
    leaveRoom(this);
    clients.delete(this);
    log('- joueur', this.id, '(' + clients.size + ' en ligne)');
  }
}

// ---------------------------------------------------------------- salons et partie rapide
function genCode() {
  for (let k = 0; k < 50; k++) {
    let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
  return String(crypto.randomInt(100000, 999999));
}
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Joueur';

function pair(r) {
  r.host.room = r; r.guest.room = r;
  r.host.send({t: 'paired', role: 'host', peer: r.guest.name, code: r.code});
  r.guest.send({t: 'paired', role: 'guest', peer: r.host.name, code: r.code});
  log('duel', r.code, ':', r.host.name, 'contre', r.guest.name);
}
function leaveRoom(c) {
  if (quickWait === c) quickWait = null;
  const r = c.room; if (!r) return;
  c.room = null;
  const other = r.host === c ? r.guest : r.host;
  rooms.delete(r.code);
  if (other) { other.room = null; other.send({t: 'peerLeft'}); }
}
function handle(c, m) {
  switch (m.t) {
    case 'hello':
      c.name = cleanName(m.name);
      c.send({t: 'welcome', v: 1, online: clients.size});
      break;
    case 'create': {
      leaveRoom(c);
      const r = {code: genCode(), host: c, guest: null};
      rooms.set(r.code, r); c.room = r;
      c.send({t: 'room', code: r.code});
      break;
    }
    case 'join': {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const r = rooms.get(code);
      if (!r) { c.send({t: 'error', e: 'nocode'}); break; }
      if (r.host === c) { c.send({t: 'error', e: 'self'}); break; }
      if (r.guest) { c.send({t: 'error', e: 'full'}); break; }
      if (c.room) leaveRoom(c);
      if (quickWait === c) quickWait = null;
      r.guest = c; pair(r);
      break;
    }
    case 'quick':
      leaveRoom(c);
      if (quickWait && quickWait !== c && quickWait.open) {
        const r = {code: genCode(), host: quickWait, guest: c};
        rooms.set(r.code, r); quickWait = null; pair(r);
      } else { quickWait = c; c.send({t: 'queued'}); }
      break;
    case 'leave':
      leaveRoom(c);
      break;
    case 'msg': {
      const r = c.room; if (!r || !r.guest) break;
      const other = r.host === c ? r.guest : r.host;
      if (other) other.send({t: 'msg', d: m.d});
      break;
    }
    case 'ping':
      c.send({t: 'pong'});
      break;
  }
}

// ---------------------------------------------------------------- présence : on coupe les connexions mortes
setInterval(() => {
  for (const c of clients) {
    c.rate = 0;
    if (!c.alive) { if (++c.miss >= 3) { try { c.sock.destroy(); } catch (e) {} c.gone(); continue; } } else c.miss = 0;   // ~30 s sans réponse : déconnecté
    c.alive = false;
    c.frame(0x9, Buffer.alloc(0));
  }
}, 10000);

server.listen(PORT, () => {
  log('Serveur Unicorn Run prêt sur le port ' + PORT + (fs.existsSync(GAME_FILE) ? ' (le jeu est servi sur /)' : ''));
  log(STRIPE_KEY ? 'Boutique payante : ouverte (' + (/^sk_test_/.test(STRIPE_KEY) ? 'mode test, aucun vrai débit' : 'paiements réels') + ')' : 'Boutique payante : fermée (pas de STRIPE_SECRET_KEY)');
});
