// Automatic detection of GitHub Repo details from URL
let GITHUB_OWNER = '';
let GITHUB_REPO = '';

const host = window.location.hostname;
if (host.includes('.github.io')) {
    GITHUB_OWNER = host.split('.')[0];
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    GITHUB_REPO = pathParts[0] || '';
} else {
    // For local testing, get from localStorage or default to user's repo
    GITHUB_OWNER = localStorage.getItem('GITHUB_OWNER') || 'tomaximum';
    GITHUB_REPO = localStorage.getItem('GITHUB_REPO') || 'TelegramLiveTracker';
}

let map = null;
let gpxLayer = null;
const participantMarkers = {};
const participantTrails = {};
const waypointMarkers = [];
let participants = [];
let dataState = {};

const iconMap = {
    motorcycle: 'fa-motorcycle',
    hiker: 'fa-person-hiking',
    car: 'fa-car',
    bicycle: 'fa-bicycle',
    flag: 'fa-flag',
    star: 'fa-star',
    pin: 'fa-location-dot',
    check: 'fa-circle-check'
};

document.addEventListener('DOMContentLoaded', () => {
    if (!GITHUB_OWNER || !GITHUB_REPO) {
        showSetupModal();
        return;
    }

    initMap();
    startPolling();
});

// Prompt for local testing configuration
function showSetupModal() {
    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.background = 'rgba(15, 23, 42, 0.9)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.zIndex = '10000';
    modal.innerHTML = `
        <div class="admin-card" style="width: 450px;">
            <h2>Configuration GitHub requise</h2>
            <p style="color: var(--text-secondary); font-size: 0.9rem;">
                Pour tester localement, veuillez saisir le propriétaire et le nom de votre dépôt GitHub.
            </p>
            <div class="form-group">
                <label>Nom d'utilisateur GitHub (Owner)</label>
                <input type="text" id="setup-owner" class="form-control" placeholder="Ex: tomaximum">
            </div>
            <div class="form-group">
                <label>Nom du Dépôt (Repository)</label>
                <input type="text" id="setup-repo" class="form-control" placeholder="Ex: TelegramLiveTracker">
            </div>
            <button class="btn" id="btn-save-setup">Sauvegarder et recharger</button>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('btn-save-setup').addEventListener('click', () => {
        const owner = document.getElementById('setup-owner').value.trim();
        const repo = document.getElementById('setup-repo').value.trim();
        if (owner && repo) {
            localStorage.setItem('GITHUB_OWNER', owner);
            localStorage.setItem('GITHUB_REPO', repo);
            window.location.reload();
        } else {
            alert('Veuillez remplir tous les champs');
        }
    });
}

function initMap() {
    map = L.map('map', {
        zoomControl: false
    }).setView([46.603354, 1.888334], 6);

    L.control.zoom({
        position: 'bottomleft'
    }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
}

// Fetch data.json from GitHub raw content (unlimited hits, bypasses cache via timestamp)
async function fetchData() {
    const timestamp = new Date().getTime();
    const url = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/data.json?t=${timestamp}`;
    
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error("Impossible de récupérer les données.");
        const data = await response.json();
        
        updateUI(data);
    } catch (err) {
        console.error("Erreur lors de la récupération des données:", err);
    }
}

function startPolling() {
    fetchData(); // first load
    setInterval(fetchData, 30000); // refresh every 30 seconds
}

function updateUI(data) {
    // Check if GPX or basic config changed
    if (JSON.stringify(data.config) !== JSON.stringify(dataState.config)) {
        document.getElementById('event-title').textContent = data.config.title || 'Live Tracker';
        document.getElementById('event-description').textContent = data.config.description || '';
        
        const btnJoin = document.getElementById('btn-join-event');
        if (btnJoin) {
            if (data.config.telegram_link) {
                btnJoin.href = data.config.telegram_link;
                btnJoin.style.display = 'flex';
            } else {
                btnJoin.style.display = 'none';
            }
        }

        if (data.config.gpx && (!dataState.config || data.config.gpx !== dataState.config.gpx)) {
            loadGPXTrack(data.config.gpx);
        }
        dataState.config = data.config;
    }

    // Update Waypoints
    if (JSON.stringify(data.waypoints) !== JSON.stringify(dataState.waypoints)) {
        renderWaypoints(data.waypoints);
        dataState.waypoints = data.waypoints;
    }

    // Update Participants and Locations
    participants = data.participants || [];
    document.getElementById('participant-count').textContent = participants.length;

    participants.forEach(p => {
        const locHistory = data.locations[p.telegram_id];
        if (locHistory && locHistory.length > 0) {
            const latest = locHistory[locHistory.length - 1];
            p.lat = latest.lat;
            p.lng = latest.lng;
            p.speed = latest.speed;
            p.last_updated = latest.time;
            p.history = locHistory.map(l => [l.lat, l.lng]);

            updateMapMarker(p);
        }
    });

    renderParticipantList();

    // Update messages
    if (JSON.stringify(data.messages) !== JSON.stringify(dataState.messages)) {
        renderChatMessages(data.messages || []);
        dataState.messages = data.messages;
    }
}

function loadGPXTrack(gpxString) {
    if (gpxLayer) {
        map.removeLayer(gpxLayer);
    }

    const blankImg = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    gpxLayer = new L.GPX(gpxString, {
        async: true,
        marker_options: {
            startIconUrl: blankImg,
            endIconUrl: blankImg,
            shadowUrl: blankImg,
            wptIconUrls: {
                '': blankImg
            }
        },
        polyline_options: {
            color: '#3b82f6',
            opacity: 0.75,
            weight: 4,
            lineCap: 'round'
        }
    }).on('loaded', function(e) {
        map.fitBounds(e.target.getBounds(), { padding: [50, 50] });
    }).addTo(map);
}

function renderWaypoints(waypoints) {
    // Clear old
    waypointMarkers.forEach(m => map.removeLayer(m));
    waypointMarkers.length = 0;

    waypoints.forEach(wp => {
        const fontAwesomeClass = iconMap[wp.icon] || 'fa-location-dot';
        const customIcon = L.divIcon({
            className: 'custom-div-icon',
            html: `
                <div class="marker-pin" style="background-color: #8b5cf6;">
                    <i class="fa-solid ${fontAwesomeClass}"></i>
                </div>
            `,
            iconSize: [30, 42],
            iconAnchor: [15, 42],
            popupAnchor: [0, -36]
        });

        const marker = L.marker([wp.lat, wp.lng], { icon: customIcon })
            .bindPopup(`<strong>${wp.name}</strong><br>${wp.description || ''}`)
            .addTo(map);

        waypointMarkers.push(marker);
    });
}

function updateMapMarker(p) {
    const latlng = [p.lat, p.lng];
    const color = p.color || '#ef4444';
    const fontAwesomeClass = iconMap[p.icon] || 'fa-motorcycle';

    if (p.history && p.history.length > 1) {
        if (participantTrails[p.telegram_id]) {
            participantTrails[p.telegram_id].setLatLngs(p.history);
        } else {
            participantTrails[p.telegram_id] = L.polyline(p.history, {
                color: color,
                opacity: 0.5,
                weight: 3,
                dashArray: '5, 10'
            }).addTo(map);
        }
    }

    const htmlMarker = `
        <div class="marker-pulse"></div>
        <div class="marker-pin" style="background-color: ${color};">
            <i class="fa-solid ${fontAwesomeClass}"></i>
        </div>
    `;

    if (participantMarkers[p.telegram_id]) {
        participantMarkers[p.telegram_id].setLatLng(latlng);
        participantMarkers[p.telegram_id].getPopup().setContent(getPopupContent(p));
    } else {
        const customIcon = L.divIcon({
            className: 'custom-div-icon',
            html: htmlMarker,
            iconSize: [32, 42],
            iconAnchor: [16, 42],
            popupAnchor: [0, -36]
        });

        const marker = L.marker(latlng, { icon: customIcon })
            .bindPopup(getPopupContent(p))
            .addTo(map);

        participantMarkers[p.telegram_id] = marker;
    }
}

function getPopupContent(p) {
    const speedText = p.speed !== null && p.speed !== undefined ? `${Math.round(p.speed * 3.6)} km/h` : 'N/A'; // conversion standard
    const timeText = new Date(p.last_updated).toLocaleTimeString();
    return `
        <div style="font-family: var(--font-sans); color: #000; min-width: 150px;">
            <strong style="font-size: 1.1rem; color: ${p.color};">${p.display_name}</strong><br>
            <span style="font-size: 0.85rem; color: #555;">@${p.username || 'N/A'}</span>
            <hr style="margin: 8px 0; border: none; border-top: 1px solid #ddd;">
            <table style="width: 100%; font-size: 0.85rem;">
                <tr><td><strong>Vitesse:</strong></td><td style="text-align: right;">${speedText}</td></tr>
                <tr><td><strong>Mise à jour:</strong></td><td style="text-align: right;">${timeText}</td></tr>
            </table>
        </div>
    `;
}

function renderParticipantList() {
    const container = document.getElementById('participants');
    container.innerHTML = '';

    if (participants.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); margin-top: 20px;">Aucun participant actif</div>`;
        return;
    }

    participants.forEach(p => {
        const isOnline = p.last_updated && (new Date() - new Date(p.last_updated)) < 10 * 60 * 1000; // 10 minutes threshold
        const speedText = p.speed !== null && p.speed !== undefined ? `${Math.round(p.speed * 3.6)} km/h` : '--';
        const initials = p.display_name.slice(0, 2).toUpperCase();

        const card = document.createElement('div');
        card.className = 'participant-card';
        card.innerHTML = `
            <div class="participant-avatar" style="background-color: ${p.color || '#555'}">${initials}</div>
            <div class="participant-info">
                <div class="participant-name">${p.display_name}</div>
                <div class="participant-meta">
                    <span class="status-dot ${isOnline ? 'status-online' : 'status-offline'}"></span>
                    <span>${isOnline ? 'En ligne' : 'Hors ligne'}</span>
                    <span>•</span>
                    <span>${speedText}</span>
                </div>
            </div>
            <i class="fa-solid fa-chevron-right" style="color: var(--text-secondary); font-size: 0.8rem;"></i>
        `;

        card.addEventListener('click', () => {
            if (p.lat && p.lng) {
                map.setView([p.lat, p.lng], 15);
                if (participantMarkers[p.telegram_id]) {
                    participantMarkers[p.telegram_id].openPopup();
                }
            }
        });

        container.appendChild(card);
    });
}

function renderChatMessages(messages) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';

    if (messages.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); margin-top: 20px;">Aucun message récent</div>`;
        return;
    }

    // Display last 25 messages
    const recent = messages.slice(-25);
    recent.forEach(msg => {
        const time = new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.innerHTML = `
            <div class="chat-bubble-sender">${msg.sender}</div>
            <div class="chat-bubble-text">${escapeHtml(msg.text)}</div>
            <div class="chat-bubble-time">${time}</div>
        `;
        container.appendChild(bubble);
    });

    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
