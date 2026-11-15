// Opt-in desktop voice I/O. No background microphone or persisted audio.
// Chromium's speech API can use an OS/browser service; it may be unavailable on Windows.
(function () {
  'use strict';
  var Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  var active = null;
  var output = false;
  var nativeWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '');

  function stop() {
    if (active) { var r = active; active = null; try { r.abort(); } catch (_) {} }
  }
  function speak(text) {
    if (!output) return false;
    var value = String(text || '').slice(0, 1000);
    if (!value) return false;
    if (nativeWindows && window.nqa?.voiceSpeak) {
      window.nqa.voiceSpeak({ text: value }).catch(function () {});
      return true;
    }
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return false;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(value));
    return true;
  }
  window.BonesVoice = {
    available: function () { return !!Speech; },
    listening: function () { return !!active; },
    setOutput: function (enabled) {
      output = enabled === true;
      if (!output) {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        window.nqa?.voiceStop?.({}).catch(function () {});
      }
    },
    stop: stop,
    cancelAudio: function () {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      window.nqa?.voiceStop?.({}).catch(function () {});
    },
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
