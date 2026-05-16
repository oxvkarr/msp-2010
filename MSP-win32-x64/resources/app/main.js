const { app, BrowserWindow, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

const resolveRuntimePath = (...parts) => {
    const packedPath = path.join(__dirname, ...parts);
    if (fs.existsSync(packedPath)) return packedPath;
    return packedPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
};

const flashPath = resolveRuntimePath('pepflashplayer.dll');
const debugLogPath = path.join(__dirname, 'msp-debug.log');
const LOCAL_BASE_URL = 'http://127.0.0.1';
const PLAY_PARAMS = 'country=pl&locale=pl_PL&language=pl&selectedLocale=pl_PL&server=pl&domain=pl';
const exeName = path.basename(process.execPath || '').toLowerCase();
const isDebugMode = process.argv.includes('--debug') || process.env.MSP_DEBUG === '1' || exeName.includes('debug');
const useFiddlerProxy = process.argv.includes('--fiddler') || process.env.MSP_FIDDLER === '1' || exeName.includes('fiddler');
const fiddlerProxy = process.env.MSP_FIDDLER_PROXY || '127.0.0.1:8888';
const fiddlerBaseUrl = (process.env.MSP_FIDDLER_BASE_URL || 'http://ipv4.fiddler').replace(/\/+$/, '');
const TERMS_VERSION = 'msp-private-server-2026-05-09';

process.env.MSP_DEBUG = isDebugMode ? '1' : '0';
require('./app');
const localHostRules = [
    'MAP 127.0.0.1translations 127.0.0.1',
    'MAP 127.0.0.1localization 127.0.0.1',
    'MAP 127.0.0.1dictionaries 127.0.0.1',
    'MAP ipv4.fiddlertranslations 127.0.0.1',
    'MAP ipv4.fiddlerlocalization 127.0.0.1',
    'MAP ipv4.fiddlerdictionaries 127.0.0.1',
    'MAP cdn.alpha.moviestarplanet.com 127.0.0.1',
    'MAP upload.alpha.moviestarplanet.com 127.0.0.1',
    'MAP alpha.moviestarplanet.com 127.0.0.1',
    'MAP cdn.moviestarplanet.com 127.0.0.1',
    'MAP localcdn.moviestarplanet.com 127.0.0.1',
    'MAP upload.moviestarplanet.com 127.0.0.1',
    'MAP cdnlocaldev.moviestarplanet.com 127.0.0.1',
    'MAP cdndev.moviestarplanet.com 127.0.0.1',
    'MAP cdnlocaltest.moviestarplanet.com 127.0.0.1',
    'MAP cdnlocalrc.moviestarplanet.com 127.0.0.1',
    'MAP cdn.beta.moviestarplanet.com 127.0.0.1',
    'MAP upload.beta.moviestarplanet.com 127.0.0.1',
    'MAP content.mspapis.com 127.0.0.1',
    'MAP disco.mspapis.com 127.0.0.1',
    'MAP mspapis.com 127.0.0.1',
    'MAP content.mspcdns.com 127.0.0.1',
    'MAP assets.mspcdns.com 127.0.0.1',
    'MAP locales.mspcdns.com 127.0.0.1',
    'MAP mspcdns.com 127.0.0.1'
].join(', ');

app.commandLine.appendSwitch('ppapi-flash-path', flashPath);
app.commandLine.appendSwitch('ppapi-flash-version', '32.0.0.465');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('host-rules', localHostRules);
if (useFiddlerProxy) {
    const proxyPac = [
        'function FindProxyForURL(url, host) {',
        '  if (host === "127.0.0.1translations" || host === "127.0.0.1localization" || host === "127.0.0.1dictionaries") return "DIRECT";',
        '  if (host === "ipv4.fiddlertranslations" || host === "ipv4.fiddlerlocalization" || host === "ipv4.fiddlerdictionaries") return "DIRECT";',
        `  return "PROXY ${fiddlerProxy}; DIRECT";`,
        '}'
    ].join('\n');
    app.commandLine.appendSwitch('proxy-pac-url', `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(proxyPac).toString('base64')}`);
}

let mainWindow;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

const readSettings = () => {
    try {
        return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    } catch (err) {
        return {};
    }
};

const writeSettings = (settings) => {
    try {
        fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
        fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
    } catch (err) {
        debugLog(`[SETTINGS SAVE FAIL] ${err.message}`);
    }
};

const ensureTermsAccepted = async () => {
    const settings = readSettings();
    if (settings.termsAcceptedVersion === TERMS_VERSION) return true;
    if (isDebugMode || process.env.MSP_ACCEPT_TERMS === '1') {
        writeSettings(Object.assign({}, settings, {
            termsAcceptedVersion: TERMS_VERSION,
            termsAcceptedAt: new Date().toISOString()
        }));
        if (isDebugMode) {
            debugLog('[TERMS] auto accepted for debug');
        }
        return true;
    }

    const result = await dialog.showMessageBox({
        type: 'info',
        title: 'MSP Private Server',
        message: 'Akceptacja regulaminu',
        detail: [
            'To jest prywatny serwer i nieoficjalny klient gry.',
            'Nie wpisuj tutaj hasel z prawdziwego konta MovieStarPlanet.',
            'Gra laczy sie z prywatna brama serwera i pobiera assety z hostingu projektu.',
            'Klikajac Akceptuje potwierdzasz, ze uruchamiasz klienta testowo i na wlasna odpowiedzialnosc.'
        ].join('\n\n'),
        buttons: ['Akceptuje', 'Zamknij'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });

    if (result.response !== 0) return false;
    writeSettings(Object.assign({}, settings, {
        termsAcceptedVersion: TERMS_VERSION,
        termsAcceptedAt: new Date().toISOString()
    }));
    return true;
};

const waitForLocalServer = (attempts = 300) => new Promise((resolve) => {
    const check = (left) => {
        const req = require('http').get(`${LOCAL_BASE_URL}/play.html`, (res) => {
            res.resume();
            if (res.statusCode >= 200 && res.statusCode < 400) {
                resolve(true);
                return;
            }
            if (left <= 1) {
                resolve(false);
                return;
            }
            setTimeout(() => check(left - 1), 250);
        });
        req.on('error', () => {
            if (left <= 1) {
                resolve(false);
                return;
            }
            setTimeout(() => check(left - 1), 250);
        });
        req.setTimeout(1000, () => {
            req.destroy();
        });
    };
    check(attempts);
});

const debugLog = (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(message);
    fs.appendFile(debugLogPath, `${line}\n`, () => {});
};

const removeIfExists = (targetPath) => {
    try {
        if (fs.existsSync(targetPath)) {
            if (typeof fs.rmSync === 'function') {
                fs.rmSync(targetPath, { recursive: true, force: true });
            } else {
                fs.rmdirSync(targetPath, { recursive: true });
            }
        }
    } catch (err) {
        if (isDebugMode) {
            debugLog(`[CACHE CLEANUP FAIL] ${targetPath} ${err.message}`);
        }
    }
};

const clearLocalCaches = async () => {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
    removeIfExists(path.join(__dirname, 'asset-cache'));
    removeIfExists(path.join(app.getPath('userData'), 'Cache'));
    removeIfExists(path.join(app.getPath('userData'), 'GPUCache'));
    removeIfExists(path.join(app.getPath('userData'), 'Local Storage'));
    const flashBase = path.join(app.getPath('appData'), 'Macromedia', 'Flash Player');
    removeIfExists(path.join(flashBase, '#SharedObjects'));
    removeIfExists(path.join(flashBase, 'macromedia.com', 'support', 'flashplayer', 'sys', '#127.0.0.1'));
    removeIfExists(path.join(flashBase, 'macromedia.com', 'support', 'flashplayer', 'sys', '#localhost'));
    if (isDebugMode) {
        debugLog('[CACHE] wyczyszczono cache Electron/Flash');
        if (useFiddlerProxy) {
            debugLog(`[FIDDLER] proxy wlaczony: ${fiddlerProxy}`);
        }
    }
};

function redirectExternalMspRequests() {
    const filter = {
        urls: [
            '*://*.moviestarplanet.com/*',
            '*://*.moviestarplanet.co.uk/*',
            '*://*.moviestarplanet.de/*',
            '*://*.moviestarplanet.fi/*',
            '*://*.moviestarplanet.fr/*',
            '*://*.moviestarplanet.pl/*',
            '*://*.moviestarplanet.nl/*',
            '*://*.moviestarplanet.no/*',
            '*://*.moviestarplanet.se/*',
            '*://*.moviestarplanet.dk/*',
            '*://*.moviestarplanet.com.tr/*',
            '*://*.moviestarplanet.com.au/*',
            '*://*.moviestarplanet.co.nz/*',
            '*://*.moviestarplanet.ca/*',
            '*://*.moviestarplanet.ie/*',
            '*://*.moviestarplanet.es/*',
            '*://*.moviestarplanet.it/*',
            '*://*.moviestarplanet.br/*',
            '*://*.mspapis.com/*',
            '*://*.mspcdns.com/*'
        ]
    };

    session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
        try {
            const url = new URL(details.url);
            if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
                callback({});
                return;
            }

            const publicHost = /(?:^|\.)moviestarplanet\.(?:com|co\.uk|de|fi|fr|pl|nl|no|se|dk|com\.tr|com\.au|co\.nz|ca|ie|es|it|br)$/i.test(url.hostname);
            const isPolishHost = /(?:^|\.)moviestarplanet\.pl$/i.test(url.hostname);
            const redirectURL = publicHost && !isPolishHost
                ? `${LOCAL_BASE_URL}/server-unavailable.html`
                : `${LOCAL_BASE_URL}${url.pathname}${url.search}`;
            if (isDebugMode) {
                console.log(`[REDIRECT] ${details.url} -> ${redirectURL}`);
            }
            callback({ redirectURL });
        } catch (err) {
            callback({});
        }
    });
}

async function createWindow() {
    const accepted = await ensureTermsAccepted();
    if (!accepted) {
        app.quit();
        return;
    }

    redirectExternalMspRequests();
    await clearLocalCaches();

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: isDebugMode ? 'MSP Private Server - Debug' : 'MSP',
        webPreferences: {
            plugins: true,
            contextIsolation: false,
            nodeIntegration: true,
            webSecurity: false
        }
    });

    if (isDebugMode) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
        mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
            debugLog(`[WINDOW CONSOLE] level=${level} ${sourceId || ''}:${line || 0} ${message}`);
        });
        mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
            debugLog(`[WINDOW LOAD FAIL] code=${errorCode} url=${validatedURL} ${errorDescription}`);
        });
        mainWindow.webContents.on('plugin-crashed', (event, name, version) => {
            debugLog(`[PLUGIN CRASHED] ${name || 'unknown'} ${version || ''}`);
        });
        mainWindow.webContents.on('crashed', () => {
            debugLog('[RENDERER CRASHED]');
        });
        mainWindow.on('unresponsive', () => {
            debugLog('[WINDOW UNRESPONSIVE]');
        });
    }
    const ready = await waitForLocalServer();
    if (!ready && isDebugMode) {
        debugLog('[LOCAL SERVER] timed out waiting for /play.html');
    }
    const playBaseUrl = useFiddlerProxy ? fiddlerBaseUrl : LOCAL_BASE_URL;
    mainWindow.loadURL(`${playBaseUrl}/play.html?${PLAY_PARAMS}${isDebugMode ? '&debug=1' : ''}${useFiddlerProxy ? '&fiddler=1' : ''}`);
}

app.on('ready', createWindow);
app.on('window-all-closed', () => app.quit());
