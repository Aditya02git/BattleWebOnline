// healthBar.js — HUD health bar for player and enemy tanks

export class HealthBar {
  constructor(maxHealth = 100) {
    this.maxHealth  = maxHealth;
    this.health     = maxHealth;
    this._el        = null;
    this._fill      = null;
  }

  mount(parentEl, opts = {}) {
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      pointer-events:none;
      font-family:monospace;
      font-size:13px;
      color:#b8d888;
      margin-bottom:6px;
      display:flex;
      align-items:center;
      gap:8px;
    `;

    const title = document.createElement('div');
    title.style.cssText = `
      display:flex;
      align-items:center;
      flex-shrink:0;
    `;

    if (opts.svg) {
      title.innerHTML = opts.svg;
      const svgEl = title.querySelector('svg');
      if (svgEl) {
        svgEl.style.cssText = `
          display:block;
          width:20px;
          height:25px;
        `;
      }
    } else {
      title.textContent = opts.label ?? 'HP';
    }

    // Health track
    const track = document.createElement('div');
    track.style.cssText = `
      width:${opts.width ?? 300}px;
      height:5px;
      background:rgba(20,30,10,0.7);
      overflow:hidden;
    `;
    this._fill = document.createElement('div');
    this._fill.style.cssText = `
      height:100%;
      width:100%;
      background:#ffffff96;
      transition:width 0.15s, background 0.3s;
    `;
    track.appendChild(this._fill);

    wrap.appendChild(title);
    wrap.appendChild(track);
    parentEl.appendChild(wrap);
    this._el = wrap;
    this._update();
  }

  setMaxHealth(v) {
    this.maxHealth = v;
    this.health = Math.min(this.health, this.maxHealth);
    this._update();
  }

  setHealth(v) {
    this.health = Math.max(0, Math.min(this.maxHealth, v));
    this._update();
  }

  _update() {
    if (!this._fill) return;
    const pct = this.health / this.maxHealth;
    this._fill.style.width = `${pct * 100}%`;
    this._fill.style.background =
      pct > 0.5 ? '#ffffff96' : pct > 0.25 ? '#d49e1796' : '#cc33229b';
  }

  remove() { this._el?.remove(); }
}