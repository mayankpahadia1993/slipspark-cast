# RallyCade Custom Web Receiver

This static receiver shows RallyCade on Chromecast and Google TV. The phone (iPhone or Android) remains the only camera and motion controller.

- **Stadium** (`urn:x-cast:com.slipspark.scene`, `receiver-scene.js`, `receiver-scene-core.js`): since build 121 the TV draws the innings itself from drawing commands the phone sends (about 7 KB a frame, 30 a second), on a clock synced to the phone's, with the HUD laid out in HTML over the canvas. Nothing is recorded. The stadium's pictures come from `scene-images/` (exported from the app) or, for anything else, from the phone in parts, kept in IndexedDB. Since receiver 46 (build 134) the canvas is drawn 1920 wide on Android TV devices (Google TV Streamer, Chromecast with Google TV) and drops to 1280 for good if it falls under 25 frames a second; the Chromecast dongles (up to the Ultra) stay at 1280. Only phones whose `hello` carries `"wide":1` (build 134 on) get 1920; older phones, the App Store's 2.6 among them, keep the 1280 canvas. Pictures are drawn into the rect their key names (`bowler-3-119x301`), so a sharper file can replace a bundled one under the same key. Protocol, timing and testing: `docs/design/CAST_SCENE.md`.
- **Scorecard pictures** (`receiver-card-core.js`, receiver 50, build 154): result screens are the phone's own result screen, drawn on the phone and sent as a JPEG in checksummed `card` parts on the scene channel. Since receiver 51 a picture may come twice under one id (a small draft, then the sharp picture), the newest whole one shows, the TV waits up to 4 s on the phone's backdrop, and a scorecard drawn again keeps its last picture until the new one is in. The HTML result shows if no picture arrives in time, and for older phones. See `docs/design/CAST_SCENE.md`.
- **Live batter** (receiver 51, build 157): the phone draws frames 0.15 s ahead, but the batter, which follows the camera, comes on its own in `b` messages drawn for now. The receiver draws the newest one into each frame's `["B"]` slot as soon as it arrives, and says it can with `live: 1` in `ready`. `stats` report the age of the batter's pose on screen (`pose`, `pose90`). See `docs/design/CAST_SCENE.md`.
- **Setup picture** (receiver 52, build 158): the stadium setup before an innings is the phone's own setup screen too, sent as `card` parts to a receiver that says `setup: 1`. Each part carries `ring: [x, y, d]`, where the hold ring is on the picture, and the receiver draws `positioning.progress` there live. The HTML setup shows if no picture arrives in 4 s, and for older phones. The HUD's pause and lost cards use the phone's measures. See `docs/design/CAST_SCENE.md`, "The setup as a picture".
- **Drawn ahead** (receiver 55): the phone may draw the live batter's backlift ahead by its pose's age (`ph` in `b`, at most `chromecast.predictMs`) when the receiver says `predict: 1`. The receiver draws nothing differently; it reports `ahead` and `eff`/`eff90` (the pose's age less the forecast) in its stats. See "Drawn ahead" in `docs/design/CAST_SCENE.md`.
- **Welcome** (receiver 56, `receiver-welcome.js`): while the phone plays its app-open welcome, the ready state carries `welcome` (id, full or short, Reduce Motion, how far in, the commentator's lines and when the TV hands back). The receiver plays it itself over the ready screen: `welcome-stadium.jpg` dark, the four floodlights striking with a flicker and a glow, the logo landing, the captions (the voice stays on the phone). A short welcome is a caption over the ready screen. Older phones send none; older receivers ignore it. Preview: `?preview=welcome` (or `welcomeShort`), `&at=1.3` to hold a moment.
- **Drawing cheaply** (receiver 57): on a Chromecast Ultra any canvas `filter: blur()` cost 370–400 ms a draw and a picture whose decoded copy the TV had dropped was decoded again on the page's thread (30–190 ms each), so iOS 161's contact flash froze the TV for 0.4 s at every hit and its stadium opened on a 3.2 s frame. The receiver now draws a blurred plain shape as its own shadow (anything else blurred in a small canvas), can decode its pictures once into ImageBitmaps (off by default since receiver 59: holding them made the Chromecast refuse a quick relaunch sooner), clears and composites layers only where something was drawn, skips layers that change nothing, shows iOS's stage-clipped stadium photo on its GPU layer, composites the broadcast shading as two thirds, and writes only what changed into the HUD. `x` in `hello` (the bench's `X=`) switches each back for A/B runs. See "Drawing cheaply on a Chromecast" in `docs/design/CAST_SCENE.md`.
- **The innings' first screens** (receiver 60, Oct 15 2026): pictures load from page load, the first frame's first (stadium photos, batter and the kit the hello names, bowler, fielders, the rest, cached); the stadium photos' GPU layers are made as they load; the phone's setup picture stays over a stadium still loading until a frame is whole and its photo layer has shown (at most 3 s); cards become bytes as `data:` addresses, checksummed part by part; a `shown` message tells the phone when each picture went up. See "The innings' first screens" in `docs/design/CAST_SCENE.md`.
- **Inset atlases** (Oct 20 2026): the bowler's-end inset's 75 transparent pictures load as three atlases (`scene-images/atlas-bowler-end-*.png`, `atlases.json`, made by `scripts/cast-inset-atlas.mjs`) with the first frame's pictures, not one by one through the first innings; each is still drawn, offered in `have` and asked for by its own key, and its own file stays the fallback. See "The inset's atlases" in `docs/design/CAST_SCENE.md`.
- **Steady sooner, cheaper draws** (receiver 67, build 215): a TV that never draws 25 a second (the owner's Chromecast Ultra at 19–21.5) is `steady` 3 s after its first whole frame when its last second is within 15% of the first of those three (5.7–8 s before), and a draw clears only where the draw before drew and copies only the static layer's own parts (`x.dirty: 0` for the whole canvas): about a quarter less per draw, the same pixels. See "The pace with memory" in `docs/design/CAST_SCENE.md`.
- **Pictures it holds** (receiver 67, build 215): `ready` says how many of the phone's pictures it keeps (`held: 3`) and which (`cards`), a `held` message repeats that after each change, a re-sent draft never replaces its sharp picture, and a picture the state names that it lacks is asked for (`want`). A build 215 phone sends none it holds (innings 2's flipping setup: 1.9 MB → 0.85 MB). See "Pictures the TV holds" in `docs/design/CAST_SCENE.md`.
- **The setup's picture goes once the stadium draws** (receiver 70, t4yvzm24/r7ak7c4w): it was held all innings under the stadium (the card at z-index 11 under the scene's 12), composited every frame; an Ultra drew those innings at ~21–25 a second against 28–30 after a reconnect. Now `onCover` from receiver-scene.js ends the hold when the stadium uncovers: the card hides and its pictures go (`held` tells the phone). Bench: three innings after two pictures, 25 → 28 a second, frame gaps 51 → 41 ms.
- **No picture held until steady** (receiver 70, the owner: "getting the tv ready screen takes a long time and the circle keeps on restarting"): the stadium shows at its first whole frame once its photo layers have shown; steadiness (`steady`) is watched on the stadium itself. Ultra: steady at ~30 a second in 2.4–3.6 s, was 20 after 3–4 s or 10 s.
- **The level in the scorebug** (receiver 69, r7ak7c4w): the HUD's optional `level` (`{title, value}`: `BOWLING` and Easy, Medium, Hard or Legend; `LEVEL` in a friend's match) shows beside the overs behind a hairline, as on the phone. Phones from this change on send it wherever their own scorebug shows it (not in the Nets or a timing check; the boundary over sends the TV no scorebug); older phones send none and older receivers skip it. `shared/home/difficulty-label.json`.
- **The level in every game** (receiver 71, Oct 24 2026, the owner: "Let's show the level everywhere including innings, friends, nets, cups etc"): phones from this change on send `level` in every game. The Nets (always Easy) and a timing check (Medium) show it beside the ball in their card (`#hud-check-level`), in the scorebug's column. The boundary over sends the TV no scorebug, so the level gets a card of its own where the scorebug would be (`#hud-level-card`), with the boundary line under it. With no `level` (older phones), none shows. `shared/home/difficulty-label.json`.
- **THIS OVER, ball by ball** (receiver 71, the owner: "Instead can we show what happened, 4,6, wickets, 1,2,3 etc"): the HUD's `overBalls` (each ball's glyph in order: "1"–"6", "•", "W", "wd") and `overLeft` (legal balls to come) draw a chip per ball (4 and 6 the boundary gold, W the wicket red, a dot and a wide quiet, other runs cream) then an empty ring per ball to come, in the boundary over too (`receiver-scene-core.js` `overStrip`). Eight fit at full size (six balls and two wides); more are drawn smaller. Only the chips that changed are rewritten. The card is a little tighter round the chips so the speed gun under it still clears the replay's timing card. Phones without `overBalls` keep the six dots from `over`, and older receivers ignore the new fields. `shared/stadium/this-over.json`; the layout at 720p and 1080p is checked in headless Chrome (`CastReceiverTests/receiver-hud-render.test.cjs`, `RECEIVER_SHOTS=<folder>` saves pictures).
- **Picture** (`urn:x-cast:com.slipspark.video`, `receiver-video.js`): builds 89–120 streamed the phone's own screen (ReplayKit, H.264, fragmented MP4 over Cast messages, Media Source Extensions). Kept so those builds still work; nothing newer sends it.
- **Game state** (`urn:x-cast:com.slipspark.game`, `receiver.js`): home, setup, results, the innings break and cricket-duel screens. Play has no HTML board (Oct 18 2026): cricket is the stadium; before its first frame, or for a phone older than build 121, a branded holding screen (score and ball); with the stadium off mid-play its last frame stays with a chip ("Reconnecting…"). Boxing (flagged off) gets the holding screen.
- **Weak plan** (32-bit Chromecasts, `Linux armv7l`): an 854 canvas, no blended redraws, unblurred glows, `weak: 1` in `ready` so the phone sends at the TV's pace. See "A 32-bit Chromecast at a party" in `docs/design/CAST_SCENE.md`.

## Background music

`urn:x-cast:com.slipspark.music` is an optional channel. A version-1 hello
acknowledges support before either phone pauses its local theme. Only then does
the receiver play its bundled `music/music-theme.m4a`, byte-identical to the apps’
original theme. Older receivers leave music on the phone. The same screen,
volume, mute, other-music and commentary/ring duck rules still decide its level.
Gameplay remains free of background music. Commentary and effects keep their
existing output; this channel carries only the background bed.

Commands contain an ephemeral session, increasing sequence, position, volume,
fade and a three-second expiry on the receiver’s measured clock. A healthy phone
renews the lease; shutdown, sender departure, decoding failure or an expired
lease stops audio. Reordered/expired commands and other senders cannot restart
it. Phone fallback waits for a stopped acknowledgement or the last lease plus
its clock/round-trip margin, so the two outputs do not play together.

Receiver files share cache revision 63. Deployment of this receiver and updated
iOS/Android apps is required for TV playback; this source change deploys nothing.
See [the feedback validation record](../docs/cast-music-feedback.md).

Production URL: `https://www.mysticoai.com/slipspark-cast/`

The MysticoAI site keeps the public receiver URL on the product domain and
proxies it to the tested static receiver deployed from this directory.

Local preview:

```sh
python3 -m http.server 8765 --directory CastReceiver
open 'http://localhost:8765/?preview=fight'
```

Contract tests:

```sh
node --test CastReceiverTests/*.cjs
```

Drawing parity with the phone and a real-Chromecast bench: `scripts/cast-scene-check.sh` and `scripts/cast-scene-bench.py` (see `docs/design/CAST_SCENE.md`).

Google Cast setup requires a registered Custom Receiver using the production URL. The receiver application ID is `SLIPSPARK_CAST_APP_ID` in `project.yml` (per configuration) and `CAST_APP_ID` in `android/app/build.gradle.kts` (per build type); regenerate the project and verify that both Bonjour service entries expand to that ID. Keep relay casting disabled in the Cast Developer Console so gameplay state remains local to the selected network.

Registered receiver IDs: `CE947E6B` (production, the site's root: Release builds) and `9AFC369F` ("RallyCade Staging", unpublished, the site's `staging/` folder: Debug builds and the bench scripts, registered TVs only). `scripts/deploy-cast-receiver.sh --staging` publishes this folder to `staging/`, `--promote` moves it to production. Served from a `staging/` folder the receiver keeps its own localStorage and IndexedDB names. See "Chromecast environments" in `docs/design/CAST_SCENE.md`.
