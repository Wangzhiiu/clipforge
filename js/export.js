/* ============================================================
 * ClipForge · export.js
 * 导出引擎：canvas 实时合成 → MediaRecorder 录制 WebM（含音频）
 * ============================================================ */
(function () {
  'use strict';
  const VE = (window.VE = window.VE || {});

  VE.Exporter = {
    /**
     * 导出当前项目为 WebM 视频
     * @param {Object} project
     * @param {VE.Player} player
     * @param {Object} opts { onProgress(p), onDone(blob), onError(msg), onCanceled() }
     * @returns {{ cancel: Function }}
     */
    exportVideo(project, player, opts) {
      const o = opts || {};
      const duration = project.duration;

      if (duration <= 0.01) {
        if (o.onError) o.onError('时间线是空的，先添加一些素材再导出吧');
        return null;
      }

      let canceled = false;
      let recorder = null;
      let intervalId = null;

      // 1. 准备捕获流
      let stream;
      try {
        const vStream = player.getCaptureStream();
        const aStream = player.getAudioStream();
        const tracks = [];
        for (const t of vStream.getVideoTracks()) tracks.push(t);
        if (aStream) {
          for (const t of aStream.getAudioTracks()) tracks.push(t);
        }
        stream = new MediaStream(tracks);
      } catch (e) {
        if (o.onError) o.onError('无法创建媒体捕获流：' + e.message);
        return null;
      }

      // 2. 选择编码
      const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ];
      const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      if (!window.MediaRecorder) {
        if (o.onError) o.onError('当前浏览器不支持 MediaRecorder，请使用最新版 Chrome / Edge');
        return null;
      }

      // 3. 初始化录制器
      try {
        recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 12_000_000,
          audioBitsPerSecond: 192_000
        });
      } catch (e) {
        if (o.onError) o.onError('初始化录制器失败：' + e.message);
        return null;
      }

      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };

      // 4. 定位到开头并开始录制
      player.pause();
      player.seek(0);
      player.render(0);

      const finish = (ok) => {
        if (intervalId) clearInterval(intervalId);
        player.onEnd = null;
        player.pause();
        if (ok && !canceled) {
          const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
          if (o.onDone) o.onDone(blob);
        }
      };

      recorder.onstop = () => {
        finish(true);
      };
      recorder.onerror = () => {
        canceled = true;
        if (o.onError) o.onError('录制过程中发生错误，请重试');
        try { recorder.stop(); } catch (e) { /* noop */ }
      };

      player.onEnd = () => {
        // 播放结束后停止录制
        setTimeout(() => {
          try { if (recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* noop */ }
        }, 120);
      };

      intervalId = setInterval(() => {
        if (o.onProgress) o.onProgress(Math.min(1, player.time / duration));
      }, 120);

      try {
        recorder.start(400);
        player.play();
      } catch (e) {
        if (intervalId) clearInterval(intervalId);
        if (o.onError) o.onError('导出启动失败：' + e.message);
        return null;
      }

      return {
        cancel() {
          canceled = true;
          try { if (recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* noop */ }
          if (o.onCanceled) o.onCanceled();
        }
      };
    }
  };
})();
