const { ipcRenderer } = require('electron');

// Variables globales
let currentServerInfo = null;
let currentStats = null;

// Controles de ventana
document.getElementById('minimize-btn').addEventListener('click', () => {
    ipcRenderer.send('minimize-window');
});

document.getElementById('close-btn').addEventListener('click', () => {
    ipcRenderer.send('close-window');
});

// Navegación entre secciones
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', function () {
        document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
        document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));

        this.classList.add('active');
        const sectionId = this.getAttribute('data-section');
        document.getElementById(sectionId).classList.add('active');

        // Solicitar actualización de datos según la sección
        if (sectionId === 'stats') {
            ipcRenderer.send('request-statistics');
        } else if (sectionId === 'home') {
            ipcRenderer.send('request-server-info');
        }
    });
});

// Recibir actualización de información del servidor
ipcRenderer.on('server-info-update', (event, serverInfo) => {
    currentServerInfo = serverInfo;
    updateServerDisplay(serverInfo);
});

// Actualizar display del servidor
function updateServerDisplay(serverInfo) {
    const statusIndicator = document.querySelector('.status-indicator');
    const statusText = document.querySelector('.status-header span:last-child');

    if (serverInfo.online) {
        statusIndicator.classList.remove('offline');
        statusIndicator.classList.add('online');
        statusText.textContent = 'Servidor Online';

        document.getElementById('player-count').textContent = `${serverInfo.players}/${serverInfo.maxPlayers}`;

        const pingElement = document.querySelector('.detail-item:nth-child(2) .detail-value');
        if (pingElement) pingElement.textContent = `${serverInfo.ping}ms`;

        const heroCounter = document.getElementById('hero-player-count');
        if (heroCounter) heroCounter.textContent = serverInfo.players;

        const versionElement = document.querySelector('.detail-item:nth-child(3) .detail-value');
        if (versionElement) versionElement.textContent = serverInfo.gamemode || '0.3.DL';
    } else {
        statusIndicator.classList.remove('online');
        statusIndicator.classList.add('offline');
        statusText.textContent = 'Servidor Offline';

        document.getElementById('player-count').textContent = '0/500';
        const pingElement = document.querySelector('.detail-item:nth-child(2) .detail-value');
        if (pingElement) pingElement.textContent = '0ms';
        const heroCounter = document.getElementById('hero-player-count');
        if (heroCounter) heroCounter.textContent = '0';
    }
}

// Estadísticas
ipcRenderer.on('statistics-update', (event, stats) => {
    currentStats = stats;
    updateStatisticsDisplay(stats);
});

function updateStatisticsDisplay(stats) {
    if (!stats) return;

    const statsHTML = `
        <div class="stat-card">
            <div class="stat-value">${stats.totalUsers.toLocaleString()}</div>
            <div class="stat-label">Usuarios Registrados</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${currentServerInfo ? currentServerInfo.players : 0}</div>
            <div class="stat-label">Jugadores Online</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.availableHouses}</div>
            <div class="stat-label">Casas Disponibles</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.activeBusiness}</div>
            <div class="stat-label">Negocios Activos</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.totalVehicles.toLocaleString()}</div>
            <div class="stat-label">Vehículos Totales</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.activeFactions}</div>
            <div class="stat-label">Facciones Activas</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">$${(stats.totalEconomy / 1000000).toFixed(1)}M</div>
            <div class="stat-label">Economía Total</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.today.newUsersToday}</div>
            <div class="stat-label">Nuevos Usuarios Hoy</div>
        </div>
    `;

    const statsGrid = document.querySelector('.stats-grid');
    if (statsGrid) statsGrid.innerHTML = statsHTML;

    if (stats.topPlayers && stats.topPlayers.length > 0) {
        updateTopPlayers(stats.topPlayers);
    }
}

// Noticias
ipcRenderer.on('news-update', (event, news) => updateNewsDisplay(news));

function updateNewsDisplay(news) {
    if (!news || news.length === 0) return;

    const newsGrid = document.querySelector('.news-grid');
    if (!newsGrid) return;

    const featured = news[0];
    const otherNews = news.slice(1, 4);

    const newsHTML = `
        <article class="news-card featured">
            ${featured.image_url ? `<div class="news-image" style="background-image: url('${featured.image_url}')"></div>` : '<div class="news-image"></div>'}
            <div class="news-content">
                <span class="news-date">${featured.date}</span>
                <h3>${featured.title}</h3>
                <p>${featured.content}</p>
                <button class="read-more" onclick="openLink('https://horizonrp.es/news/${featured.id}')">Leer más →</button>
            </div>
        </article>
        ${otherNews.map(article => `
            <article class="news-card">
                <span class="news-date">${article.date}</span>
                <h3>${article.title}</h3>
                <p>${article.content.substring(0, 100)}...</p>
            </article>
        `).join('')}
    `;
    newsGrid.innerHTML = newsHTML;
}

// Botón de jugar y progreso
const playBtn = document.getElementById('play-btn');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const progressPercent = document.getElementById('progress-percent');
const downloadSpeed = document.getElementById('download-speed');
const downloadSize = document.getElementById('download-size');

playBtn.addEventListener('click', () => {
    if (currentServerInfo && !currentServerInfo.online) {
        alert('El servidor está actualmente offline. Por favor, intenta más tarde.');
        return;
    }
    ipcRenderer.send('open-nickname-window');
});

function updatePlayButton(isInstalled) {
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        const playText = playBtn.querySelector('.play-text');
        if(playText) {
            if (isInstalled) {
                playText.textContent = 'JUGAR AHORA';
            } else {
                playText.textContent = 'INSTALAR';
            }
        }
    }
}

ipcRenderer.on('download-progress', (_, data) => {
    // Mostrar UI de progreso siempre que llegue progreso
    if (playBtn) playBtn.style.display = 'none';
    if (progressContainer) progressContainer.style.display = 'block';

    const percent = Math.round(data.percent || 0);
    if (progressFill) progressFill.style.width = percent + '%';
    if (progressPercent) progressPercent.textContent = percent + '%';
    if (progressText) progressText.textContent = data.message || 'Descargando archivos...';

    if (downloadSpeed && data.speed) downloadSpeed.textContent = (data.speed / 1024 / 1024).toFixed(2) + ' MB / s';
    if (downloadSize && data.current && data.total) {
        const currentMB = (data.current / 1024 / 1024).toFixed(2);
        const totalMB = (data.total / 1024 / 1024).toFixed(2);
        downloadSize.textContent = `${currentMB}/${totalMB} MB`;
    }
});

ipcRenderer.on('download-complete', () => {
    if (progressText) progressText.textContent = '¡Descarga completa! Iniciando juego...';
    setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (playBtn) playBtn.style.display = 'flex';
    }, 3000);
    updatePlayButton(true);
});

ipcRenderer.on('download-error', (_, error) => {
    if (progressText) progressText.textContent = 'Error: ' + error;
    if (progressFill) progressFill.style.background = 'var(--danger)';
    setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (playBtn) playBtn.style.display = 'flex';
        if (progressFill) progressFill.style.background = '';
    }, 3000);
});

ipcRenderer.on('game-error', (event, error) => alert('Error al iniciar el juego: ' + error));

// Reinstalar juego
document.getElementById('reset-install-btn').addEventListener('click', () => {
    if (confirm('¿Estás seguro de que deseas reinstalar el juego? Esto eliminará todos los archivos descargados.')) {
        ipcRenderer.send('reset-installation');
    }
});

ipcRenderer.on('installation-reset', (event, message) => {
    alert(message);
    updatePlayButton(false);
});

// Copiar IP
function copyIP() {
    const serverIP = `${currentServerInfo ? currentServerInfo.host : 'samp.horizonrp.es'}:7777`;
    navigator.clipboard.writeText(serverIP);

    const copyBtn = document.querySelector('.copy-btn');
    const originalText = copyBtn.textContent;
    copyBtn.textContent = '✓';
    setTimeout(() => copyBtn.textContent = originalText, 1000);
}

// Abrir enlaces externos
function openLink(url) {
    ipcRenderer.send('open-external', url);
}

// Mostrar ruta de instalación
ipcRenderer.on('installation-path', (event, installPath) => {
    const pathInput = document.getElementById('install-path');
    if (pathInput) pathInput.value = installPath;
});

// Obtener versión de la app al cargar
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const version = await ipcRenderer.invoke('app-version');
        const versionNode = document.getElementById('app-version');
        if (versionNode) versionNode.textContent = version; // quedará como "Launcher v1.0.22"
    } catch (e) {
        console.warn('No se pudo obtener versión:', e);
    }

    ipcRenderer.send('get-installation-path');
    ipcRenderer.send('request-server-info');

    try {
        const isInstalled = await ipcRenderer.invoke('check-gta-installed');
        updatePlayButton(isInstalled);
    } catch (e) {
        console.warn('Could not check if GTA is installed:', e);
        updatePlayButton(false); // Assume not installed on error
    }
});

// Botón de "Examinar" para abrir la ruta de instalación
const browseBtn = document.querySelector('.browse-btn');
if (browseBtn) {
    browseBtn.addEventListener('click', () => {
        const installPath = document.getElementById('install-path').value;
        if (installPath && installPath !== 'No instalado') {
            ipcRenderer.send('open-path', installPath);
        }
    });
}