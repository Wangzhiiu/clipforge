/* ============================================================
 * ClipForge · app.js
 * 主应用：项目模型、素材导入、属性面板、快捷键、保存/加载、导出
 * ============================================================ */
(function () {
  'use strict';
  const VE = (window.VE = window.VE || {});

  /* ---------------- 工具 ---------------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function fmtTime(t) {
    t = Math.max(0, t || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const cs = Math.floor((t - Math.floor(t)) * 100);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return p(h) + ':' + p(m) + ':' + p(s) + '.' + p(cs);
  }

  /* ---------------- 项目模型 ---------------- */
  VE.Project = class {
    constructor() {
      this.name = '未命名项目';
      this.width = 1920;
      this.height = 1080;
      this.fps = 30;
      this.assets = new Map();
      this.transitions = [];
      this.tracks = [
        { id: 'v1', type: 'video', name: '视频轨 1', clips: [] },
        { id: 'v2', type: 'video', name: '视频轨 2', clips: [] },
        { id: 'a1', type: 'audio', name: '音频轨', clips: [] },
        { id: 't1', type: 'text', name: '字幕轨', clips: [] }
      ];
    }

    getAsset(id) { return this.assets.get(id); }

    get duration() {
      let d = 0;
      for (const tr of this.tracks) {
        for (const c of tr.clips) d = Math.max(d, c.start + c.duration);
      }
      return d;
    }

    addAsset(asset) { this.assets.set(asset.id, asset); }

    addClip(trackId, clip) {
      const tr = this.tracks.find((t) => t.id === trackId);
      if (tr) {
        clip.trackId = trackId;
        tr.clips.push(clip);
      }
    }

    removeClip(clipId) {
      for (const tr of this.tracks) {
        tr.clips = tr.clips.filter((c) => c.id !== clipId);
      }
      // 清理引用该片段的转场
      this.transitions = this.transitions.filter((tr) => tr.aClipId !== clipId && tr.bClipId !== clipId);
    }

    getTransitionBetween(aClipId, bClipId) {
      return this.transitions.find((tr) => tr.aClipId === aClipId && tr.bClipId === bClipId);
    }

    addTransition(trackId, aClipId, bClipId, type, duration) {
      let tr = this.getTransitionBetween(aClipId, bClipId);
      if (tr) {
        tr.type = type;
        tr.duration = duration;
      } else {
        this.transitions.push({ id: uid(), type, duration, trackId, aClipId, bClipId });
      }
    }

    removeTransitionBetween(aClipId, bClipId) {
      this.transitions = this.transitions.filter((tr) => !(tr.aClipId === aClipId && tr.bClipId === bClipId));
    }

    getClip(clipId) {
      for (const tr of this.tracks) {
        for (const c of tr.clips) if (c.id === clipId) return c;
      }
      return null;
    }

    /** 在播放头处分割片段，返回是否成功 */
    split(clipId, t) {
      for (const tr of this.tracks) {
        const i = tr.clips.findIndex((c) => c.id === clipId);
        if (i < 0) continue;
        const c = tr.clips[i];
        if (t <= c.start + 0.05 || t >= c.start + c.duration - 0.05) return false;
        const right = Object.assign({}, c, {
          id: uid(),
          start: t,
          duration: c.duration - (t - c.start),
          sourceStart: (c.sourceStart || 0) + (t - c.start)
        });
        c.duration = t - c.start;
        tr.clips.splice(i + 1, 0, right);
        // 分割后清理引用原片段的转场，避免转场错位
        this.transitions = this.transitions.filter((x) => x.aClipId !== clipId && x.bClipId !== clipId);
        return true;
      }
      return false;
    }

    /** 序列化（不含媒体二进制，仅元数据 + 时间线） */
    serialize() {
      return JSON.stringify({
        app: 'clipforge',
        version: 1,
        name: this.name,
        width: this.width,
        height: this.height,
        fps: this.fps,
        assets: Array.from(this.assets.values()).map((a) => ({
          id: a.id, kind: a.kind, name: a.name, duration: a.duration,
          width: a.width, height: a.height
        })),
        tracks: this.tracks.map((t) => ({ id: t.id, type: t.type, name: t.name, clips: t.clips })),
        transitions: this.transitions
      }, null, 2);
    }

    /** 从 JSON 恢复（素材需重新关联文件） */
    static deserialize(json) {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      if (!data || data.app !== 'clipforge') throw new Error('不是有效的 ClipForge 项目文件');
      const p = new VE.Project();
      p.name = data.name || '未命名项目';
      p.width = data.width || 1920;
      p.height = data.height || 1080;
      p.fps = data.fps || 30;
      if (Array.isArray(data.assets)) {
        for (const a of data.assets) {
          p.assets.set(a.id, {
            id: a.id, kind: a.kind, name: a.name, duration: a.duration,
            width: a.width, height: a.height, url: null, thumbUrl: ''
          });
        }
      }
      if (Array.isArray(data.tracks)) {
        p.tracks = data.tracks.map((t) => ({
          id: t.id, type: t.type, name: t.name,
          clips: (t.clips || []).map((c) => Object.assign({}, c, { trackId: t.id, filters: Object.assign({}, VE.util.defaultFilters(), c.filters || {}) }))
        }));
      }
      p.transitions = Array.isArray(data.transitions) ? data.transitions : [];
      return p;
    }
  };

  /* ---------------- 主应用 ---------------- */
  VE.App = class {
    constructor() {
      this.project = new VE.Project();
      this.selectedClipId = null;
      this.player = null;
      this.timeline = null;
      this.exportHandle = null;
      this._toastTimer = null;

      this._cacheEls();
      this._initPlayer();
      this._initTimeline();
      this._initEvents();
      this._initKeyboard();
      this.refreshAll();
    }

    /* ---------- DOM ---------- */
    _cacheEls() {
      this.el = {
        canvas: document.getElementById('canvas'),
        mediaInput: document.getElementById('media-input'),
        mediaList: document.getElementById('media-list'),
        libraryEmpty: document.getElementById('library-empty'),
        propsBody: document.getElementById('props-body'),
        canvasHint: document.getElementById('canvas-hint'),
        btnPlay: document.getElementById('btn-play'),
        btnStop: document.getElementById('btn-stop'),
        timeDisplay: document.getElementById('time-display'),
        seekSlider: document.getElementById('seek-slider'),
        timelineScroll: document.getElementById('timeline-scroll'),
        timelineEmpty: document.getElementById('timeline-empty'),
        projectName: document.getElementById('project-name'),
        zoomLabel: document.getElementById('zoom-label'),
        exportOverlay: document.getElementById('export-overlay'),
        exportProgress: document.getElementById('export-progress'),
        exportStatus: document.getElementById('export-status'),
        btnExportCancel: document.getElementById('btn-export-cancel'),
        toast: document.getElementById('toast')
      };
    }

    _initPlayer() {
      this.player = new VE.Player(this.el.canvas, this.project);
      this.player.onTick = (t) => this._updateTransport(t);
    }

    _initTimeline() {
      this.timeline = new VE.Timeline(this.el.timelineScroll, this.project, {
        onSeek: (t) => this._seek(t),
        onSelect: (id) => this.selectClip(id),
        onChange: () => { /* 拖拽过程中轻量刷新 */ },
        onChangeEnd: () => {
          this.player.rebuildElements();
          this.timeline.rebuild();
          this.timeline.setTime(this.player.time);
          this.player.refresh();
          this.renderProps();
        },
        onDelete: (id) => this._deleteClip(id),
        onEditText: (id) => { this.selectClip(id); const ta = document.getElementById('prop-text'); if (ta) ta.focus(); },
        onTransitionChange: (trackId, aId, bId, type, duration) => {
          this.project.addTransition(trackId, aId, bId, type, duration);
          this.timeline.rebuild();
          this.timeline.setTime(this.player.time);
          this.player.refresh();
        },
        onTransitionDelete: (aId, bId) => {
          this.project.removeTransitionBetween(aId, bId);
          this.timeline.rebuild();
          this.timeline.setTime(this.player.time);
          this.player.refresh();
        }
      });
    }

    _initEvents() {
      const $ = (id) => document.getElementById(id);

      // 导入媒体
      this.el.mediaInput.addEventListener('change', () => this._handleFiles(this.el.mediaInput.files));
      // 字幕
      $('btn-text').addEventListener('click', () => this._addTextClip());
      // 分割 / 删除
      $('btn-split').addEventListener('click', () => this._splitSelected());
      $('btn-delete').addEventListener('click', () => this._deleteSelected());
      // 保存 / 加载
      $('btn-save').addEventListener('click', () => this._saveProject());
      $('btn-load').addEventListener('click', () => document.getElementById('project-input').click());
      document.getElementById('project-input').addEventListener('change', (e) => this._loadProjectFile(e));
      // 导出
      $('btn-export').addEventListener('click', () => this._startExport());
      this.el.btnExportCancel.addEventListener('click', () => this._cancelExport());
      // 传输控制
      this.el.btnPlay.addEventListener('click', () => this._togglePlay());
      this.el.btnStop.addEventListener('click', () => { this.player.stop(); this._updateTransport(0); });
      this.el.seekSlider.addEventListener('input', () => {
        const t = (this.el.seekSlider.value / 1000) * (this.project.duration || 1);
        this._seek(t);
      });
      // 缩放
      $('zoom-in').addEventListener('click', () => this._zoom(1.4));
      $('zoom-out').addEventListener('click', () => this._zoom(1 / 1.4));
      // 窗口变化重排时间线
      window.addEventListener('resize', () => this.timeline.rebuild());
    }

    _initKeyboard() {
      document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
        if (e.code === 'Space') {
          e.preventDefault();
          this._togglePlay();
        } else if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          this._splitSelected();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          this._deleteSelected();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          this._seek(this.player.time - 1 / this.project.fps);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          this._seek(this.player.time + 1 / this.project.fps);
        } else if (e.key === 'Home') {
          e.preventDefault();
          this.player.stop();
          this._updateTransport(0);
        }
      });
    }

    /* ---------- 媒体导入 ---------- */
    async _handleFiles(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      let added = 0;
      for (const file of files) {
        const kind = file.type.startsWith('video') ? 'video'
          : file.type.startsWith('image') ? 'image'
          : file.type.startsWith('audio') ? 'audio' : null;
        if (!kind) continue;
        const asset = {
          id: uid(), kind, name: file.name, url: URL.createObjectURL(file),
          duration: 0, width: 0, height: 0, thumbUrl: ''
        };
        try {
          if (kind === 'video') await this._loadVideoMeta(asset);
          else if (kind === 'image') await this._loadImageMeta(asset);
          else await this._loadAudioMeta(asset);
        } catch (e) {
          this._toast('素材读取失败：' + asset.name);
          continue;
        }
        this.project.addAsset(asset);
        added++;
      }
      this.renderLibrary();
      this._toast('已导入 ' + added + ' 个素材，点击左侧素材添加到时间线');
    }

    _loadVideoMeta(asset) {
      return new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.preload = 'auto';
        v.muted = true;
        v.playsInline = true;
        v.onloadedmetadata = () => {
          asset.duration = isFinite(v.duration) ? v.duration : 0;
          asset.width = v.videoWidth;
          asset.height = v.videoHeight;
          // 首帧缩略图
          v.currentTime = Math.min(0.1, Math.max(0, asset.duration - 0.1));
          v.onseeked = () => {
            try {
              const c = document.createElement('canvas');
              c.width = 160; c.height = 90;
              const ctx = c.getContext('2d');
              ctx.drawImage(v, 0, 0, 160, 90);
              asset.thumbUrl = c.toDataURL('image/jpeg', 0.7);
            } catch (e) { /* 缩略图失败忽略 */ }
            resolve();
          };
        };
        v.onerror = () => reject(new Error('video load error'));
        v.src = asset.url;
      });
    }

    _loadImageMeta(asset) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          asset.width = img.naturalWidth;
          asset.height = img.naturalHeight;
          asset.duration = 5;
          asset.thumbUrl = asset.url;
          resolve();
        };
        img.onerror = () => reject(new Error('image load error'));
        img.src = asset.url;
      });
    }

    _loadAudioMeta(asset) {
      return new Promise((resolve, reject) => {
        const a = document.createElement('audio');
        a.preload = 'metadata';
        a.onloadedmetadata = () => {
          asset.duration = isFinite(a.duration) ? a.duration : 0;
          resolve();
        };
        a.onerror = () => reject(new Error('audio load error'));
        a.src = asset.url;
      });
    }

    /* ---------- 素材库 ---------- */
    renderLibrary() {
      const list = this.el.mediaList;
      list.innerHTML = '';
      const assets = Array.from(this.project.assets.values());
      this.el.libraryEmpty.classList.toggle('hidden', assets.length > 0);
      for (const asset of assets) {
        const item = document.createElement('div');
        item.className = 'media-item' + (asset.url ? '' : ' missing');

        const thumb = document.createElement('div');
        thumb.className = 'media-thumb';
        if (asset.thumbUrl) {
          const img = document.createElement('img');
          img.src = asset.thumbUrl;
          thumb.appendChild(img);
        } else {
          thumb.textContent = asset.kind === 'audio' ? '♪' : asset.kind === 'image' ? '🖼' : '🎞';
        }
        item.appendChild(thumb);

        const meta = document.createElement('div');
        meta.className = 'media-meta';
        const name = document.createElement('div');
        name.className = 'media-name';
        name.textContent = asset.name;
        const sub = document.createElement('div');
        sub.className = 'media-sub';
        sub.textContent = asset.url ? this._assetInfo(asset) : '素材缺失 · 需重新导入';
        meta.appendChild(name);
        meta.appendChild(sub);
        item.appendChild(meta);

        if (!asset.url) {
          const btn = document.createElement('button');
          btn.className = 'reload-btn';
          btn.textContent = '重新导入';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._reloadAsset(asset);
          });
          item.appendChild(btn);
        } else {
          item.addEventListener('click', () => this._addAssetToTimeline(asset));
        }
        list.appendChild(item);
      }
    }

    _assetInfo(a) {
      const dur = a.duration ? a.duration.toFixed(1) + 's' : '--';
      const dim = a.width && a.height ? a.width + '×' + a.height : '';
      return [a.kind === 'video' ? '视频' : a.kind === 'image' ? '图片' : '音频', dur, dim].filter(Boolean).join(' · ');
    }

    _reloadAsset(asset) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = asset.kind === 'video' ? 'video/*' : asset.kind === 'image' ? 'image/*' : 'audio/*';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const oldUrl = asset.url;
        asset.url = URL.createObjectURL(file);
        asset.name = file.name;
        asset.thumbUrl = '';
        try {
          if (asset.kind === 'video') await this._loadVideoMeta(asset);
          else if (asset.kind === 'image') { asset.thumbUrl = asset.url; await this._loadImageMeta(asset); }
          else await this._loadAudioMeta(asset);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          this.player.rebuildElements();
          this.timeline.rebuild();
          this.renderLibrary();
          this._toast('素材已重新关联');
        } catch (e) {
          asset.url = null;
          this._toast('重新导入失败');
        }
      };
      input.click();
    }

    _addAssetToTimeline(asset) {
      let trackId, duration;
      if (asset.kind === 'video' || asset.kind === 'image') {
        trackId = 'v1';
        duration = asset.duration > 0 ? asset.duration : 5;
      } else {
        trackId = 'a1';
        duration = asset.duration > 0 ? asset.duration : 5;
      }
      const tr = this.project.tracks.find((t) => t.id === trackId);
      const end = tr.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const clip = {
        id: uid(),
        type: asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : 'video',
        start: end,
        duration,
        sourceStart: 0,
        sourceId: asset.id,
        x: 0, y: 0, w: 1, h: 1,
        opacity: 1, volume: 1,
        filters: VE.util.defaultFilters()
      };
      this.project.addClip(trackId, clip);
      this.player.rebuildElements();
      this.timeline.rebuild();
      this.timeline.setTime(this.player.time);
      this.selectClip(clip.id);
      this._syncCanvasHint();
    }

    /* ---------- 字幕 ---------- */
    _addTextClip() {
      const t = this.player.time;
      const clip = {
        id: uid(),
        type: 'text',
        start: Math.max(0, t - 1),
        duration: 3,
        text: '在这里输入字幕',
        fontSize: 64,
        color: '#ffffff',
        bgColor: 'rgba(0,0,0,0.45)',
        bold: false,
        x: 0.5, y: 0.85,
        opacity: 1
      };
      this.project.addClip('t1', clip);
      this.timeline.rebuild();
      this.timeline.setTime(this.player.time);
      this.selectClip(clip.id);
      const ta = document.getElementById('prop-text');
      if (ta) ta.focus();
    }

    /* ---------- 选中与属性面板 ---------- */
    selectClip(id) {
      if (this.selectedClipId === id) {
        this.renderProps();
        return;
      }
      this.selectedClipId = id;
      this.timeline.rebuild();
      this.timeline.setTime(this.player.time);
      this.renderProps();
    }

    renderProps() {
      const body = this.el.propsBody;
      const clip = this.project.getClip(this.selectedClipId);
      if (!clip) {
        body.innerHTML = '<div class="empty"><div class="empty-icon">⚙</div><div>选中时间线上的片段<br>在此调整位置 / 滤镜 / 字幕样式</div></div>';
        return;
      }
      const asset = this.project.getAsset(clip.sourceId);
      const html = [];
      const P = this.project;

      // 通用：名称与时间
      html.push('<div class="prop-group"><label>片段</label>');
      html.push('<div class="prop-row"><label>名称</label><input type="text" id="prop-name" value="' + this._esc(asset ? asset.name : '字幕片段') + '"></div>');
      html.push('<div class="prop-row"><label>开始</label><input type="number" id="prop-start" step="0.1" min="0" value="' + clip.start.toFixed(2) + '"><span class="val">s</span></div>');
      html.push('<div class="prop-row"><label>时长</label><input type="number" id="prop-dur" step="0.1" min="0.15" value="' + clip.duration.toFixed(2) + '"><span class="val">s</span></div>');
      html.push('</div>');

      // 视频 / 图片
      if (clip.type === 'video' || clip.type === 'image') {
        const f = clip.filters || VE.util.defaultFilters();
        html.push('<div class="prop-group"><label>位置与大小</label>');
        html.push(this._sliderRow('位置 X', 'prop-x', (clip.x || 0) * 100, 0, 100, '%'));
        html.push(this._sliderRow('位置 Y', 'prop-y', (clip.y || 0) * 100, 0, 100, '%'));
        html.push(this._sliderRow('宽度', 'prop-w', (clip.w === undefined ? 1 : clip.w) * 100, 1, 300, '%'));
        html.push(this._sliderRow('高度', 'prop-h', (clip.h === undefined ? 1 : clip.h) * 100, 1, 300, '%'));
        html.push(this._sliderRow('不透明度', 'prop-opacity', (clip.opacity === undefined ? 1 : clip.opacity) * 100, 0, 100, '%'));
        if (clip.type === 'video') {
          html.push(this._sliderRow('音量', 'prop-volume', (clip.volume === undefined ? 1 : clip.volume) * 100, 0, 200, '%'));
        }
        html.push('</div>');
        // 一键预设效果
        html.push('<div class="prop-group"><label>预设效果</label>');
        html.push('<div class="preset-grid">');
        for (const pr of VE.PRESETS) {
          html.push('<button class="preset-item" data-preset="' + pr.id + '" title="' + pr.name + '">' + pr.icon + '<span>' + pr.name + '</span></button>');
        }
        html.push('</div></div>');
        html.push('<div class="prop-group"><label>滤镜</label>');
        html.push(this._sliderRow('亮度', 'prop-brightness', (f.brightness === undefined ? 1 : f.brightness) * 100, 0, 300, '%'));
        html.push(this._sliderRow('对比度', 'prop-contrast', (f.contrast === undefined ? 1 : f.contrast) * 100, 0, 300, '%'));
        html.push(this._sliderRow('饱和度', 'prop-saturation', (f.saturation === undefined ? 1 : f.saturation) * 100, 0, 300, '%'));
        html.push(this._sliderRow('模糊', 'prop-blur', f.blur || 0, 0, 40, 'px'));
        html.push(this._sliderRow('灰度', 'prop-grayscale', (f.grayscale || 0) * 100, 0, 100, '%'));
        html.push(this._sliderRow('棕褐', 'prop-sepia', (f.sepia || 0) * 100, 0, 100, '%'));
        html.push(this._sliderRow('色相', 'prop-hue', f.hueRotate || 0, 0, 360, '°'));
        html.push('</div>');
      }

      // 音频
      if (clip.type === 'audio') {
        html.push('<div class="prop-group"><label>音量</label>');
        html.push(this._sliderRow('音量', 'prop-volume', (clip.volume === undefined ? 1 : clip.volume) * 100, 0, 200, '%'));
        html.push('</div>');
      }

      // 字幕
      if (clip.type === 'text') {
        html.push('<div class="prop-group"><label>字幕内容</label>');
        html.push('<textarea id="prop-text" rows="3">' + this._esc(clip.text || '') + '</textarea>');
        html.push('<div class="prop-row" style="margin-top:8px"><label>字号</label><input type="number" id="prop-fontsize" min="10" max="400" value="' + (clip.fontSize || 64) + '"><span class="val">px</span></div>');
        html.push('<div class="prop-row"><label>颜色</label><input type="color" id="prop-color" value="' + this._esc(clip.color || '#ffffff') + '"><span class="color-label">文字</span></div>');
        html.push('<div class="prop-row"><label>背景</label><input type="color" id="prop-bgcolor" value="' + this._esc(this._toHex(clip.bgColor)) + '"><span class="color-label">' + (clip.bgColor && clip.bgColor !== 'transparent' ? '有' : '无') + '</span><input type="checkbox" id="prop-bg-toggle" ' + (clip.bgColor && clip.bgColor !== 'transparent' ? 'checked' : '') + '></div>');
        html.push('<div class="prop-row"><label>加粗</label><input type="checkbox" id="prop-bold" ' + (clip.bold ? 'checked' : '') + '></div>');
        html.push(this._sliderRow('位置 X', 'prop-tx', (clip.x === undefined ? 0.5 : clip.x) * 100, 0, 100, '%'));
        html.push(this._sliderRow('位置 Y', 'prop-ty', (clip.y === undefined ? 0.85 : clip.y) * 100, 0, 100, '%'));
        html.push('</div>');
      }

      body.innerHTML = html.join('');
      this._bindProps(clip);
    }

    _sliderRow(label, id, value, min, max, unit) {
      const v = Math.round(value * 100) / 100;
      return '<div class="prop-row"><label>' + label + '</label>'
        + '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="1" value="' + v + '">'
        + '<span class="val">' + v + unit + '</span></div>';
    }

    _bindProps(clip) {
      const P = this.project;
      const $ = (id) => document.getElementById(id);
      const commit = () => {
        this.timeline.rebuild();
        this.timeline.setTime(this.player.time);
        this.player.rebuildElements();
        this.player.refresh();
        this.renderProps(); // 刷新数值显示
      };

      const num = (id, fn) => {
        const el = $(id);
        if (el) el.addEventListener('change', () => {
          fn(parseFloat(el.value) || 0);
          commit();
        });
      };
      const range = (id, fn) => {
        const el = $(id);
        if (el) el.addEventListener('input', () => {
          fn(parseFloat(el.value));
          // 即时更新预览
          this.timeline.rebuild();
          this.timeline.setTime(this.player.time);
          this.player.refresh();
          this._syncRangeLabel(el);
        });
      };

      // 通用
      num('prop-start', (v) => { clip.start = Math.max(0, v); });
      num('prop-dur', (v) => { clip.duration = Math.max(0.15, v); });

      // 位置大小
      range('prop-x', (v) => { clip.x = v / 100; });
      range('prop-y', (v) => { clip.y = v / 100; });
      range('prop-w', (v) => { clip.w = v / 100; });
      range('prop-h', (v) => { clip.h = v / 100; });
      range('prop-opacity', (v) => { clip.opacity = v / 100; });
      range('prop-volume', (v) => { clip.volume = v / 100; });

      // 滤镜
      const f = clip.filters = clip.filters || VE.util.defaultFilters();

      // 预设效果：一键应用滤镜组合
      const presetEls = this.el.propsBody.querySelectorAll('.preset-item');
      presetEls.forEach((btn) => {
        btn.addEventListener('click', () => {
          const pr = VE.PRESETS.find((x) => x.id === btn.dataset.preset);
          if (!pr) return;
          if (pr.filters) {
            Object.assign(f, VE.util.defaultFilters(), pr.filters);
          } else {
            Object.assign(f, VE.util.defaultFilters());
          }
          this.timeline.rebuild();
          this.timeline.setTime(this.player.time);
          this.player.refresh();
          this.renderProps();
        });
      });

      range('prop-brightness', (v) => { f.brightness = v / 100; });
      range('prop-contrast', (v) => { f.contrast = v / 100; });
      range('prop-saturation', (v) => { f.saturation = v / 100; });
      range('prop-blur', (v) => { f.blur = v; });
      range('prop-grayscale', (v) => { f.grayscale = v / 100; });
      range('prop-sepia', (v) => { f.sepia = v / 100; });
      range('prop-hue', (v) => { f.hueRotate = v; });

      // 字幕
      const ta = $('prop-text');
      if (ta) ta.addEventListener('input', () => { clip.text = ta.value; this.player.refresh(); });
      num('prop-fontsize', (v) => { clip.fontSize = Math.max(10, v); });
      const color = $('prop-color');
      if (color) color.addEventListener('input', () => { clip.color = color.value; this.player.refresh(); });
      const bg = $('prop-bgcolor');
      const bgToggle = $('prop-bg-toggle');
      if (bg) bg.addEventListener('input', () => { clip.bgColor = bg.value; this.player.refresh(); this._syncBgLabel(clip, bg, bgToggle); });
      if (bgToggle) bgToggle.addEventListener('change', () => {
        clip.bgColor = bgToggle.checked ? (bg ? bg.value : 'rgba(0,0,0,0.45)') : 'transparent';
        this.player.refresh();
        this._syncBgLabel(clip, bg, bgToggle);
      });
      const bold = $('prop-bold');
      if (bold) bold.addEventListener('change', () => { clip.bold = bold.checked; this.player.refresh(); });
      range('prop-tx', (v) => { clip.x = v / 100; });
      range('prop-ty', (v) => { clip.y = v / 100; });
    }

    _syncRangeLabel(input) {
      const row = input.closest('.prop-row');
      const val = row && row.querySelector('.val');
      if (val) val.textContent = input.value + (val.textContent.slice(-1) === '%' ? '%' : val.textContent.slice(-2));
    }

    _syncBgLabel(clip, bgInput, toggle) {
      if (!bgInput) return;
      const row = bgInput.closest('.prop-row');
      const label = row && row.querySelector('.color-label');
      if (label) label.textContent = clip.bgColor && clip.bgColor !== 'transparent' ? '有' : '无';
    }

    _toHex(colorStr) {
      if (!colorStr || colorStr === 'transparent') return '#000000';
      if (colorStr[0] === '#') return colorStr.slice(0, 7);
      // rgba(0,0,0,0.45) → 近似 hex
      const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const h = (n) => ('0' + Number(n).toString(16)).slice(-2);
        return '#' + h(m[1]) + h(m[2]) + h(m[3]);
      }
      return '#000000';
    }

    _esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    /* ---------- 编辑操作 ---------- */
    _splitSelected() {
      if (!this.selectedClipId) { this._toast('请先选中一个片段'); return; }
      const ok = this.project.split(this.selectedClipId, this.player.time);
      if (ok) {
        this.player.rebuildElements();
        this.timeline.rebuild();
        this.timeline.setTime(this.player.time);
        this._toast('已在 ' + this.player.time.toFixed(2) + 's 处分割');
      }
    }

    _deleteSelected() {
      if (!this.selectedClipId) { this._toast('请先选中一个片段'); return; }
      this.project.removeClip(this.selectedClipId);
      this.selectedClipId = null;
      this.player.rebuildElements();
      this.timeline.rebuild();
      this.timeline.setTime(this.player.time);
      this.renderProps();
    }

    /* ---------- 播放 / 定位 ---------- */
    _togglePlay() {
      if (this.player.playing) {
        this.player.pause();
      } else {
        this.player.play();
      }
      this._updateTransport(this.player.time);
    }

    _seek(t) {
      this.player.seek(t);
      this._updateTransport(this.player.time);
    }

    _updateTransport(t) {
      const d = this.project.duration;
      this.el.timeDisplay.textContent = fmtTime(t) + ' / ' + fmtTime(d);
      this.el.seekSlider.value = Math.round((d > 0 ? t / d : 0) * 1000);
      this.el.btnPlay.textContent = this.player.playing ? '⏸' : '▶';
      this.el.btnPlay.classList.toggle('playing', this.player.playing);
      this.timeline.setTime(t);
    }

    /* ---------- 缩放 ---------- */
    _zoom(mult) {
      this.timeline.setZoom(mult);
      this.el.zoomLabel.textContent = (this.timeline.pps / 20).toFixed(1) + '×';
    }

    /* ---------- 保存 / 加载 ---------- */
    _saveProject() {
      const json = this.project.serialize();
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (this.project.name || 'clipforge-project') + '.clipforge.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this._toast('项目已保存（素材文件需重新导入）');
    }

    _loadProjectFile(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const p = VE.Project.deserialize(reader.result);
          this.project = p;
          this.selectedClipId = null;
          this.player = new VE.Player(this.el.canvas, p);
          this.player.onTick = (t) => this._updateTransport(t);
          this._initTimeline();
          this.refreshAll();
          this._toast('项目已加载，缺失素材请在素材库重新导入');
        } catch (err) {
          this._toast('项目文件解析失败：' + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    }

    /* ---------- 导出 ---------- */
    _startExport() {
      if (this.exportHandle) { this._toast('正在导出中…'); return; }
      const self = this;
      this.el.exportOverlay.classList.remove('hidden');
      this.el.exportProgress.style.width = '0%';
      this.el.exportStatus.textContent = '正在合成画面…';

      this.exportHandle = VE.Exporter.exportVideo(this.project, this.player, {
        onProgress: (p) => {
          this.el.exportProgress.style.width = (p * 100).toFixed(1) + '%';
          this.el.exportStatus.textContent = '合成进度 ' + (p * 100).toFixed(0) + '%（实时渲染中，请勿切换窗口）';
        },
        onDone: (blob) => {
          this.exportHandle = null;
          this.el.exportOverlay.classList.add('hidden');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (this.project.name || 'clipforge') + '.webm';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 3000);
          this._toast('导出完成 🎉 已下载 ' + (blob.size / 1048576).toFixed(1) + ' MB 视频');
        },
        onError: (msg) => {
          this.exportHandle = null;
          this.el.exportOverlay.classList.add('hidden');
          this._toast(msg);
        },
        onCanceled: () => {
          this.exportHandle = null;
          this.el.exportOverlay.classList.add('hidden');
          this._toast('已取消导出');
        }
      });
      if (!this.exportHandle) this.el.exportOverlay.classList.add('hidden');
    }

    _cancelExport() {
      if (this.exportHandle) this.exportHandle.cancel();
    }

    /* ---------- 全局刷新 ---------- */
    refreshAll() {
      this.el.projectName.textContent = this.project.name;
      this.renderLibrary();
      this.timeline.rebuild();
      this.timeline.setTime(this.player.time);
      this.player.refresh();
      this.renderProps();
      this._updateTransport(0);
      this._syncCanvasHint();
    }

    _syncCanvasHint() {
      const hasMedia = this.project.assets.size > 0;
      this.el.canvasHint.classList.toggle('hidden', hasMedia);
    }

    /* ---------- Toast ---------- */
    _toast(msg) {
      const t = this.el.toast;
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
    }
  };

  // 启动
  document.addEventListener('DOMContentLoaded', () => {
    window.clipforge = new VE.App();
  });
})();
