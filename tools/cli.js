#!/usr/bin/env node
// Library tooling: `node tools/cli.js help`. The password comes from VAULT_PASSWORD or a prompt.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as vault from '../docs/lib/vault.js';
import * as repo from './lib/repo.js';
import { readManifest, bundleGame, gamePage, checkSite } from './lib/build.js';
import { serve } from './lib/dev.js';

const { P, rel, exists, fail, same } = repo;

function ask(question, hidden) {
  const tty = !!process.stdin.isTTY;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  if (hidden && tty) rl._writeToOutput = s => { if (s.startsWith(question)) process.stdout.write(question); };
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    if (hidden && tty) process.stdout.write('\n');
    resolve(answer.trim());
  }));
}
const password = (q = 'Password: ') => process.env.VAULT_PASSWORD || ask(q, true);
const signIn = async () => repo.open(await password());

const HELP = `Library commands

  npm run unlock                 decrypt game sources into games/ (for editing)
  npm run dev [-- docs]          local server for games/ (or the built site in docs/)
  npm run build                  bundle, encrypt and update docs/ and vault/
  npm run check                  validate docs/ before publishing (no password needed)

  npm run user -- list           who has access
  npm run user -- add <name>     add a person (a password is generated and shown once)
  npm run user -- remove <name>  remove a person (rotates the library key, re-encrypts everything)
  npm run user -- passwd         change your password

  node tools/cli.js init <name> …  create a new library (once)

Set VAULT_PASSWORD to skip the password prompt.`;

const commands = {
  help: () => console.log(HELP),

  async init(...names) {
    if (exists(P.keyring)) fail('A library already exists: ' + rel(P.keyring));
    if (!names.length) fail('Give at least one name: node tools/cli.js init <name> …');
    const kr = vault.newKeyring(), raw = vault.newLibraryKey(), key = await vault.importKey(raw);
    console.log('New library. Passwords are shown only once, save them:\n');
    for (const name of names) {
      const pw = repo.makePassword();
      await repo.addPerson(kr, raw, key, name, pw);
      console.log('  ' + name.padEnd(12) + pw);
    }
    repo.writeKeyring(kr);
    console.log('\nNext: npm run build');
  },

  async unlock(...flags) {
    const { key } = await signIn();
    for (const id of repo.sourceIds()) {
      const dir = path.join(P.games, id);
      const files = repo.unpackSource(await repo.readSealed(repo.sourcePath(id), vault.label.source(id), key));
      const changed = files.filter(([f, data]) => exists(path.join(dir, f)) && !same(fs.readFileSync(path.join(dir, f)), data)).map(([f]) => f);
      if (changed.length && !flags.includes('--force')) {
        console.log('! ' + id + ': local files differ (' + changed.join(', ') + '), skipped. Overwrite: npm run unlock -- --force');
        continue;
      }
      for (const [f, data] of files) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), data);
      }
      console.log('✓ ' + rel(dir));
    }
  },

  async build() {
    const ids = repo.gameIds(), missing = repo.sourceIds().filter(id => !ids.includes(id));
    if (missing.length) fail('Decrypt the sources first (npm run unlock): missing games/' + missing.join(', games/'));
    if (!ids.length) fail('No games in games/.');
    const manifests = Object.fromEntries(ids.map(id => [id, readManifest(id)]));   // validate everything before asking for the password
    const { key } = await signIn();
    for (const [id, g] of Object.entries(manifests)) {
      const html = await bundleGame(id, g);
      const changed = [
        await repo.writeSealed(repo.sitePath(id, 'game.bin'), html, vault.label.game(id), key),
        await repo.writeSealed(repo.sourcePath(id), repo.packSource(path.join(P.games, id)), vault.label.source(id), key)
      ].some(Boolean);
      fs.copyFileSync(path.join(P.games, id, g.image), repo.sitePath(id, g.image));
      fs.writeFileSync(repo.sitePath(id, 'index.html'), gamePage(id, g));
      console.log('✓ ' + id + ': ' + (html.length / 1024).toFixed(0) + ' KB' + (changed ? '' : ' (unchanged)'));
    }
    const shelf = Object.entries(manifests).map(([id, g]) => ({ id, title: g.title, tagline: g.tagline, image: g.image, emoji: g.emoji }));
    await repo.writeSealed(repo.sitePath('library.bin'), JSON.stringify(shelf), vault.label.library(), key);
  },

  async user(sub, ...args) {
    const name = args.join(' ');
    if (sub === 'list') {
      const { kr, me, key } = await signIn();
      for (const p of kr.people) console.log((p.id === me.id ? '* ' : '  ') + await repo.nameOf(key, p));
    } else if (sub === 'add') {
      if (!name) fail('npm run user -- add <name>');
      const { kr, raw, key } = await signIn();
      for (const p of kr.people) if (await repo.nameOf(key, p) === name) fail('That name is already taken.');
      const pw = repo.makePassword();
      await repo.addPerson(kr, raw, key, name, pw);
      repo.writeKeyring(kr);
      console.log('✓ ' + name + ' has access. Password (shown once): ' + pw);
    } else if (sub === 'remove') {
      const { kr, me, key } = await signIn();
      const names = await Promise.all(kr.people.map(p => repo.nameOf(key, p)));
      const gone = kr.people.filter((p, i) => names[i] === name);
      if (!gone.length) fail('No such name. See: npm run user -- list');
      if (gone.includes(me)) fail('You cannot remove yourself: sign in with someone else’s password.');
      // the removed person may have kept the library key, so it is replaced and everything re-encrypted
      kr.people = kr.people.filter(p => !gone.includes(p));
      await repo.rotate(kr, key);
      repo.writeKeyring(kr);
      console.log('✓ ' + name + ' no longer has access. Library key rotated, files re-encrypted — commit docs/ and vault/.');
    } else if (sub === 'passwd') {
      const kr = repo.readKeyring(), old = await password('Current password: ');
      const who = await vault.signIn(kr, old);
      if (!who) fail('Wrong password.');
      let pw = await ask('New password (empty to generate): ', true);
      if (!pw) console.log('New password: ' + (pw = repo.makePassword()));
      else if (pw.length < 12) fail('Too short: at least 12 characters. The keyring is public, so short passwords can be brute-forced.');
      else if (await ask('Repeat: ', true) !== pw) fail('Passwords do not match.');
      await vault.changePassword(kr, who.person, old, pw);
      repo.writeKeyring(kr);
      console.log('✓ Password changed. Commit docs/keyring.json.');
    } else fail('npm run user -- list | add <name> | remove <name> | passwd');
  },

  check() {
    const { problems, games, people } = checkSite();
    if (problems.length) { problems.forEach(p => console.error('✗ ' + p)); process.exit(1); }
    console.log('✓ docs/ is valid: ' + games + ' game(s), ' + people + ' people');
  },

  dev: serve
};

const [cmd = 'help', ...rest] = process.argv.slice(2);
if (!commands[cmd]) fail('Unknown command: ' + cmd + '. See: node tools/cli.js help');
Promise.resolve(commands[cmd](...rest)).catch(e => fail(e.stack || e));
