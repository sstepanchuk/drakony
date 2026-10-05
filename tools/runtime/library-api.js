/* Library API, available to every game as `window.ihroteka`.
   The build (and `npm run dev`) inlines this script at the top of the game's <head>,
   before any game code runs. __GAME__ is replaced with { id, title } from game.json.

   Contract (version 1):
     ihroteka.version     1
     ihroteka.game        { id, title }
     ihroteka.libraryUrl  absolute URL of the library shelf
     ihroteka.home()      go back to the library

   Games must treat the API as optional: when a game page is opened on its own
   (no library around it), `window.ihroteka` is undefined. */
(function (game) {
  // every game lives at <library>/<id>/, so the shelf is one level up
  var libraryUrl = new URL('../', location.href).href;
  window.ihroteka = Object.freeze({
    version: 1,
    game: Object.freeze(game),
    libraryUrl: libraryUrl,
    home: function () {
      // came straight from the shelf: step back so the browser restores it instantly
      if (document.referrer && document.referrer.split(/[?#]/)[0] === libraryUrl && history.length > 1) {
        history.back();
        setTimeout(function () { location.assign(libraryUrl); }, 500);   // nothing to go back to after all
      } else location.assign(libraryUrl);
    }
  });
})(__GAME__);
