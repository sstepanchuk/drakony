// Local static server. For games/ it mirrors the library: a stand-in shelf at / and the library API in every game.
// It serves plaintext sources, so by default it only listens on this computer.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { P, MIME, rel, esc, exists, problem, gameIds } from './repo.js';
import { readManifest, withLibraryApi, sdkModules } from './build.js';

const text = type => type + (/^(text|application\/json)/.test(type) ? '; charset=utf-8' : '');

// The build bundles @ihroteka/<name> imports; in the browser an import map points them at sdk/ instead.
const SDK = '/@ihroteka/';
function withSdk(html) {
  const imports = Object.fromEntries(Object.keys(sdkModules()).map(m => [m, SDK + m.split('/')[1] + '/index.js']));
  return html.replace(/<script\b/i, m => '<script type="importmap">' + JSON.stringify({ imports }) + '</script>\n' + m);
}

export function serve(what = 'games', port = '8000', host = '127.0.0.1') {
  const games = what !== 'docs', dir = games ? P.games : P.site;
  if (!exists(dir)) problem('No ' + rel(dir) + (games ? ' (run npm run unlock first)' : ''));

  const respond = (req, res) => {
    const send = (code, type, body) => res.writeHead(code, { 'Content-Type': text(type), 'Cache-Control': 'no-store' }).end(body);
    let url;
    try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return send(400, 'text/plain', 'Bad URL'); }
    if (games && url === '/') {
      return send(200, 'text/html', '<!doctype html><meta charset="utf-8"><title>Games (dev)</title><body style="font:16px system-ui;padding:24px"><h1>Games (dev)</h1><ul>' +
        gameIds().map(id => '<li><a href="/' + id + '/">' + esc(readManifest(id).title) + '</a></li>').join('') + '</ul>');
    }
    const game = games && url.match(/^\/([a-z0-9-]+)\/(index\.html)?$/)?.[1];
    if (game && gameIds().includes(game)) return send(200, 'text/html', withSdk(withLibraryApi(fs.readFileSync(path.join(dir, game, 'index.html'), 'utf8'), game, readManifest(game))));
    const base = games && url.startsWith(SDK) ? P.sdk : dir;   // shared libraries, as the import map names them
    let file = path.join(base, games && base === P.sdk ? url.slice(SDK.length) : url);
    if (file !== base && !file.startsWith(base + path.sep)) return send(403, 'text/plain', 'Forbidden');
    if (exists(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!exists(file)) return send(404, 'text/plain', 'Not found');
    send(200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', fs.readFileSync(file));
  };

  http.createServer((req, res) => {
    try { respond(req, res); }
    catch (e) {                                          // a typo in game.json must not stop the server
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(e.message);
      console.error('✗ ' + e.message);
    }
  }).listen(+port, host, () => {
    console.log('http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port + '/' + (host === '127.0.0.1' ? '' : '   (reachable from your network)'));
    if (games) for (const id of gameIds()) console.log('  ' + id + ': http://localhost:' + port + '/' + id + '/');
  });
}
