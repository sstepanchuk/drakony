# 🎲 Ihroteka

A tiny private game library. Password-protected, end-to-end encrypted, hosted on GitHub Pages.

**[Open](https://sstepanchuk.github.io/mini-games/)** · [🐉 Two Dragons](https://sstepanchuk.github.io/mini-games/dragons/)

## How it works

- Games and their sources are stored only encrypted (AES-256-GCM).
- Each person has their own password and ECDH P-256 key pair; the password unlocks the private key, which unlocks the library key.
- Removing someone rotates the library key and re-encrypts everything.
- Every game has its own public link preview; the game itself opens only after sign-in.

## Layout

```
docs/    published site (deployed by GitHub Actions)
vault/   encrypted game sources
games/   plaintext sources (local only, git-ignored)
tools/   cli.js (commands) · lib/repo.js (keys, sealed files) · lib/build.js (bundling, checks) · lib/dev.js
```

## Usage

```sh
npm install
npm run unlock              # decrypt sources into games/
npm run dev                 # serve games/ at localhost:8000
npm run build               # bundle, encrypt, update docs/ and vault/
npm run check               # validate docs/ (runs in CI before every deploy)

npm run user -- list | add <name> | remove <name> | passwd
```

Set `VAULT_PASSWORD` to skip the prompt.

## Adding a game

```
games/<id>/          <id> becomes the URL: /<id>/
  game.json          title, tagline, description, image (+ optional shareTitle,
                     shareDescription, imageAlt, emoji, theme) — validated on build
  index.html         <script type="module"> and <link rel="stylesheet"> are bundled inline
  preview.png        1200×630, used on the shelf and in link previews
```

Then `npm run build`, commit, push.

## Game API

Every game gets `window.ihroteka`, injected before its own code (in builds and in `npm run dev`):

```js
ihroteka.version     // 1
ihroteka.game        // { id, title }
ihroteka.libraryUrl  // the shelf
ihroteka.home()      // back to the library
```

Treat it as optional — it is `undefined` when a game runs standalone:

```js
if (window.ihroteka) backButton.onclick = () => ihroteka.home();
```

**Deploy:** every push to `main` is checked and published by GitHub Actions (Settings → Pages → Source: *GitHub Actions*).
