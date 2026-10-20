(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RallycadeSharedTV = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  // One TV for an online room (receiver 63, docs/online-rooms.md "One TV for
  // the room"). Phones on the TV's Wi-Fi join the same Cast session, and the
  // TV follows the batting phone: whoever it is draws the stadium as it does
  // alone, phone to TV, so the picture never crosses the room server.
  //
  // For a moment two phones are on the TV at once: the new batter has joined
  // and the last one (held, sending only its match card) has not yet heard
  // and left. Up to receiver 62 the last phone to send anything drew, so the
  // two would flicker and the held phone's clock pings would move the
  // stadium's clock. Now one phone owns the TV:
  //
  // - A scene `hello` with `claim: 1` (a phone that is not held), or a
  //   `claim {on: 1}` when a phone already on the TV is not held any more,
  //   takes it.
  // - `claim {on: 0}` from the owner: it is held now, and keeps the TV until
  //   a claim takes it (a remote batter: the room's card stays up).
  // - A hello with `claim: 0` never takes it from another phone; one that
  //   says nothing (older phones) takes it unless the owner claims.
  // - Anything else is taken only from the owner, or from anyone when nobody
  //   owns the TV (a single phone, as before).
  // - Each phone's last game state is kept, so a batter whose state came
  //   before its hello shows it the moment it claims.
  //
  // The cases are shared with the phones: shared/online/shared-tv-cases.json.
  function createSharedTV() {
    let owner = null, claiming = false;
    const lastGame = new Map();

    function take(sender, claims) {
      const changed = owner !== sender;
      owner = sender;
      claiming = claims;
      return changed;
    }

    // Returns {accept, replay}: whether to act on the message, and a game
    // state to draw now because its sender just took the TV.
    function receive(sender, namespace, message) {
      const data = message && typeof message === "object" ? message : {};
      if (namespace === "game") {
        lastGame.set(sender, message);
        if (owner === null) take(sender, false);
        return { accept: owner === sender, replay: null };
      }
      let took = false;
      if (data.t === "hello") {
        if (owner === null || owner === sender || data.claim === 1 || (data.claim === undefined && !claiming)) {
          took = take(sender, data.claim === 1);
        } else {
          return { accept: false, replay: null };
        }
      } else if (data.t === "claim") {
        if (data.on === 1) took = take(sender, true);
        else if (owner === sender) claiming = false;
        else return { accept: false, replay: null };
      } else if (owner === null) {
        took = take(sender, false);
      } else if (owner !== sender) {
        return { accept: false, replay: null };
      }
      return { accept: true, replay: took && lastGame.has(sender) ? lastGame.get(sender) : null };
    }

    function disconnected(sender) {
      lastGame.delete(sender);
      if (sender === owner) { owner = null; claiming = false; }
    }

    return { receive, disconnected, owner: () => owner, claiming: () => claiming };
  }
  return { createSharedTV };
});
