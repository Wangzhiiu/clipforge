/* ============================================================
 * ClipForge · player.js
 * 播放 / 画面合成引擎：多轨视频合成、转场、滤镜、字幕绘制、音频混音
 * ============================================================ */
(function () {
  'use strict';
  const VE = (window.VE = window.VE || {});

  /* ---------- 转场类型定义 ---------- */
  VE.TRANSITIONS = [
    { id: 'crossfade',  name: '叠化',   icon: '⇄' },
    { id: 'fade-black', name: '黑场',   icon: '◐' },
    { id: 'fade-white', name: '白场',   icon: '◑' },
    { id: 'slide-left', name: '左滑入', icon: '⤟' },
    { id: 'slide-right',name: '右滑入', icon: '⤠' },
    { id: 'wipe-right', name: '左擦除', icon: '▸' },
    { id: 'wipe-left',  name: '右擦除', icon: '◂' },
    { id: 'zoom-in',    name: '缩放',   icon: '⤢' },
    { id: 'blur',       name: '模糊',   icon: '◌' },
    { id: 'circle',     name: '圆形',   icon: '◎' },
    { id: 'spin',       name: '旋转',   icon: '⟳' },
    { id: 'split',      name: '分裂',   icon: '⫿' }
  ];

  VE.transitionName = (id) => {
    const t = VE.TRANSITIONS.find((x) => x.id === id);
    return t ? t.name : '未知';
  };

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

  /* ---------- 一键预设效果（滤镜组合） ---------- */
  VE.PRESETS = [
    { id: 'reset',    name: '默认',   icon: '↺', filters: null },
    { id: 'cinematic',name: '电影感', icon: '🎬', filters: { brightness: 1.03, contrast: 1.18, saturation: 1.06 } },
    { id: 'bw',       name: '黑白',   icon: '◐', filters: { grayscale: 1, contrast: 1.1 } },
    { id: 'retro',    name: '复古',   icon: '📼', filters: { sepia: 0.45, saturation: 0.75, contrast: 1.02, brightness: 1.02 } },
    { id: 'fresh',    name: '日系',   icon: '🌸', filters: { brightness: 1.12, contrast: 0.9, saturation: 1.18 } },
    { id: 'cyber',    name: '赛博',   icon: '🌆', filters: { hueRotate: 28, saturation: 1.55, contrast: 1.3, brightness: 1.02 } },
    { id: 'warm',     name: '暖阳',   icon: '☀️', filters: { sepia: 0.18, brightness: 1.06, saturation: 1.12 } },
    { id: 'cold',     name: '冷调',   icon: '❄️', filters: { hueRotate: 12, saturation: 0.85, brightness: 1.04, contrast: 1.08 } },
    { id: 'vivid',    name: '高饱和', icon: '🌈', filters: { saturation: 1.7, contrast: 1.12 } }
  ];

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

    /* ---------- 音视频元素同步（含转场提前激活） ---------- */
    _syncElements(force) {
      const P = this.project;
      const transB = new Set();
      for (const tr of P.transitions || []) {
        const a = P.getClip(tr.aClipId), b = P.getClip(tr.bClipId);
        if (!a || !b) continue;
        const start = b.start - tr.duration;
        if (this.time >= start && this.time < b.start) transB.add(b.id);
      }
      for (const track of P.tracks) {
        for (const clip of track.clips) {
          if (clip.type !== 'video' && clip.type !== 'audio') continue;
          const entry = this._getElement(clip);
          if (!entry) continue;
          const transActive = transB.has(clip.id);
          const inRange = (this.time >= clip.start && this.time < clip.start + clip.duration) || transActive;
          if (!inRange) {
            if (!entry.el.paused) { try { entry.el.pause(); } catch (e) {} }
            if (entry.gain) entry.gain.gain.value = 0;
            continue;
          }
          const asset = P.getAsset(clip.sourceId);
          let srcOff;
          if (transActive) srcOff = (clip.sourceStart || 0) + Math.max(0, this.time - clip.start);
          else srcOff = (clip.sourceStart || 0) + (this.time - clip.start);
          const tMod = asset && asset.duration > 0 ? srcOff % asset.duration : srcOff;
          if (transActive) {
            // 转场中 B 提前出现：画面可取，但声音保持静音
            if (entry.gain) entry.gain.gain.value = 0;
            else { try { entry.el.volume = 0; } catch (e) {} }
          } else {
            if (entry.gain) entry.gain.gain.value = (clip.volume === undefined ? 1 : clip.volume);
            else { try { entry.el.volume = clip.volume === undefined ? 1 : clip.volume; } catch (e) {} }
          }
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

    /* ---------- 转场查询 ---------- */
    _activeTransitions(t) {
      const out = [];
      for (const tr of this.project.transitions || []) {
        const a = this.project.getClip(tr.aClipId);
        const b = this.project.getClip(tr.bClipId);
        if (!a || !b || a.trackId !== b.trackId) continue;
        const start = b.start - tr.duration;
        if (t >= start && t < b.start) {
          out.push({ tr, a, b, p: Math.max(0, Math.min(1, (t - start) / tr.duration)) });
        }
      }
      return out;
    }

    /* ---------- 帧渲染 ---------- */
    render(t) {
      const ctx = this.ctx;
      const W = this.project.width, H = this.project.height;
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      const trans = this._activeTransitions(t);
      const skipA = new Set();
      for (const tr of trans) skipA.add(tr.a.id);

      // 视频 / 图片轨（从下往上，跳过转场中的前片段 A）
      for (const track of this.project.tracks) {
        if (track.type !== 'video') continue;
        for (const clip of track.clips) {
          if (skipA.has(clip.id)) continue;
          if (t < clip.start || t >= clip.start + clip.duration) continue;
          this._drawMediaClip(ctx, clip, t, {});
        }
      }
      // 转场合成（覆盖绘制）
      for (const tr of trans) this._drawTransition(ctx, tr, t);
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

    /* ---------- 转场绘制 ---------- */
    _drawTransition(ctx, tr, t) {
      const { a, b, p } = tr;
      const W = this.project.width, H = this.project.height;
      const type = tr.tr.type;
      const aActive = t >= a.start && t < a.start + a.duration;

      switch (type) {
        case 'crossfade':
          if (aActive) this._drawMediaClip(ctx, a, t, { alpha: 1 });
          this._drawMediaClip(ctx, b, t, { alpha: p });
          break;

        case 'fade-black': {
          const ap = Math.max(0, 1 - p * 2);
          const bp = Math.max(0, p * 2 - 1);
          if (aActive && ap > 0) this._drawMediaClip(ctx, a, t, { alpha: ap });
          if (bp > 0) this._drawMediaClip(ctx, b, t, { alpha: bp });
          break;
        }

        case 'fade-white': {
          const ap = Math.max(0, 1 - p * 2);
          const bp = Math.max(0, p * 2 - 1);
          if (aActive && ap > 0) this._drawMediaClip(ctx, a, t, {});
          if (bp > 0) this._drawMediaClip(ctx, b, t, {});
          ctx.save();
          ctx.fillStyle = '#ffffff';
          ctx.globalAlpha = Math.max(ap, bp) * 0.9;
          ctx.fillRect(0, 0, W, H);
          ctx.restore();
          break;
        }

        case 'slide-left':
          if (aActive) this._drawMediaClip(ctx, a, t, {});
          this._drawMediaClip(ctx, b, t, { dxo: (1 - p) * W });
          break;

        case 'slide-right':
          if (aActive) this._drawMediaClip(ctx, a, t, {});
          this._drawMediaClip(ctx, b, t, { dxo: -(1 - p) * W });
          break;

        case 'wipe-right':
          if (aActive) this._drawMediaClip(ctx, a, t, {});
          this._drawMediaClip(ctx, b, t, { clip: { x: 0, y: 0, w: p * W, h: H } });
          break;

        case 'wipe-left':
          if (aActive) this._drawMediaClip(ctx, a, t, {});
          this._drawMediaClip(ctx, b, t, { clip: { x: (1 - p) * W, y: 0, w: p * W, h: H } });
          break;

        case 'zoom-in':
          if (aActive) this._drawMediaClip(ctx, a, t, {});
          this._drawMediaClip(ctx, b, t, { scale: 0.25 + 0.75 * p });
          break;

        case 'blur': {
          const bl = Math.round((1 - p) * 24);
          if (aActive) this._drawMediaClip(ctx, a, t, { blur: bl });
          this._drawMediaClip(ctx, b, t, { blur: bl });
          break;
        }

        case 'circle':
          if (aActive) this._drawMediaClip(ctx, a, t, {});
          this._drawMediaClip(ctx, b, t, { circleClip: { cx: W / 2, cy: H / 2, r: Math.hypot(W, H) / 2 * p + 1 } });
          break;

        case 'spin':
          if (aActive) this._drawMediaClip(ctx, a, t, {});
          this._drawMediaClip(ctx, b, t, { rotate: (-15 * (1 - p)) * Math.PI / 180 });
          break;

        case 'split': {
          if (aActive) this._drawMediaClip(ctx, a, t, {});
          const w = (W / 2) * p;
          this._drawMediaClip(ctx, b, t, { clip: { x: 0, y: 0, w, h: H } });
          this._drawMediaClip(ctx, b, t, { clip: { x: W - w, y: 0, w, h: H } });
          break;
        }

        default: // 未知类型回退为叠化
          if (aActive) this._drawMediaClip(ctx, a, t, { alpha: 1 });
          this._drawMediaClip(ctx, b, t, { alpha: p });
      }
    }

    /* ---------- 单片段绘制 ---------- */
    _drawMediaClip(ctx, clip, t, opts) {
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

      const o = opts || {};
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
      ctx.globalAlpha = (clip.opacity === undefined ? 1 : clip.opacity) * (o.alpha === undefined ? 1 : o.alpha);

      // 变换：滑动 / 缩放 / 旋转（围绕片段中心）
      if (o.dxo || o.dyo || (o.scale && o.scale !== 1) || o.rotate) {
        ctx.translate(dx + dw / 2 + (o.dxo || 0), dy + dh / 2 + (o.dyo || 0));
        if (o.rotate) ctx.rotate(o.rotate);
        if (o.scale) ctx.scale(o.scale, o.scale);
        ctx.translate(-(dx + dw / 2), -(dy + dh / 2));
      }

      // 矩形裁剪（擦除 / 分裂）
      if (o.clip) {
        ctx.beginPath();
        ctx.rect(o.clip.x, o.clip.y, o.clip.w, o.clip.h);
        ctx.clip();
      }
      // 圆形裁剪
      if (o.circleClip) {
        ctx.beginPath();
        ctx.arc(o.circleClip.cx, o.circleClip.cy, Math.max(0.5, o.circleClip.r), 0, Math.PI * 2);
        ctx.clip();
      }

      // 滤镜 + 转场模糊
      const blurPx = o.blur || 0;
      ctx.filter = buildFilter(clip.filters) + (blurPx > 0 ? ' blur(' + blurPx + 'px)' : '');
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
