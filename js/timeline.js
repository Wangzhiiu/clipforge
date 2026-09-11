/* ============================================================
 * ClipForge · timeline.js
 * 时间线：标尺、轨道、片段渲染与拖拽交互、播放头
 * ============================================================ */
(function () {
  'use strict';
  const VE = (window.VE = window.VE || {});

  const EDGE = 7; // 边缘调整热区（px）
  const MIN_DUR = 0.15;

  VE.Timeline = class {
    /**
     * @param {HTMLElement} root    #timeline-scroll
     * @param {Object} project
     * @param {Object} cb  { onSeek(t), onSelect(clipId), onChange(), onDelete(clipId) }
     */
    constructor(root, project, cb) {
      this.root = root;
      this.project = project;
      this.cb = cb || {};
      this.pps = 20;                      // 每秒钟像素数
      this._drag = null;                  // 拖拽状态
      this._playheadEl = null;
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
    }

    /* ---------- 渲染 ---------- */
    rebuild() {
      const P = this.project;
      const total = Math.max(P.duration, 4);
      const width = Math.max(total * this.pps + 60, this.root.clientWidth || 800);

      this.root.innerHTML = '';

      // 标尺
      const ruler = document.createElement('div');
      ruler.id = 'ruler';
      ruler.style.width = width + 'px';
      ruler.addEventListener('pointerdown', (e) => this._onRulerDown(e));
      this._renderRuler(ruler, total);
      this.root.appendChild(ruler);

      // 轨道
      const tracks = document.createElement('div');
      tracks.id = 'tracks';
      tracks.style.width = width + 'px';
      for (const track of P.tracks) {
        const row = document.createElement('div');
        row.className = 'track-row';
        row.dataset.trackId = track.id;
        row.style.width = width + 'px';
        row.addEventListener('pointerdown', (e) => this._onRowDown(e, track.id));
        const label = document.createElement('span');
        label.className = 'track-label';
        const dot = document.createElement('i');
        dot.className = 'dot ' + (track.type === 'video' ? 'v' : track.type === 'audio' ? 'a' : 't');
        label.appendChild(dot);
        label.appendChild(document.createTextNode(track.name));
        row.appendChild(label);
        // 片段
        for (const clip of track.clips) {
          row.appendChild(this._buildClipEl(clip, track.type));
        }
        tracks.appendChild(row);
      }
      this.root.appendChild(tracks);

      // 播放头
      const ph = document.createElement('div');
      ph.id = 'playhead';
      this.root.appendChild(ph);
      this._playheadEl = ph;
      this._updatePlayhead();
    }

    _renderRuler(ruler, total) {
      // 选择刻度步长
      let step = 1;
      const steps = [0.25, 0.5, 1, 2, 5, 10, 30, 60];
      for (const s of steps) { step = s; if (s * this.pps >= 50) break; }
      const majorEvery = step < 1 ? 10 : 5; // 每 N 个刻度出现一个主刻度（带时间标签）
      const n = Math.ceil(total / step) + 1;
      for (let i = 0; i <= n; i++) {
        const t = i * step;
        const major = i % majorEvery === 0;
        const m = document.createElement('div');
        m.className = 'ruler-mark ' + (major ? 'major' : 'minor');
        m.style.left = t * this.pps + 'px';
        ruler.appendChild(m);
        if (major) {
          const l = document.createElement('span');
          l.className = 'ruler-label';
          l.style.left = t * this.pps + 'px';
          l.textContent = this._fmt(t);
          ruler.appendChild(l);
        }
      }
    }

    _fmt(t) {
      const s = Math.floor(t);
      const ms = Math.round((t - s) * 100);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m + ':' + (sec < 10 ? '0' : '') + sec + '.' + (ms < 10 ? '0' : '') + ms;
    }

    _buildClipEl(clip, trackType) {
      const el = document.createElement('div');
      el.className = 'tl-clip ' + trackType;
      el.dataset.clipId = clip.id;
      el.style.left = clip.start * this.pps + 'px';
      el.style.width = Math.max(clip.duration * this.pps - 2, 10) + 'px';

      const name = document.createElement('span');
      name.className = 'clip-name' + (clip.type === 'text' ? ' text-clip' : '');
      name.textContent = clip.type === 'text' ? (clip.text || '字幕') : this._clipName(clip);
      el.appendChild(name);

      // 视频缩略图背景
      const asset = this.project.getAsset(clip.sourceId);
      if ((clip.type === 'video' || clip.type === 'image') && asset && asset.thumbUrl) {
        const img = document.createElement('img');
        img.className = 'clip-thumb';
        img.src = asset.thumbUrl;
        img.draggable = false;
        el.appendChild(img);
      }

      // 边缘调整热区
      const hl = document.createElement('div');
      hl.className = 'resize-handle left';
      const hr = document.createElement('div');
      hr.className = 'resize-handle right';
      el.appendChild(hl);
      el.appendChild(hr);

      el.addEventListener('pointerdown', (e) => this._onClipDown(e, clip));
      el.addEventListener('dblclick', (e) => this._onClipDblClick(e, clip));
      return el;
    }

    _clipName(clip) {
      const asset = this.project.getAsset(clip.sourceId);
      if (!asset) return '缺失素材';
      return asset.name;
    }

    /* ---------- 交互 ---------- */
    _onRulerDown(e) {
      const x = e.clientX - this.root.getBoundingClientRect().left + this.root.scrollLeft;
      const t = Math.max(0, x / this.pps);
      if (this.cb.onSeek) this.cb.onSeek(t);
      this._startSeekDrag(e);
    }

    _onRowDown(e, trackId) {
      if (e.target.closest('.tl-clip')) return;
      const x = e.clientX - this.root.getBoundingClientRect().left + this.root.scrollLeft;
      if (this.cb.onSeek) this.cb.onSeek(Math.max(0, x / this.pps));
      this._startSeekDrag(e);
    }

    _startSeekDrag(e) {
      this._drag = { mode: 'seek' };
      document.addEventListener('pointermove', this._onPointerMove);
      document.addEventListener('pointerup', this._onPointerUp);
      e.preventDefault();
    }

    _onClipDown(e, clip) {
      if (this.cb.onSelect) this.cb.onSelect(clip.id);
      const rect = e.currentTarget.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const asset = this.project.getAsset(clip.sourceId);
      let mode = 'move';
      if (relX < EDGE) mode = 'resizeL';
      else if (relX > rect.width - EDGE) mode = 'resizeR';

      const startLeft = clip.start;
      const startDur = clip.duration;
      const startSrc = clip.sourceStart || 0;
      const startX = e.clientX;
      const startScroll = this.root.scrollLeft;
      const assetDur = asset && asset.duration > 0 ? asset.duration : Infinity;

      this._drag = {
        mode, clip, startLeft, startDur, startSrc, startX, startScroll,
        el: e.currentTarget
      };
      e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
      document.addEventListener('pointermove', this._onPointerMove);
      document.addEventListener('pointerup', this._onPointerUp);
      e.preventDefault();
      e.stopPropagation();
    }

    _onClipDblClick(e, clip) {
      if (clip.type === 'text' && this.cb.onEditText) this.cb.onEditText(clip.id);
    }

    _onPointerMove(e) {
      const d = this._drag;
      if (!d) return;
      if (d.mode === 'seek') {
        const x = e.clientX - this.root.getBoundingClientRect().left + this.root.scrollLeft;
        if (this.cb.onSeek) this.cb.onSeek(Math.max(0, x / this.pps));
        return;
      }
      // 片段拖拽
      const deltaSec = (e.clientX - d.startX) / this.pps;
      let { clip } = d;
      if (d.mode === 'move') {
        clip.start = Math.max(0, d.startLeft + deltaSec);
      } else if (d.mode === 'resizeR') {
        let dur = d.startDur + deltaSec;
        const srcLimit = d.assetDur === Infinity ? Infinity : (d.assetDur - d.startSrc);
        dur = Math.min(dur, srcLimit);
        dur = Math.max(MIN_DUR, dur);
        clip.duration = dur;
      } else if (d.mode === 'resizeL') {
        // 左边缘：start 增加、duration 减少、sourceStart 前移
        let delta = Math.max(0, d.startLeft + deltaSec) - d.startLeft;
        delta = Math.min(delta, d.startDur - MIN_DUR);
        if (d.startSrc + delta <= (d.assetDur === Infinity ? Infinity : d.assetDur)) {
          clip.start = d.startLeft + delta;
          clip.duration = d.startDur - delta;
          clip.sourceStart = d.startSrc + delta;
        }
      }
      this._applyClipLayout(d.el, clip);
      if (this.cb.onChange) this.cb.onChange();
    }

    _onPointerUp() {
      const d = this._drag;
      this._drag = null;
      if (!d) return;
      document.removeEventListener('pointermove', this._onPointerMove);
      document.removeEventListener('pointerup', this._onPointerUp);
      if (d.mode !== 'seek' && this.cb.onChangeEnd) this.cb.onChangeEnd();
    }

    _applyClipLayout(el, clip) {
      el.style.left = clip.start * this.pps + 'px';
      el.style.width = Math.max(clip.duration * this.pps - 2, 10) + 'px';
      const name = el.querySelector('.clip-name');
      if (name && clip.type === 'text') name.textContent = clip.text || '字幕';
    }

    /* ---------- 播放头 ---------- */
    _updatePlayhead() {
      if (!this._playheadEl) return;
      this._playheadEl.style.left = this.time * this.pps + 'px';
      const container = this.root;
      const ph = this.time * this.pps;
      if (ph < container.scrollLeft || ph > container.scrollLeft + container.clientWidth - 40) {
        container.scrollLeft = Math.max(0, ph - container.clientWidth / 2);
      }
    }

    setTime(t) {
      this.time = t;
      this._updatePlayhead();
    }

    /* ---------- 缩放 ---------- */
    setZoom(mult) {
      this.pps = Math.min(160, Math.max(4, this.pps * mult));
      this.rebuild();
      this._updatePlayhead();
    }
  };
})();
