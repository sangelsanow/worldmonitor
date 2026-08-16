#!/usr/bin/env node
'use strict';
// World Monitor — native tool server. Part of WorldAI (~/worldai), NOT the sangai repo.
//
// Modelled directly on sangai/site/server.js: zero-dependency node:http, no framework.
// Differs from that sibling in two ways only World Monitor needs: it proxies /api/* to the
// sidecar process (upstream's Vercel Edge Functions have no equivalent here), and it
// injects an AGPL-3.0 attribution footer at serve time — a licence obligation, not
// decoration, since this is a modified, publicly-served instance.
//
// Config (env): WM_WEB_PORT (9161), WM_WEB_HOST (127.0.0.1 — public reach is via the
//   WorldAI gateway + its own named Cloudflare tunnel, never a direct bind), WM_API_PORT
//   (8081, where the sidecar listens), WM_COMMIT_SHA (stamped by redeploy.sh; falls back to
//   `git rev-parse HEAD` at process start if unset, so the footer is never wrong by default).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const API_PORT = Number(process.env.WM_API_PORT || 8081);
const UPSTREAM_REPO = 'https://github.com/koala73/worldmonitor';
const FORK_REPO = 'https://github.com/sangelsanow/worldmonitor';
// The Vite build renames the SPA entry index.html -> dashboard.html at build time
// (dashboardHtmlOutputPlugin) — there is no dist/index.html at all. Mirrors upstream's own
// docker/nginx.conf, which sets `index dashboard.html` for the same reason.
const ENTRY_HTML = 'dashboard.html';
// Sidecar auth: LOCAL_API_TOKEN is a default-deny gate on every /api/* request (see
// src-tauri/sidecar/local-api-server.mjs). A browser has no way to know this token, so
// nginx injects it server-side for every proxied request — we do the same. Header name
// and the Origin override are copied verbatim from docker/nginx.conf's /api/ location.
const LOCAL_API_TOKEN = process.env.LOCAL_API_TOKEN || '';
const LOCAL_API_TRANSPORT_HEADER = 'x-worldmonitor-local-token';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function commitSha() {
  if (process.env.WM_COMMIT_SHA) return process.env.WM_COMMIT_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
const COMMIT = commitSha();
const SHORT_COMMIT = COMMIT === 'unknown' ? 'unknown' : COMMIT.slice(0, 12);

// AGPL-3.0 §13 footer — injected into index.html at SERVE time, never patched into dist/,
// so a rebuild can never silently drop it. Kept small and unobtrusive but genuinely visible.
const FOOTER = `
<div id="wm-agpl-footer" style="position:fixed;left:0;right:0;bottom:0;z-index:99999;
  font:11px/1.4 -apple-system,system-ui,sans-serif;color:#9aa;background:rgba(10,12,16,.72);
  backdrop-filter:blur(4px);padding:4px 10px;text-align:center;pointer-events:none;">
  <span style="pointer-events:auto;">
    WorldAI Monitor — a self-hosted instance of
    <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener" style="color:#9cf;">World Monitor</a>,
    modified fork at <a href="${FORK_REPO}" target="_blank" rel="noopener" style="color:#9cf;">sangelsanow/worldmonitor</a>
    (<a href="${FORK_REPO}/commit/${COMMIT}" target="_blank" rel="noopener" style="color:#9cf;">${SHORT_COMMIT}</a>) —
    <a href="${UPSTREAM_REPO}/blob/main/LICENSE" target="_blank" rel="noopener" style="color:#9cf;">AGPL-3.0-only</a>
  </span>
</div>`;

// Hides purchase/upgrade-to-Pro/pricing CTAs and the GitHub repo links from the live UI.
// Injected as CSS at serve time (never patched into dist/, same reasoning as FOOTER above)
// rather than edited out of the upstream source: this instance runs no Clerk/Convex/Dodo
// billing at all, so every one of these is either a dead link (nothing to upgrade to here)
// or points at upstream's repo/pricing rather than this fork. Scoped to `#app` throughout —
// our own AGPL attribution footer lives outside #app (a sibling in <body>) and must stay
// visible; scoping this way means no selector here can ever hide it by accident.
const HIDE_STYLE = `
<style id="wm-hide-purchase-links">
  /* Top "Pro is launched" promo banner. */
  #app .pro-banner-slot,
  /* Header GitHub icon link. */
  #app a.github-link,
  /* Footer/mobile-menu nav: Pricing + GitHub (plain <a>, no stable class — matched by href). */
  #app nav a[href*="/pro#pricing"],
  #app nav a[href="/pro"],
  #app nav a[href*="github.com/koala73"],
  #app .mobile-menu-footer-links a[href*="/pro"],
  /* Settings dialog: "Upgrade to Pro/Business" CTAs (the surrounding plan-status text stays). */
  #app .upgrade-pro-cta-link,
  #app .upgrade-to-business-btn,
  /* Locked-panel gate: just the CTA button, not the whole explanatory card. */
  #app .panel-locked-cta
  { display: none !important; }
</style>`;

function injectFooter(html) {
  const withStyle = html.includes('</head>') ? html.replace('</head>', `${HIDE_STYLE}</head>`) : html + HIDE_STYLE;
  if (withStyle.includes('</body>')) return withStyle.replace('</body>', `${FOOTER}</body>`);
  return withStyle + FOOTER;
}

// serveStatic — same shape as sangai/site/server.js's own: path-traversal guard via
// startsWith(DIR + sep), no-store on the live shell. Adds SPA fallback (World Monitor is a
// client-routed Vite app; an unknown deep path must still resolve to index.html) and footer
// injection for index.html specifically.
function serveStatic(res, file) {
  const full = path.join(DIST_DIR, file);
  if (full !== DIST_DIR && !full.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA fallback: no file at this path and it isn't an obvious static asset request —
      // serve index.html so client-side routing can take over.
      if (path.extname(file)) { res.writeHead(404); return res.end('not found'); }
      return serveIndex(res);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

function serveIndex(res) {
  fs.readFile(path.join(DIST_DIR, ENTRY_HTML), 'utf8', (err, html) => {
    if (err) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('World Monitor is not built yet — run native/redeploy.sh');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(injectFooter(html));
  });
}

// proxyApi — forwards /api/* to the sidecar on WM_API_PORT, preserving method and body but
// overriding two headers exactly as docker/nginx.conf's /api/ location does: Origin is
// pinned to http://localhost so the sidecar's browser-origin checks pass, and the local
// transport token is injected since a browser has no way to know it. Deliberately does NOT
// special-case /api/mcp* here: the MCP boundary is enforced at the WorldAI gateway
// (gateway/serve.mjs), which is the only port ever exposed publicly — this server binds
// loopback-only regardless.
function proxyApi(req, res) {
  const headers = { ...req.headers, origin: 'http://localhost' };
  if (LOCAL_API_TOKEN) headers[LOCAL_API_TRANSPORT_HEADER] = LOCAL_API_TOKEN;
  const opts = { hostname: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers };
  const upstream = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`api sidecar unreachable: ${e.code || e.message}`);
  });
  req.pipe(upstream);
}

function createTool() {
  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end('ok');
    }
    if (p.startsWith('/api/')) return proxyApi(req, res);
    if (p === '/') return serveIndex(res);
    return serveStatic(res, p.slice(1));
  }
  return { handle };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.WM_WEB_PORT || 9161);
  const host = process.env.WM_WEB_HOST || '127.0.0.1';
  const tool = createTool();

  const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const say = (m) => console.log(`[wm-web ${stamp()}] ${m}`);
  const shout = (m) => console.error(`[wm-web ${stamp()}] ${m}`);

  process.on('uncaughtException', (e) => {
    shout(`FATAL uncaughtException: ${e && e.stack || e}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    shout(`FATAL unhandledRejection: ${e && e.stack || e}`);
    process.exit(1);
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { shout(`received ${sig} — exiting`); process.exit(0); });
  }

  const server = http.createServer(tool.handle);
  server.on('error', (e) => {
    shout(`cannot listen on ${host}:${port} — ${e.code === 'EADDRINUSE'
      ? 'port already in use' : e.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => say(`listening on http://${host}:${port} (commit ${SHORT_COMMIT})`));
}

export { createTool };
