const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const https = require('https');
const unzipper = require('unzipper');
const regedit = require('regedit'); // solo para setExternalVBSLocation (no usamos su API)
const query = require('samp-query');
const GameAPI = require('./src/services/api');
const { autoUpdater } = require('electron-updater');
const axios = require('axios');
const crypto = require('crypto');
const log = require('electron-log');
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Configurar regedit para usar VBS (necesario si en algn momento usas su API)
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
let nicknameWindow = null;
let updateWindow = null;
let checkingUpdatesWindow = null;
let downloadActive = false;
const gameAPI = new GameAPI();

// Configuracin del servidor
const CONFIG = {
    serverName: 'Horizon Roleplay',
    serverIP: '195.26.252.73',
    serverPort: 7778,
    website: 'https://horizonrp.es',
    discord: 'https://discord.gg/horizonrp',
    forum: 'https://foro.horizonrp.es',
    wiki: 'https://wiki.horizonrp.es',
    baseDownloadURL: 'https://horizonrp.es/HZGTA/', // Nueva URL base para archivos individuales
    gtaPath: null
};

const TITLEBAR_H = 32; // alto de tu barra de ttulo custom

// Ajustes manuales para mover la ventana (px)
const OFFSET_X = -15;  // positivo ? ms a la derecha, negativo ? ms a la izquierda
const OFFSET_Y = -5; // positivo ? ms abajo, negativo ? ms arriba

function getSidebarWidth(winWidth) {
    return winWidth <= 1200 ? 250 : 280;
}

function getContentPadding(winWidth) {
    return winWidth <= 900 ? 20 : 30;
}

function positionNicknameWindow() {
    if (!mainWindow || !nicknameWindow) return;

    const mainB = mainWindow.getBounds();
    const modalB = nicknameWindow.getBounds();

    const sidebarW = getSidebarWidth(mainB.width);
    const pad = getContentPadding(mainB.width);

    // rea til horizontal
    const rightW = mainB.width - sidebarW - (pad * 2);
    let x = Math.round(
        mainB.x + sidebarW + pad + (rightW - modalB.width) / 2
    );

    // rea til vertical
    const rightH = mainB.height - TITLEBAR_H - (pad * 2);
    let y = Math.round(
        mainB.y + TITLEBAR_H + pad + (rightH - modalB.height) / 2
    );

    // Aplicar offsets manuales
    x += OFFSET_X;
    y += OFFSET_Y;

    nicknameWindow.setPosition(x, y);
}


const GTA_MANIFEST_URL = 'https://horizonrp.es/downloads/manifest.json';

// Utilidades versin local
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
            resolve(null); // Si no existe, retorna null
            return;
        }
        const hash = crypto.createHash('sha256');
        const rs = fs.createReadStream(filePath);
        rs.on('data', d => hash.update(d));
        rs.on('end', () => resolve(hash.digest('hex')));
        rs.on('error', reject);
    });
}

// Auto-update del juego (manifest)
async function initGameAutoUpdate() {
    try {
        if (!CONFIG.gtaPath) loadConfig();
        const baseDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getPath('home'), 'Horizon RP Dev');
        if (!CONFIG.gtaPath) CONFIG.gtaPath = path.join(baseDir, 'GTA Horizon');

        // Descargar el nuevo manifest detallado
        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 8000 });
        if (!manifest || !manifest.files || !Array.isArray(manifest.files)) {
            console.warn('Manifest invï¿½lido', manifest);
            return;
        }

        // Si no existe la carpeta del GTA, no hacer auto-update (primera instalaciï¿½n)
        if (!fs.existsSync(CONFIG.gtaPath)) {
            console.log('GTA no instalado.');
            return;
        }

        // Verificar quï¿½ archivos necesitan actualizaciï¿½n
        const filesToUpdate = [];
        let totalUpdateSize = 0;

        for (const fileInfo of manifest.files) {
            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);
            const localHash = await sha256File(localPath);

            if (!localHash || localHash.toLowerCase() !== fileInfo.hash.toLowerCase()) {
                filesToUpdate.push(fileInfo);
                totalUpdateSize += fileInfo.size;
            }
        }

        if (filesToUpdate.length > 0) {
            console.log(`Actualizaciï¿½n disponible: ${filesToUpdate.length} archivos (${formatBytes(totalUpdateSize)})`);
            if (mainWindow) {
                mainWindow.webContents.send('game-update', {
                    state: 'available',
                    filesCount: filesToUpdate.length,
                    totalSize: totalUpdateSize
                });
            }
            await downloadAndInstallGTA(filesToUpdate);
        } else {
            console.log('GTA estï¿½ actualizado');
            if (mainWindow) mainWindow.webContents.send('game-update', { state: 'uptodate' });
        }
    } catch (e) {
        console.warn('No se pudo verificar manifest GTA:', e.message);
    }
}

async function downloadAndInstallGTA(filesToUpdate) {
    if (filesToUpdate.length === 0) return;

    let downloadedFiles = 0;
    const totalFiles = filesToUpdate.length;

    if (mainWindow) {
        mainWindow.webContents.send('download-progress', {
            percent: 0,
            message: `Actualizando ${totalFiles} archivos...`
        });
    }

    try {
        for (const fileInfo of filesToUpdate) {
            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);
            const localDir = path.dirname(localPath);

            // Crear directorio si no existe
            await fs.ensureDir(localDir);

            // URL del archivo en el servidor usando la baseDownloadURL
            const fileUrl = `${CONFIG.baseDownloadURL}${fileInfo.path}`;

            // Descargar el archivo
            await downloadFile(fileUrl, localPath, (percent, current, total, speed) => {
                const overallProgress = Math.round(
                    ((downloadedFiles / totalFiles) * 100) +
                    (percent / totalFiles)
                );

                if (mainWindow) {
                    mainWindow.webContents.send('download-progress', {
                        percent: overallProgress,
                        message: `Actualizando archivo ${downloadedFiles + 1}/${totalFiles}...`,
                        current,
                        total,
                        speed
                    });
                }
            });

            // Verificar integridad del archivo descargado
            const downloadedHash = await sha256File(localPath);
            if (downloadedHash.toLowerCase() !== fileInfo.hash.toLowerCase()) {
                throw new Error(`Error de integridad en ${fileInfo.path}`);
            }

            downloadedFiles++;
        }

        // Actualizar versión local si existe en el manifest
        if (mainWindow) {
            mainWindow.webContents.send('download-progress', {
                percent: 100,
                message: 'Actualización completa'
            });
            mainWindow.webContents.send('download-complete');
        }

        console.log(`Actualización completada: ${totalFiles} archivos actualizados`);

    } catch (e) {
        console.error('Error actualizando archivos:', e);
        if (mainWindow) {
            mainWindow.webContents.send('download-error', e.message);
        }
        throw e;
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
                console.log('? Instalacin cargada:', CONFIG.gtaPath);
                return;
            }
        }
    } catch (e) {
        console.error('? Error cargando config:', e);
    }

    const baseDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getPath('home'), 'Horizon RP Dev');
    CONFIG.gtaPath = path.join(baseDir, 'GTA Horizon');
    console.log('? Ruta de GTA calculada automticamente:', CONFIG.gtaPath);
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
    mainWindow.on('move', () => {
        if (nicknameWindow && !nicknameWindow.isDestroyed()) {
            positionNicknameWindow();
        }
    });
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
    if (mainWindow) { // If it's already open for some reason
        return;
    }
    loadConfig();
    createWindow();
    initGameAutoUpdate();
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
            checkingUpdatesWindow.webContents.send('update-message', 'Descargando actualizaciÃ³n...');
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
        if (nicknameWindow) {
            nicknameWindow.close();
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

// Inicializar API y timers (sin intervalo para estadsticas)
async function initializeAPI() {
    await gameAPI.initDatabase();

    updateServerInfo();
    setInterval(updateServerInfo, 10000);

    updateNews();
    setInterval(updateNews, 60000);
}

// ====== Server/News ====== 
async function updateServerInfo() {
    const serverOptions = { host: '195.26.252.73', port: 7778, timeout: 5000 };
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

// ====== REG.EXE helper ====== 
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
            if (code === 0) resolve({ stdout, stderr, code });
            else reject(new Error(`reg.exe exit ${code} :: ${stderr || stdout || '(sin salida)'}`));
        });
    });
}
function parseRegQueryValue(stdout, valueName) {
    // Busca lneas con: valueName   REG_SZ   value
    const re = new RegExp(`\s${valueName}\s+REG_\w+\s+(.*)`);
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(re);
        if (m && m[1]) return m[1].trim();
    }
    return '';
}

// ====== Nickname en registro (HKCU\Software\SAMP) ====== 
async function getNickname() {
    const key = 'HKCU\\Software\\SAMP';

    // Intenta PlayerName
    try {
        const { stdout } = await runReg(['QUERY', key, '/v', 'PlayerName']);
        const val = parseRegQueryValue(stdout, 'PlayerName');
        if (val) return val;
    } catch { }

    // Fallback: player_name
    try {
        const { stdout } = await runReg(['QUERY', key, '/v', 'player_name']);
        const val = parseRegQueryValue(stdout, 'player_name');
        if (val) return val;
    } catch { }

    return '';
}
async function setNickname(nickname) {
    const key = 'HKCU\\Software\\SAMP';
    // Crea clave si no existe
    try { await runReg(['ADD', key, '/f']); } catch { }

    // Guarda en PlayerName (principal)
    await runReg(['ADD', key, '/v', 'PlayerName', '/t', 'REG_SZ', '/d', nickname, '/f']).catch(() => { });
    // Tambin en player_name (compat)
    await runReg(['ADD', key, '/v', 'player_name', '/t', 'REG_SZ', '/d', nickname, '/f']).catch(() => { });
}

// ====== Actualizar registro de SAMP (ruta del gta) ====== 
async function updateSAMPRegistry(gtaExePath) {
    const key = 'HKCU\\Software\\SAMP';

    try { await runReg(['ADD', key, '/f']); } catch { }

    // Vista por defecto
    try {
        await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f']);
        await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f']);
        console.log('? Registro SAMP actualizado (vista por defecto):', gtaExePath);
        return;
    } catch (e1) {
        console.warn('Fallo vista por defecto, reintentando /reg:32', e1.message);
    }

    try {
        await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:32']);
        await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:32']);
        console.log('? Registro SAMP actualizado (/reg:32):', gtaExePath);
        return;
    } catch (e2) {
        console.warn('Fallo /reg:32, reintentando /reg:64', e2.message);
    }

    await runReg(['ADD', key, '/v', 'gta_sa_exe', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:64']);
    await runReg(['ADD', key, '/v', 'gta_sa_exe_last', '/t', 'REG_SZ', '/d', gtaExePath, '/f', '/reg:64']);
    console.log('? Registro SAMP actualizado (/reg:64):', gtaExePath);
}

// ====== Descargar/extraer ====== 
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

// ====== IPC ====== 

// Controles de ventana
ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('close-window', () => {
    if (downloadActive) {
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Cancelar descarga y salir', 'Continuar descargando'],
            defaultId: 1,
            message: 'Hay una descarga en progreso',
            detail: 'Si sales ahora, tendrs que descargar todo de nuevo.'
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

// Estadsticas bajo demanda
ipcMain.on('request-statistics', async () => {
    const stats = await gameAPI.getStatistics();
    if (mainWindow && stats) mainWindow.webContents.send('statistics-update', stats);
});

// Versin app
ipcMain.handle('app-version', () => app.getVersion());

// Nickname window
ipcMain.on('open-nickname-window', () => {
    if (nicknameWindow && !nicknameWindow.isDestroyed()) {
        nicknameWindow.focus();
        return;
    }
    nicknameWindow = new BrowserWindow({
        width: 420,
        height: 260,
        frame: false,
        resizable: false,
        parent: mainWindow, // hija del launcher
        modal: false, // no bloquea el launcher
        transparent: true, // que no se vea recuadro blanco
        backgroundColor: '#00000000',
        alwaysOnTop: true, // opcional; si no te gusta, ponlo en false
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    nicknameWindow.loadFile('src/nickname.html');

    // Posicionarla cuando est lista
    nicknameWindow.once('ready-to-show', () => {
        positionNicknameWindow();
        nicknameWindow.show();
    });

    // Cerrar si pierde foco
    nicknameWindow.on('blur', () => {
        if (nicknameWindow && !nicknameWindow.isDestroyed()) nicknameWindow.close();
    });

    nicknameWindow.on('closed', () => { nicknameWindow = null; });
});

// Cierre de la ventanita desde el renderer (click en fondo o Escape)
ipcMain.on('close-nickname', () => {
    if (nicknameWindow && !nicknameWindow.isDestroyed()) nicknameWindow.close();
});

// Nickname IPC
ipcMain.on('get-nickname', async (event) => {
    const nick = await getNickname();
    event.reply('nickname-current', nick || '');
});
ipcMain.on('save-nickname-and-play', async (event, nickname) => {
    try { await setNickname(nickname); } catch (e) { console.error('Error guardando nickname:', e); }
    if (nicknameWindow && !nicknameWindow.isDestroyed()) nicknameWindow.close();

    const isInstalled = await checkGameInstalled();
    if (!isInstalled) {
        downloadGame(); // <- sin event
    } else {
        const result = await launchGame();
        if (!result.success && mainWindow) mainWindow.webContents.send('game-error', result.message);
    }
});

// Obtener ruta instalacin (para settings)
ipcMain.on('get-installation-path', () => {
    if (mainWindow) {
        mainWindow.webContents.send('installation-path', CONFIG.gtaPath || 'No instalado');
    }
});

// ===== SISTEMA DE INSTALACIN Y JUEGO =====
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
    if (!CONFIG.gtaPath) return false;
    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) return false;
    const gameFiles = findGameFiles(CONFIG.gtaPath);
    return !!(gameFiles['gta_sa.exe'] && gameFiles['samp.exe'] && gameFiles['samp.dll']);
});
ipcMain.on('reset-installation', async () => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Cancelar', 'Eliminar y reinstalar'],
        defaultId: 0,
        message: 'Deseas eliminar la instalacin actual?',
        detail: 'Esto eliminar todos los archivos del juego y tendrs que descargar todo de nuevo.'
    });
    if (choice === 1 && CONFIG.gtaPath && fs.existsSync(CONFIG.gtaPath)) {
        try {
            await fs.remove(CONFIG.gtaPath);
            CONFIG.gtaPath = null;
            const configPath = path.join(app.getPath('userData'), 'horizonrp_config.json');
            if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
            if (mainWindow) mainWindow.webContents.send('installation-reset', 'Instalacin eliminada correctamente');
        } catch (error) {
            if (mainWindow) mainWindow.webContents.send('installation-reset', 'Error: ' + error.message);
        }
    }
});

ipcMain.on('start-game', async () => {
    const isInstalled = await checkGameInstalled();
    if (!isInstalled) {
        downloadGame(); // <- sin event
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

    try {
        // Marcar instalación
        const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
        fs.writeFileSync(markerFile, JSON.stringify({
            version: '1.0.0',
            server: CONFIG.serverName,
            installedAt: new Date().toISOString()
        }));

        // Descargar manifest para obtener lista de archivos
        send('download-progress', { percent: 0, message: 'Obteniendo lista de archivos...' });

        const { data: manifest } = await axios.get(GTA_MANIFEST_URL, { timeout: 8000 });
        if (!manifest || !manifest.files) {
            throw new Error('No se pudo obtener la lista de archivos');
        }

        const totalFiles = manifest.files.length;
        let downloadedFiles = 0;
        let totalSize = manifest.files.reduce((acc, f) => acc + f.size, 0);

        send('download-progress', {
            percent: 0,
            message: `Descargando ${totalFiles} archivos (${formatBytes(totalSize)})...`
        });

        // Descargar cada archivo
        for (const fileInfo of manifest.files) {
            const localPath = path.join(CONFIG.gtaPath, fileInfo.path);
            const localDir = path.dirname(localPath);

            await fs.ensureDir(localDir);

            // Usar baseDownloadURL en lugar de URL hardcodeada
            const fileUrl = `${CONFIG.baseDownloadURL}${fileInfo.path}`;

            await downloadFile(fileUrl, localPath, (percent, current, total, speed) => {
                const overallProgress = Math.round(
                    (downloadedFiles / totalFiles) * 100 +
                    (percent / totalFiles)
                );

                send('download-progress', {
                    percent: overallProgress,
                    message: `Descargando archivo ${downloadedFiles + 1}/${totalFiles}...`,
                    current: current,
                    total: total,
                    speed: speed
                });
            });

            // Verificar integridad
            const downloadedHash = await sha256File(localPath);
            if (downloadedHash.toLowerCase() !== fileInfo.path.toLowerCase()) {
                console.warn(`Hash mismatch para ${fileInfo.path}, continuando...`);
                // Puedes decidir si quieres fallar o continuar
            }

            downloadedFiles++;
        }

        // Verificar que los archivos principales existan
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
            throw new Error('Archivos del juego no encontrados');
        }
    } catch (error) {
        downloadActive = false;
        if (CONFIG.gtaPath && fs.existsSync(CONFIG.gtaPath)) await fs.remove(CONFIG.gtaPath);
        CONFIG.gtaPath = null;
        console.error('Error en descarga:', error);
        send('download-error', error.message);
    }
}

async function launchGame() {
    if (!CONFIG.gtaPath) return { success: false, message: 'El juego no est instalado' };
    const markerFile = path.join(CONFIG.gtaPath, '.horizonrp');
    if (!fs.existsSync(markerFile)) { return { success: false, message: 'Instalacin corrupta. Por favor reinstala.' }; }

    const gameFiles = findGameFiles(CONFIG.gtaPath);
    if (!gameFiles['samp.exe'] || !gameFiles['gta_sa.exe']) return { success: false, message: 'No se encontraron los archivos del juego' };

    try {
        await updateSAMPRegistry(gameFiles['gta_sa.exe']);

        const gameCwd = path.dirname(gameFiles['samp.exe']);
        const gameProcess = spawn(gameFiles['samp.exe'], [`${CONFIG.serverIP}:${CONFIG.serverPort}`], {
            cwd: gameCwd,
            detached: true,
            stdio: 'ignore'
        });

        gameProcess.unref();
        setTimeout(() => mainWindow?.minimize(), 2000);
        return { success: true };
    } catch (error) {
        console.error('Error al iniciar juego:', error);
        return { success: false, message: error.message };
    }
}

// ====== Aux ====== 
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

// ===== INICIALIZACIN =====
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

    // After showing the window, start the update check
    initLauncherAutoUpdate();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });