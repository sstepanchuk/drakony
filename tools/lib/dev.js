// Local static server. For games/ it mirrors the library: a stand-in shelf at / and the library API in every game.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { P, rel, exists, fail, gameIds } from './repo.js';
import { readManifest, withLibraryApi } from './build.js';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const esc = s => String(s).replace(/[&<>"]/g, c => '&#' + c.charCodeAt(0) + ';');

export function serve(what = 'games', port = 8000) {
  const games = what !== 'docs', dir = games ? P.games : P.site;
  if (!exists(dir)) fail('No ' + rel(dir) + (games ? ' (run npm run unlock first)' : ''));
  const send = (res, type, body) => res.writeHead(200, { 'Content-Type': type + (/^(text|application\/json)/.test(type) ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store' }).end(body);

  http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (games && url === '/') {
      return send(res, 'text/html', '<!doctype html><meta charset="utf-8"><title>Games (dev)</title><body style="font:16px system-ui;padding:24px"><h1>Games (dev)</h1><ul>' +
        gameIds().map(id => '<li><a href="/' + id + '/">' + esc(readManifest(id).title) + '</a></li>').join('') + '</ul>');
    }
    const game = games && url.match(/^\/([a-z0-9-]+)\/(index\.html)?$/)?.[1];
    if (game && gameIds().includes(game)) return send(res, 'text/html', withLibraryApi(fs.readFileSync(path.join(dir, game, 'index.html'), 'utf8'), game, readManifest(game)));

    let file = path.join(dir, url);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    if (exists(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!exists(file)) return res.writeHead(404).end('404');
    send(res, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
  }).listen(+port, () => {
    console.log('http://localhost:' + port + '/');
    if (games) for (const id of gameIds()) console.log('  ' + id + ': http://localhost:' + port + '/' + id + '/');
  });
}
