const { ipcRenderer } = require('electron');

// Variables globales
let currentServerInfo = null;
let currentStats = null;
let currentNickname = '';
let isSelectingPath = false;
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

// Sistema de Nickname
const nicknameInput = document.getElementById('nickname-input');

// Validar formato de nickname
function validateNickname(nickname) {
    if (!nickname || nickname.length < 3 || nickname.length > 24) {
        return false;
    }
    // Formato: Nombre_Apellido (solo letras y un underscore)
    const regex = /^[A-Za-z]+_[A-Za-z]+$/;
    return regex.test(nickname);
}

// Cargar nickname guardado
async function loadNickname() {
    ipcRenderer.send('get-nickname');
}

async function selectInstallPath() {
    if (isSelectingPath) return;
    isSelectingPath = true;

    try {
        const result = await ipcRenderer.invoke('select-install-path');

        if (result.canceled) {
            isSelectingPath = false;
            return null;
        }

        if (!result.success) {
            showNotification(result.message || 'Error al seleccionar la carpeta', 'error');
            isSelectingPath = false;
            return null;
        }

        // Actualizar UI con la nueva ruta
        const pathInput = document.getElementById('install-path');
        if (pathInput) {
            pathInput.value = result.path;
        }

        showNotification(`Ruta seleccionada: ${result.path}`, 'success');
        isSelectingPath = false;
        return result.path;

    } catch (error) {
        console.error('Error seleccionando ruta:', error);
        showNotification('Error al seleccionar la carpeta', 'error');
        isSelectingPath = false;
        return null;
    }
}

// Recibir nickname actual
ipcRenderer.on('nickname-current', (event, nickname) => {
    currentNickname = nickname || '';
    if (nicknameInput) {
        nicknameInput.value = currentNickname;
        updateNicknameUI();
    }
});

ipcRenderer.on('request-install-path', async () => {
    await showInstallPathDialog();
});

// Actualizar UI del nickname
function updateNicknameUI() {
    const isValid = validateNickname(nicknameInput.value);

    if (isValid) {
        nicknameInput.style.borderColor = '';
    } else if (nicknameInput.value) {
        nicknameInput.style.borderColor = 'var(--danger)';
    }
}

// Event listeners para nickname
if (nicknameInput) {
    nicknameInput.addEventListener('input', updateNicknameUI);

    nicknameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !saveNicknameBtn.disabled) {
            saveNicknameBtn.click();
        }
    });
}

async function showInstallPathDialog() {
    const confirmed = confirm(
        '¡Bienvenido a Horizon Roleplay!\n\n' +
        'Antes de descargar, elige dónde quieres instalar el juego.\n\n' +
        'Se creará una carpeta "GTA Horizon" en la ubicación que elijas.\n' +
        'Necesitarás aproximadamente 2 GB de espacio libre.\n\n' +
        '¿Continuar?'
    );

    if (!confirmed) return false;

    const result = await ipcRenderer.invoke('select-install-path');

    if (result.canceled) {
        return false;
    }

    if (!result.success) {
        showNotification(result.message || 'Error al seleccionar la carpeta', 'error');
        return false;
    }

    // Actualizar UI
    const pathInput = document.getElementById('install-path');
    if (pathInput) {
        pathInput.value = result.path;
    }

    showNotification('Ubicación seleccionada. Iniciando descarga...', 'success');

    // Iniciar descarga
    ipcRenderer.send('start-download-with-path', result.path);
    return true;
}

// Sistema de notificaciones simple
function showNotification(message, type = 'info') {
    // Crear notificación temporal
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 50px;
        right: 20px;
        padding: 12px 20px;
        background: ${type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--primary)'};
        color: ${type === 'error' || type === 'success' ? 'white' : 'var(--bg-dark)'};
        border-radius: 8px;
        z-index: 10000;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        font-size: 14px;
        font-weight: 500;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}

// Añadir estilos de animación para notificaciones
const notificationStyles = document.createElement('style');
notificationStyles.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
`;
document.head.appendChild(notificationStyles);

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

playBtn.addEventListener('click', async () => {
    // Verificar servidor online
    if (currentServerInfo && !currentServerInfo.online) {
        showNotification('El servidor está offline. Intenta más tarde.', 'error');
        return;
    }

    // Verificar nickname
    const nickname = nicknameInput.value.trim();
    if (!validateNickname(nickname)) {
        showNotification('Ingresa un nickname válido (Nombre_Apellido)', 'error');
        nicknameInput.focus();
        nicknameInput.style.borderColor = 'var(--danger)';
        return;
    }

    // Verificar si hay ruta de instalación
    const hasPath = await ipcRenderer.invoke('has-install-path');
    const isInstalled = await ipcRenderer.invoke('check-gta-installed');

    if (!isInstalled && !hasPath) {
        // No hay instalación ni ruta, pedir que elija
        const selected = await showInstallPathDialog();
        if (!selected) return;

        // La descarga ya se inició en showInstallPathDialog
        return;
    }

    // Guardar nickname si cambió
    if (nickname !== currentNickname) {
        try {
            await ipcRenderer.invoke('save-nickname', nickname);
            currentNickname = nickname;
        } catch (error) {
            showNotification('Error al guardar el nickname', 'error');
            return;
        }
    }

    // Iniciar juego
    ipcRenderer.send('start-game-with-nickname', nickname);
});

// Recibir eventos del proceso de inicio del juego
ipcRenderer.on('game-starting', () => {
    showNotification('Iniciando el juego...', 'info');
});

async function updatePlayButton(isInstalled) {
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        const playText = playBtn.querySelector('.title');
        if (playText) {
            if (isInstalled) {
                playText.textContent = 'JUGAR';
            } else {
                playText.textContent = 'INSTALAR';
            }
        }
    }

    // También actualizar la ruta mostrada
    const pathInput = document.getElementById('install-path');
    if (pathInput) {
        const currentPath = await ipcRenderer.invoke('get-install-path');
        pathInput.value = currentPath || 'No configurado';
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
    if (progressText) progressText.textContent = '¡Descarga completa!';
    setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (playBtn) playBtn.style.display = 'flex';
        const verifyBtn = document.getElementById('verify-files-btn');
        if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.textContent = 'Verificar Archivos';
        }
    }, 3000);
    updatePlayButton(true);
    showNotification('Descarga completada exitosamente', 'success');
});

ipcRenderer.on('download-error', (_, error) => {
    if (progressText) progressText.textContent = 'Error: ' + error;
    if (progressFill) progressFill.style.background = 'var(--danger)';
    setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        if (playBtn) playBtn.style.display = 'flex';
        if (progressFill) progressFill.style.background = '';
        const verifyBtn = document.getElementById('verify-files-btn');
        if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.textContent = 'Verificar Archivos';
        }
    }, 3000);
    showNotification('Error en la descarga: ' + error, 'error');
});

ipcRenderer.on('game-error', (event, error) => {
    showNotification('Error al iniciar el juego: ' + error, 'error');
});

// Reinstalar juego
document.getElementById('reset-install-btn').addEventListener('click', () => {
    if (confirm('¿Estás seguro de que deseas reinstalar el juego? Esto eliminará todos los archivos descargados.')) {
        ipcRenderer.send('reset-installation');
    }
});

ipcRenderer.on('installation-reset', (event, message) => {
    showNotification(message, 'info');
    updatePlayButton(false);
});

// Copiar IP
function copyIP() {
    const serverIP = `${CONFIG.serverIP}:${CONFIG.serverPort}`;
    navigator.clipboard.writeText(serverIP);
    showNotification('IP copiada al portapapeles', 'success');
}

// Abrir enlaces externos
function openLink(url) {
    ipcRenderer.send('open-external', url);
}

// Mostrar ruta de instalación
ipcRenderer.on('installation-path', (event, installPath) => {
    const pathInput = document.getElementById('install-path');
    if (pathInput) {
        pathInput.value = installPath || 'No configurado';
    }
});

// Verificación de archivos
const verifyBtn = document.getElementById('verify-files-btn');
if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
        verifyBtn.disabled = true;
        verifyBtn.textContent = 'Verificando...';

        // Navegar a la sección "Home" para ver el progreso
        document.querySelector('.nav-item[data-section="home"]').click();

        // Mostrar UI de progreso
        if (playBtn) playBtn.style.display = 'none';
        if (progressContainer) progressContainer.style.display = 'block';
        if (progressText) progressText.textContent = 'Iniciando verificación de archivos...';
        if (progressFill) progressFill.style.width = '0%';
        if (progressPercent) progressPercent.textContent = '0%';
        if (downloadSpeed) downloadSpeed.textContent = '';
        if (downloadSize) downloadSize.textContent = '';

        await ipcRenderer.invoke('verify-files');
    });
}

ipcRenderer.on('game-update', (event, data) => {
    const verifyBtn = document.getElementById('verify-files-btn');

    if (data.state === 'uptodate') {
        if (progressText) progressText.textContent = 'Tus archivos ya están actualizados.';
        if (progressFill) progressFill.style.width = '100%';
        if (progressPercent) progressPercent.textContent = '100%';
        showNotification('Archivos verificados correctamente', 'success');
        setTimeout(() => {
            if (progressContainer) progressContainer.style.display = 'none';
            if (playBtn) playBtn.style.display = 'flex';
            if (verifyBtn) {
                verifyBtn.disabled = false;
                verifyBtn.textContent = 'Verificar Archivos';
            }
        }, 3000);
    } else if (data.state === 'available') {
        if (progressText) progressText.textContent = `Actualización encontrada. Descargando ${data.filesCount} archivos...`;
    }
});

// Obtener versión de la app al cargar
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const version = await ipcRenderer.invoke('app-version');
        const versionNode = document.getElementById('app-version');
        if (versionNode) versionNode.textContent = version;
    } catch (e) {
        console.warn('No se pudo obtener versión:', e);
    }

    // Cargar nickname guardado
    loadNickname();

    // Cargar ruta de instalación
    try {
        const installPath = await ipcRenderer.invoke('get-install-path');
        const pathInput = document.getElementById('install-path');
        if (pathInput) {
            pathInput.value = installPath || 'No configurado';
        }
    } catch (e) {
        console.warn('Error cargando ruta de instalación:', e);
    }

    ipcRenderer.send('request-server-info');

    try {
        const isInstalled = await ipcRenderer.invoke('check-gta-installed');
        updatePlayButton(isInstalled);
    } catch (e) {
        console.warn('Could not check if GTA is installed:', e);
        updatePlayButton(false);
    }
});


// Botón de "Examinar" para abrir la ruta de instalación
const browseBtn = document.querySelector('.browse-btn');
if (browseBtn) {
    browseBtn.addEventListener('click', () => {
        const installPath = document.getElementById('install-path').value;

        if (installPath && installPath !== 'No configurado' && installPath !== 'No instalado') {
            // Abrir la carpeta de instalación
            ipcRenderer.send('open-install-folder');
        } else {
            showNotification('El juego no está instalado todavía', 'info');
        }
    });
}

// Auto-guardar nickname cuando se pierde el foco
if (nicknameInput) {
    nicknameInput.addEventListener('blur', async () => {
        const nickname = nicknameInput.value.trim();
        if (validateNickname(nickname) && nickname !== currentNickname) {
            try {
                await ipcRenderer.invoke('save-nickname', nickname);
                currentNickname = nickname;
                nicknameInput.classList.add('nickname-saved');
                setTimeout(() => {
                    nicknameInput.classList.remove('nickname-saved');
                }, 500);
            } catch (error) {
                console.error('Error auto-guardando nickname:', error);
            }
        }
    });
}

// Configuración global del servidor (para copiar IP)
const CONFIG = {
    serverIP: '209.237.141.132',
    serverPort: 7777
};