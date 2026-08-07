require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

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
    participants: [], // list of newly registered participants
    shared_points: [] // list of shared points from chat
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

        // Check if event is active, and schedule run/termination
        scheduleRunSession();

    } catch (err) {
        console.error("Erreur lors du chargement de l'état GitHub:", err.message);
        process.exit(1);
    }
}

// Check if event is active and determine runtime duration (max 27 minutes per cron cycle)
function scheduleRunSession() {
    const isManual = process.env.IS_MANUAL_TRIGGER === 'true';

    if (isManual) {
        const durationHours = parseInt(process.env.MANUAL_DURATION) || 6;
        console.log(`[Planificateur] Déclenchement MANUEL détecté ! Fonctionnement forcé pendant ${durationHours} heures.`);
        
        // We will run for the specified manual duration
        setTimeout(async () => {
            console.log(`[Planificateur] Fin du fonctionnement manuel de ${durationHours}h. Arrêt.`);
            await runFinalSave();
            process.exit(0);
        }, durationHours * 60 * 60 * 1000);
        return;
    }

    if (!dataState || !dataState.config || !dataState.config.event_start) {
        console.log("Aucune date de début programmée. Arrêt immédiat.");
        process.exit(0);
    }

    const eventStart = new Date(dataState.config.event_start);
    const durationHours = dataState.config.event_duration || 4;
    const eventEnd = new Date(eventStart.getTime() + (durationHours * 60 * 60 * 1000));
    const now = new Date();

    if (now < eventStart || now > eventEnd) {
        console.log(`[Planificateur] Pas d'événement actif actuellement.\nDébut prévu : ${eventStart.toLocaleString()}\nFin prévue : ${eventEnd.toLocaleString()}\nDate actuelle : ${now.toLocaleString()}\nArrêt.`);
        process.exit(0);
    }

    // Calculate remaining time
    const msLeft = eventEnd.getTime() - now.getTime();
    const minutesLeft = Math.ceil(msLeft / 60000);

    // Run for at most 27 minutes (matching the 30-minute GitHub Action Cron trigger interval with a 3-minute safety gap)
    const sessionMinutes = Math.min(27, minutesLeft);
    console.log(`[Planificateur] Événement actif ! Lancement de la session d'écoute pour : ${sessionMinutes} minutes (Fin prévue de l'événement dans ${minutesLeft} mins).`);

    // Send Startup Telemetry Notification
    sendTelemetryMessage(`📢 *Live Tracker Bot en ligne !*\n⏱️ Session active : \`${sessionMinutes} mins\` (événement actif)\n👥 Participants : \`${dataState.participants.length}\`\n📍 Positions enregistrées : \`${Object.keys(dataState.locations).length}\``);

    setTimeout(async () => {
        console.log(`[Planificateur] Fin de la session de ${sessionMinutes} minutes. Sauvegarde et fermeture...`);
        
        // Send Shutdown Telemetry Notification
        await sendTelemetryMessage(`🛑 *Session temporaire terminée* (${sessionMinutes} mins). Sauvegarde de l'état sur GitHub. Le planificateur relancera la session suivante sous peu.`);
        
        // Final merge and save
        await runFinalSave();
        process.exit(0);
    }, sessionMinutes * 60 * 1000);
}

// Send telegram messages to group if group ID is saved
async function sendTelemetryMessage(text) {
    if (!dataState || !dataState.config || !dataState.config.telegram_admin_group_id) {
        console.log(`[Télémétrie] ID de groupe d'administration inconnu.\nMessage: ${text}`);
        return;
    }

    try {
        await bot.sendMessage(dataState.config.telegram_admin_group_id, text, { parse_mode: 'Markdown' });
        console.log(`[Télémétrie Envoyée] ${text.replace(/\n/g, ' ')}`);
    } catch (err) {
        console.error("[Télémétrie] Erreur d'envoi Telegram:", err.message);
    }
}

// Force a final save before exiting
async function runFinalSave() {
    let hasChanges = false;
    let changeReason = [];

    if (localUpdates.participants.length > 0) {
        localUpdates.participants.forEach(p => {
            if (!dataState.participants.some(dp => dp.telegram_id === p.telegram_id)) {
                dataState.participants.push(p);
                hasChanges = true;
            }
        });
        changeReason.push("Inscriptions");
    }

    for (const tgId in localUpdates.locations) {
        if (localUpdates.locations[tgId].length > 0) {
            if (!dataState.locations[tgId]) dataState.locations[tgId] = [];
            dataState.locations[tgId].push(...localUpdates.locations[tgId]);
            if (dataState.locations[tgId].length > 150) {
                dataState.locations[tgId] = dataState.locations[tgId].slice(-150);
            }
            hasChanges = true;
        }
    }
    if (hasChanges && changeReason.length === 0) {
        changeReason.push("Mise à jour coordonnées");
    }

    if (localUpdates.messages.length > 0) {
        dataState.messages.push(...localUpdates.messages);
        if (dataState.messages.length > 50) {
            dataState.messages = dataState.messages.slice(-50);
        }
        hasChanges = true;
        changeReason.push("Messages chat");
    }

    if (localUpdates.shared_points && localUpdates.shared_points.length > 0) {
        if (!dataState.shared_points) dataState.shared_points = [];
        dataState.shared_points.push(...localUpdates.shared_points);
        if (dataState.shared_points.length > 50) {
            dataState.shared_points = dataState.shared_points.slice(-50);
        }
        hasChanges = true;
        changeReason.push("Points partagés");
    }

    if (hasChanges) {
        await pushGitHubState("Fin de session: " + changeReason.join(" & "));
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
            dataState.config = { ...latestState.config, ...dataState.config };
            dataState.waypoints = latestState.waypoints;

            if (!dataState.shared_points) dataState.shared_points = [];
            const combinedSharedPoints = [...(latestState.shared_points || [])];
            dataState.shared_points.forEach(sp => {
                if (!combinedSharedPoints.some(csp => csp.time === sp.time && csp.sender === sp.sender)) {
                    combinedSharedPoints.push(sp);
                }
            });
            dataState.shared_points = combinedSharedPoints;

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

    // Merge shared points
    if (localUpdates.shared_points && localUpdates.shared_points.length > 0) {
        if (!dataState.shared_points) dataState.shared_points = [];
        dataState.shared_points.push(...localUpdates.shared_points);
        if (dataState.shared_points.length > 50) {
            dataState.shared_points = dataState.shared_points.slice(-50);
        }
        localUpdates.shared_points = [];
        hasChanges = true;
        changeReason.push("Points GPS partagés dans le chat");
    }

    if (hasChanges) {
        await pushGitHubState(changeReason.join(" & "));
    }

}, 15000);

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
bot.on('message', async (msg) => {
    if (msg.chat.type !== 'private') {
        console.log(`[Message Groupe Reçu] ID du canal: ${msg.chat.id} | Expéditeur: ${msg.from.first_name} | Texte: ${msg.text || '[Aucun texte]'}`);
    }

    if (msg.chat.type === 'private' || (msg.text && msg.text.startsWith('/'))) {
        return;
    }

    if (!dataState || !dataState.config || !dataState.config.telegram_chat_group_id) {
        console.log(`[Message Ignoré] Le canal de chat de groupe n'est pas configuré. Veuillez envoyer la commande /setup chat dans le groupe Telegram des participants.`);
        return;
    }

    // Only sync if the message comes from the participant group
    if (msg.chat.id !== dataState.config.telegram_chat_group_id) {
        console.log(`[Message Ignoré] Le message provient de l'ID ${msg.chat.id}, mais le groupe de participants configuré est ${dataState.config.telegram_chat_group_id}`);
        return;
    }

    const from = msg.from;
    const participant = dataState ? dataState.participants.find(p => p.telegram_id === from.id) : null;
    const senderName = participant ? participant.display_name : [from.first_name, from.last_name].filter(Boolean).join(' ') || `User ${from.id}`;

    // Extract GPS point if any
    let isGpsPoint = false;
    let lat = null;
    let lng = null;

    if (msg.location) {
        isGpsPoint = true;
        lat = msg.location.latitude;
        lng = msg.location.longitude;
    } else if (msg.text) {
        // Regex for raw coordinates (e.g. 48.8584, 2.2945)
        const coordRegex = /(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/;
        const match = msg.text.match(coordRegex);
        if (match) {
            isGpsPoint = true;
            lat = parseFloat(match[1]);
            lng = parseFloat(match[2]);
        } else {
            // Google Maps link: google.com/maps?q=lat,lng
            const gmapsRegex = /google\..*\/maps.*[q|place]\/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/i;
            const matchGmaps = msg.text.match(gmapsRegex);
            if (matchGmaps) {
                isGpsPoint = true;
                lat = parseFloat(matchGmaps[1]);
                lng = parseFloat(matchGmaps[2]);
            }
        }
    }

    if (isGpsPoint && lat !== null && lng !== null) {
        if (!localUpdates.shared_points) localUpdates.shared_points = [];
        localUpdates.shared_points.push({
            sender: senderName,
            text: msg.text || "📍 Position partagée",
            lat: lat,
            lng: lng,
            time: new Date().toISOString()
        });
        console.log(`[Télémétrie] Point GPS partagé détecté de ${senderName} : ${lat}, ${lng}`);
    }

    if (msg.text) {
        localUpdates.messages.push({
            sender: senderName,
            text: msg.text,
            time: new Date().toISOString()
        });
    } else if (msg.location) {
        localUpdates.messages.push({
            sender: senderName,
            text: `📍 Position partagée : ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            time: new Date().toISOString()
        });
    }
});

// Setup admin group command
bot.onText(/\/setup admin/, async (msg) => {
    if (msg.chat.type === 'private') {
        bot.sendMessage(msg.chat.id, "⚠️ Cette commande doit être exécutée dans le groupe Telegram destiné à l'administration/télémétrie.");
        return;
    }
    if (!dataState) return bot.sendMessage(msg.chat.id, "⚠️ L'état n'est pas encore chargé.");

    dataState.config.telegram_admin_group_id = msg.chat.id;
    console.log(`[Configuration] Groupe d'administration configuré avec l'ID : ${msg.chat.id}`);
    bot.sendMessage(msg.chat.id, "✅ Ce groupe a été configuré comme le groupe d'administration et de télémétrie.");
    await pushGitHubState("Configuration du groupe d'administration Telegram");
});

// Setup chat/participants group command
bot.onText(/\/setup chat/, async (msg) => {
    if (msg.chat.type === 'private') {
        bot.sendMessage(msg.chat.id, "⚠️ Cette commande doit être exécutée dans le groupe Telegram destiné aux participants.");
        return;
    }
    if (!dataState) return bot.sendMessage(msg.chat.id, "⚠️ L'état n'est pas encore chargé.");

    dataState.config.telegram_chat_group_id = msg.chat.id;
    console.log(`[Configuration] Groupe de discussion configuré avec l'ID : ${msg.chat.id}`);
    bot.sendMessage(msg.chat.id, "✅ Ce groupe a été configuré comme le groupe de discussion des participants.");
    await pushGitHubState("Configuration du groupe des participants Telegram");
});

// Handle /status command
bot.onText(/\/status/, (msg) => {
    if (!dataState) {
        bot.sendMessage(msg.chat.id, "⚠️ L'état du bot n'est pas encore complètement chargé.");
        return;
    }
    
    const isManual = process.env.IS_MANUAL_TRIGGER === 'true';
    const participantsCount = dataState.participants ? dataState.participants.length : 0;
    const activeLocationsCount = Object.keys(dataState.locations || {}).length;
    
    let timeText = "";
    if (isManual) {
        timeText = `Mode manuel (${process.env.MANUAL_DURATION}h)`;
    } else if (dataState.config.event_start) {
        const eventStart = new Date(dataState.config.event_start);
        const durationHours = dataState.config.event_duration || 4;
        const eventEnd = new Date(eventStart.getTime() + durationHours * 60 * 60 * 1000);
        const now = new Date();
        const leftMs = eventEnd - now;
        if (leftMs > 0) {
            timeText = `${Math.ceil(leftMs / 60000)} mins restantes`;
        } else {
            timeText = "Terminé";
        }
    } else {
        timeText = "Non planifié";
    }

    const report = `📊 *Status du Live Tracker* :\n` +
                   `⏱️ *Temps* : \`${timeText}\`\n` +
                   `👥 *Participants enregistrés* : \`${participantsCount}\`\n` +
                   `📍 *Marqueurs actifs* : \`${activeLocationsCount}\``;
    
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
});

// Load state and begin
loadGitHubState();
