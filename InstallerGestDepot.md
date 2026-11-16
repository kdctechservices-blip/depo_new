# Guide d’installation autonome de GestDepot sur MacBook Pro (macOS)

Ce guide explique comment compiler, installer et exécuter **GestDepot** en tant qu’application de bureau autonome (`.app` / `.dmg` via **Electron**) sur **MacBook Pro** (puces Apple Silicon M1/M2/M3/M4 et processeurs Intel), avec **enregistrement 100 % local et persistant des données dans SQLite** et sauvegarde automatique dans un dossier dédié de votre Mac.

---

## 1. Architecture locale et garantie « Zéro perte de données »

Lorsque GestDepot fonctionne en application autonome Electron sur macOS :

- **Aucune connexion Internet ni serveur cloud n’est requis** : le serveur Node/Express et le moteur SQLite tournent localement sur `127.0.0.1` à l’intérieur de l’application.
- **Validation disque immédiate (`PRAGMA journal_mode = WAL` + `PRAGMA synchronous = FULL`)** : chaque vente, encaissement, mouvement de stock, consigne ou dépense est écrit dans une transaction atomique et synchronisé physiquement sur le SSD du MacBook Pro avant confirmation à l’écran.
- **Emplacements locaux sur votre MacBook Pro** :
  1. **Base de données active** :
     ```
     ~/Library/Application Support/GestDepot/data/gestdepot.sqlite
     ```
  2. **Dossier principal des sauvegardes internes** :
     ```
     ~/Library/Application Support/GestDepot/data/backups/
     ```
  3. **Dossier dédié de sauvegarde automatique miroir (configurable)** :
     ```
     ~/Documents/GestDepot-Sauvegardes/
     ```
     *(Vous pouvez remplacer ce dossier à tout moment par un disque externe, une clé USB ou un autre dossier local depuis **Sauvegardes → Changer de dossier** dans l’application.)*

- **Déclencheurs automatiques via le contexte Electron (`electron/main.cjs`)** :
  - **Au démarrage** (`AUTO_DEMARRAGE`) : vérification et copie immédiate vers le dossier miroir.
  - **À intervalle régulier** (`AUTO_PERIODIQUE`) : toutes les **15, 30 ou 60 minutes** (30 min par défaut).
  - **À la fermeture de la fenêtre** (`AUTO_FENETRE`) : même si vous fermez simplement la fenêtre avec la croix rouge sans faire `Cmd + Q`, Electron intercepte la fermeture et sauvegarde la base vers le dossier dédié.
  - **À la fermeture de l’application ou arrêt du Mac** (`AUTO_FERMETURE`) : fusion complète du journal WAL (`PRAGMA wal_checkpoint(TRUNCATE)`) et dernière sauvegarde vérifiée par `PRAGMA integrity_check`.
  - **Rétention intelligente** : les **30 dernières copies automatiques** sont conservées dans le dossier miroir pour éviter de saturer le disque tout en gardant un historique complet.

---

## 2. Prérequis sur votre MacBook Pro

1. **macOS 12 (Monterey) ou plus récent** (Apple Silicon M1/M2/M3/M4 ou Intel).
2. **Node.js 22 LTS ou supérieur** (requis pour le module natif `node:sqlite`) :
   - Téléchargez l’installeur macOS (`.pkg`) depuis [https://nodejs.org](https://nodejs.org) (version **22 LTS** ou plus récente).
   - Vérifiez l’installation dans le **Terminal** (`Applications → Utilitaires → Terminal`) :
     ```bash
     node -v   # Doit afficher v22.x.x ou supérieur
     npm -v
     ```
3. **Outils en ligne de commande macOS** (si non encore installés) :
   ```bash
   xcode-select --install
   ```

---

## 3. Télécharger, compiler et installer l’application `.dmg`

Placez le dossier du projet **GestDepot** sur votre MacBook Pro (par exemple dans `~/Documents/gestdepot`), ouvrez le **Terminal** dans ce dossier, puis exécutez les commandes suivantes :

```bash
cd ~/Documents/gestdepot

# 1. Installer les dépendances de l'application
npm install

# 2. Installer Electron (>= 35 pour intégrer Node 22 / node:sqlite) et electron-builder
npm install -D electron@^35.2.0 electron-builder@^26.0.12

# 3. Compiler l'interface, le serveur embarqué et générer l'installeur macOS (.dmg)
npm run dist:mac
```

### Installer dans le dossier Applications
1. Ouvrez le dossier `release/` qui vient d’être créé dans `~/Documents/gestdepot/release/`.
2. Choisissez le fichier `.dmg` correspondant à votre MacBook Pro :
   - **MacBook Pro M1 / M2 / M3 / M4 (Apple Silicon)** : `GestDepot-1.0.0-arm64.dmg`
   - **MacBook Pro Intel** : `GestDepot-1.0.0.dmg`
3. Double-cliquez sur le `.dmg` puis glissez l’icône **GestDepot** dans **Applications**.

### Premier lancement sur macOS (contournement Gatekeeper)
Comme le `.dmg` a été compilé localement sur votre poste sans certificat payant *Apple Developer ID*, macOS affiche une alerte de sécurité au premier lancement :

- **Méthode graphique** : allez dans **Applications**, faites **Clic droit (ou Ctrl + clic) sur `GestDepot.app` → Ouvrir → Ouvrir**.
- **Ou via le Terminal** (à faire une seule fois) :
  ```bash
  xattr -cr /Applications/GestDepot.app
  ```
Ensuite, **GestDepot** s’ouvrira directement d’un simple double-clic ou depuis le Dock / Spotlight.

---

## 4. Configurer le stockage local persistant avec SQLite

### A. Configuration standard via l’interface (recommandé)
1. Lancez **GestDepot** depuis **Applications**.
2. Déverrouillez l’application avec le **Code PIN par défaut `5555`** (puis personnalisez-le à tout moment dans **Paramètres avancés → Sécurité & Code PIN**).
3. Ouvrez l’onglet **Sauvegardes** dans le menu latéral.
4. Dans la section **« Base de données 100 % locale SQLite »**, vérifiez que les chemins affichent bien :
   - **Base active** : `/Users/<votre-nom>/Library/Application Support/GestDepot/data/gestdepot.sqlite`
   - **Dossier sauvegardes principal** : `/Users/<votre-nom>/Library/Application Support/GestDepot/data/backups`
5. Dans la section **« Sauvegarde automatique vers un dossier système dédié (Contexte Electron) »** :
   - Vérifiez le **Dossier cible** (par défaut `~/Documents/GestDepot-Sauvegardes`).
   - Cliquez sur **Changer de dossier** pour choisir un autre dossier local, un disque dur externe ou une clé USB permanente.
   - Choisissez la fréquence souhaitée (**Toutes les 15 min**, **30 min** ou **60 min**).
   - Cliquez sur **Synchroniser maintenant** pour tester l’écriture immédiate, puis sur **Ouvrir** pour vérifier la présence du fichier `.sqlite` dans le Finder.

### B. Configuration avancée par variables d’environnement (exécution locale via Terminal)
Si vous souhaitez exécuter le serveur local sans compiler le `.dmg` ou imposer un emplacement SQLite personnalisé (par exemple sur un volume monté `/Volumes/DossierDepot`) :

```bash
# Dossier contenant gestdepot.sqlite et backups/
export GESTDEPOT_DATA_DIR="$HOME/GestDepotData"

# Dossier miroir supplémentaire pour les sauvegardes automatiques vérifiées
export GESTDEPOT_AUTO_BACKUP_DIR="$HOME/Documents/GestDepot-Sauvegardes"

# Compiler puis démarrer le serveur local sur http://localhost:3000
npm run build
npm start
```

> **Mode développement Electron** (avec rechargement à chaud, Terminal 1 + Terminal 2) :
> - Terminal 1 : `GESTDEPOT_DATA_DIR="$HOME/GestDepotData" GESTDEPOT_AUTO_BACKUP_DIR="$HOME/Documents/GestDepot-Sauvegardes" npm run dev`
> - Terminal 2 : `npm run electron:dev`

---

## 5. Sauvegarde externe, restauration et migration vers un autre Mac

- **Copie sur clé USB** : dans **Sauvegardes**, cliquez sur **Créer une sauvegarde maintenant**, puis sur **Copie USB** sur la ligne créée. Conservez ce fichier `.sqlite` sur une clé USB ou dans Time Machine.
- **Restaurer une sauvegarde ou migrer sur un nouveau MacBook Pro** :
  1. Installez **GestDepot** sur le nouveau Mac.
  2. Ouvrez **Sauvegardes → Importer un fichier (.sqlite)** et sélectionnez votre fichier `.sqlite`.
  3. Validez avec le mot de passe Administrateur : GestDepot vérifie automatiquement l’intégrité (`PRAGMA integrity_check`), sauvegarde la base actuelle par sécurité, puis restaure l’intégrité complète du dépôt (produits, stocks, clients, dettes, consignes, ventes, historique).

---

## 6. Dépannage rapide sur macOS

- **macOS demande l’autorisation d’accéder au dossier Documents** : acceptez la fenêtre système *« GestDepot souhaite accéder aux fichiers de votre dossier Documents »*. En cas de refus accidentel, réactivez-la dans **Réglages Système → Confidentialité et sécurité → Fichiers et dossiers → GestDepot**.
- **Erreur `node:sqlite` introuvable lors d’un lancement manuel** : vérifiez que `node -v` est bien **>= 22.13** (ou que Electron installé est bien **>= 35.0.0**).
- **Mise à jour de l’application sans perdre les données** : remplacer `GestDepot.app` dans **Applications** par une version plus récente **ne supprime jamais** vos données car `gestdepot.sqlite` et `desktop-config.json` résident dans `~/Library/Application Support/GestDepot/` et `~/Documents/GestDepot-Sauvegardes/`.
