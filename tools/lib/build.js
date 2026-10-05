// Turning games/<id>/ into a published game: manifest, library API, one-page bundle, public page; and site checks.
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import * as vault from '../../docs/lib/vault.js';
import { P, rel, exists, problem, homepage, sourceIds, siteGames, sitePath, sourcePath, walk } from './repo.js';

const RESERVED = new Set(['lib']);                     // top-level names the site itself uses

/* ---------- manifest: games/<id>/game.json ---------- */
const FIELDS = {
  title: 'name on the shelf and in the link preview',
  tagline: 'one line under the title on the shelf',
  description: 'page description',
  image: '1200×630 PNG next to game.json, e.g. preview.png',
  shareTitle: '?link preview title',
  shareDescription: '?link preview text',
  imageAlt: '?image description',
  emoji: '?tab icon (one emoji)',
  theme: '?browser theme color, e.g. #e4e2f0'
};
const FORMAT = {
  image: v => /^[\w-]+\.png$/.test(v),
  emoji: v => [...v].length <= 4 && !/[\x00-\x7f]/.test(v),
  theme: v => /^#[0-9a-f]{3,8}$/i.test(v)
};
export function readManifest(id) {
  const dir = path.join(P.games, id), file = rel(path.join(dir, 'game.json'));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || RESERVED.has(id)) problem('games/' + id + ': the folder name becomes the URL, so use lowercase letters, digits and dashes (and not ' + [...RESERVED].join(', ') + ')');
  let g;
  try { g = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { problem(file + ': ' + e.message); }
  for (const k of Object.keys(g)) if (!(k in FIELDS)) problem(file + ': unknown field "' + k + '"');
  for (const [k, about] of Object.entries(FIELDS)) {
    const optional = about.startsWith('?');
    if (g[k] === undefined && optional) continue;
    if (typeof g[k] !== 'string' || !g[k].trim()) problem(file + ': "' + k + '" must be a non-empty string (' + about.replace('?', '') + ')');
    if (FORMAT[k] && !FORMAT[k](g[k])) problem(file + ': "' + k + '" has an unexpected value (' + about.replace('?', '') + ')');
  }
  for (const f of ['index.html', g.image]) if (!exists(path.join(dir, f))) problem('games/' + id + '/' + f + ' not found');
  return g;
}

/* ---------- library API (tools/runtime/library-api.js), first thing in <head> ---------- */
export function withLibraryApi(html, id, g) {
  const api = fs.readFileSync(P.api, 'utf8')
    .replace(/^\/\*[\s\S]*?\*\/\s*/, '')
    .replace('__GAME__', () => JSON.stringify({ id, title: g.title }).replace(/</g, '\\u003c'));
  const at = /<meta charset[^>]*>/i.test(html) ? /<meta charset[^>]*>/i : /<head>/i;   // charset must stay near the top
  if (!at.test(html)) problem('games/' + id + '/index.html has no <head>');
  return html.replace(at, m => m + '\n<script>' + api.trim() + '</script>');
}

/* ---------- shared libraries: import … from '@ihroteka/<name>' resolves to sdk/<name>/index.js ---------- */
export const sdkModules = () => Object.fromEntries((exists(P.sdk) ? fs.readdirSync(P.sdk) : [])
  .filter(n => exists(path.join(P.sdk, n, 'index.js'))).map(n => ['@ihroteka/' + n, path.join(P.sdk, n, 'index.js')]));

/* ---------- one self-contained page ---------- */
// Styles and module scripts are bundled inline; images, fonts and sounds they use become data: URLs.
// Anything else the page points to by a relative URL would not exist on the site, so the build stops.
const ASSETS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.json': 'application/json' };
const loader = Object.fromEntries(Object.keys(ASSETS).filter(e => e !== '.json').map(e => [e, 'dataurl']));
const attr = (tag, name) => tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'))?.slice(1).find(v => v !== undefined);
const local = url => url && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
const dataUrl = file => 'data:' + ASSETS[path.extname(file).toLowerCase()] + ';base64,' + fs.readFileSync(file).toString('base64');

export async function bundleGame(id, g) {
  const dir = path.join(P.games, id), where = 'games/' + id + '/index.html';
  let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/^\uFEFF/, '');
  if (!/^\s*<!doctype html>/i.test(html)) problem(where + ' must start with <!doctype html> (without it the page renders in quirks mode)');
  html = withLibraryApi(html, id, g);
  const build = async (entry, extra) => (await esbuild.build({ entryPoints: [path.join(dir, entry)], bundle: true, minify: true, write: false, charset: 'utf8',
    legalComments: 'none', logLevel: 'silent', loader, alias: sdkModules(), ...extra }).catch(e => problem(where + ': ' + (e.errors?.[0]?.text || e.message)))).outputFiles[0].text.trim();

  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag) || !local(attr(tag, 'href'))) continue;
    const css = await build(attr(tag, 'href'), {});
    html = html.replace(tag, () => '<style>' + css + '</style>');
  }
  for (const tag of html.match(/<script\b[^>]*>\s*<\/script>/gi) || []) {
    const src = attr(tag, 'src');
    if (!local(src)) continue;
    if (!/\btype\s*=\s*["']?module/i.test(tag)) problem(where + ': <script src="' + src + '"> must be type="module" to be bundled');
    const js = await build(src, { format: 'esm', target: 'es2020' });
    if (/<\/script/i.test(js)) problem(where + ': the bundle contains "</script" and cannot be inlined');
    html = html.replace(tag, () => '<script type="module">' + js + '</script>');   // still a module: runs after the page is parsed, as before
  }
  // remaining relative src/href: inline known assets, refuse everything else
  html = html.replace(/(\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, url) => {
    if (!local(url)) return m;
    const file = path.join(dir, url.split(/[?#]/)[0]);
    if (!file.startsWith(dir + path.sep) || !exists(file) || !ASSETS[path.extname(file).toLowerCase()]) problem(where + ': "' + url + '" would not exist on the site (only styles, module scripts and media files are bundled)');
    return pre + q + dataUrl(file) + q;
  });
  return html;
}

/* ---------- public game page with the lock and the link preview ---------- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function gamePage(id, g) {
  const base = homepage();
  if (!/^https:\/\/[^/]+\/(.*\/)?$/.test(base.replace(/\/?$/, '/'))) problem('package.json "homepage" must be the absolute https URL of the site (link previews need it)');
  const vals = {
    title: g.title, description: g.description, image: g.image,
    shareTitle: g.shareTitle || g.title, shareDescription: g.shareDescription || g.description, imageAlt: g.imageAlt || g.title,
    imageUrl: base.replace(/\/?$/, '/') + id + '/' + g.image, emoji: g.emoji || '🎮', theme: g.theme || '#e4e2f0'
  };
  return fs.readFileSync(P.template, 'utf8')
    .replace('{{idJson}}', JSON.stringify(id))
    .replace(/\{\{(\w+)\}\}/g, (_, k) => k in vals ? esc(vals[k]) : problem('Template: unknown field ' + k));
}

/* ---------- password-free site validation (also run by CI) → { problems, games, people } ---------- */
const SITE_FILES = new Set(['index.html', 'keyring.json', 'library.bin', 'lib/lock.js', 'lib/vault.js', 'lib/keystore.js', 'lib/style.css']);
export function checkSite() {
  const problems = [], bad = msg => problems.push(msg);
  let kr = null;
  try { kr = JSON.parse(fs.readFileSync(P.keyring, 'utf8')); } catch (e) { bad(rel(P.keyring) + ': ' + e.message); }
  if (kr) {
    if (kr.v !== 1 || !kr.kid || !kr.kdf?.salt || !(kr.kdf.iterations >= 100000)) bad('keyring.json: invalid header');
    if (!kr.people?.length) bad('keyring.json: no people');
    for (const p of kr.people || []) if (!(p.id && p.pub && p.priv && p.name && p.box?.epk && p.box?.ct)) bad('keyring.json: incomplete entry ' + (p.id || '?'));
  }
  // every sealed file must be sealed with the current library key
  const sealedWithCurrentKey = (file, label) => {
    if (!exists(file)) return bad('missing ' + rel(file));
    const kid = vault.fileKid(fs.readFileSync(file));
    if (!kid) bad(rel(file) + ': not a sealed file');
    else if (kr && kid !== kr.kid) bad(rel(file) + ': sealed with an old library key (' + label + ' — rebuild after git pull)');
  };
  for (const f of SITE_FILES) if (!f.endsWith('.bin') && !exists(sitePath(f))) bad('missing docs/' + f);
  sealedWithCurrentKey(sitePath('library.bin'), 'shelf');
  const games = siteGames();
  if (!games.length) bad('no games in docs/');
  for (const id of games) {
    sealedWithCurrentKey(sitePath(id, 'game.bin'), id);
    sealedWithCurrentKey(sourcePath(id), id + ' sources');
    const page = sitePath(id, 'index.html');
    if (!exists(page)) { bad('missing docs/' + id + '/index.html'); continue; }
    const html = fs.readFileSync(page, 'utf8'), img = html.match(/class="cover" src="([^"]+)"/)?.[1];
    if (!html.includes('bootGame(')) bad('docs/' + id + '/index.html is not a library game page');
    if (/\{\{\w+\}\}/.test(html)) bad('docs/' + id + '/index.html: unfilled template');
    if (!img || !exists(sitePath(id, img))) bad('docs/' + id + ': missing image ' + (img || ''));
  }
  for (const id of sourceIds()) if (!games.includes(id)) bad('vault/' + id + '.bin exists but docs/ has no such game');
  // only known files may be published: anything else could be a plaintext leak
  const allowed = f => SITE_FILES.has(f) || (/^([\w-]+)\/(index\.html|game\.bin|[\w-]+\.png)$/.test(f) && games.includes(f.split('/')[0]));
  for (const f of walk(P.site)) if (!allowed(f)) bad('docs/' + f + ': unexpected file (only game pages, sealed files and cover images are published)');
  return { problems, games: games.length, people: kr?.people?.length || 0 };
}
