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
    serverIP: '195.26.252.73',
    serverPort: 7777,
    website: 'https://horizonrp.es',
    discord: 'https://discord.gg/horizonrp',
    forum: 'https://foro.horizonrp.es',
    wiki: 'https://wiki.horizonrp.es',
    baseDownloadURL: 'https://horizonrp.es/HZGTA/',
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

// Descarga paralela con control de concurrencia
async function downloadFilesParallel(files, maxConcurrent = 3) {
    const send = (ch, payload) => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); } catch { }
    };

    let completedFiles = 0;
    let failedFiles = [];
    const totalFiles = files.length;
    let totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
    let downloadedBytes = 0;

    const needsDownload = async (fileInfo) => {
        const localPath = path.join(CONFIG.gtaPath, fileInfo.path);
        if (!fs.existsSync(localPath)) return true;
        const currentHash = await sha256File(localPath);
        return !currentHash || currentHash.toLowerCase() !== fileInfo.hash.toLowerCase();
    };

    const downloadWithRetry = async (fileInfo, retries = 3) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const shouldDownload = await needsDownload(fileInfo);
                if (!shouldDownload) {
                    console.log(`Archivo ${fileInfo.path} ya existe y es válido, saltando...`);
                    completedFiles++;
                    return true;
                }

                console.log(`Descargando ${fileInfo.path} (intento ${attempt}/${retries})`);
                await downloadSingleFile(fileInfo);
                return true;
            } catch (error) {
                console.error(`Error en ${fileInfo.path}, intento ${attempt}:`, error.message);
                if (attempt === retries) {
                    failedFiles.push(fileInfo);
                    return false;
                }
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }
    };

    const downloadSingleFile = (fileInfo) => {
        return new Promise((resolve, reject) => {
            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);
            const localDir = path.dirname(localPath);
            fs.ensureDirSync(localDir);

            const fileUrl = `${CONFIG.baseDownloadURL}${fileInfo.path}`;
            const file = fs.createWriteStream(localPath);
            let timeout;

            const handleError = (err) => {
                clearTimeout(timeout);
                file.close();
                try { fs.unlinkSync(localPath); } catch { }
                reject(err);
            };

            const handleResponse = (res) => {
                res.on('data', (chunk) => {
                    clearTimeout(timeout);
                    timeout = setTimeout(() => handleError(new Error(`Timeout durante ${fileInfo.path}`)), 30000);

                    downloadedBytes += chunk.length;
                    send('download-progress', {
                        percent: Math.round((completedFiles / totalFiles) * 100),
                        message: `Descargando archivo ${completedFiles + 1}/${totalFiles}: ${path.basename(fileInfo.path)}`,
                        current: downloadedBytes,
                        total: totalBytes
                    });
                });

                res.pipe(file);

                file.on('finish', () => {
                    clearTimeout(timeout);
                    file.close();
                    completedFiles++;
                    console.log(`✓ Completado ${completedFiles}/${totalFiles}: ${fileInfo.path}`);
                    resolve();
                });

                file.on('error', handleError);
            };

            const request = https.get(fileUrl, (response) => {
                if ([301, 302].includes(response.statusCode)) {
                    const redirectUrl = response.headers.location;
                    if (redirectUrl) {
                        https.get(redirectUrl, handleResponse).on('error', handleError);
                    } else {
                        handleError(new Error(`Redirección inválida para ${fileInfo.path}`));
                    }
                    return;
                }
                if (response.statusCode !== 200) {
                    return handleError(new Error(`HTTP ${response.statusCode} para ${fileInfo.path}`));
                }
                handleResponse(response);
            });

            request.on('error', handleError);
            request.on('timeout', () => {
                request.destroy();
                handleError(new Error('Request timeout'));
            });

            timeout = setTimeout(() => handleError(new Error(`Timeout para ${fileInfo.path}`)), 30000);
        });
    };

    console.log(`Iniciando descarga de ${files.length} archivos con ${maxConcurrent} simultáneos...`);

    for (let i = 0; i < files.length; i += maxConcurrent) {
        const batch = files.slice(i, i + maxConcurrent);
        console.log(`Procesando lote ${Math.floor(i / maxConcurrent) + 1}/${Math.ceil(files.length / maxConcurrent)}`);
        await Promise.all(batch.map(f => downloadWithRetry(f, 3)));

        if (i + maxConcurrent < files.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    if (failedFiles.length > 0) {
        console.error(`Archivos que fallaron (${failedFiles.length}):`, failedFiles.map(f => f.path));
        throw new Error(`No se pudieron descargar ${failedFiles.length} archivos`);
    }

    console.log(`✓ Descarga completa: ${completedFiles} archivos`);
}

// Auto-update del juego mejorado
async function initGameAutoUpdate() {
    try {
        if (!CONFIG.gtaPath) loadConfig();

        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 8000 });
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
            }

            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);

            if (!fs.existsSync(localPath)) {
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            const stats = fs.statSync(localPath);
            if (stats.size !== fileInfo.size) {
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            if (stats.size < 1024 * 1024) {
                const localHash = await sha256File(localPath);
                if (!localHash || localHash.toLowerCase() !== fileInfo.hash.toLowerCase()) {
                    filesToUpdate.push(fileInfo);
                    totalUpdateSize += fileInfo.size || 0;
                }
            }
        }

        if (filesToUpdate.length > 0) {
            console.log(`Actualización disponible: ${filesToUpdate.length} archivos (${formatBytes(totalUpdateSize)})`);
            if (mainWindow) {
                mainWindow.webContents.send('game-update', {
                    state: 'available',
                    filesCount: filesToUpdate.length,
                    totalSize: totalUpdateSize
                });
            }

            await downloadFilesParallel(filesToUpdate, 3);

            if (mainWindow) {
                mainWindow.webContents.send('download-progress', {
                    percent: 100,
                    message: 'Actualización completa'
                });
                mainWindow.webContents.send('download-complete');
            }
        } else {
            console.log('GTA está actualizado');
            if (mainWindow) mainWindow.webContents.send('game-update', { state: 'uptodate' });
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
            if (saved.gtaPath && fs.existsSync(path.join(saved.gtaPath, '.horizonrp'))) {
                CONFIG.gtaPath = saved.gtaPath;
                console.log('✓ Instalación cargada:', CONFIG.gtaPath);
                return;
            }
        }
    } catch (e) {
        console.error('✗ Error cargando config:', e);
    }

    CONFIG.gtaPath = path.join(app.getPath('documents'), 'GTA Horizon');
    console.log('✓ Ruta de GTA en Documents:', CONFIG.gtaPath);
    saveConfig();
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

function initLauncherAutoUpdate() {
    log.info('Initializing launcher auto update...');
    autoUpdater.on('error', (error) => {
        log.error('Update error:', error == null ? "unknown" : (error.stack || error).toString());
        startMainApp();
    });

    autoUpdater.on('update-not-available', () => {
        log.info('Update not available.');
        startMainApp();
    });

    autoUpdater.on('update-available', () => {
        log.info('Update available, starting download...');
        if (checkingUpdatesWindow) {
            checkingUpdatesWindow.webContents.send('update-message', 'Descargando actualización...');
        }
    });

    autoUpdater.on('update-downloaded', () => {
        log.info('Update downloaded, showing update window.');

        if (checkingUpdatesWindow) {
            checkingUpdatesWindow.close();
        }
        if (mainWindow) {
            mainWindow.close();
        }

        updateWindow = new BrowserWindow({
            width: 450,
            height: 250,
            frame: false,
            resizable: false,
            movable: true,
            transparent: true,
            backgroundColor: '#00000000',
            alwaysOnTop: true,
            center: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });

        updateWindow.loadFile('src/update.html');

        updateWindow.on('closed', () => {
            updateWindow = null;
        });

        setTimeout(() => {
            if (!updateWindow) return;
            log.info('Quitting and installing update...');
            try {
                autoUpdater.quitAndInstall(true, true);
            } catch (e) {
                log.error('Error during quitAndInstall:', e);
                app.quit();
            }
        }, 5000);
    });

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
async function updateServerInfo() {
    const serverOptions = { host: '195.26.252.73', port: 7777, timeout: 5000 };
    const startTime = Date.now();

    query(serverOptions, (error, response) => {
        const endTime = Date.now();
        const calculatedPing = Math.round((endTime - startTime) / 3);

        if (error) {
            const serverInfo = { online: false, players: 0, maxPlayers: 500, ping: 0 };
            if (mainWindow) mainWindow.webContents.send('server-info-update', serverInfo);
            return;
        }

        const serverInfo = {
            online: true,
            players: response.online || 0,
            maxPlayers: response.maxplayers || 500,
            hostname: response.hostname || 'Horizon Roleplay',
            gamemode: response.gamemode || 'Roleplay',
            mapname: response.mapname || 'Los Santos',
            passworded: response.passworded || false,
            ping: response.ping > 0 ? response.ping : calculatedPing
        };
        if (mainWindow) mainWindow.webContents.send('server-info-update', serverInfo);
    });
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
        // Guardar nickname en el registro
        await setNickname(nickname);

        // Notificar que el juego está iniciando
        if (mainWindow) mainWindow.webContents.send('game-starting');

        // Verificar si el juego está instalado
        const isInstalled = await checkGameInstalled();
        if (!isInstalled) {
            downloadGame();
        } else {
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

// Obtener ruta instalación (para settings)
ipcMain.on('get-installation-path', () => {
    if (mainWindow) {
        const displayPath = CONFIG.gtaPath || 'No instalado';
        mainWindow.webContents.send('installation-path', displayPath);
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

ipcMain.handle('get-install-path', async () => CONFIG.gtaPath || 'No instalado');

ipcMain.handle('verify-files', async () => {
    const send = (ch, payload) => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); } catch { }
    };

    try {
        if (!CONFIG.gtaPath) loadConfig();

        send('download-progress', { percent: 0, message: 'Iniciando verificación de archivos...' });

        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 8000 });
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

        send('download-progress', { percent: 5, message: `Verificando ${manifest.files.length} archivos...` });

        for (const fileInfo of manifest.files) {
            checkedFiles++;

            if (checkedFiles % 50 === 0) {
                const verifyProgress = Math.round((checkedFiles / manifest.files.length) * 40) + 5;
                send('download-progress', {
                    percent: verifyProgress,
                    message: `Verificando archivos... ${checkedFiles}/${manifest.files.length}`
                });
            }

            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);

            if (!fs.existsSync(localPath)) {
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            const stats = fs.statSync(localPath);
            if (stats.size !== fileInfo.size) {
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
                continue;
            }

            if (stats.size < 1024 * 1024) {
                const localHash = await sha256File(localPath);
                if (!localHash || localHash.toLowerCase() !== fileInfo.hash.toLowerCase()) {
                    filesToUpdate.push(fileInfo);
                    totalUpdateSize += fileInfo.size || 0;
                }
            }
        }

        if (filesToUpdate.length > 0) {
            send('download-progress', {
                percent: 45,
                message: `Se encontraron ${filesToUpdate.length} archivos para actualizar (${formatBytes(totalUpdateSize)})`
            });

            await downloadFilesParallel(filesToUpdate, 3);

            send('download-progress', { percent: 100, message: 'Verificación completa' });
            send('download-complete');
        } else {
            send('download-progress', { percent: 100, message: 'Todos los archivos están actualizados' });
            send('download-complete');
        }

        const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
        if (!fs.existsSync(markerFile)) return false;
        const gameFiles = findGameFiles(CONFIG.gtaPath);
        return !!(gameFiles['gta_sa.exe'] && gameFiles['samp.exe'] && gameFiles['samp.dll']);

    } catch (error) {
        console.error('Error durante verificación:', error);
        send('download-error', `Error verificando archivos: ${error.message}`);
        return false;
    }
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
        downloadGame();
    } else {
        const result = await launchGame();
        if (!result.success && mainWindow) mainWindow.webContents.send('game-error', result.message);
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

// Verificación de archivos post-extracción
async function verifyGameFiles() {
    const send = (ch, payload) => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); } catch { }
    };

    try {
        if (!CONFIG.gtaPath) return { success: false, message: 'No hay ruta de GTA configurada.' };

        send('download-progress', { percent: 95, message: 'Verificando archivos...' });

        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 8000 });
        if (!manifest || !manifest.files || !Array.isArray(manifest.files)) {
            throw new Error('Manifest de verificación inválido');
        }

        const filesToUpdate = [];
        let totalUpdateSize = 0;
        let checkedFiles = 0;

        for (const fileInfo of manifest.files) {
            checkedFiles++;
            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);

            if (checkedFiles % 100 === 0) {
                const progress = 95 + Math.round((checkedFiles / manifest.files.length) * 5);
                send('download-progress', {
                    percent: progress,
                    message: `Verificando ${checkedFiles}/${manifest.files.length}...`
                });
            }

            if (!fs.existsSync(localPath) || fs.statSync(localPath).size !== fileInfo.size) {
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size || 0;
            }
        }

        if (filesToUpdate.length > 0) {
            console.log(`Verificación encontró ${filesToUpdate.length} archivos faltantes o corruptos.`);
            send('game-update', {
                state: 'available',
                filesCount: filesToUpdate.length,
                totalSize: totalUpdateSize
            });

            await downloadFilesParallel(filesToUpdate, 5);
        }

        if (manifest.version) {
            setLocalGameVersion(manifest.version);
        }

        send('download-progress', { percent: 100, message: 'Verificación completada.' });
        return { success: true };

    } catch (e) {
        console.error('Error durante la verificación de archivos:', e);
        send('download-error', `Error de verificación: ${e.message}`);
        return { success: false, message: e.message };
    }
}

// downloadGame para usar HZGTA.zip
async function downloadGame() {
    const send = (ch, payload) => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); } catch { }
    };

    if (downloadActive) {
        send('download-error', 'Descarga ya en progreso');
        return;
    }
    if (!CONFIG.gtaPath) loadConfig();
    await fs.ensureDir(CONFIG.gtaPath);
    downloadActive = true;

    const zipUrl = 'https://pub-9d7e62ca68da4c1fb5a98f2a71cdf404.r2.dev/HZGTA.zip';
    const tempZipPath = path.join(app.getPath('temp'), 'HZGTA.zip');

    try {
        send('download-progress', { percent: 0, message: 'Preparando descarga...' });

        await downloadFile(zipUrl, tempZipPath, (percent, current, total, speed) => {
            send('download-progress', {
                percent: Math.round(percent * 0.8),
                message: 'Descargando GTA Horizon...',
                current: current,
                total: total,
                speed: speed
            });
        });

        send('download-progress', { percent: 80, message: 'Descarga completada. Extrayendo...' });

        await extractZip(tempZipPath, CONFIG.gtaPath, (progress) => {
            send('download-progress', {
                percent: 80 + Math.round(progress * 0.15),
                message: `Extrayendo archivos... (${progress}%)`
            });
        });

        try {
            await fs.unlink(tempZipPath);
        } catch (e) {
            console.warn("No se pudo borrar el zip temporal:", e.message);
        }

        const verificationResult = await verifyGameFiles();
        if (!verificationResult.success) {
            throw new Error(verificationResult.message || 'La verificación de archivos falló.');
        }

        const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
        fs.writeFileSync(markerFile, JSON.stringify({
            version: getLocalGameVersion(),
            server: CONFIG.serverName,
            installedAt: new Date().toISOString()
        }));

        const gameFiles = findGameFiles(CONFIG.gtaPath);
        if (gameFiles['gta_sa.exe'] && gameFiles['samp.exe']) {
            saveConfig();
            downloadActive = false;
            send('download-complete');

            setTimeout(async () => {
                const result = await launchGame();
                if (!result.success) send('game-error', result.message);
            }, 2000);
        } else {
            throw new Error('Archivos de juego no encontrados tras la extracción.');
        }

    } catch (error) {
        downloadActive = false;
        if (fs.existsSync(tempZipPath)) {
            try { await fs.unlink(tempZipPath); } catch { }
        }
        console.error('Error en la instalación desde ZIP:', error);
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
        width: 450,
        height: 250,
        frame: false,
        resizable: false,
        movable: true,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        center: true,
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