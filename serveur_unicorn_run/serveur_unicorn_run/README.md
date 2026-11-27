# Serveur Unicorn Run

`tcg_server.js` fonctionne sans aucune dépendance. Il fait cinq choses :

- **Course multi en ligne** (2 à 4 joueurs) : salons à code ou partie rapide par mise, même parcours pour tous, positions relayées, classement et cagnotte décidés par le serveur.
- **Duels TCG en ligne** : il met deux joueurs en relation (salon à code ou partie rapide) et relaie leurs coups.
- **Boutique d'arcs-en-ciel payants** : il crée la page de paiement Stripe, exige l'accord du client, vérifie le paiement et ne crédite chaque achat qu'une seule fois.
- **Pages légales** : `/legal/mentions`, `/legal/cgv` et `/legal/confidentialite`, remplies à partir de `infos_vendeur.json`.
- **Le jeu lui-même** : le fichier du jeu posé à côté du serveur (`platformer.html`, `game.html` ou `index.html` ; gardes-en un seul) est servi à l'adresse du serveur. Ouvert depuis là, le jeu trouve le serveur tout seul.

## 1. Essayer à la maison (même Wi-Fi)

1. Installe Node.js 18 ou plus (nodejs.org).
2. Dans ce dossier, lance `node tcg_server.js`.
3. Repère l'adresse de l'ordinateur sur le réseau (par exemple `192.168.1.20`).
4. Sur les téléphones, connectés au même Wi-Fi, ouvre `http://192.168.1.20:8787`.

## 2. Mettre en ligne gratuitement (Render)

1. Mets ce dossier dans un dépôt GitHub (tous les fichiers).
2. Sur render.com, crée un **Web Service** relié au dépôt et règle-le ainsi :
   - Runtime : **Node** ;
   - Start Command : `npm start` ;
   - offre : **Free**.
3. Ouvre l'adresse donnée par Render (par exemple `https://unicorn-run.onrender.com`) sur les téléphones.
4. L'adresse par défaut du serveur est écrite tout en haut du jeu (`GAME_SERVER_URL`, actuellement `wss://unicorn-run-serv.onrender.com`). Pour un autre serveur, il y a deux façons :
   - la coller dans Course multi → En ligne → « Serveur : … · changer », ou dans TCG → Duel en ligne → « Serveur : modifier » (l'adresse sert ensuite partout) ;
   - ou l'écrire une fois pour toutes dans `platformer.html` : cherche `GAME_SERVER_URL`.

Réglages Render conseillés : Language **Node**, Build Command `npm install`, Start Command `npm start`, Region **Frankfurt**, Instance Type **Free**. Vérification : `https://ton-adresse/health` doit afficher `ok`.

En offre gratuite, le serveur s'endort après 15 minutes sans visite. La première connexion qui suit peut prendre jusqu'à une minute.

## 3. Vendre des arcs-en-ciel : les obligations, et où elles sont dans le jeu

| Obligation | Où |
|---|---|
| Mentions légales (identité, contact, hébergeur) | page `/legal/mentions`, liens dans Paramètres et dans la boutique |
| Conditions générales de vente : prix TTC, contenu, commande, rétractation, garantie, médiation, formulaire de rétractation | page `/legal/cgv` |
| Politique de confidentialité (RGPD) | page `/legal/confidentialite` |
| Informations avant l'achat (article, prix TTC, vendeur, liens) | récapitulatif affiché avant chaque paiement |
| Acceptation des CGV | case à cocher obligatoire |
| Accord exprès pour la livraison immédiate et perte du droit de rétractation (art. L.221-28 13°) | 2ᵉ case à cocher obligatoire ; le serveur refuse le paiement sans les deux cases |
| Bouton « Commander avec obligation de paiement » | dernière étape avant Stripe |
| Confirmation de la commande et de l'accord, par e-mail | reçu Stripe, qui reprend l'accord donné : **à activer** (voir l'étape 5 ci-dessous) |
| Médiateur de la consommation | à choisir puis à indiquer dans `infos_vendeur.json` |
| Prix en euros des objets achetés avec des arcs-en-ciel | affiché sous chaque prix (« ≈ 0,90 € »), dès que la boutique payante est ouverte |
| Probabilités des tirages au hasard (coffre, paquets) | affichées dans le jeu |
| Contrôle parental | multiplication posée à un adulte avant chaque achat |

### Ce que tu dois faire avant les paiements réels

1. **Obtenir un statut** pour encaisser de l'argent, par exemple micro-entrepreneur, avec un numéro SIRET.
2. **Choisir un médiateur de la consommation.** C'est obligatoire ; la liste des médiateurs référencés est sur economie.gouv.fr (rubrique « médiation de la consommation »). Il faut adhérer à son service, qui est souvent payant.
3. **Remplir `infos_vendeur.json`** : remplace chaque « À COMPLÉTER ».
   - Si tu n'es pas en franchise de TVA, remplace la ligne `tva`.
   - Tant qu'il reste un « À COMPLÉTER », le serveur **bloque les paiements réels**. Le mode test marche quand même, et les pages légales surlignent ce qui manque.
4. **Stripe** :
   - ajoute la variable `STRIPE_SECRET_KEY` dans Render (`sk_test_…` pour essayer, puis `sk_live_…`) ;
   - dans Stripe, renseigne aussi l'adresse de tes conditions de vente et de ta politique de confidentialité (`https://ton-adresse/legal/cgv` et `/legal/confidentialite`) dans les informations publiques de ton compte.
5. **Active les reçus Stripe par e-mail** : Paramètres → E-mails clients → « Paiements réussis ». C'est ce reçu qui sert de confirmation écrite de la commande et de l'accord du client.
6. **Ne mets jamais la clé secrète dans `platformer.html`.**

### Les offres

Elles sont dans la liste `PACKS` de `tcg_server.js`. Le pourcentage « offert » se calcule tout seul.

| Offre | Prix TTC | Ce qu'on peut s'offrir avec |
|---|---|---|
| 500 arcs-en-ciel | 1,29 € | un coffre à chapeaux, ou un paquet de cartes |
| 1 200 (+20 %) | 2,49 € | |
| 3 500 (+50 %) | 5,99 € | |
| 8 000 (+70 %) | 11,99 € | meilleure offre |

Frais Stripe sur une carte européenne : 1,5 % + 0,25 € par paiement. Sur un achat à 1,29 €, il reste donc environ 1,02 € avant impôts.

## Comptes joueurs (pseudo unique, progression sur tous les appareils)

- Un pseudo ne peut appartenir qu'à un seul compte (majuscules, accents et espaces ignorés : « Mia » et « mïa » sont le même pseudo).
- Compte à partir de 15 ans (date de naissance demandée). Le casino est réservé aux comptes de 18 ans et plus.
- Sans compte, on joue en « Invité » : la partie reste sur l'appareil, et en ligne on apparaît comme « Invité 1234 ».
- La progression part vers le compte au plus tard 15 s après un changement (et quand on quitte la page). Sur un autre appareil : « J'ai déjà un compte ». Si deux appareils jouent en même temps, la partie la plus récente gagne.
- Mots de passe chiffrés (scrypt). Comptes inactifs pendant 3 ans effacés. Suppression possible dans Paramètres → Compte.
- **Stockage obligatoire pour la mise en ligne** : base Upstash Redis gratuite. Variables à régler sur Render : `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` (page de la base → REST API). Sans elles, les comptes vont dans `data/comptes.json`, effacé à chaque redémarrage sur Render gratuit (le journal le signale).

## Classement en ligne (aventure)

- Deux classements : **la semaine** (remis à zéro chaque lundi à minuit, heure de Paris, avec un compte à rebours dans le jeu) et **le général** (meilleur niveau de tous les temps).
- Seuls les comptes y apparaissent. Chaque niveau terminé est envoyé au serveur ; à égalité, le premier arrivé passe devant.
- Le top 3 de la semaine passée reçoit 2000 / 1000 / 500 arcs-en-ciel au lancement suivant du jeu, une seule fois.
- Les classements sont rangés dans la même base Upstash que les comptes.

## Joueurs en ligne

Chaque page du jeu ouverte se signale toutes les 25 s (`/presence`) ; le menu affiche le nombre de pages vues dans la dernière minute.

## Course multi en ligne : comment ça marche

- Mises possibles : 0 (Amicale), 10, 50, 100 ou 500 (liste `RACE_STAKES`). Cagnotte = mise × nombre de coureurs.
- Bouton **Prêt** : chaque joueur arrive « pas prêt » et appuie sur « Je suis prêt » ; personne ne part sans l'avoir choisi (on peut annuler tant que le départ n'est pas donné).
- Partie rapide : le serveur regroupe les joueurs qui ont choisi la même mise ; quand tout le monde est prêt, départ dans 5 s (3 s si le salon est plein, 4 joueurs). Si au moins 2 sont prêts mais pas tous, départ dans 20 s : ceux qui ne sont toujours pas prêts passent dans un autre salon et attendent la course suivante.
- Salon privé : code de 4 lettres ; le créateur lance la course avec les joueurs prêts (le bouton reste grisé tant qu'aucun autre joueur n'est prêt). S'il part, le joueur suivant devient l'hôte.
- Le serveur tire une graine : tous les téléphones construisent exactement le même parcours. Le 1ᵉʳ temps d'arrivée gagne (1,5 s de marge pour les arrivées serrées) ; s'il ne reste qu'un coureur, il gagne par forfait.
- Connexion perdue en pleine course : la course est annulée sur ce téléphone et la mise lui est rendue.

## Bon à savoir

- **Casino et courses avec mises.** Dès que les arcs-en-ciel s'achètent avec de l'argent réel, miser au blackjack, à la roulette ou dans la course multi (contre l'IA ou entre joueurs en ligne) peut être considéré comme un jeu d'argent. La course en ligne « Amicale » se joue sans mise. Ces jeux sont strictement encadrés en France, et les jeux de casino en ligne n'y sont pas autorisés. **Règle ce point avant d'ouvrir les paiements réels.**
- Les arcs-en-ciel achetés restent sur l'appareil : effacer les données du navigateur les supprime. Les CGV le disent clairement.
- Sur l'App Store ou Google Play, il faudrait leur propre système d'achat intégré à la place de Stripe.
- Ces textes sont un bon point de départ, mais je ne suis pas juriste. Fais-les relire si tu peux avant de vendre pour de vrai.
- Après chaque mise à jour du jeu, remplace aussi `platformer.html` dans ce dossier, puis redéploie.
