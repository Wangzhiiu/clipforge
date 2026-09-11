/* ============================================================
 * ClipForge · player.js
 * 播放 / 画面合成引擎：多轨视频合成、滤镜、字幕绘制、音频混音
 * ============================================================ */
(function () {
  'use strict';
  const VE = (window.VE = window.VE || {});

  /* ---------- 滤镜字符串 ---------- */
  function buildFilter(f) {
    if (!f) return 'none';
    const parts = [];
    if (f.brightness !== undefined && f.brightness !== 1) parts.push('brightness(' + f.brightness + ')');
    if (f.contrast !== undefined && f.contrast !== 1) parts.push('contrast(' + f.contrast + ')');
    if (f.saturation !== undefined && f.saturation !== 1) parts.push('saturate(' + f.saturation + ')');
    if (f.blur !== undefined && f.blur > 0) parts.push('blur(' + f.blur + 'px)');
    if (f.grayscale !== undefined && f.grayscale > 0) parts.push('grayscale(' + f.grayscale + ')');
    if (f.sepia !== undefined && f.sepia > 0) parts.push('sepia(' + f.sepia + ')');
    if (f.hueRotate !== undefined && f.hueRotate !== 0) parts.push('hue-rotate(' + f.hueRotate + 'deg)');
    return parts.length ? parts.join(' ') : 'none';
  }

  function defaultFilters() {
    return { brightness: 1, contrast: 1, saturation: 1, blur: 0, grayscale: 0, sepia: 0, hueRotate: 0 };
  }

  VE.Player = class {
    constructor(canvas, project) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.project = project;
      this.time = 0;
      this.playing = false;
      this.raf = 0;
      this.clockStart = 0;
      this.audioCtx = null;
      this.masterGain = null;
      this.audioDest = null;
      this._elCache = new Map();      // clipId -> { el, gain }
      this._imgCache = new Map();     // assetId -> Image
      this._captureStream = null;
      this.onEnd = null;
      this.onTick = null;
      this._seekedHandler = this._onSeeked.bind(this);
    }

    /* ---------- 音频上下文 ---------- */
    ensureAudio() {
      if (this.audioCtx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioCtx = new AC();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = 1;
      this.audioDest = this.audioCtx.createMediaStreamDestination();
      // 预览走扬声器，导出走 dest 流
      this.masterGain.connect(this.audioCtx.destination);
      this.masterGain.connect(this.audioDest);
    }

    getAudioStream() {
      this.ensureAudio();
      return this.audioDest ? this.audioDest.stream : null;
    }

    /* ---------- 元素管理 ---------- */
    _getElement(clip) {
      if (this._elCache.has(clip.id)) return this._elCache.get(clip.id);
      const asset = this.project.getAsset(clip.sourceId);
      if (!asset || (clip.type !== 'video' && clip.type !== 'audio')) return null;
      const el = document.createElement(clip.type === 'video' ? 'video' : 'audio');
      el.src = asset.url;
      el.loop = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.addEventListener('seeked', this._seekedHandler);
      let gain = null;
      try {
        this.ensureAudio();
        if (this.audioCtx) {
          const node = this.audioCtx.createMediaElementSource(el);
          gain = this.audioCtx.createGain();
          gain.gain.value = 0; // 未激活片段静音
          node.connect(gain);
          gain.connect(this.masterGain);
        }
      } catch (e) {
        // 音频路由失败时退化为元素原生音量
        gain = null;
      }
      const entry = { el, gain };
      this._elCache.set(clip.id, entry);
      return entry;
    }

    _onSeeked() {
      if (!this.playing) this.render(this.time);
    }

    /* 时间线结构变化后调用：清理全部元素缓存 */
    rebuildElements() {
      for (const entry of this._elCache.values()) {
        try { entry.el.pause(); } catch (e) { /* noop */ }
        entry.el.removeAttribute('src');
        entry.el.load();
      }
      this._elCache.clear();
    }

    /* ---------- 播放控制 ---------- */
    play() {
      if (this.playing) return;
      this.ensureAudio();
      if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      if (this.time >= this.project.duration) this.time = 0;
      this.playing = true;
      this.clockStart = performance.now() - this.time * 1000;
      this._syncElements(true);
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this._loop);
    }

    pause() {
      if (!this.playing) return;
      this.playing = false;
      cancelAnimationFrame(this.raf);
      for (const entry of this._elCache.values()) {
        try { entry.el.pause(); } catch (e) { /* noop */ }
      }
      if (this.audioCtx && this.audioCtx.state === 'running') this.audioCtx.suspend();
    }

    stop() {
      this.pause();
      this.seek(0);
    }

    _loop = (now) => {
      if (!this.playing) return;
      const t = (now - this.clockStart) / 1000;
      if (t >= this.project.duration) {
        this.time = this.project.duration;
        this.render(this.time);
        this.pause();
        if (this.onEnd) this.onEnd();
        return;
      }
      this.time = t;
      this._syncElements(false);
      this.render(t);
      if (this.onTick) this.onTick(t);
      this.raf = requestAnimationFrame(this._loop);
    };

    seek(t) {
      t = Math.max(0, Math.min(this.project.duration || 0, t));
      this.time = t;
      if (this.playing) {
        this.clockStart = performance.now() - t * 1000;
        this._syncElements(true);
      } else {
        this._syncElements(true);
        this.render(t);
      }
    }

    /* ---------- 音视频元素同步 ---------- */
    _syncElements(force) {
      const P = this.project;
      for (const track of P.tracks) {
        for (const clip of track.clips) {
          if (clip.type !== 'video' && clip.type !== 'audio') continue;
          const entry = this._getElement(clip);
          if (!entry) continue;
          const inRange = this.time >= clip.start && this.time < clip.start + clip.duration;
          if (!inRange) {
            if (!entry.el.paused) { try { entry.el.pause(); } catch (e) {} }
            if (entry.gain) entry.gain.gain.value = 0;
            continue;
          }
          const asset = P.getAsset(clip.sourceId);
          const srcOff = (clip.sourceStart || 0) + (this.time - clip.start);
          const tMod = asset && asset.duration > 0 ? srcOff % asset.duration : srcOff;
          if (entry.gain) entry.gain.gain.value = (clip.volume === undefined ? 1 : clip.volume);
          else { try { entry.el.volume = clip.volume === undefined ? 1 : clip.volume; } catch (e) {} }
          const drift = Math.abs(entry.el.currentTime - tMod);
          if (force || drift > 0.25) {
            try { entry.el.currentTime = tMod; } catch (e) { /* noop */ }
          }
          if (entry.el.paused && this.playing) {
            entry.el.play().catch(() => { /* autoplay 策略忽略 */ });
          }
        }
      }
    }

    /* ---------- 帧渲染 ---------- */
    render(t) {
      const ctx = this.ctx;
      const W = this.project.width, H = this.project.height;
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      // 视频 / 图片轨（从下往上）
      for (const track of this.project.tracks) {
        if (track.type !== 'video') continue;
        for (const clip of track.clips) {
          if (t < clip.start || t >= clip.start + clip.duration) continue;
          this._drawMediaClip(ctx, clip, t);
        }
      }
      // 字幕轨（最上层）
      for (const track of this.project.tracks) {
        if (track.type !== 'text') continue;
        for (const clip of track.clips) {
          if (t < clip.start || t >= clip.start + clip.duration) continue;
          this._drawTextClip(ctx, clip);
        }
      }
      ctx.restore();
    }

    _drawMediaClip(ctx, clip, t) {
      const asset = this.project.getAsset(clip.sourceId);
      if (!asset) return;
      let src = null;
      if (asset.kind === 'video') {
        const entry = this._getElement(clip);
        if (!entry || entry.el.readyState < 2) return;
        src = entry.el;
      } else if (asset.kind === 'image') {
        src = this._getImage(asset);
        if (!src || !src.complete || src.naturalWidth === 0) return;
      } else {
        return;
      }

      const W = this.project.width, H = this.project.height;
      const dw = W * (clip.w === undefined ? 1 : clip.w);
      const dh = H * (clip.h === undefined ? 1 : clip.h);
      const dx = W * (clip.x === undefined ? 0 : clip.x);
      const dy = H * (clip.y === undefined ? 0 : clip.y);

      const sw0 = asset.kind === 'video' ? (clip._srcW || asset.width || src.videoWidth) : src.naturalWidth;
      const sh0 = asset.kind === 'video' ? (clip._srcH || asset.height || src.videoHeight) : src.naturalHeight;
      if (!sw0 || !sh0) return;

      // cover 铺满，保持比例
      const scale = Math.max(dw / sw0, dh / sh0);
      const cw = dw / scale, ch = dh / scale;
      const sx = (sw0 - cw) / 2, sy = (sh0 - ch) / 2;

      ctx.save();
      ctx.globalAlpha = clip.opacity === undefined ? 1 : clip.opacity;
      ctx.filter = buildFilter(clip.filters);
      try {
        ctx.drawImage(src, sx, sy, cw, ch, dx, dy, dw, dh);
      } catch (e) { /* 帧未就绪跳过 */ }
      ctx.restore();
    }

    _getImage(asset) {
      if (this._imgCache.has(asset.id)) return this._imgCache.get(asset.id);
      const img = new Image();
      img.src = asset.url;
      this._imgCache.set(asset.id, img);
      return img;
    }

    _drawTextClip(ctx, clip) {
      const W = this.project.width, H = this.project.height;
      const text = clip.text || ' ';
      const f = clip.fontSize || 64;
      const lines = String(text).split('\n');
      ctx.save();
      ctx.globalAlpha = clip.opacity === undefined ? 1 : clip.opacity;
      ctx.font = (clip.bold ? 'bold ' : '') + f + 'px "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // 背景条
      if (clip.bgColor && clip.bgColor !== 'transparent') {
        let maxW = 0;
        for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
        const bw = maxW + f * 0.9;
        const bh = lines.length * f * 1.25 + f * 0.6;
        const bx = W * (clip.x === undefined ? 0.5 : clip.x) - bw / 2;
        const by = H * (clip.y === undefined ? 0.85 : clip.y) - bh / 2;
        ctx.fillStyle = clip.bgColor;
        this._roundRect(ctx, bx, by, bw, bh, f * 0.25);
        ctx.fill();
      }

      ctx.fillStyle = clip.color || '#ffffff';
      const cx = W * (clip.x === undefined ? 0.5 : clip.x);
      const cy = H * (clip.y === undefined ? 0.85 : clip.y);
      const lineH = f * 1.25;
      const startY = cy - (lines.length - 1) * lineH / 2;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], cx, startY + i * lineH);
      }
      ctx.restore();
    }

    _roundRect(ctx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /* ---------- 导出捕获 ---------- */
    getCaptureStream() {
      if (!this._captureStream) {
        this._captureStream = this.canvas.captureStream(30);
      }
      return this._captureStream;
    }

    refresh() {
      this.render(this.time);
    }
  };

  VE.util = VE.util || {};
  VE.util.buildFilter = buildFilter;
  VE.util.defaultFilters = defaultFilters;
})();
