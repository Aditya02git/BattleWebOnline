// ── Events widget: middle-right carousel + click-to-open modal ────────────
// Self-contained: injects its own markup/behavior. Call initEventsWidget()
// once after the DOM/configurator markup exists.

const EVENTS_DATA = [
  {
    id: 'summer-offensive',
    name: 'SUMMER OFFENSIVE',
    image: '/events/summer-offensive.png',
    description: 'Limited-time desert maps and double XP on captures.',
    dateRange: 'AUG 01 – AUG 15',
    reward: '2x XP',
  },
  {
    id: 'night-ops',
    name: 'NIGHT OPS',
    image: '/events/night-ops.png',
    description: 'Low-visibility night battles. Headlights matter.',
    dateRange: 'AUG 10 – AUG 20',
    reward: '+500 Currency',
  },
  {
    id: 'ace-trials',
    name: 'ACE TRIALS',
    image: '/events/ace-trials.png',
    description: 'Plane-only skirmishes. Top 100 earn exclusive skins.',
    dateRange: 'AUG 18 – AUG 31',
    reward: 'Exclusive Skin',
  },
];

const ROTATE_INTERVAL_MS = 4000;

let _currentIndex = 0;
let _rotateTimer  = null;

export function initEventsWidget() {
  const host = document.getElementById('configurator') || document.body;

  host.insertAdjacentHTML('beforeend', _widgetHTML());
  host.insertAdjacentHTML('beforeend', _modalHTML());

  _renderDots();
  _applyFrame(0);
  _startRotation();

  document.getElementById('events-widget')
    .addEventListener('click', openEventsModal);

  document.getElementById('events-modal')
    .addEventListener('click', (e) => {
      if (e.target.id === 'events-modal') closeEventsModal();
    });

  document.getElementById('events-modal-close')
    .addEventListener('click', closeEventsModal);
}

function _widgetHTML() {
  return `
  <div id="events-widget" style="
    position: fixed;
    top: 50%;
    right: 0px;
    transform: translateY(-50%);
    z-index: 1;
    cursor: pointer;
    font-family: 'Courier New', monospace;
  ">
    <div id="events-widget-box" style="
      width:200px;
    //   height: 150px;
    //   border:1px solid #2a3a1a;
    //   border-radius:4px;
      overflow:hidden;
      position:relative;
      transition:border-color 0.15s;
      background:#0d0d0d;
    ">
      <div style="aspect-ratio:16/7;background:#0a0f08;position:relative;overflow:hidden;">
        <img id="events-widget-img" src="" alt="" style="
          width:100%;height:100%;object-fit:cover;
          display:none;position:absolute;inset:0;
          transition:opacity 0.4s ease;
        ">
        <div id="events-widget-placeholder" style="
          position:absolute;inset:0;
          display:flex;align-items:center;justify-content:center;
          font-size:9px;color:#3a5a20;letter-spacing:0.1em;
        ">NO PREVIEW</div>
        <div id="events-widget-dots" style="
          position:absolute;bottom:6px;left:0;right:0;
          display:flex;justify-content:center;gap:4px;
        "></div>
      </div>
      <div style="
        padding:5px 8px;
        background:#0d0d0d;
        border-top:1px solid #1e2e14;
        display:flex;align-items:center;justify-content:space-between;
        gap:8px;
      ">
        <span style="font-size:10px;color:#a0b880;letter-spacing:0.08em;flex-shrink:0;">EVENTS</span>
        <span id="events-widget-title" style="
          font-size:9px;color:#6a8a30;
          max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        ">—</span>
        <span style="font-size:9px;color:#6a8a30;flex-shrink:0;">▶</span>
      </div>
    </div>
  </div>`;
}

function _modalHTML() {
  return `
  <div id="events-modal" onclick="" style="
    display:none;
    position:fixed;inset:0;
    background:rgba(0,0,0,0.6);
    align-items:center;justify-content:center;
    z-index:100;
    font-family:'Courier New',monospace;
  ">
    <div style="
      background:#0d0d0d;
      border-top:1px solid #2a3a1a;
      border-bottom:1px solid #2a3a1a;
      padding:1.4rem 1.8rem;
      width:760px;
      max-width:95vw;
      max-height:85vh;
      display:flex;flex-direction:column;
      gap:14px;
      position:relative;
      -webkit-mask-image: linear-gradient(
        to right, transparent 0%, black 2%, black 98%, transparent 100%
      );
      mask-image: linear-gradient(
        to right, transparent 0%, black 2%, black 98%, transparent 100%
      );
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:15px;color:#c8d8a0;letter-spacing:0.12em;">EVENTS</div>
          <div style="font-size:9px;color:#6a8a30;letter-spacing:0.14em;margin-top:2px;">LIMITED-TIME HAPPENINGS</div>
        </div>
        <button id="events-modal-close" style="
          background:none;border:none;color:#6a8a30;
          font-size:18px;cursor:pointer;line-height:1;padding:0;
        ">✕</button>
      </div>

      <div id="events-modal-track" style="
        display:flex;
        overflow-x:auto;
        gap:14px;
        scroll-snap-type:x mandatory;
        padding-bottom:6px;
      ">
        ${EVENTS_DATA.map(_cardHTML).join('')}
      </div>
    </div>
  </div>`;
}

function _cardHTML(ev) {
  return `
    <div style="
      flex:0 0 280px;
      scroll-snap-align:start;
      background:#111;
      border:1px solid #2a3a1a;
      border-radius:4px;
      overflow:hidden;
      display:flex;flex-direction:column;
    ">
      <div style="aspect-ratio:16/9;background:#0a0f08;position:relative;">
        <img src="${ev.image}" alt="${ev.name}"
          style="width:100%;height:100%;object-fit:cover;"
          onerror="this.style.display='none'">
      </div>
      <div style="padding:10px 12px;display:flex;flex-direction:column;gap:6px;">
        <div style="font-size:12px;color:#c8d8a0;letter-spacing:0.08em;">${ev.name}</div>
        <div style="font-size:10px;color:#7a9a58;line-height:1.6;">${ev.description}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
          <span style="font-size:9px;color:#6a8a30;letter-spacing:0.06em;">${ev.dateRange}</span>
          <span style="font-size:9px;color:#c8a030;letter-spacing:0.06em;">${ev.reward}</span>
        </div>
      </div>
    </div>`;
}

function _renderDots() {
  const dotsWrap = document.getElementById('events-widget-dots');
  if (!dotsWrap) return;
  dotsWrap.innerHTML = EVENTS_DATA.map((_, i) => `
    <span data-dot="${i}" style="
      width:5px;height:5px;border-radius:50%;
      background:${i === _currentIndex ? '#c8d8a0' : 'rgba(200,216,160,0.35)'};
      transition:background 0.2s;
    "></span>
  `).join('');
}

function _applyFrame(index) {
  const ev = EVENTS_DATA[index];
  if (!ev) return;
  _currentIndex = index;

  const img = document.getElementById('events-widget-img');
  const placeholder = document.getElementById('events-widget-placeholder');
  const title = document.getElementById('events-widget-title');

  if (img) {
    img.style.opacity = '0';
    const swap = () => {
      img.src = ev.image;
      img.onload = () => { img.style.display = 'block'; placeholder.style.display = 'none'; img.style.opacity = '1'; };
      img.onerror = () => { img.style.display = 'none'; placeholder.style.display = 'flex'; };
    };
    setTimeout(swap, 150);
  }
  if (title) title.textContent = ev.name;

  document.querySelectorAll('#events-widget-dots [data-dot]').forEach((d, i) => {
    d.style.background = i === index ? '#c8d8a0' : 'rgba(200,216,160,0.35)';
  });
}

function _startRotation() {
  clearInterval(_rotateTimer);
  _rotateTimer = setInterval(() => {
    _applyFrame((_currentIndex + 1) % EVENTS_DATA.length);
  }, ROTATE_INTERVAL_MS);
}

export function openEventsModal() {
  document.getElementById('events-modal').style.display = 'flex';
}

export function closeEventsModal() {
  document.getElementById('events-modal').style.display = 'none';
}

export function hideEventsWidget() {
  const el = document.getElementById('events-widget');
  if (el) el.style.display = 'none';
}

export function showEventsWidget() {
  const el = document.getElementById('events-widget');
  if (el) el.style.display = 'block';
}