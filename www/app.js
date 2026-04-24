'use strict';

// ── Platform detection ───────────────────────────────────────────
const IS_NATIVE = !!(
  window.Capacitor &&
  typeof window.Capacitor.isNativePlatform === 'function' &&
  window.Capacitor.isNativePlatform()
);

// ── State ────────────────────────────────────────────────────────
let isRecording    = false;
let isPaused       = false;
let finalTranscript = '';
let timerInterval  = null;
let startTime      = null;
let elapsedTime    = 0;
let wordCount      = 0;
let engine         = null;

// ── Boot ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  loadSavedTranscript();

  if (!IS_NATIVE) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) document.getElementById('compat-warning').style.display = 'block';
  }

  const granted = await requestPermissions();
  if (!granted) {
    document.getElementById('btn-start').disabled = true;
  }
});

// ── Permissions ──────────────────────────────────────────────────
async function requestPermissions() {
  if (IS_NATIVE) {
    const plugin = window.Capacitor.Plugins.SpeechRecognition;
    if (!plugin) {
      showError('Plugin de reconocimiento de voz no encontrado.');
      return false;
    }
    try {
      const { available } = await plugin.available();
      if (!available) {
        showError('Reconocimiento de voz no disponible en este dispositivo.');
        return false;
      }
      const perm = await plugin.requestPermissions();
      if (perm.speechRecognition !== 'granted') {
        showError('Se requiere permiso de microfono para usar la app.');
        return false;
      }
      return true;
    } catch (e) {
      showError('No se pudieron solicitar permisos: ' + e.message);
      return false;
    }
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      return true;
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        showError('Permiso de microfono denegado. Permite el acceso para continuar.');
      } else {
        showError('No se pudo acceder al microfono: ' + e.message);
      }
      return false;
    }
  }
}

// ── Web Speech Engine ─────────────────────────────────────────────
class WebSpeechEngine {
  constructor(handlers) {
    this.onPartial  = handlers.onPartial;
    this.onFinal    = handlers.onFinal;
    this.onError    = handlers.onError;
    this.active     = false;
    this._recognition  = null;
    this._restartTimer = null;
  }

  async start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this.onError('Reconocimiento de voz no disponible. Usa Chrome o Edge.');
      return false;
    }
    this.active = true;
    this._createAndStart();
    return true;
  }

  _createAndStart() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r  = new SR();
    r.continuous      = true;
    r.interimResults  = true;
    r.lang            = 'es-MX';
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          this.onFinal(res[0].transcript.trim());
        } else {
          interim += res[0].transcript;
        }
      }
      this.onPartial(interim);
    };

    r.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed') {
        this.onError('Permiso de microfono denegado.');
        this.active = false;
      }
    };

    r.onend = () => {
      this.onPartial('');
      if (this.active) {
        this._restartTimer = setTimeout(() => {
          if (this.active) this._createAndStart();
        }, 300);
      }
    };

    this._recognition = r;
    try {
      r.start();
    } catch (e) {
      if (this.active) {
        this._restartTimer = setTimeout(() => {
          if (this.active) this._createAndStart();
        }, 500);
      }
    }
  }

  async stop() {
    this.active = false;
    clearTimeout(this._restartTimer);
    if (this._recognition) {
      this._recognition.abort();
      this._recognition = null;
    }
    this.onPartial('');
  }
}

// ── Native Speech Engine (Capacitor Android) ─────────────────────
class NativeSpeechEngine {
  constructor(handlers) {
    this.onPartial    = handlers.onPartial;
    this.onFinal      = handlers.onFinal;
    this.onError      = handlers.onError;
    this.active       = false;
    this._lastPartial = '';
    this._partialHandle = null;
    this._stateHandle   = null;
    this._silenceTimer  = null;
    this._restartTimer  = null;
    this._plugin = window.Capacitor &&
                   window.Capacitor.Plugins &&
                   window.Capacitor.Plugins.SpeechRecognition;
  }

  async start() {
    if (!this._plugin) {
      this.onError('Plugin de reconocimiento de voz no disponible.');
      return false;
    }
    this.active       = true;
    this._lastPartial = '';

    this._partialHandle = await this._plugin.addListener('partialResults', (data) => {
      if (!this.active) return;
      const text = (data.matches && data.matches[0]) || '';
      this._lastPartial = text;
      this.onPartial(text);
      this._resetSilenceTimer();
    });

    this._stateHandle = await this._plugin.addListener('listeningState', (data) => {
      if (data.status === 'stopped' && this.active) this._handleEnd();
    });

    return await this._startListening();
  }

  _resetSilenceTimer() {
    clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => {
      if (this.active) this._handleEnd();
    }, 4000);
  }

  _handleEnd() {
    clearTimeout(this._silenceTimer);
    clearTimeout(this._restartTimer);
    const text = this._lastPartial.trim();
    if (text) {
      this.onFinal(text);
      this._lastPartial = '';
    }
    this.onPartial('');
    this._restartTimer = setTimeout(async () => {
      if (this.active) await this._startListening();
    }, 400);
  }

  async _startListening() {
    try {
      await this._plugin.start({
        language:       'es-MX',
        maxResults:     1,
        partialResults: true,
        popup:          false,
      });
      this._resetSilenceTimer();
      return true;
    } catch (e) {
      if (this.active) {
        this._restartTimer = setTimeout(async () => {
          if (this.active) await this._startListening();
        }, 1000);
      }
      return false;
    }
  }

  async stop() {
    this.active = false;
    clearTimeout(this._silenceTimer);
    clearTimeout(this._restartTimer);

    const text = this._lastPartial.trim();
    if (text) { this.onFinal(text); this._lastPartial = ''; }
    this.onPartial('');

    if (this._partialHandle) { await this._partialHandle.remove(); this._partialHandle = null; }
    if (this._stateHandle)   { await this._stateHandle.remove();   this._stateHandle   = null; }

    try { await this._plugin.stop(); } catch (e) {}
  }
}

// ── Engine factory ───────────────────────────────────────────────
function createEngine() {
  const handlers = {
    onPartial: (text) => updateTranscriptDisplay(text),
    onFinal: (text) => {
      if (!text) return;
      finalTranscript += text + ' ';
      saveTranscript();
      updateWordCount();
      updateTranscriptDisplay('');
    },
    onError: (msg) => showError(msg),
  };
  return IS_NATIVE ? new NativeSpeechEngine(handlers) : new WebSpeechEngine(handlers);
}

// ── Recording control ────────────────────────────────────────────
async function startRecording() {
  clearError();
  engine = createEngine();
  const ok = await engine.start();
  if (!ok) { engine = null; return; }

  isRecording = true;
  isPaused    = false;
  startTime   = Date.now() - elapsedTime;
  timerInterval = setInterval(updateTimer, 1000);
  setUIState('recording');
  showInfo('Grabando...');
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  isPaused    = false;
  clearInterval(timerInterval);

  if (engine) { await engine.stop(); engine = null; }
  if (startTime) elapsedTime = Date.now() - startTime;

  setUIState('stopped');
  showInfo('Grabacion detenida. ' + wordCount + ' palabras capturadas.');
}

async function togglePause() {
  if (!isRecording) return;

  if (!isPaused) {
    isPaused = true;
    clearInterval(timerInterval);
    elapsedTime = Date.now() - startTime;
    if (engine) { await engine.stop(); engine = null; }
    setUIState('paused');
    showInfo('Pausado.');
  } else {
    isPaused = false;
    engine   = createEngine();
    const ok = await engine.start();
    if (!ok) { isPaused = true; return; }
    startTime     = Date.now() - elapsedTime;
    timerInterval = setInterval(updateTimer, 1000);
    setUIState('recording');
    showInfo('Reanudado.');
  }
}

function clearTranscript() {
  if (isRecording) { showError('Detén la grabacion antes de limpiar.'); return; }
  if (finalTranscript && !confirm('Limpiar toda la transcripcion?')) return;
  finalTranscript = '';
  elapsedTime     = 0;
  wordCount       = 0;
  startTime       = null;
  updateTranscriptDisplay('');
  updateWordCount();
  updateTimer();
  try { localStorage.removeItem('clase_transcript'); } catch (e) {}
  document.getElementById('result-section').classList.remove('visible');
  clearError();
  clearInfo();
}

// ── Storage ──────────────────────────────────────────────────────
function saveTranscript() {
  try { localStorage.setItem('clase_transcript', finalTranscript); } catch (e) {}
}

function loadSavedTranscript() {
  try {
    const saved = localStorage.getItem('clase_transcript');
    if (saved && saved.trim()) {
      finalTranscript = saved;
      updateTranscriptDisplay('');
      updateWordCount();
      showInfo('Se recupero la transcripcion anterior. Puedes continuar o limpiar para empezar de nuevo.');
    }
  } catch (e) {}
}

// ── Timer ────────────────────────────────────────────────────────
function updateTimer() {
  const elapsed = startTime
    ? Math.floor((Date.now() - startTime) / 1000)
    : Math.floor(elapsedTime / 1000);
  const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
  const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  document.getElementById('timer').textContent = `${h}:${m}:${s}`;
}

// ── UI ────────────────────────────────────────────────────────────
function setUIState(state) {
  const dot        = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const btnStart   = document.getElementById('btn-start');
  const btnStop    = document.getElementById('btn-stop');
  const btnPause   = document.getElementById('btn-pause');
  const liveBadge  = document.getElementById('live-badge');

  dot.className = 'status-dot';
  liveBadge.classList.remove('active');

  if (state === 'recording') {
    dot.classList.add('recording');
    statusText.textContent  = 'Grabando...';
    statusText.className    = 'status-text recording';
    btnStart.disabled       = true;
    btnStop.disabled        = false;
    btnPause.disabled       = false;
    btnPause.textContent    = 'Pausar';
    liveBadge.classList.add('active');
  } else if (state === 'paused') {
    dot.classList.add('paused');
    statusText.textContent  = 'En pausa';
    statusText.className    = 'status-text paused';
    btnStart.disabled       = true;
    btnStop.disabled        = false;
    btnPause.disabled       = false;
    btnPause.textContent    = 'Reanudar';
  } else {
    statusText.textContent  = 'Listo para grabar';
    statusText.className    = 'status-text';
    btnStart.disabled       = false;
    btnStop.disabled        = true;
    btnPause.disabled       = true;
    btnPause.textContent    = 'Pausar';
  }
}

function updateTranscriptDisplay(interim) {
  document.getElementById('final-text').textContent   = finalTranscript;
  document.getElementById('interim-text').textContent = interim || '';
  const box = document.getElementById('transcript-box');
  box.scrollTop = box.scrollHeight;
}

function updateWordCount() {
  wordCount = finalTranscript.trim() ? finalTranscript.trim().split(/\s+/).length : 0;
  document.getElementById('word-count').textContent = wordCount.toLocaleString() + ' palabras';
}

function showError(msg) {
  const el = document.getElementById('error-alert');
  el.textContent = msg;
  el.classList.add('show');
}

function clearError() {
  document.getElementById('error-alert').classList.remove('show');
}

function showInfo(msg) {
  const el = document.getElementById('info-alert');
  el.textContent = msg;
  el.classList.add('show');
}

function clearInfo() {
  document.getElementById('info-alert').classList.remove('show');
}

// ── Actions ───────────────────────────────────────────────────────
function copyTranscript() {
  if (!finalTranscript.trim()) { showError('No hay nada que copiar.'); return; }
  navigator.clipboard.writeText(finalTranscript)
    .then(() => showInfo('Transcripcion copiada.'));
}

function copyResult() {
  const content = document.getElementById('result-content').textContent;
  navigator.clipboard.writeText(content)
    .then(() => showInfo('Repaso copiado.'));
}

function downloadTranscript() {
  if (!finalTranscript.trim()) { showError('No hay transcripcion para descargar.'); return; }
  const blob = new Blob([finalTranscript], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'transcripcion_clase_' + new Date().toLocaleDateString('es-MX').replace(/\//g, '-') + '.txt';
  a.click();
  URL.revokeObjectURL(url);
}

// ── AI Summary ────────────────────────────────────────────────────
async function generateSummary() {
  const transcript = finalTranscript.trim();
  if (!transcript) { showError('No hay transcripcion. Graba una clase primero.'); return; }

  const apiKey = document.getElementById('api-key').value.trim();
  if (!apiKey) { showError('Ingresa tu API Key de Anthropic para generar el repaso.'); return; }

  const resultSection = document.getElementById('result-section');
  const resultContent = document.getElementById('result-content');
  resultSection.classList.add('visible');
  resultContent.innerHTML =
    '<div class="loading-dots"><span></span><span></span><span></span>' +
    '<span class="loading-text">Analizando tu clase...</span></div>';

  const prompt =
`Eres un tutor academico experto. Analiza la siguiente transcripcion de clase y crea un material de estudio completo.

TRANSCRIPCION:
---
${transcript.substring(0, 15000)}
---

Genera lo siguiente en espanol:

## TEMA PRINCIPAL DE LA CLASE
(1-2 oraciones)

## CONCEPTOS CLAVE
(Lista con descripcion breve de cada concepto)

## RESUMEN DETALLADO
(Resumen completo manteniendo la estructura logica de la clase)

## EXPLICACIONES IMPORTANTES
(Desarrolla las explicaciones mas importantes con mas detalle)

## PREGUNTAS DE REPASO
(5-8 preguntas para autoevaluarse)

## PUNTOS A RECORDAR
(Lista de los puntos mas importantes)`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 4000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Error ' + response.status);
    }

    const data = await response.json();
    resultContent.textContent = data.content?.[0]?.text || 'No se pudo generar el repaso.';
    showInfo('Repaso generado exitosamente.');

  } catch (err) {
    resultContent.innerHTML = '';
    resultSection.classList.remove('visible');
    if (err.message.includes('401') || err.message.includes('auth')) {
      showError('API Key invalida. Verifica en console.anthropic.com');
    } else if (err.message.includes('network') || err.message.includes('fetch')) {
      showError('Error de conexion. Verifica tu internet.');
    } else {
      showError('Error: ' + err.message);
    }
  }
}
