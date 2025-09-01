const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const https = require('https');
const unzipper = require('unzipper');
const regedit = require('regedit');
const query = require('samp-query');
const GameAPI = require('./src/services/api');
const { autoUpdater } = require('electron-updater');
const axios = require('axios');
const crypto = require('crypto');
const log = require('electron-log');
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Configurar regedit para usar VBS
const vbsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'regedit', 'vbs') // en build (Horizon RP\resources\regedit\vbs)
    : path.join(__dirname, 'node_modules', 'regedit', 'vbs'); // en dev

console.log('VBScript dir:', vbsPath, 'exists:', fs.existsSync(vbsPath));
regedit.setExternalVBSLocation(vbsPath);

// Deshabilitar errores de GPU
app.disableHardwareAcceleration();

// Variables globales
let mainWindow;
let downloadActive = false;
const gameAPI = new GameAPI();

// Configuraciï¿½n del servidor
const CONFIG = {
    serverName: 'Horizon Roleplay',
    serverIP: '195.26.252.73',
    serverPort: 7778,
    website: 'https://horizonrp.es',
    discord: 'https://discord.gg/horizonrp',
    forum: 'https://foro.horizonrp.es',
    wiki: 'https://wiki.horizonrp.es',
    downloadURL: 'https://horizonrp.es/downloads/HZRPDL.zip',
    fileSize: 2000000000,
    gtaPath: null  // Se calculará automáticamente basado en la instalación
};

function getLocalGameVersion() {
    try {
        if (!CONFIG.gtaPath) return '0.0.0';
        const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
        const data = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        return data.version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function setLocalGameVersion(newVersion) {
    try {
        if (!CONFIG.gtaPath) return;
        const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
        let marker = {};
        if (fs.existsSync(markerFile)) {
            marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        }
        marker.version = newVersion;
        fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2));
    } catch (e) {
        console.warn('No se pudo guardar version local:', e.message);
    }
}

// Compara "1.2.10" vs "1.2.9" (semver simple)
function isNewer(remote, local) {
    const r = remote.split('.').map(n => parseInt(n, 10) || 0);
    const l = local.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
        const a = r[i] || 0, b = l[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return false;
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const rs = fs.createReadStream(filePath);
        rs.on('data', d => hash.update(d));
        rs.on('end', () => resolve(hash.digest('hex')));
        rs.on('error', reject);
    });
}

// Llamada al iniciar
async function initGameAutoUpdate() {
    try {
        // Asegura gtaPath calculado
        if (!CONFIG.gtaPath) loadConfig();
        const baseDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getPath('home'), 'Horizon RP Dev');
        if (!CONFIG.gtaPath) CONFIG.gtaPath = path.join(baseDir, 'GTA Horizon');
        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 8000 });
        if (!manifest || !manifest.version || !manifest.zip || !manifest.sha256) {
            console.warn('Manifest inválido', manifest);
            return;
        }

        const localVersion = getLocalGameVersion();
        if (!fs.existsSync(CONFIG.gtaPath)) {
            // Si no está instalado, auto-instalar
            console.log('GTA no instalado, instalando versión', manifest.version);
            await downloadAndInstallGTA(manifest);
            return;
        }

        if (isNewer(manifest.version, localVersion)) {
            console.log(`Actualización GTA disponible: ${localVersion} ? ${manifest.version}`);
            if (mainWindow) mainWindow.webContents.send('game-update', { state: 'available', version: manifest.version });
            await downloadAndInstallGTA(manifest);
        } else {
            console.log('GTA está actualizado:', localVersion);
            if (mainWindow) mainWindow.webContents.send('game-update', { state: 'uptodate', version: localVersion });
        }
    } catch (e) {
        console.warn('No se pudo verificar manifest GTA:', e.message);
    }
}

async function downloadAndInstallGTA(manifest) {
    // Descarga a temp, verifica SHA, extrae "atómicamente"
    const tempDir = path.join(app.getPath('userData'), 'temp');
    await fs.ensureDir(tempDir);
    const tempZip = path.join(tempDir, 'GTAHorizon - ${ manifest.version }.zip');

    if (mainWindow) mainWindow.webContents.send('download-progress', { percent: 0, message: 'Actualización de GTA: conectando...' });

    await downloadFile(manifest.zip, tempZip, (percent, current, total, speed) => {
        if (mainWindow) {
            mainWindow.webContents.send('download-progress', {
                percent,
                message: 'Actualizando GTA...',
                current, total, speed
            });
        }
    });

    // Verificar SHA-256
    const actualSha = (await sha256File(tempZip)).toLowerCase();
    if (actualSha !== manifest.sha256.toLowerCase()) {
        throw new Error('Integridad fallida (SHA-256 no coincide)');
    }

    // Actualización atómica (opcional: respalda carpeta anterior)
    const backupDir = path.join(path.dirname(CONFIG.gtaPath), `GTA Horizon_backup_${Date.now()}`);
    try {
        if (fs.existsSync(CONFIG.gtaPath)) {
            await fs.rename(CONFIG.gtaPath, backupDir);
        }
        await fs.ensureDir(CONFIG.gtaPath);
        if (mainWindow) mainWindow.webContents.send('download-progress', { percent: 90, message: 'Instalando actualización...' });
        await extractZip(tempZip, CONFIG.gtaPath);

        setLocalGameVersion(manifest.version);
        if (mainWindow) {
            mainWindow.webContents.send('download-progress', { percent: 100, message: 'Actualización completa' });
            mainWindow.webContents.send('download-complete');
        }

        // Limpieza
        await fs.remove(tempZip);
        await fs.remove(backupDir).catch(() => { }); // si quieres mantener backup, comenta esta línea
    } catch (e) {
        // en caso de error, intenta revertir
        if (fs.existsSync(backupDir)) {
            await fs.remove(CONFIG.gtaPath).catch(() => { });
            await fs.rename(backupDir, CONFIG.gtaPath).catch(() => { });
        }
        await fs.remove(tempZip).catch(() => { });
        throw e;
    }
}

const GTA_MANIFEST_URL = 'https://horizonrp.es/downloads/manifest.json';

// Cargar configuración guardada (o calcular si no existe)
function loadConfig() {
    const configPath = path.join(app.getPath('userData'), 'horizonrp_config.json');
    try {
        if (fs.existsSync(configPath)) {
            const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (saved.gtaPath && fs.existsSync(path.join(saved.gtaPath, '.horizonrp'))) {
                CONFIG.gtaPath = saved.gtaPath;
                console.log('? Instalación cargada:', CONFIG.gtaPath);
                return;
            }
        }
    } catch (e) {
        console.error('? Error cargando config:', e);
    }

    const baseDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getPath('home'), 'Horizon RP Dev');
    CONFIG.gtaPath = path.join(baseDir, 'GTA Horizon'); // Crea GTA Horizon automáticamente
    console.log('?? Ruta de GTA calculada automáticamente:', CONFIG.gtaPath);
    saveConfig();
}

// Guardar configuración
function saveConfig() {
    const configPath = path.join(app.getPath('userData'), 'horizonrp_config.json');
    fs.writeFileSync(configPath, JSON.stringify({
        gtaPath: CONFIG.gtaPath,
        version: '1.0.0',
        savedAt: new Date().toISOString()
    }));
}

// Crear ventana principal
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 700,
        frame: false,
        resizable: false,  // Bloquear redimensionamiento
        maximizable: false,  // Bloquear maximizar/fullscreen
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets/logo.png')
    });

    mainWindow.loadFile('src/index.html');

    // Bloquear fullscreen manualmente
    mainWindow.setFullScreenable(false);

    // Inicializar API al abrir
    initializeAPI();

    mainWindow.on('closed', () => {
        mainWindow = null;
        gameAPI.close();
    });
}

function initLauncherAutoUpdate() {
    try {
        // Puedes enviar eventos al renderer si quieres mostrar progreso de la app
        autoUpdater.on('update-available', () => {
            if (mainWindow) mainWindow.webContents.send('launcher-update', { state: 'available' });
        });
        autoUpdater.on('download-progress', (p) => {
            if (mainWindow) mainWindow.webContents.send('launcher-update', { state: 'downloading', progress: p.percent });
        });

        autoUpdater.on('update-downloaded', () => {
            if (mainWindow) {
                mainWindow.webContents.send('launcher-update', { state: 'downloaded' });
                // Aplica automáticamente (o muestra un diálogo)
                setTimeout(() => autoUpdater.quitAndInstall(), 1500);
            }
        });

        autoUpdater.checkForUpdatesAndNotify(); // chequea al iniciar
    } catch (e) {
        console.error('AutoUpdater error:', e);
    }
}

// Inicializar conexiones API y actualizaciones
async function initializeAPI() {
    // Inicializar base de datos
    await gameAPI.initDatabase();

    // Actualizar datos del servidor cada 10 segundos
    updateServerInfo();
    setInterval(updateServerInfo, 10000);

    // Actualizar estadï¿½sticas cada 30 segundos
    updateStatistics();
    setInterval(updateStatistics, 30000);

    // Cargar noticias
    updateNews();
    setInterval(updateNews, 60000);
}

// Actualizar informaciï¿½n del servidor usando samp-query
// Actualizar información del servidor usando samp-query
// Actualizar información del servidor usando samp-query
// Actualizar información del servidor usando samp-query
// Actualizar información del servidor usando samp-query
async function updateServerInfo() {
    const serverOptions = {
        host: '195.26.252.73',
        port: 7778,
        timeout: 5000
    };

    console.log('Iniciando consulta a servidor:', serverOptions);

    const startTime = Date.now();  // Iniciar timer para fallback

    query(serverOptions, (error, response) => {
        const endTime = Date.now();  // Fin del timer
        const calculatedPing = Math.round((endTime - startTime) / 3);  // Dividido por 2 para aproximar ping real (ida/vuelta)

        if (error) {
            console.error('Error detallado consultando servidor:', error.message, error.stack);
            const serverInfo = {
                online: false,
                players: 0,
                maxPlayers: 500,
                ping: 0
            };
            if (mainWindow) {
                mainWindow.webContents.send('server-info-update', serverInfo);
            }
            return;
        }

        console.log('Respuesta del servidor:', response);

        const serverInfo = {
            online: true,
            players: response.online || 0,
            maxPlayers: response.maxplayers || 500,
            hostname: response.hostname || 'Horizon Roleplay',
            gamemode: response.gamemode || 'Roleplay',
            mapname: response.mapname || 'Los Santos',
            passworded: response.passworded || false,
            ping: response.ping > 0 ? response.ping : calculatedPing  // Prioriza ping nativo, fallback a calculado ajustado
        };

        if (mainWindow) {
            mainWindow.webContents.send('server-info-update', serverInfo);
        }
    });
}

// Actualizar estadï¿½sticas desde la base de datos
async function updateStatistics() {
    const stats = await gameAPI.getStatistics();
    if (mainWindow && stats) {
        mainWindow.webContents.send('statistics-update', stats);
    }
}

// Actualizar noticias
async function updateNews() {
    const news = await gameAPI.getNews();
    if (mainWindow) {
        mainWindow.webContents.send('news-update', news);
    }
}

// ===== EVENTOS IPC =====

// Controles de ventana
ipcMain.on('minimize-window', () => {
    mainWindow.minimize();
});

ipcMain.on('close-window', () => {
    if (downloadActive) {
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Cancelar descarga y salir', 'Continuar descargando'],
            defaultId: 1,
            message: 'Hay una descarga en progreso',
            detail: 'Si sales ahora, tendrï¿½s que descargar todo de nuevo.'
        });

        if (choice === 1) return;
    }
    app.quit();
});

// Enlaces externos
ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
});

// Solicitudes de actualizaciï¿½n manual
ipcMain.on('request-server-info', async () => {
    await updateServerInfo();
});

ipcMain.on('request-statistics', async () => {
    await updateStatistics();
});

// Verificar usuario
ipcMain.on('check-user', async (event, username) => {
    const userInfo = await gameAPI.checkUser(username);
    event.reply('user-info', userInfo);
});
ipcMain.handle('app-version', () => app.getVersion());
// Obtener informaciï¿½n del servidor (compatibilidad)
ipcMain.handle('get-server-info', async () => {
    return new Promise((resolve) => {
        const serverOptions = {
            host: CONFIG.serverIP,
            port: CONFIG.serverPort
        };

        query(serverOptions, (error, response) => {
            if (error) {
                resolve({
                    players: 0,
                    maxPlayers: 500,
                    version: 'offline',
                    status: 'offline'
                });
            } else {
                resolve({
                    players: response.online,
                    maxPlayers: response.maxplayers,
                    version: response.rules?.version || '0.3.DL',
                    status: 'online'
                });
            }
        });
    });
});

// ===== SISTEMA DE INSTALACIï¿½N Y JUEGO =====

// Verificar si GTA estï¿½ instalado (SOLO NUESTRA VERSIï¿½N)
ipcMain.handle('check-gta-installed', async () => {
    if (!CONFIG.gtaPath) return false;

    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) {
        CONFIG.gtaPath = null;
        return false;
    }

    const gameFiles = findGameFiles(CONFIG.gtaPath);
    return gameFiles['gta_sa.exe'] && gameFiles['samp.exe'];
});

// Obtener ruta de instalaciï¿½n
ipcMain.handle('get-install-path', async () => {
    return CONFIG.gtaPath || 'No instalado';
});

ipcMain.on('get-installation-path', () => {
    if (mainWindow) {
        mainWindow.webContents.send('installation-path', CONFIG.gtaPath || 'No instalado');
    }
});

// Verificar archivos
ipcMain.handle('verify-files', async () => {
    if (!CONFIG.gtaPath) return false;

    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) return false;

    const gameFiles = findGameFiles(CONFIG.gtaPath);
    return !!(gameFiles['gta_sa.exe'] && gameFiles['samp.exe'] && gameFiles['samp.dll']);
});

// Resetear instalaciï¿½n
ipcMain.on('reset-installation', async () => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Cancelar', 'Eliminar y reinstalar'],
        defaultId: 0,
        message: 'ï¿½Deseas eliminar la instalaciï¿½n actual?',
        detail: 'Esto eliminarï¿½ todos los archivos del juego y tendrï¿½s que descargar todo de nuevo.'
    });

    if (choice === 1 && CONFIG.gtaPath && fs.existsSync(CONFIG.gtaPath)) {
        try {
            await fs.remove(CONFIG.gtaPath);
            CONFIG.gtaPath = null;
            const configPath = path.join(app.getPath('userData'), 'horizonrp_config.json');
            if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
            }
            if (mainWindow) {
                mainWindow.webContents.send('installation-reset', 'Instalaciï¿½n eliminada correctamente');
            }
        } catch (error) {
            if (mainWindow) {
                mainWindow.webContents.send('installation-reset', 'Error: ' + error.message);
            }
        }
    }
});

// EVENTO PRINCIPAL: Botï¿½n de jugar
ipcMain.on('start-game', async (event) => {
    // Verificar si el juego estï¿½ instalado
    const isInstalled = await checkGameInstalled();

    if (!isInstalled) {
        // Iniciar descarga
        downloadGame(event);
    } else {
        // Iniciar el juego
        const result = await launchGame();
        if (!result.success) {
            event.reply('game-error', result.message);
        }
    }
});

// Funciï¿½n auxiliar para verificar instalaciï¿½n
async function checkGameInstalled() {
    if (!CONFIG.gtaPath) return false;

    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) {
        CONFIG.gtaPath = null;
        return false;
    }

    const gameFiles = findGameFiles(CONFIG.gtaPath);
    return !!(gameFiles['gta_sa.exe'] && gameFiles['samp.exe']);
}

// Funciï¿½n para descargar el juego
async function downloadGame(event) {
    if (downloadActive) {
        event.reply('download-error', 'Descarga ya en progreso');
        return;
    }

    // Asegurar que gtaPath esté calculada (de loadConfig)
    if (!CONFIG.gtaPath) {
        loadConfig();  // Calcula si no existe
    }

    // Crear la carpeta GTA Horizon si no existe
    await fs.ensureDir(CONFIG.gtaPath);

    downloadActive = true;

    try {
        // Crear marcador
        const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
        fs.writeFileSync(markerFile, JSON.stringify({
            version: '1.0.0',
            server: CONFIG.serverName,
            installedAt: new Date().toISOString()
        }));

        // Preparar descarga
        const tempDir = path.join(app.getPath('userData'), 'temp');
        await fs.ensureDir(tempDir);
        const tempFile = path.join(tempDir, 'GTA_HorizonRP.zip');

        event.reply('download-progress', {
            percent: 0,
            message: 'Conectando con el servidor...'
        });

        // Descargar archivo
        await downloadFile(CONFIG.downloadURL, tempFile, (progress, downloaded, total) => {
            event.reply('download-progress', {
                percent: progress,
                message: `Descargando archivos del juego...`,
                current: downloaded,
                total: total,
                speed: downloaded / 10 // Aproximado
            });
        });

        // Extraer
        event.reply('download-progress', {
            percent: 90,
            message: 'Extrayendo archivos... Por favor espera.'
        });

        await extractZip(tempFile, CONFIG.gtaPath);

        // Limpiar temporales
        await fs.remove(tempFile);
        await fs.remove(tempDir);

        // Verificar instalación
        const gameFiles = findGameFiles(CONFIG.gtaPath);

        if (gameFiles['gta_sa.exe'] && gameFiles['samp.exe']) {
            saveConfig();
            downloadActive = false;

            event.reply('download-complete');

            // Intentar iniciar el juego automáticamente
            setTimeout(async () => {
                const result = await launchGame();
                if (!result.success) {
                    event.reply('game-error', result.message);
                }
            }, 2000);
        } else {
            throw new Error('Archivos del juego no encontrados en el ZIP');
        }

    } catch (error) {
        downloadActive = false;

        if (CONFIG.gtaPath && fs.existsSync(CONFIG.gtaPath)) {
            await fs.remove(CONFIG.gtaPath);
        }
        CONFIG.gtaPath = null;

        console.error('Error en descarga:', error);
        event.reply('download-error', error.message);
    }
}

// Funciï¿½n para iniciar el juego
async function launchGame() {
    if (!CONFIG.gtaPath) {
        return { success: false, message: 'El juego no estï¿½ instalado' };
    }

    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) {
        CONFIG.gtaPath = null;
        return { success: false, message: 'Instalaciï¿½n corrupta. Por favor reinstala.' };
    }

    const gameFiles = findGameFiles(CONFIG.gtaPath);

    if (!gameFiles['samp.exe'] || !gameFiles['gta_sa.exe']) {
        return { success: false, message: 'No se encontraron los archivos del juego' };
    }

    try {
        // Actualizar registro de Windows
        await updateSAMPRegistry(gameFiles['gta_sa.exe']);

        const gameCwd = path.dirname(gameFiles['samp.exe']);

        console.log('Iniciando juego...');
        console.log('CWD:', gameCwd);
        console.log('SAMP:', gameFiles['samp.exe']);

        const gameProcess = spawn(gameFiles['samp.exe'],
            [`${CONFIG.serverIP}:${CONFIG.serverPort}`],
            {
                cwd: gameCwd,
                detached: true,
                stdio: 'ignore'
            }
        );

        gameProcess.unref();

        setTimeout(() => {
            mainWindow.minimize();
        }, 2000);

        return { success: true };
    } catch (error) {
        console.error('Error al iniciar juego:', error);
        return { success: false, message: error.message };
    }
}

// ===== FUNCIONES AUXILIARES =====

// Seleccionar carpeta de instalaciï¿½n
async function selectInstallFolder() {
    const defaultPath = path.join(app.getPath('home'), 'HorizonRP');

    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Selecciona dï¿½nde instalar Horizon RP',
        buttonLabel: 'Instalar aquï¿½',
        defaultPath: defaultPath,
        message: 'Se crearï¿½ una carpeta "HorizonRP_Game" en la ubicaciï¿½n seleccionada'
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = path.join(result.filePaths[0], 'HorizonRP_Game');

        if (fs.existsSync(selectedPath) && fs.readdirSync(selectedPath).length > 0) {
            const choice = dialog.showMessageBoxSync(mainWindow, {
                type: 'warning',
                buttons: ['Cancelar', 'Usar esta carpeta'],
                defaultId: 0,
                message: 'La carpeta ya contiene archivos',
                detail: 'La carpeta seleccionada no estï¿½ vacï¿½a. ï¿½Deseas usarla de todos modos?'
            });

            if (choice === 0) {
                return { success: false, message: 'Selecciona otra carpeta' };
            }
        }

        CONFIG.gtaPath = selectedPath;
        return { success: true, path: selectedPath };
    }

    return { success: false, message: 'Operaciï¿½n cancelada' };
}

// Buscar archivos del juego en subdirectorios
function findGameFiles(basePath) {
    const requiredFiles = ['gta_sa.exe', 'samp.exe', 'samp.dll'];
    const foundFiles = {};

    // Buscar en la raï¿½z
    for (const file of requiredFiles) {
        const fullPath = path.join(basePath, file);
        if (fs.existsSync(fullPath)) {
            foundFiles[file] = fullPath;
        }
    }

    // Buscar en subdirectorios comunes
    if (Object.keys(foundFiles).length < requiredFiles.length) {
        const subDirs = ['GTA San Andreas', 'GTA_San_Andreas', 'game'];
        for (const dir of subDirs) {
            const dirPath = path.join(basePath, dir);
            if (fs.existsSync(dirPath)) {
                for (const file of requiredFiles) {
                    if (!foundFiles[file]) {
                        const fullPath = path.join(dirPath, file);
                        if (fs.existsSync(fullPath)) {
                            foundFiles[file] = fullPath;
                        }
                    }
                }
            }
        }
    }

    return foundFiles;
}

// Descargar archivo con progreso
function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);

        const request = https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                fs.unlinkSync(dest);
                return downloadFile(response.headers.location, dest, onProgress)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                reject(new Error(`Error del servidor: ${response.statusCode}`));
                return;
            }

            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            let lastTime = Date.now();
            let lastSize = 0;

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;

                const now = Date.now();
                const timeDiff = (now - lastTime) / 1000;

                if (timeDiff >= 0.5) { // Actualizar cada 500ms
                    const sizeDiff = downloadedSize - lastSize;
                    const speed = sizeDiff / timeDiff;

                    const progress = Math.round((downloadedSize / totalSize) * 100);
                    if (onProgress) onProgress(progress, downloadedSize, totalSize, speed);

                    lastTime = now;
                    lastSize = downloadedSize;
                }
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve();
            });
        });

        request.on('error', (err) => {
            file.close();
            fs.unlinkSync(dest);
            reject(err);
        });

        file.on('error', (err) => {
            file.close();
            fs.unlinkSync(dest);
            reject(err);
        });
    });
}

// Extraer archivo ZIP
function extractZip(source, dest) {
    return new Promise((resolve, reject) => {
        fs.ensureDirSync(dest);

        fs.createReadStream(source)
            .pipe(unzipper.Parse())
            .on('entry', (entry) => {
                const fileName = entry.path;
                const type = entry.type;

                let extractPath;

                // Manejar diferentes estructuras de ZIP
                if (fileName.startsWith('GTA San Andreas/')) {
                    const relativePath = fileName.substring('GTA San Andreas/'.length);
                    if (relativePath) {
                        extractPath = path.join(dest, relativePath);
                    } else {
                        entry.autodrain();
                        return;
                    }
                } else if (fileName.startsWith('GTA_San_Andreas/')) {
                    const relativePath = fileName.substring('GTA_San_Andreas/'.length);
                    if (relativePath) {
                        extractPath = path.join(dest, relativePath);
                    } else {
                        entry.autodrain();
                        return;
                    }
                } else {
                    extractPath = path.join(dest, fileName);
                }

                const dirName = path.dirname(extractPath);
                if (type === 'Directory') {
                    fs.ensureDirSync(extractPath);
                    entry.autodrain();
                } else {
                    fs.ensureDirSync(dirName);
                    entry.pipe(fs.createWriteStream(extractPath));
                }
            })
            .on('close', () => {
                setTimeout(() => resolve(), 1000);
            })
            .on('error', reject);
    });
}

// Actualizar registro de Windows para SAMP
// Ejecuta reg.exe y captura salida/errores
function runReg(args) {
    return new Promise((resolve, reject) => {
        const regExe = process.env.windir
            ? path.join(process.env.windir, 'System32', 'reg.exe')
            : 'reg';

        const p = spawn(regExe, args, { windowsHide: true });
        let stdout = '', stderr = '';

        p.stdout?.on('data', d => stdout += d.toString());
        p.stderr?.on('data', d => stderr += d.toString());

        p.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr, code });
            } else {
                console.error('reg.exe failed', { args, code, stdout, stderr });
                reject(new Error(`reg.exe exit ${code} :: ${stderr || stdout || '(sin salida)'}`));
            }
        });
    });
}

async function updateSAMPRegistry(gtaExePath) {
    const key = 'HKCU\\Software\\SAMP';

    // Asegurar que la clave exista (si ya existe, no pasa nada)
    try {
        await runReg(['ADD', key, '/f']);
    } catch (e) {
        console.warn('Aviso creando clave SAMP:', e.message);
        // seguimos, algunas builds devuelven 1 si ya existe
    }

    // Intento normal (vista por defecto del Registro)
    try {
        await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f']);
        await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f']);
        console.log('? Registro (vista por defecto) actualizado:', gtaExePath);
        return;
    } catch (e1) {
        console.warn('Fallo en vista por defecto, reintentando con /reg:32 ?', e1.message);
    }

    // Fallback: forzar vista de 32 bits (en algunas máquinas/reg.exe es sensible a la vista)
    try {
        await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:32']);
        await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:32']);
        console.log('? Registro (/reg:32) actualizado:', gtaExePath);
        return;
    } catch (e2) {
        console.warn('Fallo con /reg:32, reintentando con /reg:64 ?', e2.message);
    }

    // Fallback adicional: forzar vista de 64 bits
    await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:64']);
    await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:64']);
    console.log('? Registro (/reg:64) actualizado:', gtaExePath);
}

// Formatear bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ===== INICIALIZACIï¿½N =====

app.whenReady().then(() => {
    loadConfig();
    createWindow();
    initLauncherAutoUpdate(); // <- añade esto
    initGameAutoUpdate(); // <- añade esto (para GTA)
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});