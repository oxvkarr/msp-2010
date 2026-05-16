const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Writable } = require('stream');
const amfjs = require('amfjs');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const app = express();

const publicPath = path.join(__dirname, 'public');
const assetCachePath = path.join(__dirname, 'asset-cache');
const amfDumpPath = path.join(__dirname, 'amf-dumps');
const dbPath = path.join(__dirname, 'msp-db.json');
const debugLogPath = path.join(__dirname, 'msp-debug.log');
const serverPidPath = path.join(__dirname, 'msp-server.pid');
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || '';
const mongoDbName = process.env.MONGODB_DB || 'msp_2010';
const mongoStateCollection = process.env.MONGODB_STATE_COLLECTION || 'state';
const defaultRemoteAssetBaseUrl = 'https://pub-2ec8e3c2f0a24e46ab1defac06482eb3.r2.dev/2010';
const officialMspAssetBaseUrl = (process.env.MSPCDN_ASSET_BASE_URL || 'https://assets.mspcdns.com/msp/103.1.40').replace(/\/+$/, '');
const legacyMspAssetBaseUrl = 'http://cdn.moviestarplanet.com';
const defaultRemoteGatewayUrl = 'https://msp-2010.onrender.com';
const BUILD = 'render-addon-no-dev-remove-v18';
const remoteAssetBaseUrl = (process.env.REMOTE_ASSET_BASE_URL || defaultRemoteAssetBaseUrl).replace(/\/+$/, '');
const remoteAssetCacheEnabled = process.env.REMOTE_ASSET_CACHE === '1';
const remoteGatewayUrl = (process.env.REMOTE_GATEWAY_URL || defaultRemoteGatewayUrl).replace(/\/+$/, '');
const remoteGatewayTimeoutMs = Number(process.env.REMOTE_GATEWAY_TIMEOUT_MS || 15000);
const realMspProxyEnabled = process.env.REAL_MSP_PROXY === '1';
const realMspServer = (process.env.REAL_MSP_SERVER || 'pl').toLowerCase() === 'uk' ? 'gb' : (process.env.REAL_MSP_SERVER || 'pl').toLowerCase();
const realMspGatewayUrl = `https://ws-${realMspServer}.mspapis.com/Gateway.aspx`;
const isDebugMode = process.env.MSP_DEBUG === '1';
const isServerOnly = process.env.MSP_SERVER_ONLY === '1' || process.argv.includes('--server');
const remoteGatewayExplicitEnabled =
    process.env.USE_REMOTE_GATEWAY === '1' ||
    process.env.REMOTE_GATEWAY_AMF === '1' ||
    process.env.REMOTE_GATEWAY_ALL === '1';
const useRemoteGateway = Boolean(remoteGatewayUrl) && !isServerOnly && remoteGatewayExplicitEnabled;
const isCreateNewUserMethod = (method) => /MovieStarPlanet\.WebService\.User\.(AMFUserServiceWeb|AMFUserService)\.(CreateNewUser|CreateNewUserOld)$/i.test(method || '');
// Dodajemy nową linię dla logowania:
const isLoginMethod = (method) => /MovieStarPlanet\.WebService\.User\.(AMFUserServiceWeb|AMFUserService)\.Login$/i.test(method || '');

const shouldProxyRemoteGateway = (method) => {
    // Pelny lokalny flow konta: kreator, CreateNewUser, runway i Login zostaja w tym app.js.
    // Assety nadal moga byc pobierane z R2 przez remoteAssetBaseUrl.
    return false;
};
const configuredPort = process.env.PORT || process.env.MSP_PORT || '';
const normalizeLocaleCode = (value) => {
    const parts = String(value || 'pl_PL').replace('-', '_').split('_');
    const language = (parts[0] || 'pl').toLowerCase();
    const country = (parts[1] || language).toUpperCase();
    return `${language}_${country}`;
};
const forcedLocale = normalizeLocaleCode(process.env.MSP_LOCALE || 'pl_PL');
const forcedLocalePath = forcedLocale.toLowerCase();
const startupParams = 'country=pl&locale=pl_PL&language=pl&selectedLocale=pl_PL&server=pl&domain=pl';

// Render/GitHub deployment helpers. Set PUBLIC_BASE_URL on Render if you want to force
// a specific domain, for example: https://twoja-apka.onrender.com
const normalizeBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '') + '/';
const configuredPublicBaseUrl = normalizeBaseUrl(
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.APP_URL ||
    ''
);
const requestPublicBaseUrl = (req) => {
    if (configuredPublicBaseUrl !== '/') return configuredPublicBaseUrl;
    const forwardedProto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
    const proto = forwardedProto || (req && req.protocol) || 'http';
    const host = req && req.headers && req.headers.host ? req.headers.host : '127.0.0.1';
    return `${proto}://${host}/`;
};
const requestPublicWsUrl = (req) => normalizeBaseUrl(process.env.PUBLIC_WS_URL || requestPublicBaseUrl(req));
const buildFlashVars = (baseUrl = '/', wsUrl = '/') => {
    const cleanBase = normalizeBaseUrl(baseUrl || '/');
    const cleanWs = normalizeBaseUrl(wsUrl || cleanBase);
    return [
        startupParams,
        `resourceModuleUrl=${encodeURIComponent(`swf/locales/${forcedLocalePath}_resourcemodule.swf?v=Main_2010123_95850`)}`,
        'swfVer=Main_2010123_95850',
        'translationsVersion=2016112_16431',
        `newWsPath=${encodeURIComponent(cleanWs)}`,
        `wsPath=${encodeURIComponent(cleanWs)}`,
        `wspath=${encodeURIComponent(cleanWs)}`,
        `basePath=${encodeURIComponent(cleanBase)}`,
        `basepath=${encodeURIComponent(cleanBase)}`,
        `cdnLocalPath=${encodeURIComponent(cleanBase)}`,
        `cdnlocalPath=${encodeURIComponent(cleanBase)}`,
        `cdnlocalpath=${encodeURIComponent(cleanBase)}`,
        `cdnLocalBasePath=${encodeURIComponent(cleanBase)}`,
        `cdnPath=${encodeURIComponent(cleanBase)}`,
        `cdnpath=${encodeURIComponent(cleanBase)}`,
        `appUrl=${encodeURIComponent(cleanBase)}`
    ].join('&');
};
let mongoClient = null;
let mongoDatabase = null;
let dbSource = 'json';
let amfDumpCounter = 0;
const recentLogs = [];
const isDebugLogRequest = (req) => req.path === '/api/debug/logs' || req.path === '/api/db/status';
const log = (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    recentLogs.push(line);
    if (recentLogs.length > 500) {
        recentLogs.shift();
    }
    if (isDebugMode) {
        console.log(message);
        fs.appendFile(debugLogPath, `${line}\n`, () => {});
    }
};

const safeDumpName = (value) => String(value || 'unknown')
    .replace(/^.*\./, '')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .slice(0, 80) || 'unknown';

const dumpAmfExchange = (method, requestBody, responseBody, meta = {}) => {
    if (!isDebugMode) return;
    try {
        fs.mkdirSync(amfDumpPath, { recursive: true });
        amfDumpCounter += 1;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = `${stamp}_${String(amfDumpCounter).padStart(4, '0')}_${safeDumpName(method)}`;
        const reqFile = path.join(amfDumpPath, `${base}.request.amf`);
        const resFile = path.join(amfDumpPath, `${base}.response.amf`);
        const metaFile = path.join(amfDumpPath, `${base}.json`);
        fs.writeFileSync(reqFile, Buffer.isBuffer(requestBody) ? requestBody : Buffer.alloc(0));
        fs.writeFileSync(resFile, Buffer.isBuffer(responseBody) ? responseBody : Buffer.alloc(0));
        fs.writeFileSync(metaFile, JSON.stringify({
            method,
            requestBytes: Buffer.isBuffer(requestBody) ? requestBody.length : 0,
            responseBytes: Buffer.isBuffer(responseBody) ? responseBody.length : 0,
            ...meta
        }, null, 2));
        log(`[AMF DUMP] ${method} -> ${path.relative(__dirname, metaFile)}`);
    } catch (err) {
        log(`[AMF DUMP FAIL] ${method} ${err.message}`);
    }
};

app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.use((req, res, next) => {
    if (!isDebugLogRequest(req)) {
        log(`[REQ] ${req.method} ${req.url} host=${req.headers.host || ''}`);
    }
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    next();
});

const FLASH_POLICY_XML = `<?xml version="1.0"?>
<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">
<cross-domain-policy>
    <site-control permitted-cross-domain-policies="all"/>
    <allow-access-from domain="*" to-ports="*" secure="false"/>
    <allow-http-request-headers-from domain="*" headers="*" secure="false"/>
</cross-domain-policy>`;

// Sztywne serwowanie crossdomain - to musi zatrzymać pętlę
app.all('/crossdomain.xml', (req, res) => {
    log(`[POLICY] ${req.headers.host || ''}${req.url}`);
    res.set('Content-Type', 'text/x-cross-domain-policy');
    res.send(FLASH_POLICY_XML);
});

const requestBaseUrl = (req) => requestPublicBaseUrl(req);

const requestWsUrl = (req) => requestPublicWsUrl(req);

const fallbackPlayHtml = (req) => {
    const flashVars = buildFlashVars(requestBaseUrl(req), requestWsUrl(req));
    return `<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>MSP</title>
    <style>
        html, body {
            width: 100%;
            height: 100%;
            margin: 0;
            overflow: hidden;
            background: #000;
        }
        object, embed {
            width: 100%;
            height: 100%;
            display: block;
        }
        #debug-console {
            position: fixed;
            right: 14px;
            bottom: 14px;
            z-index: 999999;
            min-width: 430px;
            min-height: 260px;
            width: min(760px, calc(100vw - 28px));
            height: min(620px, calc(100vh - 28px));
            max-width: calc(100vw - 28px);
            max-height: calc(100vh - 28px);
            display: none;
            overflow: hidden;
            resize: both;
            border: 1px solid rgba(255,255,255,.18);
            border-radius: 8px;
            background: rgba(14, 18, 28, .94);
            box-shadow: 0 16px 60px rgba(0,0,0,.45);
            color: #e8eefc;
            font: 12px Consolas, monospace;
        }
        #debug-console header {
            height: 34px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 10px;
            background: rgba(255,255,255,.08);
            font: 600 12px Arial, sans-serif;
            cursor: move;
            user-select: none;
        }
        #debug-title {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #debug-console .debug-actions {
            display: flex;
            gap: 6px;
            align-items: center;
        }
        #debug-console button {
            height: 24px;
            border: 0;
            border-radius: 5px;
            background: #2f80ed;
            color: #fff;
            cursor: pointer;
            font: 600 11px Arial, sans-serif;
        }
        #debug-console button.secondary {
            background: rgba(255,255,255,.13);
        }
        #debug-console.minimized {
            min-height: 34px;
            height: 34px;
            resize: none;
        }
        #debug-console.minimized .debug-body {
            display: none;
        }
        #debug-console .debug-body {
            height: calc(100% - 34px);
            min-height: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        #debug-links {
            display: grid;
            flex: 0 0 auto;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
            padding: 8px 10px;
            border-bottom: 1px solid rgba(255,255,255,.08);
        }
        #debug-links button {
            width: 100%;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #debug-stats {
            display: grid;
            flex: 0 0 auto;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
            padding: 8px 10px;
            border-bottom: 1px solid rgba(255,255,255,.08);
        }
        .debug-stat {
            min-width: 0;
            padding: 6px 7px;
            border-radius: 6px;
            background: rgba(255,255,255,.08);
            font: 11px Arial, sans-serif;
        }
        .debug-stat strong {
            display: block;
            margin-top: 2px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #fff;
            font-size: 13px;
        }
        #debug-lights {
            display: grid;
            flex: 0 0 auto;
            grid-template-columns: repeat(5, 1fr);
            gap: 6px;
            padding: 8px 10px;
            border-bottom: 1px solid rgba(255,255,255,.08);
        }
        .debug-light {
            min-width: 0;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 7px;
            border-radius: 6px;
            background: rgba(255,255,255,.07);
            color: #b7c4dd;
            font: 11px Arial, sans-serif;
        }
        .debug-light-dot {
            width: 9px;
            height: 9px;
            flex: 0 0 auto;
            border-radius: 999px;
            background: #6b7280;
            box-shadow: 0 0 0 2px rgba(255,255,255,.08);
        }
        .debug-light.good .debug-light-dot {
            background: #22c55e;
            box-shadow: 0 0 10px rgba(34,197,94,.8);
        }
        .debug-light.warn .debug-light-dot {
            background: #f59e0b;
            box-shadow: 0 0 10px rgba(245,158,11,.8);
        }
        .debug-light.bad .debug-light-dot {
            background: #ef4444;
            box-shadow: 0 0 10px rgba(239,68,68,.8);
        }
        .debug-light span:last-child {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #debug-filter-row {
            display: flex;
            flex: 0 0 auto;
            gap: 6px;
            padding: 0 10px 8px;
            border-bottom: 1px solid rgba(255,255,255,.08);
        }
        #debug-filter {
            flex: 1;
            min-width: 0;
            height: 26px;
            box-sizing: border-box;
            border: 1px solid rgba(255,255,255,.16);
            border-radius: 5px;
            background: rgba(0,0,0,.28);
            color: #e8eefc;
            padding: 0 8px;
            font: 12px Consolas, monospace;
        }
        #debug-log {
            flex: 1 1 auto;
            min-height: 90px;
            height: auto;
            margin: 0;
            padding: 10px;
            overflow: auto;
            white-space: pre-wrap;
            word-break: break-word;
            box-sizing: border-box;
        }
        #debug-resize {
            position: absolute;
            right: 0;
            bottom: 0;
            width: 18px;
            height: 18px;
            cursor: nwse-resize;
            opacity: .9;
        }
        #debug-resize:before,
        #debug-resize:after {
            content: "";
            position: absolute;
            right: 4px;
            bottom: 4px;
            border-right: 2px solid rgba(255,255,255,.55);
            border-bottom: 2px solid rgba(255,255,255,.55);
        }
        #debug-resize:before {
            width: 11px;
            height: 11px;
        }
        #debug-resize:after {
            width: 6px;
            height: 6px;
        }
        #debug-console.minimized #debug-resize {
            display: none;
        }
    </style>
</head>
<body>
    <object id="msp" type="application/x-shockwave-flash" data="/Main_2010123_95850.swf?${startupParams}">
        <param name="movie" value="/Main_2010123_95850.swf?${startupParams}">
        <param name="allowScriptAccess" value="always">
        <param name="allowFullScreen" value="true">
        <param name="wmode" value="direct">
        <param name="flashvars" value="${flashVars}">
        <embed src="/Main_2010123_95850.swf?${startupParams}" allowScriptAccess="always" allowFullScreen="true" wmode="direct" flashvars="${flashVars}">
    </object>
    <div id="debug-console">
        <header id="debug-drag">
            <span id="debug-title">MSP Dev Panel</span>
            <div class="debug-actions">
                <button id="debug-minimize" class="secondary" type="button">_</button>
                <button id="debug-pause" class="secondary" type="button">Pause</button>
                <button id="debug-copy" class="secondary" type="button">Copy</button>
                <button id="debug-clear" type="button">Clear</button>
            </div>
        </header>
        <div class="debug-body">
            <section id="debug-stats">
                <div class="debug-stat">DB<strong id="debug-db">...</strong></div>
                <div class="debug-stat">REQ<strong id="debug-req">0</strong></div>
                <div class="debug-stat">AMF<strong id="debug-amf">0</strong></div>
                <div class="debug-stat">Assety<strong id="debug-assets">0</strong></div>
            </section>
            <section id="debug-lights">
                <div id="light-server" class="debug-light warn"><span class="debug-light-dot"></span><span>Serwer</span></div>
                <div id="light-assets" class="debug-light warn"><span class="debug-light-dot"></span><span>Pliki</span></div>
                <div id="light-locale" class="debug-light warn"><span class="debug-light-dot"></span><span>PL</span></div>
                <div id="light-amf" class="debug-light warn"><span class="debug-light-dot"></span><span>AMF</span></div>
                <div id="light-db" class="debug-light warn"><span class="debug-light-dot"></span><span>Baza</span></div>
            </section>
            <section id="debug-links">
                <button class="secondary debug-link" data-url="https://msp-2010.onrender.com/api/health" type="button">Health</button>
                <button class="secondary debug-link" data-url="https://dashboard.render.com" type="button">Render</button>
                <button class="secondary debug-link" data-url="https://cloud.mongodb.com" type="button">MongoDB</button>
                <button class="secondary debug-link" data-url="https://dash.cloudflare.com" type="button">R2</button>
            </section>
            <div id="debug-filter-row">
                <input id="debug-filter" placeholder="Filtr logów, np. Gateway albo MISS">
                <button id="debug-scroll" class="secondary" type="button">Dół</button>
            </div>
            <pre id="debug-log"></pre>
        </div>
        <div id="debug-resize" title="Zmien rozmiar panelu"></div>
    </div>
    <script>
        (function () {
            var flashStub = function (name) {
                return function () {
                    try {
                        console.log('[FLASH CALL] ' + name, Array.prototype.slice.call(arguments).join(' '));
                    } catch (error) {
                        console.log('[FLASH CALL] ' + name);
                    }
                    return null;
                };
            };
            [
                'trackLogin',
                'trackCreateNewUser',
                'trackPurchaseVIP',
                'trackBuildingCharacter',
                'trackClickNewUser',
                'trackRedeemGiftCertificate',
                'trackProductOverview',
                'trackPaymentOption',
                'showLeaderboardBanner',
                'showSkyscraperBanner',
                'hideLeaderboardBanner',
                'hideSkyscraperBanner',
                'showOverlay',
                'hideOverlay',
                'cleanUpOverlay',
                'moveOverlay',
                'loadOverlay'
            ].forEach(function (name) {
                if (typeof window[name] !== 'function') {
                    window[name] = flashStub(name);
                }
            });
            window.adf = window.adf || { Params: {}, track: flashStub('adf.track') };
            window.getFp = window.getFp || function () { return 'local-debug-fingerprint'; };
        }());
        (function () {
            var debug = new URLSearchParams(location.search).get('debug') === '1';
            var panel = document.getElementById('debug-console');
            var output = document.getElementById('debug-log');
            var dragHandle = document.getElementById('debug-drag');
            var resizeHandle = document.getElementById('debug-resize');
            var minimize = document.getElementById('debug-minimize');
            var clear = document.getElementById('debug-clear');
            var pause = document.getElementById('debug-pause');
            var copy = document.getElementById('debug-copy');
            var scroll = document.getElementById('debug-scroll');
            var filter = document.getElementById('debug-filter');
            var dbStat = document.getElementById('debug-db');
            var reqStat = document.getElementById('debug-req');
            var amfStat = document.getElementById('debug-amf');
            var assetStat = document.getElementById('debug-assets');
            var lights = {
                server: document.getElementById('light-server'),
                assets: document.getElementById('light-assets'),
                locale: document.getElementById('light-locale'),
                amf: document.getElementById('light-amf'),
                db: document.getElementById('light-db')
            };
            var allLines = [];
            var counters = { req: 0, amf: 0, assets: 0 };
            var paused = false;
            function renderLog() {
                if (!output) return;
                var query = filter && filter.value ? filter.value.toLowerCase() : '';
                var visible = query ? allLines.filter(function (line) {
                    return line.toLowerCase().indexOf(query) !== -1;
                }) : allLines;
                output.textContent = visible.slice(-500).join('\\n') + (visible.length ? '\\n' : '');
                if (!paused) output.scrollTop = output.scrollHeight;
            }
            function setText(node, text) {
                if (node) node.textContent = text;
            }
            function setLight(name, state, label) {
                var node = lights[name];
                if (!node) return;
                node.className = 'debug-light ' + state;
                if (label) {
                    var textNode = node.querySelector('span:last-child');
                    if (textNode) textNode.textContent = label;
                }
            }
            function updateStats(line) {
                if (line.indexOf('[REQ]') !== -1) counters.req += 1;
                if (line.indexOf('[AMF]') !== -1 || line.indexOf('[REMOTE GATEWAY]') !== -1) counters.amf += 1;
                if (line.indexOf('[REMOTE ASSET]') !== -1 || line.indexOf('[LOOKDATA]') !== -1 || line.indexOf('[TRANSLATION]') !== -1) counters.assets += 1;
                setText(reqStat, String(counters.req));
                setText(amfStat, String(counters.amf));
                setText(assetStat, String(counters.assets));
                if (line.indexOf('Serwer czeka na porcie') !== -1 || line.indexOf('[FALLBACK]') !== -1) setLight('server', 'good', 'Serwer');
                if (line.indexOf('[REMOTE ASSET]') !== -1 || line.indexOf('[LOOKDATA]') !== -1) setLight('assets', 'good', 'Pliki');
                if (line.indexOf('[REMOTE ASSET TRY MISS]') !== -1 || line.indexOf('[REMOTE ASSET MISS]') !== -1 || line.indexOf('[MISS]') !== -1) setLight('assets', 'warn', 'Pliki');
                if (line.indexOf('[TRANSLATION]') !== -1 || line.indexOf('pl_pl_resourcemodule') !== -1) setLight('locale', 'good', 'PL');
                if (line.indexOf('[TRANSLATION MISS]') !== -1 || line.indexOf('MISSING_LOCALE') !== -1) setLight('locale', 'bad', 'PL');
                if (line.indexOf('[AMF RESPONSE]') !== -1 || line.indexOf('[REMOTE GATEWAY]') !== -1 || line.indexOf('[REMOTE GATEWAY OK]') !== -1) setLight('amf', 'good', 'AMF');
                if (line.indexOf('[AMF ERROR]') !== -1 || line.indexOf('[AMF DECODE MISS]') !== -1 || line.indexOf('[REMOTE GATEWAY FAIL]') !== -1) setLight('amf', 'warn', 'AMF');
            }
            function write(level, args) {
                if (!debug || !output) return;
                var text = Array.prototype.slice.call(args).map(function (item) {
                    if (typeof item === 'string') return item;
                    try { return JSON.stringify(item); } catch (e) { return String(item); }
                }).join(' ');
                var line = '[' + level + '] ' + text;
                allLines.push(line);
                if (allLines.length > 1200) allLines.shift();
                updateStats(line);
                if (!paused) renderLog();
            }
            if (debug && panel) panel.style.display = 'block';
            function openExternal(url) {
                try {
                    if (window.require) {
                        window.require('electron').shell.openExternal(url);
                        return;
                    }
                } catch (e) {}
                window.open(url, '_blank');
            }
            Array.prototype.slice.call(document.querySelectorAll('.debug-link')).forEach(function (button) {
                button.onclick = function () {
                    openExternal(button.getAttribute('data-url'));
                };
            });
            if (minimize) minimize.onclick = function (event) {
                event.stopPropagation();
                panel.classList.toggle('minimized');
                minimize.textContent = panel.classList.contains('minimized') ? '+' : '_';
            };
            if (dragHandle && panel) {
                var dragging = false;
                var dragOffsetX = 0;
                var dragOffsetY = 0;
                var resizing = false;
                var resizeStartX = 0;
                var resizeStartY = 0;
                var resizeStartWidth = 0;
                var resizeStartHeight = 0;
                var resizeStartLeft = 0;
                var resizeStartTop = 0;
                dragHandle.addEventListener('mousedown', function (event) {
                    if (event.target && event.target.tagName === 'BUTTON') return;
                    dragging = true;
                    var rect = panel.getBoundingClientRect();
                    dragOffsetX = event.clientX - rect.left;
                    dragOffsetY = event.clientY - rect.top;
                    panel.style.left = rect.left + 'px';
                    panel.style.top = rect.top + 'px';
                    panel.style.right = 'auto';
                    panel.style.bottom = 'auto';
                    event.preventDefault();
                });
                if (resizeHandle) {
                    resizeHandle.addEventListener('mousedown', function (event) {
                        if (panel.classList.contains('minimized')) return;
                        resizing = true;
                        var rect = panel.getBoundingClientRect();
                        resizeStartX = event.clientX;
                        resizeStartY = event.clientY;
                        resizeStartWidth = rect.width;
                        resizeStartHeight = rect.height;
                        resizeStartLeft = rect.left;
                        resizeStartTop = rect.top;
                        panel.style.left = rect.left + 'px';
                        panel.style.top = rect.top + 'px';
                        panel.style.right = 'auto';
                        panel.style.bottom = 'auto';
                        event.preventDefault();
                        event.stopPropagation();
                    });
                }
                window.addEventListener('mousemove', function (event) {
                    if (resizing) {
                        var minWidth = 430;
                        var minHeight = 260;
                        var maxWidth = Math.max(minWidth, window.innerWidth - resizeStartLeft - 8);
                        var maxHeight = Math.max(minHeight, window.innerHeight - resizeStartTop - 8);
                        var nextWidth = Math.max(minWidth, Math.min(maxWidth, resizeStartWidth + event.clientX - resizeStartX));
                        var nextHeight = Math.max(minHeight, Math.min(maxHeight, resizeStartHeight + event.clientY - resizeStartY));
                        panel.style.width = nextWidth + 'px';
                        panel.style.height = nextHeight + 'px';
                        if (!paused) output.scrollTop = output.scrollHeight;
                        return;
                    }
                    if (dragging) {
                        var nextLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, event.clientX - dragOffsetX));
                        var nextTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, event.clientY - dragOffsetY));
                        panel.style.left = nextLeft + 'px';
                        panel.style.top = nextTop + 'px';
                    }
                });
                window.addEventListener('mouseup', function () {
                    dragging = false;
                    resizing = false;
                });
            }
            ['log', 'warn', 'error'].forEach(function (level) {
                var original = console[level];
                console[level] = function () {
                    write(level.toUpperCase(), arguments);
                    return original.apply(console, arguments);
                };
            });
            window.onerror = function (message, source, line) {
                write('ERROR', [message + ' @ ' + source + ':' + line]);
            };
            if (clear) clear.onclick = function () {
                allLines = [];
                counters = { req: 0, amf: 0, assets: 0 };
                renderLog();
                setText(reqStat, '0');
                setText(amfStat, '0');
                setText(assetStat, '0');
            };
            if (pause) pause.onclick = function () {
                paused = !paused;
                pause.textContent = paused ? 'Resume' : 'Pause';
                if (!paused) renderLog();
            };
            if (copy) copy.onclick = function () {
                var text = allLines.join('\\n');
                if (navigator.clipboard) navigator.clipboard.writeText(text);
                copy.textContent = 'Copied';
                setTimeout(function () { copy.textContent = 'Copy'; }, 900);
            };
            if (scroll) scroll.onclick = function () {
                paused = false;
                if (pause) pause.textContent = 'Pause';
                renderLog();
            };
            if (filter) filter.oninput = renderLog;
            console.log('Fallback play.html loaded');
            if (debug) {
                var fiddlerMode = new URLSearchParams(location.search).get('fiddler') === '1';
                var serverLogCursor = 0;
                var pollDbStatus = function () {
                    fetch('/api/db/status')
                        .then(function (response) { return response.json(); })
                        .then(function (data) {
                            setText(dbStat, data.source === 'remote' ? 'Render' : (data.mongoConnected ? 'MongoDB' : data.source));
                            setLight('db', data.mongoConnected ? 'good' : 'warn', data.source === 'remote' ? 'Render' : (data.mongoConnected ? 'Baza' : 'JSON'));
                        })
                        .catch(function () {
                            setText(dbStat, 'offline');
                            setLight('db', 'bad', 'Baza');
                        });
                };
                var serverLogUnavailableShown = false;
                var pollServerLogs = function () {
                    if (fiddlerMode) return;
                    fetch('/api/debug/logs?since=' + serverLogCursor)
                        .then(function (response) {
                            if (!response.ok) throw new Error('HTTP ' + response.status);
                            return response.json();
                        })
                        .then(function (data) {
                            serverLogCursor = data.next || serverLogCursor;
                            (data.lines || []).forEach(function (line) {
                                write('SERVER', [line.replace(/^\\d{4}-\\d{2}-\\d{2}T[^ ]+ /, '')]);
                            });
                        })
                        .catch(function (error) {
                            if (!serverLogUnavailableShown) {
                                serverLogUnavailableShown = true;
                                write('SERVER', ['debug logs unavailable: ' + error.message]);
                            }
                        });
                };
                pollDbStatus();
                if (fiddlerMode) {
                    write('SERVER', ['Fiddler mode: panel polling disabled, use msp-debug.log / amf-dumps']);
                } else {
                    pollServerLogs();
                    setInterval(pollServerLogs, 1000);
                }
                setInterval(pollDbStatus, 5000);
            }
        }());
    </script>
</body>
</html>`;
};

const sendPlayHtml = (req, res) => {
    if (req.path === '/play.html' && !req.query.country) {
        const debug = req.query.debug === '1' ? '&debug=1' : '';
        res.redirect(302, `/play.html?${startupParams}${debug}`);
        return;
    }
    const filePath = path.join(publicPath, 'play.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
        return;
    }
    log(`[FALLBACK] ${req.url} -> embedded play.html`);
    res.type('html').send(fallbackPlayHtml(req));
};


app.get(['/', '/play.html'], sendPlayHtml);
app.get('/cdnpath.txt', (req, res) => {
    res.type('text/plain').send(requestBaseUrl(req));
});

app.get(/^\/+assetconfig\.json$/i, async (req, res) => {
    const targets = [
        `${remoteAssetBaseUrl}/assetconfig.json`,
        `${remoteAssetBaseUrl}/msp/103.1.40/assetconfig.json`,
        `${officialMspAssetBaseUrl}/assetconfig.json`
    ];
    for (const targetUrl of targets) {
        try {
            await pipeRemoteAsset(targetUrl, res, 'assetconfig.json');
            log(`[ASSETCONFIG] ${req.url} -> ${targetUrl}`);
            return;
        } catch (err) {
            log(`[ASSETCONFIG MISS] ${targetUrl} ${err.message}`);
        }
    }
    res.status(502).type('text/plain').send('assetconfig unavailable');
});

app.get(/^\/+msp\/+103\.1\.40\/+(?:assetconfig\.json)$/i, async (req, res) => {
    const targets = [
        `${remoteAssetBaseUrl}/msp/103.1.40/assetconfig.json`,
        `${remoteAssetBaseUrl}/assetconfig.json`,
        `${officialMspAssetBaseUrl}/assetconfig.json`
    ];
    for (const targetUrl of targets) {
        try {
            await pipeRemoteAsset(targetUrl, res, 'assetconfig.json');
            log(`[ASSETCONFIG] ${req.url} -> ${targetUrl}`);
            return;
        } catch (err) {
            log(`[ASSETCONFIG MISS] ${targetUrl} ${err.message}`);
        }
    }
    res.status(502).type('text/plain').send('assetconfig unavailable');
});

const sanitizeLocalMap = (text) => text
    .replace(/https?:\/\/(?:localcdn|cdn|upload|cdndev|cdnlocaldev|cdnlocaltest|cdnlocalrc|cdn\.alpha|upload\.alpha|cdn\.beta|upload\.beta|cdn\.rc|uploadtest|cdntest|cdnupload)\.moviestarplanet(?:\.[a-z]+)?(?:\.[a-z]+)?\//gi, 'http://127.0.0.1/')
    .replace(/https?:\/\/(?:alpha|beta|dev|test|rc|www|info)\.moviestarplanet(?:\.[a-z]+)?(?:\.[a-z]+)?\//gi, 'http://127.0.0.1/')
    .replace(/https?:\/\/(?:[a-z0-9-]+\.)?mspapis\.com\//gi, 'http://127.0.0.1/')
    .replace(/https?:\/\/(?:[a-z0-9-]+\.)?mspcdns\.com\//gi, 'http://127.0.0.1/');

const disabledCountryUrl = 'http://127.0.0.1/server-unavailable.html';
const localCountry = (country, iso, locale, txt, enabled = false) => ({
    country,
    redirectUrl: enabled ? 'http://127.0.0.1/play.html' : disabledCountryUrl,
    locale,
    sys_cap: locale.split('_')[0],
    ISO_3166: iso,
    txt,
    supportMail: 'support@msp-2010.local',
    cdnLocalBasePath: 'http://127.0.0.1/',
    infoSiteMap: 'http://127.0.0.1/'
});
const localLanguageMaps = [
    localCountry('Poland', 'pl', 'pl_PL', 'MovieStarPlanet.pl', true),
    localCountry('Germany', 'de', 'de_DE', 'MovieStarPlanet.de'),
    localCountry('England', 'gb', 'en_US', 'MovieStarPlanet.co.uk'),
    localCountry('UnitedStates', 'us', 'en_US', 'MovieStarPlanet.com'),
    localCountry('France', 'fr', 'fr_FR', 'MovieStarPlanet.fr'),
    localCountry('Netherlands', 'nl', 'nl_NL', 'MovieStarPlanet.nl'),
    localCountry('Sweden', 'se', 'sv_SE', 'MovieStarPlanet.se'),
    localCountry('Denmark', 'dk', 'da_DK', 'MovieStarPlanet.dk'),
    localCountry('Norway', 'no', 'nb_NO', 'MovieStarPlanet.no'),
    localCountry('Finland', 'fi', 'fi_FI', 'MovieStarPlanet.fi'),
    localCountry('Turkey', 'tr', 'tr_TR', 'MovieStarPlanet.com.tr')
];
const localInfoSites = [{
    country: 'pl',
    baseURL: 'http://127.0.0.1/',
    about: 'server-unavailable.html',
    parents: 'server-unavailable.html',
    teachers: 'server-unavailable.html',
    userGuide: 'server-unavailable.html',
    safety: 'server-unavailable.html',
    privacyPolicy: 'server-unavailable.html',
    termsConditions: 'server-unavailable.html',
    contact: 'server-unavailable.html'
}];

const remoteAssetExtensions = new Set([
    '.swf', '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.txt', '.xml', '.json', '.css', '.html', '.js'
]);

const contentTypeFor = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    return {
        '.swf': 'application/x-shockwave-flash',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.mp3': 'audio/mpeg',
        '.txt': 'text/plain',
        '.xml': 'text/xml',
        '.json': 'application/json',
        '.css': 'text/css',
        '.html': 'text/html',
        '.js': 'application/javascript'
    }[ext] || 'application/octet-stream';
};


const emptySwfPayload = Buffer.from('RldTBhIAAAAwCgCgAAwBAAAA', 'base64');
const sendEmptySwfAsset = (req, res) => {
    log(`[EMPTY SWF ASSET] ${req.url}`);
    res.type('application/x-shockwave-flash').send(emptySwfPayload);
};

const downloadRemoteAsset = (url, destination) => new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const request = client.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            downloadRemoteAsset(new URL(response.headers.location, url).toString(), destination).then(resolve, reject);
            return;
        }
        if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
        }
        const tempFile = `${destination}.download`;
        const stream = fs.createWriteStream(tempFile);
        response.pipe(stream);
        stream.on('finish', () => {
            stream.close(() => {
                fs.rename(tempFile, destination, (err) => err ? reject(err) : resolve(destination));
            });
        });
        stream.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(15000, () => {
        request.destroy(new Error('Remote asset timeout'));
    });
});

const pipeRemoteAsset = (url, res, cleanPath) => new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            pipeRemoteAsset(new URL(response.headers.location, url).toString(), res, cleanPath).then(resolve, reject);
            return;
        }
        if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
        }

        res.type(contentTypeFor(cleanPath));
        response.pipe(res);
        response.on('end', () => resolve(true));
        response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(15000, () => {
        request.destroy(new Error('Remote asset timeout'));
    });
});

const proxyGatewayRequest = (req, res, method, fallbackHandler) => {
    if (!remoteGatewayUrl) return false;

    const targetUrl = new URL(`${remoteGatewayUrl}/Gateway.aspx`);
    if (method) {
        targetUrl.searchParams.set('method', method);
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const client = targetUrl.protocol === 'https:' ? https : http;
    let settled = false;
    const fallback = (reason) => {
        if (settled || res.headersSent) return;
        settled = true;
        if (typeof fallbackHandler === 'function') {
            fallbackHandler(reason).catch((err) => {
                log(`[REMOTE GATEWAY FALLBACK FAIL] ${method || ''} ${err.stack || err.message}`);
                if (!res.headersSent) {
                    res.status(502).type('text/plain').send('Remote gateway unavailable');
                }
            });
            return;
        }
        res.status(502).type('text/plain').send('Remote gateway unavailable');
    };
    const proxyReq = client.request(targetUrl, {
        method: req.method,
        headers: {
            'content-type': req.headers['content-type'] || 'application/x-amf',
            'content-length': body.length
        },
        timeout: remoteGatewayTimeoutMs
    }, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (chunk) => {
            chunks.push(chunk);
        });
        proxyRes.on('end', () => {
            if (settled || res.headersSent) return;
            const responseBody = Buffer.concat(chunks);
            const statusCode = proxyRes.statusCode || 502;
            if (statusCode >= 500) {
                log(`[REMOTE GATEWAY BAD STATUS] ${method || ''} status=${statusCode} bytes=${responseBody.length}`);
                fallback(`remote status ${statusCode}`);
                return;
            }
            settled = true;
            log(`[REMOTE GATEWAY OK] ${method || ''} status=${statusCode} bytes=${responseBody.length}`);
            res.status(statusCode);
            res.set('Content-Type', proxyRes.headers['content-type'] || 'application/x-amf');
            res.send(responseBody);
        });
    });

    proxyReq.on('error', (err) => {
        log(`[REMOTE GATEWAY FAIL] ${targetUrl.toString()} ${err.message}`);
        fallback(err.message);
    });
    proxyReq.on('timeout', () => {
        proxyReq.destroy(new Error('Remote gateway timeout'));
    });
    proxyReq.end(body);
    log(`[REMOTE GATEWAY] ${method || ''} -> ${targetUrl.toString()}`);
    return true;
};

// DODANE v19: proxy nie tylko /Gateway.aspx, ale tez SOAP /WebService/Service.asmx do Rendera.
// Nic lokalnego nie usuwamy: jesli Render padnie albo zwroci 5xx, wracamy do starego lokalnego handlera.
const proxyRemotePathRequest = (req, res, remotePath, label, fallbackHandler) => {
    if (!remoteGatewayUrl) return false;

    const targetUrl = new URL(`${remoteGatewayUrl}${remotePath}`);
    const originalUrl = req.originalUrl || req.url || '';
    const qIndex = originalUrl.indexOf('?');
    if (qIndex !== -1) {
        targetUrl.search = originalUrl.slice(qIndex);
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const client = targetUrl.protocol === 'https:' ? https : http;
    let settled = false;

    const fallback = (reason) => {
        if (settled || res.headersSent) return;
        settled = true;
        log(`[REMOTE ${label} FALLBACK] ${reason || ''}`);
        if (typeof fallbackHandler === 'function') {
            try {
                const maybePromise = fallbackHandler(reason);
                if (maybePromise && typeof maybePromise.catch === 'function') {
                    maybePromise.catch((err) => {
                        log(`[REMOTE ${label} FALLBACK FAIL] ${err.stack || err.message}`);
                        if (!res.headersSent) res.status(502).type('text/plain').send(`Remote ${label} unavailable`);
                    });
                }
            } catch (err) {
                log(`[REMOTE ${label} FALLBACK FAIL] ${err.stack || err.message}`);
                if (!res.headersSent) res.status(502).type('text/plain').send(`Remote ${label} unavailable`);
            }
            return;
        }
        res.status(502).type('text/plain').send(`Remote ${label} unavailable`);
    };

    const headers = Object.assign({}, req.headers, {
        host: targetUrl.host,
        'content-length': body.length
    });

    delete headers.connection;
    delete headers['accept-encoding'];

    const proxyReq = client.request(targetUrl, {
        method: req.method,
        headers,
        timeout: remoteGatewayTimeoutMs
    }, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
            if (settled || res.headersSent) return;
            const responseBody = Buffer.concat(chunks);
            const statusCode = proxyRes.statusCode || 502;

            if (statusCode >= 500) {
                log(`[REMOTE ${label} BAD STATUS] ${targetUrl.toString()} status=${statusCode} bytes=${responseBody.length}`);
                fallback(`remote status ${statusCode}`);
                return;
            }

            settled = true;
            log(`[REMOTE ${label} OK] ${targetUrl.toString()} status=${statusCode} bytes=${responseBody.length}`);
            res.status(statusCode);
            Object.entries(proxyRes.headers || {}).forEach(([key, value]) => {
                if (value !== undefined && key.toLowerCase() !== 'transfer-encoding') res.setHeader(key, value);
            });
            res.send(responseBody);
        });
    });

    proxyReq.on('error', (err) => {
        log(`[REMOTE ${label} FAIL] ${targetUrl.toString()} ${err.message}`);
        fallback(err.message);
    });
    proxyReq.on('timeout', () => {
        proxyReq.destroy(new Error(`Remote ${label} timeout`));
    });

    proxyReq.end(body);
    const actionSuffix = label === 'SOAP' ? ` action=${soapActionFrom(req)}` : '';
    log(`[REMOTE ${label}] ${req.method} ${req.url}${actionSuffix} -> ${targetUrl.toString()}`);
    return true;
};


const proxyRealMspApiRequest = (req, res, method, fallbackHandler) => {
    if (!realMspProxyEnabled) return false;

    const targetUrl = new URL(realMspGatewayUrl);
    if (method) {
        targetUrl.searchParams.set('method', method);
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let settled = false;
    const fallback = (reason) => {
        if (settled || res.headersSent) return;
        settled = true;
        if (typeof fallbackHandler === 'function') {
            fallbackHandler(reason).catch((err) => {
                log(`[REAL MSP FALLBACK FAIL] ${method || ''} ${err.stack || err.message}`);
                if (!res.headersSent) {
                    res.status(502).type('text/plain').send('Real MSP gateway unavailable');
                }
            });
            return;
        }
        res.status(502).type('text/plain').send('Real MSP gateway unavailable');
    };

    const proxyReq = https.request(targetUrl, {
        method: 'POST',
        headers: {
            'referer': 'app:/cache/t1.bin/[[DYNAMIC]]/2',
            'accept': 'text/xml, application/xml, application/xhtml+xml, text/html;q=0.9, text/plain;q=0.8, text/css, image/png, image/jpeg, image/gif;q=0.8, application/x-shockwave-flash, video/mp4;q=0.9, flv-application/octet-stream;q=0.8, video/x-flv;q=0.7, audio/mp4, application/futuresplash, */*;q=0.5, application/x-mpegURL',
            'x-flash-version': '32,0,0,100',
            'content-type': req.headers['content-type'] || 'application/x-amf',
            'content-length': body.length,
            'user-agent': 'Mozilla/5.0 (Windows; U; en) AppleWebKit/533.19.4 (KHTML, like Gecko) AdobeAIR/32.0',
            'connection': 'Keep-Alive'
        },
        timeout: remoteGatewayTimeoutMs
    }, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
            if (settled || res.headersSent) return;
            const responseBody = Buffer.concat(chunks);
            const statusCode = proxyRes.statusCode || 502;
            if (statusCode >= 400) {
                log(`[REAL MSP BAD STATUS] ${method || ''} status=${statusCode} bytes=${responseBody.length}`);
                fallback(`real msp status ${statusCode}`);
                return;
            }
            settled = true;
            log(`[REAL MSP OK] ${method || ''} status=${statusCode} bytes=${responseBody.length}`);
            res.status(statusCode);
            res.set('Content-Type', proxyRes.headers['content-type'] || 'application/x-amf');
            res.send(responseBody);
        });
    });

    proxyReq.on('error', (err) => {
        log(`[REAL MSP FAIL] ${targetUrl.toString()} ${err.message}`);
        fallback(err.message);
    });
    proxyReq.on('timeout', () => {
        proxyReq.destroy(new Error('Real MSP gateway timeout'));
    });
    proxyReq.end(body);
    log(`[REAL MSP] ${method || ''} -> ${targetUrl.toString()}`);
    return true;
};

const warmRemoteGateway = () => new Promise((resolve) => {
    if (!useRemoteGateway) {
        resolve(false);
        return;
    }

    const healthUrl = new URL(`${remoteGatewayUrl}/api/health`);
    const client = healthUrl.protocol === 'https:' ? https : http;
    log(`[REMOTE GATEWAY WARMUP] ${healthUrl.toString()}`);
    const request = client.get(healthUrl, { timeout: remoteGatewayTimeoutMs }, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 400) {
            log(`[REMOTE GATEWAY READY] ${healthUrl.toString()} status=${response.statusCode}`);
            resolve(true);
            return;
        }
        log(`[REMOTE GATEWAY WARMUP MISS] ${healthUrl.toString()} status=${response.statusCode}`);
        resolve(false);
    });
    request.on('error', (err) => {
        log(`[REMOTE GATEWAY WARMUP FAIL] ${healthUrl.toString()} ${err.message}`);
        resolve(false);
    });
    request.on('timeout', () => {
        request.destroy(new Error('Remote gateway warmup timeout'));
    });
});

const registrationAssetAlias = (cleanPath) => {
    const normalized = decodeURIComponent(String(cleanPath || '')).replace(/\\/g, '/').toLowerCase();
    const duplicatedWardrobeMatch = normalized.match(/^swf\/(hair|tops|bottoms|footwear)\/swf\/\1\/(.+?)\.swf(?:\.swf)?$/);
    if (duplicatedWardrobeMatch) {
        return `swf/${duplicatedWardrobeMatch[1]}/${duplicatedWardrobeMatch[2]}.swf`;
    }
    const categoryFolderMatch = normalized.match(/^swf\/(hair|tops|bottoms|footwear)\/swf\/\1\.swf$/);
    if (categoryFolderMatch) {
        const fallbackClothes = {
            hair: '2009_hair_girls_Honey_1.swf',
            tops: 'female_top_2009_1 (Nice Girl).swf',
            bottoms: 'female_bottoms_2009_1 (Loose Jeans).swf',
            footwear: 'january_2011_shoes_female_1.swf'
        };
        return `swf/${categoryFolderMatch[1]}/${fallbackClothes[categoryFolderMatch[1]]}`;
    }
    if (normalized === 'swf/faceparts/noses/nose_1.swf') {
        return 'swf/faceparts/noses/nose_5.swf';
    }
    if (normalized === 'swf/tops/nickelodeon_spotlight_girlstop_fj.swf') {
        return 'swf/stuff/nickelodeon_spotlight_girlstop_fj.swf';
    }
    if (normalized === 'swf/tops/nickelodeon_spotlight_boystop_fj.swf') {
        return 'swf/stuff/nickelodeon_spotlight_boystop_fj.swf';
    }
    if (normalized === 'swf/tops/birthdaycampaign_2013_boystop_ms_mf.swf') {
        return 'swf/stuff/birthdaycampaign_2013_boystop_ms_mf.swf';
    }
    if (normalized === 'swf/tops/cindarella whipped cream overwhelming disney dress.swf') {
        return 'swf/stuff/cindarella whipped cream overwhelming disney dress.swf';
    }
    if (normalized === 'swf/bottoms/nickelodeon_2015_maletopred_mf.swf') {
        return 'swf/stuff/nickelodeon_2015_maletopred_mf.swf';
    }
    if (normalized === 'swf/hair/hair_2.swf') {
        return 'swf/world/shopicons/hair.swf';
    }
    if (normalized === 'swf/hair/hair_male.swf') {
        return 'swf/world/shopicons/hair_male.swf';
    }
    if (normalized === 'swf/footwear/shoes.swf') {
        return 'swf/world/shopicons/shoes.swf';
    }
    if (normalized === 'swf/footwear/shoes_male.swf') {
        return 'swf/world/shopicons/shoes_male.swf';
    }
    return null;
};

const legacyMspAssetCandidates = (cleanPath, query) => {
    const normalized = decodeURIComponent(String(cleanPath || '')).replace(/\\/g, '/').toLowerCase();
    if (!/^swf\/(?:animations|faceparts)\/.+\.swf$/.test(normalized)) {
        return [];
    }
    return [
        `${legacyMspAssetBaseUrl}/${cleanPath}${query}`,
        `${legacyMspAssetBaseUrl}/${encodeURI(decodeURIComponent(cleanPath)).replace(/%2F/gi, '/')}${query}`,
        `${legacyMspAssetBaseUrl}/${cleanPath.toLowerCase()}${query}`
    ];
};

const isLikelyBadAnimationCache = (cleanPath, filePath) => {
    const normalized = decodeURIComponent(String(cleanPath || '')).replace(/\\/g, '/').toLowerCase();
    if (!/^swf\/animations\/.+\.swf$/.test(normalized)) {
        return false;
    }
    try {
        return fs.statSync(filePath).size < 4096;
    } catch (_) {
        return false;
    }
};

const serveRemoteAsset = async (req, res, cleanPath) => {
    if (!remoteAssetBaseUrl || !remoteAssetExtensions.has(path.extname(cleanPath).toLowerCase())) {
        return false;
    }
    if (!cleanPath || cleanPath.includes('..')) {
        return false;
    }

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const aliasPath = registrationAssetAlias(cleanPath);
    const cachePath = aliasPath || cleanPath;
    const cachedPath = path.join(assetCachePath, cachePath);
    if (remoteAssetCacheEnabled) {
        const cacheCandidates = [cachedPath];
        if (!aliasPath) {
            try {
                const encodedCachePath = path.join(assetCachePath, encodeURI(decodeURIComponent(cleanPath)).replace(/%2F/gi, '/'));
                if (encodedCachePath !== cachedPath) {
                    cacheCandidates.push(encodedCachePath);
                }
            } catch (_) {
                // Keep the original path when the URL is not decodable.
            }
        }
        for (const candidatePath of cacheCandidates) {
            if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
                if (isLikelyBadAnimationCache(cleanPath, candidatePath)) {
                    log(`[REMOTE ASSET CACHE BAD] ${req.url} -> ${candidatePath}`);
                    continue;
                }
                res.type(contentTypeFor(candidatePath)).sendFile(candidatePath);
                return true;
            }
        }
    }

    const officialAssetCandidates = officialMspAssetBaseUrl ? [
        ...(aliasPath ? [
            `${officialMspAssetBaseUrl}/${aliasPath}${query}`,
            `${officialMspAssetBaseUrl}/${aliasPath.toLowerCase()}${query}`
        ] : []),
        `${officialMspAssetBaseUrl}/${cleanPath}${query}`,
        `${officialMspAssetBaseUrl}/${cleanPath.toLowerCase()}${query}`
    ] : [];

    const candidates = [
        ...legacyMspAssetCandidates(cleanPath, query),
        ...(aliasPath ? [
            `${remoteAssetBaseUrl}/${aliasPath}${query}`,
            `${remoteAssetBaseUrl}/${aliasPath.toLowerCase()}${query}`
        ] : []),
        `${remoteAssetBaseUrl}/${cleanPath}${query}`,
        `${remoteAssetBaseUrl}/${cleanPath.toLowerCase()}${query}`,
        ...officialAssetCandidates
    ];

    for (const remoteUrl of candidates) {
        try {
            if (remoteAssetCacheEnabled) {
                await downloadRemoteAsset(remoteUrl, cachedPath);
                log(`[REMOTE ASSET] ${req.url} -> ${remoteUrl}`);
                res.type(contentTypeFor(cachedPath)).sendFile(cachedPath);
                return true;
            }
            await pipeRemoteAsset(remoteUrl, res, cleanPath);
            log(`[REMOTE ASSET] ${req.url} -> ${remoteUrl}`);
            return true;
        } catch (err) {
            log(`[REMOTE ASSET TRY MISS] ${remoteUrl} ${err.message}`);
        }
    }

    return false;
};

app.get(['/languagemaps.txt', '/localization/languagemaps.txt'], async (req, res) => {
    log(`[LANGMAP] ${req.url} -> forced pl_PL`);
    res.type('application/json').send(JSON.stringify(localLanguageMaps, null, 2));
});

app.get('/localization/infosites.txt', (req, res) => {
    log(`[INFOSITES] ${req.url} -> forced pl`);
    res.type('application/json').send(JSON.stringify(localInfoSites, null, 2));
});

app.get('/server-unavailable.html', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="pl">
<head>
    <meta charset="utf-8">
    <title>MovieStarPlanet - nowe serwery</title>
    <style>
        html, body {
            width: 100%;
            height: 100%;
            margin: 0;
            background: radial-gradient(circle at center, #243b72 0%, #111827 55%, #070a12 100%);
            color: #fff;
            font-family: Arial, sans-serif;
        }
        main {
            min-height: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 24px;
            text-align: center;
            padding: 32px;
            box-sizing: border-box;
        }
        object {
            width: 260px;
            height: 160px;
        }
        h1 {
            margin: 0;
            font-size: 34px;
        }
        p {
            margin: 0;
            color: #dbeafe;
            font-size: 20px;
        }
        a {
            color: #fff;
            background: #ec4899;
            border-radius: 8px;
            padding: 12px 18px;
            text-decoration: none;
            font-weight: 700;
        }
    </style>
</head>
<body>
    <main>
        <object type="application/x-shockwave-flash" data="/swf/world/frameIcons/MSP_Logo.swf"></object>
        <h1>Pracujemy nad tym</h1>
        <p>Nowe serwery wkrotce.</p>
        <a href="/play.html">Wroc do polskiego serwera</a>
    </main>
</body>
</html>`);
});

app.get(/^\/(?:null)?lookdata_[0-9_]+$/i, (req, res) => {
    log(`[LOOKDATA] ${req.url}`);
    res.type('application/octet-stream').send(lookDataPayload());
});

app.get(/^\/(?:MSP_alpha_blob_)?lookdata_[0-9_]+$/i, (req, res) => {
    log(`[LOOKDATA] ${req.url}`);
    res.type('application/octet-stream').send(lookDataPayload());
});

app.get(/^\/Main_2010123_95850\.swf$/i, async (req, res, next) => {
    // Main tez bierzemy najpierw z publicznego R2, dopiero potem z lokalnego public/.
    if (await serveRemoteAsset(req, res, 'Main_2010123_95850.swf')) {
        return;
    }
    if (await serveRemoteAsset(req, res, 'main_2010123_95850.swf')) {
        return;
    }
    const fileCandidates = [
        path.join(publicPath, 'Main_2010123_95850.swf'),
        path.join(publicPath, 'main_2010123_95850.swf')
    ];
    const filePath = fileCandidates.find((candidate) => fs.existsSync(candidate));
    if (filePath) {
        res.type('application/x-shockwave-flash').sendFile(filePath);
        return;
    }
    next();
});

app.get(/^\/+main_2010123_95850\.swf$/i, async (req, res, next) => {
    if (await serveRemoteAsset(req, res, 'Main_2010123_95850.swf')) {
        return;
    }
    if (await serveRemoteAsset(req, res, 'main_2010123_95850.swf')) {
        return;
    }
    next();
});

app.get(/^\/+graphics\/FrontpageDesign_film\.swf$/i, async (req, res) => {
    if (await serveRemoteAsset(req, res, 'graphics/FrontpageDesign_film.swf')) {
        return;
    }
    if (await serveRemoteAsset(req, res, 'graphics/frontpagedesign_film.swf')) {
        return;
    }
    sendEmptySwfAsset(req, res);
});
app.get(/^\/+graphics\/moviestar\.swf$/i, async (req, res) => {
    if (await serveRemoteAsset(req, res, 'graphics/moviestar.swf')) {
        return;
    }
    if (await serveRemoteAsset(req, res, 'graphics/FrontpageDesign_film.swf')) {
        return;
    }
    if (await serveRemoteAsset(req, res, 'graphics/frontpagedesign_film.swf')) {
        return;
    }
    sendEmptySwfAsset(req, res);
});

app.get(/^\/+swf\/skins\/swf\/skins\/([^/]+?)\.swf\.swf$/i, async (req, res) => {
    const skinName = String(req.params[0] || 'maleskin').replace(/[^a-z0-9_-]/gi, '') || 'maleskin';
    const skinPath = `swf/skins/${skinName}.swf`;
    log(`[SKIN PATH FIX] ${req.url} -> ${skinPath}`);
    if (await serveRemoteAsset(req, res, skinPath)) {
        return;
    }
    if (skinName.toLowerCase() !== 'maleskin' && await serveRemoteAsset(req, res, 'swf/skins/maleskin.swf')) {
        return;
    }
    sendEmptySwfAsset(req, res);
});

app.get(/^\/+swf\/skins\/([^/]+?)\.swf\.swf$/i, async (req, res) => {
    const skinName = String(req.params[0] || 'maleskin').replace(/[^a-z0-9_-]/gi, '') || 'maleskin';
    const skinPath = `swf/skins/${skinName}.swf`;
    log(`[SKIN DOUBLE EXT FIX] ${req.url} -> ${skinPath}`);
    if (await serveRemoteAsset(req, res, skinPath)) {
        return;
    }
    sendEmptySwfAsset(req, res);
});

app.get(/^\/+swf\/skins\/null\.swf$/i, async (req, res) => {
    log(`[SKIN ALIAS] ${req.url} -> swf/skins/maleskin.swf`);
    if (await serveRemoteAsset(req, res, 'swf/skins/maleskin.swf')) {
        return;
    }
    log(`[SKIN ALIAS MISS] ${req.url} -> swf/skins/maleskin.swf`);
    if (await serveRemoteAsset(req, res, 'swf/skins/femaleskin.swf')) {
        return;
    }
    sendEmptySwfAsset(req, res);
});

app.get('/dictionaries/Global/instantBlocking.txt', (req, res) => {
    res.type('text/plain').send('');
});

app.get(/^\/msp\/[^/]+\/(.+)$/i, (req, res, next) => {
    const requestedPath = req.params[0];
    if (!requestedPath || requestedPath.includes('..')) {
        next();
        return;
    }

    const filePath = path.join(publicPath, requestedPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        next();
        return;
    }

    log(`[VERSIONED ASSET] ${req.url} -> ${filePath}`);
    res.sendFile(filePath);
});

app.all('/translations/crossdomain.xml', (req, res) => {
    log(`[POLICY] ${req.headers.host || ''}${req.url}`);
    res.set('Content-Type', 'text/x-cross-domain-policy');
    res.send(FLASH_POLICY_XML);
});

app.get('/:client(MSPWeb|MSPMobile)/:locale/myResources.txt', async (req, res) => {
    const client = req.params.client.toLowerCase();
    const filePath = path.join(__dirname, 'public', 'translations', client, forcedLocalePath, 'myresources.txt');
    log(`[TRANSLATION] ${req.url} -> ${filePath}`);
    if (fs.existsSync(filePath)) {
        res.type('text/plain').sendFile(filePath);
        return;
    }
    const remotePaths = [
        `${req.params.client}/${forcedLocale}/myResources.txt`,
        `translations/${client}/${forcedLocalePath}/myresources.txt`
    ];
    for (const remotePath of remotePaths) {
        if (await serveRemoteAsset(req, res, remotePath)) {
            return;
        }
    }
    log(`[TRANSLATION MISS] ${filePath}`);
    res.status(404).type('text/plain').send(`Missing translation: ${req.url}`);
});

app.get('/api/debug/logs', (req, res) => {
    if (!isDebugMode) {
        res.status(404).json({ error: 'debug disabled' });
        return;
    }
    const since = Math.max(0, Number(req.query.since) || 0);
    res.json({
        next: recentLogs.length,
        lines: recentLogs.slice(since)
    });
});

const xmlEscape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const soapEnvelope = (action, innerXml) => `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <${action}Response xmlns="http://moviestarplanet.com/">
      ${innerXml}
    </${action}Response>
  </soap:Body>
</soap:Envelope>`;

const soapActionFrom = (req) => {
    const headerAction = String(req.headers.soapaction || '').replace(/"/g, '').split('/').pop();
    if (headerAction) return headerAction;
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const matches = [...body.matchAll(/<([A-Za-z0-9_:]+)(?:\s|>)/g)]
        .map((match) => match[1].replace(/^(soap|soap12):/i, ''))
        .filter((name) => !/^(Envelope|Header|Body|TicketHeader)$/i.test(name));
    return matches[0] || 'Unknown';
};

const sendSoapResult = (res, action, resultXml) => {
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(soapEnvelope(action, resultXml));
};

const soapStringValues = (req) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    return [...body.matchAll(/<string[^>]*>([^<]*)<\/string>/gi)]
        .map((match) => match[1])
        .filter(Boolean);
};

const soapAppSettingsXml = (keys = []) => {
    const requested = keys.length > 0 ? keys : Object.keys(appSettingDefaults);
    const items = requested.map((name) => {
        const safeName = xmlEscape(name);
        const safeValue = xmlEscape(appSettingValue(name));
        return `<AppSetting><name>${safeName}</name><value>${safeValue}</value><Name>${safeName}</Name><Value>${safeValue}</Value></AppSetting>`;
    }).join('');
    return `<GetAppSettingsResult>${items}</GetAppSettingsResult>`;
};

const userServiceWsdl = `<?xml version="1.0" encoding="utf-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="http://moviestarplanet.com/" targetNamespace="http://moviestarplanet.com/">
  <service name="UserService">
    <documentation>Local MSP compatibility endpoint</documentation>
  </service>
</definitions>`;


const serviceWsdl = `<?xml version="1.0" encoding="utf-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="http://moviestarplanet.com/" targetNamespace="http://moviestarplanet.com/">
  <service name="Service">
    <documentation>Local MSP 2010 compatibility endpoint</documentation>
  </service>
</definitions>`;


const cleanSoapName = (name, fallback = 'item') => {
    const raw = String(name || fallback).replace(/^.*[.+]/, '');
    const safe = raw.replace(/[^A-Za-z0-9_:-]/g, '') || fallback;
    return /^[A-Za-z_]/.test(safe) ? safe : fallback;
};

const soapXmlNode = (name, value, depth = 0) => {
    const tag = cleanSoapName(name);
    if (value === undefined || value === null) {
        return `<${tag} xsi:nil="true" />`;
    }
    if (value instanceof Date) {
        return `<${tag}>${xmlEscape(value.toISOString())}</${tag}>`;
    }
    if (typeof value !== 'object') {
        return `<${tag}>${xmlEscape(value)}</${tag}>`;
    }
    if (Array.isArray(value)) {
        const itemTag = cleanSoapName(value[0] && value[0].__class ? value[0].__class : 'item');
        return `<${tag}>${value.map((item) => soapXmlNode(itemTag, item, depth + 1)).join('')}</${tag}>`;
    }
    if (depth > 8) {
        return `<${tag} />`;
    }
    const body = Object.keys(value)
        .filter((key) => key !== '__class')
        .map((key) => soapXmlNode(key, value[key], depth + 1))
        .join('');
    return `<${tag}>${body}</${tag}>`;
};

const soapRegisterNewUserDataXml = () => {
    const node = (name, value) => `<${name}>${xmlEscape(value)}</${name}>`;
    const clothingSwf = (filename) => path.basename(String(filename || ''), '.swf');
    const face = (tag, idName, id, swf, colors = '', skinId = 0) => `<${tag}>`
        + node(idName, id)
        + node('Name', '')
        + node('SWF', swf)
        + node('SkinId', skinId)
        + node('DefaultColors', colors)
        + `</${tag}>`;
    const cloth = (id, cat, swf, filename, colors = '', skinId = 0, reg = 1) => `<Cloth>`
        + node('ClothesId', id)
        + node('Name', '')
        + node('SWF', clothingSwf(filename))
        + node('ClothesCategoryId', cat)
        + node('Price', 0)
        + node('ShopId', 0)
        + node('SkinId', skinId)
        + node('Filename', filename)
        + node('Scale', 1)
        + node('Vip', false)
        + node('RegNewUser', reg)
        + node('sortorder', id)
        + node('New', false)
        + node('Discount', 0)
        + node('ColorScheme', colors)
        + `<ClothesCategory>`
        + node('ClothesCategoryId', cat)
        + node('Name', '')
        + node('SlotTypeId', cat)
        + `<SlotType>${node('SlotTypeId', cat)}${node('Name', '')}</SlotType>`
        + `</ClothesCategory>`
        + `</Cloth>`;
    const rel = (id, colors = '', clothXml = '') => `<ActorClothesRel>`
        + node('ActorClothesRelId', id)
        + node('_ActorClothesRelId', id)
        + node('ClothId', id)
        + node('_ClothId', id)
        + node('ClothesId', id)
        + node('_ClothesId', id)
        + node('Color', colors)
        + node('_Color', colors)
        + node('IsWearing', true)
        + node('_IsWearing', true)
        + node('x', 0)
        + node('y', 0)
        + clothXml
        + `</ActorClothesRel>`;

    const eyeAll = [
        face('Eye', 'EyeId', 1, 'female_eyes_2', '0x5b351c', 1),
        face('Eye', 'EyeId', 2, 'male_eye1', '0x3a6eb5', 2),
        face('Eye', 'EyeId', 3, 'eyes_1', '0x5b351c', 1)
    ].join('');
    const noseAll = [
        face('Nose', 'NoseId', 5, 'nose_5', '', 1),
        face('Nose', 'NoseId', 4, 'nose_4', '', 2),
        face('Nose', 'NoseId', 6, 'nose_6', '', 1)
    ].join('');
    const mouthAll = [
        face('Mouth', 'MouthId', 1, 'female_mouth_1', 'skincolor,0xd45a6a', 1),
        face('Mouth', 'MouthId', 2, 'female_mouth_2', 'skincolor,0xd45a6a', 1),
        face('Mouth', 'MouthId', 4, 'male_mouth_1', 'skincolor,0xb64254', 2)
    ].join('');

    // Ubrania meskie
    const hairMale = cloth(1005, 1, 'swf/hair', '2009_hair_boys_Honey_3.swf', '0xcc0000,0xff6600,0xffff00', 2);
    const hairMaleAlt = cloth(1006, 1, 'swf/hair', '2009_hair_boys_Honey_4.swf', '0x111111,0x666666', 2);
    const topMale = cloth(1057, 2, 'swf/tops', 'honey_male_shirt_1.swf', '0x666666', 2);
    const topMaleAlt = cloth(1055, 2, 'swf/tops', 'Honey_Male_shirt_2.swf', '0x003300', 2);
    const bottomMale = cloth(1002, 3, 'swf/bottoms', '2009_Honey_bottoms_1_boys (Soldier).swf', '', 2);
    const bottomMaleAlt = cloth(1050, 3, 'swf/bottoms', '2009_Honey_bottoms_3_boys.swf', '0x6666cc,0xffffff', 2);
    const shoesMale = cloth(1128, 10, 'swf/footwear', 'Fall_mens_shoes_1 (Classic Shoes).swf', '0x6699cc,0x990000', 2);
    const shoesMaleAlt = cloth(1129, 10, 'swf/footwear', 'Drakulashoes_1 (Gentleman_s Shoes).swf', '0x222222,0xffffff', 2);
    const relsMale = [
        rel(1005, '0xcc0000,0xff6600,0xffff00', hairMale),
        rel(1057, '0x666666', topMale),
        rel(1002, '', bottomMale),
        rel(1128, '0x6699cc,0x990000', shoesMale)
    ].join('');

    // Ubrania zenskie
    const hairFemale = cloth(1022, 1, 'swf/hair', '2009_hair_girls_Honey_1.swf', '', 1);
    const hairFemaleAlt = cloth(1021, 1, 'swf/hair', '2009_hair_girls_Honey_2 (Japanese Buns).swf', '0xff9900,0x663366', 1);
    const topFemale = cloth(1036, 2, 'swf/tops', 'female_top_2009_1 (Nice Girl).swf', '0x666666,0xFF00CC', 1);
    const topFemaleAlt = cloth(1011, 2, 'swf/tops', 'female_top_2009_2 (Stitches).swf', '0xff66cc,0x99ffcc,0x99ffcc,0xff66cc', 1);
    const bottomFemale = cloth(1054, 3, 'swf/bottoms', 'female_bottoms_2009_1 (Loose Jeans).swf', '0x990099,0xffcc00,0xffff33', 1);
    const bottomFemaleAlt = cloth(1052, 3, 'swf/bottoms', 'female_bottoms_2009_2 (Sparkles).swf', '0xff0066,0xfeffff', 1);
    const shoesFemale = cloth(1028, 10, 'swf/footwear', 'january_2011_shoes_female_1.swf', '0x6699cc,0x990000', 1);
    const shoesFemaleAlt = cloth(1029, 10, 'swf/footwear', 'february_shoes_female_1.swf', '0xff66cc,0xffffff', 1);
    const relsFemale = [
        rel(1022, '', hairFemale),
        rel(1036, '0x666666,0xFF00CC', topFemale),
        rel(1054, '0x990099,0xffcc00', bottomFemale),
        rel(1028, '0x6699cc,0x990000', shoesFemale)
    ].join('');

    const allClothes = hairFemale + hairFemaleAlt + topFemale + topFemaleAlt + bottomFemale + bottomFemaleAlt
        + shoesFemale + shoesFemaleAlt + hairMale + hairMaleAlt + topMale + topMaleAlt + bottomMale + bottomMaleAlt
        + shoesMale + shoesMaleAlt;
    const actor = (gender, skinSwf, eyeId, noseId, mouthId, eyeColors, mouthColors, rels, clothes) => `<ActorDetails>`
        + node('ActorId', 0)
        + node('_ActorId', 0)
        + node('Name', '')
        + node('_Name', '')
        + node('Gender', gender)
        + node('_Gender', gender)
        + node('SkinSWF', skinSwf)
        + node('_SkinSWF', skinSwf)
        + node('SkinColor', '0xffd1b3')
        + node('_SkinColor', '0xffd1b3')
        + node('EyeId', eyeId)
        + node('_EyeId', eyeId)
        + node('NoseId', noseId)
        + node('_NoseId', noseId)
        + node('MouthId', mouthId)
        + node('_MouthId', mouthId)
        + node('EyeColors', eyeColors)
        + node('_EyeColors', eyeColors)
        + node('MouthColors', mouthColors)
        + node('_MouthColors', mouthColors)
        + `<ActorClothesRels>${rels}</ActorClothesRels>`
        + `<_ActorClothesRels>${rels}</_ActorClothesRels>`
        + `<ActorClothesRels2>${rels}</ActorClothesRels2>`
        + `<_ActorClothesRels2>${rels}</_ActorClothesRels2>`
        + `<Clothes>${clothes}</Clothes>`
        + `<_Clothes>${clothes}</_Clothes>`
        + `</ActorDetails>`;
    const maleActor = actor('Male', 'maleskin', 2, 4, 4, '0x3a6eb5', 'skincolor,0xb64254',
        relsMale, hairMale + topMale + bottomMale + shoesMale);
    const femaleActor = actor('Female', 'femaleskin', 1, 5, 1, '0x5b351c', 'skincolor,0xd45a6a',
        relsFemale, hairFemale + topFemale + bottomFemale + shoesFemale);
    const registerData = [
        `<eyes>${eyeAll}</eyes>`,
        `<noses>${noseAll}</noses>`,
        `<mouths>${mouthAll}</mouths>`,
        `<clothes>${allClothes}</clothes>`,
        `<actorClothesRels>${relsFemale}${relsMale}</actorClothesRels>`,
        `<maleActor>${maleActor}</maleActor>`,
        `<femaleActor>${femaleActor}</femaleActor>`,
        `<defaultMaleActor>${maleActor}</defaultMaleActor>`,
        `<defaultFemaleActor>${femaleActor}</defaultFemaleActor>`
    ].join('');
    const xml = `<LoadDataForRegisterNewUserResult>${registerData}</LoadDataForRegisterNewUserResult>`;
    log(`[SOAP REGISTER ALIAS] responseBytes=${Buffer.byteLength(xml, 'utf8')}`);
    return xml;
};
const handleSoapCompatibilityRequest = (req, res, serviceLabel = 'SOAP') => {
    const action = soapActionFrom(req);
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8').replace(/\s+/g, ' ').slice(0, 260) : '';
    log(`[${serviceLabel}] ${req.method} ${req.url} action=${action} body=${body}`);

    if (/GetAppSettings/i.test(action)) {
        sendSoapResult(res, 'GetAppSettings', soapAppSettingsXml(soapStringValues(req)));
        return;
    }
    if (/GetIPLoginType/i.test(action)) {
        sendSoapResult(res, 'GetIPLoginType', '<GetIPLoginTypeResult>0</GetIPLoginTypeResult>');
        return;
    }
    if (/getLoginHistory/i.test(action)) {
        sendSoapResult(res, 'getLoginHistory', '<getLoginHistoryResult />');
        return;
    }

    if (/LoadDataForRegisterNewUser/i.test(action)) {
        const registerXml = soapRegisterNewUserDataXml();
        log(`[SOAP REGISTER] responseBytes=${Buffer.byteLength(registerXml, 'utf8')}`);
        sendSoapResult(res, 'LoadDataForRegisterNewUser', registerXml);
        return;
    }
    if (/GetActorCount/i.test(action)) {
        const count = Array.isArray(db.users) ? db.users.length : 0;
        sendSoapResult(res, 'GetActorCount', `<GetActorCountResult>${count}</GetActorCountResult>`);
        return;
    }
    if (/GetMovieCount/i.test(action)) {
        const count = Array.isArray(db.movies) ? db.movies.length : 0;
        sendSoapResult(res, 'GetMovieCount', `<GetMovieCountResult>${count}</GetMovieCountResult>`);
        return;
    }
    if (/LoadActorWithCurrentClothesBasicDataOnly/i.test(action)) {
        sendSoapResult(res, 'LoadActorWithCurrentClothesBasicDataOnly', soapXmlNode('LoadActorWithCurrentClothesBasicDataOnlyResult', devActorDetails(null, true)));
        return;
    }

    if (/GetServerTime|GetTime|ServerTime/i.test(action)) {
        const safeTimeAction = /^[A-Za-z_][A-Za-z0-9_]*$/.test(action) && action !== 'Unknown' ? action : 'GetServerTime';
        sendSoapResult(res, safeTimeAction, `<${safeTimeAction}Result>${xmlEscape(new Date().toISOString())}</${safeTimeAction}Result>`);
        return;
    }
    if (/Login2/i.test(action)) {
        sendSoapResult(res, 'Login2', '<Login2Result><loginStatus><status>Success</status></loginStatus></Login2Result>');
        return;
    }
    if (/Login/i.test(action)) {
        sendSoapResult(res, 'Login', '<LoginResult><status>Success</status></LoginResult>');
        return;
    }

    const safeAction = /^[A-Za-z_][A-Za-z0-9_]*$/.test(action) && action !== 'Unknown' ? action : 'GetIPLoginType';
    sendSoapResult(res, safeAction, `<${safeAction}Result>false</${safeAction}Result>`);
};

const shouldHandleSoapBeforeRemote = (action) => (
    /LoadDataForRegisterNewUser/i.test(action)
);

app.all(/^\/+WebService\/+Service\.asmx\/?$/i, (req, res) => {
    if (req.method === 'GET' || /wsdl/i.test(req.url)) {
        res.type('text/xml').send(serviceWsdl);
        return;
    }

    const action = soapActionFrom(req);
    if (shouldHandleSoapBeforeRemote(action)) {
        log(`[SOAP LOCAL FIRST] action=${action}`);
        handleSoapCompatibilityRequest(req, res, 'SOAP SERVICE');
        return;
    }

    // DODANE v19: klient lokalny przekazuje SOAP do Rendera.
    // To wlasnie tu ida Login, CreateNewUser, LoadActorDetails i rejestracja 2010.
    if (useRemoteGateway && proxyRemotePathRequest(req, res, '/WebService/Service.asmx', 'SOAP', () => {
        handleSoapCompatibilityRequest(req, res, 'SOAP SERVICE');
    })) {
        return;
    }

    handleSoapCompatibilityRequest(req, res, 'SOAP SERVICE');
});

app.all(/^\/+WebService\/User\/UserService\.asmx$/i, (req, res) => {
    const action = soapActionFrom(req);
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8').replace(/\s+/g, ' ').slice(0, 220) : '';
    log(`[SOAP USER] ${req.method} ${req.url} action=${action} body=${body}`);

    if (req.method === 'GET' || /wsdl/i.test(req.url)) {
        res.type('text/xml').send(userServiceWsdl);
        return;
    }

    if (/GetAppSettings/i.test(action)) {
        sendSoapResult(res, 'GetAppSettings', soapAppSettingsXml(soapStringValues(req)));
        return;
    }
    if (/GetIPLoginType/i.test(action)) {
        sendSoapResult(res, 'GetIPLoginType', '<GetIPLoginTypeResult>0</GetIPLoginTypeResult>');
        return;
    }
    if (/getLoginHistory/i.test(action)) {
        sendSoapResult(res, 'getLoginHistory', '<getLoginHistoryResult />');
        return;
    }
    if (/Login2/i.test(action)) {
        sendSoapResult(res, 'Login2', '<Login2Result><loginStatus><status>Success</status></loginStatus></Login2Result>');
        return;
    }
    if (/Login/i.test(action)) {
        sendSoapResult(res, 'Login', '<LoginResult><status>Success</status></LoginResult>');
        return;
    }

    const safeAction = /^[A-Za-z_][A-Za-z0-9_]*$/.test(action) && action !== 'Unknown' ? action : 'GetIPLoginType';
    sendSoapResult(res, safeAction, `<${safeAction}Result>false</${safeAction}Result>`);
});

app.use(express.static(publicPath));

app.get('*', async (req, res, next) => {
    if (await serveRemoteAsset(req, res, req.path.replace(/^\/+/, ''))) {
        return;
    }
    if (!req.path.startsWith('/api/')) {
        log(`[REMOTE ASSET MISS] ${req.url}`);
    }
    next();
});

const readUtf = (buffer, offset) => {
    const length = buffer.readUInt16BE(offset);
    const start = offset + 2;
    return {
        value: buffer.slice(start, start + length).toString('utf8'),
        offset: start + length
    };
};

const skipAmfEnvelopeHeaders = (buffer, offset, count) => {
    for (let i = 0; i < count; i++) {
        const name = readUtf(buffer, offset);
        offset = name.offset + 1;
        const length = buffer.readInt32BE(offset);
        offset += 4;
        if (length >= 0) {
            offset += length;
        }
    }
    return offset;
};

const parseAmfEnvelope = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 6) {
        return null;
    }
    let offset = 0;
    const version = buffer.readUInt16BE(offset);
    offset += 2;
    const headerCount = buffer.readUInt16BE(offset);
    offset += 2;
    offset = skipAmfEnvelopeHeaders(buffer, offset, headerCount);
    const messageCount = buffer.readUInt16BE(offset);
    offset += 2;
    const messages = [];
    for (let i = 0; i < messageCount; i++) {
        const target = readUtf(buffer, offset);
        offset = target.offset;
        const response = readUtf(buffer, offset);
        offset = response.offset;
        const length = buffer.readInt32BE(offset);
        offset += 4;
        const bodyStart = offset;
        const bodyEnd = length >= 0 ? offset + length : buffer.length;
        messages.push({
            target: target.value,
            response: response.value,
            length,
            bodyStart,
            body: buffer.slice(bodyStart, bodyEnd)
        });
        offset = bodyEnd;
    }
    return { version, messages };
};

const writeUtf = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
};

const amf0String = (value) => {
    const bytes = Buffer.from(String(value), 'utf8');
    const header = Buffer.alloc(3);
    header[0] = 0x02;
    header.writeUInt16BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
};

const amf0Number = (value) => {
    const buffer = Buffer.alloc(9);
    buffer[0] = 0x00;
    buffer.writeDoubleBE(Number(value) || 0, 1);
    return buffer;
};

const amf0Boolean = (value) => Buffer.from([0x01, value ? 1 : 0]);
const amf0Null = () => Buffer.from([0x05]);

const amf0Array = (items) => {
    const length = Buffer.alloc(5);
    length[0] = 0x0a;
    length.writeUInt32BE(items.length, 1);
    return Buffer.concat([length, ...items.map(amf0Value)]);
};

const amf0Object = (object) => {
    const className = object && object.__class ? String(object.__class) : '';
    const parts = className ? [Buffer.from([0x10]), writeUtf(className)] : [Buffer.from([0x03])];
    Object.keys(object).filter((key) => key !== '__class').forEach((key) => {
        parts.push(writeUtf(key));
        parts.push(amf0Value(object[key]));
    });
    parts.push(Buffer.from([0x00, 0x00, 0x09]));
    return Buffer.concat(parts);
};

const amf0Value = (value) => {
    if (value === null || value === undefined) {
        return amf0Null();
    }
    if (Array.isArray(value)) {
        return amf0Array(value);
    }
    if (typeof value === 'boolean') {
        return amf0Boolean(value);
    }
    if (typeof value === 'number') {
        return amf0Number(value);
    }
    if (typeof value === 'object') {
        return amf0Object(value);
    }
    return amf0String(value);
};

const amf3U29 = (value) => {
    value &= 0x1fffffff;
    if (value < 0x80) return Buffer.from([value]);
    if (value < 0x4000) return Buffer.from([(value >> 7) | 0x80, value & 0x7f]);
    if (value < 0x200000) return Buffer.from([(value >> 14) | 0x80, ((value >> 7) & 0x7f) | 0x80, value & 0x7f]);
    return Buffer.from([(value >> 22) | 0x80, ((value >> 15) & 0x7f) | 0x80, ((value >> 8) & 0x7f) | 0x80, value & 0xff]);
};

const amf3Utf = (value) => {
    const bytes = Buffer.from(String(value || ''), 'utf8');
    return Buffer.concat([amf3U29((bytes.length << 1) | 1), bytes]);
};

const amf3Value = (value) => {
    if (value === undefined || value === null) return Buffer.from([0x01]);
    if (value === false) return Buffer.from([0x02]);
    if (value === true) return Buffer.from([0x03]);
    if (typeof value === 'number') {
        if (Number.isInteger(value) && value >= -268435456 && value <= 268435455) {
            return Buffer.concat([Buffer.from([0x04]), amf3U29(value)]);
        }
        const buffer = Buffer.alloc(9);
        buffer[0] = 0x05;
        buffer.writeDoubleBE(value, 1);
        return buffer;
    }
    if (typeof value === 'string') return Buffer.concat([Buffer.from([0x06]), amf3Utf(value)]);
    if (value instanceof Date) {
        const buffer = Buffer.alloc(8);
        buffer.writeDoubleBE(value.getTime(), 0);
        return Buffer.concat([Buffer.from([0x08]), amf3U29(1), buffer]);
    }
    if (Buffer.isBuffer(value)) {
        return Buffer.concat([Buffer.from([0x0c]), amf3U29((value.length << 1) | 1), value]);
    }
    if (Array.isArray(value)) {
        return Buffer.concat([
            Buffer.from([0x09]),
            amf3U29((value.length << 1) | 1),
            amf3Utf(''),
            ...value.map(amf3Value)
        ]);
    }
    if (typeof value === 'object') {
        const className = value.__class || '';
        const keys = Object.keys(value).filter((key) => key !== '__class');
        return Buffer.concat([
            Buffer.from([0x0a]),
            amf3U29((keys.length << 4) | 3),
            amf3Utf(className),
            ...keys.map(amf3Utf),
            ...keys.map((key) => amf3Value(value[key]))
        ]);
    }
    return Buffer.concat([Buffer.from([0x06]), amf3Utf(String(value))]);
};

const typed = (__class, object) => Object.assign({ __class }, object);

const ACTOR_DETAILS_ALIAS = 'MovieStarPlanet.DBML.ActorDetails';
const ACTOR_PERSONAL_INFO_ALIAS = 'MovieStarPlanet.DBML.ActorPersonalInfo';
const ACTOR_STATUS_ALIAS = 'MovieStarPlanet.DBML.ActorStatus';
const COMBAT_CATEGORISATION_ALIAS = 'MovieStarPlanet.Model.Combat.ValueObjects.CombatCategorisation';
const CREATE_NEW_USER_STATUS_ALIAS = 'MovieStarPlanet.WebService.User.UserService+CreateNewUserStatus';
const REGISTER_NEW_USER_DATA_ALIAS = 'RegisterNewUserData';
const ACTOR_CLOTHES_REL_ALIAS = 'ActorClothesRel';
const CLOTH_ALIAS = 'Cloth';
const CLOTHES_CATEGORY_ALIAS = 'ClothesCategory';
const SLOT_TYPE_ALIAS = 'SlotType';

const amf0Amf3Value = (value) => Buffer.concat([Buffer.from([0x11]), amf3Value(value)]);

const toAmfSerializable = (value) => {
    if (value === undefined || value === null) return value;
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(toAmfSerializable);
    if (typeof value !== 'object') return value;

    const output = new amfjs.Serializable(value.__class || '');
    Object.keys(value).forEach((key) => {
        if (key !== '__class') {
            output[key] = toAmfSerializable(value[key]);
        }
    });
    return output;
};

const amfjsBody = (value, useAmf3) => {
    const chunks = [];
    const sink = new Writable({
        write(chunk, encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        }
    });
    const encoder = new amfjs.AMFEncoder(sink);
    const encodedValue = toAmfSerializable(value);

    if (useAmf3) {
        encoder.encode(encodedValue, amfjs.AMF3);
    } else {
        encoder.writeObject(encodedValue, amfjs.AMF0);
    }

    return Buffer.concat(chunks);
};

const decodeAmfjsBody = (body) => {
    if (!Buffer.isBuffer(body) || body.length === 0) return null;
    let offset = 0;
    const reader = {
        read(length = 1) {
            if (offset >= body.length) return null;
            const end = Math.min(offset + length, body.length);
            const chunk = body.slice(offset, end);
            offset = end;
            return chunk;
        }
    };
    const decoder = new amfjs.AMFDecoder(reader);
    return decoder.decode(amfjs.AMF0);
};

const previewValue = (value, limit = 900) => {
    const seen = new WeakSet();
    const text = JSON.stringify(value, (key, innerValue) => {
        if (typeof innerValue === 'object' && innerValue !== null) {
            if (seen.has(innerValue)) return '[Circular]';
            seen.add(innerValue);
        }
        if (Buffer.isBuffer(innerValue)) return `[Buffer ${innerValue.length}]`;
        return innerValue;
    });
    return text && text.length > limit ? `${text.slice(0, limit)}...` : text;
};

const buildAmfResponse = (version, responseUri, value, options = {}) => {
    let body;
    let usedAmfjs = !options.legacy;
    if (options.legacy) {
        body = options.amf3 ? amf0Amf3Value(value) : amf0Value(value);
    } else {
        try {
            body = amfjsBody(value, options.amf3);
        } catch (err) {
            log(`[AMFJS FALLBACK] ${err.message}`);
            usedAmfjs = false;
            body = options.amf3 ? amf0Amf3Value(value) : amf0Value(value);
        }
    }
    if (options.debugLabel) {
        log(`[AMF RESPONSE] ${options.debugLabel} amf=${options.amf3 ? 'AMF3' : 'AMF0'} encoder=${usedAmfjs ? 'amfjs' : 'legacy'} length=${body.length} hex=${body.slice(0, 32).toString('hex')}`);
    }
    const length = Buffer.alloc(4);
    length.writeInt32BE(body.length);
    const envelope = Buffer.alloc(4);
    envelope.writeUInt16BE(version || 0, 0);
    envelope.writeUInt16BE(0, 2);
    const messageCount = Buffer.alloc(2);
    messageCount.writeUInt16BE(1);
    const target = writeUtf(`${responseUri || '/1'}/onResult`);
    const response = writeUtf('');
    return Buffer.concat([envelope, messageCount, target, response, length, body]);
};

const REG_NEW_USER_FEMALE = 1;
const REG_NEW_USER_MALE = 2;
const REG_NEW_USER_UNISEX = 3;

const registerFlagForGender = (gender) => {
    if (gender === 'Female') return REG_NEW_USER_FEMALE;
    if (gender === 'Male') return REG_NEW_USER_MALE;
    return REG_NEW_USER_UNISEX;
};

const facePart = (className, idField, id, swf, colors = '', regNewUser = REG_NEW_USER_UNISEX) => typed(className, {
    SWF: swf,
    DiamondsPrice: 0,
    Name: '',
    Price: 0,
    Vip: 0,
    DragonBone: false,
    Discount: 0,
    isNew: 0,
    sortorder: id,
    RegNewUser: regNewUser,
    SkinId: 0,
    DefaultColors: colors,
    hidden: false,
    lastNewTagDate: null,
    [idField]: id
});

const cloth = (id, swf, filename, clothesCategoryId, gender, colors = '') => {
    const isFemale = gender === 'Female';
    const regNewUser = registerFlagForGender(gender);
    const swfName = path.basename(String(filename || swf || ''), '.swf');
    const slotType = typed(SLOT_TYPE_ALIAS, {
        SlotTypeId: clothesCategoryId,
        _SlotTypeId: clothesCategoryId
    });
    const clothesCategory = typed(CLOTHES_CATEGORY_ALIAS, {
        ClothesCategoryId: clothesCategoryId,
        _ClothesCategoryId: clothesCategoryId,
        SlotTypeId: clothesCategoryId,
        _SlotTypeId: clothesCategoryId,
        SlotType: slotType,
        _SlotType: slotType
    });
    const item = typed(CLOTH_ALIAS, {
        ClothId: id,
        ClothesId: id,
        Id: id,
        ClothesCategoryId: clothesCategoryId,
        _ClothesCategoryId: clothesCategoryId,
        SWF: swfName,
        _SWF: swfName,
        Filename: filename,
        _Filename: filename,
        Price: 0,
        _Price: 0,
        ShopId: 0,
        _ShopId: 0,
        SkinId: 0,
        _SkinId: 0,
        Scale: 1,
        _Scale: 1,
        Vip: false,
        _Vip: false,
        RegNewUser: regNewUser,
        _RegNewUser: regNewUser,
        sortorder: id,
        _sortorder: id,
        isNew: false,
        _isNew: false,
        Discount: 0,
        _Discount: 0,
        MouseAction: '',
        _MouseAction: '',
        DiamondsPrice: 0,
        _DiamondsPrice: 0,
        ColorScheme: colors,
        _ColorScheme: colors,
        Gender: regNewUser,
        _Gender: regNewUser,
        GenderName: gender,
        _GenderName: gender,
        IsFemale: isFemale,
        _IsFemale: isFemale,
        isFemale,
        ClothesCategory: clothesCategory,
        _ClothesCategory: clothesCategory,
        ThemeId: 0,
        _ThemeId: 0
    });

    return typed(ACTOR_CLOTHES_REL_ALIAS, {
        ActorClothesRelId: id,
        _ActorClothesRelId: id,
        ClothesId: id,
        _ClothesId: id,
        Color: colors,
        _Color: colors,
        IsWearing: true,
        _IsWearing: true,
        x: 0,
        _x: 0,
        y: 0,
        _y: 0,
        Cloth: item,
        _Cloth: item
    });
};

const withCollectionAliases = (data) => {
    Object.keys(data).forEach((key) => {
        data[`_${key}`] = data[key];
        data[key.charAt(0).toUpperCase() + key.slice(1)] = data[key];
    });
    return data;
};

const starterClothes = () => [
    cloth(1022, 'swf/hair', '2009_hair_girls_Honey_1.swf', 1, 'Female'),
    cloth(1021, 'swf/hair', '2009_hair_girls_Honey_2 (Japanese Buns).swf', 1, 'Female', '0xff9900,0x663366'),
    cloth(1005, 'swf/hair', '2009_hair_boys_Honey_3.swf', 1, 'Male', '0xcc0000,0xff6600,0xffff00'),
    cloth(1006, 'swf/hair', '2009_hair_boys_Honey_4.swf', 1, 'Male', '0x111111,0x666666'),
    cloth(1036, 'swf/tops', 'female_top_2009_1 (Nice Girl).swf', 2, 'Female', '0x666666,0xFF00CC'),
    cloth(1011, 'swf/tops', 'female_top_2009_2 (Stitches).swf', 2, 'Female', '0xff66cc,0x99ffcc,0x99ffcc,0xff66cc'),
    cloth(1057, 'swf/tops', 'honey_male_shirt_1.swf', 2, 'Male', '0x666666'),
    cloth(1055, 'swf/tops', 'Honey_Male_shirt_2.swf', 2, 'Male', '0x003300'),
    cloth(1054, 'swf/bottoms', 'female_bottoms_2009_1 (Loose Jeans).swf', 3, 'Female', '0x990099,0xffcc00,0xffff33'),
    cloth(1052, 'swf/bottoms', 'female_bottoms_2009_2 (Sparkles).swf', 3, 'Female', '0xff0066,0xfeffff'),
    cloth(1002, 'swf/bottoms', '2009_Honey_bottoms_1_boys (Soldier).swf', 3, 'Male'),
    cloth(1050, 'swf/bottoms', '2009_Honey_bottoms_3_boys.swf', 3, 'Male', '0x6666cc,0xffffff'),
    cloth(1028, 'swf/footwear', 'january_2011_shoes_female_1.swf', 10, 'Female', '0x6699cc,0x990000'),
    cloth(1029, 'swf/footwear', 'february_shoes_female_1.swf', 10, 'Female'),
    cloth(1128, 'swf/footwear', 'Fall_mens_shoes_1 (Classic Shoes).swf', 10, 'Male', '0x6699cc,0x990000'),
    cloth(1129, 'swf/footwear', 'Drakulashoes_1 (Gentleman_s Shoes).swf', 10, 'Male')
];

const starterClothesById = () => {
    const byId = new Map();
    starterClothes().forEach((rel) => byId.set(Number(rel.ClothesId || rel._ClothesId), rel));
    return byId;
};

const starterOutfit = (gender = 'Male') => {
    const ids = String(gender).toLowerCase() === 'female'
        ? [1022, 1036, 1054, 1028]
        : [1005, 1057, 1002, 1128];
    const byId = starterClothesById();
    return ids.map((id) => byId.get(id)).filter(Boolean);
};

const actorGender = (actor = {}) => {
    const explicit = actor.gender || actor.Gender || actor.genderName || actor.GenderName;
    if (explicit) return /female/i.test(String(explicit)) ? 'Female' : 'Male';
    const skin = String(actor.skinSWF || actor.SkinSWF || '').toLowerCase();
    return skin.includes('female') ? 'Female' : 'Male';
};

const clothItem = (rel) => rel && (rel.Cloth || rel._Cloth || rel);

const clothItems = (rels) => rels.map(clothItem).filter(Boolean);

const loginActorClothesRels = (gender = 'Male') => starterOutfit(gender).map((rel) => typed(ACTOR_CLOTHES_REL_ALIAS, {
    ActorClothesRelId: rel.ActorClothesRelId,
    _ActorClothesRelId: rel._ActorClothesRelId,
    ClothesId: rel.ClothesId,
    _ClothesId: rel._ClothesId,
    Color: rel.Color,
    _Color: rel._Color,
    IsWearing: rel.IsWearing,
    _IsWearing: rel._IsWearing,
    x: rel.x,
    _x: rel._x,
    y: rel.y,
    _y: rel._y
}));

const relSlot = (rel) => {
    const item = clothItem(rel);
    const category = item && (item.ClothesCategory || item._ClothesCategory);
    return Number(category && (category.SlotTypeId || category._SlotTypeId || category.ClothesCategoryId || category._ClothesCategoryId));
};

const relsBySlot = (rels, slot) => rels.filter((rel) => relSlot(rel) === slot);

const defaultRegisterActor = (gender, rels) => {
    const isFemale = gender === 'Female';
    const outfitIds = new Set(starterOutfit(gender).map((rel) => Number(rel.ClothesId || rel._ClothesId)));
    const actorRels = rels.filter((rel) => outfitIds.has(Number(rel.ClothesId || rel._ClothesId)));
    const skinSWF = isFemale ? 'femaleskin' : 'maleskin';
    const eyeId = isFemale ? 1 : 2;
    return typed(ACTOR_DETAILS_ALIAS, {
        ActorId: 0,
        _ActorId: 0,
        Name: '',
        _Name: '',
        Gender: gender,
        _Gender: gender,
        SkinSWF: skinSWF,
        _SkinSWF: skinSWF,
        SkinColor: '0xffd1b3',
        _SkinColor: '0xffd1b3',
        EyeId: eyeId,
        _EyeId: eyeId,
        NoseId: isFemale ? 5 : 4,
        _NoseId: isFemale ? 5 : 4,
        MouthId: isFemale ? 1 : 4,
        _MouthId: isFemale ? 1 : 4,
        EyeColors: isFemale ? '0x5b351c' : '0x3a6eb5',
        _EyeColors: isFemale ? '0x5b351c' : '0x3a6eb5',
        MouthColors: isFemale ? 'skincolor,0xd45a6a' : 'skincolor,0xb64254',
        _MouthColors: isFemale ? 'skincolor,0xd45a6a' : 'skincolor,0xb64254',
        ActorClothesRels: actorRels,
        _ActorClothesRels: actorRels,
        Clothes: clothItems(actorRels),
        _Clothes: clothItems(actorRels)
    });
};

const registerNewUserData = () => {
    const rels = starterClothes();
    const data = typed(REGISTER_NEW_USER_DATA_ALIAS, {
        eyes: [
            facePart('Eye', 'EyeId', 1, 'female_eyes_2', '0x5b351c'),
            facePart('Eye', 'EyeId', 2, 'male_eye1', '0x3a6eb5'),
            facePart('Eye', 'EyeId', 3, 'eyes_1', '0x5b351c')
        ],
        noses: [
            facePart('Nose', 'NoseId', 5, 'nose_5', '', REG_NEW_USER_FEMALE),
            facePart('Nose', 'NoseId', 4, 'nose_4', '', REG_NEW_USER_MALE),
            facePart('Nose', 'NoseId', 6, 'nose_6', '', REG_NEW_USER_FEMALE)
        ],
        mouths: [
            facePart('Mouth', 'MouthId', 1, 'female_mouth_1', 'skincolor,0xd45a6a', REG_NEW_USER_FEMALE),
            facePart('Mouth', 'MouthId', 2, 'female_mouth_2', 'skincolor,0xd45a6a', REG_NEW_USER_FEMALE),
            facePart('Mouth', 'MouthId', 4, 'male_mouth_1', 'skincolor,0xb64254', REG_NEW_USER_MALE)
        ],
        clothes: clothItems(rels),
        actorClothesRels: rels,
        maleActor: defaultRegisterActor('Male', rels),
        femaleActor: defaultRegisterActor('Female', rels),
        defaultMaleActor: defaultRegisterActor('Male', rels),
        defaultFemaleActor: defaultRegisterActor('Female', rels)
    });
    return withCollectionAliases(data);
};

const DEV_ACTOR_ID = 1;
const DEV_USERNAME = 'admin';
const DEV_PASSWORD = 'admin';

const actorDefaults = (actorRecord = {}) => {
    const actor = actorRecord || {};
    return {
    actorId: actor.actorId || actor.ActorId || DEV_ACTOR_ID,
    name: actor.name || actor.Name || DEV_USERNAME,
    level: actor.level || actor.Level || 1,
    money: actor.money || actor.Money || 0,
    diamonds: actor.diamonds || actor.Diamonds || 0,
    fame: actor.fame || actor.Fame || 0,
    fortune: actor.fortune || actor.Fortune || 0,
    gender: actorGender(actor),
    skinSWF: actor.skinSWF || actor.SkinSWF || 'maleskin',
    skinColor: actor.skinColor || actor.SkinColor || '0xffd1b3',
    eyeId: actor.eyeId || actor.EyeId || 2,
    noseId: actor.noseId || actor.NoseId || 1,
    mouthId: actor.mouthId || actor.MouthId || 1
};
};

const devActorDetails = (actorRecord = null, includeClothDetails = true) => {
    const actor = actorDefaults(actorRecord);
    const actorClothesRels = includeClothDetails ? starterOutfit(actor.gender) : loginActorClothesRels(actor.gender);
    return typed(ACTOR_DETAILS_ALIAS, {
    ActorId: actor.actorId,
    Name: actor.name,
    Level: actor.level,
    SkinSWF: actor.skinSWF,
    _SkinSWF: actor.skinSWF,
    SkinColor: actor.skinColor,
    NoseId: actor.noseId,
    EyeId: actor.eyeId,
    MouthId: actor.mouthId,
    Money: actor.money,
    EyeColors: '0x5b351c',
    MouthColors: '0xd45a6a',
    Fame: actor.fame,
    Fortune: actor.fortune,
    FriendCount: 0,
    ProfileText: 'Local admin/dev account',
    Moderator: 0,
    ProfileDisplays: 0,
    FavoriteMovie: '',
    FavoriteActor: '',
    FavoriteActress: '',
    FavoriteSinger: '',
    FavoriteSong: '',
    IsExtra: 0,
    HasUnreadMessages: 0,
    InvitedByActorId: 0,
    PollTaken: 1,
    ValueOfGiftsReceived: 0,
    ValueOfGiftsGiven: 0,
    NumberOfGiftsGiven: 0,
    NumberOfGiftsReceived: 0,
    NumberOfAutographsReceived: 0,
    NumberOfAutographsGiven: 0,
    FacebookId: '',
    BoyfriendId: 0,
    BoyfriendStatus: 0,
    BehaviourStatus: 0,
    LockedText: '',
    BadWordCount: 0,
    EmailValidated: 1,
    RetentionStatus: 0,
    GiftStatus: 0,
    MarketingNextStepLogins: 0,
    MarketingStep: 0,
    TotalVipDays: 9999,
    RecyclePoints: 0,
    EmailSettings: 0,
    TimeOfLastAutographGivenStr: '',
    BestFriendId: 0,
    BestFriendStatus: 0,
    FriendCountVIP: 0,
    ForceNameChange: 0,
    CreationRewardStep: 0,
    NameBeforeDeleted: '',
    LastTransactionId: 0,
    AllowCommunication: 1,
    Diamonds: actor.diamonds,
    PopUpStyleId: 0,
    BoyFriend: null,
    ActorClothesRels: actorClothesRels,
    _ActorClothesRels: actorClothesRels,
    ActorClothesRels2: actorClothesRels,
    _ActorClothesRels2: actorClothesRels,
    Animations: [{
        ActorAnimationRelId: 1,
        AnimationId: 1,
        SWF: 'swf/animationtest.swf',
        Name: 'stand',
        InitialAnimation: 'stand'
    }],
    ActorPersonalInfo: typed(ACTOR_PERSONAL_INFO_ALIAS, {
        ActorId: actor.actorId,
        ParentEmail: '',
        ChatAllowed: 1,
        ActorEmailAllowed: 1,
        BirthMonth: 1,
        BirthYear: 2000,
        ParentConsentEmailSent: false,
        UserEmailParentOptOut: false,
        ParentEmailConfirmed: true,
        RealBirthdayCollected: true,
        YoutubeAllowed: true
    }),
    ActorRelationships: []
});
};

const makePostLoginSequence = (className) => typed(className, {
    ShowCampaign: false,
    ShowVipRebuy: false
});

const postLoginSequence = () => makePostLoginSequence('com.moviestarplanet.valueObjects.PostLoginSequenceDomain');
const servicePostLoginSequence = () => ({
    ShowCampaign: false,
    ShowVipRebuy: false,
    ShowFameLevelConvert: false,
    DailyBonusType: 0,
    AnchorFriendshipAccepted: false,
    AnchorGiftsGiven: 0,
    Features: [],
    SpecialOffer: null
});

const loginActorPersonalInfo = () => typed(ACTOR_PERSONAL_INFO_ALIAS, {
    ActorId: DEV_ACTOR_ID,
    BirthDate: null,
    ParentEmail: '',
    ChatAllowed: 1,
    ActorEmailAllowed: 1,
    BirthMonth: 1,
    BirthYear: 2000,
    ParentConsentEmailSent: false,
    UserEmailParentOptOut: false,
    ParentEmailConfirmed: true,
    RealBirthdayCollected: true,
    YoutubeAllowed: true
});

const loginActorDetails = (actorRecord = null) => {
    const actor = actorDefaults(actorRecord);
    return typed(ACTOR_DETAILS_ALIAS, {
    ActorId: actor.actorId,
    Name: actor.name,
    Level: actor.level,
    SkinSWF: actor.skinSWF,
    _SkinSWF: actor.skinSWF,
    SkinColor: actor.skinColor,
    NoseId: actor.noseId,
    EyeId: actor.eyeId,
    MouthId: actor.mouthId,
    Money: actor.money,
    EyeColors: '0x5b351c',
    MouthColors: '0xd45a6a',
    Fame: actor.fame,
    Fortune: actor.fortune,
    FriendCount: 0,
    ProfileText: 'Local admin/dev account',
    Created: new Date(),
    LastLogin: new Date(),
    Moderator: 0,
    ProfileDisplays: 0,
    FavoriteMovie: '',
    FavoriteActor: '',
    FavoriteActress: '',
    FavoriteSinger: '',
    FavoriteSong: '',
    IsExtra: 0,
    HasUnreadMessages: 0,
    InvitedByActorId: 0,
    PollTaken: 1,
    ValueOfGiftsReceived: 0,
    ValueOfGiftsGiven: 0,
    NumberOfGiftsGiven: 0,
    NumberOfGiftsReceived: 0,
    NumberOfAutographsReceived: 0,
    NumberOfAutographsGiven: 0,
    TimeOfLastAutographGiven: null,
    FacebookId: '',
    MembershipPurchasedDate: new Date(),
    MembershipTimeoutDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
    MembershipGiftRecievedDate: null,
    BehaviourStatus: 0,
    LockedUntil: null,
    LockedText: '',
    BadWordCount: 0,
    PurchaseTimeoutDate: null,
    EmailValidated: 1,
    RetentionStatus: 0,
    GiftStatus: 0,
    MarketingNextStepLogins: 0,
    MarketingStep: 0,
    TotalVipDays: 0,
    RecyclePoints: 0,
    EmailSettings: 0,
    TimeOfLastAutographGivenStr: '',
    BestFriendId: 0,
    BestFriendStatus: 0,
    FriendCountVIP: 0,
    ForceNameChange: 0,
    CreationRewardStep: 0,
    CreationRewardLastAwardDate: null,
    NameBeforeDeleted: '',
    LastTransactionId: 0,
    AllowCommunication: 1,
    Diamonds: actor.diamonds,
    PopUpStyleId: 0,
    VipTier: 0,
    EyeShadowId: 0,
    EyeShadowColors: '',
    BoyFriend: null,
    ActorPersonalInfo: loginActorPersonalInfo(),
    ActorRelationships: [],
    ActorStatus: typed(ACTOR_STATUS_ALIAS, {
        ActorId: actor.actorId,
        SoundMute: false,
        CampaignViewed: 0,
        MobileStartAward: 0,
        FameLevelConvert: false,
        NotificationActive: false,
        PhotoShareRulesAccepted: true,
        ArtbookShareRulesAccepted: true,
        LogOutWhenClickingExternalAppLinkAccepted: true,
        AnchorFriendshipAccepted: false,
        AnchorGiftsGiven: 0,
        ThirdPartyCreation: false,
        PreviousLoginDate: new Date()
    }),
    CombatCategorisation: typed(COMBAT_CATEGORISATION_ALIAS, {
        ActorId: actor.actorId,
        Category: '',
        Level: 0,
        DurationMinutes: 0,
        CombatAction: 0,
        CombatModerator: 0,
        DateCreated: null,
        DateProcessed: null
    }),
    RoomLikes: 0
});
};

const makeLoginStatus = (className, postLoginSeq = postLoginSequence(), actorRecord = null) => typed(className, {
    status: 'Success',
    actor: loginActorDetails(actorRecord),
    statusDetails: '',
    actorLocale: [],
    lbs: [],
    userType: 'Approved',
    adCountryMap: [],
    postLoginSeq,
    previousLastLogin: '',
    version: '20161102_160430',
    userIp: 2130706433,
    ticket: 'local-admin-ticket',
    piggyBank: null,
    purchaseTypeId: 0
});

const loginStatus = (actorRecord = null) => makeLoginStatus('com.moviestarplanet.valueObjects.LoginStatus', postLoginSequence(), actorRecord);
const serviceLoginStatus = (actorRecord = null) => {
    const status = makeLoginStatus('com.moviestarplanet.services.userservice.valueObjects.LoginStatus', null, actorRecord);
    status.mutedUntil = null;
    status.helpMessage = '';
    status.amsHash = '';
    return status;
};

const webLoginStatus = (actorRecord = null) => loginStatus2(actorRecord, true);

const loginHash = (status) => {
    const actor = status.actor || {};
    const values = [
        status.status,
        actor.ActorId,
        actor.Moderator,
        actor.Money,
        actor.Diamonds,
        actor.Fame,
        actor.Level
    ].map((value) => value === undefined || value === null ? '' : String(value));
    log(`[LOGIN HASH VALUES] ${values.join('|')}`);
    const hash = crypto.createHash('md5').update(`idu!2*;d${values.join('')}`, 'utf8').digest('hex');
    log(`[LOGIN HASH] ${hash}`);
    return hash;
};

const loginStatus2 = (actorRecord = null, useServiceTypes = false) => {
    const status = useServiceTypes ? serviceLoginStatus(actorRecord) : loginStatus(actorRecord);
    const hash = loginHash(status);
    const hDetails = crypto.createHash('md5').update(`wiurh2i${status.actor.ActorId}`, 'utf8').digest('hex');
    const payload = {
        loginStatus: status,
        hDetails,
        hash
    };
    return typed(useServiceTypes ? 'com.moviestarplanet.services.userservice.valueObjects.LoginStatus2' : 'com.moviestarplanet.valueObjects.LoginStatus2', payload);
};

const invalidLoginStatus2 = (useServiceTypes = false) => {
    const status = useServiceTypes ? serviceLoginStatus() : loginStatus();
    status.status = 'InvalidCredentials';
    status.statusDetails = '';
    status.actor = null;
    status.actorLocale = [];
    status.lbs = [];
    status.ticket = '';
    const payload = {
        loginStatus: status,
        hDetails: '',
        hash: ''
    };
    return typed(useServiceTypes ? 'com.moviestarplanet.services.userservice.valueObjects.LoginStatus2' : 'com.moviestarplanet.valueObjects.LoginStatus2', payload);
};

const invalidLoginStatus = () => {
    const status = loginStatus();
    status.status = 'InvalidCredentials';
    status.statusDetails = '';
    return status;
};

const createNewUserStatus = (actorRecord = null) => {
    const actor = actorDefaults(actorRecord);
    return typed(CREATE_NEW_USER_STATUS_ALIAS, {
        actor: devActorDetails(actorRecord, false),
        hDetails: crypto.createHash('md5').update(`wiurh2i${actor.actorId}`, 'utf8').digest('hex'),
        adCountryMap: [],
        ticket: `local-${actor.name}-ticket${crypto.randomBytes(8).toString('hex')}`,
        amsHash: '',
        features: []
    });
};

const createNewUserError = (actorId = -2) => typed(CREATE_NEW_USER_STATUS_ALIAS, {
    actor: typed(ACTOR_DETAILS_ALIAS, { ActorId: actorId }),
    hDetails: '',
    adCountryMap: [],
    ticket: '',
    amsHash: '',
    features: []
});

const APP_SETTING_ALIAS = 'MovieStarPlanet.WebService.User.UserService+AppSetting';
const appSettingDefaults = {
    SuperVIPDisabled: 'false',
    ImageUpload: 'true',
    ImageUploadLevelRequired: '0',
    ImageUploadAgeRestriction: '0',
    TextSearchMinLength: '1',
    SeasonalSale: 'false',
    XmppUseLocalhost: 'true',
    ReleaseVersion: '2010123_95850',
    BooniePlanetURL: '',
    RoboBlastPlanetURL: '',
    ExternalAppLinksLevelRequired: '999',
    MessageServiceELB: 'false',
    SendMessagesToCassandraDatabase: 'false',
    XmppConferenceServerUrl: '',
    UseOldMessagesList: 'true',
    usejsonc: 'false',
    SchoolFriendsSwitchEnabled: 'false',
    MySchoolFirstNameEnabled: 'false',
    EcoSystemUrl: '',
    EcosystemUrl: '',
    XmppServerUrl: '',
    XMPPFeatureState: 'false',
    specialinputtextchars: '',
    AllowedNonFriendCommunication: 'true',
    showoffercountdown: 'false',
    youtubeapikey: '',
    MessageServerUrl: '',
    vipsale: 'false',
    DeviceFingerprintCollectionEnabled: 'false',
    MangroveAnalyticsSwitch: 'false',
    MangroveAnalyticsCollectorURL: '',
    MangroveAnalyticsBufferSize: '5',
    MangroveAnalyticsDisabledEvents: '',
    MangroveAnalyticsDisableBase64: 'true',
    MangroveAnalyticsFeatureUsageMinTime: '0',
    HelpCenterLink: 'http://127.0.0.1/',
    SafetyHelplineLink: 'http://127.0.0.1/',
    SafetyRulesLink: 'http://127.0.0.1/',
    ModerationCheckUpdateTimerSeconds: '300',
    enableClientExceptionLogging: 'false',
    giftcertificateenabled: 'false',
    EnableSpecialOffers: 'false',
    PhotoUploadOnWeb: 'false',
    mobileversion_amazonstore: '',
    mobileversion_googleplay: '',
    mobileversion_appstore: '',
    YoutubeKindle: 'false',
    YoutubeIos: 'false',
    YoutubeAndroid: 'false',
    clientidletimeout: '3600',
    ServerType: 'local',
    MaxConcurrentLoads: '10',
    MaxConcurrentAmfCalls: '10',
    SnapshotServerUrl: '',
    SnapshotServiceHostName: '',
    PerformanceTracker: 'false',
    UseRemoting: 'true',
    SwrveEnabled: 'false',
    UseUserBehaviorService: 'false',
    UseUserNameFiltering: 'false',
    UserBehaviorServiceHostName: '',
    chatFMSServer: '',
    chatGameFMSServer: '',
    CommFMSServer: '',
    BlobServiceHostName: '',
    PurchaseFlow: 'local',
    ShowSIDLogo: 'true',
    ShowCEOPLogo: 'true',
    showwebshoplink: 'false',
    MalesMustWearTops: 'false',
    ChristmasStartDate: '',
    arcadegamesurl: '',
    testFMSServer: ''
};

const appSettingValue = (name) => Object.prototype.hasOwnProperty.call(appSettingDefaults, name) ? appSettingDefaults[name] : '';
const appSetting = (name) => typed(APP_SETTING_ALIAS, {
    name,
    value: String(appSettingValue(name))
});
const appSettingsForKeys = (keys = []) => {
    const requested = Array.isArray(keys) && keys.length > 0 ? keys : Object.keys(appSettingDefaults);
    return requested.map((name) => appSetting(String(name)));
};

const createAccountFromArgs = async (args = []) => {
    const { username, password } = credentialsFromArgs(args);
    const cleanUsername = String(username || '').trim();

    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(cleanUsername)) {
        return createNewUserError(-1);
    }
    if (findUserByName(cleanUsername)) {
        return createNewUserError(-2);
    }

    const actorId = nextActorId();
    const actor = actorFromCreateArgs(args, actorId, cleanUsername);
    const user = {
        id: actorId,
        username: cleanUsername,
        passwordHash: hashPassword(password),
        actorId,
        role: 'player',
        createdAt: actor.createdAt
    };

    db.users.push(user);
    db.actors.push(actor);
    db.inventory[String(actorId)] = starterOutfit(actorGender(actor));
    await saveDb();
    log(`[ACCOUNT] created username=${cleanUsername} actorId=${actorId} source=${dbSource}`);
    return createNewUserStatus(actor);
};

const actorForLoginArgs = (args = []) => {
    const { username, password } = credentialsFromArgs(args);
    const user = findUserByName(username);
    let actor = null;

    if (user && passwordMatches(user, password)) {
        actor = findActorById(user.actorId) || null;
        log(`[LOGIN AUTH] username=${username || ''} matched user actorId=${user.actorId} actor=${actor ? 'found' : 'missing-in-actors'}`);
    } else {
        log(`[LOGIN AUTH] username=${username || ''} FAILED user=${user ? 'found-but-wrong-password' : 'not-found'}`);
    }
    return actor;
};

const relativePublicPath = (filePath) => path.relative(publicPath, filePath).replace(/\\/g, '/');

const walkFiles = (dir, predicate, limit = 1000, result = []) => {
    if (result.length >= limit || !fs.existsSync(dir)) return result;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (result.length >= limit) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFiles(fullPath, predicate, limit, result);
        } else if (!predicate || predicate(fullPath)) {
            result.push(fullPath);
        }
    }
    return result;
};

const inferClothSlotType = (filename) => {
    const name = filename.toLowerCase();
    if (name.includes('hair')) return 2;
    if (name.includes('top') || name.includes('shirt') || name.includes('dress')) return 3;
    if (name.includes('bottom') || name.includes('pants') || name.includes('skirt')) return 4;
    if (name.includes('shoe') || name.includes('boot')) return 5;
    if (name.includes('acc') || name.includes('hat') || name.includes('glasses')) return 6;
    return 3;
};

const inferGender = (filename) => {
    const name = filename.toLowerCase();
    if (name.includes('female') || name.includes('girl') || name.includes('_fj') || name.includes('fem')) return 'Female';
    if (name.includes('male') || name.includes('boy') || name.includes('_mj') || name.includes('_mf')) return 'Male';
    return 'Unisex';
};

const hashPassword = (password) => crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('hex');

const buildClothesCatalog = () => {
    const stuffDir = path.join(publicPath, 'swf', 'stuff');
    return walkFiles(stuffDir, (filePath) => filePath.toLowerCase().endsWith('.swf'), 800)
        .map((filePath, index) => {
            const filename = path.basename(filePath);
            return {
                id: 100000 + index + 1,
                swf: relativePublicPath(filePath),
                filename,
                slotTypeId: inferClothSlotType(filename),
                gender: inferGender(filename),
                colors: '0xffffff,0x222222'
            };
        });
};

const starterCatalogItems = () => clothItems(starterClothes()).map((item) => ({
    id: Number(item.ClothesId || item.ClothId || item.Id),
    swf: `swf/${categoryFolderForSlot(Number(item.ClothesCategoryId || item._ClothesCategoryId))}`,
    filename: item.Filename || item._Filename,
    slotTypeId: Number(item.ClothesCategoryId || item._ClothesCategoryId),
    gender: item.GenderName || item._GenderName || (Number(item.Gender || item._Gender) === REG_NEW_USER_FEMALE ? 'Female' : 'Male'),
    colors: item.ColorScheme || item._ColorScheme || ''
}));

const categoryFolderForSlot = (slotTypeId) => {
    if (slotTypeId === 1) return 'hair';
    if (slotTypeId === 2) return 'tops';
    if (slotTypeId === 3) return 'bottoms';
    if (slotTypeId === 10) return 'footwear';
    return 'stuff';
};

const shouldReplaceStarterData = (state) => {
    const catalog = state && state.catalog && Array.isArray(state.catalog.clothes) ? state.catalog.clothes : [];
    if (catalog.length !== starterClothes().length) return true;
    return JSON.stringify(catalog.map((item) => item && item.filename).filter(Boolean).sort())
        !== JSON.stringify(starterCatalogItems().map((item) => item.filename).sort());
};

const migrateStarterData = (state) => {
    const next = state;
    next.catalog = next.catalog || {};
    if (shouldReplaceStarterData(next)) {
        next.catalog.clothes = starterCatalogItems();
    }
    next.inventory = next.inventory || {};
    (next.actors || []).forEach((actor) => {
        next.inventory[String(actor.actorId || actor.ActorId)] = starterOutfit(actorGender(actor));
    });
    return next;
};

const defaultDb = () => ({
    version: 1,
    createdAt: new Date().toISOString(),
    users: [{
        id: 1,
        username: DEV_USERNAME,
        passwordHash: hashPassword(DEV_PASSWORD),
        actorId: DEV_ACTOR_ID,
        role: 'admin'
    }],
    actors: [{
        actorId: DEV_ACTOR_ID,
        name: DEV_USERNAME,
        level: 10,
        money: 50000,
        diamonds: 500,
        fame: 10000,
        fortune: 10000
    }],
    catalog: {
        clothes: starterCatalogItems()
    },
    inventory: {
        [DEV_ACTOR_ID]: []
    },
    looks: [],
    movies: [],
    friends: [],
    messages: [],
    wallPosts: [],
    transactions: []
});

const ensureDbShape = (state) => {
    const next = state && typeof state === 'object' ? state : defaultDb();
    next.catalog = next.catalog || {};
    if (!Array.isArray(next.catalog.clothes) || next.catalog.clothes.length === 0) {
        next.catalog.clothes = starterCatalogItems();
    }
    next.users = Array.isArray(next.users) ? next.users : defaultDb().users;
    next.actors = Array.isArray(next.actors) ? next.actors : defaultDb().actors;
    next.inventory = next.inventory || { [DEV_ACTOR_ID]: [] };
    next.looks = Array.isArray(next.looks) ? next.looks : [];
    next.movies = Array.isArray(next.movies) ? next.movies : [];
    next.friends = Array.isArray(next.friends) ? next.friends : [];
    next.messages = Array.isArray(next.messages) ? next.messages : [];
    next.wallPosts = Array.isArray(next.wallPosts) ? next.wallPosts : [];
    next.transactions = Array.isArray(next.transactions) ? next.transactions : [];
    // Migracja: zamien plaintext password na passwordHash
    next.users = next.users.map((user) => {
        if (!user.passwordHash && user.password) {
            return Object.assign({}, user, { passwordHash: hashPassword(user.password), password: undefined });
        }
        return user;
    });
    return migrateStarterData(next);
};

const loadJsonDb = () => {
    try {
        if (fs.existsSync(dbPath)) {
            const existing = ensureDbShape(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
            fs.writeFileSync(dbPath, JSON.stringify(existing, null, 2));
            return existing;
        }
    } catch (err) {
        log(`[DB] Nie udalo sie wczytac bazy, tworze nowa: ${err.message}`);
    }
    const created = defaultDb();
    fs.writeFileSync(dbPath, JSON.stringify(created, null, 2));
    log(`[DB] Utworzono lokalna baze: ${dbPath} (${created.catalog.clothes.length} ubran)`);
    return created;
};

const loadMongoDb = async () => {
    if (!mongoUri) {
        log('[DB] MONGODB_URI nie ustawione, uzywam msp-db.json');
        return null;
    }

    try {
        mongoClient = new MongoClient(mongoUri, {
            serverSelectionTimeoutMS: 8000
        });
        await mongoClient.connect();
        mongoDatabase = mongoClient.db(mongoDbName);
        const collection = mongoDatabase.collection(mongoStateCollection);
        let document = await collection.findOne({ _id: 'main' });

        if (!document) {
            // Pierwsza inicjalizacja — zapisz domyslna baze
            const seed = defaultDb();
            // Upewnij sie ze dev user ma passwordHash
            if (seed.users && seed.users.length > 0 && !seed.users[0].passwordHash) {
                seed.users[0].passwordHash = hashPassword(seed.users[0].password || DEV_PASSWORD);
                delete seed.users[0].password;
            }
            document = Object.assign({ _id: 'main' }, seed);
            await collection.insertOne(document);
            log(`[DB] Utworzono baze MongoDB: ${mongoDbName}.${mongoStateCollection}`);
        }

        const { _id, ...storedState } = document;
        // Upewnij sie ze catalog.clothes istnieje (nie nadpisuj uzytkownikow!)
        if (!storedState.catalog || !Array.isArray(storedState.catalog.clothes) || storedState.catalog.clothes.length === 0) {
            storedState.catalog = { clothes: buildClothesCatalog() };
            await collection.updateOne({ _id: 'main' }, { $set: { catalog: storedState.catalog } }, { upsert: true });
        }
        const state = ensureDbShape(storedState);
        await collection.updateOne({ _id: 'main' }, {
            $set: {
                catalog: state.catalog,
                inventory: state.inventory
            }
        }, { upsert: true });
        dbSource = 'mongodb';
        log(`[DB] Polaczono z MongoDB: ${mongoDbName}.${mongoStateCollection} users=${state.users.length} actors=${state.actors.length} ubran=${state.catalog.clothes.length}`);
        return state;
    } catch (err) {
        dbSource = 'json';
        log(`[DB] MongoDB niedostepne (${err.message}), uzywam msp-db.json`);
        if (mongoClient) {
            await mongoClient.close().catch(() => {});
        }
        mongoClient = null;
        mongoDatabase = null;
        return null;
    }
};

const loadDb = async () => {
    if (useRemoteGateway) {
        dbSource = 'remote';
        log(`[DB] Uzywam zdalnej bramy: ${remoteGatewayUrl}`);
        return loadJsonDb();
    }
    const mongoState = await loadMongoDb();
    if (mongoState) return mongoState;
    return loadJsonDb();
};

let db = defaultDb();

const saveDb = async () => {
    db = ensureDbShape(db);
    if (mongoClient && mongoDatabase) {
        // Zapisujemy tylko dane ktore sie zmieniaja — nie catalog (za duzy, niezmienny)
        const toSave = {
            version: db.version,
            users: db.users,
            actors: db.actors,
            inventory: db.inventory,
            looks: db.looks,
            movies: db.movies,
            friends: db.friends,
            messages: db.messages,
            wallPosts: db.wallPosts,
            transactions: db.transactions
        };
        await mongoDatabase.collection(mongoStateCollection).updateOne(
            { _id: 'main' },
            { $set: toSave },
            { upsert: true }
        );
        return;
    }
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
};

const isDevCredentials = (requestBody) => {
    const text = Buffer.isBuffer(requestBody) ? requestBody.toString('utf8').toLowerCase() : '';
    return text.includes(DEV_USERNAME) || text.includes(DEV_PASSWORD);
};

const methodLeaf = (method) => String(method || '').split('.').pop();

const collectStrings = (value, output = []) => {
    if (typeof value === 'string') {
        output.push(value);
    } else if (Array.isArray(value)) {
        value.forEach((item) => collectStrings(item, output));
    } else if (value && typeof value === 'object') {
        Object.keys(value).forEach((key) => {
            if (key !== '__class' && key !== 'Ticket') {
                collectStrings(value[key], output);
            }
        });
    }
    return output;
};

const usefulCredentialStrings = (args = []) => collectStrings(args)
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 3 && value.length <= 32)
    .filter((value) => !/^0x[0-9a-f]+$/i.test(value))
    .filter((value) => !/^(http|swf\/|img\/|lookdata_|mockhash_|en_|pl_|de_|fr_|nl_)/i.test(value))
    .filter((value) => !/[\\/:]/.test(value));

const credentialsFromArgs = (args = []) => {
    if (typeof args[0] === 'string' && typeof args[1] === 'string') {
        return { username: args[0].trim(), password: args[1] };
    }
    if (args[0] && typeof args[0] === 'object') {
        const newActor = args[0];
        if (newActor.ChosenActorName || newActor.ChosenPassword) {
            return {
                username: String(newActor.ChosenActorName || '').trim(),
                password: String(newActor.ChosenPassword || '')
            };
        }
    }
    const strings = usefulCredentialStrings(args);
    return {
        username: strings[0] || `player${Date.now()}`,
        password: strings[1] || crypto.randomBytes(8).toString('hex')
    };
};

const actorFromCreateArgs = (args = [], actorId, name) => {
    const newActor = args[0] && typeof args[0] === 'object' ? args[0] : {};
    const isMale = newActor.SkinIsMale !== false;
    return {
        actorId,
        name,
        level: 1,
        money: 5000,
        diamonds: 100,
        fame: 0,
        fortune: 0,
        skinSWF: isMale ? 'maleskin' : 'femaleskin',
        skinColor: newActor.SkinColor || '0xffd1b3',
        eyeId: Number(newActor.EyeId) || 2,
        eyeColors: newActor.EyeColors || '0x5b351c',
        noseId: Number(newActor.NoseId) || (isMale ? 4 : 5),
        mouthId: Number(newActor.MouthId) || 1,
        mouthColors: newActor.MouthColors || '0xd45a6a',
        createdAt: new Date().toISOString()
    };
};

const findUserByName = (username) => {
    const wanted = String(username || '').toLowerCase();
    return (db.users || []).find((user) => String(user.username || '').toLowerCase() === wanted) || null;
};

const findActorById = (actorId) => {
    return (db.actors || []).find((actor) => Number(actor.actorId) === Number(actorId)) || null;
};

const passwordMatches = (user, password) => {
    if (!user) return false;
    if (user.passwordHash) return user.passwordHash === hashPassword(password);
    return user.password === password;
};

const nextActorId = () => Math.max(DEV_ACTOR_ID, ...(db.actors || []).map((actor) => Number(actor.actorId) || 0)) + 1;

const okResult = (data = null) => ({
    Success: true,
    success: true,
    Status: 0,
    status: 0,
    Message: '',
    message: '',
    Data: data,
    data
});

const emptyPagedList = () => ({
    TotalRecords: 0,
    totalRecords: 0,
    PageIndex: 0,
    pageIndex: 0,
    PageSize: 50,
    pageSize: 50,
    Items: [],
    items: [],
    list: [],
    Result: [],
    result: []
});

const catalogClothes = (limit = 200) => db.catalog.clothes.slice(0, limit).map((item) => (
    cloth(item.id, item.swf, item.filename, item.slotTypeId, item.gender, item.colors)
));

const profileSummary = () => typed('com.moviestarplanet.profile.valueObjects.ProfileSummary', {
    ActorId: DEV_ACTOR_ID,
    Name: DEV_USERNAME,
    Level: 101,
    Fame: 999999999,
    Fortune: 999999999,
    Money: 999999999,
    Diamonds: 999999999,
    ProfileText: 'Local admin/dev account',
    FriendCount: 0,
    Clothes: catalogClothes(12),
    Looks: [],
    Movies: [],
    Pets: [],
    WallPosts: []
});

const lookDataPayload = () => Buffer.from(JSON.stringify({
    actorId: DEV_ACTOR_ID,
    actorName: DEV_USERNAME,
    skinSWF: 'maleskin',
    skinColor: '0xffd1b3',
    eyeId: 2,
    noseId: 1,
    mouthId: 1,
    eyeColors: '0x5b351c',
    mouthColors: '0xd45a6a',
    clothes: starterOutfit('Male').map((item) => item.Cloth ? {
        clothesId: item.ClothesId,
        swf: item.Cloth.SWF,
        color: item.Color
    } : item),
    animation: 'stand'
}), 'utf8');

const randomFrontpageLook = () => {
    const clothes = starterOutfit('Male');
    const actor = devActorDetails();
    actor.ActorClothesRels = clothes;
    actor._ActorClothesRels = clothes;
    actor.ActorClothesRels2 = clothes;
    actor._ActorClothesRels2 = clothes;
    actor.initialAnimation = 'stand';
    actor.InitialAnimation = 'stand';
    actor.AnimationId = 1;
    actor.AnimationSWF = 'swf/animationtest.swf';
    return typed('com.moviestarplanet.look.valueobjects.LookItem', {
        LookId: 1,
        ActorId: DEV_ACTOR_ID,
        actorName: DEV_USERNAME,
        CreatorId: DEV_ACTOR_ID,
        creatorName: DEV_USERNAME,
        Created: new Date(),
        Headline: 'Local animated admin',
        LookData: lookDataPayload(),
        lookData: 'lookdata_000_000_000_001',
        LookDataUrl: 'lookdata_000_000_000_001',
        lookDataUrl: 'lookdata_000_000_000_001',
        Url: 'lookdata_000_000_000_001',
        url: 'lookdata_000_000_000_001',
        Likes: Math.floor(Math.random() * 9000) + 1000,
        Sells: 0,
        LookActorLikes: [],
        Actor: actor,
        actor,
        ActorDetails: actor,
        actorDetails: actor,
        ActorClothesRels: clothes,
        actorClothesRels: clothes,
        lookActorClothesRels: clothes,
        SkinSWF: actor.SkinSWF,
        SkinColor: actor.SkinColor,
        AnimationId: 1,
        AnimationSWF: 'swf/animationtest.swf',
        initialAnimation: 'stand'
    });
};

const postLoginState = () => typed('com.moviestarplanet.commonvalueobjects.login.PostLoginData', {
    ActorDetails: devActorDetails(),
    actorDetails: devActorDetails(),
    ProfileSummary: profileSummary(),
    profileSummary: profileSummary(),
    Friends: [],
    friends: [],
    Messages: [],
    messages: [],
    Notifications: [],
    notifications: [],
    News: [],
    news: [],
    Quests: [],
    quests: [],
    Gifts: [],
    gifts: [],
    Campaigns: [],
    campaigns: [],
    ServerTime: new Date(),
    serverTime: new Date()
});

const looksList = () => [randomFrontpageLook()];

const shouldReturnPagedList = (leaf) => /Paged|Page|Highscore|Browser|Search|List/i.test(leaf);

const genericReadResult = (method, leaf) => {
    const key = `${method}.${leaf}`;
    if (/ActorDetails|ActorDetail/i.test(leaf)) return devActorDetails();
    if (/ActorPersonalInfo|PersonalInfo/i.test(leaf)) return devActorDetails().ActorPersonalInfo;
    if (/ProfileSummary|Profile/i.test(key)) return profileSummary();
    if (/LoadState|PostLogin|OfflineTodo|Todo/i.test(leaf)) return postLoginState();
    if (/ActorIdFromName/i.test(leaf)) return DEV_ACTOR_ID;
    if (/ActorNameFromId|Username/i.test(leaf)) return DEV_USERNAME;
    if (/Locale/i.test(leaf)) return 'en_US';
    if (/Look/i.test(key)) return looksList();
    if (/Shop|Cloth|Clothes|Spending|Inventory|Wardrobe|BeautyClinic|GiftableItems|ContextClothes/i.test(key)) {
        const clothes = catalogClothes(250);
        return shouldReturnPagedList(leaf) ? Object.assign(emptyPagedList(), { Items: clothes, items: clothes, list: clothes, Result: clothes }) : clothes;
    }
    if (/Payment|Transaction|Price|Vip|Diamond|StarCoin|Money/i.test(key)) return [];
    if (/Friend|Invitation|Block|Blocked|Blocking/i.test(key)) return [];
    if (/Message|Mail|Chat|Conversation/i.test(key)) return [];
    if (/Movie|News|Forum|Club|Quest|Gift|Pet|PetPet|Boonie|Room|Highscore|Autograph|Status|Notification|Campaign|Poll/i.test(key)) {
        return shouldReturnPagedList(leaf) ? emptyPagedList() : [];
    }
    return shouldReturnPagedList(leaf) ? emptyPagedList() : [];
};

const genericWriteResult = (method, leaf) => {
    const key = `${method}.${leaf}`;
    if (/Buy|Purchase|Spend/i.test(key)) return okResult(devActorDetails());
    if (/Award|Give|Claim|Redeem|Reward/i.test(key)) return okResult(devActorDetails());
    if (/SaveLook/i.test(leaf)) return okResult(looksList()[0]);
    return okResult();
};

const shouldUseAmf3 = (method, result) => {
    if (method.endsWith('Login')) return true;
    if (method.endsWith('Login2')) return false;
    if (method.endsWith('GetAppSettings')) return true;
    if (result && typeof result === 'object' && result.__class) return true;
    return /Login|LoadDataForRegisterNewUser|LoadActorDetails|UserSession|UserService|MovieStar|Shopping|Shop|Spending|Profile|Friend|Movie|Look|News|Quest|Gift|Admin|Payment|Messaging|Room|Inventory|Wardrobe|Logging/i.test(method);
};

const getAmfResultForMethod = async (method, args = []) => {
    const leaf = methodLeaf(method);
    if (method.endsWith('GetAppSettings')) {
        const requestedKeys = Array.isArray(args[1]) ? args[1] : (Array.isArray(args[0]) ? args[0] : []);
        return appSettingsForKeys(requestedKeys);
    }
    if (method.endsWith('GetAppSetting')) {
        const name = args.find((arg) => typeof arg === 'string') || '';
        return String(appSettingValue(name));
    }
    if (method.endsWith('GetActorCount') || method.endsWith('GetOnlineCount') || method.endsWith('GetOnlineUserCount') || method.endsWith('GetNumberOfOnlineUsers')) {
        return Array.isArray(db.users) ? db.users.length : 1;
    }
    if (method.endsWith('GetMovieCount')) {
        return Array.isArray(db.movies) ? db.movies.length : 0;
    }
    if (method.endsWith('GetCurrentPaymentPossibilities')) {
        return [];
    }
    if (method.endsWith('ClientLog') || method.endsWith('LogClient')) {
        log(`[CLIENT LOG] ${method}`);
        return true;
    }
    if (method.endsWith('CreateTestException')) {
        return true;
    }
    if (method.endsWith('GetLatestServerException')) {
        return {
            Version: '20161102_160430',
            Exception: ''
        };
    }
    if (method.endsWith('GetRandomLookByLikes')) {
        return looksList()[0];
    }
    if (method.endsWith('Login2')) {
        const actor = actorForLoginArgs(args);
        return actor ? loginStatus2(actor, true) : invalidLoginStatus2(true);
    }
    if (method.endsWith('Login')) {
        const actor = actorForLoginArgs(args);
        return actor ? webLoginStatus(actor) : invalidLoginStatus2(true);
    }
    if (method.endsWith('CreateNewUser') || method.endsWith('CreateNewUserOld')) {
        return createAccountFromArgs(args);
    }
    if (method.endsWith('LoadActorDetails') || method.endsWith('LoadActorDetails2') || method.endsWith('LoadActorDetailsExtended')) {
        return devActorDetails();
    }
    if (method.endsWith('LoadActorDetailsSecure')) {
        return typed('com.moviestarplanet.usersession.valueobjects.ActorDetailSecure', {
            actorDetails: devActorDetails(),
            password: DEV_PASSWORD
        });
    }
    if (method.endsWith('GetActorIdFromName')) {
        return DEV_ACTOR_ID;
    }
    if (method.endsWith('GetActorNameFromId')) {
        return DEV_USERNAME;
    }
    if (method.endsWith('GetActorLocale')) {
        return 'en_US';
    }
    if (method.endsWith('LoadState')) {
        return postLoginState();
    }
    if (method.endsWith('IsModerator') || method.endsWith('IsAdminSite') || method.endsWith('IsDevSite')) {
        return true;
    }
    if (method.endsWith('awardActorMoneySecure') || method.endsWith('awardActorVIP')) {
        return null;
    }
    if (method.endsWith('LoadDataForRegisterNewUser')) {
        const data = registerNewUserData();
        return data;
    }
    if (/^(Is|Has|Can|Check)/i.test(leaf)) {
        if (/NameUsed|NameTaken|Blocked|Banned|Muted|Locked/i.test(leaf)) return false;
        return true;
    }
    if (/^(Get|Load|Find|Search|Browse|List)/i.test(leaf)) {
        return genericReadResult(method, leaf);
    }if (method.endsWith('SaveBirthInfoWithTicket')) {
    const ticket = args && args[0] ? String(args[0]) : '';

    let userRecord = null;

    const usersList = Array.isArray(db.users)
        ? db.users
        : Object.values(db.users || {});

    for (const user of usersList) {
        if (
            user.ticket === ticket ||
            user.Ticket === ticket ||
            user.loginTicket === ticket ||
            user.LoginTicket === ticket
        ) {
            userRecord = user;
            break;
        }
    }

    if (!userRecord && ticket) {
        const ticketMatch = ticket.match(/^local-(.+?)-ticket/i);
        if (ticketMatch) {
            const usernameFromTicket = ticketMatch[1].toLowerCase();

            userRecord = usersList.find((user) =>
                String(user.username || user.Username || user.name || user.Name || '').toLowerCase() === usernameFromTicket
            );
        }
    }

    const actorRecord = userRecord && (userRecord.actor || userRecord.Actor || userRecord);

    log(`[BIRTH INFO] ticket=${ticket.slice(0, 30)} actor=${actorRecord ? (actorRecord.name || actorRecord.Name || actorRecord.actorId || actorRecord.ActorId) : 'not-found'}`);

    return createNewUserStatus(actorRecord);
}
    if (/^(Save|Update|Delete|Remove|Add|Set|Send|Report|Claim|Redeem|Award|Give|Accept|Reject|Invite|Buy|Purchase|Block|Unblock)/i.test(leaf)) {
        return genericWriteResult(method, leaf);
    }
    log(`[AMF FALLBACK] ${method} -> null`);
    return null;
};

const handleLocalGatewayRequest = async (req, res, fallbackReason = '') => {
    const size = Buffer.isBuffer(req.body) ? req.body.length : 0;
    const method = req.query.method || '';
    if (fallbackReason) {
        log(`[REMOTE GATEWAY LOCAL FALLBACK] ${method} ${fallbackReason}`);
    }
    const envelope = parseAmfEnvelope(req.body);
    const responseUri = envelope && envelope.messages[0] ? envelope.messages[0].response : '/1';
    let decodedArgs = [];
    log(`[AMF] ${req.method} /Gateway.aspx method=${method} body=${size} bytes response=${responseUri}`);
    if (envelope && envelope.messages[0]) {
        try {
            log(`[AMF BODY] target=${envelope.messages[0].target} length=${envelope.messages[0].body.length} hex=${envelope.messages[0].body.slice(0, 32).toString('hex')}`);
            const decodedBody = decodeAmfjsBody(envelope.messages[0].body);
            decodedArgs = Array.isArray(decodedBody) ? decodedBody : [];
            log(`[AMF DECODE] target=${envelope.messages[0].target} args=${previewValue(decodedBody)}`);
        } catch (err) {
            log(`[AMF DECODE MISS] target=${envelope.messages[0].target} error=${err.message}`);
        }
    }
    try {
        const result = await getAmfResultForMethod(method, decodedArgs);

        // Uzywamy amfjs dla wszystkich metod — legacy tylko jesli amfjs rzuci wyjatek.
        // Wyjatki: Login przez stary klient AMFUserServiceWeb wymaga legacy+amf3.
        const forceAmf3 = shouldUseAmf3(method, result);
        // Nie uzywamy useLegacyEncoder domyslnie — amfjs powinien dzialac dla CreateNewUser i LoadDataForRegisterNewUser.
        // Legacy jest uzywane tylko gdy amfjs rzuci blad (patrz: buildAmfResponse fallback).
        const responseBody = buildAmfResponse(envelope ? envelope.version : 0, responseUri, result, {
            amf3: forceAmf3,
            debugLabel: method,
            legacy: false
        });
        dumpAmfExchange(method, req.body, responseBody, {
            responseUri,
            amf3: forceAmf3,
            legacy: false,
            resultPreview: previewValue(result, 2000)
        });
        res.type('application/x-amf').send(responseBody);
    } catch (err) {
        log(`[AMF ERROR] ${method} ${err.stack || err.message}`);
        const result = okResult();
        const responseBody = buildAmfResponse(envelope ? envelope.version : 0, responseUri, result, {
            amf3: true,
            debugLabel: `${method} ERROR_FALLBACK`
        });
        dumpAmfExchange(method, req.body, responseBody, {
            responseUri,
            amf3: true,
            legacy: false,
            error: err.message,
            resultPreview: previewValue(result, 2000)
        });
        res.type('application/x-amf').send(responseBody);
    }
};

app.all('/Gateway.aspx', async (req, res) => {
    const method = req.query.method || '';
    if (proxyRealMspApiRequest(req, res, method, (reason) => handleLocalGatewayRequest(req, res, reason))) {
        return;
    }

    // DODANE: tryb klient -> Render. Niczego lokalnego nie usuwamy.
    // v19: SOAP /WebService/Service.asmx tez jest proxy do Rendera, nie tylko /Gateway.aspx.
    // Gdy USE_REMOTE_GATEWAY=1, wszystkie AMF /Gateway.aspx ida do Rendera.
    // Jesli Render padnie, app.js wraca do starego lokalnego handlera, wiec dev panel nie znika.
    if (useRemoteGateway && proxyGatewayRequest(req, res, method, (reason) => handleLocalGatewayRequest(req, res, reason))) {
        return;
    }

    if (shouldProxyRemoteGateway(method) && proxyGatewayRequest(req, res, method, (reason) => handleLocalGatewayRequest(req, res, reason))) {
        return;
    }
    await handleLocalGatewayRequest(req, res);
});

app.get('/getConfig', (req, res) => {
    const baseUrl = requestBaseUrl(req);
    res.json({
        "version": 5,
        "swfUrl": `${baseUrl}Main_2010123_95850.swf`,
        "basePath": baseUrl,
        "cdnPath": baseUrl,
        "assetConfigUrl": `${baseUrl}assetconfig.json`,
        "remoteAssetBaseUrl": remoteAssetBaseUrl + "/",
        "officialCdnPath": officialMspAssetBaseUrl + "/",
        "isLocal": "false",
        "language": "PL",
        "mongoDbName": mongoDbName,
        "mongoStateCollection": mongoStateCollection
    });
});

app.get('/api/db/status', (req, res) => {
    res.json({
        build: typeof BUILD !== 'undefined' ? BUILD : null,
        source: dbSource,
        mongoConnected: useRemoteGateway || Boolean(mongoClient && mongoDatabase),
        remoteGatewayEnabled: useRemoteGateway,
        remoteGatewayExplicitEnabled,
        remoteGateway: useRemoteGateway ? remoteGatewayUrl : '',
        mongoDbName,
        mongoStateCollection,
        clothes: db.catalog && Array.isArray(db.catalog.clothes) ? db.catalog.clothes.length : 0,
        users: Array.isArray(db.users) ? db.users.length : 0
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        mode: configuredPort ? 'render' : (isServerOnly ? 'server' : 'local'),
        source: dbSource,
        mongoConnected: useRemoteGateway || Boolean(mongoClient && mongoDatabase),
        remoteGateway: useRemoteGateway ? remoteGatewayUrl : '',
        realMspProxy: realMspProxyEnabled,
        realMspServer,
        remoteAssets: Boolean(remoteAssetBaseUrl),
        locale: forcedLocale,
        serverTime: new Date().toISOString()
    });
});
// Automatyczna naprawa brakujących szkieletów animacji (DragonBone)
app.get('*.json', (req, res, next) => {
    const fullPath = path.join(publicPath, req.path);
    if (!fs.existsSync(fullPath) && req.path.includes('dragonbone')) {
        log(`[FIX] Generuję pusty szkielet dla: ${req.url}`);
        return res.json({}); // Zwraca pusty obiekt zamiast błędu 404
    }
    next();
});
app.use((req, res) => {
    log(`[MISS] ${req.method} ${req.url}`);
    res.status(404).type('text/plain').send(`Missing local file/route: ${req.url}`);
});
const startServer = (port) => {
    app.listen(port, '0.0.0.0', () => {
        log(`Serwer czeka na porcie ${port}...`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log(`Port ${port} jest juz zajety, pomijam.`);
        } else {
            console.error(`Nie mozna uruchomic portu ${port}:`, err);
        }
    });
};

const writeServerPid = () => {
    if (!isServerOnly && !configuredPort) {
        return;
    }
    try {
        fs.writeFileSync(serverPidPath, String(process.pid), 'utf8');
    } catch (err) {
        log(`[PID] Nie udalo sie zapisac PID: ${err.message}`);
    }
};

const removeServerPid = () => {
    try {
        if (fs.existsSync(serverPidPath)) {
            fs.unlinkSync(serverPidPath);
        }
    } catch (err) {
        log(`[PID] Nie udalo sie usunac PID: ${err.message}`);
    }
};

process.on('exit', removeServerPid);
process.on('SIGINT', () => {
    removeServerPid();
    process.exit(0);
});
process.on('SIGTERM', () => {
    removeServerPid();
    process.exit(0);
});

const preloadSwfAssets = async () => {
    if (process.env.PRELOAD_SWF !== '1') return;
    if (!remoteAssetBaseUrl) return;
    if (!remoteAssetCacheEnabled) {
        log('[PRELOAD SWF] pominieto, bo REMOTE_ASSET_CACHE nie jest wlaczone');
        return;
    }

    const manifestPath = path.join(__dirname, 'main_swf_manifest_critical.json');

    if (!fs.existsSync(manifestPath)) {
        log(`[PRELOAD SWF] brak manifestu: ${manifestPath}`);
        return;
    }

    let list = [];
    try {
        list = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
        log(`[PRELOAD SWF] blad manifestu: ${err.message}`);
        return;
    }

    if (!Array.isArray(list)) {
        log('[PRELOAD SWF] manifest nie jest tablica');
        return;
    }

    const limit = Math.max(1, Number(process.env.PRELOAD_SWF_LIMIT || 4));
    const queue = list.slice();
    let ok = 0;
    let fail = 0;

    const worker = async () => {
        while (queue.length) {
            const rel = queue.shift();
            const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');

            if (!clean || !clean.toLowerCase().endsWith('.swf')) continue;

            const target = path.join(assetCachePath, clean);

            try {
                if (fs.existsSync(target) && fs.statSync(target).isFile()) {
                    ok += 1;
                    continue;
                }
            } catch (_) {
                // Gdy stat sie wysypie, probujemy pobrac plik od nowa.
            }

            const remoteUrl = `${remoteAssetBaseUrl}/${encodeURI(clean).replace(/%2F/gi, '/')}`;

            try {
                await downloadRemoteAsset(remoteUrl, target);
                ok += 1;
                log(`[PRELOAD SWF] OK ${clean}`);
            } catch (err) {
                fail += 1;
                log(`[PRELOAD SWF] MISS ${clean} ${err.message}`);
            }
        }
    };

    await Promise.all(Array.from({ length: limit }, worker));
    log(`[PRELOAD SWF] koniec ok=${ok} fail=${fail}`);
};

const start = async () => {
    db = await loadDb();
    await warmRemoteGateway();
    await preloadSwfAssets();
    writeServerPid();
    if (configuredPort) {
        startServer(Number(configuredPort));
        return;
    }
    if (isServerOnly) {
        startServer(1600);
        return;
    }
    startServer(80);
    startServer(1600);
};

start().catch((err) => {
    log(`[START] Nie udalo sie uruchomic serwera: ${err.stack || err.message}`);
    process.exitCode = 1;
});
