// ==UserScript==
// @name         VibeTube
// @namespace    https://github.com/NIK-TIGER-BILL/vibetube
// @version      0.5.0
// @description  Auto-pause YouTube when you look away. Made for vibecoders & multitaskers — never lose the thread of a video while you switch context.
// @author       NIK-TIGER-BILL
// @homepageURL  https://github.com/NIK-TIGER-BILL/vibetube
// @supportURL   https://github.com/NIK-TIGER-BILL/vibetube/issues
// @updateURL    https://raw.githubusercontent.com/NIK-TIGER-BILL/vibetube/main/vibetube.user.js
// @downloadURL  https://raw.githubusercontent.com/NIK-TIGER-BILL/vibetube/main/vibetube.user.js
// @license      MIT
// @match        https://www.youtube.com/watch*
// @require      https://cdn.jsdelivr.net/gh/nenadmarkus/picojs@master/pico.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// ==/UserScript==

'use strict';
(() => {
  // ===== Constants =====
  const PAUSE_DEBOUNCE_MS = 4000;
  const RESUME_DEBOUNCE_MS = 1500;
  const YAW_THRESHOLD_DEG = 25;
  const PITCH_THRESHOLD_DEG = 25;
  const DETECTION_FPS = 10;
  const SCRIPT_ACTION_WINDOW_MS = 100;

  const log = (...a) => console.log('[gaze]', ...a);

  // Pinned commit from nenadmarkus/pico — used by the official picojs examples.
  const CASCADE_URL = 'https://cdn.jsdelivr.net/gh/nenadmarkus/pico@c2e81f9d23cc11d1a612fd21e4f9de0921a5d0d9/rnt/cascades/facefinder';

  // ===== Helpers =====

  function fetchCascade() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: CASCADE_URL,
        responseType: 'arraybuffer',
        onload: (r) => {
          if (r.status >= 200 && r.status < 300 && r.response) {
            resolve(new Int8Array(r.response));
          } else {
            reject(new Error('cascade fetch HTTP ' + r.status));
          }
        },
        onerror: (e) => reject(new Error('cascade fetch error: ' + (e && e.error || 'unknown'))),
        ontimeout: () => reject(new Error('cascade fetch timeout')),
      });
    });
  }

  function rgbaToGrayscale(rgba, w, h) {
    const out = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
      out[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
    }
    return out;
  }

  // Persisted on/off state across YouTube sessions, via Tampermonkey storage.
  // Auto-resume happens after the toggle button is injected, so the user can
  // see and override the state immediately if they want it off this session.
  const STATE_KEY = 'gaze:on';
  function loadPersistedState() {
    try {
      return typeof GM_getValue === 'function' && GM_getValue(STATE_KEY, false) === true;
    } catch {
      return false;
    }
  }
  function savePersistedState(on) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STATE_KEY, !!on);
    } catch {}
  }

  // ===== Camera Manager =====
  function createCamera() {
    let stream = null;
    const videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    // No off-screen positioning here — Chrome does not reliably decode frames
    // for off-screen / display:none <video>, which makes drawImage produce
    // black canvases. The Preview module appends videoEl into a visible wrap.

    return {
      getVideoEl: () => videoEl,
      isOn: () => !!stream,
      async start() {
        if (stream) return;
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240, frameRate: 15 },
          audio: false,
        });
        videoEl.srcObject = stream;
        await new Promise((resolve) => {
          if (videoEl.readyState >= 2) resolve();
          else videoEl.addEventListener('loadeddata', resolve, { once: true });
        });
        log('camera started');
      },
      stop() {
        if (!stream) return;
        stream.getTracks().forEach((t) => t.stop());
        videoEl.srcObject = null;
        stream = null;
        log('camera stopped');
      },
    };
  }

  // ===== Preview =====
  // The <video> is rendered directly inside the wrap so the browser keeps
  // decoding frames; the canvas only draws the bbox overlay on top.
  function createPreview(videoEl, getOverlay) {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;right:16px;bottom:16px;width:160px;height:120px;' +
      'background:#000;border:2px solid #555;border-radius:6px;overflow:hidden;' +
      'z-index:99999;display:none;';

    videoEl.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;'
      + 'transform:scaleX(-1);'; // mirror like a webcam preview
    wrap.appendChild(videoEl);

    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;'
      + 'pointer-events:none;';
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    let raf = 0;

    function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const overlay = getOverlay && getOverlay();
      if (overlay && overlay.bbox) {
        const { x, y, w, h } = overlay.bbox;
        const color = overlay.cls === 'frontal' ? '#4caf50' : '#ffc107';
        // Mirror the bbox X to match the mirrored video.
        const mirroredX = 1 - x - w;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(
          mirroredX * canvas.width,
          y * canvas.height,
          w * canvas.width,
          h * canvas.height,
        );
        ctx.fillStyle = color;
        ctx.font = '10px monospace';
        const q = typeof overlay.quality === 'number' ? overlay.quality.toFixed(0) : '-';
        ctx.fillText(`q:${q}`, 4, 12);
      }
      raf = requestAnimationFrame(tick);
    }

    return {
      show() {
        wrap.style.display = 'block';
        wrap.style.opacity = '1';
        wrap.style.pointerEvents = 'auto';
        if (!raf) raf = requestAnimationFrame(tick);
      },
      // Visually hide while keeping the wrap in the rendering tree, so the
      // <video> child keeps decoding frames for the detector. display:none
      // would freeze frames and blind the detector.
      hide() {
        wrap.style.display = 'block';
        wrap.style.opacity = '0';
        wrap.style.pointerEvents = 'none';
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      // Fully tear down — only used when the camera is also being stopped.
      stop() {
        wrap.style.display = 'none';
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
    };
  }

  // ===== Preview toggle button =====
  function createPreviewToggle(preview) {
    const btn = document.createElement('button');
    btn.className = 'ytp-button gaze-preview-toggle is-off';
    btn.setAttribute('aria-label', 'Toggle camera preview');
    btn.style.visibility = 'hidden';

    // Two paths in the same SVG: .icon-on is the videocam glyph, .icon-off is
    // the videocam_off glyph (camera with a diagonal slash). CSS shows one or
    // the other based on the .is-off class on the button — no JS DOM swap
    // needed when state changes.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');

    const pathOn = document.createElementNS(SVG_NS, 'path');
    pathOn.setAttribute('class', 'icon-on');
    pathOn.setAttribute('fill', 'currentColor');
    pathOn.setAttribute(
      'd',
      'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12'
      + 'c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z',
    );

    const pathOff = document.createElementNS(SVG_NS, 'path');
    pathOff.setAttribute('class', 'icon-off');
    pathOff.setAttribute('fill', 'currentColor');
    pathOff.setAttribute(
      'd',
      'M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5z'
      + 'M3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12'
      + 'c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z',
    );

    svg.appendChild(pathOn);
    svg.appendChild(pathOff);
    btn.appendChild(svg);

    // Preview starts hidden when the gaze toggle is enabled — the user opts
     // in by clicking. preview.hide() still keeps the wrap as display:block
     // (opacity 0), so the <video> child remains in the rendering tree and
     // the detector keeps getting decoded frames.
    let visible = false;

    function refresh() {
      btn.title = visible ? 'Hide camera preview' : 'Show camera preview';
      btn.classList.toggle('is-off', !visible);
    }

    btn.addEventListener('click', () => {
      visible = !visible;
      if (visible) preview.show();
      else preview.hide();
      refresh();
    });

    return {
      el: btn,
      activate() {
        btn.style.visibility = 'visible';
        visible = false;
        preview.hide();
        refresh();
      },
      deactivate() {
        btn.style.visibility = 'hidden';
        preview.stop();
      },
    };
  }

  // ===== LED indicator =====
  // Implemented as a child <circle> inside the toggle's SVG so it positions
  // in the icon's own user-space coordinates (viewBox 0 0 24 24). This way
  // the LED rides on the eye icon at a fixed offset regardless of how the
  // button is sized or which centering layout the player applies. No
  // position:absolute on the button — keeps the button's DOM identical in
  // shape to standard YouTube control buttons.
  function createLed() {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const led = document.createElementNS(SVG_NS, 'circle');
    led.setAttribute('class', 'gaze-led');
    led.setAttribute('cx', '21');
    led.setAttribute('cy', '3.5');
    led.setAttribute('r', '2.4');
    led.setAttribute('stroke', 'rgba(0, 0, 0, 0.7)');
    led.setAttribute('stroke-width', '1.1');
    led.setAttribute('fill', '#666');
    led.setAttribute('visibility', 'hidden');
    return {
      el: led,
      setActive(active) {
        led.setAttribute('visibility', active ? 'visible' : 'hidden');
      },
      setClass(cls) {
        led.setAttribute('fill', cls === 'frontal' ? '#4caf50' : '#ffc107');
      },
    };
  }

  // ===== Detector (pico.js) =====
  // pico.js is loaded via @require and exposes the global `pico` object with
  // unpack_cascade / instantiate_detection_memory / run_cascade / update_memory
  // / cluster_detections. The frontal-face cascade detects only when the user
  // is roughly facing the camera — when the head is significantly turned, the
  // detector loses the face. So "detected" ≈ "frontal", "not detected" ≈ "away".
  // YAW_THRESHOLD_DEG / PITCH_THRESHOLD_DEG are unused with this backend but
  // kept as constants for documentation.

  // Pico tuning. PICO_MIN_QUALITY raises the bar for "is this a face" — too
  // low and looking away is no longer detected; too high and partial occlusions
  // (hand on chin) drop the signal. PICO_MEMORY_FRAMES smooths over very brief
  // detection misses but adds equal latency to genuine look-aways.
  const PICO_MIN_QUALITY = 50.0;
  const PICO_DET_MIN_SIZE = 80;
  const PICO_DET_MAX_SIZE = 1000;
  const PICO_MEMORY_FRAMES = 5;

  function createDetector(getVideoEl, onClassChange) {
    let cascade = null;
    let updateMemory = null;
    let intervalId = 0;
    let lastClass = null;
    let lastInfo = null;

    const tmp = document.createElement('canvas');
    tmp.width = 320;
    tmp.height = 240;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });

    return {
      async start() {
        if (cascade) return;
        if (typeof pico === 'undefined' || !pico.unpack_cascade) {
          throw new Error('pico.js not loaded (check @require)');
        }
        log('loading cascade...');
        const bytes = await fetchCascade();
        cascade = pico.unpack_cascade(bytes);
        // instantiate_detection_memory returns the update_memory function itself;
        // call it directly as updateMemory(dets) — there is no pico.update_memory.
        updateMemory = pico.instantiate_detection_memory(PICO_MEMORY_FRAMES);
        log('cascade loaded');
        lastClass = null;

        intervalId = setInterval(() => {
          const v = getVideoEl();
          if (!v || v.readyState < 2 || !cascade) return;

          tctx.drawImage(v, 0, 0, tmp.width, tmp.height);
          const img = tctx.getImageData(0, 0, tmp.width, tmp.height);
          const gray = rgbaToGrayscale(img.data, tmp.width, tmp.height);
          const image = {
            pixels: gray,
            nrows: tmp.height,
            ncols: tmp.width,
            ldim: tmp.width,
          };
          const params = {
            shiftfactor: 0.1,
            minsize: PICO_DET_MIN_SIZE,
            maxsize: PICO_DET_MAX_SIZE,
            scalefactor: 1.1,
          };

          let dets = pico.run_cascade(image, cascade, params);
          dets = updateMemory(dets);
          dets = pico.cluster_detections(dets, 0.2);
          const good = dets.filter((d) => d[3] >= PICO_MIN_QUALITY);
          // Pick the LARGEST face (biggest s) — assume the user is closer to
          // the camera than anyone else who happens to walk through the frame
          // behind them. Discards mid-room faces, reflections, photos, etc.
          good.sort((a, b) => b[2] - a[2]);

          const facePresent = good.length > 0;
          let bbox = null;
          let quality = 0;
          if (facePresent) {
            // d = [r, c, s, q]: row, col, size in image pixels; q = confidence
            const [r, c, s, q] = good[0];
            quality = q;
            bbox = {
              x: (c - s / 2) / tmp.width,
              y: (r - s / 2) / tmp.height,
              w: s / tmp.width,
              h: s / tmp.height,
            };
          }

          const cls = facePresent ? 'frontal' : 'away';
          // yawDeg/pitchDeg kept as 0 for compatibility with preview overlay
          lastInfo = { cls, facePresent, yawDeg: 0, pitchDeg: 0, bbox, quality };
          if (cls !== lastClass) {
            lastClass = cls;
            onClassChange(cls, lastInfo);
          }
        }, Math.round(1000 / DETECTION_FPS));
      },
      stop() {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = 0;
        }
        cascade = null;
        updateMemory = null;
        lastClass = null;
        lastInfo = null;
        log('detector stopped');
      },
      getLast: () => lastInfo,
    };
  }

  // ===== State Machine =====
  function createFsm({ onPauseRequested, onPlayRequested }) {
    let manualPaused = false;
    let autoPaused = false;
    let videoIsPlaying = false;
    let pauseTimer = 0;
    let resumeTimer = 0;

    function clearTimers() {
      if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = 0; }
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = 0; }
    }

    return {
      onClass(cls) {
        if (cls === 'away') {
          if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = 0; }
          if (pauseTimer) return;
          pauseTimer = setTimeout(() => {
            pauseTimer = 0;
            if (manualPaused) return;
            if (!videoIsPlaying) return;
            autoPaused = true;
            log('FSM → pause');
            onPauseRequested();
          }, PAUSE_DEBOUNCE_MS);
        } else if (cls === 'frontal') {
          if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = 0; }
          if (resumeTimer) return;
          resumeTimer = setTimeout(() => {
            resumeTimer = 0;
            if (manualPaused) return;
            if (!autoPaused) return;
            autoPaused = false;
            log('FSM → play');
            onPlayRequested();
          }, RESUME_DEBOUNCE_MS);
        }
      },
      onUserPause() {
        manualPaused = true;
        autoPaused = false;
        clearTimers();
        videoIsPlaying = false;
        log('FSM: manual pause');
      },
      onUserPlay() {
        manualPaused = false;
        autoPaused = false;
        videoIsPlaying = true;
        log('FSM: manual play');
      },
      setVideoPlaying(v) {
        videoIsPlaying = v;
      },
      reset() {
        manualPaused = false;
        autoPaused = false;
        clearTimers();
        videoIsPlaying = false;
      },
    };
  }

  // ===== YouTube Controller =====
  function createYouTubeController(fsm) {
    let videoEl = null;
    let scriptActionAt = 0;
    let onPauseHandler = null;
    let onPlayHandler = null;
    let bodyObs = null;

    function bindTo(el) {
      if (videoEl === el) return;
      if (videoEl && onPauseHandler) {
        videoEl.removeEventListener('pause', onPauseHandler);
        videoEl.removeEventListener('play', onPlayHandler);
      }
      videoEl = el;
      if (!videoEl) return;

      onPauseHandler = () => {
        if (performance.now() - scriptActionAt < SCRIPT_ACTION_WINDOW_MS) return;
        fsm.onUserPause();
      };
      onPlayHandler = () => {
        if (performance.now() - scriptActionAt < SCRIPT_ACTION_WINDOW_MS) return;
        fsm.onUserPlay();
      };
      videoEl.addEventListener('pause', onPauseHandler);
      videoEl.addEventListener('play', onPlayHandler);
      fsm.setVideoPlaying(!videoEl.paused);
      log('youtube controller bound to <video>');
    }

    function rebind() {
      const el = document.querySelector('video.html5-main-video');
      if (el && el !== videoEl) {
        bindTo(el);
        fsm.reset();
        if (el && !el.paused) fsm.setVideoPlaying(true);
      }
    }

    return {
      start() {
        rebind();
        bodyObs = new MutationObserver(rebind);
        bodyObs.observe(document.body, { childList: true, subtree: true });
      },
      stop() {
        if (bodyObs) {
          bodyObs.disconnect();
          bodyObs = null;
        }
        if (videoEl && onPauseHandler) {
          videoEl.removeEventListener('pause', onPauseHandler);
          videoEl.removeEventListener('play', onPlayHandler);
        }
        videoEl = null;
        onPauseHandler = null;
        onPlayHandler = null;
      },
      scriptPause() {
        if (!videoEl) return;
        scriptActionAt = performance.now();
        videoEl.pause();
      },
      scriptPlay() {
        if (!videoEl) return;
        scriptActionAt = performance.now();
        const p = videoEl.play();
        if (p && p.catch) p.catch((e) => log('play() rejected:', e.message));
      },
    };
  }

  // ===== Bootstrap =====
  const camera = createCamera();
  const led = createLed();

  let controller; // forward declaration: FSM needs callback that calls controller
  const fsm = createFsm({
    onPauseRequested: () => controller && controller.scriptPause(),
    onPlayRequested: () => controller && controller.scriptPlay(),
  });
  controller = createYouTubeController(fsm);

  const detector = createDetector(camera.getVideoEl, (cls, info) => {
    log('class:', cls, 'q:', info.quality ? info.quality.toFixed(1) : '-');
    led.setClass(cls);
    fsm.onClass(cls);
  });

  const preview = createPreview(camera.getVideoEl(), () => detector.getLast());
  const previewToggle = createPreviewToggle(preview);

  let on = false;

  async function turnOn(btn) {
    // Activate preview BEFORE starting the camera so the <video> is attached
    // to a visible parent when the stream hooks up — otherwise Chrome may not
    // decode the first frame promptly inside display:none.
    previewToggle.activate();
    try {
      await camera.start();
      await detector.start();
      controller.start();
    } catch (e) {
      previewToggle.deactivate();
      throw e;
    }
    led.setActive(true);
    btn.classList.remove('is-off', 'is-error');
    btn.title = 'Gaze-aware pause: on';
    on = true;
    savePersistedState(true);
  }

  function turnOff(btn) {
    detector.stop();
    camera.stop();
    controller.stop();
    fsm.reset();
    previewToggle.deactivate();
    led.setActive(false);
    btn.classList.add('is-off');
    btn.classList.remove('is-error');
    btn.title = 'Gaze-aware pause: off';
    on = false;
    savePersistedState(false);
  }

  // One-time CSS. Two things to guarantee:
  //   1) The button itself is 48px wide (same as YT's CC/settings/etc) and
  //      lays out via flex so the SVG is dead-centered both axes — relying on
  //      preserveAspectRatio for centring breaks if YT decides to apply
  //      different padding/box-sizing to .ytp-button.
  //   2) The SVG renders at a fixed 24x24 (matching its viewBox) so the icon
  //      weight doesn't drift with player size.
  // Colour comes from `currentColor` on the <path> + `color` on the button,
  // so the off/error states can flip the whole thing via class.
  function injectStyles() {
    if (document.getElementById('gaze-styles')) return;
    const style = document.createElement('style');
    style.id = 'gaze-styles';
    style.textContent = [
      '.ytp-right-controls .gaze-toggle,',
      '.ytp-right-controls .gaze-preview-toggle {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  width: 48px;',
      '  height: 100%;',
      '  flex-shrink: 0;',
      '  vertical-align: top;',
      '  padding: 0;',
      '  margin: 0;',
      '  background: transparent;',
      '  border: 0;',
      '  cursor: pointer;',
      '  color: #fff;',
      '  opacity: 1;',
      '  transition: opacity 120ms ease, color 120ms ease;',
      '}',
      '.ytp-right-controls .gaze-toggle > svg,',
      '.ytp-right-controls .gaze-preview-toggle > svg {',
      '  display: block;',
      '  width: 24px;',
      '  height: 24px;',
      '  pointer-events: none;',
      '}',
      '.ytp-right-controls .gaze-toggle .icon-off,',
      '.ytp-right-controls .gaze-preview-toggle .icon-off {',
      '  display: none;',
      '}',
      '.ytp-right-controls .gaze-toggle.is-off .icon-on,',
      '.ytp-right-controls .gaze-preview-toggle.is-off .icon-on {',
      '  display: none;',
      '}',
      '.ytp-right-controls .gaze-toggle.is-off .icon-off,',
      '.ytp-right-controls .gaze-preview-toggle.is-off .icon-off {',
      '  display: inline;',
      '}',
      '.ytp-right-controls .gaze-toggle.is-off,',
      '.ytp-right-controls .gaze-preview-toggle.is-off {',
      '  opacity: 0.7;',
      '}',
      '.ytp-right-controls .gaze-toggle.is-error {',
      '  color: #ff5252;',
      '  opacity: 1;',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function injectToggle() {
    injectStyles();
    const tryInject = () => {
      const right = document.querySelector('.ytp-right-controls');
      if (!right) return false;
      if (right.querySelector('.gaze-toggle')) return true;

      const btn = document.createElement('button');
      btn.className = 'ytp-button gaze-toggle is-off';
      btn.title = 'Gaze-aware pause: off';
      btn.setAttribute('aria-label', 'Gaze-aware pause toggle');

      // Build SVG via DOM (innerHTML is blocked by YouTube's Trusted Types CSP).
      // 24x24 viewBox = 24x24 rendered size (set by CSS), so the path renders
      // 1:1 and the icon is perfectly centred inside the 48px flex button.
      // Two paths: .icon-on (open eye) + .icon-off (eye with diagonal slash,
      // Material visibility_off). CSS picks one based on .is-off on the button.
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');

      const pathOn = document.createElementNS(SVG_NS, 'path');
      pathOn.setAttribute('class', 'icon-on');
      pathOn.setAttribute('fill', 'currentColor');
      pathOn.setAttribute(
        'd',
        'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 '
        + '11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8'
        + 'a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
      );

      const pathOff = document.createElementNS(SVG_NS, 'path');
      pathOff.setAttribute('class', 'icon-off');
      pathOff.setAttribute('fill', 'currentColor');
      pathOff.setAttribute(
        'd',
        'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92'
        + 'c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7'
        + 'l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46'
        + 'C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84'
        + 'l.42.42L19.73 22 21 20.73 3.27 3 2 4.27z'
        + 'M7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08'
        + 'l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2z'
        + 'm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z',
      );

      svg.appendChild(pathOn);
      svg.appendChild(pathOff);

      // LED rides inside the SVG as a child <circle>, positioned in the icon's
      // own user-space coords (top-right of the eye). No CSS positioning, no
      // effect on button layout. Hidden when the gaze is off via the LED's own
      // visibility attribute, so the icon-off glyph isn't obscured by it.
      svg.appendChild(led.el);

      btn.appendChild(svg);

      btn.addEventListener('click', async () => {
        try {
          if (!on) await turnOn(btn);
          else turnOff(btn);
        } catch (e) {
          on = false;
          let msg = e.message || String(e);
          if (e.name === 'NotAllowedError') msg = 'Camera permission denied';
          else if (e.name === 'NotReadableError') msg = 'Camera is in use by another tab/app';
          else if (e.name === 'NotFoundError') msg = 'No camera found';
          btn.classList.add('is-error', 'is-off');
          btn.title = 'Gaze-aware pause: error — ' + msg;
          log('error:', msg, e);
          try { detector.stop(); } catch {}
          try { camera.stop(); } catch {}
          try { controller.stop(); } catch {}
          previewToggle.deactivate();
          led.setActive(false);
        }
      });

      // Order in DOM: [preview-toggle] [gaze-toggle (with LED inside)] [...YT controls]
      // The eye sits next to YT's CC/settings; when the camera is off, the
      // hidden preview-toggle's 48px slot is on the far left (next to the
      // progress bar) instead of opening a gap between the eye and YT controls.
      right.insertBefore(btn, right.firstChild);
      right.insertBefore(previewToggle.el, btn);
      log('toggle injected');

      // Auto-resume from persisted state. If this fails (e.g. camera denied),
      // the click handler's catch block will surface the error in the UI.
      if (loadPersistedState() && !on) {
        log('auto-resuming from persisted state');
        turnOn(btn).catch((e) => {
          on = false;
          let msg = e.message || String(e);
          if (e.name === 'NotAllowedError') msg = 'Camera permission denied';
          else if (e.name === 'NotReadableError') msg = 'Camera is in use by another tab/app';
          else if (e.name === 'NotFoundError') msg = 'No camera found';
          btn.classList.add('is-error', 'is-off');
          btn.title = 'Gaze-aware pause: error — ' + msg;
          log('auto-resume failed:', msg);
        });
      }
      return true;
    };

    if (tryInject()) return;
    const obs = new MutationObserver(() => {
      if (tryInject()) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  injectToggle();
  log('bootstrap done');
})();