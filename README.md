# 🎲 Ihroteka

A tiny private game library. Password-protected, end-to-end encrypted, hosted on GitHub Pages.

**[Open](https://sstepanchuk.github.io/drakony/)** · [🐉 Two Dragons](https://sstepanchuk.github.io/drakony/dragons/)

## How it works

- Games and their sources are stored only encrypted (AES-256-GCM).
- Each person has their own password and ECDH P-256 key pair; the password unlocks the private key, which unlocks the library key.
- Removing someone rotates the library key and re-encrypts everything.
- Every game has its own public link preview; the game itself opens only after sign-in.

## Layout

```
docs/    published site (GitHub Pages → main, /docs)
vault/   encrypted game sources
games/   plaintext sources (local only, git-ignored)
tools/   build & key management
```

## Usage

```sh
npm install
npm run unlock              # decrypt sources into games/
npm run dev                 # serve games/ at localhost:8000
npm run build               # bundle, encrypt, update docs/ and vault/

npm run user -- list | add <name> | remove <name> | passwd
```

Set `VAULT_PASSWORD` to skip the prompt.

**New game:** add `games/<id>/` with `index.html` (ES modules), `game.json` and a 1200×630 `preview.png`, then `npm run build`.
