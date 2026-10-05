// Video/audio transcription tool with a subtitle editor (views/transcribe.pug).
// Ported from the standalone "okssihome" site, where a local Python process
// ran Whisper. Here the audio goes to POST /transcribe/run, which relays it to
// stt-service through the API Gateway (src/routes/transcribeRoutes.js) and
// streams back the same status / segment / done events - so everything from
// "SSE event handler" down (player, timeline, editor, SRT, FCPXML) is the
// original code. What changed is the upload page: no model picker or decoder
// tuning (stt-service runs one model), and no vocal isolation.
'use strict';

// ── Dark mode ────────────────────────────────────────────────────
const darkModeBtn = document.getElementById('dark-mode-btn');
const mainEl      = document.querySelector('main');

if (localStorage.getItem('transcribeDark') === '1') mainEl.classList.add('dark');
syncDarkBtn();

darkModeBtn.addEventListener('click', () => {
    mainEl.classList.toggle('dark');
    localStorage.setItem('transcribeDark', mainEl.classList.contains('dark') ? '1' : '0');
    syncDarkBtn();
    // Invalidate cached canvas size so waveform redraws with new color
    const wc = document.getElementById('waveform-canvas');
    if (wc) { wc.width = 0; wc.height = 0; }
    renderWaveform();
});

function syncDarkBtn() {
    const isDark = mainEl.classList.contains('dark');
    darkModeBtn.textContent = isDark ? t('Light') : t('Dark');
    darkModeBtn.title = isDark ? t('Switch to light mode') : t('Switch to dark mode');
}

// ── Upload page elements ─────────────────────────────────────────
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('audio-file');
const selectedFile   = document.getElementById('selected-file');
const transcribeBtn  = document.getElementById('transcribe-btn');
const openPlayerBtn  = document.getElementById('open-player-btn');
const langSelect     = document.getElementById('lang-select');

const pageUpload = document.getElementById('page-upload');
const pagePlayer = document.getElementById('page-player');

// ── Advanced parameters ──────────────────────────────────────────
const advancedToggle  = document.getElementById('advanced-toggle');
const advancedPanel   = document.getElementById('advanced-panel');
const resetParamsBtn  = document.getElementById('reset-params-btn');
const vadInput        = document.getElementById('vad-input');
const maxCharsInput      = document.getElementById('max-chars-input');
const maxDurationInput   = document.getElementById('max-duration-input');
const pauseSplitInput    = document.getElementById('pause-split-input');

// ── Floating tooltip ─────────────────────────────────────────────
const paramTooltip      = document.getElementById('param-tooltip');
const paramTooltipText  = document.getElementById('param-tooltip-text');
const paramTooltipArrow = document.getElementById('param-tooltip-arrow');

// Each tooltip is one string literal passed through t() - that is what
// `npm run i18n:check` reads to find text that still needs Korean.
const TOOLTIP_COPY = {
    'vad-input': t('Skips stretches with no speech (silence, pauses) before transcribing. Faster, and stops Whisper inventing text over silence. Turn off if quiet speech is being dropped.'),
    'max-chars-input': t('Longest a single subtitle segment is allowed to be. Whisper segments get split at sentence ends, commas, or pauses to stay under this; if none of those show up in time, it force-splits at the nearest word. Leave blank for the auto value based on language (28 for Korean/Japanese/Chinese, 80 otherwise).'),
    'max-duration-input': t('Longest a single subtitle segment is allowed to stay on screen. Long stretches of continuous speech with no punctuation or pauses get force-split once they hit this, even mid-sentence. Default: 6s.'),
    'pause-split-input': t('Gap of silence between two words that starts a new segment, even if the character/duration limits have not been reached. Lower values split on shorter pauses. Default: 0.5s.'),
};

const TOOLTIP_GAP = 10; // px between field and tooltip box

function showTooltip(el) {
    const text = TOOLTIP_COPY[el.id];
    if (!text) return;
    paramTooltipText.textContent = text;
    paramTooltip.classList.remove('tooltip--below');
    paramTooltip.style.visibility = 'hidden';
    paramTooltip.style.display    = 'block';

    const fieldRect   = el.getBoundingClientRect();
    const tipHeight   = paramTooltip.offsetHeight;
    const tipWidth    = paramTooltip.offsetWidth;
    const scrollY     = window.scrollY;
    const viewportW   = window.innerWidth;

    const placeAbove  = fieldRect.top - tipHeight - TOOLTIP_GAP > 0;
    const top = placeAbove
        ? scrollY + fieldRect.top - tipHeight - TOOLTIP_GAP
        : scrollY + fieldRect.bottom + TOOLTIP_GAP;

    // Centre over the field, clamped inside the viewport
    let left = fieldRect.left + fieldRect.width / 2 - tipWidth / 2;
    left = Math.max(8, Math.min(left, viewportW - tipWidth - 8));

    paramTooltip.style.top  = `${top}px`;
    paramTooltip.style.left = `${left}px`;

    // Arrow: position horizontally over the field's centre
    const arrowLeft = (fieldRect.left + fieldRect.width / 2) - left;
    paramTooltipArrow.style.left = `${Math.max(10, Math.min(arrowLeft, tipWidth - 10))}px`;

    if (!placeAbove) paramTooltip.classList.add('tooltip--below');
    paramTooltip.style.visibility = '';
}

function hideTooltip() {
    paramTooltip.style.display = 'none';
}

[vadInput, maxCharsInput, maxDurationInput, pauseSplitInput].forEach(el => {
    el.addEventListener('focus', () => showTooltip(el));
    el.addEventListener('blur',  hideTooltip);
});

const PARAM_DEFAULTS = {
    vad:           true,
    maxChars:      '',   // blank = auto, based on detected language
    maxDuration:   6,
    pauseSplit:    0.5,
};

advancedToggle.addEventListener('click', () => {
    const open = advancedPanel.classList.toggle('open');
    advancedToggle.textContent = (open ? '▾ ' : '▸ ') + t('Advanced Parameters');
});

resetParamsBtn.addEventListener('click', () => {
    vadInput.checked         = PARAM_DEFAULTS.vad;
    maxCharsInput.value      = PARAM_DEFAULTS.maxChars;
    maxDurationInput.value   = PARAM_DEFAULTS.maxDuration;
    pauseSplitInput.value    = PARAM_DEFAULTS.pauseSplit;
});

// The subtitle-chunking settings, as the query string of /transcribe/run
// (they are applied by the homepage server, not by stt-service).
function getChunkingQuery() {
    const query = new URLSearchParams({
        max_duration: parseFloat(maxDurationInput.value) || PARAM_DEFAULTS.maxDuration,
        pause:        parseFloat(pauseSplitInput.value)  || PARAM_DEFAULTS.pauseSplit,
    });
    if (maxCharsInput.value.trim() !== '') query.set('max_chars', parseInt(maxCharsInput.value));
    return query.toString();
}

// ── Progress panel ───────────────────────────────────────────────
const progressPanel    = document.getElementById('progress-panel');
const statusText       = document.getElementById('status-text');
const progressFill     = document.getElementById('progress-fill');
const segmentPreview   = document.getElementById('segment-preview');
const extractReady     = document.getElementById('extract-ready');
const extractReadyInfo = document.getElementById('extract-ready-info');
const downloadAudioBtn = document.getElementById('download-audio-btn');
const extractNextBtn   = document.getElementById('extract-next-btn');

// ── Player page elements ─────────────────────────────────────────
const backBtn        = document.getElementById('back-btn');
const playerFilename = document.getElementById('player-filename');

const videoPanel          = document.getElementById('video-panel');
const videoPlayer         = document.getElementById('video-player');
const vocalsAudio         = document.getElementById('vocals-audio');
const voiceToggleBtn      = document.getElementById('voice-toggle-btn');
const subtitleOverlay     = document.getElementById('subtitle-overlay');
const subtitleToggleBtn   = document.getElementById('subtitle-toggle-btn');
const timelineEl         = document.getElementById('subtitle-timeline');
const timelineTrack      = document.getElementById('timeline-track');
const timelinePlayhead   = document.getElementById('timeline-playhead');
const timelineZoomInBtn  = document.getElementById('timeline-zoom-in');
const timelineZoomOutBtn = document.getElementById('timeline-zoom-out');
const timelineZoomLabel  = document.getElementById('timeline-zoom-label');
const besideResizer     = document.getElementById('beside-resizer');
const videoColumn       = document.getElementById('video-column');
const videoFloatHandle  = document.getElementById('video-float-handle');
const subList           = document.getElementById('sub-list');
const subListBody       = document.getElementById('sub-list-body');
const subListHeader     = document.getElementById('sub-list-header');
const subListDragHandle = document.getElementById('sub-list-drag-handle');
const subListResizer    = document.getElementById('sub-list-resizer');
const autoscrollBtn     = document.getElementById('autoscroll-btn');
const layoutBelowBtn    = document.getElementById('layout-below');
const layoutBesideBtn   = document.getElementById('layout-beside');
const layoutFloatBtn    = document.getElementById('layout-float');
const undoBtn           = document.getElementById('undo-btn');
const redoBtn           = document.getElementById('redo-btn');
const mergeSelectedBtn  = document.getElementById('merge-selected-btn');

const resultPanel      = document.getElementById('result-panel');
const srtOutput        = document.getElementById('srt-output');
const loadSrtBtn       = document.getElementById('load-srt-btn');
const srtFileInput     = document.getElementById('srt-file-input');
const downloadBtn      = document.getElementById('download-btn');
const exportFcpxmlBtn    = document.getElementById('export-fcpxml-btn');
const fcpxmlFpsSelect    = document.getElementById('fcpxml-fps-select');
const fcpxmlTargetSelect = document.getElementById('fcpxml-target-select');
const copyBtn          = document.getElementById('copy-btn');

// stt-service's upload limit, passed in by the page (views/transcribe.pug).
const MAX_UPLOAD_MB    = Number(document.body.dataset.maxUploadMb) || 25;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

let chosenFile      = null;
let isVideoFile     = false;
let currentFilename = 'transcript';
let srtBlocks       = [];
let subtitles       = [];   // [{start, end, text}]

let activeSubIdx     = -1;
let isEditingSubList = false;
let subtitleOn       = true;
let autoScrollOn     = true;
let selectedSubIndices = new Set();

// ── Voice-only playback (isolated vocals track) ───────────────────
let vocalsToken  = null;  // set from the X-Audio-Token response header
let voiceOnlyMode = false;

// ── Undo / Redo history ──────────────────────────────────────────
const MAX_HISTORY  = 100;
let historyStack   = [];   // array of deep-copied subtitle snapshots
let historyIndex   = -1;

function snapshotSubtitles() {
    return subtitles.map(s => ({ ...s }));
}

let isApplyingHistory = false;

function saveHistory() {
    if (isApplyingHistory) return;
    // Drop any redo entries ahead of current position
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(snapshotSubtitles());
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    historyIndex = historyStack.length - 1;
    updateHistoryBtns();
}

function applyHistory(snapshot) {
    isApplyingHistory = true;
    subtitles = snapshot.map(s => ({ ...s }));
    srtOutput.value = rebuildSRT();
    populateSubList();
    isApplyingHistory = false;
}

function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    applyHistory(historyStack[historyIndex]);
    updateHistoryBtns();
}

function redo() {
    if (historyIndex >= historyStack.length - 1) return;
    historyIndex++;
    applyHistory(historyStack[historyIndex]);
    updateHistoryBtns();
}

function updateHistoryBtns() {
    undoBtn.disabled = historyIndex <= 0;
    redoBtn.disabled = historyIndex >= historyStack.length - 1;
}

let globalAudioBuffer  = null;
let audioDecodePromise = null;

// sub-list layout: 'below' | 'beside' | 'float'
let timelineZoom  = 1;

let subListLayout = localStorage.getItem('subListLayout') || 'below';
let floatPos      = null;      // {x, y} for sub-list float
let floatVideoPos = null;      // {x, y} for video column float
let isDragging    = false;
let isDraggingVideo = false;
let dragOffset      = { x: 0, y: 0 };
let dragVideoOffset = { x: 0, y: 0 };

// ── Page navigation ──────────────────────────────────────────────
function showPage(name) {
    if (name === 'player') {
        pageUpload.style.display = 'none';
        pagePlayer.classList.add('active');
        playerFilename.textContent = currentFilename;
        videoPanel.style.display   = 'flex';
        videoPanel.classList.add('play-mode');
        resultPanel.style.display  = 'flex';
        if (subtitles.length) populateSubList();
        renderWaveform();
    } else {
        pageUpload.style.display = '';
        pagePlayer.classList.remove('active');
    }
}

openPlayerBtn.addEventListener('click', () => showPage('player'));
backBtn.addEventListener('click',       () => showPage('upload'));

subtitleToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    subtitleOn = !subtitleOn;
    subtitleToggleBtn.classList.toggle('sub-off', !subtitleOn);
    if (!subtitleOn) subtitleOverlay.style.display = 'none';
});

autoscrollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    autoScrollOn = !autoScrollOn;
    autoscrollBtn.classList.toggle('active', autoScrollOn);
    if (autoScrollOn && activeSubIdx !== -1) {
        const items = subList.querySelectorAll('.sub-item');
        if (items[activeSubIdx]) {
            items[activeSubIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
});

// ── File selection ───────────────────────────────────────────────
fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) setFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
});

function setFile(file) {
    chosenFile      = file;
    isVideoFile     = file.type.startsWith('video/');
    currentFilename = file.name.replace(/\.[^/.]+$/, '') || 'transcript';
    const size = (file.size / (1024 * 1024)).toFixed(1);
    selectedFile.textContent = `${file.name}  (${size} MB)`;
    dropZone.classList.add('has-file');
    transcribeBtn.disabled = false;
    openPlayerBtn.disabled = false;

    videoPlayer.src = URL.createObjectURL(file);
    subtitleOverlay.textContent = '';
    subtitleOverlay.style.display = 'none';

    // Clear previous transcript state
    subtitles = [];
    srtBlocks = [];
    srtOutput.value = '';
    subListBody.innerHTML = '';
    activeSubIdx = -1;
    pendingAudioBlob = null;
    extractReady.style.display = 'none';
    videoPanel.classList.remove('play-mode', 'layout-below', 'layout-beside', 'layout-float');
    subList.style.left = subList.style.top = subList.style.width = subList.style.height = '';
    setTimelineZoom(1);
    resetVoiceOnlyMode();

    // Decode audio for waveform visualization and fast extraction
    globalAudioBuffer = null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioDecodePromise = file.arrayBuffer().then(ab => {
        const ctx = new AudioCtx();
        return ctx.decodeAudioData(ab);
    }).then(buffer => {
        globalAudioBuffer = buffer;
        renderWaveform();
        return buffer;
    }).catch(err => {
        console.warn('Failed to decode audio for waveform', err);
        audioDecodePromise = null;  // allow fresh retry in extractAudioFromVideo
    });
}

// ── Transcribe ───────────────────────────────────────────────────
transcribeBtn.addEventListener('click', () => {
    if (!chosenFile) return;
    startTranscription();
});

// Holds the WAV blob between extraction and upload phases
let pendingAudioBlob = null;

async function startTranscription() {
    srtBlocks = [];
    subtitles = [];
    srtOutput.value = '';
    subtitleOverlay.textContent = '';
    subtitleOverlay.style.display = 'none';
    subListBody.innerHTML = '';
    activeSubIdx = -1;
    pendingAudioBlob = null;

    progressPanel.style.display = 'flex';
    transcribeBtn.disabled      = true;
    openPlayerBtn.disabled      = true;
    extractReady.style.display  = 'none';
    segmentPreview.textContent  = '';

    // ── Phase 1: extraction ──────────────────────────────────────
    setProgressIndeterminate(true);

    // stt-service accepts up to MAX_UPLOAD_MB. Video always has its audio
    // extracted; an audio file is sent as it is unless it is too big, in
    // which case it is re-encoded the same way (16 kHz mono, 32 kbps).
    let audioBlob;
    if (isVideoFile || chosenFile.size > MAX_UPLOAD_BYTES) {
        setStatus(t('Preparing audio...'));
        try {
            audioBlob = await extractAudioFromVideo(chosenFile);
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            setStatus(t('Audio extraction failed: {msg}', { msg }));
            setProgressIndeterminate(false);
            transcribeBtn.disabled = false;
            openPlayerBtn.disabled = false;
            return;
        }

        // Extraction done — show size and pause for user confirmation
        const sizeMB = (audioBlob.size / (1024 * 1024)).toFixed(1);
        setStatus(t('Audio extraction complete.'));
        setProgressIndeterminate(false);
        setProgressFull();

        pendingAudioBlob = audioBlob;
        extractReadyInfo.textContent = t('Extracted audio: {mb} MB (16 kHz mono MP3, 32 kbps)', { mb: sizeMB });
        if (audioBlob.size > MAX_UPLOAD_BYTES) {
            setStatus(t('The extracted audio is {mb} MB - more than the {max} MB the speech service accepts (about {min} minutes). Try a shorter clip.', { mb: sizeMB, max: MAX_UPLOAD_MB, min: Math.round(MAX_UPLOAD_MB / 0.24) }));
            transcribeBtn.disabled = false;
            openPlayerBtn.disabled = false;
            return;
        }

        downloadAudioBtn.onclick = () => {
            const url  = URL.createObjectURL(audioBlob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = chosenFile.name.replace(/\.[^.]+$/, '') + '_audio.mp3';
            a.click();
            URL.revokeObjectURL(url);
        };

        extractReady.style.display = 'flex';
        // Wait for user to click Next
        return;
    } else {
        audioBlob = chosenFile;
    }

    // Non-video files skip straight to upload
    uploadAndTranscribe(audioBlob);
}

extractNextBtn.addEventListener('click', () => {
    if (!pendingAudioBlob) return;
    extractReady.style.display = 'none';
    segmentPreview.textContent = '';
    uploadAndTranscribe(pendingAudioBlob);
    pendingAudioBlob = null;
});

function uploadAndTranscribe(audioBlob) {
    setStatus(t('Uploading audio...'));
    setProgressIndeterminate(true);

    // The multipart body is exactly what stt-service's
    // /v1/audio/transcriptions expects - the homepage server pipes it through.
    const formData = new FormData();
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    formData.append('vad_filter', vadInput.checked ? 'true' : 'false');
    if (langSelect.value !== 'auto') formData.append('language', langSelect.value);
    formData.append('file', audioBlob, audioBlob.name || 'audio.mp3');

    const fail = (message) => {
        setStatus(t('Error: {message}', { message }));
        setProgressIndeterminate(false);
        transcribeBtn.disabled = false;
        openPlayerBtn.disabled = false;
    };

    fetch(`/transcribe/run?${getChunkingQuery()}`, { method: 'POST', body: formData })
        .then((res) => {
            if (res.status === 401) { window.top.location.href = '/login?next=/transcribe'; return null; }
            if (!res.ok) {
                // Rejected before the stream started: a JSON { error }.
                return res.json().catch(() => ({})).then((body) => {
                    throw new Error(body.error || `Server error ${res.status}`);
                });
            }
            return res.body;
        })
        .then((body) => {
            if (!body) return;
            const reader  = body.getReader();
            const decoder = new TextDecoder();
            let lineBuffer = '';

            function pump() {
                return reader.read().then(({ done, value }) => {
                    if (done) { onStreamDone(); return; }
                    lineBuffer += decoder.decode(value, { stream: true });
                    const lines = lineBuffer.split('\n');
                    lineBuffer  = lines.pop();
                    for (const line of lines) {
                        if (line.startsWith('data: ')) handleEvent(line.slice(6));
                    }
                    return pump();
                });
            }
            return pump();
        })
        .catch((err) => fail(err.message));
}

// ── Client-side audio extraction ─────────────────────────────────
async function extractAudioFromVideo(videoFile) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let buffer = globalAudioBuffer;

    // ── Step 1: try the cached background decode ──────────────────
    if (!buffer && audioDecodePromise) {
        setStatus(t('Decoding audio track...'));
        buffer = await audioDecodePromise;
        audioDecodePromise = null;
    }

    // ── Step 2: if still missing, try a fresh arrayBuffer decode ──
    if (!buffer) {
        setStatus(t('Decoding audio track...'));
        try {
            const arrayBuffer = await videoFile.arrayBuffer();
            const audioCtx    = new AudioCtx();
            buffer = await audioCtx.decodeAudioData(arrayBuffer);
            await audioCtx.close();
            globalAudioBuffer = buffer;
        } catch (decodeErr) {
            // Step 3: decodeAudioData can't handle this codec.
            // Restore duration from the video element and capture via playback.
            const duration = videoPlayer.duration;
            if (!isFinite(duration) || duration <= 0) {
                throw new Error(
                    `Audio decode failed and video duration is unavailable. ` +
                    `Original error: ${decodeErr.message || decodeErr}`
                );
            }
            buffer = await extractAudioViaPlayback(duration);
            globalAudioBuffer = buffer;
        }
    }

    // ── Step 4: resample to 16 kHz mono WAV ──────────────────────
    setStatus(t('Resampling to 16 kHz mono...'));
    const targetSampleRate = 16000;
    const numFrames        = Math.ceil(buffer.duration * targetSampleRate);
    const OfflineCtx       = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx       = new OfflineCtx(1, numFrames, targetSampleRate);
    const src              = offlineCtx.createBufferSource();
    src.buffer             = buffer;
    src.connect(offlineCtx.destination);
    src.start(0);
    const resampled = await offlineCtx.startRendering();

    setStatus(t('Encoding MP3...'));
    return encodeMP3(resampled);
}

// Fallback: route video element through Web Audio → MediaRecorder.
// Used when decodeAudioData can't parse the video's codec directly.
async function extractAudioViaPlayback(duration) {
    const mins = Math.ceil(duration / 60);
    setStatus(t('Direct decode failed — capturing audio via playback (~{mins} min)...', { mins }));

    const AudioCtx  = window.AudioContext || window.webkitAudioContext;
    const audioCtx  = new AudioCtx();
    const streamDst = audioCtx.createMediaStreamDestination();

    // Connect the video element into the audio graph
    let mediaSource;
    try {
        mediaSource = audioCtx.createMediaElementSource(videoPlayer);
    } catch (e) {
        // Already connected to another context — best effort
        await audioCtx.close();
        throw new Error(`Cannot capture audio from video element: ${e.message}`);
    }
    mediaSource.connect(streamDst);
    mediaSource.connect(audioCtx.destination); // keep speakers live while capturing

    // Pick a supported MIME type
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', '']
        .find(t => !t || MediaRecorder.isTypeSupported(t)) || '';

    const chunks   = [];
    const recorder = new MediaRecorder(streamDst.stream, mimeType ? { mimeType } : {});
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    await new Promise((resolve, reject) => {
        recorder.onstop  = resolve;
        recorder.onerror = e => reject(e.error || new Error('MediaRecorder error'));

        videoPlayer.currentTime = 0;
        recorder.start(500); // collect every 500 ms
        videoPlayer.play().catch(reject);

        const done = () => { if (recorder.state !== 'inactive') recorder.stop(); };
        videoPlayer.addEventListener('ended', done, { once: true });
        // Safety timeout: duration + 15 s
        setTimeout(done, (duration + 15) * 1000);
    });

    videoPlayer.pause();
    mediaSource.disconnect();

    setStatus(t('Decoding captured audio...'));
    const blob       = new Blob(chunks, { type: mimeType || 'audio/webm' });
    const ab         = await blob.arrayBuffer();
    const capBuffer  = await audioCtx.decodeAudioData(ab);
    await audioCtx.close();
    return capBuffer;
}

function encodeMP3(audioBuffer) {
    // lamejs expects Int16 PCM samples at the buffer's native sample rate.
    // The buffer arriving here is already 16 kHz mono (from the OfflineAudioContext).
    const sampleRate = audioBuffer.sampleRate;
    const pcmFloat   = audioBuffer.getChannelData(0);

    // Convert Float32 → Int16
    const pcmInt16 = new Int16Array(pcmFloat.length);
    for (let i = 0; i < pcmFloat.length; i++) {
        const s = Math.max(-1, Math.min(1, pcmFloat[i]));
        pcmInt16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // 32 kbps mono MP3 at 16 kHz: plenty for speech recognition, ~0.24 MB/min,
    // so about 100 minutes fit in stt-service's 25 MB upload limit.
    const mp3enc  = new lamejs.Mp3Encoder(1, sampleRate, 32);
    const chunks  = [];
    const BLOCK   = 1152; // lamejs requires multiples of 1152 samples

    for (let i = 0; i < pcmInt16.length; i += BLOCK) {
        const slice = pcmInt16.subarray(i, i + BLOCK);
        const buf   = mp3enc.encodeBuffer(slice);
        if (buf.length > 0) chunks.push(new Uint8Array(buf));
    }
    const tail = mp3enc.flush();
    if (tail.length > 0) chunks.push(new Uint8Array(tail));

    return new Blob(chunks, { type: 'audio/mpeg' });
}

// ── SSE event handler ────────────────────────────────────────────
function handleEvent(json) {
    let msg;
    try { msg = JSON.parse(json); } catch { return; }

    switch (msg.type) {
        case 'status':
            setStatus(msg.message);
            break;

        case 'segment':
            srtBlocks.push(msg.block);
            srtOutput.value = srtBlocks.join('\n\n') + '\n';
            segmentPreview.textContent = `[${msg.index}] ${msg.text}`;
            break;

        case 'done':
            srtOutput.value = msg.srt;
            setStatus(msg.total_segments === 1 ? t('Done — 1 segment.') : t('Done — {n} segments.', { n: msg.total_segments }));
            setProgressFull();
            subtitles = parseSRT(msg.srt);
            historyStack = []; historyIndex = -1;
            saveHistory();
            loadVocalsTrack();
            // Auto-navigate to player page
            showPage('player');
            break;

        case 'error':
            if (msg.code === 'auth') { window.top.location.href = '/login?next=/transcribe'; break; }
            setStatus(t('Error: {message}', { message: msg.message }));
            setProgressIndeterminate(false);
            progressFill.style.width = '0%';
            transcribeBtn.disabled = false;
            openPlayerBtn.disabled = false;
            break;
    }
}

function onStreamDone() {
    setProgressIndeterminate(false);
    transcribeBtn.disabled = false;
    openPlayerBtn.disabled = false;
}

// ── Voice-only playback (isolated vocals track) ────────────────────
// The server may have run Demucs to separate dialogue from background
// music/noise for transcription accuracy; if it did, that isolated track
// is fetchable here too, so the player can switch between hearing just the
// voice or the original full mix.
function loadVocalsTrack() {
    if (!vocalsToken) return;
    vocalsAudio.src = `/transcribe/vocals/${vocalsToken}`;
    vocalsAudio.load();
}

vocalsAudio.addEventListener('loadedmetadata', () => {
    voiceToggleBtn.hidden   = false;
    voiceToggleBtn.disabled = false;
});

vocalsAudio.addEventListener('error', () => {
    // No vocals track for this transcription — isolation was off or failed.
    voiceToggleBtn.hidden   = true;
    voiceToggleBtn.disabled = true;
    if (voiceOnlyMode) setVoiceOnlyMode(false);
});

function resetVoiceOnlyMode() {
    vocalsToken   = null;
    voiceOnlyMode = false;
    vocalsAudio.pause();
    vocalsAudio.removeAttribute('src');
    vocalsAudio.load();
    voiceToggleBtn.hidden   = true;
    voiceToggleBtn.disabled = true;
    voiceToggleBtn.classList.remove('active');
    videoPlayer.muted = false;
}

function setVoiceOnlyMode(on) {
    voiceOnlyMode = on;
    voiceToggleBtn.classList.toggle('active', on);
    if (on) {
        videoPlayer.muted = true;
        vocalsAudio.currentTime = videoPlayer.currentTime;
        if (!videoPlayer.paused) vocalsAudio.play().catch(() => {});
    } else {
        vocalsAudio.pause();
        videoPlayer.muted = false;
    }
}

voiceToggleBtn.addEventListener('click', () => setVoiceOnlyMode(!voiceOnlyMode));

// Keep the vocals track's play state and position mirrored to the video —
// they're independent <video>/<audio> elements with no shared clock.
videoPlayer.addEventListener('play', () => {
    if (voiceOnlyMode) vocalsAudio.play().catch(() => {});
});
videoPlayer.addEventListener('pause', () => {
    if (voiceOnlyMode) vocalsAudio.pause();
});
videoPlayer.addEventListener('seeked', () => {
    if (voiceOnlyMode) vocalsAudio.currentTime = videoPlayer.currentTime;
});
// Two independent media elements drift apart over time even while both are
// "playing" — nudge the vocals track back in sync on any noticeable gap.
videoPlayer.addEventListener('timeupdate', () => {
    if (!voiceOnlyMode) return;
    if (Math.abs(vocalsAudio.currentTime - videoPlayer.currentTime) > 0.2) {
        vocalsAudio.currentTime = videoPlayer.currentTime;
    }
});

// ── Subtitle overlay + sub-list sync ────────────────────────────
videoPlayer.addEventListener('timeupdate', () => {
    if (!subtitles.length) return;
    const now = videoPlayer.currentTime;
    const idx = subtitles.findIndex(s => now >= s.start && now <= s.end);

    // Overlay
    if (idx !== -1 && subtitleOn) {
        const text = subtitles[idx].text;
        if (subtitleOverlay.textContent !== text) subtitleOverlay.textContent = text;
        subtitleOverlay.style.display = 'block';
    } else {
        subtitleOverlay.style.display = 'none';
    }

    // Sub-list highlight
    if (idx !== activeSubIdx) {
        const items = subList.querySelectorAll('.sub-item');
        if (activeSubIdx !== -1 && items[activeSubIdx]) {
            items[activeSubIdx].classList.remove('active');
        }
        activeSubIdx = idx;
        if (idx !== -1 && items[idx]) {
            items[idx].classList.add('active');
            if (autoScrollOn && !isEditingSubList) {
                items[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    // Timeline playhead + segment highlight
    updateTimelinePlayhead();
    timelineEl.querySelectorAll('.timeline-segment').forEach((seg, i) => {
        seg.classList.toggle('active', i === idx);
    });
});

// ── Waveform rendering ───────────────────────────────────────────
function renderWaveform() {
    if (!globalAudioBuffer) return;
    let waveformCanvas = document.getElementById('waveform-canvas');
    if (!waveformCanvas) {
        waveformCanvas = document.createElement('canvas');
        waveformCanvas.id = 'waveform-canvas';
        // Insert underneath the subtitle elements
        timelineTrack.insertBefore(waveformCanvas, timelineTrack.firstChild);
    }

    let trackWidth = timelineTrack.clientWidth;
    if (trackWidth === 0) {
        trackWidth = window.innerWidth * 0.8 * timelineZoom;
    }

    const dpr = window.devicePixelRatio || 1;
    const MAX_CANVAS_WIDTH = 32000;
    const width  = Math.min(MAX_CANVAS_WIDTH, Math.floor(Math.max(1000, trackWidth) * dpr));
    const height = Math.floor((waveformCanvas.offsetHeight || 51) * dpr);

    if (waveformCanvas.width === width && waveformCanvas.height === height) {
        return;
    }

    waveformCanvas.width = width;
    waveformCanvas.height = height;

    const ctx = waveformCanvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    const data = globalAudioBuffer.getChannelData(0);
    const step = Math.max(1, Math.ceil(data.length / width));
    const amp = height / 2;

    ctx.fillStyle = mainEl.classList.contains('dark') ? '#555' : '#c0c0c0';
    for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
            const datum = data[i * step + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }
}

// ── Subtitle timeline ────────────────────────────────────────────
function buildTimeline() {
    timelineTrack.querySelectorAll('.timeline-segment').forEach(el => el.remove());

    if (!subtitles.length) return;

    const duration = (videoPlayer.duration > 0 && isFinite(videoPlayer.duration))
        ? videoPlayer.duration
        : subtitles[subtitles.length - 1].end;

    subtitles.forEach((sub, i) => {
        const seg = document.createElement('div');
        seg.className     = 'timeline-segment';
        seg.dataset.index = i;
        const left  = (sub.start / duration) * 100;
        const width = Math.max(0.15, (sub.end - sub.start) / duration * 100);
        seg.style.left  = `${left}%`;
        seg.style.width = `${width}%`;
        // mousedown on segment body: drag to move, release without moving to seek
        seg.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.classList.contains('seg-handle')) return;
            e.stopPropagation();
            e.preventDefault();
            startSegmentMove(i, subtitles[i].start, subtitles[i].end, e.clientX);
        });

        // Left handle → drag start time; right handle → drag end time
        const lh = document.createElement('div');
        lh.className = 'seg-handle seg-handle--left';
        lh.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); startHandleDrag(i, 'start'); });

        const rh = document.createElement('div');
        rh.className = 'seg-handle seg-handle--right';
        rh.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); startHandleDrag(i, 'end'); });

        seg.appendChild(lh);
        seg.appendChild(rh);
        timelineTrack.insertBefore(seg, timelinePlayhead);
    });

    updateTimelinePlayhead();
}

function updateTimelinePlayhead() {
    const duration = videoPlayer.duration;
    if (!duration || !isFinite(duration)) return;
    const pct = (videoPlayer.currentTime / duration) * 100;
    timelinePlayhead.style.left = `${pct}%`;
    scrollTimelineToPlayhead();
}

function scrollTimelineToPlayhead() {
    if (timelineZoom <= 1) return;
    const duration = videoPlayer.duration;
    if (!duration || !isFinite(duration)) return;
    const pct          = videoPlayer.currentTime / duration;
    const trackWidth   = timelineTrack.offsetWidth;
    const playheadX    = pct * trackWidth;
    const visibleWidth = timelineEl.clientWidth;
    // Keep playhead centred; only scroll when it drifts near the edges
    const margin = visibleWidth * 0.25;
    const sl     = timelineEl.scrollLeft;
    if (playheadX < sl + margin || playheadX > sl + visibleWidth - margin) {
        timelineEl.scrollLeft = Math.max(0, playheadX - visibleWidth / 2);
    }
}

function setTimelineZoom(zoom) {
    timelineZoom = Math.max(1, Math.min(16, zoom));
    timelineTrack.style.width  = timelineZoom === 1 ? '100%' : `${timelineZoom * 100}%`;
    timelineZoomLabel.textContent = `${parseFloat(timelineZoom.toFixed(3))}×`;
    timelineZoomOutBtn.disabled   = timelineZoom <= 1;
    timelineZoomInBtn.disabled    = timelineZoom >= 16;
    scrollTimelineToPlayhead();
    renderWaveform();
}

timelineZoomInBtn.addEventListener('click',  () => setTimelineZoom(timelineZoom * 2));
timelineZoomOutBtn.addEventListener('click', () => setTimelineZoom(timelineZoom / 2));

timelineEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    setTimelineZoom(timelineZoom * factor);
}, { passive: false });

// Click on timeline track → seek (account for horizontal scroll offset)
timelineEl.addEventListener('click', (e) => {
    const duration = videoPlayer.duration;
    if (!duration || !isFinite(duration)) return;
    const rect  = timelineEl.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) + timelineEl.scrollLeft;
    const pct    = Math.max(0, Math.min(1, clickX / timelineTrack.offsetWidth));
    videoPlayer.currentTime = pct * duration;
    if (videoPlayer.paused) videoPlayer.play();
});

// Rebuild with real duration once metadata is ready
videoPlayer.addEventListener('loadedmetadata', () => {
    if (subtitles.length) buildTimeline();
});

// ── Sub-list population ──────────────────────────────────────────
function populateSubList() {
    subListBody.innerHTML = '';
    activeSubIdx = -1;
    // Indices are only meaningful for the subtitles array currently on
    // screen — any rebuild (edit, undo/redo, load) invalidates a prior
    // selection, so start clean rather than risk merging the wrong rows.
    selectedSubIndices = new Set();
    updateMergeBtnState();

    subtitles.forEach((sub, i) => {
        const item = document.createElement('div');
        item.className     = 'sub-item';
        item.dataset.index = i;

        const selectCb = document.createElement('input');
        selectCb.type      = 'checkbox';
        selectCb.className = 'sub-select-checkbox';
        selectCb.title     = t('Select for merging');
        selectCb.addEventListener('click', (e) => e.stopPropagation());
        selectCb.addEventListener('change', () => {
            if (selectCb.checked) selectedSubIndices.add(i);
            else selectedSubIndices.delete(i);
            item.classList.toggle('selected', selectCb.checked);
            updateMergeBtnState();
        });

        const timesCol = document.createElement('div');
        timesCol.className = 'sub-times';

        const startEl = document.createElement('span');
        startEl.className   = 'sub-time sub-time-start';
        startEl.title       = t('Click to edit start time');
        startEl.textContent = formatTimeCompact(sub.start);
        startEl.addEventListener('click', (e) => { e.stopPropagation(); editTime(startEl, i, 'start'); });

        const endEl = document.createElement('span');
        endEl.className   = 'sub-time sub-time-end';
        endEl.title       = t('Click to edit end time');
        endEl.textContent = formatTimeCompact(sub.end);
        endEl.addEventListener('click', (e) => { e.stopPropagation(); editTime(endEl, i, 'end'); });

        timesCol.appendChild(startEl);
        timesCol.appendChild(endEl);

        const textEl = document.createElement('span');
        textEl.className       = 'sub-text';
        textEl.contentEditable = 'false';
        textEl.spellcheck      = false;
        textEl.textContent     = sub.text;

        // ── Split button ─────────────────────────────────────────
        const splitBtn = document.createElement('button');
        splitBtn.type      = 'button';
        splitBtn.className = 'sub-split-btn';
        splitBtn.title     = t('Split subtitle at cursor position');
        splitBtn.textContent = '✂';

        // Prevent textEl blur when the user clicks the confirm-state button
        splitBtn.addEventListener('mousedown', (e) => {
            if (splitBtn.classList.contains('confirming')) e.preventDefault();
        });

        splitBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!splitBtn.classList.contains('confirming')) {
                // First click: enter edit mode, place cursor at word-boundary midpoint
                textEl.contentEditable = 'true';
                textEl.focus();
                const node = textEl.firstChild;
                if (node && node.nodeType === Node.TEXT_NODE) {
                    let mid = Math.floor(node.length / 2);
                    // Snap to nearest word boundary
                    const spAfter  = node.textContent.indexOf(' ', mid);
                    const spBefore = node.textContent.lastIndexOf(' ', mid - 1);
                    if (spAfter !== -1 || spBefore !== -1) {
                        const dA = spAfter  !== -1 ? spAfter  - mid : Infinity;
                        const dB = spBefore !== -1 ? mid - 1 - spBefore : Infinity;
                        mid = dB <= dA ? spBefore + 1 : spAfter + 1;
                    }
                    const r = document.createRange();
                    r.setStart(node, mid);
                    r.collapse(true);
                    window.getSelection().removeAllRanges();
                    window.getSelection().addRange(r);
                }
                splitBtn.classList.add('confirming');
                splitBtn.title = t('Click to split here — move cursor first to change split point');
            } else {
                // Second click: perform the split at current cursor position
                splitSubtitle(i, textEl);
            }
        });

        // Single click on item → seek & play
        item.addEventListener('click', () => {
            videoPlayer.currentTime = sub.start;
            if (videoPlayer.paused) videoPlayer.play();
        });

        // Double click on item → enter text edit mode (select-all)
        item.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            textEl.contentEditable = 'true';
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });

        // Exit edit mode + reset split button when focus leaves
        textEl.addEventListener('blur', () => {
            if ((subtitles[i]?.text ?? '') !== textAtFocus) saveHistory();
            textEl.contentEditable = 'false';
            splitBtn.classList.remove('confirming');
            splitBtn.title = t('Split subtitle at cursor position');
        });

        let textAtFocus = '';
        textEl.addEventListener('focus', () => { textAtFocus = subtitles[i]?.text ?? ''; });
        textEl.addEventListener('input', () => {
            subtitles[i].text = textEl.textContent;
            srtOutput.value   = rebuildSRT();
        });

        // Prevent clicks inside the active text field from seeking
        textEl.addEventListener('click', e => {
            if (textEl.contentEditable === 'true') e.stopPropagation();
        });

        // ── Delete button ─────────────────────────────────────────
        const deleteBtn = document.createElement('button');
        deleteBtn.type      = 'button';
        deleteBtn.className = 'sub-delete-btn';
        deleteBtn.title     = t('Delete subtitle');
        deleteBtn.innerHTML = '<svg width="11" height="12" viewBox="0 0 11 12" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="3" width="9" height="1" fill="currentColor"/><path d="M2 4l.6 6.5a.5.5 0 0 0 .5.5h4.8a.5.5 0 0 0 .5-.5L9 4" stroke="currentColor" stroke-width="1" fill="none"/><path d="M4 3V2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1" stroke="currentColor" stroke-width="1" fill="none"/></svg>';

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!deleteBtn.classList.contains('confirming')) {
                deleteBtn.classList.add('confirming');
                deleteBtn.title = t('Click again to confirm delete');
                // Auto-cancel confirm state after 2 s if user doesn't click again
                setTimeout(() => {
                    deleteBtn.classList.remove('confirming');
                    deleteBtn.title = t('Delete subtitle');
                }, 2000);
            } else {
                subtitles.splice(i, 1);
                saveHistory();
                srtOutput.value = rebuildSRT();
                populateSubList();
            }
        });

        item.appendChild(selectCb);
        item.appendChild(timesCol);
        item.appendChild(textEl);
        item.appendChild(splitBtn);
        item.appendChild(deleteBtn);
        subListBody.appendChild(item);

        // Insert-between button (between this item and the next)
        if (i < subtitles.length - 1) {
            const insertZone = document.createElement('div');
            insertZone.className = 'sub-insert';

            const insertBtn = document.createElement('button');
            insertBtn.type      = 'button';
            insertBtn.className = 'sub-insert-btn';
            insertBtn.title     = t('Insert new subtitle here');
            insertBtn.textContent = '+ ' + t('Insert');
            insertBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                insertSubtitle(i);
            });

            insertZone.appendChild(insertBtn);
            subListBody.appendChild(insertZone);
        }
    });

    setLayout(subListLayout);
    buildTimeline();
}

// ── Split subtitle at cursor position ────────────────────────────
function splitSubtitle(index, textEl) {
    // Read cursor offset from the contentEditable span
    let splitPos = 0;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (textEl.contains(range.startContainer)) {
            const pre = range.cloneRange();
            pre.selectNodeContents(textEl);
            pre.setEnd(range.startContainer, range.startOffset);
            splitPos = pre.toString().length;
        }
    }

    const sub  = subtitles[index];
    const text = sub.text;

    // If cursor is at start/end or unset, use midpoint
    if (splitPos <= 0 || splitPos >= text.length) {
        splitPos = Math.floor(text.length / 2);
    }

    // Snap to nearest word boundary
    const spAfter  = text.indexOf(' ', splitPos);
    const spBefore = text.lastIndexOf(' ', splitPos - 1);
    if (spAfter !== -1 || spBefore !== -1) {
        const dA = spAfter  !== -1 ? spAfter  - splitPos : Infinity;
        const dB = spBefore !== -1 ? splitPos - 1 - spBefore : Infinity;
        splitPos = dB <= dA ? spBefore + 1 : spAfter + 1;
    }

    const textA = text.slice(0, splitPos).trim();
    const textB = text.slice(splitPos).trim();
    if (!textA || !textB) return; // nothing useful on one side

    let midTime;
    const currentTime = videoPlayer.currentTime;
    // Use the current video time if it falls within the segment's duration
    if (currentTime > sub.start && currentTime < sub.end) {
        midTime = currentTime;
    } else {
        // Otherwise, divide the time range proportionally by character count
        const ratio = textA.length / (textA.length + textB.length);
        midTime = sub.start + (sub.end - sub.start) * ratio;
    }

    subtitles.splice(index, 1,
        { start: sub.start, end: midTime, text: textA },
        { start: midTime,   end: sub.end, text: textB }
    );
    saveHistory();

    srtOutput.value = rebuildSRT();
    populateSubList();

    // Scroll first new item into view
    const items = subListBody.querySelectorAll('.sub-item');
    if (items[index]) items[index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Insert subtitle between two existing items ───────────────────
function insertSubtitle(afterIndex) {
    const NEW_DUR = 1.0;
    const MIN_DUR = 0.1;
    const prev = subtitles[afterIndex];
    const next = subtitles[afterIndex + 1];

    const gap = next.start - prev.end;
    let newStart, newEnd;

    if (gap >= NEW_DUR) {
        // Enough room — place right after prev
        newStart = prev.end;
        newEnd   = prev.end + NEW_DUR;
    } else {
        // Not enough room — steal from prev's tail and next's head
        const deficit     = NEW_DUR - gap;
        const maxFromPrev = Math.max(0, (prev.end - prev.start) - MIN_DUR);
        const maxFromNext = Math.max(0, (next.end - next.start) - MIN_DUR);

        let stealPrev = Math.min(deficit / 2, maxFromPrev);
        let stealNext = Math.min(deficit / 2, maxFromNext);

        // Redistribute any shortfall to the other side
        if (stealPrev < deficit / 2)
            stealNext = Math.min(stealNext + (deficit / 2 - stealPrev), maxFromNext);
        if (stealNext < deficit / 2)
            stealPrev = Math.min(stealPrev + (deficit / 2 - stealNext), maxFromPrev);

        newStart = prev.end - stealPrev;
        newEnd   = next.start + stealNext;

        subtitles[afterIndex].end         = newStart;
        subtitles[afterIndex + 1].start   = newEnd;
    }

    subtitles.splice(afterIndex + 1, 0, { start: newStart, end: newEnd, text: '' });
    saveHistory();
    srtOutput.value = rebuildSRT();
    populateSubList();

    // Scroll new item into view and open it for editing
    const items = subListBody.querySelectorAll('.sub-item');
    const newItem = items[afterIndex + 1];
    if (newItem) {
        newItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const textEl = newItem.querySelector('.sub-text');
        if (textEl) { textEl.contentEditable = 'true'; textEl.focus(); }
    }
}

// ── Merge selected subtitles ───────────────────────────────────────
// Only a contiguous run can be merged — merging a non-adjacent selection
// would have to silently absorb whatever unselected segments sit between
// them, which is more likely to lose text than help.
function selectedIndicesAreContiguous() {
    if (selectedSubIndices.size < 2) return false;
    const indices = [...selectedSubIndices].sort((a, b) => a - b);
    return indices.every((idx, k) => k === 0 || idx === indices[k - 1] + 1);
}

function updateMergeBtnState() {
    const contiguous = selectedIndicesAreContiguous();
    mergeSelectedBtn.disabled = !contiguous;
    mergeSelectedBtn.title = contiguous
        ? t('Merge {n} selected segments', { n: selectedSubIndices.size })
        : (selectedSubIndices.size >= 2
            ? t('Selected segments must be adjacent to merge')
            : t('Select two or more adjacent segments to merge'));
}

function mergeSelectedSubtitles() {
    if (!selectedIndicesAreContiguous()) return;
    const indices = [...selectedSubIndices].sort((a, b) => a - b);
    const first = indices[0];
    const last  = indices[indices.length - 1];

    const merged = {
        start: subtitles[first].start,
        end:   subtitles[last].end,
        text:  subtitles.slice(first, last + 1)
            .map(s => s.text.trim())
            .filter(Boolean)
            .join(' '),
    };

    subtitles.splice(first, last - first + 1, merged);
    saveHistory();
    srtOutput.value = rebuildSRT();
    populateSubList();

    const items = subListBody.querySelectorAll('.sub-item');
    if (items[first]) items[first].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

mergeSelectedBtn.addEventListener('click', mergeSelectedSubtitles);

// ── Time format helpers ──────────────────────────────────────────
// Compact display format: M:SS.mmm or H:MM:SS.mmm
function formatTimeCompact(sec) {
    const h  = Math.floor(sec / 3600);
    const m  = Math.floor((sec % 3600) / 60);
    const s  = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    const tail = `${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
    return h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${tail}`
        : `${m}:${tail}`;
}

// Parse [H:]M:SS[.mmm] — returns seconds or null on failure
function parseTimeCompact(str) {
    const m = str.trim().match(/^(?:(\d+):)?(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/);
    if (!m) return null;
    const total = parseInt(m[1]||'0')*3600 + parseInt(m[2])*60 + parseInt(m[3])
                  + parseInt((m[4]||'0').padEnd(3,'0')) / 1000;
    return isNaN(total) || total < 0 ? null : total;
}

// ── Inline time editing ──────────────────────────────────────────
function editTime(el, index, field) {
    if (el.querySelector('input')) return; // already editing
    const input = document.createElement('input');
    input.type      = 'text';
    input.className = 'sub-time-input';
    input.value     = el.textContent;
    el.textContent  = '';
    el.appendChild(input);
    input.focus();
    input.select();

    const timeAtOpen = subtitles[index][field];
    function commit() {
        const parsed = parseTimeCompact(input.value);
        const sub    = subtitles[index];
        if (parsed !== null) {
            if (field === 'start' && parsed >= 0 && parsed < sub.end) {
                subtitles[index].start = parsed;
                if (parsed !== timeAtOpen) saveHistory();
            } else if (field === 'end' && parsed > sub.start) {
                subtitles[index].end = parsed;
                if (parsed !== timeAtOpen) saveHistory();
            }
        }
        el.textContent = formatTimeCompact(subtitles[index][field]);
        srtOutput.value = rebuildSRT();
        updateTimelineSegment(index);
    }

    input.addEventListener('blur',    commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { el.textContent = formatTimeCompact(subtitles[index][field]); }
    });
}

// ── Live sub-list time display update (used during timeline drag) ─
function updateSubListTimeDisplay(index) {
    const items = subListBody.querySelectorAll('.sub-item');
    if (!items[index]) return;
    const sub     = subtitles[index];
    const startEl = items[index].querySelector('.sub-time-start');
    const endEl   = items[index].querySelector('.sub-time-end');
    // Don't overwrite if an input is currently active inside the element
    if (startEl && !startEl.querySelector('input')) startEl.textContent = formatTimeCompact(sub.start);
    if (endEl   && !endEl.querySelector('input'))   endEl.textContent   = formatTimeCompact(sub.end);
}

// ── Update one timeline segment without full rebuild ─────────────
function updateTimelineSegment(index) {
    const segs = timelineTrack.querySelectorAll('.timeline-segment');
    if (!segs[index]) return;
    const duration = (videoPlayer.duration > 0 && isFinite(videoPlayer.duration))
        ? videoPlayer.duration : subtitles[subtitles.length - 1].end;
    const sub = subtitles[index];
    segs[index].style.left  = `${(sub.start / duration) * 100}%`;
    segs[index].style.width = `${Math.max(0.15, (sub.end - sub.start) / duration * 100)}%`;
}

// Suppress auto-scroll while the user types in the list (one-time setup)
subListBody.addEventListener('focusin',  () => { isEditingSubList = true; });
subListBody.addEventListener('focusout', () => { isEditingSubList = false; });

// ── SRT textarea editing → sync back to subtitles + sub-list ────
let srtValueAtFocus = '';
srtOutput.addEventListener('focus', () => { srtValueAtFocus = srtOutput.value; });
srtOutput.addEventListener('blur',  () => { if (srtOutput.value !== srtValueAtFocus) saveHistory(); });
srtOutput.addEventListener('input', () => {
    const parsed = parseSRT(srtOutput.value);
    if (parsed.length === subtitles.length) {
        parsed.forEach((s, i) => { subtitles[i].text = s.text; });
        subListBody.querySelectorAll('.sub-text').forEach((el, i) => {
            if (subtitles[i] && el.textContent !== subtitles[i].text) {
                el.textContent = subtitles[i].text;
            }
        });
    } else {
        // Segment count changed — full re-parse and rebuild
        subtitles = parsed;
        if (pagePlayer.classList.contains('active')) populateSubList();
    }
});

// ── Rebuild SRT string from subtitles array ──────────────────────
function rebuildSRT() {
    return subtitles.map((sub, i) =>
        `${i + 1}\n${formatSRTTime(sub.start)} --> ${formatSRTTime(sub.end)}\n${sub.text}`
    ).join('\n\n') + '\n';
}

function formatSRTTime(sec) {
    const h  = Math.floor(sec / 3600);
    const m  = Math.floor((sec % 3600) / 60);
    const s  = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

// ── Sub-list layout ──────────────────────────────────────────────
[layoutBelowBtn, layoutBesideBtn, layoutFloatBtn].forEach(btn => {
    btn.addEventListener('click', () => setLayout(btn.id.replace('layout-', '')));
});

function setLayout(mode) {
    subListLayout = mode;
    localStorage.setItem('subListLayout', mode);
    videoPanel.classList.remove('layout-below', 'layout-beside', 'layout-float');
    videoPanel.classList.add(`layout-${mode}`);
    [layoutBelowBtn, layoutBesideBtn, layoutFloatBtn].forEach(b =>
        b.classList.toggle('active', b.id === `layout-${mode}`)
    );
    if (mode === 'float') {
        positionFloat();
        positionFloatVideo();
    } else {
        subList.style.left   = '';
        subList.style.top    = '';
        subList.style.width  = '';
        subList.style.height = '';
        videoColumn.style.left   = '';
        videoColumn.style.top    = '';
        videoColumn.style.width  = '';
        videoColumn.style.height = '';
        videoColumn.style.zIndex = '';
        subList.style.zIndex     = '';
    }
    if (mode !== 'beside') {
        videoColumn.style.flex = '';
        subList.style.flex     = '';
    }
    if (mode !== 'float') {
        const savedH = localStorage.getItem(`subListHeight-${mode}`);
        subList.style.height = savedH ? `${savedH}px` : '';
    }
}

function positionFloat() {
    if (!floatPos) {
        // First use: anchor near the right of the viewport
        floatPos = { x: Math.max(8, window.innerWidth - 340), y: 120 };
    }
    const margin = 8;
    // offsetWidth/Height may be 0 on the first call before the browser
    // applies the new CSS class; fall back to the CSS-defined dimensions.
    const w    = subList.offsetWidth  || 300;
    const h    = subList.offsetHeight || 380;
    // position:fixed coords are viewport-relative — never add scrollY
    const maxX = window.innerWidth  - w - margin;
    const maxY = window.innerHeight - h - margin;
    subList.style.left = `${Math.max(margin, Math.min(floatPos.x, maxX))}px`;
    subList.style.top  = `${Math.max(margin, Math.min(floatPos.y, maxY))}px`;
}

function positionFloatVideo() {
    if (!floatVideoPos) {
        floatVideoPos = { x: Math.max(8, window.innerWidth / 2 - 240), y: 80 };
    }
    const margin = 8;
    const w    = videoColumn.offsetWidth  || 480;
    const h    = videoColumn.offsetHeight || 300;
    const maxX = window.innerWidth  - w - margin;
    const maxY = window.innerHeight - h - margin;
    videoColumn.style.left = `${Math.max(margin, Math.min(floatVideoPos.x, maxX))}px`;
    videoColumn.style.top  = `${Math.max(margin, Math.min(floatVideoPos.y, maxY))}px`;
}

// ── Drag (float mode) ────────────────────────────────────────────
function startDrag(clientX, clientY) {
    if (subListLayout !== 'float') return;
    isDragging   = true;
    const rect   = subList.getBoundingClientRect();
    dragOffset.x = clientX - rect.left;
    dragOffset.y = clientY - rect.top;
}

function moveDrag(clientX, clientY) {
    if (!isDragging) return;
    floatPos = {
        x: clientX - dragOffset.x,
        y: clientY - dragOffset.y,
    };
    positionFloat();
}

function stopDrag() { isDragging = false; }

function startVideoDrag(clientX, clientY) {
    if (subListLayout !== 'float') return;
    isDraggingVideo   = true;
    const rect        = videoColumn.getBoundingClientRect();
    dragVideoOffset.x = clientX - rect.left;
    dragVideoOffset.y = clientY - rect.top;
}

function moveVideoDrag(clientX, clientY) {
    if (!isDraggingVideo) return;
    floatVideoPos = {
        x: clientX - dragVideoOffset.x,
        y: clientY - dragVideoOffset.y,
    };
    positionFloatVideo();
}

function stopVideoDrag() { isDraggingVideo = false; }

// ── Timeline handle drag ─────────────────────────────────────────
let isDraggingHandle = false;
let handleDragIndex  = -1;
let handleDragEdge   = null;   // 'start' | 'end'

function startHandleDrag(index, edge) {
    isDraggingHandle = true;
    handleDragIndex  = index;
    handleDragEdge   = edge;
    document.body.style.cursor = 'ew-resize';
}

function moveHandleDrag(clientX) {
    if (!isDraggingHandle) return;
    const duration = (videoPlayer.duration > 0 && isFinite(videoPlayer.duration))
        ? videoPlayer.duration : subtitles[subtitles.length - 1].end;
    const rect    = timelineEl.getBoundingClientRect();
    const clickX  = (clientX - rect.left) + timelineEl.scrollLeft;
    const newTime = Math.max(0, Math.min(duration, (clickX / timelineTrack.offsetWidth) * duration));
    const sub     = subtitles[handleDragIndex];

    if (handleDragEdge === 'start') {
        const minT = handleDragIndex > 0 ? subtitles[handleDragIndex - 1].end : 0;
        sub.start  = Math.max(minT, Math.min(newTime, sub.end - 0.1));
    } else {
        const maxT = handleDragIndex < subtitles.length - 1
            ? subtitles[handleDragIndex + 1].start : duration;
        sub.end = Math.max(sub.start + 0.1, Math.min(newTime, maxT));
    }

    updateTimelineSegment(handleDragIndex);
    updateSubListTimeDisplay(handleDragIndex);
    srtOutput.value = rebuildSRT();
}

function stopHandleDrag() {
    if (!isDraggingHandle) return;
    saveHistory();
    isDraggingHandle = false;
    handleDragIndex  = -1;
    handleDragEdge   = null;
    document.body.style.cursor = '';
}

// ── Segment body move (fixed duration) ──────────────────────────
let isMovingSegment   = false;
let moveDragActive    = false;   // true once movement exceeds threshold
let moveDragIndex     = -1;
let moveDragStartX    = 0;
let moveDragOrigStart = 0;
let moveDragOrigEnd   = 0;

function startSegmentMove(index, origStart, origEnd, clientX) {
    isMovingSegment   = true;
    moveDragActive    = false;
    moveDragIndex     = index;
    moveDragStartX    = clientX;
    moveDragOrigStart = origStart;
    moveDragOrigEnd   = origEnd;
}

function moveSegmentDrag(clientX) {
    if (!isMovingSegment) return;
    const dx = clientX - moveDragStartX;
    if (!moveDragActive) {
        if (Math.abs(dx) < 3) return;   // below threshold — not a drag yet
        moveDragActive = true;
        document.body.style.cursor = 'grabbing';
    }

    const duration  = (videoPlayer.duration > 0 && isFinite(videoPlayer.duration))
        ? videoPlayer.duration : subtitles[subtitles.length - 1].end;
    const dur       = moveDragOrigEnd - moveDragOrigStart;
    const dtSec     = (dx / timelineTrack.offsetWidth) * duration;

    let newStart = moveDragOrigStart + dtSec;
    let newEnd   = moveDragOrigEnd   + dtSec;

    // Clamp to timeline bounds first
    if (newStart < 0)        { newStart = 0;             newEnd = dur; }
    if (newEnd   > duration) { newEnd   = duration;      newStart = duration - dur; }

    // Clamp to neighbour boundaries (prevent overlap)
    if (moveDragIndex > 0) {
        const prevEnd = subtitles[moveDragIndex - 1].end;
        if (newStart < prevEnd) { newStart = prevEnd; newEnd = prevEnd + dur; }
    }
    if (moveDragIndex < subtitles.length - 1) {
        const nextStart = subtitles[moveDragIndex + 1].start;
        if (newEnd > nextStart) { newEnd = nextStart; newStart = Math.max(0, nextStart - dur); }
    }

    subtitles[moveDragIndex].start = newStart;
    subtitles[moveDragIndex].end   = newEnd;
    updateTimelineSegment(moveDragIndex);
    updateSubListTimeDisplay(moveDragIndex);
    srtOutput.value = rebuildSRT();
}

function stopSegmentMove() {
    if (!isMovingSegment) return;
    if (!moveDragActive) {
        // No significant movement → treat as seek click
        videoPlayer.currentTime = subtitles[moveDragIndex]?.start ?? moveDragOrigStart;
        if (videoPlayer.paused) videoPlayer.play();
    } else {
        saveHistory();
    }
    isMovingSegment = false;
    moveDragActive  = false;
    moveDragIndex   = -1;
    document.body.style.cursor = '';
}

// ── Sub-list height resize ───────────────────────────────────────
let isResizingSubList = false;
let subListResizeStartY = 0;
let subListResizeStartH = 0;

subListResizer.addEventListener('mousedown', (e) => {
    if (subListLayout !== 'below' && subListLayout !== 'beside') return;
    isResizingSubList   = true;
    subListResizeStartY = e.clientY;
    subListResizeStartH = subList.offsetHeight;
    subListResizer.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
});

function moveSubListResize(clientY) {
    if (!isResizingSubList) return;
    const dy   = clientY - subListResizeStartY;  // down = positive = taller
    const minH = 80;
    const newH = Math.max(minH, subListResizeStartH + dy);
    subList.style.height = `${newH}px`;
}

function stopSubListResize() {
    if (!isResizingSubList) return;
    isResizingSubList = false;
    subListResizer.classList.remove('dragging');
    document.body.style.cursor = '';
    localStorage.setItem(`subListHeight-${subListLayout}`, subList.offsetHeight);
}

// ── Beside-panel resize ──────────────────────────────────────────
let isResizingBeside = false;

besideResizer.addEventListener('mousedown', (e) => {
    if (subListLayout !== 'beside') return;
    isResizingBeside = true;
    besideResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
});

function moveBesideResize(clientX) {
    if (!isResizingBeside) return;
    const panelRect = videoPanel.getBoundingClientRect();
    const minPx     = 200;
    const maxPx     = panelRect.width - besideResizer.offsetWidth - 160;
    const videoW    = Math.max(minPx, Math.min(clientX - panelRect.left, maxPx));
    videoColumn.style.flex = `0 0 ${videoW}px`;
    subList.style.flex     = '1 1 0';
}

function stopBesideResize() {
    if (!isResizingBeside) return;
    isResizingBeside = false;
    besideResizer.classList.remove('dragging');
    document.body.style.cursor = '';
}

function bringToFront(el, other) {
    if (subListLayout !== 'float') return;
    el.style.zIndex    = '201';
    other.style.zIndex = '200';
}

subList.addEventListener('mousedown',      () => bringToFront(subList,     videoColumn));
videoColumn.addEventListener('mousedown',  () => bringToFront(videoColumn, subList));

subListHeader.addEventListener('mousedown', e => { startDrag(e.clientX, e.clientY); e.preventDefault(); });
videoFloatHandle.addEventListener('mousedown', e => { startVideoDrag(e.clientX, e.clientY); e.preventDefault(); });
document.addEventListener('mousemove', (e) => { moveDrag(e.clientX, e.clientY); moveVideoDrag(e.clientX, e.clientY); moveHandleDrag(e.clientX); moveSegmentDrag(e.clientX); moveBesideResize(e.clientX); moveSubListResize(e.clientY); });
document.addEventListener('mouseup',   ()  => { stopDrag(); stopVideoDrag(); stopHandleDrag(); stopSegmentMove(); stopBesideResize(); stopSubListResize(); });

subListHeader.addEventListener('touchstart', e => {
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
    e.preventDefault();
}, { passive: false });
videoFloatHandle.addEventListener('touchstart', e => {
    startVideoDrag(e.touches[0].clientX, e.touches[0].clientY);
    e.preventDefault();
}, { passive: false });
document.addEventListener('touchmove', e => {
    if (isDragging)      { moveDrag(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }
    if (isDraggingVideo) { moveVideoDrag(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }
}, { passive: false });
document.addEventListener('touchend', () => { stopDrag(); stopVideoDrag(); });

// ── SRT parser ───────────────────────────────────────────────────
function parseSRT(srt) {
    const toSec = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;
    return srt.trim().split(/\n\n+/).map(block => {
        const lines = block.trim().split('\n');
        if (lines.length < 2) return null;
        const m = lines[1].match(
            /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/
        );
        if (!m) return null;
        return {
            start: toSec(m[1], m[2], m[3], m[4]),
            end:   toSec(m[5], m[6], m[7], m[8]),
            text:  lines.slice(2).join('\n'),
        };
    }).filter(Boolean);
}

function formatTimecode(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Helpers ──────────────────────────────────────────────────────
function setStatus(msg) { statusText.textContent = msg; }

function setProgressIndeterminate(on) {
    if (on) {
        progressFill.classList.add('indeterminate');
        progressFill.style.width = '';
    } else {
        progressFill.classList.remove('indeterminate');
    }
}

function setProgressFull() {
    setProgressIndeterminate(false);
    progressFill.style.width = '100%';
}

// ── Download ─────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
    const srt = srtOutput.value;
    if (!srt.trim()) return;
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${currentFilename}.srt`;
    a.click();
    URL.revokeObjectURL(url);
});

// ── FCPXML Export ─────────────────────────────────────────────────
// Each preset stores the frameDuration as { num, den } (num/den seconds per frame).
// All time values must be integer multiples of frameDuration — FCP rejects anything else.

const FCP_PROFILES = {
    me: {
        version: '1.11',
        effect: 'name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"',
        buildTitle: (offset, dur, clipName, tsId, text) => [
            `            <title ref="r2" lane="1" offset="${offset}" duration="${dur}" start="0s" name="${clipName}">`,
            `              <param name="Position" key="9999/999166631/999166633/1/100/101" value="0 -420"/>`,
            `              <text>`,
            `                <text-style ref="${tsId}">${text}</text-style>`,
            `              </text>`,
            `              <text-style-def id="${tsId}">`,
            `                <text-style font="GyeonggiTitleOTF" fontSize="50" fontFace="Light" fontColor="1 1 1 1" strokeColor="0.0156863 0.00392158 0.145098 1" strokeWidth="-1" shadowColor="0 0 0 0.75" shadowOffset="5 315" kerning="1.6" alignment="center">`,
            `                    <param name="MotionSimpleValues" key="MotionTextStyle:SimpleValues">`,
            `                        <param name="motionTextTracking" key="tracking" value="1.6"/>`,
            `                    </param>`,
            `                </text-style>`,
            `              </text-style-def>`,
            `            </title>`,
        ].join('\n'),
    },
    wife: {
        version: '1.13',
        effect: 'name="반응형 자막" uid="~/Titles.localized/AS_Titles/하단 자막/반응형 자막/반응형 자막.moti" src="file:///Users/okssi/Library/Containers/com.apple.FinalCut/Data/Movies/Motion%20Templates.localized/Titles.localized/AS_Titles/%E1%84%92%E1%85%A1%E1%84%83%E1%85%A1%E1%86%AB%20%E1%84%8C%E1%85%A1%E1%84%86%E1%85%A1%E1%86%A8/%E1%84%87%E1%85%A1%E1%86%AB%E1%84%8B%E1%85%B3%E1%86%BC%E1%84%92%E1%85%A7%E1%86%BC%20%E1%84%8C%E1%85%A1%E1%84%86%E1%85%A1%E1%86%A8/%E1%84%87%E1%85%A1%E1%86%AB%E1%84%8B%E1%85%B3%E1%86%BC%E1%84%92%E1%85%A7%E1%86%BC%20%E1%84%8C%E1%85%A1%E1%84%86%E1%85%A1%E1%86%A8.moti"',
        buildTitle: (offset, dur, clipName, tsId, text) => [
            `<title ref="r2" lane="1" offset="${offset}" name="${clipName} - 반응형 자막" start="0s" duration="${dur}">`,
            `                    <param name="Position" key="9999/10003/10009/1/100/101" value="41.2446 -266.217"/>`,
            `                    <param name="Anchor Point" key="9999/10003/10009/1/100/107" value="768 50"/>`,
            `                    <param name="Alignment" key="9999/10003/10009/2/354/10038/401" value="1 (Center)"/>`,
            `                    <param name="박스 Color" key="9999/10003/11041/2/353/113/111" value="0 0 0"/>`,
            `                    <param name="박스 투명도" key="9999/10003/11041/2/353/113/141" value="0.6457"/>`,
            `                    <text>`,
            `                        <text-style ref="${tsId}">${text}</text-style>`,
            `                    </text>`,
            `                    <text-style-def id="${tsId}">`,
            `                        <text-style font="Pretendard" fontSize="55" fontFace="Regular" fontColor="0.941192 0.9437 1 1" shadowColor="0 0 0 1" shadowOffset="10 315" shadowBlurRadius="10" alignment="center"/>`,
            `                    </text-style-def>`,
            `                </title>`,
        ].join('\n'),
    },
};
const FPS_PRESETS = {
    '2997': { num: 1001, den: 30000 },
    '30':   { num: 1,    den: 30    },
    '2398': { num: 1001, den: 24000 },
    '24':   { num: 1,    den: 24    },
    '25':   { num: 1,    den: 25    },
    '5994': { num: 1001, den: 60000 },
    '60':   { num: 1,    den: 60    },
};

function framesToFCPTime(frames, num, den) {
    if (frames === 0) return '0s';
    const n = frames * num;
    function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
    const g = gcd(n, den);
    return (den / g) === 1 ? `${n / g}s` : `${n / g}/${den / g}s`;
}

function convertToFCPXML(subs, title, fpsKey, target) {
    const escXML = s => s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const { num, den } = FPS_PRESETS[fpsKey] || FPS_PRESETS['2997'];
    const frameDuration = (den === 1) ? `${num}s` : `${num}/${den}s`;

    const toFrames = sec => Math.round(sec * den / num);

    const totalFrames = toFrames(subs[subs.length - 1].end);
    const totalDur    = framesToFCPTime(totalFrames, num, den);

    const profile = FCP_PROFILES[target] || FCP_PROFILES.wife;

    const titleLines = subs.map((sub, i) => {
        const startF   = toFrames(sub.start);
        const endF     = Math.max(startF + 1, toFrames(sub.end));
        const offset   = framesToFCPTime(startF, num, den);
        const dur      = framesToFCPTime(endF - startF, num, den);
        const text     = escXML(sub.text.replace(/\n/g, ' ').trim());
        const tsId     = `ts${i + 1}`;
        const clipName = escXML(sub.text.slice(0, 32).replace(/\n/g, ' ').trim());
        return profile.buildTitle(offset, dur, clipName, tsId, text);
    }).join('\n');

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE fcpxml>',
        `<fcpxml version="${profile.version}">`,
        '  <resources>',
        `    <format id="r1" frameDuration="${frameDuration}" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>`,
        `    <effect id="r2" ${profile.effect}/>`,
        '  </resources>',
        '  <library>',
        `    <event name="Subtitles">`,
        `      <project name="${escXML(title || 'Subtitles')}">`,
        `        <sequence duration="${totalDur}" format="r1" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
        '          <spine>',
        `            <gap name="Gap" offset="0s" duration="${totalDur}" start="0s">`,
        titleLines,
        '            </gap>',
        '          </spine>',
        '        </sequence>',
        '      </project>',
        '    </event>',
        '  </library>',
        '</fcpxml>',
    ].join('\n');
}


exportFcpxmlBtn.addEventListener('click', () => {
    if (!subtitles.length) return;
    const xml  = convertToFCPXML(subtitles, currentFilename, fcpxmlFpsSelect.value, fcpxmlTargetSelect.value);
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${currentFilename}.fcpxml`;
    a.click();
    URL.revokeObjectURL(url);
});

// ── Load SRT ─────────────────────────────────────────────────────
loadSrtBtn.addEventListener('click', () => srtFileInput.click());

srtFileInput.addEventListener('change', () => {
    const file = srtFileInput.files[0];
    if (!file) return;

    // Update the base filename so Download uses the SRT's name
    currentFilename = file.name.replace(/\.srt$/i, '') || currentFilename;
    playerFilename.textContent = currentFilename;

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        srtOutput.value = text;
        srtOutput.scrollTop = 0;

        subtitles = parseSRT(text);
        historyStack = []; historyIndex = -1;
        saveHistory();
        populateSubList();
    };
    reader.readAsText(file, 'utf-8');

    // Allow re-loading the same file again
    srtFileInput.value = '';
});

// ── Copy ─────────────────────────────────────────────────────────
copyBtn.addEventListener('click', () => {
    const srt = srtOutput.value;
    if (!srt.trim()) return;
    navigator.clipboard.writeText(srt).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = t('Copied!');
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    });
});

window.addEventListener('resize', () => {
    if (pagePlayer.classList.contains('active')) {
        renderWaveform();
    }
});

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && pagePlayer.classList.contains('active')) {
        const active = document.activeElement;
        if (!active || (!active.isContentEditable && active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) {
            e.preventDefault();
            undo();
            return;
        }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey)) && pagePlayer.classList.contains('active')) {
        const active = document.activeElement;
        if (!active || (!active.isContentEditable && active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) {
            e.preventDefault();
            redo();
            return;
        }
    }
    if (e.key === ' ' && pagePlayer.classList.contains('active')) {
        const active = document.activeElement;
        if (active && (
            active.tagName === 'INPUT' || 
            active.tagName === 'TEXTAREA' || 
            active.tagName === 'BUTTON' || 
            active.tagName === 'SELECT' || 
            active.isContentEditable
        )) {
            return;
        }
        e.preventDefault();
        if (videoPlayer.paused) {
            videoPlayer.play();
        } else {
            videoPlayer.pause();
        }
    }
});
