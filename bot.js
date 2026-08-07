require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch'); // Required on Node 16, native on Node 18+

// Configure parameters
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const githubRepo = process.env.GITHUB_REPOSITORY; // format: owner/repo
const githubToken = process.env.GITHUB_TOKEN; // provided automatically by GitHub Actions

if (!botToken || !githubRepo || !githubToken) {
    console.error("Erreur: Les variables d'environnement TELEGRAM_BOT_TOKEN, GITHUB_REPOSITORY et GITHUB_TOKEN doivent être définies.");
    process.exit(1);
}

// In-Memory buffers to prevent committing too frequently
let localUpdates = {
    locations: {}, // telegram_id -> array of { lat, lng, speed, time }
    messages: [],  // array of { sender, text, time }
    participants: [] // list of newly registered participants
};

let dataState = null;
let dataSha = '';
let isSaving = false;

// Initialize bot in polling mode
const bot = new TelegramBot(botToken, { polling: true });

console.log(`Bot démarré. Cible dépôt: https://github.com/${githubRepo}`);

// Initialize by fetching state from GitHub
async function loadGitHubState() {
    const url = `https://api.github.com/repos/${githubRepo}/contents/data.json`;
    try {
        const res = await fetch(url, {
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        if (!res.ok) throw new Error(`Chargement échoué avec statut ${res.status}`);
        
        const fileInfo = await res.json();
        dataSha = fileInfo.sha;
        const decodedContent = Buffer.from(fileInfo.content, 'base64').toString('utf8');
        dataState = JSON.parse(decodedContent);

        console.log("État GitHub chargé avec succès !");
        
        // Execute automated cleanup upon start
        await runAutomatedCleanup();

    } catch (err) {
        console.error("Erreur lors du chargement de l'état GitHub:", err.message);
        process.exit(1); // Exit if we cannot read initial database
    }
}

// Automated Cleanup
async function runAutomatedCleanup() {
    if (!dataState || !dataState.config) return;
    
    const cleanupDays = dataState.config.cleanup_days || 3;
    const now = new Date();
    const thresholdDate = new Date(now.getTime() - (cleanupDays * 24 * 60 * 60 * 1000));
    
    console.log(`Lancement du nettoyage automatique des données de plus de ${cleanupDays} jours...`);
    let modified = false;

    // 1. Clean locations history
    if (dataState.locations) {
        for (const tgId in dataState.locations) {
            const initialCount = dataState.locations[tgId].length;
            // Filter points
            dataState.locations[tgId] = dataState.locations[tgId].filter(pt => new Date(pt.time) > thresholdDate);
            if (dataState.locations[tgId].length !== initialCount) {
                modified = true;
            }
            // Remove participant key if history is completely empty
            if (dataState.locations[tgId].length === 0) {
                delete dataState.locations[tgId];
            }
        }
    }

    // 2. Clean messages history
    if (dataState.messages) {
        const initialCount = dataState.messages.length;
        dataState.messages = dataState.messages.filter(msg => new Date(msg.time) > thresholdDate);
        if (dataState.messages.length !== initialCount) {
            modified = true;
        }
    }

    if (modified) {
        console.log("Des données obsolètes ont été détectées. Enregistrement du nettoyage...");
        await pushGitHubState("Nettoyage automatique des données expirées");
    } else {
        console.log("Aucune donnée obsolète à nettoyer.");
    }
}

// Save merged updates back to GitHub
async function pushGitHubState(commitMessage) {
    if (isSaving) return;
    isSaving = true;

    const url = `https://api.github.com/repos/${githubRepo}/contents/data.json`;
    
    try {
        // 1. Re-fetch current data.json to avoid edit conflicts (merge changes)
        const res = await fetch(url, {
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        if (res.ok) {
            const fileInfo = await res.json();
            dataSha = fileInfo.sha;
            const decodedContent = Buffer.from(fileInfo.content, 'base64').toString('utf8');
            const latestState = JSON.parse(decodedContent);

            // Merge config, waypoints, participants
            dataState.config = latestState.config;
            dataState.waypoints = latestState.waypoints;

            // Merge participants (combining newly registered and existing ones)
            const combinedParticipants = [...latestState.participants];
            dataState.participants.forEach(p => {
                if (!combinedParticipants.some(cp => cp.telegram_id === p.telegram_id)) {
                    combinedParticipants.push(p);
                }
            });
            dataState.participants = combinedParticipants;

            // Merge locations trails
            for (const tgId in latestState.locations) {
                if (!dataState.locations[tgId]) {
                    dataState.locations[tgId] = latestState.locations[tgId];
                } else {
                    // Combine lists keeping unique timestamp objects
                    const combinedLocs = [...latestState.locations[tgId]];
                    dataState.locations[tgId].forEach(pt => {
                        if (!combinedLocs.some(cl => cl.time === pt.time)) {
                            combinedLocs.push(pt);
                        }
                    });
                    // Sort by time
                    combinedLocs.sort((a,b) => new Date(a.time) - new Date(b.time));
                    dataState.locations[tgId] = combinedLocs;
                }
            }

            // Merge messages
            const combinedMsgs = [...latestState.messages];
            dataState.messages.forEach(m => {
                if (!combinedMsgs.some(cm => cm.time === m.time && cm.sender === m.sender)) {
                    combinedMsgs.push(m);
                }
            });
            combinedMsgs.sort((a,b) => new Date(a.time) - new Date(b.time));
            dataState.messages = combinedMsgs;
        }

        // 2. Commit back to GitHub
        const contentEncoded = Buffer.from(JSON.stringify(dataState, null, 2), 'utf8').toString('base64');
        const updateRes = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: commitMessage,
                content: contentEncoded,
                sha: dataSha
            })
        });

        if (updateRes.ok) {
            const updateInfo = await updateRes.json();
            dataSha = updateInfo.content.sha;
            console.log(`[GitHub Commit] ${commitMessage}`);
        } else {
            console.error(`Erreur de commit: ${updateRes.statusText}`);
        }
    } catch (err) {
        console.error("Erreur lors de la sauvegarde sur GitHub:", err);
    } finally {
        isSaving = false;
    }
}

// Periodically merge local updates and push to GitHub (every 60 seconds if changes present)
setInterval(async () => {
    if (!dataState) return;

    let hasChanges = false;
    let changeReason = [];

    // Merge registered participants
    if (localUpdates.participants.length > 0) {
        localUpdates.participants.forEach(p => {
            if (!dataState.participants.some(dp => dp.telegram_id === p.telegram_id)) {
                dataState.participants.push(p);
                hasChanges = true;
            }
        });
        changeReason.push("Inscriptions de participants");
        localUpdates.participants = [];
    }

    // Merge locations
    for (const tgId in localUpdates.locations) {
        if (localUpdates.locations[tgId].length > 0) {
            if (!dataState.locations[tgId]) dataState.locations[tgId] = [];
            dataState.locations[tgId].push(...localUpdates.locations[tgId]);
            
            // Limit trail points per user to last 150 points to prevent data.json from bloating
            if (dataState.locations[tgId].length > 150) {
                dataState.locations[tgId] = dataState.locations[tgId].slice(-150);
            }

            localUpdates.locations[tgId] = [];
            hasChanges = true;
        }
    }
    if (hasChanges && changeReason.length === 0) {
        changeReason.push("Mise à jour des coordonnées GPS");
    }

    // Merge messages
    if (localUpdates.messages.length > 0) {
        dataState.messages.push(...localUpdates.messages);
        
        // Limit messages count to last 50 messages to keep data.json lightweight
        if (dataState.messages.length > 50) {
            dataState.messages = dataState.messages.slice(-50);
        }

        localUpdates.messages = [];
        hasChanges = true;
        changeReason.push("Synchronisation des messages de chat");
    }

    if (hasChanges) {
        await pushGitHubState(changeReason.join(" & "));
    }

}, 60000);

// Get/Register participant
function registerParticipant(from) {
    const telegramId = from.id;
    
    // Check if loaded yet
    if (!dataState) return null;

    const existing = dataState.participants.find(p => p.telegram_id === telegramId);
    if (existing) return existing;

    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || `Randonneur ${telegramId}`;

    const newParticipant = {
        telegram_id: telegramId,
        username: from.username || '',
        display_name: displayName,
        color: randomColor,
        icon: 'motorcycle',
        is_active: true
    };

    // Save in local buffer
    localUpdates.participants.push(newParticipant);
    return newParticipant;
}

// Bot listeners
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    if (msg.chat.type !== 'private') {
        bot.sendMessage(chatId, "Ajoutez-moi en privé et lancez /start pour vous inscrire !");
        return;
    }

    const participant = registerParticipant(msg.from);
    const name = participant ? participant.display_name : msg.from.first_name;

    bot.sendMessage(chatId, `Salut ${name} ! 🚀\n\nTu es maintenant enregistré pour le Live Tracker.\n\nPour partager ta position :\n1. Clique sur l'icône trombone 📎\n2. Sélectionne "Position" 📍\n3. Choisis **"Partager ma position en direct..."** (Share My Live Location) et choisis la durée (ex: 8 heures).\n\nLe tracker mettra automatiquement à jour ta position sur la carte publique !`);
});

bot.on('location', (msg) => {
    bufferLocation(msg);
});

bot.on('edited_message', (msg) => {
    if (msg.location) {
        bufferLocation(msg);
    }
});

function bufferLocation(msg) {
    const from = msg.from;
    const loc = msg.location;
    const tgId = from.id;

    registerParticipant(from); // Ensure registered

    if (!localUpdates.locations[tgId]) {
        localUpdates.locations[tgId] = [];
    }

    localUpdates.locations[tgId].push({
        lat: loc.latitude,
        lng: loc.longitude,
        speed: loc.speed || null,
        time: new Date().toISOString()
    });
}

// Sync group messages
bot.on('message', (msg) => {
    if (msg.chat.type === 'private' || msg.location || (msg.text && msg.text.startsWith('/'))) {
        return;
    }

    if (!msg.text) return;

    const from = msg.from;
    const participant = dataState ? dataState.participants.find(p => p.telegram_id === from.id) : null;
    const senderName = participant ? participant.display_name : [from.first_name, from.last_name].filter(Boolean).join(' ') || `User ${from.id}`;

    localUpdates.messages.push({
        sender: senderName,
        text: msg.text,
        time: new Date().toISOString()
    });
});

// Load state and begin
loadGitHubState();
