# Rallycade Custom Web Receiver

This static receiver shows Rallycade on Chromecast and Google TV. The iPhone remains the only camera and motion controller.

- **Picture** (`urn:x-cast:com.slipspark.video`, `receiver-video.js`): the iPhone streams its own screen (ReplayKit in-app capture, H.264 Main profile at 1280 wide, up to 30 fps, about 1.5 Mbit/s) as fragmented MP4. Each frame is one moof+mdat fragment placed back to back on the timeline, in base64 JSON messages of at most 32,000 characters (larger keyframes arrive in parts and are rejoined). The SPS says frames are never reordered, so the decoder shows each one as soon as it has it. Media Source Extensions play the frames. A Chromecast's player starts only once it holds about a second of picture, and a jump makes it gather that second again. So the receiver leaves it alone until it plays, then holds about 0.25 s behind the newest frame by speed (1.15× to catch up, 0.95× to ease off). It jumps only when more than 3 s behind, at most every 10 s. Measured on a Chromecast Ultra: smooth at 0.24-0.36 s behind; see docs/TESTING.md, build 91.
  - Phone → TV: `hello` (TestFlight builds add `debug: 1`, and the TV shows the stream's counters in a corner), `init` (codec and initialization segment; each one starts a fresh player), `frag`, `alive` (once a second while the screen is still), `stop`.
  - TV → phone: `ready` (whether it can play `avc1.4D001F`, the receiver version and user agent), `ack` (every fifth frame; the phone holds frames back past 15 unacknowledged), `need-key` (after lost data or a player error), `need-init` (frames arrived without an opening), `stats` (every 3 s: frames in, played and waiting for a keyframe, the player's state, how far behind, decoded and dropped frames, recoveries, last error), `error` (where and what failed, including script errors), `unsupported` (with a reason).
  - The phone writes all of this, and its own stream counters every 5 s, to its diagnostic log ("cast", "cast video", "cast tv" lines), which TestFlight builds can copy from Settings.
  - The picture is what the phone shows, so it includes Self-view when that is on. It travels only over the local Cast connection.
- **Scoreboard** (`urn:x-cast:com.slipspark.game`, `receiver.js`): positioning, boxing, cricket, 1v1, results and cricket-duel state as normalized pose coordinates and game state. It shows whenever no picture is live, for example before the stream starts or on a Chromecast that can't play it.

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
node --test CastReceiverTests/receiver-core.test.cjs
```

Google Cast setup requires a registered Custom Receiver using the production URL. Put the issued 8-character receiver application ID in `RALLYCADE_CAST_APP_ID` in `project.yml`, regenerate the project, and verify that both Bonjour service entries expand to that ID. Keep relay casting disabled in the Cast Developer Console so gameplay state remains local to the selected network.

Registered receiver ID: `CE947E6B`.
