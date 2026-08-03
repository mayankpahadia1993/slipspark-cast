# SlipSpark Custom Web Receiver

This static receiver renders positioning and fight state on Chromecast and Google TV. The iPhone remains the only camera and motion controller; messages contain normalized pose coordinates and deterministic game state, never frames.

Production URL: `https://mayankpahadia1993.github.io/slipspark/`

Local preview:

```sh
python3 -m http.server 8765 --directory CastReceiver
open 'http://localhost:8765/?preview=fight'
```

Contract tests:

```sh
node --test CastReceiverTests/receiver-core.test.cjs
```

Google Cast setup requires a registered Custom Receiver using the production URL. Put the issued 8-character receiver application ID in `SLIPSPARK_CAST_APP_ID` in `project.yml`, regenerate the project, and verify that both Bonjour service entries expand to that ID. Keep relay casting disabled in the Cast Developer Console so gameplay state remains local to the selected network.
