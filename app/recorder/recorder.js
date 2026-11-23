// Parents' recorder. Each recording uploads at once as a new take; the server trims and
// normalises it; we play back the processed take (the exact bytes the iPad will get); Keep makes
// it the clip's active take. Nothing reaches the iPad until Keep.
//
// Races handled (Codex review 1): one recording session at a time, reserved before the mic
// permission prompt; the stop timer is bound to its own recorder; the speaker is fixed when
// Record is tapped; each clip's uploads carry a sequence number and late responses are ignored;
// Keep is hidden while a newer take processes; one preview player, silenced before recording.

// Who's recording: typed once per phone or computer and remembered there. No names are built in.
const SPEAKERS = [];
const MAX_MS = 4000;
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* fine */ } },
};

let speaker = store.get('toddler.recorder.speaker', '');
let filter = store.get('toddler.recorder.filter', 'all');
let clips = [];
let stream = null;
let session = null;            // {clipId, speaker, phase: 'starting'|'recording', recorder, timer}
const rows = new Map();        // clip id -> {phase: 'idle'|'processing'|'review'|'keeping', take, error, seq}
const player = new Audio();    // the one preview player

const $ = (sel) => document.querySelector(sel);
const rowOf = (id) => {
  if (!rows.has(id)) rows.set(id, { phase: 'idle', take: null, error: null, seq: 0 });
  return rows.get(id);
};

function preview(url) {
  player.pause();
  player.src = url;
  return player.play().then(() => true, () => false);
}

function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

function ext(mime) {
  if (mime.startsWith('audio/mp4')) return 'm4a';
  if (mime.startsWith('audio/webm')) return 'webm';
  if (mime.startsWith('audio/ogg')) return 'ogg';
  return 'bin';
}

function renderSpeakers() {
  const box = $('#speakers');
  box.replaceChildren();
  for (const name of SPEAKERS) {
    const b = document.createElement('button');
    b.textContent = name;
    b.setAttribute('aria-pressed', String(speaker === name));
    b.onclick = () => { speaker = name; store.set('toddler.recorder.speaker', name); renderSpeakers(); };
    box.append(b);
  }
  const other = document.createElement('input');
  other.placeholder = SPEAKERS.length ? 'Someone else' : 'Your name';
  other.maxLength = 40;
  if (speaker && !SPEAKERS.includes(speaker)) other.value = speaker;
  other.oninput = () => { speaker = other.value.trim(); store.set('toddler.recorder.speaker', speaker); };
  box.append(other);
}

function renderFilters() {
  const box = $('#filters');
  box.replaceChildren();
  for (const [key, label] of [['all', 'All'], ['missing', 'Not recorded'], ['en', 'English'], ['zh', '中文']]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(filter === key));
    b.onclick = () => { filter = key; store.set('toddler.recorder.filter', key); renderFilters(); renderList(); };
    box.append(b);
  }
}

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}

const GROUPS = [['shape.', 'Shapes'], ['num.', 'Numbers'], ['letter.', 'Letters and picture words'], ['word.', 'Letters and picture words'], ['char.', '中文 characters']];
const groupOf = (id) => (GROUPS.find(([prefix]) => id.startsWith(prefix)) ?? ['', 'Other'])[1];

function renderList() {
  const list = $('#list');
  list.replaceChildren();
  const done = clips.filter((c) => c.active).length;
  $('#summary').textContent = `${done} of ${clips.length} clips kept.`;
  let group = null;
  for (const c of clips) {
    if (filter === 'missing' && c.active) continue;
    if ((filter === 'en' || filter === 'zh') && c.lang !== filter) continue;
    const g = groupOf(c.id);
    if (g !== group) {
      group = g;
      const h = document.createElement('h2');
      h.className = 'group';
      h.textContent = g;
      list.append(h);
    }
    list.append(renderClip(c));
  }
}

function renderClip(c) {
  const el = document.createElement('div');
  el.className = 'clip';
  el.dataset.clip = c.id;
  const r = rowOf(c.id);
  const recordingThis = session?.clipId === c.id;
  const busy = r.phase === 'processing' || r.phase === 'keeping';
  el.innerHTML = `
    <div><div class="text"></div><div class="prompt"></div></div>
    <div class="actions"></div>
    <div class="status"></div>`;
  el.querySelector('.text').textContent = c.text;
  el.querySelector('.prompt').textContent = c.prompt;
  const actions = el.querySelector('.actions');
  const button = (cls, label, fn, disabled = false) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.disabled = disabled;
    b.onclick = fn;
    actions.append(b);
  };

  if (recordingThis) {
    button('rec on', session.phase === 'starting' ? 'Starting…' : 'Stop', () => stopSession(session), session.phase === 'starting');
  } else {
    button('rec', r.take ? 'Record again' : 'Record', () => startRecording(c), !!session || busy);
  }
  if (r.retry && r.phase !== 'processing') {
    // The upload never reached the server: the recording is still here, so send it again.
    button('retry', 'Try again', () => upload(c, { speaker: r.retry.speaker }, r.retry.blob), !!session);
  }
  if (r.take && r.phase !== 'processing') {
    button('listen', 'Listen', () => preview(r.take.preview_url), !!session);
    button('keep', r.phase === 'keeping' ? 'Keeping…' : 'Keep', () => keep(c), !!session || r.phase === 'keeping');
  } else if (c.active && !r.take && !busy) {
    button('listen-kept', 'Play kept', () => preview(`/api/takes/${encodeURIComponent(c.active.take_id)}.m4a`), !!session);
  }

  const status = el.querySelector('.status');
  if (recordingThis) {
    status.textContent = session.phase === 'starting'
      ? 'Waiting for the microphone…'
      : 'Recording… say it once, then tap Stop (it stops by itself after 4 s).';
  } else if (r.phase === 'processing') {
    status.textContent = 'Processing…';
  } else if (r.error) {
    // A failed redo keeps the earlier take: say so, so it's clear what Keep would publish.
    status.textContent = r.take
      ? `${r.error} The earlier take (${r.take.duration.toFixed(1)} s, ${r.take.speaker}) is still here: Listen, Keep, or record again.`
      : r.error;
    status.classList.add('err');
  } else if (r.take) {
    status.textContent = `New take by ${r.take.speaker} (${r.take.duration.toFixed(1)} s)${r.take.autoplayed ? '' : ', ready: tap Listen'}. Keep it, or record again.`;
  } else if (c.active) {
    status.textContent = `Kept: ${c.active.speaker}, ${fmtWhen(c.active.recorded_at)} (${Number(c.active.duration).toFixed(1)} s)`;
    status.classList.add('kept');
  } else {
    status.textContent = 'Not recorded yet';
  }
  return el;
}

function fail(c, message) {
  rowOf(c.id).error = message;
  renderList();
}

async function startRecording(c) {
  if (session) return;
  if (!speaker) return fail(c, 'Pick who is recording first (top of the page).');
  const mime = pickMime();
  if (mime === null) return fail(c, 'This browser cannot record audio. Try Safari on the iPhone or Chrome on the Mac.');
  const s = { clipId: c.id, speaker, phase: 'starting', recorder: null, timer: null };
  session = s;                     // reserved before the permission prompt: no double starts
  rowOf(c.id).error = null;
  player.pause();                  // never record the speaker playing a preview
  renderList();
  let got = stream;
  try {
    got ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false } });
  } catch (e) {
    if (session === s) session = null;
    return fail(c, `No microphone access (${e.name}). Allow it for this site and try again.`);
  }
  if (session !== s) {             // cancelled (page hidden) while the prompt was up
    if (got !== stream) got.getTracks().forEach((t) => t.stop());
    return;
  }
  stream = got;
  try {
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => upload(c, s, new Blob(chunks, { type: recorder.mimeType || mime || 'audio/mp4' }));
    s.recorder = recorder;
    s.phase = 'recording';
    s.timer = setTimeout(() => stopSession(s), MAX_MS);   // bound to this session only
    recorder.start();
  } catch (e) {
    clearTimeout(s.timer);
    if (session === s) session = null;
    return fail(c, `Recording could not start (${e.name || e}). Reload the page and try again.`);
  }
  renderList();
}

function stopSession(s) {
  if (!s || session !== s) return;
  clearTimeout(s.timer);
  session = null;
  if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();   // onstop uploads
  else renderList();
}

async function upload(c, s, blob) {
  const r = rowOf(c.id);
  const seq = ++r.seq;
  r.phase = 'processing';
  r.error = null;
  renderList();
  const fd = new FormData();
  fd.append('speaker', s.speaker);
  fd.append('audio', blob, `take.${ext(blob.type)}`);
  let res, body;
  try {
    res = await fetch(`/api/clips/${encodeURIComponent(c.id)}/takes`, { method: 'POST', body: fd });
    body = await res.json().catch(() => ({}));
  } catch {
    res = null;
  }
  if (r.seq !== seq) return;       // a newer take for this clip has started: ignore this one
  r.phase = r.take ? 'review' : 'idle';
  if (!res) {
    r.error = 'Could not reach the server. Is Tailscale on? Your recording is kept: tap Try again.';
    r.retry = { blob, speaker: s.speaker };
  } else if (res.status === 201) {
    r.retry = null;
    const take = { ...body, speaker: s.speaker, autoplayed: false };
    r.take = take;
    r.phase = 'review';
    renderList();                  // Listen/Keep appear now, not after playback settles
    // Play it straight away, but never during a recording or on a hidden page.
    if (!session && document.visibilityState === 'visible' && (take.autoplayed = await preview(body.preview_url))) {
      if (r.take === take) renderList();
    }
    return;
  } else {
    r.retry = null;                 // the server got it and said no: record it again
    r.error = body.detail || `Upload failed (${res.status}). Try again.`;
  }
  renderList();
}

async function keep(c) {
  const r = rowOf(c.id);
  const take = r.take;
  if (!take || r.phase !== 'review') return;
  const seq = r.seq;
  r.phase = 'keeping';
  r.error = null;
  renderList();
  let res, body = {};
  try {
    res = await fetch(`/api/clips/${encodeURIComponent(c.id)}/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ take_id: take.take_id }),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    res = null;
  }
  if (r.seq !== seq) return;       // a newer take arrived meanwhile: leave it alone
  r.phase = 'review';
  if (res?.ok) {
    r.take = null;
    r.phase = 'idle';
    await load();
    return;
  }
  r.error = res ? (body.detail || `Keep failed (${res.status}). Try again.`) : 'Could not reach the server. Is Tailscale on?';
  renderList();                    // the take stays, so Keep can be retried
}

async function load() {
  const r = await fetch('/api/clips');
  clips = (await r.json()).clips;
  // A take uploaded earlier but never kept (a lost response, a reload): offer it again.
  for (const c of clips) {
    const row = rowOf(c.id);
    if (c.unkept && !row.take && row.phase === 'idle') {
      row.take = { ...c.unkept, autoplayed: true };
      row.phase = 'review';
    }
  }
  renderList();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    player.pause();
    const releaseMic = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
    const s = session;
    if (s?.recorder && s.recorder.state !== 'inactive') {
      // Leaving mid-take: stop and upload what was said (it's reviewed before Keep anyway),
      // then let go of the microphone once the recorder has flushed.
      s.recorder.addEventListener('stop', releaseMic, { once: true });
      stopSession(s);
    } else {
      if (s) { clearTimeout(s.timer); session = null; }
      releaseMic();
      renderList();
    }
  }
});

renderSpeakers();
renderFilters();
load();
if (!window.isSecureContext) {
  $('#micnote').textContent = 'The microphone only works over https (the tailnet address), not plain http.';
}
