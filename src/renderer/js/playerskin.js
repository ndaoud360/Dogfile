// Dogfile Player: animated music-player skins (record player and cassette deck).
// Chosen by the "Player animations" feature (dogfile.player.setSkin), drawn here because features run in a sandbox
// and can't draw. The skin replaces the cover picture in the music view:
//   record player: the record slides in and lands, the needle swings over and drops, then the song starts;
//                  pausing lifts the needle and the record spins down.
//   cassette deck: the lid opens, the tape slides in, the lid closes, then the song starts and the reels turn;
//                  pausing stops the reels.
export const SKINS = { off: 'Cover picture', turntable: 'Record player', cassette: 'Cassette deck' };

const CSS = `
#skin-stage { display: none; position: relative; width: min(100%, 62vh); aspect-ratio: 4 / 3; justify-self: center; }
body.skin-on #skin-stage { display: block; }
body.skin-on .av-art { display: none; }
#skin-stage svg { width: 100%; height: 100%; overflow: visible; display: block; filter: drop-shadow(0 26px 34px rgba(0,0,0,.55)); }
#skin-stage .sk-rec, #skin-stage .sk-arm, #skin-stage .sk-tape, #skin-stage .sk-lid { transform-box: fill-box; }
#skin-stage .sk-rec { transform-origin: center; }
#skin-stage .sk-arm { transition: transform .75s cubic-bezier(.45,.05,.3,1), filter .5s; transform-origin: 350px 60px; transform-box: view-box; filter: drop-shadow(8px 12px 6px rgba(0,0,0,.45)); }
#skin-stage .sk-arm.down { transition: transform .7s cubic-bezier(.45,.05,.3,1), filter .35s; filter: drop-shadow(2px 3px 2px rgba(0,0,0,.55)); }
#skin-stage .sk-arm.track { transition: transform 1s linear, filter .35s; }
#skin-stage .sk-tape { transform-origin: center; }
#skin-stage .sk-lid { transform-origin: 50% 0; transition: transform .55s cubic-bezier(.5,0,.3,1), opacity .55s; }
#skin-stage .sk-reel, #skin-stage .sk-spin { transform-box: fill-box; transform-origin: center; }
@media (max-width: 760px) { #skin-stage { width: min(80vw, 40vh); } }
`;

const NS = 'http://www.w3.org/2000/svg';

function turntableSVG() {
  return `<svg viewBox="0 0 400 300" xmlns="${NS}" aria-hidden="true">
  <defs>
    <linearGradient id="skWood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5a3b24"/><stop offset="1" stop-color="#3a2415"/></linearGradient>
    <radialGradient id="skVinyl" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#1a1a1c"/><stop offset=".55" stop-color="#0d0d0e"/><stop offset="1" stop-color="#17171a"/></radialGradient>
    <linearGradient id="skSheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset=".45" stop-color="#fff" stop-opacity=".16"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <clipPath id="skLabel"><circle cx="150" cy="150" r="38"/></clipPath>
  </defs>
  <rect x="6" y="6" width="388" height="288" rx="18" fill="url(#skWood)"/>
  <rect x="6" y="6" width="388" height="288" rx="18" fill="none" stroke="rgba(255,255,255,.12)"/>
  <circle cx="150" cy="150" r="124" fill="#1d1d20"/>
  <circle cx="150" cy="150" r="118" fill="#2b2b30"/>
  <g class="sk-rec"><g class="sk-spin">
    <circle cx="150" cy="150" r="112" fill="url(#skVinyl)"/>
    ${[100, 92, 84, 76, 68, 60, 52].map((r) => `<circle cx="150" cy="150" r="${r}" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="1"/>`).join('')}
    <circle cx="150" cy="150" r="38" fill="#b33a2e" class="sk-label-bg"/>
    <image class="sk-label-img" href="" x="112" y="112" width="76" height="76" preserveAspectRatio="xMidYMid slice" clip-path="url(#skLabel)" style="display:none"/>
    <circle cx="150" cy="150" r="112" fill="url(#skSheen)"/>
  </g></g>
  <circle cx="150" cy="150" r="4.5" fill="#d8d8dc"/>
  <circle cx="150" cy="150" r="1.6" fill="#555"/>
  <circle cx="350" cy="60" r="22" fill="#2a2a2e"/><circle cx="350" cy="60" r="16" fill="#44444a"/>
  <g class="sk-arm"><g>
    <rect x="346" y="56" width="8" height="150" rx="4" fill="#cfd0d4"/>
    <rect x="346" y="56" width="3" height="150" rx="1.5" fill="rgba(255,255,255,.55)"/>
    <rect x="340" y="196" width="20" height="38" rx="4" fill="#26262a"/>
    <rect x="344" y="226" width="12" height="6" fill="#d9a441"/>
    <circle cx="350" cy="60" r="9" fill="#e6e6ea"/><circle cx="350" cy="60" r="3.5" fill="#888"/>
    <rect x="343" y="20" width="14" height="42" rx="4" fill="#3a3a40"/>
  </g></g>
  <circle cx="368" cy="266" r="9" fill="#1a1a1d"/><circle cx="368" cy="266" r="5" fill="#d9a441"/>
  </svg>`;
}

function cassetteSVG() {
  const reel = (cx) => `<g class="sk-reel" data-cx="${cx}">
      <circle cx="${cx}" cy="150" r="17" fill="#e9e9ec"/>
      ${[0, 60, 120, 180, 240, 300].map((a) => `<rect x="${cx - 1.6}" y="${150 - 15}" width="3.2" height="8" rx="1" fill="#2b2b2f" transform="rotate(${a} ${cx} 150)"/>`).join('')}
      <circle cx="${cx}" cy="150" r="5" fill="#2b2b2f"/>
    </g>`;
  return `<svg viewBox="0 0 400 300" xmlns="${NS}" aria-hidden="true">
  <defs>
    <linearGradient id="skBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34353b"/><stop offset="1" stop-color="#1d1e22"/></linearGradient>
    <clipPath id="skSlot"><rect x="36" y="60" width="328" height="190" rx="10"/></clipPath>
  </defs>
  <rect x="14" y="30" width="372" height="250" rx="20" fill="url(#skBody)"/>
  <rect x="14" y="30" width="372" height="250" rx="20" fill="none" stroke="rgba(255,255,255,.14)"/>
  <rect x="36" y="60" width="328" height="190" rx="10" fill="#0b0b0d"/>
  <g clip-path="url(#skSlot)"><g class="sk-tape">
    <rect x="46" y="70" width="308" height="170" rx="9" fill="#d8c9a0"/>
    <rect x="46" y="70" width="308" height="170" rx="9" fill="none" stroke="rgba(0,0,0,.35)"/>
    <rect x="62" y="82" width="276" height="56" rx="4" fill="#f4efe0"/>
    <text class="sk-title" x="200" y="116" text-anchor="middle" font-family="Georgia, serif" font-size="17" fill="#3a3326"></text>
    <rect x="62" y="82" width="276" height="9" rx="2" fill="#b33a2e"/>
    <rect x="86" y="146" width="228" height="62" rx="31" fill="#2a2a2e"/>
    <circle class="sk-tape-l" cx="130" cy="177" r="30" fill="#4a3220"/>
    <circle class="sk-tape-r" cx="270" cy="177" r="16" fill="#4a3220"/>
    <g transform="translate(0 27)">${reel(130)}${reel(270)}</g>
    <path d="M118 226 L132 214 L268 214 L282 226 Z" fill="#1b1b1f"/>
    <circle cx="68" cy="228" r="5" fill="#8d8570"/><circle cx="332" cy="228" r="5" fill="#8d8570"/>
  </g></g>
  <g class="sk-lid"><rect x="30" y="54" width="340" height="202" rx="12" fill="rgba(170,200,230,.16)" stroke="rgba(220,235,255,.38)" stroke-width="2"/>
    <path d="M44 66 L150 66 L110 130 L44 130 Z" fill="rgba(255,255,255,.07)"/></g>
  <circle cx="44" cy="262" r="5" fill="#6a6b72"/><circle cx="62" cy="262" r="5" fill="#6a6b72"/>
  <rect x="300" y="256" width="60" height="10" rx="3" fill="#1b1b1f"/>
  </svg>`;
}

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reduce() ? 0 : ms));

// a looping spin whose speed eases up and down
function spinner(el, ms) {
  const a = el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: ms, iterations: Infinity });
  a.pause();
  let raf = 0;
  const to = (rate, over = 900) => {
    cancelAnimationFrame(raf);
    if (rate > 0 && a.playState !== 'running') { a.playbackRate = 0.01; a.play(); }
    const from = a.playbackRate, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / over);
      a.playbackRate = Math.max(0.01, from + (rate - from) * (k * k * (3 - 2 * k)));
      if (k < 1) raf = requestAnimationFrame(step);
      else if (rate === 0) a.pause();
    };
    if (reduce()) { a.playbackRate = Math.max(0.01, rate); if (rate === 0) a.pause(); return; }
    raf = requestAnimationFrame(step);
  };
  return { to, anim: a };
}

// the angle (degrees, clockwise from straight down) that puts the needle a given distance from the record's centre
function armAngle(radius) {
  const P = { x: 350, y: 60 }, C = { x: 150, y: 150 }, L = 172;
  let best = 0, bd = 1e9;
  for (let a = 0; a <= 80; a += 0.1) {
    const r = a * Math.PI / 180, x = P.x - L * Math.sin(r), y = P.y + L * Math.cos(r);
    const d = Math.abs(Math.hypot(x - C.x, y - C.y) - radius);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

export function createSkins({ stage, audioEl, getProgress }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const box = document.createElement('div'); box.id = 'skin-stage';
  stage.insertBefore(box, stage.firstChild);
  let hasTrack = false, name = 'off', ui = null, state = 'out', token = 0, ready = Promise.resolve(), meta = { title: '', art: '' };

  const aOuter = armAngle(106), aInner = armAngle(50);

  function build() {
    box.innerHTML = '';
    ui = null; state = 'out';
    if (name === 'off') { document.body.classList.remove('skin-on'); return; }
    box.innerHTML = name === 'turntable' ? turntableSVG() : cassetteSVG();
    document.body.classList.add('skin-on');
    const q = (s) => box.querySelector(s);
    if (name === 'turntable') {
      const spin = spinner(q('.sk-spin'), 1800);
      ui = { kind: 'turntable', rec: q('.sk-rec'), arm: q('.sk-arm'), spin, img: q('.sk-label-img'), bg: q('.sk-label-bg') };
      ui.rec.style.opacity = '0'; // waiting off to the side until a track is loaded
      setArm(0, 'lift');
    } else {
      const reels = [...box.querySelectorAll('.sk-reel')].map((el) => spinner(el, 1500));
      ui = { kind: 'cassette', tape: q('.sk-tape'), lid: q('.sk-lid'), reels, title: q('.sk-title'), tl: q('.sk-tape-l'), tr: q('.sk-tape-r') };
      ui.tape.style.transform = 'translateY(300px)';
      setLid(false, true);
    }
    applyMeta();
  }

  function applyMeta() {
    if (!ui) return;
    if (ui.kind === 'turntable') {
      if (meta.art) { ui.img.setAttribute('href', meta.art); ui.img.style.display = ''; } else ui.img.style.display = 'none';
    } else ui.title.textContent = (meta.title || '').slice(0, 30);
  }

  function setArm(angle, mode) {
    ui.arm.classList.toggle('down', mode === 'down' || mode === 'track');
    ui.arm.classList.toggle('track', mode === 'track');
    ui.arm.style.transform = `rotate(${angle}deg)`;
  }
  function setLid(closed, instant) {
    if (!ui) return;
    if (instant) { ui.lid.style.transition = 'none'; }
    ui.lid.style.transform = closed ? 'scaleY(1)' : 'scaleY(.18) translateY(-6px)';
    ui.lid.style.opacity = closed ? '1' : '.7';
    if (instant) { void ui.lid.offsetWidth; ui.lid.style.transition = ''; }
  }
  const slide = (el, frames, ms) => reduce() ? Promise.resolve(el.animate([frames[frames.length - 1]], { duration: 0, fill: 'forwards' })) : el.animate(frames, { duration: ms, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'forwards' }).finished.catch(() => {});

  async function out() {
    if (!ui || state === 'out') return;
    const u = ui;
    if (u.kind === 'turntable') {
      u.spin.to(0, 250); setArm(0, 'lift'); await wait(500);
      await slide(u.rec, [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(120%) rotate(40deg)', opacity: 0 }], 520);
    } else {
      u.reels.forEach((r) => r.to(0, 200)); setLid(false); await wait(500);
      await slide(u.tape, [{ transform: 'translateY(0)' }, { transform: 'translateY(300px)' }], 480);
    }
    state = 'out';
  }

  async function intro(my) {
    if (!ui) return;
    const u = ui;
    if (u.kind === 'turntable') {
      u.rec.style.opacity = '';
      await slide(u.rec, [{ transform: 'translateX(-120%) rotate(-40deg)', opacity: 0 }, { transform: 'translateX(0) rotate(0)', opacity: 1, offset: .8 }, { transform: 'translateX(0) scale(1.025)', opacity: 1, offset: .9 }, { transform: 'translateX(0) scale(1)', opacity: 1 }], 900);
      if (my !== token) return;
      await wait(250);
      if (my !== token) return;
      setArm(aOuter, 'down'); // swings over the record and drops
      u.spin.to(1, 1400);
      await wait(800);
    } else {
      setLid(false, true);
      await slide(u.tape, [{ transform: 'translateY(300px)' }, { transform: 'translateY(-8px)', offset: .85 }, { transform: 'translateY(0)' }], 800);
      if (my !== token) return;
      await wait(150);
      setLid(true);
      await wait(600);
      if (my !== token) return;
      u.reels.forEach((r) => r.to(1, 900));
    }
    state = 'in';
  }

  function reelSizes(p) {
    if (!ui || ui.kind !== 'cassette') return;
    ui.tl.setAttribute('r', (30 - 14 * p).toFixed(1));
    ui.tr.setAttribute('r', (16 + 14 * p).toFixed(1));
  }

  return {
    active: () => name !== 'off',
    name: () => name,
    set(n) {
      if (!SKINS[n]) n = 'off';
      if (n === name) return;
      name = n; token++; build();
      if (name !== 'off' && hasTrack) { ready = intro(token); } else ready = Promise.resolve();
    },
    // a new track was loaded: the old tape/record leaves, the new one comes in; resolves when playback may start
    track(m) {
      meta = m; hasTrack = true; token++;
      const my = token;
      if (name === 'off') { ready = Promise.resolve(); return ready; }
      ready = (async () => { await out(); if (my !== token) return; applyMeta(); await intro(my); })();
      return ready;
    },
    whenReady: () => ready,
    clear() { hasTrack = false; token++; if (ui) out(); },
    art(src) { meta = { ...meta, art: src }; applyMeta(); },
    // follow the audio element
    playing(on) {
      if (!ui || state !== 'in') return;
      if (ui.kind === 'turntable') {
        if (on) { setArm(aOuter + (aInner - aOuter) * getProgress(), 'down'); ui.spin.to(1, 700); }
        else { setArm(0, 'lift'); ui.spin.to(0, 1500); }
      } else ui.reels.forEach((r) => r.to(on ? 1 : 0, on ? 500 : 900));
    },
    progress(p) {
      if (!ui || state !== 'in' || audioEl.paused) return;
      if (ui.kind === 'turntable') setArm(aOuter + (aInner - aOuter) * p, 'track');
      else reelSizes(p);
    },
  };
}
