// Unicorn Run : serveur du jeu, VERSION 2026-11-27 (bouton Prêt en course multi, comptes joueurs, classement en ligne, course multi, duels TCG, boutique)
// -----------------------------------------------------------------------------
// Aucune dépendance : il suffit de Node.js 18 ou plus.
//     node tcg_server.js
// Variables d'environnement (toutes facultatives) :
//   PORT               port d'écoute (les hébergeurs le donnent), sinon 8787
//   STRIPE_SECRET_KEY  clé secrète Stripe (sk_test_… pour essayer, sk_live_… pour de vrai) :
//                      sans elle, la boutique payante reste fermée
//   PUBLIC_URL         adresse publique du serveur (ex. https://mon-jeu.onrender.com), si les
//                      pages de retour après paiement ne trouvent pas la bonne adresse toutes seules
// Si le jeu (platformer.html, game.html ou index.html) est posé à côté de ce fichier, il est aussi
// servi à l'adresse du serveur : il s'y connecte alors tout seul, rien à régler.
// -----------------------------------------------------------------------------
// Duels : le serveur met deux joueurs en relation (salon à code ou partie rapide)
// puis relaie leurs messages ; les règles tournent sur le téléphone de l'hôte.
// Course multi : salons de 2 à 4 joueurs. Le serveur donne le départ (même parcours
// pour tous grâce à une graine commune), relaie les positions et désigne le vainqueur.
// Boutique : le serveur crée la page de paiement Stripe, vérifie auprès de Stripe
// que le paiement est bien passé, et ne crédite chaque paiement qu'une seule fois.
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 8787;
// le jeu posé à côté de ce fichier, quel que soit son nom parmi ceux-ci (garde un seul fichier de jeu dans le dossier)
const GAME_NAMES = ['game.html', 'platformer.html', 'index.html', 'jeu.html', 'unicorn_run.html'];
function gameFile() { for (const n of GAME_NAMES) { const f = path.join(__dirname, n); if (fs.existsSync(f)) return f; } return ''; }
const MAX_MSG = 512 * 1024;            // taille maximale d'un message (octets)
const MAX_RATE = 400;                  // messages maximum par joueur toutes les 10 s
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // sans I ni O (confusion avec 1 et 0)

const clients = new Set();
const rooms = new Map();               // code → {code, host, guest}
const races = new Map();               // code → salon de Course multi
let quickWait = null;                  // joueur en attente d'une partie rapide
let nextId = 1;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- boutique : offres (le serveur fait foi)
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const STRIPE_API = process.env.STRIPE_API || 'https://api.stripe.com';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
// prix TTC en centimes ; le « bonus » affiché est calculé tout seul par rapport à la plus petite offre (arrondi vers le bas)
const PACKS = [
  {id: 'p1', rainbows: 500, cents: 129},     // 1,29 €  : un coffre à chapeaux, ou un paquet de cartes
  {id: 'p2', rainbows: 1200, cents: 249},    // 2,49 €
  {id: 'p3', rainbows: 3500, cents: 599},    // 5,99 €
  {id: 'p4', rainbows: 8000, cents: 1199},   // 11,99 €
];
(function () { const b = PACKS[0].rainbows / PACKS[0].cents; PACKS.forEach((p) => { p.bonus = Math.max(0, Math.floor(((p.rainbows / p.cents) / b - 1) * 20) * 5); }); })();
const euros = (c) => (c / 100).toFixed(2).replace('.', ',') + '\u00a0€';
const nfr = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// ---------------------------------------------------------------- informations légales (fichier infos_vendeur.json)
const SELLER_FILE = path.join(__dirname, 'infos_vendeur.json');
function seller() {
  let j = {}; try { j = JSON.parse(fs.readFileSync(SELLER_FILE, 'utf8')); } catch (e) {}
  const d = (v) => (typeof v === 'string' ? v.trim() : '');
  const o = {nom: d(j.nom), commercial: d(j.nom_commercial), statut: d(j.statut), siret: d(j.siret), immatriculation: d(j.immatriculation), adresse: d(j.adresse), email: d(j.email), telephone: d(j.telephone),
    directeur: d(j.directeur_publication), tva: d(j.tva) || 'TVA non applicable, art. 293 B du CGI', jeu: d(j.nom_du_jeu) || 'Unicorn Run', maj: d(j.date_mise_a_jour) || '',
    med: {nom: d((j.mediateur || {}).nom), adresse: d((j.mediateur || {}).adresse), site: d((j.mediateur || {}).site)},
    heb: {nom: d((j.hebergeur || {}).nom), adresse: d((j.hebergeur || {}).adresse), contact: d((j.hebergeur || {}).contact)}};
  const req = [o.nom, o.statut, o.siret, o.adresse, o.email, o.telephone, o.directeur, o.med.nom, o.med.adresse, o.med.site, o.heb.nom, o.heb.adresse, o.heb.contact];
  o.complete = req.every((v) => v && !/À COMPLÉTER/i.test(v));
  o.affiche = o.commercial && !/À COMPLÉTER/i.test(o.commercial) ? o.commercial + ' (' + o.nom + ')' : o.nom;   // « Neko (Prénom Nom) »
  return o;
}
const LIVE = /^sk_live_/.test(STRIPE_KEY);
const escH = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (m) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[m]));
const fill = (v) => (v && !/À COMPLÉTER/i.test(v) ? escH(v) : '<mark>' + escH(v || 'À COMPLÉTER') + '</mark>');
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
    let d = '', n = 0, big = false;
    // trop gros : on lit jusqu'au bout sans garder (pour pouvoir répondre proprement), et on coupe si ça devient absurde
    req.on('data', (c) => { n += c.length; if (n > max) { big = true; d = ''; if (n > max + 2 * 1024 * 1024) { req.destroy(); resolve(null); } return; } d += c; });
    req.on('end', () => { if (big) { resolve({_big: true}); return; } let j = null; try { j = JSON.parse(d || '{}'); } catch (e) {} resolve(j); });
    req.on('error', () => resolve(null));
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(obj));
}
function page(res, title, text, emoji) {
  const back = gameFile() ? '<a href="/">Retour au jeu</a>' : '<p class="s">Tu peux fermer cette page et revenir dans Unicorn Run.</p>';
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:linear-gradient(180deg,#3b1f80,#1d1050);color:#fff;text-align:center}' +
    'main{max-width:420px;padding:28px}h1{font-size:30px;margin:10px 0}p{font-size:17px;line-height:1.45}.e{font-size:64px}.s{opacity:.8;font-size:15px}' +
    'a{display:inline-block;margin-top:14px;padding:12px 22px;border-radius:14px;background:linear-gradient(180deg,#ffe985,#f0b400);color:#3a2400;font-weight:800;text-decoration:none}</style></head>' +
    '<body><main><div class="e">' + emoji + '</div><h1>' + title + '</h1><p>' + text + '</p>' + back + '</main></body></html>');
}

// ---------------------------------------------------------------- pages légales : mentions légales, CGV, confidentialité
function legalPage(res, title, body) {
  const v = seller();
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'});
  res.end('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escH(title) + ' – ' + escH(v.jeu) + '</title><style>' +
    'body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2a1846;background:#f7f2ff}main{max-width:760px;margin:0 auto;padding:22px 18px 60px}' +
    'h1{font-size:26px;margin:6px 0 4px;color:#4a2384}h2{font-size:19px;margin:26px 0 6px;color:#5b2ea0}p,li{margin:6px 0}small{color:#6b5a85}nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}' +
    'nav a{padding:6px 11px;border-radius:999px;background:#e8dcff;color:#3b1a70;text-decoration:none;font-weight:600;font-size:14px}nav a.on{background:#5b2ea0;color:#fff}' +
    'table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #d9c9f2;padding:6px 8px;text-align:left}th{background:#efe6ff}' +
    'mark{background:#ffe08a;padding:0 3px;border-radius:3px}.box{background:#fff;border:1px solid #e0d2f7;border-radius:12px;padding:12px 14px;margin:10px 0}' +
    '.kid{background:#fff6d6;border-color:#f0d78a}</style></head><body><main><nav>' +
    [['mentions', 'Mentions légales'], ['cgv', 'Conditions de vente'], ['confidentialite', 'Confidentialité']].map(([k, n]) => '<a href="/legal/' + k + '"' + (title === n ? ' class="on"' : '') + '>' + n + '</a>').join('') +
    (gameFile() ? '<a href="/">Retour au jeu</a>' : '') + '</nav><h1>' + escH(title) + '</h1>' + (v.maj ? '<small>Mise à jour : ' + escH(v.maj) + '</small>' : '') + body +
    (v.complete ? '' : '<p class="box kid"><b>Informations à compléter</b> : les passages surlignés doivent être remplis dans le fichier infos_vendeur.json du serveur.</p>') +
    '</main></body></html>');
}
function identite(v) {
  return '<p>' + (v.commercial ? '<b>' + escH(v.commercial) + '</b><br>' + fill(v.nom) : '<b>' + fill(v.nom) + '</b>') + '<br>' + fill(v.statut) + '<br>SIRET : ' + fill(v.siret) + (v.immatriculation ? '<br>' + escH(v.immatriculation) : '') +
    '<br>Adresse : ' + fill(v.adresse) + '<br>E-mail : ' + fill(v.email) + '<br>Téléphone : ' + fill(v.telephone) + '<br>' + escH(v.tva) + '</p>';
}
function mediateur(v) {
  return '<p>Médiateur de la consommation : <b>' + fill(v.med.nom) + '</b><br>Adresse : ' + fill(v.med.adresse) + '<br>Site internet : ' + fill(v.med.site) + '</p>';
}
function pageMentions(res) {
  const v = seller();
  legalPage(res, 'Mentions légales',
    '<h2>Éditeur du jeu et du site</h2>' + identite(v) +
    '<p>Directeur de la publication : ' + fill(v.directeur) + '</p>' +
    '<h2>Hébergeur</h2><p>' + fill(v.heb.nom) + '<br>' + fill(v.heb.adresse) + '<br>' + fill(v.heb.contact) + '</p>' +
    '<h2>Paiements</h2><p>Les paiements sont traités par Stripe Payments Europe, Ltd. (Irlande). L\'éditeur n\'a jamais accès aux numéros de carte.</p>' +
    '<h2>Médiation</h2>' + mediateur(v) +
    '<h2>Propriété intellectuelle</h2><p>Le jeu ' + escH(v.jeu) + ', ses textes, ses dessins, ses musiques et ses personnages sont protégés. Toute reproduction sans autorisation est interdite.</p>' +
    '<p>Voir aussi : <a href="/legal/cgv">conditions générales de vente</a> · <a href="/legal/confidentialite">politique de confidentialité</a>.</p>');
}
function pageCgv(res) {
  const v = seller();
  const rows = PACKS.map((p) => '<tr><td>' + nfr(p.rainbows) + ' arcs-en-ciel' + (p.bonus ? ' (dont environ ' + p.bonus + ' % offerts par rapport à la plus petite offre)' : '') + '</td><td>' + euros(p.cents) + ' TTC</td></tr>').join('');
  legalPage(res, 'Conditions de vente',
    '<div class="box kid"><b>En clair</b> : tu achètes des arcs-en-ciel, la monnaie du jeu, avec de l\'argent réel. Ils arrivent tout de suite dans le jeu, sur l\'appareil utilisé. Comme tu demandes à les recevoir tout de suite, tu ne peux plus annuler l\'achat ensuite pour te faire rembourser. Si tu es mineur, il faut l\'accord d\'un parent. En cas de souci, écris-nous : ' + fill(v.email) + '.</div>' +
    '<h2>1. Objet</h2><p>Les présentes conditions générales de vente (CGV) s\'appliquent à l\'achat, par des consommateurs, d\'« arcs-en-ciel », monnaie virtuelle du jeu ' + escH(v.jeu) + ', vendue par :</p>' + identite(v) +
    '<p>Toute commande suppose l\'acceptation des présentes CGV, que l\'acheteur coche expressément avant de payer. Les CGV applicables sont celles en vigueur à la date de la commande ; elles restent consultables à cette adresse.</p>' +
    '<h2>2. Ce que tu achètes</h2><p>Les arcs-en-ciel sont un contenu numérique fourni sans support matériel. Ils servent uniquement, dans le jeu, à obtenir des objets et avantages virtuels : chapeaux, traînées, pouvoirs, paquets de cartes, mises de jeu, etc. Ils peuvent aussi se gagner gratuitement en jouant.</p>' +
    '<ul><li>Ils n\'ont aucune valeur en dehors du jeu : ils ne sont ni remboursables en argent, ni échangeables, ni revendables, ni transférables à une autre personne.</li>' +
    '<li>Fonctionnement : ils sont crédités dans le jeu ouvert dans le navigateur de l\'appareil utilisé pour l\'achat (smartphone, tablette ou ordinateur récent). Ils sont enregistrés sur cet appareil : effacer les données du navigateur, désinstaller l\'application web ou changer d\'appareil les supprime, comme le reste de la progression. Le jeu n\'a pas de compte en ligne.</li>' +
    '<li>Les objets obtenus avec des arcs-en-ciel peuvent être tirés au hasard (coffre à chapeaux, paquets de cartes). Les probabilités sont indiquées dans le jeu avant l\'achat.</li></ul>' +
    '<h2>3. Prix</h2><p>Les prix sont indiqués en euros toutes taxes comprises (' + escH(v.tva) + ').</p><table><tr><th>Offre</th><th>Prix</th></tr>' + rows + '</table>' +
    '<p>Dans le jeu, le prix en euros de chaque objet est aussi affiché, calculé au tarif de la plus petite offre.</p>' +
    '<h2>4. Commande</h2><ol><li>Dans la boutique du jeu, l\'acheteur choisit une offre.</li><li>Un adulte répond à une question de contrôle.</li>' +
    '<li>Un récapitulatif affiche l\'offre, le prix TTC, le vendeur et des liens vers ces CGV, les mentions légales et la politique de confidentialité.</li>' +
    '<li>L\'acheteur coche son acceptation des CGV, puis sa demande de livraison immédiate avec renonciation au droit de rétractation (article 7).</li>' +
    '<li>Il valide avec le bouton « Commander avec obligation de paiement », puis paie sur la page sécurisée de Stripe.</li></ol>' +
    '<p>Le contrat est conclu quand le paiement est accepté. Une confirmation de la commande est envoyée par e-mail à l\'adresse indiquée lors du paiement. Elle reprend le contenu acheté, le prix et l\'accord exprès donné pour la livraison immédiate.</p>' +
    '<h2>5. Mineurs</h2><p>Un mineur ne peut commander qu\'avec l\'accord de ses parents ou de son représentant légal, qui reste responsable de la commande. Le jeu demande à un adulte de répondre à une question de contrôle avant chaque achat.</p>' +
    '<h2>6. Paiement et livraison</h2><p>Le paiement se fait par carte bancaire, ou par les autres moyens proposés par Stripe, sur une page sécurisée. Le vendeur ne voit jamais les données de carte. Les arcs-en-ciel sont livrés automatiquement dans le jeu dès que le paiement est validé, en général en quelques secondes. Si ce n\'est pas le cas, écris à ' + fill(v.email) + ' en donnant la date et le montant de l\'achat.</p>' +
    '<h2 id="retractation">7. Droit de rétractation</h2><p>En principe, un consommateur dispose de 14 jours pour se rétracter d\'un achat à distance. Pour un contenu numérique fourni sans support matériel, ce droit ne s\'applique pas si les trois conditions suivantes sont réunies (article L.221-28, 13° du Code de la consommation) :</p>' +
    '<ul><li>l\'acheteur a donné son accord préalable et exprès pour que la livraison commence tout de suite, avant la fin du délai de 14 jours ;</li>' +
    '<li>il a reconnu qu\'il perd ainsi son droit de rétractation ;</li>' +
    '<li>le vendeur lui a envoyé une confirmation de cet accord.</li></ul>' +
    '<p>C\'est ce que demandent les cases à cocher avant le paiement, et la confirmation est envoyée par e-mail. Si, par exception, ces conditions n\'étaient pas réunies, l\'acheteur peut se rétracter dans les 14 jours qui suivent la commande, sans donner de raison. Il suffit d\'envoyer une déclaration claire, par exemple avec le formulaire ci-dessous, à ' + fill(v.email) + ' ou à ' + fill(v.adresse) + '. Le remboursement est fait dans les 14 jours, par le même moyen de paiement.</p>' +
    '<h2>8. Garantie légale de conformité</h2><p>Le vendeur répond des défauts de conformité du contenu numérique dans les conditions des articles L.224-25-12 et suivants du Code de la consommation. Pour une fourniture ponctuelle, comme un achat d\'arcs-en-ciel, il répond des défauts qui existent au moment de la fourniture et qui apparaissent dans les deux ans. Les défauts qui apparaissent dans les 12 mois sont présumés exister dès la fourniture (article L.224-25-16).</p>' +
    '<p>En cas de défaut, par exemple des arcs-en-ciel payés mais non crédités, l\'acheteur a droit à la mise en conformité gratuite, c\'est-à-dire au crédit des arcs-en-ciel. À défaut, il a droit à une réduction du prix ou à la résolution du contrat, avec remboursement.</p>' +
    '<h2>9. Réclamations et médiation</h2><p>Pour toute réclamation : ' + fill(v.email) + '. Si le problème n\'est pas réglé après cette réclamation écrite, tu peux saisir gratuitement le médiateur de la consommation (articles L.612-1 et suivants du Code de la consommation) :</p>' + mediateur(v) +
    '<h2>10. Données personnelles</h2><p>Voir la <a href="/legal/confidentialite">politique de confidentialité</a>.</p>' +
    '<h2>11. Droit applicable</h2><p>Les présentes CGV sont soumises au droit français. En cas de litige, l\'acheteur peut saisir la juridiction de son domicile ou celle du lieu où le dommage est survenu.</p>' +
    '<h2>Annexe : formulaire de rétractation</h2><div class="box"><p>(Complétez et renvoyez le présent formulaire uniquement si vous souhaitez vous rétracter du contrat.)</p>' +
    '<p>À l\'attention de ' + fill(v.nom) + ', ' + fill(v.adresse) + ', ' + fill(v.email) + ' :</p>' +
    '<p>Je/Nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la fourniture du contenu numérique ci-dessous :<br>' +
    'Commandé le (*)/reçu le (*) :<br>Nom du (des) consommateur(s) :<br>Adresse du (des) consommateur(s) :<br>Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) :<br>Date :</p><p>(*) Rayez la mention inutile.</p></div>');
}
function pageConfidentialite(res) {
  const v = seller();
  legalPage(res, 'Confidentialité',
    '<div class="box kid"><b>En clair</b> : sans compte, ta partie reste sur ton appareil. Avec un compte (à partir de 15 ans), on garde ton pseudo, ta date de naissance, ton mot de passe chiffré et ta progression pour que tu la retrouves sur tous tes appareils. Pendant une partie en ligne, ton pseudo et tes coups passent par notre serveur, sans être gardés. Pour un achat, c\'est Stripe qui s\'occupe du paiement et de ton e-mail. Pas de publicité, pas de pistage.</div>' +
    '<h2>Responsable du traitement</h2>' + identite(v) +
    '<h2>Données sur ton appareil</h2><p>Ta progression, ton pseudo, tes arcs-en-ciel, ta collection et tes réglages sont enregistrés uniquement dans le stockage local du navigateur de ton appareil. Ils ne nous sont pas envoyés. Ce stockage est strictement nécessaire au fonctionnement du jeu ; il ne demande donc pas de consentement. Le jeu n\'utilise ni cookie publicitaire, ni outil de mesure d\'audience, ni pistage.</p>' +
    '<h2>Compte joueur</h2><p>Le compte est facultatif et réservé aux personnes de 15 ans et plus. Il contient ton pseudo (unique), ta date de naissance, ton mot de passe (enregistré sous une forme chiffrée qu\'on ne peut pas relire) et une copie de ta progression. La date de naissance sert uniquement à vérifier l\'âge minimum de 15 ans et à réserver le casino aux 18 ans et plus. Base légale : l\'exécution du service que tu demandes en créant le compte. Ces données sont conservées jusqu\'à ce que tu supprimes ton compte (Paramètres → Compte → Supprimer mon compte), et effacées automatiquement après 3 ans sans connexion. Elles sont stockées chez notre hébergeur et chez Upstash, Inc. (base de données).</p>' +
    '<h2>Joueurs en ligne</h2><p>Pour afficher le nombre de joueurs connectés, chaque page du jeu ouverte envoie un identifiant tiré au hasard, sans lien avec toi. Il est oublié au bout d\'une minute.</p>' +
    '<h2>Duel en ligne</h2><p>Quand tu joues un duel, ton pseudo, ton niveau, ton deck et tes actions de jeu sont transmis à ton adversaire par notre serveur. Ils ne sont pas conservés après la partie. Ton adresse IP est utilisée le temps de la connexion pour faire marcher le service et limiter les abus. L\'hébergeur peut garder des journaux techniques pendant une durée limitée. Base légale : l\'exécution du service que tu demandes.</p>' +
    '<h2>Achats</h2><p>Le paiement est géré par Stripe Payments Europe, Ltd. Stripe recueille ton adresse e-mail et tes données de paiement, et les traite selon sa propre politique de confidentialité (stripe.com/fr/privacy). Nous recevons l\'identifiant du paiement, la date, le montant, l\'offre achetée et l\'adresse e-mail indiquée.</p>' +
    '<p>Bases légales : l\'exécution du contrat, puis nos obligations comptables. Les pièces comptables sont conservées 10 ans, comme la loi l\'exige.</p>' +
    '<h2>Destinataires et transferts</h2><p>Seuls l\'éditeur et ses prestataires techniques ont accès à ces données : l\'hébergeur (' + fill(v.heb.nom) + '), Upstash (comptes joueurs) et Stripe. Si un prestataire traite des données hors de l\'Union européenne, ce transfert est encadré par les garanties prévues par le RGPD, par exemple des clauses contractuelles types ou une décision d\'adéquation.</p>' +
    '<h2>Tes droits</h2><p>Tu peux demander l\'accès à tes données, leur rectification ou leur effacement, ou t\'opposer à leur traitement. Tu peux aussi demander la limitation du traitement ou la portabilité de tes données. Écris à ' + fill(v.email) + '. Si tu n\'es pas satisfait de la réponse, tu peux saisir la CNIL (cnil.fr).</p>' +
    '<h2>Enfants</h2><p>Le jeu peut être utilisé par des enfants sans compte : rien n\'est alors envoyé, la partie reste sur l\'appareil. Le compte n\'est pas ouvert aux moins de 15 ans. Le casino est réservé aux 18 ans et plus. Les achats nécessitent un adulte.</p>');
}
async function shopRoute(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400'});
    res.end(); return;
  }
  if (url === '/shop/packs') {
    const v = seller(), open = !!STRIPE_KEY && (!LIVE || v.complete);
    sendJson(res, 200, {enabled: open, test: /^sk_test_/.test(STRIPE_KEY), reason: STRIPE_KEY && !open ? 'legal' : '', currency: 'eur', packs: PACKS,
      legal: {complete: v.complete, seller: v.complete ? v.affiche : '', vat: v.tva, email: v.complete ? v.email : '', cgv: '/legal/cgv', mentions: '/legal/mentions', privacy: '/legal/confidentialite', version: v.maj}});
    return;
  }
  if (url === '/shop/merci') { page(res, 'Merci !', 'Ton paiement est bien reçu. Retourne dans le jeu : tes arcs-en-ciel arrivent tout seuls dans quelques secondes. La confirmation de ta commande t\'est envoyée par e-mail.', '🌈'); return; }
  if (url === '/shop/annule') { page(res, 'Paiement annulé', 'Aucun débit n\'a été fait. Tu peux revenir dans le jeu.', '🦄'); return; }
  if (url === '/shop/checkout' && req.method === 'POST') {
    if (!STRIPE_KEY) { sendJson(res, 503, {e: 'off'}); return; }
    const v = seller();
    if (LIVE && !v.complete) { sendJson(res, 503, {e: 'legal'}); return; }
    if (tooMany(clientIp(req), 12)) { sendJson(res, 429, {e: 'slow'}); return; }
    const b = await readBody(req, 2048), pk = b && PACKS.find((p) => p.id === b.pack);
    if (!pk) { sendJson(res, 400, {e: 'pack'}); return; }
    // accord exprès obligatoire : CGV acceptées + livraison immédiate demandée avec renonciation au droit de rétractation
    if (!(b.consent && b.consent.cgv === true && b.consent.waiver === true)) { sendJson(res, 400, {e: 'consent'}); return; }
    const base = baseUrl(req), en = b.lang === 'en', at = new Date().toISOString();
    const confirm = nfr(pk.rainbows) + ' arcs-en-ciel (monnaie virtuelle du jeu ' + v.jeu + ') – ' + euros(pk.cents) + ' TTC (' + v.tva + '). ' +
      'Le client a accepté les conditions générales de vente (version du ' + (v.maj || at.slice(0, 10)) + ') et a demandé expressément la livraison immédiate des arcs-en-ciel, en reconnaissant perdre son droit de rétractation (art. L.221-28 13° du Code de la consommation). ' +
      'Vendeur : ' + (v.complete ? v.affiche + ', ' + v.adresse + ', ' + v.email : 'informations vendeur à compléter') + '. CGV : ' + base + '/legal/cgv';
    try {
      const s = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'payment', submit_type: 'pay', locale: en ? 'en' : 'fr',
        line_items: [{quantity: 1, price_data: {currency: 'eur', unit_amount: pk.cents,
          product_data: {name: pk.rainbows.toLocaleString('fr-FR') + (en ? ' rainbows' : ' arcs-en-ciel'), description: 'Unicorn Run'}}}],
        success_url: base + '/shop/merci?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: base + '/shop/annule',
        metadata: {pack: pk.id, rainbows: pk.rainbows, consent_cgv: '1', consent_waiver: '1', consent_at: at, cgv_version: v.maj || ''},
        // la description apparaît sur le reçu envoyé par e-mail : c'est la confirmation de l'accord exprès sur support durable
        payment_intent_data: {description: confirm.slice(0, 1000), metadata: {pack: pk.id, rainbows: pk.rainbows, consent_waiver: '1', consent_at: at}},
        custom_text: {submit: {message: en
          ? 'By paying, you accept the [terms of sale](' + base + '/legal/cgv) and ask for your rainbows to be delivered right away: you then lose your 14-day right of withdrawal.'
          : 'En payant, tu acceptes les [conditions de vente](' + base + '/legal/cgv) et tu demandes la livraison immédiate de tes arcs-en-ciel : tu perds alors ton droit de rétractation de 14 jours.'}},
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

// ---------------------------------------------------------------- extraits vidéo de l'écran « Jouer »
// Ils sont rangés dans platformer.html ; on les sert aussi comme de vrais fichiers .mp4 (avec lecture par morceaux),
// ce que le lecteur vidéo des iPhone accepte toujours, même quand il refuse une vidéo rangée dans la page.
let clipCache = {mtime: -1, map: new Map()};
function clips() {
  try {
    const gf = gameFile(), st = fs.statSync(gf);
    if (st.mtimeMs + gf !== clipCache.mtime) {
      const txt = fs.readFileSync(gf, 'utf8'), map = new Map(), re = /<script type="text\/plain" id="(mvm-[a-z]+-[LP])">([\s\S]*?)<\/script>/g;
      let m; while ((m = re.exec(txt))) map.set(m[1], Buffer.from(m[2].trim(), 'base64'));
      clipCache = {mtime: st.mtimeMs + gf, map: map};
    }
  } catch (e) {}
  return clipCache.map;
}
function sendClip(req, res, name) {
  const buf = clips().get(name);
  if (!buf) { res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'}); res.end('introuvable'); return; }
  const head = {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600'};
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (r && (r[1] || r[2])) {
    let a = r[1] ? parseInt(r[1], 10) : buf.length - parseInt(r[2], 10), b = r[1] && r[2] ? parseInt(r[2], 10) : buf.length - 1;
    a = Math.max(0, a); b = Math.min(buf.length - 1, b);
    if (a > b) { res.writeHead(416, {'Content-Range': 'bytes */' + buf.length}); res.end(); return; }
    res.writeHead(206, Object.assign(head, {'Content-Range': 'bytes ' + a + '-' + b + '/' + buf.length, 'Content-Length': b - a + 1}));
    res.end(req.method === 'HEAD' ? undefined : buf.subarray(a, b + 1)); return;
  }
  res.writeHead(200, Object.assign(head, {'Content-Length': buf.length}));
  res.end(req.method === 'HEAD' ? undefined : buf);
}

// ---------------------------------------------------------------- comptes joueurs
// Un pseudo = un seul compte (pseudo unique) ; la progression du compte suit le joueur sur tous ses appareils.
// Compte réservé aux 15 ans et plus (majorité numérique en France) ; la date de naissance sert aussi à réserver le casino aux 18 ans et plus.
// Stockage : base Upstash Redis (gratuite, en HTTPS) si UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN sont réglés.
// Sinon : fichier data/comptes.json, pratique à la maison mais EFFACÉ à chaque redémarrage sur Render gratuit.
// valeurs collées avec des guillemets, des espaces ou « NOM=… » devant : on nettoie
const envClean = (v) => String(v || '').trim().replace(/^[A-Z_]+\s*=\s*/, '').replace(/^["'`]+|["'`;]+$/g, '').trim();
let KV_URL = envClean(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, ''), KV_TOKEN = envClean(process.env.UPSTASH_REDIS_REST_TOKEN);
let KV_PROBLEM = '';
if (KV_URL && /^rediss?:\/\//i.test(KV_URL)) KV_PROBLEM = 'UPSTASH_REDIS_REST_URL contient l\'adresse « rediss://… » : il faut celle de la partie REST, qui commence par https://';
else if (KV_URL && !/^https?:\/\//i.test(KV_URL)) KV_URL = 'https://' + KV_URL;
if (!KV_PROBLEM && (KV_URL ? !KV_TOKEN : !!KV_TOKEN)) KV_PROBLEM = 'il manque ' + (KV_URL ? 'UPSTASH_REDIS_REST_TOKEN' : 'UPSTASH_REDIS_REST_URL');
const SERVER_VERSION = '2026-11-27';
const KV_ON = !!(KV_URL && KV_TOKEN && !/^rediss?:/i.test(KV_URL)), DATA_FILE = path.join(__dirname, 'data', 'comptes.json');
const MIN_AGE = 15, ADULT_AGE = 18, SAVE_MAX = 450 * 1024, TOKEN_TTL = 365 * 86400, KEEP_TTL = 3 * 365 * 86400;   // compte sans connexion pendant 3 ans : effacé
async function upstash(args) {
  const r = await fetch(KV_URL, {method: 'POST', headers: {Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json'}, body: JSON.stringify(args), signal: AbortSignal.timeout(8000)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('base de comptes : ' + (j.error || ('HTTP ' + r.status)));
  return j.result;
}
// au démarrage : on vérifie que la base Upstash accepte bien de lire et d'écrire, et on dit clairement ce qui ne va pas
async function kvSelfTest() {
  if (!KV_ON) return;
  try {
    await upstash(['SET', 'diag:ping', String(Date.now()), 'EX', '120']);
    await upstash(['GET', 'diag:ping']);
    KV_PROBLEM = '';
    log('Comptes joueurs : base Upstash vérifiée (lecture et écriture OK)');
  } catch (e) {
    const m = String(e && e.message || e);
    KV_PROBLEM = /WRONGPASS|invalid or missing auth|Unauthorized|HTTP 401/i.test(m) ? 'Upstash refuse le jeton : recopie UPSTASH_REDIS_REST_TOKEN (le jeton principal, pas celui « read-only »)'
      : /NOPERM|no permissions/i.test(m) ? 'c\'est le jeton « read-only » : prends le jeton principal UPSTASH_REDIS_REST_TOKEN'
      : /fetch failed|ENOTFOUND|EAI_AGAIN|Invalid URL|abort|timeout/i.test(m) ? 'impossible de joindre Upstash : vérifie UPSTASH_REDIS_REST_URL (https://…upstash.io)'
      : m;
    log('⚠ Comptes joueurs : la base Upstash ne marche pas : ' + KV_PROBLEM + ' (' + m + ')');
  }
}
const fileKv = {map: null, t: 0};
function fileLoad() { if (fileKv.map) return; try { fileKv.map = new Map(Object.entries(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')))); } catch (e) { fileKv.map = new Map(); } }
function fileFlush() {
  try { fs.mkdirSync(path.dirname(DATA_FILE), {recursive: true}); fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(Object.fromEntries(fileKv.map))); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
  catch (e) { log('⚠ comptes : écriture impossible :', e.message); }
}
const fileSave = () => { clearTimeout(fileKv.t); fileKv.t = setTimeout(fileFlush, 400); };
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => {
  try { lbFlushAll(); } catch (e) {}
  setTimeout(() => { if (fileKv.t) { clearTimeout(fileKv.t); fileFlush(); } process.exit(0); }, KV_ON ? 1500 : 0);   // laisse partir les dernières écritures du classement
}));
const kv = {
  async get(k) {
    if (KV_ON) return upstash(['GET', k]);
    fileLoad(); const e = fileKv.map.get(k); if (!e) return null;
    if (e.x && e.x < Date.now()) { fileKv.map.delete(k); return null; }
    return e.v;
  },
  async set(k, v, o) {   // o : {nx: ne pas écraser, ex: durée de vie en secondes}
    if (KV_ON) { const a = ['SET', k, v]; if (o && o.nx) a.push('NX'); if (o && o.ex) a.push('EX', String(o.ex)); return (await upstash(a)) === 'OK'; }
    if (o && o.nx && (await kv.get(k)) !== null) return false;
    fileKv.map.set(k, {v: v, x: o && o.ex ? Date.now() + o.ex * 1000 : 0}); fileSave(); return true;
  },
  async del(k) { if (KV_ON) { await upstash(['DEL', k]); return; } fileLoad(); fileKv.map.delete(k); fileSave(); },
  async expire(k, sec) { if (KV_ON) { await upstash(['EXPIRE', k, String(sec)]); return; } fileLoad(); const e = fileKv.map.get(k); if (e) { e.x = Date.now() + sec * 1000; fileSave(); } },
};
const pkeyOf = (p) => String(p || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const RESERVED = new Set(['admin', 'administrateur', 'moderateur', 'modo', 'invite', 'guest', 'joueur', 'licorne', 'unicorn', 'unicornrun', 'support', 'staff', 'systeme', 'system', 'serveur']);
function pseudoCheck(raw) {
  const p = String(raw || '').replace(/\s+/g, ' ').trim();
  if (p.length < 3 || p.length > 14) return {e: 'len'};
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(p)) return {e: 'chars'};
  const k = pkeyOf(p);
  if (k.length < 3) return {e: 'len'};
  if (RESERVED.has(k) || /^(invite|guest)\d*$/.test(k)) return {e: 'reserved'};
  return {p: p, k: k};
}
function ageOf(birth) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birth || '')); if (!m) return -1;
  const y = +m[1], mo = +m[2], d = +m[3], dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return -1;
  const now = new Date(Date.now() + 3600e3);   // heure de Paris, à peu près
  let a = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) a--;
  return a > 120 ? -1 : a;
}
const scryptP = (pass, salt) => new Promise((ok, ko) => crypto.scrypt(String(pass), salt, 32, {N: 16384, r: 8, p: 1}, (e, k) => (e ? ko(e) : ok(k))));
const accCache = new Map(), metaCache = new Map(), tokCache = new Map();
const capMap = (m, n) => { if (m.size > n) m.delete(m.keys().next().value); };
async function accGet(k) {
  if (accCache.has(k)) return accCache.get(k);
  const raw = await kv.get('acc:' + k); let a = null; try { a = raw ? JSON.parse(raw) : null; } catch (e) {}
  if (a) { accCache.set(k, a); capMap(accCache, 2000); }
  return a;
}
async function metaGet(k) {   // révision et date de la dernière sauvegarde (sans relire toute la sauvegarde)
  if (metaCache.has(k)) return metaCache.get(k);
  const raw = await kv.get('save:' + k); let m = {rev: 0, at: 0};
  try { if (raw) { const j = JSON.parse(raw); m = {rev: j.rev | 0, at: +j.at || 0}; } } catch (e) {}
  metaCache.set(k, m); capMap(metaCache, 2000);
  return m;
}
async function tokAcc(t) {
  if (typeof t !== 'string' || !/^[a-f0-9]{48}$/.test(t)) return null;
  let k = tokCache.get(t);
  if (k === undefined) { k = await kv.get('tok:' + t); tokCache.set(t, k || null); capMap(tokCache, 4000); }
  if (!k) return null;
  const a = await accGet(k);
  if (!a) { tokCache.set(t, null); return null; }
  return a;
}
async function tokNew(k) { const t = crypto.randomBytes(24).toString('hex'); await kv.set('tok:' + t, k, {ex: TOKEN_TTL}); tokCache.set(t, k); return t; }
const accOut = (a, m) => ({pseudo: a.p, birth: a.b, adult: ageOf(a.b) >= ADULT_AGE, rev: m.rev, at: m.at});
// trop d'essais de mot de passe ratés : pause de 15 minutes
const accFails = new Map();
const accFailKey = (req, k) => clientIp(req) + '|' + k;
const accTooMany = (req, k) => { const f = accFails.get(accFailKey(req, k)); return !!(f && f.n >= 8 && Date.now() - f.t < 15 * 60e3); };
const accFailed = (req, k) => { const key = accFailKey(req, k), f = accFails.get(key); accFails.set(key, f && Date.now() - f.t < 15 * 60e3 ? {n: f.n + 1, t: f.t} : {n: 1, t: Date.now()}); capMap(accFails, 5000); };
function saveSize(save) { try { return JSON.stringify(save || {}).length; } catch (e) { return Infinity; } }
async function accountRoute(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400'});
    res.end(); return;
  }
  if (req.method !== 'POST') { sendJson(res, 405, {e: 'method'}); return; }
  const b = await readBody(req, url === '/account/save' || url === '/account/register' ? SAVE_MAX + 4096 : 4096);
  if (!b) { sendJson(res, 400, {e: 'body'}); return; }
  if (b._big) { sendJson(res, 413, {e: 'big'}); return; }
  switch (url) {
    case '/account/check': {
      const c = pseudoCheck(b.pseudo); if (c.e) { sendJson(res, 200, {ok: true, free: false, e: c.e}); return; }
      sendJson(res, 200, {ok: true, free: !(await accGet(c.k))}); return;
    }
    case '/account/register': {
      const c = pseudoCheck(b.pseudo); if (c.e) { sendJson(res, 200, {e: c.e}); return; }
      const age = ageOf(b.birth);
      if (age < 0) { sendJson(res, 200, {e: 'birth'}); return; }
      if (age < MIN_AGE) { sendJson(res, 200, {e: 'age'}); return; }
      const pass = String(b.pass || '');
      if (pass.length < 6 || pass.length > 72) { sendJson(res, 200, {e: 'pass'}); return; }
      if (saveSize(b.save) > SAVE_MAX) { sendJson(res, 200, {e: 'big'}); return; }
      const salt = crypto.randomBytes(16), h = await scryptP(pass, salt);
      const a = {p: c.p, k: c.k, h: h.toString('hex'), s: salt.toString('hex'), b: b.birth, c: Date.now()};
      if (!(await kv.set('acc:' + c.k, JSON.stringify(a), {nx: true, ex: KEEP_TTL}))) { sendJson(res, 200, {e: 'taken'}); return; }
      accCache.set(c.k, a);
      const m = {rev: 1, at: Date.now()};
      await kv.set('save:' + c.k, JSON.stringify({rev: m.rev, at: m.at, data: b.save && typeof b.save === 'object' ? b.save : {}}), {ex: KEEP_TTL});
      metaCache.set(c.k, m);
      log('compte créé :', c.p);
      sendJson(res, 200, Object.assign({ok: true, token: await tokNew(c.k)}, accOut(a, m))); return;
    }
    case '/account/login': {
      const k = pkeyOf(b.pseudo);
      if (accTooMany(req, k)) { sendJson(res, 200, {e: 'wait'}); return; }
      const a = k && (await accGet(k));
      const ok = a && crypto.timingSafeEqual(await scryptP(String(b.pass || ''), Buffer.from(a.s, 'hex')), Buffer.from(a.h, 'hex'));
      if (!ok) { accFailed(req, k); sendJson(res, 200, {e: 'login'}); return; }
      const raw = await kv.get('save:' + k); let sv = {rev: 0, at: 0, data: {}}; try { if (raw) sv = JSON.parse(raw); } catch (e) {}
      metaCache.set(k, {rev: sv.rev | 0, at: +sv.at || 0});
      await kv.expire('acc:' + k, KEEP_TTL); await kv.expire('save:' + k, KEEP_TTL);   // on repart pour 3 ans
      sendJson(res, 200, Object.assign({ok: true, token: await tokNew(k), save: sv.data || {}}, accOut(a, metaCache.get(k)))); return;
    }
  }
  const a = await tokAcc(b.token);
  if (!a) { sendJson(res, 200, {e: 'auth'}); return; }
  switch (url) {
    case '/account/me': sendJson(res, 200, Object.assign({ok: true}, accOut(a, await metaGet(a.k)))); return;
    case '/account/load': {
      const raw = await kv.get('save:' + a.k); let sv = {rev: 0, at: 0, data: {}}; try { if (raw) sv = JSON.parse(raw); } catch (e) {}
      metaCache.set(a.k, {rev: sv.rev | 0, at: +sv.at || 0});
      sendJson(res, 200, {ok: true, rev: sv.rev | 0, at: +sv.at || 0, save: sv.data || {}}); return;
    }
    case '/account/save': {
      if (!b.save || typeof b.save !== 'object') { sendJson(res, 400, {e: 'body'}); return; }
      if (saveSize(b.save) > SAVE_MAX) { sendJson(res, 200, {e: 'big'}); return; }
      const m = await metaGet(a.k);
      // un autre appareil a sauvegardé entre-temps : le jeu choisit (la partie la plus récente gagne)
      if (!b.force && (b.base | 0) !== m.rev) { sendJson(res, 200, {e: 'conflict', rev: m.rev, at: m.at}); return; }
      const n = {rev: m.rev + 1, at: Math.min(Date.now(), +b.at || Date.now())};
      await kv.set('save:' + a.k, JSON.stringify({rev: n.rev, at: n.at, data: b.save}), {ex: KEEP_TTL});
      if (n.rev % 50 === 2) kv.expire('acc:' + a.k, KEEP_TTL).catch(() => {});
      metaCache.set(a.k, n);
      sendJson(res, 200, {ok: true, rev: n.rev, at: n.at}); return;
    }
    case '/account/logout': await kv.del('tok:' + b.token); tokCache.delete(b.token); sendJson(res, 200, {ok: true}); return;
    case '/account/delete': {
      if (accTooMany(req, a.k)) { sendJson(res, 200, {e: 'wait'}); return; }
      const ok = crypto.timingSafeEqual(await scryptP(String(b.pass || ''), Buffer.from(a.s, 'hex')), Buffer.from(a.h, 'hex'));
      if (!ok) { accFailed(req, a.k); sendJson(res, 200, {e: 'login'}); return; }
      await kv.del('acc:' + a.k); await kv.del('save:' + a.k); await kv.del('tok:' + b.token);
      accCache.delete(a.k); metaCache.delete(a.k); tokCache.delete(b.token);
      log('compte supprimé :', a.p);
      sendJson(res, 200, {ok: true}); return;
    }
  }
  sendJson(res, 404, {e: 'route'});
}

// ---------------------------------------------------------------- classement en ligne de l'aventure
// Deux classements : la semaine (remis à zéro le lundi à minuit, heure de Paris) et le général (meilleur niveau de tous les temps).
// Seuls les comptes y figurent (pseudos uniques). Le top 3 de la semaine passée réclame sa récompense une seule fois.
const LB_KEEP = 100, LB_SHOW = 20, LB_REWARDS = [2000, 1000, 500], LB_MAXLVL = 500;
function parisParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  const o = {}; for (const x of f.formatToParts(new Date(ms))) o[x.type] = +x.value || 0;
  return o;   // year, month, day, hour, minute, second
}
const parisOffset = (ms) => { const o = parisParts(ms); return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) - Math.floor(ms / 1000) * 1000; };
function weekInfo(ms) {
  const o = parisParts(ms), d = new Date(Date.UTC(o.year, o.month - 1, o.day)), dow = (d.getUTCDay() + 6) % 7;   // lundi = 0
  const t = new Date(d); t.setUTCDate(t.getUTCDate() - dow + 3);   // jeudi de la semaine (semaine ISO)
  const y = t.getUTCFullYear(), w = 1 + Math.round((t - Date.UTC(y, 0, 4)) / 604800000 - 3 / 7 + ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7) / 7);
  const endLocal = Date.UTC(o.year, o.month - 1, o.day - dow + 7);   // lundi suivant 00:00, heure de Paris
  let end = endLocal - parisOffset(endLocal); end = endLocal - parisOffset(end);
  return {id: y + '-W' + String(w).padStart(2, '0'), end: end};
}
const lbBoards = new Map(), lbDirty = new Map();
async function lbGet(key) {
  if (lbBoards.has(key)) return lbBoards.get(key);
  let b = []; try { const raw = await kv.get(key); if (raw) b = JSON.parse(raw).e || []; } catch (e) {}
  lbBoards.set(key, b); capMap(lbBoards, 20);
  return b;
}
function lbSave(key, ttl) {   // écriture groupée : au plus une toutes les 10 s par classement
  if (lbDirty.has(key)) return;
  lbDirty.set(key, setTimeout(() => { lbDirty.delete(key); const b = lbBoards.get(key); if (b) kv.set(key, JSON.stringify({e: b}), ttl ? {ex: ttl} : null).catch((e) => log('⚠ classement :', e.message)); }, 10000));
}
function lbFlushAll() { for (const [key, t] of lbDirty) { clearTimeout(t); const b = lbBoards.get(key); if (b) kv.set(key, JSON.stringify({e: b}), key.startsWith('lb:w:') ? {ex: 40 * 86400} : null).catch(() => {}); } lbDirty.clear(); }
function lbPut(board, a, level) {   // garde le meilleur niveau ; à égalité, le premier arrivé passe devant
  let e = board.find((x) => x.k === a.k);
  if (e && e.l >= level) { e.p = a.p; return false; }
  if (!e) { e = {k: a.k, p: a.p, l: 0, t: 0}; board.push(e); }
  e.l = level; e.t = Date.now(); e.p = a.p;
  board.sort((x, y) => y.l - x.l || x.t - y.t);
  if (board.length > LB_KEEP) board.length = LB_KEEP;
  return true;
}
const lbTop = (b, n) => b.slice(0, n).map((e) => ({p: e.p, l: e.l}));
const lbMe = (b, k) => { const i = b.findIndex((e) => e.k === k); return i < 0 ? null : {rank: i + 1, l: b[i].l}; };
async function lbRoute(req, res, url) {
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'}); res.end(); return; }
  const b = req.method === 'POST' ? await readBody(req, 4096) : {};
  if (!b || b._big) { sendJson(res, 400, {e: 'body'}); return; }
  const now = Date.now(), W = weekInfo(now), wkey = 'lb:w:' + W.id;
  const a = b.token ? await tokAcc(b.token) : null;
  if (url === '/lb/view') {
    const all = await lbGet('lb:all'), week = await lbGet(wkey);
    const prev = weekInfo(W.end - 8 * 86400e3), pw = await lbGet('lb:w:' + prev.id);
    sendJson(res, 200, {ok: true, now: now, week: {id: W.id, end: W.end, top: lbTop(week, LB_SHOW), n: week.length}, all: {top: lbTop(all, LB_SHOW), n: all.length},
      last: lbTop(pw, 3), rewards: LB_REWARDS, me: a ? {pseudo: a.p, week: lbMe(week, a.k), all: lbMe(all, a.k)} : null});
    return;
  }
  if (!a) { sendJson(res, 200, {e: 'auth'}); return; }
  if (url === '/lb/submit') {
    const level = Math.floor(Number(b.level));
    if (!(level >= 1 && level <= LB_MAXLVL)) { sendJson(res, 400, {e: 'level'}); return; }
    const all = await lbGet('lb:all'); if (lbPut(all, a, level)) lbSave('lb:all');
    if (!b.old) { const week = await lbGet(wkey); if (lbPut(week, a, level)) lbSave(wkey, 40 * 86400); }   // « old » : record d'avant le compte, ne compte pas pour la semaine
    sendJson(res, 200, {ok: true, week: lbMe(await lbGet(wkey), a.k), all: lbMe(all, a.k)});
    return;
  }
  if (url === '/lb/reward') {
    const prev = weekInfo(W.end - 8 * 86400e3), pw = await lbGet('lb:w:' + prev.id), i = pw.findIndex((e) => e.k === a.k);
    if (i < 0 || i > 2 || !(pw[i].l > 0)) { sendJson(res, 200, {ok: true, none: true}); return; }
    if (!(await kv.set('lbr:' + prev.id + ':' + a.k, '1', {nx: true, ex: 40 * 86400}))) { sendJson(res, 200, {ok: true, none: true, claimed: true}); return; }
    log('récompense de la semaine', prev.id, ':', a.p, (i + 1) + 'e');
    sendJson(res, 200, {ok: true, rank: i + 1, amount: LB_REWARDS[i], week: prev.id});
    return;
  }
  sendJson(res, 404, {e: 'route'});
}

// ---------------------------------------------------------------- joueurs en ligne (compteur affiché dans le jeu)
// Chaque page du jeu ouverte signale sa présence toutes les ~25 s ; on compte celles vues dans la dernière minute.
const presence = new Map();
function presenceCount() { const lim = Date.now() - 60e3; for (const [id, t] of presence) if (t < lim) presence.delete(id); return presence.size; }
function presenceRoute(req, res, url) {
  const q = new URL(req.url, 'http://x').searchParams, id = String(q.get('id') || '').slice(0, 40);
  if (/^[A-Za-z0-9_-]{8,40}$/.test(id)) { if (q.get('bye') === '1') presence.delete(id); else if (presence.has(id) || presence.size < 100000) presence.set(id, Date.now()); }
  sendJson(res, 200, {online: Math.max(1, presenceCount())});
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const clip = /^\/clips\/(mvm-[a-z]+-[LP])\.mp4$/.exec(url);
  if (clip) { sendClip(req, res, clip[1]); return; }
  if (url.startsWith('/shop/')) { shopRoute(req, res, url).catch(() => { try { sendJson(res, 500, {e: 'server'}); } catch (e) {} }); return; }
  if (url.startsWith('/account/')) { accountRoute(req, res, url).catch((e) => { log('⚠ comptes :', e.message); if (KV_ON) kvSelfTest().catch(() => {}); try { sendJson(res, 503, {e: 'store', why: KV_PROBLEM || String(e.message || '')}); } catch (x) {} }); return; }
  if (url === '/presence') { presenceRoute(req, res, url); return; }
  if (url.startsWith('/lb/')) { lbRoute(req, res, url).catch((e) => { log('⚠ classement :', e.message); try { sendJson(res, 503, {e: 'store'}); } catch (x) {} }); return; }
  if (url === '/legal/mentions') { pageMentions(res); return; }
  if (url === '/legal/cgv') { pageCgv(res); return; }
  if (url === '/legal/confidentialite') { pageConfidentialite(res); return; }
  if (url === '/health') {   // « ok » + version : permet de vérifier que le bon fichier tourne
    res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'});
    res.end('ok · version ' + SERVER_VERSION + ' · comptes : ' + (KV_PROBLEM ? 'PROBLÈME : ' + KV_PROBLEM : KV_ON ? 'base Upstash OK' : 'fichier local (à remplacer par Upstash)')); return;
  }
  const gf = (url === '/' || GAME_NAMES.indexOf(url.slice(1)) >= 0) ? gameFile() : '';
  if (gf) {
    let st = null; try { st = fs.statSync(gf); } catch (e) {}
    const tag = st ? '"' + st.size.toString(36) + '-' + Math.round(st.mtimeMs).toString(36) + '"' : '';
    if (tag && req.headers['if-none-match'] === tag) { res.writeHead(304, {ETag: tag, 'Cache-Control': 'no-cache'}); res.end(); return; }
    res.writeHead(200, Object.assign({'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'}, tag ? {ETag: tag} : {}));
    fs.createReadStream(gf).pipe(res); return;
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
    this.alive = true; this.miss = 0; this.open = true; this.room = null; this.race = null; this.rready = false; this.name = 'Joueur'; this.rate = 0;
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
    leaveRace(this);
    clients.delete(this);
    log('- joueur', this.id, '(' + clients.size + ' en ligne)');
  }
}

// ---------------------------------------------------------------- salons et partie rapide
function genCode() {
  for (let k = 0; k < 50; k++) {
    let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(s) && !races.has(s)) return s;
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
    case 'hello': {
      const guest = 'Invité ' + String(1000 + (c.id * 7919) % 9000);
      const done = () => c.send({t: 'welcome', v: 1, online: clients.size, name: c.name});
      c.name = guest;
      if (typeof m.token === 'string' && m.token) tokAcc(m.token).then((a) => { if (a) { c.name = a.p; c.acct = a.k; } }, () => {}).then(done);
      else done();
      break;
    }
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
    default:
      if (m.t.charAt(0) === 'r') raceHandle(c, m);
  }
}

// ---------------------------------------------------------------- Course multi en ligne (2 à 4 joueurs)
// Chaque joueur arrive « pas prêt » et appuie sur Prêt : personne ne part sans l'avoir choisi.
// Salon privé : on partage un code, le créateur lance la course avec les joueurs prêts.
// Partie rapide : le serveur regroupe les joueurs qui ont choisi la même mise ; le compte à rebours
// démarre quand au moins 2 joueurs sont prêts (court si tout le monde l'est, plus long sinon :
// ceux qui ne sont toujours pas prêts au départ passent dans un autre salon et attendent la suivante).
// Pendant la course chaque téléphone envoie sa position ~12 fois par seconde ; le serveur la relaie
// aux autres, note les temps d'arrivée et annonce le classement (le 1er empoche la cagnotte).
const RACE_MAX = 4, RACE_LEN = 5300, RACE_STAKES = [0, 10, 50, 100, 500];
const RACE_GO = 5000, RACE_GO_FULL = 3000;        // partie rapide, tout le monde prêt : départ dans 5 s (3 s si le salon est plein)
const RACE_AFK = 20000;                           // au moins 2 prêts mais pas tous : départ dans 20 s sans les retardataires
const RACE_NEWCOMER = 5000;                       // un joueur qui arrive pendant le compte à rebours a au moins 5 s pour se dire prêt
const RACE_FIN_GRACE = 1500;                      // après la 1re arrivée, on attend un peu les arrivées serrées (réseau)
const RACE_MAX_T = 6 * 60 * 1000;                 // course bloquée (tout le monde en pause…) : on arrête
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; };
function raceSnap(R, you) {
  return {t: 'rroom', code: R.quick ? '' : R.code, quick: R.quick, bet: R.bet, host: R.host, st: R.st, you: you,
    wait: R.autoAt ? Math.max(0, Math.round((R.autoAt - Date.now()) / 1000)) : 0,
    players: R.players.map((p) => ({id: p.id, name: p.name, ready: !!p.rready, racing: R.st === 'run' && R.racers.has(p.id)}))};
}
function raceSync(R) { for (const p of R.players) p.send(raceSnap(R, p.id)); }
function raceNew(c, quick, bet) {
  const R = {code: genCode(), quick: quick, bet: bet, host: c.id, players: [], st: 'lobby', racers: new Set(), names: new Map(),
    fins: new Map(), lastZ: new Map(), gone: new Set(), pot: 0, seed: 0, autoT: 0, autoAt: 0, finT: 0, maxT: 0};
  races.set(R.code, R);
  return R;
}
function raceEnter(c, R) {
  // les jeux d'avant le bouton Prêt (pas de « rdy » dans leur demande) sont prêts d'office, comme avant
  R.players.push(c); c.race = R; c.rready = !!c.oldReady;
  raceAuto(R, true); raceSync(R);
}
function quickLobby(bet, not) {
  for (const x of races.values()) if (x !== not && x.quick && x.st === 'lobby' && x.bet === bet && x.players.length < RACE_MAX) return x;
  return null;
}
function leaveRace(c) {
  const R = c.race; if (!R) return;
  c.race = null; c.rready = false;
  R.players = R.players.filter((p) => p !== c);
  if (!R.players.length) { clearTimeout(R.autoT); clearTimeout(R.finT); clearTimeout(R.maxT); races.delete(R.code); return; }
  if (R.host === c.id) R.host = R.players[0].id;
  if (R.st === 'run' && R.racers.has(c.id)) {
    R.gone.add(c.id);
    for (const p of R.players) if (R.racers.has(p.id)) p.send({t: 'rleft', id: c.id});
    raceCheck(R);
  }
  raceAuto(R);
  if (races.has(R.code)) raceSync(R);
}
// partie rapide : compte à rebours automatique dès que 2 joueurs sont prêts
function raceAuto(R, newcomer) {
  if (!R.quick || R.st !== 'lobby') return;
  const rd = R.players.filter((p) => p.rready).length, all = rd === R.players.length;
  if (rd < 2) { if (R.autoT) { clearTimeout(R.autoT); R.autoT = 0; R.autoAt = 0; } return; }
  const now = Date.now();
  let at = now + (all ? (R.players.length >= RACE_MAX ? RACE_GO_FULL : RACE_GO) : RACE_AFK);
  if (R.autoT && R.autoAt < at) at = R.autoAt;                              // un départ annoncé n'est jamais repoussé…
  if (newcomer && R.autoT && at - now < RACE_NEWCOMER) at = now + RACE_NEWCOMER; // …sauf pour laisser le temps au nouveau venu
  if (!R.autoT || at !== R.autoAt) {
    clearTimeout(R.autoT); R.autoAt = at;
    R.autoT = setTimeout(() => { R.autoT = 0; R.autoAt = 0; raceStart(R); }, Math.max(0, at - now));
  }
}
function raceStart(R) {
  if (R.st !== 'lobby') return;
  const list = R.players.filter((p) => p.rready);
  if (list.length < 2) { raceSync(R); return; }
  clearTimeout(R.autoT); R.autoT = 0; R.autoAt = 0;
  R.st = 'run'; R.seed = crypto.randomInt(1, 2147483646);
  if (R.quick) {
    // partie rapide : ceux qui ne sont pas prêts attendent la suivante dans un autre salon
    const rest = R.players.filter((p) => !p.rready);
    if (rest.length) {
      R.players = R.players.filter((p) => p.rready);
      for (const p of rest) { p.race = null; raceEnter(p, quickLobby(R.bet, R) || raceNew(p, true, R.bet)); }
    }
  }
  R.racers = new Set(list.map((p) => p.id)); R.names = new Map(list.map((p) => [p.id, p.name]));
  R.fins = new Map(); R.lastZ = new Map(); R.gone = new Set(); R.pot = R.bet * list.length;
  const players = list.map((p) => ({id: p.id, name: p.name}));
  for (const p of list) p.send({t: 'rgo', seed: R.seed, bet: R.bet, pot: R.pot, len: RACE_LEN, you: p.id, players: players});
  R.maxT = setTimeout(() => raceDecide(R), RACE_MAX_T);
  raceSync(R);
  log('course', R.code, ':', players.map((p) => p.name).join(', '), R.bet ? '(mise ' + R.bet + ')' : '(amicale)');
}
// tout le monde est arrivé, ou il ne reste qu'un seul coureur : on annonce le résultat
function raceCheck(R) {
  if (R.st !== 'run') return;
  const active = R.players.filter((p) => R.racers.has(p.id));
  if (!active.length || active.every((p) => R.fins.has(p.id)) || (active.length === 1 && !R.fins.size)) raceDecide(R);
}
function raceDecide(R) {
  if (R.st !== 'run') return;
  clearTimeout(R.finT); clearTimeout(R.maxT); R.finT = 0; R.maxT = 0;
  const rows = [...R.racers].map((id) => ({id: id, name: R.names.get(id) || 'Joueur', t: R.fins.has(id) ? R.fins.get(id) : null,
    z: R.fins.has(id) ? RACE_LEN : Math.round(R.lastZ.get(id) || 0), left: R.gone.has(id)}));
  // d'abord les arrivés (du plus rapide au plus lent), puis ceux encore en course (le plus avancé d'abord), puis ceux partis
  rows.sort((a, b) => ((a.t === null) - (b.t === null)) || (a.t !== null ? a.t - b.t : ((a.left - b.left) || (b.z - a.z))));
  const res = {t: 'rres', winner: rows[0].id, pot: R.pot, bet: R.bet, ranking: rows};
  const racers = R.players.filter((p) => R.racers.has(p.id));
  for (const p of racers) p.send(res);
  log('arrivée', R.code, ':', rows[0].name, 'gagne', R.pot ? R.pot + ' arcs-en-ciel' : '');
  R.st = 'lobby'; R.racers = new Set();
  for (const p of racers) p.rready = false;
  if (R.quick) { for (const p of R.players) { p.race = null; p.rready = false; } races.delete(R.code); return; }   // partie rapide : chacun relance une recherche
  raceSync(R);
}
function raceHandle(c, m) {
  const R = c.race;
  if (m.t === 'rcreate' || m.t === 'rjoin' || m.t === 'rquick') c.oldReady = !m.rdy;
  switch (m.t) {
    case 'rcreate': {
      const bet = RACE_STAKES.indexOf(m.bet | 0) >= 0 ? m.bet | 0 : 0;
      leaveRace(c);
      raceEnter(c, raceNew(c, false, bet));
      break;
    }
    case 'rjoin': {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const T = races.get(code);
      if (!T || T.quick) { c.send({t: 'rerr', e: 'nocode'}); break; }
      if (T === R) { raceSync(T); break; }
      if (T.players.length >= RACE_MAX) { c.send({t: 'rerr', e: 'full'}); break; }
      leaveRace(c);
      raceEnter(c, T);
      break;
    }
    case 'rquick': {
      const bet = RACE_STAKES.indexOf(m.bet | 0) >= 0 ? m.bet | 0 : 0;
      leaveRace(c);
      raceEnter(c, quickLobby(bet, null) || raceNew(c, true, bet));
      break;
    }
    case 'rready': {
      // Prêt / plus prêt (les anciens jeux envoient {t:'rready'} sans « on » : ça veut dire prêt)
      if (!R || (R.st === 'run' && R.racers.has(c.id))) break;
      const on = m.on !== false;
      if (c.rready === on) { raceSync(R); break; }
      c.rready = on; raceAuto(R); raceSync(R);
      break;
    }
    case 'rstart':
      // l'hôte qui lance est forcément prêt ; les joueurs pas prêts attendent la course suivante
      if (R && !R.quick && R.host === c.id && R.st === 'lobby') { c.rready = true; raceStart(R); }
      break;
    case 'rleave':
      leaveRace(c);
      break;
    case 'rpos': {
      if (!R || R.st !== 'run' || !R.racers.has(c.id) || R.fins.has(c.id)) break;
      const z = num(m.z, 0, RACE_LEN + 200);
      R.lastZ.set(c.id, z);
      const o = {t: 'rpos', id: c.id, z: z, l: num(m.l, 0, 2) | 0, y: num(m.y, 0, 12), vy: num(m.vy, -60, 30), sl: num(m.sl, 0, 2), v: num(m.v, 0, 250), h: m.h ? 1 : 0};
      for (const p of R.players) if (p !== c && R.racers.has(p.id)) p.send(o);
      break;
    }
    case 'rfin': {
      if (!R || R.st !== 'run' || !R.racers.has(c.id) || R.fins.has(c.id)) break;
      R.fins.set(c.id, num(m.time, 20, 3600));
      for (const p of R.players) if (p !== c && R.racers.has(p.id)) p.send({t: 'rpos', id: c.id, z: RACE_LEN, l: 1, y: 0, vy: 0, sl: 0, v: 0, h: 0});
      if (R.fins.size === 1) R.finT = setTimeout(() => raceDecide(R), RACE_FIN_GRACE);
      raceCheck(R);
      break;
    }
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
  log('Serveur Unicorn Run prêt sur le port ' + PORT + (gameFile() ? ' (le jeu ' + path.basename(gameFile()) + ' est servi sur /)' : ' (aucun fichier de jeu trouvé à côté du serveur)'));
  log(KV_ON ? 'Comptes joueurs : base Upstash (permanente)' : '⚠ Comptes joueurs : fichier local data/comptes.json. Sur Render gratuit il est EFFACÉ à chaque redémarrage : règle UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN.');
  kvSelfTest().catch(() => {});
  const v = seller();
  log(!STRIPE_KEY ? 'Boutique payante : fermée (pas de STRIPE_SECRET_KEY)'
    : LIVE && !v.complete ? 'Boutique payante : BLOQUÉE – complète infos_vendeur.json avant les paiements réels'
    : 'Boutique payante : ouverte (' + (LIVE ? 'paiements réels' : 'mode test, aucun vrai débit') + ')');
  if (!v.complete) log('Pages légales : informations vendeur à compléter dans infos_vendeur.json (voir /legal/mentions)');
});
