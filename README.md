# Telegram Public Live Tracker (100% GitHub Edition) 🗺️🚀

Un tracker en direct public moderne, esthétique et ultra-performant. Il permet de localiser des participants (marcheurs, cyclistes, motards, voitures...) sur une carte interactive contenant un tracé GPX et des points d'intérêt (waypoints), tout en intégrant un chat de discussion en temps réel synchronisé depuis un groupe Telegram.

Ce projet fonctionne **sans aucun serveur externe ni base de données payante**. Tout est hébergé, stocké et exécuté directement sur **GitHub** (Pages, Actions et Secrets).

---

## 🛠️ Architecture du projet

1. **Le Stockage (`data.json`)** : Une base de données JSON contenant toute la configuration, la liste des participants, l'historique GPS, les waypoints et le chat.
2. **Le Frontend (GitHub Pages)** : Une application HTML/JS/CSS statique qui lit `data.json` en direct pour afficher le parcours et la position des participants.
3. **La Console Admin (`admin.html`)** : Permet de configurer l'événement, charger le tracé GPX, ajouter des waypoints et faire le ménage. Elle commite les modifications directement dans le dépôt GitHub via l'API REST grâce à un jeton d'accès personnel (PAT) stocké localement dans votre navigateur.
4. **Le Bot Telegram (`bot.js` exécuté par GitHub Actions)** : Un script Node.js lancé dans les serveurs de GitHub (Actions) qui écoute les localisations Telegram en temps réel et commite les modifications dans `data.json` toutes les minutes.

---

## 🤖 Étape 1 : Création du Bot Telegram

1. Ouvrez Telegram et recherchez [@BotFather](https://t.me/BotFather).
2. Envoyez la commande `/newbot` et suivez les instructions.
3. Notez le **Token API** fourni (ex: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
4. Créez un groupe Telegram pour votre événement/randonnée.
5. Ajoutez le bot comme **Administrateur** de ce groupe pour qu'il puisse y lire et synchroniser les messages de discussion.

---

## 🔑 Étape 2 : Configuration du dépôt GitHub

1. Créez un dépôt public sur GitHub nommé `TelegramLiveTracker`.
2. Initialisez git dans votre dossier de projet local et poussez le code vers votre dépôt :
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/votre-utilisateur/TelegramLiveTracker.git
   git branch -M main
   git push -u origin main
   ```
3. Sur votre dépôt GitHub, allez dans **Settings** -> **Secrets and variables** -> **Actions**.
4. Cliquez sur **New repository secret** :
   * Nom : `TELEGRAM_BOT_TOKEN`
   * Valeur : Le Token API obtenu auprès de BotFather.
5. Allez dans **Settings** -> **Actions** -> **General** :
   * Faites défiler jusqu'à **Workflow permissions**.
   * Cochez **Read and write permissions** (nécessaire pour que le workflow puisse modifier le fichier `data.json`).
   * Cliquez sur **Save**.

---

## 🌐 Étape 3 : Activer GitHub Pages

1. Sur GitHub, allez dans les **Settings** de votre dépôt -> **Pages**.
2. Sous **Build and deployment**, sélectionnez la branche `main` et le dossier `/ (root)`, puis cliquez sur **Save**.
3. Votre site sera disponible sous l'adresse `https://votre-utilisateur.github.io/TelegramLiveTracker/` !

---

## 💻 Étape 4 : Utilisation et Administration

1. Allez sur votre page d'administration `https://votre-utilisateur.github.io/TelegramLiveTracker/admin.html`.
2. Saisissez vos identifiants GitHub (Utilisateur, dépôt) et créez un **Jeton d'accès personnel GitHub (PAT)** avec le droit `repo` sur [GitHub Tokens](https://github.com/settings/tokens). Saisissez-le dans la console. (Ce jeton reste dans votre navigateur).
3. Personnalisez le titre de l'événement et uploadez votre fichier **GPX**.
4. Ajoutez des **Waypoints** sur la carte.
5. Entrez le lien d'invitation de votre groupe Telegram pour générer le **QR Code d'Inscription**.

---

## ⏱️ Étape 5 : Lancement du Live Tracker

1. Sur GitHub, cliquez sur l'onglet **Actions**.
2. Dans la colonne de gauche, cliquez sur le workflow **Telegram Live Tracker Bot Runner**.
3. Cliquez sur le menu déroulant **Run workflow**, choisissez la durée en heures (ex: 6) et cliquez sur le bouton vert **Run workflow**.
4. Le bot démarre sur les serveurs de GitHub et commence à écouter.
5. Les participants n'ont plus qu'à scanner le QR Code, démarrer le bot avec `/start` et lancer le **partage de position en direct** sur Telegram !

---

## 🧹 Nettoyage des Données

* **Automatique** : Chaque fois que le bot démarre sur GitHub Actions, il supprime automatiquement de `data.json` toutes les positions GPS et les messages de chat plus anciens que le nombre de jours spécifié dans l'administration (3 jours par défaut).
* **Manuel** : Dans la section **Danger Zone** de la page `admin.html`, l'administrateur peut cliquer sur les boutons de suppression pour vider instantanément les positions, le chat ou les waypoints.
