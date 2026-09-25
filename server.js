'use strict';
/**
 * Network Planner — web server
 * ----------------------------------------------------------------------------
 * A deliberately tiny HTTP server built only on Node's standard library (no
 * npm packages), so the Docker image stays small and has nothing to patch.
 *
 * It does three things:
 *   1. Serves the browser app from ./public (index.html, app.js, styles.css).
 *   2. Stores the whole rack layout as one JSON document:
 *        GET  /api/layout   → returns the saved layout (204 if none saved yet)
 *        PUT  /api/layout   → replaces the saved layout with the request body
 *      The file lives at $DATA_DIR/layout.json (/data in Docker = a volume).
 *   3. Answers GET /healthz with "ok" for the Docker HEALTHCHECK.
 *
 * Environment variables:
 *   PORT      port to listen on            (default 8080)
 *   DATA_DIR  folder for layout.json       (default ./data, /data in Docker)
 *
 * There is no authentication: anyone who can reach the port can view and edit
 * the layout. Put it behind a reverse proxy with auth if exposing it widely.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'layout.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 20 * 1024 * 1024; // reject layouts larger than 20 MB

// Content-Type for each static file extension we serve.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// Write a complete response in one go. API responses are never cached so the
// browser always sees the latest saved layout.
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// /api/layout — load (GET) or save (PUT) the layout document.
// Saves are atomic: the JSON is written to layout.json.tmp and then renamed
// over layout.json, so a crash mid-write can never leave a half-written file.
function handleLayout(req, res) {
  if (req.method === 'GET') {
    fs.readFile(DATA_FILE, (err, buf) => {
      if (err) return err.code === 'ENOENT' ? send(res, 204, '') : send(res, 500, 'read failed');
      send(res, 200, buf, TYPES['.json']);
    });
    return;
  }
  if (req.method === 'PUT') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { send(res, 413, 'too large'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || !Array.isArray(data.racks) || !Array.isArray(data.devices)) throw new Error('bad shape');
      } catch {
        return send(res, 400, 'invalid layout');
      }
      const tmp = DATA_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(data, null, 2), (err) => {
        if (err) return send(res, 500, 'write failed');
        fs.rename(tmp, DATA_FILE, (err2) => (err2 ? send(res, 500, 'write failed') : send(res, 204, '')));
      });
    });
    return;
  }
  send(res, 405, 'method not allowed');
}

// Serve a file from ./public. "/" maps to index.html. The resolved path must
// stay inside ./public, which blocks "../" path-traversal requests.
function serveStatic(pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'bad path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// Request router.
http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/layout') return handleLayout(req, res);
  if (pathname === '/healthz') return send(res, 200, 'ok');
  serveStatic(pathname, res);
}).listen(PORT, () => {
  console.log(`Rack Planner listening on http://0.0.0.0:${PORT} (data: ${DATA_FILE})`);
});
