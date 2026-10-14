# RallyCade Custom Web Receiver

This static receiver shows RallyCade on Chromecast and Google TV. The phone (iPhone or Android) remains the only camera and motion controller.

- **Stadium** (`urn:x-cast:com.slipspark.scene`, `receiver-scene.js`, `receiver-scene-core.js`): since build 121 the TV draws the innings itself from drawing commands the phone sends (about 7 KB a frame, 30 a second), on a clock synced to the phone's, with the HUD laid out in HTML over the canvas. Nothing is recorded. The stadium's pictures come from `scene-images/` (exported from the app) or, for anything else, from the phone in parts, kept in IndexedDB. Since receiver 46 (build 134) the canvas is drawn 1920 wide on Android TV devices (Google TV Streamer, Chromecast with Google TV) and drops to 1280 for good if it falls under 25 frames a second; the Chromecast dongles (up to the Ultra) stay at 1280. Only phones whose `hello` carries `"wide":1` (build 134 on) get 1920; older phones, the App Store's 2.6 among them, keep the 1280 canvas. Pictures are drawn into the rect their key names (`bowler-3-119x301`), so a sharper file can replace a bundled one under the same key. Protocol, timing and testing: `docs/design/CAST_SCENE.md`.
- **Scorecard pictures** (`receiver-card-core.js`, receiver 50, build 154): result screens are the phone's own result screen, drawn on the phone and sent as a JPEG in checksummed `card` parts on the scene channel. Since receiver 51 a picture may come twice under one id (a small draft, then the sharp picture), the newest whole one shows, the TV waits up to 4 s on the phone's backdrop, and a scorecard drawn again keeps its last picture until the new one is in. The HTML result shows if no picture arrives in time, and for older phones. See `docs/design/CAST_SCENE.md`.
- **Live batter** (receiver 51, build 157): the phone draws frames 0.15 s ahead, but the batter, which follows the camera, comes on its own in `b` messages drawn for now. The receiver draws the newest one into each frame's `["B"]` slot as soon as it arrives, and says it can with `live: 1` in `ready`. `stats` report the age of the batter's pose on screen (`pose`, `pose90`). See `docs/design/CAST_SCENE.md`.
- **Setup picture** (receiver 52, build 158): the stadium setup before an innings is the phone's own setup screen too, sent as `card` parts to a receiver that says `setup: 1`. Each part carries `ring: [x, y, d]`, where the hold ring is on the picture, and the receiver draws `positioning.progress` there live. The HTML setup shows if no picture arrives in 4 s, and for older phones. The HUD's pause and lost cards use the phone's measures. See `docs/design/CAST_SCENE.md`, "The setup as a picture".
- **Drawn ahead** (receiver 55): the phone may draw the live batter's backlift ahead by its pose's age (`ph` in `b`, at most `chromecast.predictMs`) when the receiver says `predict: 1`. The receiver draws nothing differently; it reports `ahead` and `eff`/`eff90` (the pose's age less the forecast) in its stats. See "Drawn ahead" in `docs/design/CAST_SCENE.md`.
- **Welcome** (receiver 56, `receiver-welcome.js`): while the phone plays its app-open welcome, the ready state carries `welcome` (id, full or short, Reduce Motion, how far in, the commentator's lines and when the TV hands back). The receiver plays it itself over the ready screen: `welcome-stadium.jpg` dark, the four floodlights striking with a flicker and a glow, the logo landing, the captions (the voice stays on the phone). A short welcome is a caption over the ready screen. Older phones send none; older receivers ignore it. Preview: `?preview=welcome` (or `welcomeShort`), `&at=1.3` to hold a moment.
- **Drawing cheaply** (receiver 57): on a Chromecast Ultra any canvas `filter: blur()` cost 370–400 ms a draw and a picture whose decoded copy the TV had dropped was decoded again on the page's thread (30–190 ms each), so iOS 161's contact flash froze the TV for 0.4 s at every hit and its stadium opened on a 3.2 s frame. The receiver now draws a blurred plain shape as its own shadow (anything else blurred in a small canvas), can decode its pictures once into ImageBitmaps (off by default since receiver 59: holding them made the Chromecast refuse a quick relaunch sooner), clears and composites layers only where something was drawn, skips layers that change nothing, shows iOS's stage-clipped stadium photo on its GPU layer, composites the broadcast shading as two thirds, and writes only what changed into the HUD. `x` in `hello` (the bench's `X=`) switches each back for A/B runs. See "Drawing cheaply on a Chromecast" in `docs/design/CAST_SCENE.md`.
- **Picture** (`urn:x-cast:com.slipspark.video`, `receiver-video.js`): builds 89–120 streamed the phone's own screen (ReplayKit, H.264, fragmented MP4 over Cast messages, Media Source Extensions). Kept so those builds still work; nothing newer sends it.
- **Scoreboard** (`urn:x-cast:com.slipspark.game`, `receiver.js`): positioning, boxing, cricket, 1v1, results and cricket-duel state as normalized pose coordinates and game state. It shows whenever the stadium isn't drawn: setup, results, the innings break, boxing, and on phones older than build 121 before their picture starts.

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

Google Cast setup requires a registered Custom Receiver using the production URL. Put the issued 8-character receiver application ID in `RALLYCADE_CAST_APP_ID` in `project.yml`, regenerate the project, and verify that both Bonjour service entries expand to that ID. Keep relay casting disabled in the Cast Developer Console so gameplay state remains local to the selected network.

Registered receiver ID: `CE947E6B`.
