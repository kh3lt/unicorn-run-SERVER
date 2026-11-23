# Serveur Unicorn Run

Un seul fichier, `tcg_server.js`, sans aucune dépendance. Il sert à trois choses :

- **Duels TCG en ligne** : il met deux joueurs en relation (salon à code ou partie rapide) et relaie leurs coups.
- **Boutique d'arcs-en-ciel payants** : il crée la page de paiement Stripe, vérifie le paiement et ne crédite chaque achat qu'une seule fois.
- **Le jeu lui-même** : `platformer.html` est servi à l'adresse du serveur. Ouvert depuis là, le jeu trouve le serveur tout seul, sans rien régler.

## 1. Essayer à la maison (même Wi-Fi)

1. Installe Node.js 18 ou plus (nodejs.org).
2. Dans ce dossier, lance `node tcg_server.js`. Le message « Serveur Unicorn Run prêt sur le port 8787 » s'affiche.
3. Repère l'adresse de l'ordinateur sur le réseau (par exemple `192.168.1.20`).
4. Sur les deux téléphones, connectés au même Wi-Fi, ouvre `http://192.168.1.20:8787`. Ensuite : TCG → **Duel en ligne**.

## 2. Mettre en ligne gratuitement (Render)

1. Mets ce dossier dans un dépôt GitHub : `tcg_server.js`, `package.json` et `platformer.html`.
2. Sur render.com, crée un nouveau **Web Service** relié à ce dépôt et règle-le ainsi :
   - Runtime : **Node** ;
   - Start Command : `npm start` ;
   - offre : **Free**.
3. Render te donne une adresse, par exemple `https://unicorn-run.onrender.com`. Ouvre-la sur les téléphones : c'est prêt.
4. Pour un jeu ouvert en fichier sur le téléphone, il y a deux façons de lui donner l'adresse :
   - la coller dans TCG → Duel en ligne → « Serveur : modifier » ;
   - ou l'écrire une fois pour toutes dans `platformer.html` : cherche `GAME_SERVER_URL`.

En offre gratuite, le serveur s'endort après 15 minutes sans visite. La première connexion qui suit peut prendre jusqu'à une minute, le temps qu'il se réveille ; le jeu patiente tout seul.

## 3. Ouvrir la boutique payante (Stripe)

1. Crée un compte Stripe. Pour encaisser de l'argent réel, Stripe demande un statut, par exemple micro-entrepreneur.
2. Dans le tableau de bord Stripe, va dans Développeurs → Clés API et copie la **clé secrète de test** (`sk_test_…`).
3. Dans Render, va dans Environment et ajoute la variable `STRIPE_SECRET_KEY`, avec la clé copiée comme valeur, puis redéploie.
4. Dans le jeu : Boutique → **Acheter**. Un bandeau « Mode test » s'affiche. Paie avec la carte 4242 4242 4242 4242, n'importe quelle date future et n'importe quel code : aucun vrai débit.
5. Quand tout marche, remplace la clé par la **clé secrète réelle** (`sk_live_…`).

**Ne mets jamais la clé secrète dans `platformer.html`** : elle ne va que dans les variables du serveur.

Les offres sont dans `tcg_server.js` (liste `PACKS`). C'est le serveur qui fait foi : changer un prix là suffit.

| Offre | Prix | Ce qu'on peut s'offrir avec |
|---|---|---|
| 500 arcs-en-ciel | 0,99 € | un coffre à chapeaux, ou un paquet de cartes |
| 1 200 (+20 %) | 1,99 € | |
| 3 500 (+40 %) | 4,99 € | |
| 8 000 (+60 %) | 9,99 € | meilleure offre |

Frais Stripe sur une carte européenne : 1,5 % + 0,25 € par paiement. Sur un achat à 0,99 €, il reste donc environ 0,73 € avant impôts.

## Bon à savoir

- Avant tout achat, le jeu pose une question à un adulte (une multiplication).
- Les arcs-en-ciel achetés restent sur l'appareil, comme le reste de la partie. Si on efface les données du navigateur, ils sont perdus.
- Si le jeu est un jour publié sur l'App Store ou Google Play, ces magasins imposent leur propre système d'achat intégré pour les monnaies virtuelles. Stripe convient pour un jeu joué dans le navigateur.
- Vendre à des particuliers, et en particulier à des enfants, entraîne des obligations : conditions de vente, TVA, accord des parents. Renseigne-toi avant de passer en paiements réels.
- Après chaque mise à jour du jeu, remplace aussi `platformer.html` dans ce dossier, puis redéploie.
