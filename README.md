# Rallycade Custom Web Receiver

This static receiver shows Rallycade on Chromecast and Google TV. The iPhone remains the only camera and motion controller.

- **Stadium** (`urn:x-cast:com.slipspark.scene`, `receiver-scene.js`, `receiver-scene-core.js`): since build 121 the TV draws the innings itself from drawing commands the phone sends (about 7 KB a frame, 30 a second), on a clock synced to the phone's, with the HUD laid out in HTML over the canvas. Nothing is recorded. The stadium's pictures come from `scene-images/` (exported from the app) or, for anything else, from the phone in parts, kept in IndexedDB. Since receiver 46 (build 134) the canvas is drawn 1920 wide on Android TV devices (Google TV Streamer, Chromecast with Google TV) and drops to 1280 for good if it falls under 25 frames a second; the Chromecast dongles (up to the Ultra) stay at 1280. Only phones whose `hello` carries `"wide":1` (build 134 on) get 1920; older phones, the App Store's 2.6 among them, keep the 1280 canvas. Pictures are drawn into the rect their key names (`bowler-3-119x301`), so a sharper file can replace a bundled one under the same key. Protocol, timing and testing: `docs/design/CAST_SCENE.md`.
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
