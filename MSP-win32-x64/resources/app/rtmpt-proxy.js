'use strict';

// The local bridge keeps its authentication key in memory. Flash only sees
// its numeric RTMPT session ID; all traffic to Render travels over HTTPS.
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const express = require('express');

function router(target) {
  const base = new URL(target);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1')) throw Error('RTMPT endpoint must use HTTPS');
  const client = base.protocol === 'https:' ? https : http;
  const app = express.Router();
  const keys = new Map();
  const ttl = 120000;
  app.post(/^\/(fcs\/ident2|open\/1|(?:send|idle|close)\/[0-9]{1,10}\/\d+)$/, (req, res) => {
    const now = Date.now();
    for (const [id, item] of keys) if (item.updated < now - ttl) keys.delete(id);
    if (req.path === '/fcs/ident2') return res.status(404).end();
    const open = req.path === '/open/1';
    const parts = req.path.split('/');
    const id = parts[2];
    if (open && keys.size >= 50) return res.status(503).end();
    const entry = open ? {key:crypto.randomBytes(32).toString('hex'), updated:now} : keys.get(id);
    if (!entry) return res.status(404).end();
    entry.updated = now;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length > 1048576) return res.status(413).end();
    const url = new URL('/rtmpt' + req.path, base);
    const upstream = client.request(url, {method:'POST', headers:{'content-type':'application/x-fcs', 'content-length':body.length, 'x-rtmpt-client-key':entry.key}}, incoming => {
      if (open) {
        const chunks = []; let length = 0;
        incoming.on('data', chunk => { length += chunk.length; if (length <= 128) chunks.push(chunk); else upstream.destroy(); });
        incoming.on('end', () => {
          const result = Buffer.concat(chunks); const newId = result.toString('ascii').trim();
          if (incoming.statusCode !== 200 || !/^[0-9]{1,10}$/.test(newId)) return res.status(502).end();
          keys.set(newId, entry); res.type('application/x-fcs').send(result);
        });
      } else {
        if (parts[1] === 'close') keys.delete(id);
        res.status(incoming.statusCode).type('application/x-fcs'); incoming.pipe(res);
      }
    });
    upstream.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.end(body);
  });
  return app;
}
module.exports = {router};

