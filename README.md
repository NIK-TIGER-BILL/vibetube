# VibeTube

Auto-pause YouTube when you look away. Resume when you look back.

Made for **vibecoders** and **multitaskers** — those of us who watch a tutorial while writing code, switch tabs to read an error, then come back to find the video has played four minutes without us.

## What it does

- Watches your webcam locally (face detection via [pico.js](https://github.com/nenadmarkus/picojs))
- When you turn your head away for ~4 seconds → video pauses
- When you look back at the screen → video resumes after a short delay
- Manual pause/play (clicking the YouTube play button, pressing space) always takes priority

A small eye icon in the YouTube player controls toggles the whole thing on/off. State is remembered across YouTube sessions.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Click here to install VibeTube: **[vibetube.user.js](https://raw.githubusercontent.com/NIK-TIGER-BILL/vibetube/main/vibetube.user.js)**
3. Open any YouTube video — click the eye icon in the player controls to enable, grant camera permission

Tampermonkey will auto-update from this repo as new versions are pushed.

## Privacy

Everything runs locally in your browser.

- No frames, no detections, no telemetry leave your machine
- Network requests: one — to fetch the face-detection cascade file from jsDelivr (a CDN). After that, no traffic
- The webcam stream is consumed only by the in-browser detector and (optionally) the preview window

If you want to verify, the whole script is ~700 lines of plain JavaScript in [vibetube.user.js](./vibetube.user.js).

## Controls

In the right side of the YouTube player controls you'll see two icons:

| Icon | Meaning |
|---|---|
| Camera | Toggle the preview window (small 160×120 box in the bottom-right showing what the detector sees) |
| Eye | Toggle VibeTube on/off |

A small green dot on the eye = face detected (the video would resume / keep playing). Yellow dot = no face detected (the video is on its way to auto-pause).

## How it works

1. Captures a 320×240 webcam stream at 15 fps
2. Runs [pico.js](https://github.com/nenadmarkus/picojs) frontal-face detection at 10 fps
3. Debounces "away" for 4 s (so glancing at your phone briefly doesn't pause) and "back" for 1.5 s
4. Calls `videoEl.pause()` / `videoEl.play()` on YouTube's main `<video>` element
5. Watches for manual pause/play and yields to it (manual control wins)

## Limitations

- Frontal-face detection only — extreme angles, harsh side-light, or large occlusions (hand on chin) can confuse it
- Requires camera permission per origin (YouTube)
- One face at a time — picks the largest face in frame
- YouTube watch pages only (`youtube.com/watch*`), not Shorts or embeds

## License

MIT — see [LICENSE](./LICENSE).
