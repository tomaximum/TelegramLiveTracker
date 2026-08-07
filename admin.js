// GitHub API Configuration & Initialization
let GITHUB_OWNER = localStorage.getItem('GITHUB_OWNER') || 'tomaximum';
let GITHUB_REPO = localStorage.getItem('GITHUB_REPO') || 'TelegramLiveTracker';

let dataState = null;
let dataSha = '';
let qrCodeGenerator = null;

document.addEventListener('DOMContentLoaded', () => {
    // If not set, try to auto-detect from GitHub Pages URL
    const host = window.location.hostname;
    if (host.includes('.github.io')) {
        GITHUB_OWNER = host.split('.')[0];
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        GITHUB_REPO = pathParts[0] || '';
        localStorage.setItem('GITHUB_OWNER', GITHUB_OWNER);
        localStorage.setItem('GITHUB_REPO', GITHUB_REPO);
    }

    const savedTgLink = localStorage.getItem('TELEGRAM_LINK') || '';
    document.getElementById('tg-link').value = savedTgLink;

    loadDataFromGitHub().then(() => {
        if (savedTgLink) {
            generateQrCode(savedTgLink);
        }
    });

    setupEventListeners();
});

function setupEventListeners() {
    document.getElementById('btn-upload-gpx').addEventListener('click', uploadGpxAndInfo);
    document.getElementById('btn-gen-qr').addEventListener('click', handleQrGeneration);
    document.getElementById('btn-add-wp').addEventListener('click', addWaypoint);
    document.getElementById('btn-encrypt-save').addEventListener('click', saveEncryptedPAT);

    // Danger Zone buttons
    document.getElementById('btn-clear-locations').addEventListener('click', () => confirmAction('locations', clearLocations));
    document.getElementById('btn-clear-messages').addEventListener('click', () => confirmAction('messages', clearMessages));
    document.getElementById('btn-clear-waypoints').addEventListener('click', () => confirmAction('waypoints', clearWaypoints));
}

// Fetch data.json from GitHub (read-only, no token needed for public repos!)
async function loadDataFromGitHub() {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/data.json`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        if (!response.ok) throw new Error("Impossible de charger le fichier data.json depuis GitHub.");
        
        const fileInfo = await response.json();
        dataSha = fileInfo.sha;
        const contentDecoded = decodeURIComponent(escape(atob(fileInfo.content)));
        dataState = JSON.parse(contentDecoded);

        populateUI();
    } catch (err) {
        console.error(err);
        alert("Erreur lors du chargement des données depuis GitHub. Vérifiez que votre dépôt est public et contient le fichier data.json.");
    }
}

// Helper to decrypt GITHUB_TOKEN
function getDecryptedToken() {
    const passwordInput = document.getElementById('admin-password').value.trim();
    if (!passwordInput) {
        alert("Veuillez entrer le Mot de passe d'administration.");
        return null;
    }

    if (!dataState || !dataState.config || !dataState.config.encrypted_pat) {
        alert("Aucun jeton d'accès GitHub chiffré n'a été trouvé dans data.json. Veuillez configurer le jeton ci-dessous en premier.");
        return null;
    }

    try {
        const decryptedBytes = CryptoJS.AES.decrypt(dataState.config.encrypted_pat, passwordInput);
        const decryptedToken = decryptedBytes.toString(CryptoJS.enc.Utf8);
        
        if (!decryptedToken || !decryptedToken.startsWith('gh')) {
            throw new Error("Mot de passe incorrect ou jeton invalide.");
        }
        return decryptedToken;
    } catch (err) {
        alert("Mot de passe d'administration incorrect ou décryptage échoué.");
        return null;
    }
}

// Push updated dataState back to GitHub using the supplied token
async function pushDataToGitHub(commitMessage, token) {
    if (!token) return false;
    
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/data.json`;
    const contentEncoded = btoa(unescape(encodeURIComponent(JSON.stringify(dataState, null, 2))));
    
    try {
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: commitMessage,
                content: contentEncoded,
                sha: dataSha
            })
        });

        if (!response.ok) throw new Error("Échec de la mise à jour sur GitHub. Vérifiez la validité du jeton (PAT).");
        
        const result = await response.json();
        dataSha = result.content.sha; // update SHA
        return true;
    } catch (err) {
        console.error(err);
        alert("Erreur de sauvegarde GitHub: " + err.message);
        return false;
    }
}

// Initial setup helper to encrypt PAT and save it in data.json using itself
async function saveEncryptedPAT() {
    const pat = document.getElementById('init-pat').value.trim();
    const password = document.getElementById('init-password').value.trim();

    if (!pat || !password) {
        return alert("Veuillez saisir le jeton PAT et le mot de passe de chiffrement.");
    }

    // Try to load the data first using the provided PAT if it failed initially (e.g., private repo)
    if (!dataState) {
        try {
            const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/data.json`;
            const response = await fetch(url, {
                headers: {
                    'Authorization': `token ${pat}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (!response.ok) throw new Error("Jeton invalide ou fichier introuvable.");
            
            const fileInfo = await response.json();
            dataSha = fileInfo.sha;
            const contentDecoded = decodeURIComponent(escape(atob(fileInfo.content)));
            dataState = JSON.parse(contentDecoded);
        } catch (err) {
            return alert("Erreur : Impossible de récupérer data.json. Vérifiez la validité de votre jeton PAT et le nom du dépôt.");
        }
    }

    // Encrypt token
    const encrypted = CryptoJS.AES.encrypt(pat, password).toString();
    dataState.config.encrypted_pat = encrypted;

    // Save back to GitHub using the entered PAT itself
    const success = await pushDataToGitHub("Chiffrement et configuration du jeton d'administration (PAT)", pat);
    if (success) {
        alert("Jeton chiffré et enregistré dans le dépôt avec succès ! Vous pouvez maintenant utiliser votre mot de passe d'administration.");
        document.getElementById('init-pat').value = '';
        document.getElementById('init-password').value = '';
        populateUI(); // Refresh UI lists
    }
}

function populateUI() {
    if (!dataState) return;

    document.getElementById('event-title-input').value = dataState.config.title || '';
    document.getElementById('event-desc-input').value = dataState.config.description || '';
    document.getElementById('event-cleanup-input').value = dataState.config.cleanup_days || 3;

    if (dataState.config.telegram_link) {
        document.getElementById('tg-link').value = dataState.config.telegram_link;
        localStorage.setItem('TELEGRAM_LINK', dataState.config.telegram_link);
    }

    loadParticipantsTable();
}

// Upload GPX, Title, Description, and Cleanup days
async function uploadGpxAndInfo() {
    const token = getDecryptedToken();
    if (!token) return;

    const title = document.getElementById('event-title-input').value.trim();
    const desc = document.getElementById('event-desc-input').value.trim();
    const cleanupDays = parseInt(document.getElementById('event-cleanup-input').value) || 3;
    const gpxFileInput = document.getElementById('gpx-file');

    dataState.config.title = title;
    dataState.config.description = desc;
    dataState.config.cleanup_days = cleanupDays;

    if (gpxFileInput.files.length > 0) {
        const file = gpxFileInput.files[0];
        const reader = new FileReader();
        
        reader.onload = async function(e) {
            dataState.config.gpx = e.target.result;
            const success = await pushDataToGitHub("Mise à jour du tracé GPX et de la configuration", token);
            if (success) alert('Configuration et GPX mis à jour avec succès !');
        };
        reader.readAsText(file);
    } else {
        const success = await pushDataToGitHub("Mise à jour de la configuration de l'événement", token);
        if (success) alert('Configuration mise à jour avec succès !');
    }
}

function handleQrGeneration() {
    const token = getDecryptedToken();
    if (!token) return;

    const link = document.getElementById('tg-link').value.trim();
    if (!link) return alert('Veuillez saisir un lien valide.');
    
    dataState.config.telegram_link = link;
    pushDataToGitHub("Mise à jour du lien d'inscription Telegram", token).then((success) => {
        if (success) {
            localStorage.setItem('TELEGRAM_LINK', link);
            generateQrCode(link);
        }
    });
}

function generateQrCode(text) {
    const qrContainer = document.getElementById('qr-section');
    const qrDiv = document.getElementById('qrcode');
    qrDiv.innerHTML = ''; 
    qrContainer.style.display = 'flex';

    qrCodeGenerator = new QRCode(qrDiv, {
        text: text,
        width: 180,
        height: 180,
        colorDark : "#0f172a",
        colorLight : "#ffffff",
        correctLevel : QRCode.CorrectLevel.H
    });
}

// Add Waypoints
async function addWaypoint() {
    const token = getDecryptedToken();
    if (!token) return;

    const name = document.getElementById('wp-name').value.trim();
    const desc = document.getElementById('wp-desc').value.trim();
    const lat = parseFloat(document.getElementById('wp-lat').value);
    const lng = parseFloat(document.getElementById('wp-lng').value);
    const icon = document.getElementById('wp-icon').value;

    if (!name || isNaN(lat) || isNaN(lng)) {
        return alert('Veuillez remplir au moins le nom, la latitude et la longitude.');
    }

    const newWp = {
        name: name,
        description: desc,
        lat: lat,
        lng: lng,
        icon: icon
    };

    if (!dataState.waypoints) dataState.waypoints = [];
    dataState.waypoints.push(newWp);

    const success = await pushDataToGitHub(`Ajout du Waypoint: ${name}`, token);
    if (success) {
        alert('Waypoint ajouté avec succès !');
        document.getElementById('wp-name').value = '';
        document.getElementById('wp-desc').value = '';
        document.getElementById('wp-lat').value = '';
        document.getElementById('wp-lng').value = '';
    }
}

// Render participants table
function loadParticipantsTable() {
    const tbody = document.querySelector('#participants-table tbody');
    tbody.innerHTML = '';

    const list = dataState.participants || [];

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 20px; color: var(--text-secondary);">Aucun participant enregistré</td></tr>`;
        return;
    }

    list.forEach(p => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255, 255, 255, 0.05)';
        tr.innerHTML = `
            <td style="padding: 12px; font-weight: 500;">
                ${p.display_name}<br>
                <span style="font-size: 0.8rem; color: var(--text-secondary);">@${p.username || 'N/A'}</span>
            </td>
            <td style="padding: 12px; font-family: monospace; color: var(--text-secondary);">${p.telegram_id}</td>
            <td style="padding: 12px;">
                <div style="display: flex; gap: 8px; align-items: center;">
                    <input type="color" value="${p.color}" class="color-picker" style="border: none; background: none; cursor: pointer; width: 30px; height: 30px;">
                    <select class="icon-selector form-control" style="padding: 4px; font-size: 0.8rem;">
                        <option value="motorcycle" ${p.icon === 'motorcycle' ? 'selected' : ''}>🏍️ Moto</option>
                        <option value="hiker" ${p.icon === 'hiker' ? 'selected' : ''}>🥾 Marcheur</option>
                        <option value="car" ${p.icon === 'car' ? 'selected' : ''}>🚗 Voiture</option>
                        <option value="bicycle" ${p.icon === 'bicycle' ? 'selected' : ''}>🚲 Vélo</option>
                    </select>
                </div>
            </td>
            <td style="padding: 12px; text-align: right;">
                <button class="btn btn-danger btn-secondary btn-delete" style="padding: 6px 12px; font-size: 0.8rem;">
                    <i class="fa-solid fa-trash"></i> Retirer
                </button>
            </td>
        `;

        // Change triggers
        tr.querySelector('.color-picker').addEventListener('change', async (e) => {
            const token = getDecryptedToken();
            if (!token) return;
            p.color = e.target.value;
            await pushDataToGitHub(`Mise à jour couleur de ${p.display_name}`, token);
        });

        tr.querySelector('.icon-selector').addEventListener('change', async (e) => {
            const token = getDecryptedToken();
            if (!token) return;
            p.icon = e.target.value;
            await pushDataToGitHub(`Mise à jour icône de ${p.display_name}`, token);
        });

        tr.querySelector('.btn-delete').addEventListener('click', async () => {
            const token = getDecryptedToken();
            if (!token) return;
            if (confirm(`Voulez-vous vraiment retirer le participant ${p.display_name} ?`)) {
                dataState.participants = dataState.participants.filter(pt => pt.telegram_id !== p.telegram_id);
                if (dataState.locations[p.telegram_id]) delete dataState.locations[p.telegram_id];
                
                const success = await pushDataToGitHub(`Suppression du participant ${p.display_name}`, token);
                if (success) loadParticipantsTable();
            }
        });

        tbody.appendChild(tr);
    });
}

function confirmAction(type, callback) {
    const confirmation = confirm(`ATTENTION: Êtes-vous sûr de vouloir supprimer TOUTES les données de type "${type}" ? Cette action est irréversible.`);
    if (confirmation) {
        callback();
    }
}

// Clear GPS history
async function clearLocations() {
    const token = getDecryptedToken();
    if (!token || !dataState) return;
    dataState.locations = {};
    const success = await pushDataToGitHub("Effacement de l'historique des positions", token);
    if (success) alert('Historique des positions vidé !');
}

// Clear Chat Messages
async function clearMessages() {
    const token = getDecryptedToken();
    if (!token || !dataState) return;
    dataState.messages = [];
    const success = await pushDataToGitHub("Effacement de l'historique du chat", token);
    if (success) alert('Chat effacé !');
}

// Clear Waypoints
async function clearWaypoints() {
    const token = getDecryptedToken();
    if (!token || !dataState) return;
    dataState.waypoints = [];
    const success = await pushDataToGitHub("Suppression de tous les waypoints", token);
    if (success) alert('Waypoints supprimés !');
}
