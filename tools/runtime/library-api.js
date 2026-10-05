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
  // The shelf leaves a mark when you open a game from it (docs/lib/lock.js). Only then is one step
  // back the shelf; a game opened from a chat link goes to the shelf by address instead.
  var fromShelf = false;
  try { fromShelf = sessionStorage.getItem('ihroteka:shelf') === libraryUrl; sessionStorage.removeItem('ihroteka:shelf'); } catch (e) {}
  var fallback = 0;
  // if the game goes into the back/forward cache, the fallback must not fire when it comes back
  addEventListener('pagehide', function () { clearTimeout(fallback); });
  window.ihroteka = Object.freeze({
    version: 1,
    game: Object.freeze(game),
    libraryUrl: libraryUrl,
    home: function () {
      if (fromShelf && history.length > 1) {
        history.back();                              // the browser restores the shelf instantly
        fallback = setTimeout(function () { location.assign(libraryUrl); }, 700);   // nothing to go back to after all
      } else location.assign(libraryUrl);
    }
  });
})(__GAME__);
