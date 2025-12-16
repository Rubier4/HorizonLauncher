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
const checkDiskSpace = require('check-disk-space').default;
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Configurar regedit para usar VBS
const vbsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'regedit', 'vbs')
    : path.join(__dirname, 'node_modules', 'regedit', 'vbs');
try {
    regedit.setExternalVBSLocation(vbsPath);
} catch { }

// Deshabilitar errores de GPU
app.disableHardwareAcceleration();

// Variables globales
let mainWindow;
let updateWindow = null;
let checkingUpdatesWindow = null;
let downloadActive = false;
const gameAPI = new GameAPI();

// Configuración del servidor
const CONFIG = {
    serverName: 'Horizon Roleplay',
    serverIP: '209.237.141.132',
    serverPort: 7777,
    website: 'https://horizonrp.es',
    discord: 'https://discord.gg/horizonrp',
    forum: 'https://foro.horizonrp.es',
    wiki: 'https://wiki.horizonrp.es',
    baseDownloadURL: 'https://pub-9d7e62ca68da4c1fb5a98f2a71cdf404.r2.dev/HZGTA/',
    gtaPath: null
};

const GTA_MANIFEST_URL = 'https://horizonrp.es/manifest.json';

// Utilidades versión local
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

// Semver simple
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
        if (!fs.existsSync(filePath)) {
            resolve(null);
            return;
        }
        const hash = crypto.createHash('sha256');
        const rs = fs.createReadStream(filePath);
        rs.on('data', d => hash.update(d));
        rs.on('end', () => resolve(hash.digest('hex')));
        rs.on('error', reject);
    });
}

async function checkAvailableSpace(requiredBytes, targetPath) {
    try {
        const checkDiskSpace = require('check-disk-space').default;

        let checkPath = targetPath;
        while (!fs.existsSync(checkPath) && checkPath !== path.dirname(checkPath)) {
            checkPath = path.dirname(checkPath);
        }

        const diskInfo = await checkDiskSpace(checkPath);
        const requiredWithMargin = requiredBytes * 1.1;

        if (diskInfo.free < requiredWithMargin) {
            return {
                success: false,
                message: `Espacio insuficiente. Necesitas ${formatBytes(requiredWithMargin)}, disponible: ${formatBytes(diskInfo.free)}`
            };
        }

        return { success: true, free: diskInfo.free };
    } catch (e) {
        console.warn('No se pudo verificar espacio:', e.message);
        return { success: true, free: 0 };
    }
}

// Descarga paralela con control de concurrencia
// Reemplazar downloadFilesParallel con esta versión mejorada
async function downloadFilesParallel(files, maxConcurrent = 5) {
    const send = (ch, payload) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(ch, payload);
            }
        } catch { }
    };

    let completedFiles = 0;
    let failedFiles = [];
    const totalFiles = files.length;
    const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
    let downloadedBytes = 0;
    let lastSpeedUpdate = Date.now();
    let lastBytes = 0;
    let currentSpeed = 0;

    const updateProgress = (message, currentFile = '') => {
        const now = Date.now();
        const timeDiff = (now - lastSpeedUpdate) / 1000;

        if (timeDiff >= 0.5) {
            currentSpeed = (downloadedBytes - lastBytes) / timeDiff;
            lastSpeedUpdate = now;
            lastBytes = downloadedBytes;
        }

        send('download-progress', {
            percent: Math.round((downloadedBytes / totalBytes) * 100),
            message: message,
            current: downloadedBytes,
            total: totalBytes,
            speed: currentSpeed,
            filesCompleted: completedFiles,
            filesTotal: totalFiles,
            currentFile: currentFile
        });
    };

    const downloadSingleFile = (fileInfo) => {
        return new Promise((resolve, reject) => {
            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);
            fs.ensureDirSync(path.dirname(localPath));

            const encodedPath = fileInfo.path.split('/').map(encodeURIComponent).join('/');
            const fileUrl = `${CONFIG.baseDownloadURL}${encodedPath}`;

            const tempPath = localPath + '.download';
            const file = fs.createWriteStream(tempPath);
            let fileBytes = 0;
            let timeout;

            const cleanup = () => {
                clearTimeout(timeout);
                file.close();
            };

            const handleError = (err) => {
                cleanup();
                try { fs.unlinkSync(tempPath); } catch { }
                reject(err);
            };

            const resetTimeout = () => {
                clearTimeout(timeout);
                // Timeout dinámico basado en tamaño del archivo
                const timeoutMs = Math.max(30000, Math.min(300000, fileInfo.size / 1000));
                timeout = setTimeout(() => handleError(new Error('Timeout')), timeoutMs);
            };

            const makeRequest = (url, redirectCount = 0) => {
                if (redirectCount > 5) {
                    return handleError(new Error('Demasiadas redirecciones'));
                }

                resetTimeout();

                const request = https.get(url, (response) => {
                    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                        if (response.headers.location) {
                            makeRequest(response.headers.location, redirectCount + 1);
                        } else {
                            handleError(new Error('Redirección sin URL'));
                        }
                        return;
                    }

                    if (response.statusCode !== 200) {
                        return handleError(new Error(`HTTP ${response.statusCode}`));
                    }

                    response.on('data', (chunk) => {
                        resetTimeout();
                        fileBytes += chunk.length;
                        downloadedBytes += chunk.length;
                        updateProgress(`Descargando...`, fileInfo.path);
                    });

                    response.pipe(file);

                    file.on('finish', () => {
                        cleanup();
                        // Renombrar de .download a archivo final
                        try {
                            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
                            fs.renameSync(tempPath, localPath);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });

                    file.on('error', handleError);
                    response.on('error', handleError);
                });

                request.on('error', handleError);
            };

            makeRequest(fileUrl);
        });
    };

    const downloadWithRetry = async (fileInfo, retries = 3) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await downloadSingleFile(fileInfo);
                completedFiles++;
                return true;
            } catch (error) {
                console.error(`Error ${fileInfo.path} (${attempt}/${retries}):`, error.message);
                if (attempt === retries) {
                    failedFiles.push({ path: fileInfo.path, error: error.message });
                    return false;
                }
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }
    };

    console.log(`=== Descargando ${files.length} archivos (${formatBytes(totalBytes)}) ===`);

    // Pool de workers
    const queue = [...files];
    const workers = [];

    for (let i = 0; i < maxConcurrent; i++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const file = queue.shift();
                if (file) await downloadWithRetry(file);
            }
        })());
    }

    await Promise.all(workers);

    if (failedFiles.length > 0) {
        console.error(`${failedFiles.length} archivos fallaron`);
        throw new Error(`No se pudieron descargar ${failedFiles.length} archivos`);
    }

    console.log(`=== Descarga completa ===`);
}
// Auto-update del juego mejorado
async function initGameAutoUpdate() {
    try {
        if (!CONFIG.gtaPath) loadConfig();

        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 15000 });
        if (!manifest || !manifest.files || !Array.isArray(manifest.files)) {
            console.warn('Manifest inválido', manifest);
            return;
        }

        if (!fs.existsSync(CONFIG.gtaPath)) {
            console.log('GTA no instalado.');
            return;
        }

        const filesToUpdate = [];
        let totalUpdateSize = 0;
        let checkedFiles = 0;

        console.log(`Verificando ${manifest.files.length} archivos...`);

        for (const fileInfo of manifest.files) {
            checkedFiles++;

            if (checkedFiles % 50 === 0) {
                console.log(`Verificados ${checkedFiles}/${manifest.files.length} archivos...`);
                // Enviar progreso de verificación
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('download-progress', {
                        percent: Math.round((checkedFiles / manifest.files.length) * 100),
                        message: `Verificando archivos... ${checkedFiles}/${manifest.files.length}`
                    });
                }
            }

            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);

            // Si no existe el archivo, necesita descarga
            if (!fs.existsSync(localPath)) {
                console.log(`Falta: ${fileInfo.path}`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            // Verificar tamaño primero (es más rápido)
            const stats = fs.statSync(localPath);
            if (stats.size !== fileInfo.size) {
                console.log(`Tamaño diferente: ${fileInfo.path} (local: ${stats.size}, servidor: ${fileInfo.size})`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            // SIEMPRE verificar hash
            const localHash = await sha256File(localPath);
            if (!localHash || localHash.toLowerCase() !== fileInfo.hash.toLowerCase()) {
                console.log(`Hash diferente: ${fileInfo.path}`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
            }
        }

        if (filesToUpdate.length > 0) {
            console.log(`Actualización disponible: ${filesToUpdate.length} archivos (${formatBytes(totalUpdateSize)})`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('game-update', {
                    state: 'available',
                    filesCount: filesToUpdate.length,
                    totalSize: totalUpdateSize
                });
            }

            await downloadFilesParallel(filesToUpdate, 3);

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', {
                    percent: 100,
                    message: 'Actualización completa'
                });
                mainWindow.webContents.send('download-complete');
            }
        } else {
            console.log('GTA está actualizado');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('game-update', { state: 'uptodate' });
            }
        }
    } catch (e) {
        console.warn('Error verificando actualización:', e.message);
    }
}

// Config persistente del launcher
function loadConfig() {
    const configPath = path.join(app.getPath('userData'), 'horizonrp_config.json');
    try {
        if (fs.existsSync(configPath)) {
            const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (saved.gtaPath && fs.existsSync(saved.gtaPath)) {
                // Verificar que la instalación sigue siendo válida
                const markerFile = path.join(saved.gtaPath, '.horizonrp');
                if (fs.existsSync(markerFile)) {
                    CONFIG.gtaPath = saved.gtaPath;
                    console.log('✓ Instalación cargada:', CONFIG.gtaPath);
                    return;
                }
            }
        }
    } catch (e) {
        console.error('✗ Error cargando config:', e);
    }

    // NO establecer ruta por defecto - dejar que el usuario elija
    CONFIG.gtaPath = null;
    console.log('✓ Sin instalación previa, el usuario deberá elegir ubicación');
}

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
        resizable: false,
        maximizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets/logo.png')
    });

    mainWindow.loadFile('src/index.html');
    mainWindow.setFullScreenable(false);

    initializeAPI();

    mainWindow.on('closed', () => {
        mainWindow = null;
        gameAPI.close();
    });
}

function startMainApp() {
    if (checkingUpdatesWindow) {
        checkingUpdatesWindow.close();
    }
    if (mainWindow) {
        return;
    }
    loadConfig();
    createWindow();
}

// ============================================
// REEMPLAZAR: initLauncherAutoUpdate completo
// ============================================
function initLauncherAutoUpdate() {
    log.info('Initializing launcher auto update...');

    // Configurar para control manual de descarga
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('error', (error) => {
        log.error('Update error:', error == null ? "unknown" : (error.stack || error).toString());

        if (checkingUpdatesWindow && !checkingUpdatesWindow.isDestroyed()) {
            checkingUpdatesWindow.webContents.send('update-error', error?.message || 'Error desconocido');
        }

        setTimeout(() => startMainApp(), 2000);
    });

    autoUpdater.on('checking-for-update', () => {
        log.info('Checking for updates...');
        if (checkingUpdatesWindow && !checkingUpdatesWindow.isDestroyed()) {
            checkingUpdatesWindow.webContents.send('update-status', {
                status: 'checking',
                message: 'Buscando actualizaciones...'
            });
        }
    });

    autoUpdater.on('update-not-available', () => {
        log.info('Update not available.');
        if (checkingUpdatesWindow && !checkingUpdatesWindow.isDestroyed()) {
            checkingUpdatesWindow.webContents.send('update-status', {
                status: 'not-available',
                message: 'Launcher actualizado'
            });
        }
        setTimeout(() => startMainApp(), 500);
    });

    autoUpdater.on('update-available', (info) => {
        log.info('Update available:', info.version);

        if (checkingUpdatesWindow && !checkingUpdatesWindow.isDestroyed()) {
            checkingUpdatesWindow.webContents.send('update-status', {
                status: 'available',
                message: `Nueva versión ${info.version} disponible`,
                version: info.version
            });
        }

        // Iniciar descarga
        autoUpdater.downloadUpdate();
    });

    autoUpdater.on('download-progress', (progress) => {
        log.info(`Download progress: ${progress.percent.toFixed(1)}%`);

        if (checkingUpdatesWindow && !checkingUpdatesWindow.isDestroyed()) {
            checkingUpdatesWindow.webContents.send('update-progress', {
                percent: progress.percent,
                bytesPerSecond: progress.bytesPerSecond,
                transferred: progress.transferred,
                total: progress.total
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('Update downloaded:', info.version);

        // Cerrar ventana de checking si existe
        if (checkingUpdatesWindow && !checkingUpdatesWindow.isDestroyed()) {
            checkingUpdatesWindow.close();
            checkingUpdatesWindow = null;
        }

        // Cerrar ventana principal si existe
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.close();
            mainWindow = null;
        }

        // Crear ventana de actualización lista
        updateWindow = new BrowserWindow({
            width: 400,
            height: 220,
            frame: false,
            resizable: false,
            movable: true,
            transparent: true,
            backgroundColor: '#00000000',
            alwaysOnTop: true,
            center: true,
            skipTaskbar: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });

        updateWindow.loadFile('src/update.html');

        updateWindow.on('closed', () => {
            updateWindow = null;
        });

        // Instalar después de mostrar la ventana
        setTimeout(() => {
            log.info('Quitting and installing update...');
            try {
                autoUpdater.quitAndInstall(true, true);
            } catch (e) {
                log.error('Error during quitAndInstall:', e);
                app.quit();
            }
        }, 5000);
    });

    // Iniciar verificación
    try {
        autoUpdater.checkForUpdates();
    } catch (e) {
        log.error('Error checking for updates:', e);
        startMainApp();
    }
}

// Inicializar API y timers
async function initializeAPI() {
    await gameAPI.initDatabase();

    updateServerInfo();
    setInterval(updateServerInfo, 10000);

    updateNews();
    setInterval(updateNews, 60000);
}

// Server/News
// Variables globales para el estado del servidor
let lastKnownServerState = null;
let consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_OFFLINE = 3; // Necesita 3 fallos seguidos para marcar offline

async function updateServerInfo() {
    const serverOptions = { host: '209.237.141.132', port: 7777, timeout: 3000 };

    // Función para hacer una consulta con reintentos
    const queryWithRetry = (retries = 2) => {
        return new Promise((resolve) => {
            const startTime = Date.now();

            query(serverOptions, (error, response) => {
                const endTime = Date.now();
                const calculatedPing = Math.round((endTime - startTime) / 3);

                if (error) {
                    if (retries > 0) {
                        // Reintentar después de 1 segundo
                        setTimeout(() => {
                            queryWithRetry(retries - 1).then(resolve);
                        }, 1000);
                    } else {
                        resolve({ success: false, error });
                    }
                } else {
                    resolve({
                        success: true,
                        data: {
                            online: true,
                            players: response.online || 0,
                            maxPlayers: response.maxplayers || 500,
                            hostname: response.hostname || 'Horizon Roleplay',
                            gamemode: response.gamemode || 'Roleplay',
                            mapname: response.mapname || 'Los Santos',
                            passworded: response.passworded || false,
                            ping: response.ping > 0 ? response.ping : calculatedPing
                        }
                    });
                }
            });
        });
    };

    const result = await queryWithRetry(2); // 3 intentos totales

    if (result.success) {
        // Éxito - resetear contador de fallos
        consecutiveFailures = 0;
        lastKnownServerState = result.data;

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-info-update', result.data);
        }
    } else {
        // Fallo
        consecutiveFailures++;
        console.warn(`Query fallida (${consecutiveFailures}/${MAX_FAILURES_BEFORE_OFFLINE})`);

        if (consecutiveFailures >= MAX_FAILURES_BEFORE_OFFLINE) {
            // Solo marcar offline después de varios fallos consecutivos
            const offlineInfo = { online: false, players: 0, maxPlayers: 500, ping: 0 };
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('server-info-update', offlineInfo);
            }
        } else if (lastKnownServerState) {
            // Mantener el último estado conocido (con ping 0 para indicar problema)
            const cachedInfo = { ...lastKnownServerState, ping: 0 };
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('server-info-update', cachedInfo);
            }
        }
    }
}

async function updateNews() {
    const news = await gameAPI.getNews();
    if (mainWindow) mainWindow.webContents.send('news-update', news);
}

// REG.EXE helper
function runReg(args) {
    return new Promise((resolve, reject) => {
        const regExe = process.env.windir
            ? path.join(process.env.windir, 'System32', 'reg.exe')
            : 'reg';

        console.log('Ejecutando reg.exe con args:', args);

        const p = spawn(regExe, args, {
            windowsHide: true,
            shell: false
        });

        let stdout = '', stderr = '';

        p.stdout?.on('data', d => stdout += d.toString());
        p.stderr?.on('data', d => stderr += d.toString());

        p.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr, code });
            } else {
                console.error('Error reg.exe:', { code, stderr, stdout });
                reject(new Error(`reg.exe exit ${code} :: ${stderr || stdout || '(sin salida)'}`));
            }
        });

        p.on('error', err => {
            console.error('Error spawning reg.exe:', err);
            reject(err);
        });
    });
}

function parseRegQueryValue(stdout, valueName) {
    const re = new RegExp(`\\s${valueName}\\s+REG_\\w+\\s+(.*)`);
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(re);
        if (m && m[1]) return m[1].trim();
    }
    return '';
}

// Nickname en registro (HKCU\Software\SAMP)
async function getNickname() {
    const key = 'HKCU\\Software\\SAMP';

    try {
        const { stdout } = await runReg(['QUERY', key, '/v', 'PlayerName']);
        const val = parseRegQueryValue(stdout, 'PlayerName');
        if (val) return val;
    } catch { }

    try {
        const { stdout } = await runReg(['QUERY', key, '/v', 'player_name']);
        const val = parseRegQueryValue(stdout, 'player_name');
        if (val) return val;
    } catch { }

    return '';
}

async function setNickname(nickname) {
    const key = 'HKCU\\Software\\SAMP';

    try {
        await runReg(['ADD', key, '/f']);
    } catch { }

    await runReg(['ADD', key, '/v', 'PlayerName', '/t', 'REG_SZ', '/d', nickname, '/f']).catch(() => { });
    await runReg(['ADD', key, '/v', 'player_name', '/t', 'REG_SZ', '/d', nickname, '/f']).catch(() => { });
}

// Actualizar registro de SAMP (ruta del gta)
async function updateSAMPRegistry(gtaExePath) {
    const key = 'HKCU\\Software\\SAMP';

    try {
        await runReg(['ADD', key, '/f']);
    } catch { }

    try {
        await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f']);
        await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f']);
        console.log('✓ Registro SAMP actualizado (vista por defecto):', gtaExePath);
        return;
    } catch (e1) {
        console.warn('Fallo vista por defecto, reintentando /reg:32', e1.message);
    }

    try {
        await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:32']);
        await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:32']);
        console.log('✓ Registro SAMP actualizado (/reg:32):', gtaExePath);
        return;
    } catch (e2) {
        console.warn('Fallo /reg:32, reintentando /reg:64', e2.message);
    }

    await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:64']);
    await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:64']);
    console.log('✓ Registro SAMP actualizado (/reg:64):', gtaExePath);
}

// Descargar/extraer
function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);

        const request = https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                fs.unlinkSync(dest);
                return downloadFile(response.headers.location, dest, onProgress)
                    .then(resolve).catch(reject);
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

                if (timeDiff >= 0.5) {
                    const sizeDiff = downloadedSize - lastSize;
                    const speed = sizeDiff / timeDiff;
                    const progress = Math.round((downloadedSize / totalSize) * 100);
                    if (onProgress) onProgress(progress, downloadedSize, totalSize, speed);
                    lastTime = now;
                    lastSize = downloadedSize;
                }
            });

            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        });

        request.on('error', (err) => {
            file.close(); fs.unlinkSync(dest); reject(err);
        });
        file.on('error', (err) => {
            file.close(); fs.unlinkSync(dest); reject(err);
        });
    });
}

async function extractZip(source, dest, onProgress) {
    const directory = await unzipper.Open.file(source);
    const totalEntries = directory.files.length;
    let extractedEntries = 0;

    return new Promise((resolve, reject) => {
        fs.ensureDirSync(dest);

        fs.createReadStream(source)
            .pipe(unzipper.Parse())
            .on('entry', (entry) => {
                extractedEntries++;
                const progress = Math.round((extractedEntries / totalEntries) * 100);
                if (onProgress) onProgress(progress);

                const fileName = entry.path;
                const type = entry.type;

                let extractPath;
                if (fileName.startsWith('GTA San Andreas/')) {
                    const relativePath = fileName.substring('GTA San Andreas/'.length);
                    if (relativePath) extractPath = path.join(dest, relativePath); else { entry.autodrain(); return; }
                } else if (fileName.startsWith('GTA_San_Andreas/')) {
                    const relativePath = fileName.substring('GTA_San_Andreas/'.length);
                    if (relativePath) extractPath = path.join(dest, relativePath); else { entry.autodrain(); return; }
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
            .on('close', () => setTimeout(() => resolve(), 1000))
            .on('error', reject);
    });
}

// IPC Handlers

ipcMain.handle('select-install-path', async () => {
    const defaultPath = app.getPath('documents');

    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Seleccionar carpeta para instalar GTA Horizon',
        defaultPath: defaultPath,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Seleccionar esta carpeta'
    });

    if (result.canceled || !result.filePaths[0]) {
        return { success: false, canceled: true };
    }

    const selectedPath = result.filePaths[0];
    const gtaPath = path.join(selectedPath, 'GTA Horizon');

    // Verificar permisos de escritura
    try {
        await fs.ensureDir(gtaPath);
        const testFile = path.join(gtaPath, '.write_test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
    } catch (e) {
        return {
            success: false,
            message: 'No tienes permisos para escribir en esta carpeta. Elige otra ubicación.'
        };
    }

    // Verificar espacio (necesitamos ~5GB)
    try {
        const spaceCheck = await checkAvailableSpace(5 * 1024 * 1024 * 1024, selectedPath);
        if (!spaceCheck.success) {
            // Limpiar carpeta creada
            try { await fs.remove(gtaPath); } catch { }
            return { success: false, message: spaceCheck.message };
        }
    } catch (e) {
        console.warn('No se pudo verificar espacio:', e.message);
    }

    // Guardar la ruta
    CONFIG.gtaPath = gtaPath;
    saveConfig();

    return {
        success: true,
        path: gtaPath
    };
});

// Controles de ventana
ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('close-window', () => {
    if (downloadActive) {
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Cancelar descarga y salir', 'Continuar descargando'],
            defaultId: 1,
            message: 'Hay una descarga en progreso',
            detail: 'Si sales ahora, tendrás que descargar todo de nuevo.'
        });
        if (choice === 1) return;
    }
    app.quit();
});

ipcMain.on('open-external', (e, url) => shell.openExternal(url));

ipcMain.on('open-path', (e, folderPath) => {
    if (folderPath) {
        shell.openPath(folderPath);
    }
});

ipcMain.on('open-install-folder', () => {
    if (CONFIG.gtaPath && fs.existsSync(CONFIG.gtaPath)) {
        shell.openPath(CONFIG.gtaPath);
    } else if (CONFIG.gtaPath) {
        // Si la ruta está configurada pero no existe, abrir la carpeta padre
        const parentPath = path.dirname(CONFIG.gtaPath);
        if (fs.existsSync(parentPath)) {
            shell.openPath(parentPath);
        } else {
            shell.openPath(app.getPath('documents'));
        }
    } else {
        shell.openPath(app.getPath('documents'));
    }
});

ipcMain.on('request-server-info', async () => { await updateServerInfo(); });

// Estadísticas bajo demanda
ipcMain.on('request-statistics', async () => {
    const stats = await gameAPI.getStatistics();
    if (mainWindow && stats) mainWindow.webContents.send('statistics-update', stats);
});

// Versión app
ipcMain.handle('app-version', () => app.getVersion());

// Sistema de Nickname
ipcMain.on('get-nickname', async (event) => {
    const nick = await getNickname();
    event.reply('nickname-current', nick || '');
});

ipcMain.handle('save-nickname', async (event, nickname) => {
    try {
        await setNickname(nickname);
        return { success: true };
    } catch (error) {
        console.error('Error guardando nickname:', error);
        throw error;
    }
});

// Nuevo handler para iniciar juego con nickname
ipcMain.on('start-game-with-nickname', async (event, nickname) => {
    try {
        // Guardar nickname
        await setNickname(nickname);

        // Verificar si el juego está instalado
        const isInstalled = await checkGameInstalled();

        if (!isInstalled) {
            // Si no hay ruta configurada, pedir que elija
            if (!CONFIG.gtaPath) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('request-install-path');
                }
                return;
            }

            // Hay ruta pero no está instalado, descargar
            if (mainWindow) mainWindow.webContents.send('game-starting');
            downloadGame();
        } else {
            // Juego instalado, iniciar
            if (mainWindow) mainWindow.webContents.send('game-starting');

            const result = await launchGame();
            if (!result.success && mainWindow) {
                mainWindow.webContents.send('game-error', result.message);
            }
        }
    } catch (error) {
        console.error('Error iniciando juego:', error);
        if (mainWindow) mainWindow.webContents.send('game-error', error.message);
    }
});

ipcMain.on('start-download-with-path', async (event, selectedPath) => {
    if (selectedPath) {
        CONFIG.gtaPath = selectedPath;
        saveConfig();
    }
    downloadGame();
});

// Obtener ruta instalación (para settings)
ipcMain.on('get-installation-path', () => {
    if (mainWindow) {
        const displayPath = CONFIG.gtaPath || 'No instalado';
        mainWindow.webContents.send('installation-path', displayPath);
    }
});

ipcMain.handle('check-existing-installation', async (_, checkPath) => {
    try {
        const gtaPath = path.join(checkPath, 'GTA Horizon');
        const markerFile = path.join(gtaPath, '.horizonrp');

        if (fs.existsSync(markerFile)) {
            const gameFiles = findGameFiles(gtaPath);
            if (gameFiles['gta_sa.exe'] && gameFiles['samp.exe']) {
                return {
                    exists: true,
                    valid: true,
                    path: gtaPath
                };
            }
            return { exists: true, valid: false, path: gtaPath };
        }
        return { exists: false };
    } catch (e) {
        return { exists: false, error: e.message };
    }
});

// Sistema de instalación y juego
ipcMain.handle('check-gta-installed', async () => {
    if (!CONFIG.gtaPath) return false;
    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) {
        return false;
    }
    const gameFiles = findGameFiles(CONFIG.gtaPath);
    return !!(gameFiles['gta_sa.exe'] && gameFiles['samp.exe']);
});

ipcMain.handle('get-install-path', async () => {
    if (!CONFIG.gtaPath) loadConfig();
    return CONFIG.gtaPath || 'No configurado';
});

// ============================================
// AÑADIR: Handler para obtener información de instalación
// ============================================
ipcMain.handle('get-install-info', async () => {
    try {
        const info = {
            launcherVersion: app.getVersion(),
            installSize: null,
            installPath: CONFIG.gtaPath || 'No configurado',
            isInstalled: false
        };

        if (CONFIG.gtaPath && fs.existsSync(CONFIG.gtaPath)) {
            info.isInstalled = true;

            // Calcular tamaño de la instalación
            const size = await getDirectorySize(CONFIG.gtaPath);
            info.installSize = size;
        }

        return info;
    } catch (e) {
        console.error('Error obteniendo info de instalación:', e);
        return {
            launcherVersion: app.getVersion(),
            installSize: null,
            installPath: CONFIG.gtaPath || 'No configurado',
            isInstalled: false
        };
    }
});

// ============================================
// AÑADIR: Función para calcular tamaño de directorio
// ============================================
async function getDirectorySize(dirPath) {
    let totalSize = 0;

    try {
        const items = await fs.readdir(dirPath, { withFileTypes: true });

        for (const item of items) {
            const itemPath = path.join(dirPath, item.name);

            if (item.isDirectory()) {
                totalSize += await getDirectorySize(itemPath);
            } else if (item.isFile()) {
                try {
                    const stats = await fs.stat(itemPath);
                    totalSize += stats.size;
                } catch {
                    // Ignorar archivos que no se pueden leer
                }
            }
        }
    } catch (e) {
        console.warn('Error calculando tamaño de:', dirPath, e.message);
    }

    return totalSize;
}

ipcMain.handle('verify-files', async () => {
    const send = (ch, payload) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(ch, payload);
            }
        } catch { }
    };

    try {
        if (!CONFIG.gtaPath) loadConfig();

        send('download-progress', { percent: 0, message: 'Iniciando verificación completa...' });

        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 15000 });
        if (!manifest || !manifest.files || !Array.isArray(manifest.files)) {
            send('download-error', 'No se pudo obtener el manifest de verificación');
            return false;
        }

        if (!fs.existsSync(CONFIG.gtaPath)) {
            send('download-error', 'GTA no está instalado');
            return false;
        }

        const filesToUpdate = [];
        let totalUpdateSize = 0;
        let checkedFiles = 0;
        const totalFiles = manifest.files.length;

        console.log(`=== Verificación completa de ${totalFiles} archivos ===`);

        for (const fileInfo of manifest.files) {
            checkedFiles++;

            // Actualizar progreso
            if (checkedFiles % 25 === 0 || checkedFiles === totalFiles) {
                const verifyProgress = Math.round((checkedFiles / totalFiles) * 50);
                send('download-progress', {
                    percent: verifyProgress,
                    message: `Verificando ${checkedFiles}/${totalFiles} archivos...`
                });
            }

            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);

            // Verificar existencia
            if (!fs.existsSync(localPath)) {
                console.log(`[FALTA] ${fileInfo.path}`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            // Verificar tamaño
            const stats = fs.statSync(localPath);
            if (stats.size !== fileInfo.size) {
                console.log(`[TAMAÑO] ${fileInfo.path} - Local: ${stats.size}, Esperado: ${fileInfo.size}`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            // SIEMPRE verificar hash
            const localHash = await sha256File(localPath);
            if (!localHash || localHash.toLowerCase() !== fileInfo.hash.toLowerCase()) {
                console.log(`[HASH] ${fileInfo.path}`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
            }
        }

        console.log(`=== Verificación completada: ${filesToUpdate.length} archivos necesitan actualización ===`);

        if (filesToUpdate.length > 0) {
            send('download-progress', {
                percent: 50,
                message: `Descargando ${filesToUpdate.length} archivos (${formatBytes(totalUpdateSize)})...`
            });

            await downloadFilesParallel(filesToUpdate, 3);

            send('download-progress', { percent: 100, message: 'Verificación y reparación completa' });
            send('download-complete');
        } else {
            send('download-progress', { percent: 100, message: 'Todos los archivos están correctos' });
            send('download-complete');
        }

        // Verificar archivos críticos
        const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
        if (!fs.existsSync(markerFile)) return false;

        const gameFiles = findGameFiles(CONFIG.gtaPath);
        return !!(gameFiles['gta_sa.exe'] && gameFiles['samp.exe'] && gameFiles['samp.dll']);

    } catch (error) {
        console.error('Error durante verificación:', error);
        send('download-error', `Error: ${error.message}`);
        return false;
    }
});

ipcMain.handle('has-install-path', async () => {
    if (!CONFIG.gtaPath) loadConfig();
    return !!CONFIG.gtaPath;
});

ipcMain.on('reset-installation', async () => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Cancelar', 'Eliminar y reinstalar'],
        defaultId: 0,
        message: '¿Deseas eliminar la instalación actual?',
        detail: 'Esto eliminará todos los archivos del juego y tendrás que descargar todo de nuevo.'
    });
    if (choice === 1 && CONFIG.gtaPath && fs.existsSync(CONFIG.gtaPath)) {
        try {
            await fs.remove(CONFIG.gtaPath);
            CONFIG.gtaPath = null;
            const configPath = path.join(app.getPath('userData'), 'horizonrp_config.json');
            if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
            if (mainWindow) mainWindow.webContents.send('installation-reset', 'Instalación eliminada correctamente');
        } catch (error) {
            if (mainWindow) mainWindow.webContents.send('installation-reset', 'Error: ' + error.message);
        }
    }
});

ipcMain.on('start-game', async () => {
    const isInstalled = await checkGameInstalled();

    if (!isInstalled) {
        // Si no está instalado, verificar si hay ruta configurada
        if (!CONFIG.gtaPath) {
            // Pedir al usuario que seleccione ruta primero
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('request-install-path');
            }
        } else {
            // Hay ruta pero no está instalado, descargar
            downloadGame();
        }
    } else {
        const result = await launchGame();
        if (!result.success && mainWindow) {
            mainWindow.webContents.send('game-error', result.message);
        }
    }
});

async function checkGameInstalled() {
    if (!CONFIG.gtaPath) return false;
    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) {
        return false;
    }
    const gameFiles = findGameFiles(CONFIG.gtaPath);
    return !!(gameFiles['gta_sa.exe'] && gameFiles['samp.exe']);
}

// Verificación de archivos post-extracción (VERIFICA HASH SIEMPRE)
async function verifyGameFiles() {
    const send = (ch, payload) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(ch, payload);
            }
        } catch { }
    };

    try {
        if (!CONFIG.gtaPath) {
            return { success: false, message: 'No hay ruta de GTA configurada.' };
        }

        send('download-progress', { percent: 90, message: 'Verificando archivos instalados...' });

        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 15000 });
        if (!manifest || !manifest.files || !Array.isArray(manifest.files)) {
            throw new Error('No se pudo obtener el manifest de verificación');
        }

        const filesToUpdate = [];
        let totalUpdateSize = 0;
        let checkedFiles = 0;
        const totalFiles = manifest.files.length;

        console.log(`Verificando ${totalFiles} archivos después de extracción...`);

        for (const fileInfo of manifest.files) {
            checkedFiles++;
            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);

            // Actualizar progreso cada 50 archivos
            if (checkedFiles % 50 === 0) {
                const progress = 90 + Math.round((checkedFiles / totalFiles) * 8);
                send('download-progress', {
                    percent: progress,
                    message: `Verificando ${checkedFiles}/${totalFiles}...`
                });
            }

            // Si no existe
            if (!fs.existsSync(localPath)) {
                console.log(`Falta archivo: ${fileInfo.path}`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            // Verificar tamaño
            const stats = fs.statSync(localPath);
            if (stats.size !== fileInfo.size) {
                console.log(`Tamaño incorrecto: ${fileInfo.path}`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            // SIEMPRE verificar hash
            const localHash = await sha256File(localPath);
            if (!localHash || localHash.toLowerCase() !== fileInfo.hash.toLowerCase()) {
                console.log(`Hash incorrecto: ${fileInfo.path}`);
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
            }
        }

        if (filesToUpdate.length > 0) {
            console.log(`Se encontraron ${filesToUpdate.length} archivos para reparar (${formatBytes(totalUpdateSize)})`);

            send('download-progress', {
                percent: 98,
                message: `Reparando ${filesToUpdate.length} archivos...`
            });

            await downloadFilesParallel(filesToUpdate, 5);
        }

        // Guardar versión si existe en manifest
        if (manifest.version) {
            setLocalGameVersion(manifest.version);
        }

        send('download-progress', { percent: 100, message: 'Verificación completada.' });
        return { success: true };

    } catch (e) {
        console.error('Error durante la verificación:', e);
        send('download-error', `Error de verificación: ${e.message}`);
        return { success: false, message: e.message };
    }
}

// downloadGame para usar HZGTA.zip
async function downloadGame(customPath = null) {
    const send = (ch, payload) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(ch, payload);
            }
        } catch { }
    };

    if (downloadActive) {
        send('download-error', 'Ya hay una descarga en progreso');
        return;
    }

    // Si se proporciona una ruta personalizada, usarla
    if (customPath) {
        CONFIG.gtaPath = customPath;
        saveConfig();
    }

    // Si no hay ruta configurada, pedir al usuario que seleccione una
    if (!CONFIG.gtaPath) {
        send('request-install-path');
        return;
    }

    downloadActive = true;

    const zipUrl = 'https://pub-9d7e62ca68da4c1fb5a98f2a71cdf404.r2.dev/HZGTA.zip';
    const tempZipPath = path.join(app.getPath('temp'), 'HZGTA.zip');

    try {
        send('download-progress', { percent: 0, message: 'Verificando espacio en disco...' });

        // Verificar espacio en disco (ZIP ~4GB + extracción ~5GB = ~9GB necesarios)
        const spaceCheck = await checkAvailableSpace(9 * 1024 * 1024 * 1024, CONFIG.gtaPath);
        if (!spaceCheck.success) {
            throw new Error(spaceCheck.message);
        }

        // Crear directorio de instalación
        await fs.ensureDir(CONFIG.gtaPath);

        send('download-progress', { percent: 0, message: 'Preparando descarga...' });

        // Descargar el ZIP
        await downloadFile(zipUrl, tempZipPath, (percent, current, total, speed) => {
            send('download-progress', {
                percent: Math.round(percent * 0.75), // 0-75% para descarga
                message: 'Descargando GTA Horizon...',
                current: current,
                total: total,
                speed: speed
            });
        });

        send('download-progress', { percent: 75, message: 'Descarga completada. Extrayendo archivos...' });

        // Extraer el ZIP
        await extractZip(tempZipPath, CONFIG.gtaPath, (progress) => {
            send('download-progress', {
                percent: 75 + Math.round(progress * 0.15), // 75-90% para extracción
                message: `Extrayendo archivos... (${progress}%)`
            });
        });

        // Eliminar ZIP temporal
        try {
            await fs.unlink(tempZipPath);
            console.log('ZIP temporal eliminado');
        } catch (e) {
            console.warn("No se pudo borrar el ZIP temporal:", e.message);
        }

        send('download-progress', { percent: 90, message: 'Verificando archivos instalados...' });

        // Verificar archivos
        const verificationResult = await verifyGameFiles();
        if (!verificationResult.success) {
            throw new Error(verificationResult.message || 'La verificación de archivos falló.');
        }

        // Crear archivo marcador de instalación
        const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
        fs.writeFileSync(markerFile, JSON.stringify({
            version: getLocalGameVersion(),
            server: CONFIG.serverName,
            installedAt: new Date().toISOString(),
            installPath: CONFIG.gtaPath
        }, null, 2));

        // Verificar que los archivos esenciales existen
        const gameFiles = findGameFiles(CONFIG.gtaPath);
        if (gameFiles['gta_sa.exe'] && gameFiles['samp.exe']) {
            saveConfig();
            downloadActive = false;

            send('download-progress', { percent: 100, message: '¡Instalación completada!' });
            send('download-complete');
            send('installation-path', CONFIG.gtaPath);

            // Iniciar el juego después de 2 segundos
            setTimeout(async () => {
                const result = await launchGame();
                if (!result.success) {
                    send('game-error', result.message);
                }
            }, 2000);
        } else {
            throw new Error('Archivos de juego no encontrados tras la extracción. Por favor, reinstala.');
        }

    } catch (error) {
        downloadActive = false;

        // Limpiar ZIP temporal si existe
        if (fs.existsSync(tempZipPath)) {
            try {
                await fs.unlink(tempZipPath);
            } catch { }
        }

        console.error('Error en la instalación:', error);
        send('download-error', error.message);
    }
}

async function launchGame() {
    if (!CONFIG.gtaPath) return { success: false, message: 'El juego no está instalado' };
    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) { return { success: false, message: 'Instalación corrupta. Por favor reinstala.' }; }

    const gameFiles = findGameFiles(CONFIG.gtaPath);
    if (!gameFiles['samp.exe'] || !gameFiles['gta_sa.exe']) return { success: false, message: 'No se encontraron los archivos del juego' };

    try {
        await updateSAMPRegistry(gameFiles['gta_sa.exe']);
        const launcherFlag = path.join(CONFIG.gtaPath, '.launcher_active');
        fs.writeFileSync(launcherFlag, Date.now().toString());
        const gameCwd = path.dirname(gameFiles['samp.exe']);
        const gameProcess = spawn(gameFiles['samp.exe'], [`${CONFIG.serverIP}:${CONFIG.serverPort}`], {
            cwd: gameCwd,
            detached: true,
            stdio: 'ignore'
        });
        setTimeout(() => {
            try { fs.unlinkSync(launcherFlag); } catch { }
        }, 10000);

        gameProcess.unref();
        setTimeout(() => mainWindow?.minimize(), 2000);
        return { success: true };
    } catch (error) {
        console.error('Error al iniciar juego:', error);
        return { success: false, message: error.message };
    }
}

// Funciones auxiliares
function findGameFiles(basePath) {
    const requiredFiles = ['gta_sa.exe', 'samp.exe', 'samp.dll'];
    const foundFiles = {};
    for (const file of requiredFiles) {
        const fullPath = path.join(basePath, file);
        if (fs.existsSync(fullPath)) foundFiles[file] = fullPath;
    }
    if (Object.keys(foundFiles).length < requiredFiles.length) {
        const subDirs = ['GTA San Andreas', 'GTA_San_Andreas', 'game'];
        for (const dir of subDirs) {
            const dirPath = path.join(basePath, dir);
            if (fs.existsSync(dirPath)) {
                for (const file of requiredFiles) {
                    if (!foundFiles[file]) {
                        const fullPath = path.join(dirPath, file);
                        if (fs.existsSync(fullPath)) foundFiles[file] = fullPath;
                    }
                }
            }
        }
    }
    return foundFiles;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Inicialización
app.whenReady().then(() => {
    checkingUpdatesWindow = new BrowserWindow({
        width: 400,
        height: 220,  // Altura fija adecuada
        frame: false,
        resizable: false,
        movable: true,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        center: true,
        skipTaskbar: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    checkingUpdatesWindow.loadFile('src/checking-updates.html');

    checkingUpdatesWindow.on('closed', () => {
        checkingUpdatesWindow = null;
    });

    initLauncherAutoUpdate();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });