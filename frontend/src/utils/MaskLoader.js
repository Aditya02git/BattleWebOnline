import * as THREE from "three";

export class MaskLoader {
  constructor() {
    this._pixels = null;
    this._width  = 0;
    this._height = 0;
  }

  load(maskPath) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width  = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        this._pixels = ctx.getImageData(0, 0, img.width, img.height).data;
        this._width  = img.width;
        this._height = img.height;
        resolve(this);
      };
      img.src = maskPath;
    });
  }

  // ── Returns raw pixel index — zero allocation ──────────────────────────
  _getIndex(x, z, worldSize = 500) {
    const half = worldSize / 2;
    const u  = (x + half) / worldSize;
    const v  = (z + half) / worldSize;
    const px = Math.floor(Math.min(u, 0.9999) * this._width);
    const py = Math.floor(Math.min(v, 0.9999) * this._height);
    return (py * this._width + px) * 4;
  }

  // ── Keep getPixelAt for TerrainBuilder compatibility — but don't use in hot paths ──
  getPixelAt(x, z, worldSize = 500) {
    const i = this._getIndex(x, z, worldSize);
    return {
      r: this._pixels[i],
      g: this._pixels[i + 1],
      b: this._pixels[i + 2],
    };
  }

  isGrass(x, z, worldSize = 500) {
    const i = this._getIndex(x, z, worldSize);
    const r = this._pixels[i], g = this._pixels[i+1], b = this._pixels[i+2];
    return g > 100 && g > r * 1.5 && g > b * 1.5;
  }

  // isPath(x, z, worldSize = 500) {
  //   const i = this._getIndex(x, z, worldSize);
  //   const r = this._pixels[i], g = this._pixels[i+1], b = this._pixels[i+2];
  //   return b > 100 && b > r * 1.5 && b > g * 1.5;
  // }

  isTree(x, z, worldSize = 500) {
    const i = this._getIndex(x, z, worldSize);
    const r = this._pixels[i], g = this._pixels[i+1], b = this._pixels[i+2];
    return r > 100 && r > g * 1.5 && r > b * 1.5;
  }
}