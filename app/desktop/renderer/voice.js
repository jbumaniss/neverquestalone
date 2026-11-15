// Opt-in desktop voice I/O. No background microphone, audio files or third-party STT endpoint.
// The browser's speech service may be unavailable on a Windows installation; fail closed.
(function () {
  'use strict';
  var Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  var active = null;
  var output = false;

  function stop() {
    if (active) { var r = active; active = null; try { r.abort(); } catch (_) {} }
  }
  function speak(text) {
    if (!output || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return false;
    var value = String(text || '').slice(0, 1000);
    if (!value) return false;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(value));
    return true;
  }
  window.BonesVoice = {
    available: function () { return !!Speech; },
    listening: function () { return !!active; },
    setOutput: function (enabled) {
      output = enabled === true;
      if (!output && window.speechSynthesis) window.speechSynthesis.cancel();
    },
    stop: stop,
    cancelAudio: function () { if (window.speechSynthesis) window.speechSynthesis.cancel(); },
    speak: speak,
    start: function (onResult, onError, onEnd) {
      stop();
      if (!Speech) { onError('Speech recognition is unavailable on this computer.'); return false; }
      var r = new Speech();
      r.continuous = false;
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.lang = 'en-US';
      r.onresult = function (ev) {
        var t = ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript;
        if (typeof t === 'string' && t.trim()) onResult(t.trim());
      };
      r.onerror = function (ev) { onError(ev.error || 'Speech recognition failed.'); };
      r.onend = function () { if (active === r) active = null; onEnd(); };
      active = r;
      try { r.start(); } catch (e) { active = null; onError(e.message || 'Microphone unavailable.'); return false; }
      return true;
    },
  };
})();
