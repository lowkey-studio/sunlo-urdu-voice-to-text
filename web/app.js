// Sunlo browser app. Audio goes to the Sunlo API only to be transcribed; nothing is stored.
(function () {
  var API = 'https://sunlo-api.appin60.com';
  try { API = localStorage.getItem('sunlo_api') || API; } catch (e) {}
  var SITE = 'https://sunlo.appin60.com';
  var MAX_SEC = 600, CHUNK = 150;
  try { CHUNK = parseFloat(localStorage.getItem('sunlo_chunk')) || CHUNK; } catch (e) {}
  var $ = function (id) { return document.getElementById(id); };
  var src0 = (document.body.getAttribute('data-page') || 'home');
  try { var rh = document.referrer ? new URL(document.referrer).hostname : ''; if (rh === location.hostname) rh = 'internal'; var tk0 = localStorage.getItem('sunlo_test');
    fetch(API + '/api/event', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Src': src0 }, tk0 ? { 'X-Test': tk0 } : {}), body: JSON.stringify({ kind: 'view', ref: (new URLSearchParams(location.search).get('src') || rh) }) });
  } catch (e) {}
  var form = $('tool'); if (!form) return;
  var fileIn = $('file'), result = $('result'), status = $('status'), recBtn = $('rec'), last = null;
  var src = (document.body.getAttribute('data-page') || 'home');

  var TK = '', PRO = ''; try { TK = localStorage.getItem('sunlo_test') || ''; PRO = localStorage.getItem('sunlo_pro') || ''; } catch (e) {}
  if (PRO) { MAX_SEC = 3600; }
  function H(h) { h = h || {}; h['Content-Type'] = h['Content-Type'] || 'application/json'; h['X-Src'] = src; if (TK) h['X-Test'] = TK; if (PRO) h['X-Pro'] = PRO; return h; }
  function ev(kind) { try { fetch(API + '/api/event', { method: 'POST', headers: H(), body: JSON.stringify({ kind: kind }) }); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function say(html, tone) { status.innerHTML = html ? '<div class="callout ' + (tone ? 'callout-' + tone : '') + '"><div><p>' + html + '</p></div></div>' : ''; }

  function wavFrom(buf) {
    var ch = buf.numberOfChannels, n = buf.length, data = new Float32Array(n);
    for (var c = 0; c < ch; c++) { var d = buf.getChannelData(c); for (var i = 0; i < n; i++) data[i] += d[i] / ch; }
    var out = new DataView(new ArrayBuffer(44 + n * 2)), sr = buf.sampleRate;
    function w(o, s) { for (var i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); }
    w(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 2, true);
    for (var j = 0; j < n; j++) { var x = Math.max(-1, Math.min(1, data[j])); out.setInt16(44 + j * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Blob([out], { type: 'audio/wav' });
  }

  async function prepare(file) {
    var dur = null, body = file, type = file.type || 'application/octet-stream', buf = null;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC({ sampleRate: 16000 });
      buf = await new Promise(function (ok, bad) { file.arrayBuffer().then(function (ab) { var p = ctx.decodeAudioData(ab, ok, bad); if (p && p.catch) p.catch(bad); }, bad); });
      dur = buf.duration;
      if (ctx.close) ctx.close();
      // small compressed notes go as they are; large files or video become 16 kHz mono WAV
      if (file.size > 3 * 1024 * 1024 || /^video\//.test(type) || buf.sampleRate !== 16000 && file.size > 1.5 * 1024 * 1024) {
        if (dur <= MAX_SEC + 1) { body = wavFrom(buf); type = 'audio/wav'; }
      }
    } catch (e) { dur = null; }
    return { body: body, type: type, dur: dur, buf: (typeof buf !== 'undefined') ? buf : null };
  }

  async function run(file) {
    if (!file) return;
    ev('pick');
    result.innerHTML = '';
    say('<span class="loading">Note parha ja raha hai… (aam tor par 5 se 20 second)</span>');
    form.setAttribute('aria-busy', 'true');
    var p = await prepare(file);
    if (p.dur && p.dur > MAX_SEC + 1) { say('Yeh recording ' + Math.round(p.dur / 60) + ' minute ki hai. ' + (PRO ? 'Pro mein 60 minute tak ki recording chalti hai.' : 'Muft version 10 minute tak parhta hai. 60 minute tak ke liye neeche Sunlo Pro dekhein.') + '', 'warn'); form.removeAttribute('aria-busy'); ev('too_long'); return; }
    var parts = [];
    if (p.buf && p.dur > CHUNK * 1.2) {
      var sr = p.buf.sampleRate, L = p.buf.length, mix = new Float32Array(L);
      for (var c = 0; c < p.buf.numberOfChannels; c++) { var d = p.buf.getChannelData(c); for (var i = 0; i < L; i++) mix[i] += d[i] / p.buf.numberOfChannels; }
      var cuts = [0], step = Math.round(CHUNK * sr), win = Math.round(0.05 * sr);
      while (L - cuts[cuts.length - 1] > step * 1.2) {
        // cut at the quietest 50 ms window in the last quarter of the chunk, so words are not split
        var lo = cuts[cuts.length - 1] + Math.round(step * 0.75), hi = Math.min(L - win, cuts[cuts.length - 1] + step), best = hi, bestE = Infinity;
        for (var w0 = lo; w0 < hi; w0 += win) { var e = 0; for (var j = w0; j < w0 + win; j++) e += mix[j] * mix[j]; if (e < bestE) { bestE = e; best = w0 + (win >> 1); } }
        cuts.push(best);
      }
      cuts.push(L);
      for (var k = 0; k + 1 < cuts.length; k++) {
        var seg = new AudioBuffer({ length: cuts[k + 1] - cuts[k], numberOfChannels: 1, sampleRate: sr });
        seg.getChannelData(0).set(mix.subarray(cuts[k], cuts[k + 1]));
        parts.push({ body: wavFrom(seg), type: 'audio/wav', dur: seg.length / sr });
      }
    } else {
      if (!p.dur && file.size > 6 * 1024 * 1024) { say('Is file ko phone par parha nahin ja saka. 5 minute se chhoti awaz wali file (MP3, M4A, OGG) chunein.', 'warn'); form.removeAttribute('aria-busy'); return; }
      parts.push(p);
    }
    var out = { urdu: [], roman: [], english: [], seconds: 0 };
    for (var q = 0; q < parts.length; q++) {
      if (parts.length > 1) say('<span class="loading">Lambi recording: hissa ' + (q + 1) + ' / ' + parts.length + ' parha ja raha hai…</span>');
      var headers = H({ 'Content-Type': parts[q].type });
      if (parts[q].dur) headers['X-Duration'] = String(Math.round(parts[q].dur * 10) / 10);
      headers['X-Asr-Only'] = '1';  // Urdu first; Roman Urdu and English follow in one /api/translate call
      if (parts.length > 1) headers['X-Part'] = (q + 1) + '/' + parts.length;
      try {
        var r = await fetch(API + '/api/transcribe', { method: 'POST', headers: headers, body: parts[q].body });
        var j = await r.json();
        if (!r.ok) { if (j.error === 'no_speech' && parts.length > 1) continue; form.removeAttribute('aria-busy'); say(esc(j.msg || 'Kuch ghalat ho gaya. Dobara koshish karein.') + (q ? ' (Pehle ' + q + ' hisse neeche hain.)' : ''), 'warn'); if (q) show(join(out)); return; }
        out.urdu.push(j.urdu); out.roman.push(j.roman || ''); out.english.push(j.english || ''); out.seconds += j.seconds || 0;
      } catch (e) { form.removeAttribute('aria-busy'); say('Internet ka masla lagta hai. Dobara koshish karein.', 'warn'); if (q) show(join(out)); return; }
    }
    var res = join(out);
    if (res.urdu) {
      show(res);
      say('<span class="loading">Urdu tayar hai. Roman Urdu aur English tayar ho rahe hain…</span>');
      try { var tr = await fetch(API + '/api/translate', { method: 'POST', headers: H(), body: JSON.stringify({ text: res.urdu }) }); var tj = await tr.json(); res.roman = tj.roman || ''; res.english = tj.english || ''; if (!tr.ok && tj.msg) { say(esc(tj.msg), 'warn'); form.removeAttribute('aria-busy'); show(res); return; } } catch (e) {}
    }
    form.removeAttribute('aria-busy'); say(''); show(res);
  }
  function join(o) { var sep = ' '; return { urdu: o.urdu.join(sep), roman: o.roman.filter(Boolean).join(sep), english: o.english.filter(Boolean).join(sep), seconds: Math.round(o.seconds) }; }

  function block(id, label, text, cls, lang) {
    return '<div class="out-block"><div class="out-head"><span>' + label + '</span><button class="btn btn-ghost btn-sm" type="button" data-copy-from="' + id + '">Copy</button></div>' +
      '<div class="out-text ' + (cls || '') + '" id="' + id + '"' + (lang ? ' lang="' + lang + '" dir="rtl"' : '') + '>' + esc(text) + '</div></div>';
  }
  function shareText() {
    var t = '';
    if (last.urdu) t += last.urdu + '\n\n';
    if (last.roman) t += last.roman + '\n\n';
    if (last.english && $('want-en') && $('want-en').checked) t += 'English: ' + last.english + '\n\n';
    return t + '(Voice note se likha gaya: ' + SITE + '/?src=wa )';
  }
  function show(j) {
    last = j;
    var en = $('want-en') && $('want-en').checked;
    var h = '<div class="result-head"><div class="verdict"><span class="tag tag-ok tag-dot">Ho gaya</span> ' + j.seconds + ' second ki recording</div><span class="tag">Machine transcript: ahem baat khud check karein</span></div><div class="out">';
    h += block('o-ur', 'اردو', j.urdu, 'ur', 'ur');
    if (j.roman) h += block('o-ro', 'Roman Urdu', j.roman);
    if (en && j.english) h += block('o-en', 'English (machine translation)', j.english);
    h += '</div><div class="actions no-print">' +
      '<a class="btn" id="wa" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(shareText()) + '">WhatsApp par bhejein</a>' +
      (navigator.share ? '<button class="btn btn-secondary" type="button" id="sh">Share</button>' : '') +
      '<button class="btn btn-secondary" type="button" id="dl">.txt download</button>' +
      '<button class="btn btn-ghost" type="button" id="again">Ek aur note</button></div>' +
      '<p class="small no-print">Ghar walon ya dosto ko bhi Urdu voice notes parhne mein mushkil hoti hai? <a id="tell" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent('Urdu voice note sun nahin sakte? Yahan daalo, Urdu, Roman Urdu aur English mein likh deta hai. Free: ' + SITE + '/?src=tell') + '">Unhein Sunlo ka link WhatsApp par bhejein</a>.</p>' +
      '<div class="fb no-print" id="fb"><p class="small">Kya yeh transcript theek tha? Aap ka jawab tool behtar banata hai.</p><div class="choice">' +
      '<button class="btn btn-secondary btn-sm" type="button" data-rate="good">Haan, theek tha</button>' +
      '<button class="btn btn-secondary btn-sm" type="button" data-rate="some">Kuch ghaltiyan</button>' +
      '<button class="btn btn-secondary btn-sm" type="button" data-rate="bad">Bilkul ghalat</button></div></div>';
    result.innerHTML = h;
    $('wa').onclick = function () { ev('share_whatsapp'); };
    $('tell').onclick = function () { ev('share_tool'); };
    if ($('sh')) $('sh').onclick = function () { ev('share_native'); navigator.share({ text: shareText() }).catch(function () {}); };
    $('dl').onclick = function () { ev('download'); var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([shareText()], { type: 'text/plain;charset=utf-8' })); a.download = 'sunlo-voice-note.txt'; a.click(); };
    $('again').onclick = function () { result.innerHTML = ''; fileIn.value = ''; fileIn.click(); };
    result.querySelectorAll('[data-copy-from]').forEach(function (b) { b.onclick = function () { navigator.clipboard.writeText($(b.getAttribute('data-copy-from')).textContent + '\n\n' + SITE + '/?src=copy').then(function () { b.textContent = 'Copied'; ev('copy'); setTimeout(function () { b.textContent = 'Copy'; }, 2000); }); }; });
    result.querySelectorAll('[data-rate]').forEach(function (b) { b.onclick = function () { rate(b.getAttribute('data-rate')); }; });
  }
  function rate(r) {
    fetch(API + '/api/feedback', { method: 'POST', headers: H(), body: JSON.stringify({ rating: r }) });
    $('fb').innerHTML = '<p class="small">Shukriya! Kya ghalat tha, ya aap is tool ko kis kaam ke liye use karte hain? (optional)</p>' +
      '<textarea class="textarea" id="fb-t" rows="3" placeholder="Maslan: naam ghalat likhe, ya English translation achhi thi"></textarea>' +
      '<div class="row-gap" style="margin-top:8px"><input class="input" id="fb-e" type="email" placeholder="Email (optional, jawab ke liye)" style="max-width:280px"><button class="btn btn-sm" type="button" id="fb-s">Bhejein</button></div>';
    $('fb-s').onclick = function () {
      fetch(API + '/api/feedback', { method: 'POST', headers: H(), body: JSON.stringify({ rating: r + '_text', text: $('fb-t').value, email: $('fb-e').value }) });
      $('fb').innerHTML = '<p class="small">Mil gaya, shukriya.</p>';
    };
  }

  fileIn.addEventListener('change', function () { run(fileIn.files[0]); });
  var dz = $('dz');
  if (dz) {
    ['dragenter', 'dragover'].forEach(function (e) { dz.addEventListener(e, function (x) { x.preventDefault(); dz.classList.add('is-over'); }); });
    ['dragleave', 'drop'].forEach(function (e) { dz.addEventListener(e, function (x) { x.preventDefault(); dz.classList.remove('is-over'); }); });
    dz.addEventListener('drop', function (x) { if (x.dataTransfer.files[0]) run(x.dataTransfer.files[0]); });
  }

  // record from the microphone (Urdu voice typing)
  var mr = null, chunks = [], t0 = 0, timer = null;
  if (recBtn) {
    if (!navigator.mediaDevices || !window.MediaRecorder) recBtn.hidden = true;
    recBtn.onclick = async function () {
      if (mr && mr.state === 'recording') { mr.stop(); return; }
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = []; mr = new MediaRecorder(stream);
        mr.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        mr.onstop = function () { clearInterval(timer); stream.getTracks().forEach(function (t) { t.stop(); }); recBtn.textContent = 'Bol kar likhein'; recBtn.classList.remove('rec-on');
          var b = new Blob(chunks, { type: mr.mimeType || 'audio/webm' }); ev('record'); run(new File([b], 'recording', { type: b.type })); };
        mr.start(); t0 = Date.now(); recBtn.classList.add('rec-on');
        timer = setInterval(function () { var s = Math.round((Date.now() - t0) / 1000); recBtn.textContent = 'Rokein (' + s + 's)'; if (s >= MAX_SEC) mr.stop(); }, 500);
      } catch (e) { say('Mic ki ijazat nahin mili. Browser settings mein mic allow karein.', 'warn'); }
    };
  }

  // Sunlo Pro checkout (card, through Whop)
  document.querySelectorAll('[data-buy-pro]').forEach(function (b) { b.addEventListener('click', function () {
    b.setAttribute('aria-busy', 'true'); ev('pro_click');
    fetch(API + '/api/pro/start', { method: 'POST', headers: H() }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.url) { try { localStorage.setItem('sunlo_pro_pending', j.token); } catch (e) {} location.href = j.url; }
      else { b.removeAttribute('aria-busy'); alert(j.msg || 'Checkout abhi nahin khul saka.'); }
    }).catch(function () { b.removeAttribute('aria-busy'); alert('Internet ka masla. Dobara koshish karein.'); });
  }); });
  if (PRO && $('pro-state')) $('pro-state').innerHTML = '<span class="tag tag-ok tag-dot">Pro active</span> Is browser mein 60 minute tak ki recordings.';

  // email opt-in
  var su = $('signup');
  if (su) su.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('su-email').value, purpose = (su.querySelector('[name=purpose]:checked') || su.querySelector('[name=purpose]') || {}).value || 'updates';
    fetch(API + '/api/signup', { method: 'POST', headers: H(), body: JSON.stringify({ email: email, purpose: purpose, note: ($('su-note') || {}).value || '' }) })
      .then(function (r) { return r.json(); }).then(function (j) {
        $('su-msg').textContent = j.ok ? 'Shukriya! Confirm karne ke liye aap ke email par link aayega (kuch ghanton mein).' : (j.msg || 'Dobara koshish karein.');
        if (j.ok) ev('signup_' + purpose);
      });
  });

  // file shared from WhatsApp into the installed app (share target)
  if (location.search.indexOf('shared=1') > -1 && 'caches' in window) {
    caches.open('sunlo-share').then(function (c) { return c.match('/shared-audio').then(function (r) {
      if (!r) return; c.delete('/shared-audio');
      return r.blob().then(function (b) { ev('share_target'); run(new File([b], 'shared', { type: b.type })); });
    }); });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
})();
