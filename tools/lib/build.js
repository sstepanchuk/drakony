// Turning games/<id>/ into a published game: manifest, library API, one-page bundle, public page; and site checks.
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { P, rel, exists, fail, homepage, sourceIds, sitePath, sourcePath, walk } from './repo.js';

/* ---------- manifest: games/<id>/game.json ---------- */
const FIELDS = {
  title: 'name on the shelf and in the link preview',
  tagline: 'one line under the title on the shelf',
  description: 'page description',
  image: '1200×630 PNG for the shelf and the link preview',
  shareTitle: '?link preview title',
  shareDescription: '?link preview text',
  imageAlt: '?image description',
  emoji: '?tab icon',
  theme: '?browser theme color'
};
export function readManifest(id) {
  const dir = path.join(P.games, id), file = rel(path.join(dir, 'game.json'));
  if (!/^[a-z0-9-]+$/.test(id)) fail('games/' + id + ': folder name must be lowercase letters, digits and dashes (it becomes the URL)');
  let g;
  try { g = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8')); } catch (e) { fail(file + ': ' + e.message); }
  for (const k of Object.keys(g)) if (!(k in FIELDS)) fail(file + ': unknown field "' + k + '"');
  for (const [k, about] of Object.entries(FIELDS)) {
    if (!about.startsWith('?') && !(typeof g[k] === 'string' && g[k].trim())) fail(file + ': "' + k + '" is required (' + about + ')');
  }
  for (const f of ['index.html', g.image]) if (!exists(path.join(dir, f))) fail('games/' + id + '/' + f + ' not found');
  return g;
}

/* ---------- library API (tools/runtime/library-api.js), first thing in <head> ---------- */
export function withLibraryApi(html, id, g) {
  const api = fs.readFileSync(P.api, 'utf8')
    .replace(/^\/\*[\s\S]*?\*\/\s*/, '')
    .replace('__GAME__', () => JSON.stringify({ id, title: g.title }).replace(/</g, '\\u003c'));
  const at = /<meta charset[^>]*>/i.test(html) ? /<meta charset[^>]*>/i : /<head>/i;   // charset must stay near the top
  if (!at.test(html)) fail('games/' + id + '/index.html has no <head>');
  return html.replace(at, m => m + '\n<script>' + api.trim() + '</script>');
}

/* ---------- one self-contained page: styles and module scripts inlined ---------- */
export async function bundleGame(id, g) {
  const dir = path.join(P.games, id);
  let html = withLibraryApi(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), id, g);
  for (const [tag, href] of html.matchAll(/<link rel="stylesheet" href="([^":]+)">/g)) {
    const { code } = await esbuild.transform(fs.readFileSync(path.join(dir, href), 'utf8'), { loader: 'css', minify: true, charset: 'utf8' });
    html = html.replace(tag, () => '<style>' + code.trim() + '</style>');
  }
  for (const [tag, src] of html.matchAll(/<script type="module" src="([^":]+)"><\/script>/g)) {
    const { outputFiles: [out] } = await esbuild.build({ entryPoints: [path.join(dir, src)], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020', charset: 'utf8', legalComments: 'none', logLevel: 'silent' });
    if (/<\/script/i.test(out.text)) fail('games/' + id + ': the bundle contains "</script" and cannot be inlined');
    html = html.replace(tag, () => '<script>' + out.text.trim() + '</script>');
  }
  return html;
}

/* ---------- public game page with the lock and the link preview ---------- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function gamePage(id, g) {
  const vals = {
    title: g.title, description: g.description, image: g.image,
    shareTitle: g.shareTitle || g.title, shareDescription: g.shareDescription || g.description, imageAlt: g.imageAlt || g.title,
    imageUrl: homepage().replace(/\/?$/, '/') + id + '/' + g.image, emoji: g.emoji || '🎮', theme: g.theme || '#e4e2f0'
  };
  return fs.readFileSync(P.template, 'utf8')
    .replace('{{idJson}}', JSON.stringify(id))
    .replace(/\{\{(\w+)\}\}/g, (_, k) => k in vals ? esc(vals[k]) : fail('Template: unknown field ' + k));
}

/* ---------- password-free site validation (also run by CI) → list of problems ---------- */
export function checkSite() {
  const problems = [], bad = msg => problems.push(msg);
  const sealed = f => exists(f) && fs.statSync(f).size > 28;   // iv (12) + tag (16) + payload
  let kr = null;
  try { kr = JSON.parse(fs.readFileSync(P.keyring, 'utf8')); } catch (e) { bad(rel(P.keyring) + ': ' + e.message); }
  if (kr) {
    if (kr.v !== 1 || !kr.kdf?.salt || !(kr.kdf.iterations >= 100000)) bad('keyring.json: invalid header');
    if (!kr.people?.length) bad('keyring.json: no people');
    for (const p of kr.people || []) if (!(p.id && p.pub && p.priv && p.name && p.box?.epk && p.box?.ct)) bad('keyring.json: incomplete entry ' + (p.id || '?'));
  }
  if (!sealed(sitePath('library.bin'))) bad('missing docs/library.bin');
  for (const f of ['index.html', 'lib/lock.js', 'lib/vault.js', 'lib/keystore.js', 'lib/style.css']) if (!exists(sitePath(f))) bad('missing docs/' + f);
  const games = fs.readdirSync(P.site).filter(d => exists(sitePath(d, 'game.bin')));
  if (!games.length) bad('no games in docs/');
  for (const id of games) {
    if (!sealed(sitePath(id, 'game.bin'))) bad('docs/' + id + '/game.bin is empty');
    if (!exists(sourcePath(id))) bad('vault/' + id + '.bin: missing encrypted sources');
    if (!exists(sitePath(id, 'index.html'))) { bad('missing docs/' + id + '/index.html'); continue; }
    const html = fs.readFileSync(sitePath(id, 'index.html'), 'utf8'), img = html.match(/class="cover" src="([^"]+)"/)?.[1];
    if (/\{\{\w+\}\}/.test(html)) bad('docs/' + id + '/index.html: unfilled template');
    if (!img || !exists(sitePath(id, img))) bad('docs/' + id + ': missing image ' + (img || ''));
  }
  for (const id of sourceIds()) if (!games.includes(id)) bad('vault/' + id + '.bin exists but docs/ has no such game');
  // plaintext game files must never reach the site
  for (const f of walk(P.site)) if (/\.(m?js|css|html)$/.test(f) && !/^(index\.html|lib\/[\w-]+\.(js|css)|[\w-]+\/index\.html)$/.test(f)) bad('docs/' + f + ': looks like a plaintext game file');
  return { problems, games: games.length, people: kr?.people?.length || 0 };
}
