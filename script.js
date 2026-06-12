// --- State Variables ---
const CONFIG = {
    STORAGE_KEYS: {
        SEEN_WORDS: 'tabooseySeenWords',
        AI_DECK: 'tabooseyAIDeck' 
    }
};

let currentTeam = 1;
let totalScores = { 1: 0, 2: 0 };
let currentRoundScore = 0;
let currentRoundWords = []; 
let roundCounter = 1;
let historyLog = [];

let timeLimit = 90;
let totalRounds = Infinity;
let infiniteRounds = true;
let currentCategory = "All";
let customCategoryText = "";
let timeLeft = 0;
let timerInterval = null;
let isPaused = false;
let isMuted = false;
let lastAdRefreshTime = 0;

// Tracking actual state to fix category sync bug
let activeDeckCategory = "All";
let activeCustomText = "";

// --- Deck Tracking Variables (Loaded from LocalStorage) ---
let seenWords = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.SEEN_WORDS)) || []; 
let aiDeck = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AI_DECK)) || []; 
let unseenWords = [];
let currentCard = null;

// --- Clean up legacy string-based history if it exists ---
if (localStorage.getItem('tabooseyAIHistory')) {
    localStorage.removeItem('tabooseyAIHistory');
}

// --- AI Configuration ---
let useAI = false;
let isFetching = false;
let isBackgroundFetching = false;
let aiBuffer = [];
let preFetchDebounce = null;
let fetchEpoch = 0;

// --- Solo Mode State ---
let gameMode = 'teams'; // 'teams' | 'solo'
let soloTotalScore = 0;
let soloRoundScore = 0;
let soloHistoryLog = [];          // [{ round, score, cards: [{word, taboo, clues, guesses, status}] }]
let soloPlayedCards = [];          // current round's completed cards
let soloCurrentEntries = [];       // {type:'clue'|'guess'|'feedback', text, html?}
let soloCardStartTime = 0;
let soloGuessCount = 0;
let soloCluePaceTimer = null;
let soloAutoSkipTimer = null;      // pending "AI gives up" timer (lets the last clue breathe)
let soloAiSkipThreshold = { time: 40, guesses: 10 };
const AI_SKIP_GRACE_MS = 5000;     // wait after the final clue before the AI actually skips
let soloAiClueInFlight = false;
let soloCardResolving = false;     // true during the 1.5s pause before next card
let soloClueQueue = [];            // pending clue strings for the current card
let soloAwaitingFirstClue = false; // true while waiting for a card's opening clue
let soloRevealedWords = [];        // revealed word slots for current card (null = hidden)
let pauseOnType = localStorage.getItem('tabooseyPauseOnType') !== 'false'; // default true
let typingPaused = false;          // true while player has text in the guess field
let speakClues = localStorage.getItem('tabooseySpeakClues') === 'true'; // read clues aloud (default off)
let clueRate = parseFloat(localStorage.getItem('tabooseyClueRate')) || 1; // TTS speech rate
let ttsSpeaking = false;           // true while a clue is being read aloud
let interimSubmitTimer = null;     // debounce: auto-submit stable interim transcript
let lastVoiceSubmit = '';          // last text submitted via voice (for dedup)
let lastVoiceSubmitAt = 0;         // timestamp of last voice submission
const VOICE_DEDUP_MS = 2500;       // ignore duplicate voice text within this window
let lastSpokenClue = '';           // normalized words of the clue currently/just spoken
let ttsEndedAt = 0;                // timestamp (ms) when the last spoken clue finished
const TTS_ECHO_GRACE_MS = 1500;    // window after speech where echo results may still arrive
let preferredVoice = null;         // chosen TTS voice (natural female, en) — set once voices load

// --- Voice input: speak guesses in Solo vs AI (continuous listen-toggle) ---
// Dual-path: native Capacitor plugin on Android, Web Speech API in the browser/PWA.
const voiceInput = {
    mode: null,         // 'native' | 'web' | null (set once at startup)
    listening: false,
    rec: null,          // web SpeechRecognition instance
    lastPartial: '',    // native: latest partial transcript for the current utterance
    nativeBound: false, // native: listeners registered once

    async toggle() {
        if (this.listening) this.stop();
        else await this.start();
    },

    async start() {
        if (this.listening || !this.mode) return;
        try {
            if (this.mode === 'web') this._startWeb();
            else await this._startNative();
        } catch (e) {
            this._setListening(false);
            return;
        }
        this._setListening(true);
    },

    stop() {
        this._setListening(false);
        if (this.mode === 'web') {
            if (this.rec) { try { this.rec.stop(); } catch (e) {} }
        } else {
            const SR = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SpeechRecognition;
            if (SR) { try { SR.stop(); } catch (e) {} }
        }
        showInterim('');
    },

    _setListening(state) {
        this.listening = state;
        if (ui.soloMicBtn) ui.soloMicBtn.classList.toggle('listening', state);
    },

    _notify(msg) {
        if (typeof appendToFeed === 'function') appendToFeed({ type: 'feedback', text: msg });
    },

    // ----- Web Speech API path -----
    _startWeb() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new SR();
        rec.lang = 'en-US';
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const transcript = e.results[i][0].transcript;
                if (e.results[i].isFinal) handleVoiceGuess(transcript);
                else interim += transcript;
            }
            if (interim) showInterim(interim);
        };
        rec.onerror = (e) => {
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                this._notify('Microphone permission needed for voice mode.');
                this.stop();
            }
            // 'no-speech' / 'aborted' are transient — onend handles restart
        };
        rec.onend = () => {
            // Continuous listening: restart until the user toggles off.
            if (this.listening) { try { rec.start(); } catch (e) {} }
        };
        this.rec = rec;
        rec.start();
    },

    // ----- Capacitor native plugin path (@capacitor-community/speech-recognition) -----
    async _startNative() {
        const SR = Capacitor.Plugins.SpeechRecognition;
        const perm = await SR.requestPermissions();
        if (perm && perm.speechRecognition && perm.speechRecognition !== 'granted') {
            this._notify('Microphone permission needed for voice mode.');
            throw new Error('permission denied');
        }
        if (!this.nativeBound) {
            SR.addListener('partialResults', (data) => {
                const m = data && data.matches && data.matches[0];
                if (m) { this.lastPartial = m; showInterim(m); }
            });
            // Android's recognizer stops after each pause → submit that utterance and restart.
            SR.addListener('listeningState', (data) => {
                if (data && data.status === 'stopped' && this.listening) {
                    const said = this.lastPartial;
                    this.lastPartial = '';
                    if (said) handleVoiceGuess(said);
                    this._restartNative();
                }
            });
            this.nativeBound = true;
        }
        await SR.start({ language: 'en-US', partialResults: true, popup: false });
    },

    async _restartNative() {
        const SR = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SpeechRecognition;
        if (!SR || !this.listening) return;
        try { await SR.start({ language: 'en-US', partialResults: true, popup: false }); }
        catch (e) { /* device may need a beat between sessions; ignore */ }
    }
};

function detectVoiceMode() {
    const isNative = window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform();
    if (isNative) {
        // On native, ONLY trust the plugin — the WebView's Web Speech API does not work.
        return (Capacitor.Plugins && Capacitor.Plugins.SpeechRecognition) ? 'native' : null;
    }
    if (window.SpeechRecognition || window.webkitSpeechRecognition) return 'web';
    return null;
}

function handleVoiceGuess(text) {
    const val = stripClueWords(text);
    if (!val) return;
    if (soloCardResolving || isPaused || !currentCard) return;
    submitVoiceGuess(val);
}

// Single entry point for all voice submissions — enforces dedup so the debounce timer
// and the recognizer's final-result event can't both submit the same phrase.
function submitVoiceGuess(val) {
    const now = Date.now();
    const norm = val.trim().toLowerCase();
    if (!norm) return;
    if (norm === lastVoiceSubmit && now - lastVoiceSubmitAt < VOICE_DEDUP_MS) return;
    lastVoiceSubmit = norm;
    lastVoiceSubmitAt = now;
    ui.soloGuessInput.value = '';
    clearInterimSubmitTimer();
    submitSoloGuess(val);
}

// Remove any words that belong to the clue currently/just spoken aloud, so the mic
// hearing the clue never shows up (in the box or as a guess). Real guess words remain.
function stripClueWords(text) {
    const raw = (text || '').trim();
    if (!raw) return '';
    const echoActive = ttsSpeaking || (Date.now() - ttsEndedAt <= TTS_ECHO_GRACE_MS);
    if (!echoActive || !lastSpokenClue) return raw;
    const clueSet = new Set(lastSpokenClue.split(' '));
    return raw.split(/\s+/)
        .filter(w => {
            const norm = w.toLowerCase().replace(/[^a-z0-9]/g, '');
            return norm && !clueSet.has(norm);
        })
        .join(' ')
        .trim();
}

function showInterim(text) {
    // Setting .value directly does NOT fire the 'input' event, so it won't trip typingPaused.
    // Strip spoken-clue words so the echo never appears in the box, even mid-speech.
    if (!ui.soloGuessInput) return;
    const cleaned = stripClueWords(text);
    ui.soloGuessInput.value = cleaned;

    // Auto-submit if the cleaned transcript stays unchanged for 1 s (handles the case where
    // the recognizer never fires a final result while TTS audio is in the room).
    if (interimSubmitTimer) clearTimeout(interimSubmitTimer);
    if (!cleaned) return;
    interimSubmitTimer = setTimeout(() => {
        interimSubmitTimer = null;
        const current = (ui.soloGuessInput.value || '').trim();
        if (current && !soloCardResolving && !isPaused && currentCard) {
            submitVoiceGuess(current);
        }
    }, 1000);
}

function clearInterimSubmitTimer() {
    if (interimSubmitTimer) { clearTimeout(interimSubmitTimer); interimSubmitTimer = null; }
}

// --- Text-to-speech: read clues aloud (Solo vs AI) ---
// Produce a spoken-safe version of a clue: taboo/target words become "blank" (length-agnostic).
function clueToSpeech(clueText, card) {
    const forbidden = buildForbiddenStems(card);
    return clueText.split(/(\W+)/).map(part => {
        if (!part) return '';
        if (/^\W+$/.test(part)) return part;
        const clean = part.toLowerCase().replace(/[^a-z]/g, '');
        if (clean.length >= 2 && forbidden.has(stemWord(clean))) return 'blank';
        return part;
    }).join('');
}

// Choose a natural-sounding female English voice. Voices load asynchronously, so this is
// run on startup and again on the 'voiceschanged' event.
function pickPreferredVoice() {
    if (!window.speechSynthesis) return;
    const voices = speechSynthesis.getVoices();
    if (!voices || !voices.length) return;
    const en = voices.filter(v => /^en(-|_|$)/i.test(v.lang));
    const pool = en.length ? en : voices;
    // Preference order: high-quality natural voices first, then known female names.
    // Android WebView exposes Google TTS voices; iOS/macOS has Siri-quality voices.
    const prefs = [
        // Google TTS (Android WebView — highest quality available on-device)
        'google us english',
        // Google generic fallback (Android)
        v => v.name.toLowerCase().startsWith('google') && /^en/i.test(v.lang),
        // Microsoft neural voices (Edge/desktop)
        'microsoft aria', 'microsoft jenny', 'microsoft michelle', 'microsoft natasha',
        // Apple natural voices (macOS/iOS)
        'samantha', 'karen', 'moira', 'tessa', 'fiona', 'serena',
        // Microsoft legacy female
        'microsoft zira',
        // Generic quality markers
        'natural', 'enhanced', 'premium', 'female'
    ];
    for (const key of prefs) {
        const match = typeof key === 'function'
            ? pool.find(key)
            : pool.find(v => v.name.toLowerCase().includes(key));
        if (match) { preferredVoice = match; return; }
    }
    preferredVoice = pool[0] || null;
}

function speakClue(text) {
    if (!speakClues || !window.speechSynthesis || !text) return;
    try {
        speechSynthesis.cancel();
        ttsSpeaking = true;
        // Remember the spoken words so the mic can filter out the clue echoing back.
        lastSpokenClue = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const u = new SpeechSynthesisUtterance(text);
        if (!preferredVoice) pickPreferredVoice();
        if (preferredVoice) { u.voice = preferredVoice; u.lang = preferredVoice.lang; }
        else { u.lang = 'en-US'; }
        u.rate = 1.0;
        u.pitch = 1.0;  // neutral pitch — let the voice's own quality shine
        const done = () => { ttsSpeaking = false; ttsEndedAt = Date.now(); };
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
    } catch (e) {
        ttsSpeaking = false;
        ttsEndedAt = Date.now();
    }
}

function stopSpeaking() {
    ttsSpeaking = false;
    ttsEndedAt = Date.now(); // keep the echo grace window after an interrupted clue
    if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (e) {} }
}

function stemWord(w) {
    w = w.toLowerCase().trim();
    if (w.length < 4) return w;
    if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
    // Sibilant clusters add '-es' as the plural suffix → strip both e and s
    if ((w.endsWith('ches') || w.endsWith('shes') || w.endsWith('xes') ||
         w.endsWith('zes') || w.endsWith('sses')) && w.length > 5) return w.slice(0, -2);
    // '-oes' plurals (tomato→tomatoes, echo→echoes)
    if (w.endsWith('oes') && w.length > 4) return w.slice(0, -2);
    // '-ses' (buses→bus, lenses→lens, classes→class)
    if (w.endsWith('ses') && w.length > 4) return w.slice(0, -2);
    // Everything else: strip just 's' — handles headphones→headphone, games→game, etc.
    if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
}

// --- Sound Engine (Web Audio API) ---
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function playSound(type) {
    if (isMuted) return;
    if (type === 'tick' && voiceInput.listening) return;

    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t = audioCtx.currentTime;

    const playChime = (freq, startTime, duration) => {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        osc.type = 'sine'; 
        osc.frequency.setValueAtTime(freq, startTime);
        
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(0.25, startTime + 0.02); 
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration); 
        
        osc.start(startTime);
        osc.stop(startTime + duration);
    };

    if (type === 'correct') {
        playChime(523.25, t, 0.5); 
        playChime(659.25, t + 0.1, 0.7); 
    } else if (type === 'taboo') {
        playChime(622.25, t, 0.5);
        playChime(523.25, t + 0.15, 0.7);
    } else if (type === 'skip') {
        playChime(783.99, t, 0.4);
    } else if (type === 'tick') {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, t);
        
        gainNode.gain.setValueAtTime(0, t);
        gainNode.gain.linearRampToValueAtTime(0.05, t + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        
        osc.start(t);
        osc.stop(t + 0.1);
    }
}

// --- DOM Elements ---
const screens = {
    setup: document.getElementById('setup-screen'),
    turn: document.getElementById('turn-screen'),
    game: document.getElementById('game-screen'),
    gameover: document.getElementById('gameover-screen'),
    soloGame: document.getElementById('solo-game-screen'),
    soloGameover: document.getElementById('solo-gameover-screen')
};

const ui = {
    muteBtn: document.getElementById('global-mute-btn'),
    homeBtn: document.getElementById('home-btn'),

    timeInputSetup: document.getElementById('time-limit'),
    catInputSetup: document.getElementById('setup-category'),
    customCatGroupSetup: document.getElementById('custom-cat-group-setup'),
    customCatInputSetup: document.getElementById('custom-cat-input-setup'),
    errorMsgSetup: document.getElementById('error-msg-setup'),
    
    timeInputTurn: document.getElementById('turn-time-limit'),
    catInputTurn: document.getElementById('turn-category'),
    customCatGroupTurn: document.getElementById('custom-cat-group-turn'),
    customCatInputTurn: document.getElementById('custom-cat-input-turn'),
    errorMsgTurn: document.getElementById('error-msg-turn'),
    
    timerDisplay: document.getElementById('timer-display'),
    timerBar: document.getElementById('timer-bar'),
    pausedIndicator: document.getElementById('paused-indicator'),
    activeCard: document.getElementById('active-card'),
    targetWord: document.getElementById('target-word'),
    tabooWords: document.getElementById('taboo-words'),
    teamAnnouncement: document.getElementById('team-announcement'),
    t1ScoreDisplay: document.getElementById('t1-score-display'),
    t2ScoreDisplay: document.getElementById('t2-score-display'),
    currentRoundScore: document.getElementById('current-round-score'),
    historyList: document.getElementById('score-history-list'),
    
    loadingOverlay: document.getElementById('loading-overlay'),
    cardContent: document.getElementById('card-content'),
    
    pauseBtn: document.getElementById('pause-btn'),
    endRoundBtn: document.getElementById('end-round-btn'),
    gameButtons: document.querySelectorAll('.controls button'),

    rulesModal: document.getElementById('rules-modal'),
    detailsModal: document.getElementById('round-details-modal'),
    customAlertModal: document.getElementById('custom-alert-modal'),
    customAlertTitle: document.getElementById('custom-alert-title'),
    customAlertMsg: document.getElementById('custom-alert-message'),
    customAlertCancel: document.getElementById('custom-alert-cancel'),
    customAlertConfirm: document.getElementById('custom-alert-confirm'),

    openRulesLinks: document.querySelectorAll('.how-to-play-link'),
    closeRulesBtn: document.getElementById('close-rules-btn'),
    closeDetailsBtn: document.getElementById('close-details-btn'),
    clearMemoryLink: document.getElementById('clear-memory-link'),

    roundsSelectSetup: document.getElementById('rounds-limit'),
    roundsSelectTurn: document.getElementById('rounds-limit-turn'),

    goWinnerText: document.getElementById('gameover-winner-text'),
    goT1Score: document.getElementById('go-t1-score'),
    goT2Score: document.getElementById('go-t2-score'),
    goCategory: document.getElementById('go-category'),
    goHistoryList: document.getElementById('go-history-list'),
    playAgainBtn: document.getElementById('play-again-btn'),
    newGameBtn: document.getElementById('new-game-btn'),

    // Solo mode
    startSoloBtn: document.getElementById('start-solo-btn'),
    soloTimerDisplay: document.getElementById('solo-timer-display'),
    soloTimerBar: document.getElementById('solo-timer-bar'),
    soloPausedIndicator: document.getElementById('solo-paused-indicator'),
    soloRoundScoreEl: document.getElementById('solo-round-score'),
    soloPlayedStrip: document.getElementById('solo-played-strip'),
    soloCardMeta: document.getElementById('solo-card-meta'),
    soloClueFeed: document.getElementById('solo-clue-feed'),
    soloThinking: document.getElementById('solo-thinking'),
    soloGuessForm: document.getElementById('solo-guess-form'),
    soloGuessInput: document.getElementById('solo-guess-input'),
    soloGuessBtn: document.getElementById('solo-guess-btn'),
    soloPauseBtn: document.getElementById('solo-pause-btn'),
    soloSkipBtn: document.getElementById('solo-skip-btn'),
    soloEndRoundBtn: document.getElementById('solo-end-round-btn'),
    soloGoSummary: document.getElementById('solo-go-summary'),
    soloGoFinalScore: document.getElementById('solo-go-final-score'),
    soloGoMeta: document.getElementById('solo-go-meta'),
    soloGoHistoryList: document.getElementById('solo-go-history-list'),
    soloPlayAgainBtn: document.getElementById('solo-play-again-btn'),
    soloNewGameBtn: document.getElementById('solo-new-game-btn'),
    soloCardModal: document.getElementById('solo-card-modal'),
    soloCardModalTitle: document.getElementById('solo-card-modal-title'),
    soloCardModalStatus: document.getElementById('solo-card-modal-status'),
    soloCardModalTaboo: document.getElementById('solo-card-modal-taboo'),
    soloCardModalTranscript: document.getElementById('solo-card-modal-transcript'),
    closeSoloCardBtn: document.getElementById('close-solo-card-btn'),
    soloTypingIndicator: document.getElementById('solo-typing-indicator'),
    pauseOnTypeCheckbox: document.getElementById('pause-on-type-checkbox'),
    soloMicBtn: document.getElementById('solo-mic-btn'),
    speakCluesCheckbox: document.getElementById('speak-clues-checkbox'),
    ttsEchoHint: document.getElementById('tts-echo-hint')
};

// Headphones tip is only relevant when clues are spoken AND the mic is listening for guesses.
function updateTtsEchoHint() {
    if (ui.ttsEchoHint) ui.ttsEchoHint.style.display = (speakClues && voiceInput.mode) ? '' : 'none';
}

function showCustomModal(title, message, isConfirm, onConfirmCallback) {
    ui.customAlertTitle.innerHTML = title;
    ui.customAlertMsg.innerText = message;
    
    const newConfirm = ui.customAlertConfirm.cloneNode(true);
    ui.customAlertConfirm.parentNode.replaceChild(newConfirm, ui.customAlertConfirm);
    ui.customAlertConfirm = newConfirm;

    const newCancel = ui.customAlertCancel.cloneNode(true);
    ui.customAlertCancel.parentNode.replaceChild(newCancel, ui.customAlertCancel);
    ui.customAlertCancel = newCancel;

    if (isConfirm) {
        ui.customAlertCancel.style.display = 'block';
        ui.customAlertConfirm.innerText = "Yes";
        ui.customAlertConfirm.className = "btn-danger";
    } else {
        ui.customAlertCancel.style.display = 'none';
        ui.customAlertConfirm.innerText = "OK";
        ui.customAlertConfirm.className = "btn-success";
    }

    ui.customAlertConfirm.addEventListener('click', () => {
        ui.customAlertModal.classList.remove('active');
        if (onConfirmCallback) onConfirmCallback();
    });

    ui.customAlertCancel.addEventListener('click', () => {
        ui.customAlertModal.classList.remove('active');
    });

    ui.customAlertModal.classList.add('active');
}

function saveHistoryToStorage() {
    localStorage.setItem(CONFIG.STORAGE_KEYS.SEEN_WORDS, JSON.stringify(seenWords));
    localStorage.setItem(CONFIG.STORAGE_KEYS.AI_DECK, JSON.stringify(aiDeck));
}

function syncCategories(source) {
    const val = source.value;
    ui.catInputSetup.value = val;
    ui.catInputTurn.value = val;
    currentCategory = val;
    
    const showCustom = (val === 'Custom');
    ui.customCatGroupSetup.style.display = showCustom ? 'flex' : 'none';
    ui.customCatGroupTurn.style.display = showCustom ? 'flex' : 'none';

    if (!showCustom) {
        ui.errorMsgSetup.style.display = 'none';
        ui.errorMsgTurn.style.display = 'none';
        ui.customCatInputSetup.classList.remove('input-error');
        ui.customCatInputTurn.classList.remove('input-error');
    }
    useAI = showCustom;
}

function syncCustomText(source) {
    const text = source.value;
    if (text.trim().toLowerCase() !== customCategoryText.trim().toLowerCase()) {
        fetchEpoch++;
        aiBuffer = [];
        isBackgroundFetching = false;
    }

    ui.customCatInputSetup.value = text;
    ui.customCatInputTurn.value = text;
    customCategoryText = text;

    if (text.trim() !== "") {
        ui.errorMsgSetup.style.display = 'none';
        ui.errorMsgTurn.style.display = 'none';
        ui.customCatInputSetup.classList.remove('input-error');
        ui.customCatInputTurn.classList.remove('input-error');

        clearTimeout(preFetchDebounce);
        preFetchDebounce = setTimeout(triggerAIPreFetch, 2000);
    }
}

function toggleMute(forceState = null) {
    isMuted = forceState !== null ? forceState : !isMuted;
    ui.muteBtn.innerHTML = isMuted ? '<i class="fas fa-volume-mute"></i>' : '<i class="fas fa-volume-up"></i>';
}

const navTabs = document.querySelectorAll('.nav-tab');
const sitePages = document.querySelectorAll('.site-page');

navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-target');
        if (!target) return; // <a> nav links navigate to a new page — let the browser handle it
        navTabs.forEach(t => t.classList.remove('active'));
        sitePages.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(target).classList.add('active');
    });
});

ui.catInputSetup.addEventListener('change', (e) => syncCategories(e.target));
ui.catInputTurn.addEventListener('change', (e) => syncCategories(e.target));
ui.customCatInputSetup.addEventListener('input', (e) => syncCustomText(e.target));
ui.customCatInputTurn.addEventListener('input', (e) => syncCustomText(e.target));

// Rounds sync
ui.roundsSelectSetup.addEventListener('change', (e) => syncRounds(e.target));
ui.roundsSelectTurn.addEventListener('change', (e) => syncRounds(e.target));


ui.muteBtn.addEventListener('click', () => toggleMute());

if (ui.homeBtn) ui.homeBtn.addEventListener('click', () => {
    showCustomModal('<i class="fas fa-home"></i> Quit Game?', "Return to the main menu? The current game's scores will be lost.", true, () => {
        showScreen('setup');
    });
});

// Nav logo: return to setup when in a game, do nothing when already on setup.
const navLogo = document.getElementById('nav-logo');
if (navLogo) {
    const handleLogoClick = () => {
        if (screens.setup.classList.contains('active')) return; // already on setup, nothing to do
        showCustomModal('<i class="fas fa-home"></i> Quit Game?', "Return to the main menu? The current game's scores will be lost.", true, () => {
            endSoloRound && typeof endSoloRound === 'function' && screens.soloGame.classList.contains('active') && endSoloRound();
            showScreen('setup');
        });
    };
    navLogo.addEventListener('click', handleLogoClick);
    navLogo.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handleLogoClick(); });
}

ui.openRulesLinks.forEach(link => {
    link.addEventListener('click', () => ui.rulesModal.classList.add('active'));
});

ui.closeRulesBtn.addEventListener('click', () => ui.rulesModal.classList.remove('active'));
ui.closeDetailsBtn.addEventListener('click', () => ui.detailsModal.classList.remove('active'));

window.addEventListener('click', (e) => {
    if (e.target === ui.rulesModal) ui.rulesModal.classList.remove('active');
    if (e.target === ui.detailsModal) ui.detailsModal.classList.remove('active');
    if (e.target === ui.customAlertModal) ui.customAlertModal.classList.remove('active');
});

if (ui.clearMemoryLink) {
    ui.clearMemoryLink.addEventListener('click', () => {
        showCustomModal('<i class="fas fa-trash-alt"></i> Reset Deck?', "Are you sure you want to reset the deck? Previously played words will appear again.", true, () => {
            localStorage.removeItem(CONFIG.STORAGE_KEYS.SEEN_WORDS);
            localStorage.removeItem(CONFIG.STORAGE_KEYS.AI_DECK);
            seenWords = [];
            aiDeck = [];
            resetDeck();
            showCustomModal('<i class="fas fa-check-circle"></i> Success', "Deck memory has been successfully wiped!", false);
        });
    });
}

document.getElementById('start-game-btn').addEventListener('click', () => {
    gameMode = 'teams';
    initializeGame();
});
document.getElementById('start-solo-btn').addEventListener('click', () => {
    gameMode = 'solo';
    initializeGame();
});
document.getElementById('start-turn-btn').addEventListener('click', () => {
    if (gameMode === 'solo') startSoloRound();
    else startTurn();
});
document.getElementById('reset-scores-btn').addEventListener('click', resetScores);
document.getElementById('correct-btn').addEventListener('click', () => handleGuess(1));
document.getElementById('skip-btn').addEventListener('click', () => handleGuess(0));
document.getElementById('taboo-btn').addEventListener('click', () => handleGuess(-1));
ui.pauseBtn.addEventListener('click', togglePause);
ui.endRoundBtn.addEventListener('click', endTurn);

document.getElementById('play-again-btn').addEventListener('click', () => {
    resetScores();
    showScreen('turn');
});
document.getElementById('new-game-btn').addEventListener('click', () => {
    showScreen('setup');
});

// Solo mode button wiring
ui.soloGuessForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = ui.soloGuessInput.value.trim();
    if (!val) return;
    submitSoloGuess(val);
});

// Pause-while-typing: freeze timer whenever text is in the guess field
ui.soloGuessInput.addEventListener('input', () => {
    if (!pauseOnType) return;
    const hasText = ui.soloGuessInput.value.length > 0;
    setTypingPaused(hasText);
});

// Checkbox wiring (initialise from stored preference)
if (ui.pauseOnTypeCheckbox) {
    ui.pauseOnTypeCheckbox.checked = pauseOnType;
    ui.pauseOnTypeCheckbox.addEventListener('change', () => {
        pauseOnType = ui.pauseOnTypeCheckbox.checked;
        localStorage.setItem('tabooseyPauseOnType', pauseOnType ? 'true' : 'false');
        if (!pauseOnType) setTypingPaused(false); // immediately unfreeze if turned off mid-game
    });
}

// Speak-clues-aloud wiring (TTS). Hide controls entirely if the browser has no speech synthesis.
if (ui.speakCluesCheckbox) {
    if (!window.speechSynthesis) {
        if (ui.speakCluesCheckbox.closest('#speak-clues-label')) ui.speakCluesCheckbox.closest('#speak-clues-label').style.display = 'none';
    } else {
        // Pick a natural female voice now and refresh when the voice list finishes loading.
        pickPreferredVoice();
        if (typeof speechSynthesis.addEventListener === 'function') {
            speechSynthesis.addEventListener('voiceschanged', pickPreferredVoice);
        } else {
            speechSynthesis.onvoiceschanged = pickPreferredVoice;
        }
        ui.speakCluesCheckbox.checked = speakClues;
        updateTtsEchoHint();

        ui.speakCluesCheckbox.addEventListener('change', () => {
            speakClues = ui.speakCluesCheckbox.checked;
            localStorage.setItem('tabooseySpeakClues', speakClues ? 'true' : 'false');
            updateTtsEchoHint();
            if (!speakClues) stopSpeaking();
        });
    }
}

// Voice mode: reveal & wire the mic button only if speech recognition is available
if (ui.soloMicBtn) {
    voiceInput.mode = detectVoiceMode();
    if (voiceInput.mode) {
        ui.soloMicBtn.style.display = '';
        ui.soloMicBtn.addEventListener('click', () => voiceInput.toggle());
    }
    updateTtsEchoHint(); // mode is now known — show the headphones tip if applicable
}
ui.soloPauseBtn.addEventListener('click', toggleSoloPause);
ui.soloSkipBtn.addEventListener('click', () => {
    if (soloCardResolving) return;
    aiSkipCard(true);
});
ui.soloEndRoundBtn.addEventListener('click', endSoloRound);
ui.soloPlayAgainBtn.addEventListener('click', () => {
    resetScores();
    showScreen('turn');
});
ui.soloNewGameBtn.addEventListener('click', () => {
    showScreen('setup');
});
ui.closeSoloCardBtn.addEventListener('click', () => ui.soloCardModal.classList.remove('active'));
ui.soloCardModal.addEventListener('click', (e) => {
    if (e.target === ui.soloCardModal) ui.soloCardModal.classList.remove('active');
});

function showScreen(screenName) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screenName].classList.add('active');
    // Apply solo mode class to turn-screen so its layout adapts (single-column)
    screens.turn.classList.toggle('solo-mode-active', gameMode === 'solo');
    if (ui.homeBtn) ui.homeBtn.style.display = screenName === 'turn' ? 'flex' : 'none';
}

function syncRounds(source) {
    const val = source.value;
    infiniteRounds = (val === 'inf');
    totalRounds = infiniteRounds ? Infinity : parseInt(val);
    ui.roundsSelectSetup.value = val;
    ui.roundsSelectTurn.value = val;
}

function showGameOver() {
    const s1 = totalScores[1];
    const s2 = totalScores[2];
    let winnerHTML;
    if (s1 > s2) {
        winnerHTML = '<span class="go-winner-team t1-score">&#127942; Team 1 Wins!</span>';
    } else if (s2 > s1) {
        winnerHTML = '<span class="go-winner-team t2-score">&#127942; Team 2 Wins!</span>';
    } else {
        winnerHTML = '<span class="go-winner-team">&#129309; It\'s a Tie!</span>';
    }
    ui.goWinnerText.innerHTML = winnerHTML;
    ui.goT1Score.innerText = s1;
    ui.goT2Score.innerText = s2;

    // Category label
    const catLabel = currentCategory === 'Custom'
        ? 'Custom &middot; ' + (customCategoryText || 'AI')
        : currentCategory;
    ui.goCategory.innerHTML = 'Category: <strong>' + catLabel + '</strong>';

    // History
    if (historyLog.length === 0) {
        ui.goHistoryList.innerHTML = '<li class="history-placeholder">No rounds played.</li>';
    } else {
        ui.goHistoryList.innerHTML = [...historyLog].reverse().map((log, index) => {
            const realIndex = historyLog.length - 1 - index;
            return `
            <li class="history-item">
                <span class="hg-round hist-round">Round ${log.round}</span>
                <span class="hg-t1 hist-score t1-score">${log.t1}</span>
                <span class="hg-blank hist-vs">-</span>
                <span class="hg-t2 hist-score t2-score">${log.t2}</span>
                <button class="details-btn" onclick="openRoundDetails(${realIndex})"><i class="fas fa-search"></i></button>
            </li>`;
        }).join('');
    }

    showScreen('gameover');
}

// =====================================================================
// SOLO MODE
// =====================================================================

const SOLO_PROXY_URL = "https://taboosey-proxy.robertchenmit.workers.dev";
const SOLO_CLUE_PACE_MS = 10000;
const SOLO_RESOLVE_DELAY_MS = 1600;

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function startSoloRound() {
    if (!validateInputs(ui.catInputTurn, ui.customCatInputTurn, ui.errorMsgTurn)) return;

    syncCategories(ui.catInputTurn);
    syncCustomText(ui.customCatInputTurn);

    if (currentCategory !== activeDeckCategory || customCategoryText !== activeCustomText) {
        resetDeck();
    }

    timeLimit = parseInt(ui.timeInputTurn.value) || 90;
    syncRounds(ui.roundsSelectTurn);

    if (typeof gtag !== 'undefined') {
        gtag('event', 'solo_round_start', { round: soloHistoryLog.length + 1, category: currentCategory });
    }

    timeLeft = timeLimit;
    soloRoundScore = 0;
    soloPlayedCards = [];
    soloCurrentEntries = [];
    soloGuessCount = 0;
    soloCardResolving = false;
    soloClueQueue = [];
    soloAwaitingFirstClue = false;
    isPaused = false;
    isFetching = false;
    soloAiClueInFlight = false;

    ui.soloTimerDisplay.innerText = timeLeft;
    ui.soloRoundScoreEl.innerText = soloRoundScore;
    ui.soloPauseBtn.innerText = 'Pause';
    ui.soloPauseBtn.classList.replace('btn-secondary', 'btn-warning');
    if (ui.soloPausedIndicator) ui.soloPausedIndicator.style.display = 'none';

    // Reset timer bar
    if (ui.soloTimerBar) {
        ui.soloTimerBar.style.transition = 'none';
        ui.soloTimerBar.style.width = '100%';
        ui.soloTimerBar.classList.remove('danger');
        requestAnimationFrame(() => {
            ui.soloTimerBar.style.transition = 'width 0.9s linear, background-color 0.3s';
        });
    }

    renderPlayedStrip();
    ui.soloClueFeed.innerHTML = '';
    ui.soloThinking.style.display = 'none';
    ui.soloGuessInput.value = '';

    showScreen('soloGame');
    loadNextSoloCard();

    timerInterval = setInterval(() => {
        if (!isPaused && !isFetching && !typingPaused) {
            // Freeze the clock immediately while waiting for the opening clue on AI/custom cards
            if (soloAwaitingFirstClue) return;
            timeLeft--;
            ui.soloTimerDisplay.innerText = timeLeft;
            if (ui.soloTimerBar) {
                ui.soloTimerBar.style.width = (timeLeft / timeLimit * 100) + '%';
                if (timeLeft <= 10) ui.soloTimerBar.classList.add('danger');
            }
            if (timeLeft <= 10 && timeLeft > 0) playSound('tick');
            if (timeLeft <= 0) {
                playSound('taboo');
                endSoloRound();
            }
        }
    }, 1000);
}

function clearCluePaceTimer() {
    if (soloCluePaceTimer) { clearTimeout(soloCluePaceTimer); soloCluePaceTimer = null; }
}

// Adaptive pacing: faster when clues are already queued up, slower when we must fetch.
function scheduleNextClue() {
    clearCluePaceTimer();
    if (soloAutoSkipTimer) return; // AI is about to give up — stop pacing new clues
    const n = soloClueQueue.length;
    const delay = n >= 2 ? 4000 : (n === 1 ? 8000 : 10000);
    soloCluePaceTimer = setTimeout(showNextClue, delay);
}

// Pace tick: show a queued clue if one is waiting, otherwise fetch a fresh one.
function showNextClue() {
    if (isPaused || soloCardResolving || !currentCard || soloAutoSkipTimer) return;
    if (soloClueQueue.length > 0) {
        dispatchClueFromQueue();
        scheduleNextClue();
    } else if (!soloAiClueInFlight) {
        requestAiClue({ reason: 'pace' });
    } else {
        scheduleNextClue();
    }
}

// Show exactly one clue from the queue (redacted), if the card is still active.
function dispatchClueFromQueue() {
    if (soloCardResolving || !currentCard) return;
    const clueText = soloClueQueue.shift();
    if (!clueText) return;
    const redactedHtml = redactClue(clueText, currentCard);
    appendToFeed({ type: 'clue', text: clueText, html: redactedHtml });
    speakClue(clueToSpeech(clueText, currentCard));
    soloAwaitingFirstClue = false;
    playSound('tick');
    checkAutoSkip();
}

async function loadNextSoloCard() {
    if (timeLeft <= 0) return;

    clearAutoSkipTimer();
    clearInterimSubmitTimer();
    soloCurrentEntries = [];
    soloClueQueue = [];
    soloAwaitingFirstClue = false;
    soloGuessCount = 0;
    soloCardStartTime = Date.now();
    lastVoiceSubmit = ''; lastVoiceSubmitAt = 0; // clear dedup for the fresh card
    // Randomize skip thresholds per card: 35-50s and 8-12 guesses
    soloAiSkipThreshold = {
        time: 35 + Math.floor(Math.random() * 16),
        guesses: 8 + Math.floor(Math.random() * 5)
    };
    soloCardResolving = false;
    ui.soloClueFeed.innerHTML = '';
    ui.soloGuessInput.value = '';
    setTypingPaused(false);
    ui.soloThinking.style.display = 'none';

    // Get next card from existing infrastructure (AI or built-in)
    if (useAI) {
        // Reuse the loadNextCard buffer logic — fetch if buffer empty
        fillBufferFromLocal();
        if (aiBuffer.length === 0) {
            setSoloLoadingState(true);
            if (!isBackgroundFetching) {
                try {
                    isBackgroundFetching = true;
                    const newCards = await fetchAIBatch(10);
                    if (newCards?.length) aiBuffer.push(...newCards);
                } catch (e) { console.error('Solo card fetch failed', e); }
                finally { isBackgroundFetching = false; }
            } else {
                while (isBackgroundFetching && aiBuffer.length === 0) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }
            setSoloLoadingState(false);
            if (!screens.soloGame.classList.contains('active')) return;
        }
        currentCard = aiBuffer.length > 0 ? aiBuffer.shift() : getNextDeckCard();
        maintainAIBuffer();
    } else {
        currentCard = getNextDeckCard();
    }

    if (!currentCard) {
        ui.soloCardMeta.innerHTML = '<span class="shape-hint">(no card available)</span>';
        return;
    }

    soloRevealedWords = currentCard.word.trim().split(/\s+/).map(() => null);
    renderCardShape(currentCard.word);
    ui.soloGuessInput.focus();

    // Built-in deck cards have a hand-written opening clue → show it instantly (no wait).
    const preClue = (!useAI && typeof preGeneratedClues !== 'undefined')
        ? preGeneratedClues[currentCard.word.trim().toLowerCase()]
        : null;

    if (preClue) {
        soloClueQueue.push(preClue);
        dispatchClueFromQueue();
        scheduleNextClue();
    } else {
        // AI/custom card (or no pre-gen entry): fetch the opening clue, pausing the
        // clock after 2s if it's slow to arrive.
        soloAwaitingFirstClue = true;
        requestAiClue({ reason: 'opening' });
    }
}

function setSoloLoadingState(loading) {
    isFetching = loading;
    ui.soloThinking.style.display = loading ? 'block' : 'none';
    ui.soloGuessBtn.disabled = loading;
}

function renderCardShape(target) {
    const words = target.trim().split(/\s+/);
    const hint = words.length === 1 ? '1 word' : `${words.length} word phrase`;
    const slots = words.map((w, i) => {
        const rev = soloRevealedWords[i];
        return rev != null
            ? `<span class="word-revealed">${rev}</span>`
            : `<span class="word-blank">&nbsp;</span>`;
    }).join('');
    ui.soloCardMeta.innerHTML = `${slots}<span class="shape-hint">${hint}</span>`;
}

function appendToFeed(entry) {
    soloCurrentEntries.push(entry);
    const div = document.createElement('div');
    div.className = `solo-feed-entry ${entry.type}`;
    const bubble = document.createElement('div');
    bubble.className = `solo-bubble ${entry.type}`;
    if (entry.html) {
        bubble.innerHTML = entry.html;
    } else {
        bubble.innerText = entry.text;
    }
    div.appendChild(bubble);
    ui.soloClueFeed.appendChild(div);
    ui.soloClueFeed.scrollTop = ui.soloClueFeed.scrollHeight;
}

function buildCluePrompt({ card, clueHistory, guessHistory, lastGuess, feedback, isOpening }) {
    const cluesGiven = clueHistory.length === 0
        ? '(none yet — give the OPENING clue)'
        : clueHistory.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const guesses = guessHistory.length === 0
        ? '(none yet)'
        : guessHistory.map(g => `- "${g}"`).join('\n');
    const reaction = lastGuess
        ? `\n\nThe player just guessed "${lastGuess}".${feedback ? ' System note: ' + feedback : ''} Briefly react and steer them with a NEW clue from a different angle.`
        : '';
    const wordCountHint = card.word.trim().split(/\s+/).length > 1
        ? `\n(Note: target is a ${card.word.trim().split(/\s+/).length}-word phrase.)`
        : '';

    return `You are giving spoken-style clues for a Taboo word game. Help the player guess the TARGET without ever saying the target itself or any FORBIDDEN word.

TARGET: "${card.word}"
FORBIDDEN (do not say these or any stem/variant): ${card.taboo.join(', ')}${wordCountHint}

Use varied clue strategies — rotate between:
- Synonyms / alternate definitions
- Fill-in-the-blank (e.g. The famous spy is James ___)
- Opposites (e.g. the opposite of cold)
- Category narrowing (e.g. a type of tropical fruit)
- Association chains (e.g. you find it at the beach, made of grains...)

Clues already given:
${cluesGiven}

Player's previous guesses:
${guesses}${reaction}

IMPORTANT: Reply with ONLY the plain clue sentence. No JSON, no field names, no labels like "Clue:" or "Hint:", no quotation marks, no brackets. Just the sentence.`;
}

// Clean a single clue string: strip wrapping/embedded quotes, brackets, labels.
function cleanOne(s) {
    return String(s || '')
        .replace(/^\s*[\[\("'`<«“”‘’]+/, '')   // leading [ ( " ' ` < « “ ” ‘ ’
        .replace(/[\]\)"'`>»“”‘’]+\s*$/, '')   // trailing ] ) " ' ` > » “ ” ‘ ’
        .replace(/\[([^\]]*)\]/g, '$1')          // remove remaining [..] brackets, keep content
        .replace(/^(Clue|Hint|Answer|Note)\s*:\s*/i, '') // strip label prefix
        .trim();
}

// Parse a raw AI response into an array of clean clue strings.
// Handles a single clue, JSON arrays/objects, and angle-bracket / multi-quoted lists.
function parseClues(rawText) {
    let t = (rawText || '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
    if (!t) return [];
    let clues = [];

    // JSON array or object
    if (t.startsWith('[') || t.startsWith('{')) {
        try {
            const parsed = JSON.parse(t);
            if (Array.isArray(parsed)) {
                clues = parsed.map(x => typeof x === 'string' ? x : (x.clue || x.hint || x.text || x.message || ''));
            } else {
                const v = parsed.clue || parsed.hint || parsed.text || parsed.message;
                if (Array.isArray(v)) clues = v;
                else if (v) clues = [v];
            }
        } catch (e) { /* fall through to text handling */ }
    }

    // Multiple quoted segments (e.g. <"c1", "c2", ...>) → treat as a list
    if (clues.length === 0) {
        const segs = [...t.matchAll(/"([^"]{3,})"/g)].map(m => m[1]);
        if (segs.length >= 2) clues = segs;
    }

    // Single clue fallback
    if (clues.length === 0) clues = [t];

    return clues.map(cleanOne).filter(Boolean);
}

async function requestAiClue({ reason, lastGuess, feedback } = {}) {
    if (soloAiClueInFlight || soloCardResolving || !currentCard) return;
    // Snapshot the card reference NOW before any awaits — prevents stale-clue bug
    // where the async response arrives after the card has already changed.
    const cardSnapshot = currentCard;
    soloAiClueInFlight = true;
    ui.soloThinking.style.display = 'block';

    const clueHistory = soloCurrentEntries.filter(e => e.type === 'clue').map(e => e.text);
    const guessHistory = soloCurrentEntries.filter(e => e.type === 'guess').map(e => e.text);

    const prompt = buildCluePrompt({
        card: cardSnapshot,
        clueHistory,
        guessHistory,
        lastGuess,
        feedback,
        isOpening: reason === 'opening'
    });

    try {
        const resp = await fetch(SOLO_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });
        if (!resp.ok) throw new Error('proxy ' + resp.status);
        const data = await resp.json();

        const clues = parseClues(data.text);

        // Only act if the card hasn't changed since we made the request and the AI
        // hasn't already decided to give up on this card.
        if (clues.length && !soloCardResolving && !soloAutoSkipTimer && currentCard === cardSnapshot) {
            soloClueQueue.push(...clues);
            dispatchClueFromQueue();   // show exactly one now
        }
    } catch (e) {
        console.error('AI clue failed', e);
        if (!soloCardResolving && currentCard === cardSnapshot) {
            appendToFeed({ type: 'feedback', text: '(AI hiccupped — keep guessing or wait for the next clue)' });
            soloAwaitingFirstClue = false;
        }
    } finally {
        soloAiClueInFlight = false;
        ui.soloThinking.style.display = 'none';
        // Re-arm the pacing timer (adapts to however many clues are now queued)
        if (!soloCardResolving && currentCard === cardSnapshot) scheduleNextClue();
    }
}

// Build the set of stemmed words (target + taboo) that must never be revealed in a clue.
function buildForbiddenStems(card) {
    const forbidden = new Set();
    const addStem = (w) => {
        const cleaned = String(w).toLowerCase().replace(/[^a-z]/g, '');
        if (cleaned.length >= 2) forbidden.add(stemWord(cleaned));
    };
    addStem(card.word);
    card.word.split(/\s+/).forEach(addStem);
    card.taboo.forEach(t => {
        addStem(t);
        t.split(/\s+/).forEach(addStem);
    });
    return forbidden;
}

function redactClue(clueText, card) {
    const forbidden = buildForbiddenStems(card);

    // Tokenize preserving whitespace and punctuation
    return clueText.split(/(\W+)/).map(part => {
        if (!part) return '';
        if (/^\W+$/.test(part)) return escapeHtml(part);
        const clean = part.toLowerCase().replace(/[^a-z]/g, '');
        if (clean.length >= 2 && forbidden.has(stemWord(clean))) {
            // Fixed-width pill so the redaction never reveals the hidden word's length.
            return `<span class="redacted-taboo" title="redacted taboo word">█████</span>`;
        }
        return escapeHtml(part);
    }).join('');
}

function evaluateGuess(rawGuess, target) {
    const guess = rawGuess.trim().toLowerCase();
    const targetLow = target.trim().toLowerCase();
    if (!guess) return { correct: false, revealPositions: [] };

    // EXACT MATCH (also strip non-alphanum for tolerance)
    const normalize = s => s.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (normalize(guess) === normalize(targetLow)) return { correct: true, revealPositions: [] };

    const guessWords = guess.split(/\s+/);
    const targetWords = targetLow.split(/\s+/);
    const n = targetWords.length;

    // If the guess CONTAINS the full target as a contiguous run of words, accept it.
    // e.g. target "tick" ⊂ "tick tock"; target "ice cream" ⊂ "an ice cream cone"
    if (guessWords.length > n) {
        for (let start = 0; start + n <= guessWords.length; start++) {
            let all = true;
            for (let k = 0; k < n; k++) {
                if (stemWord(guessWords[start + k]) !== stemWord(targetWords[k])) { all = false; break; }
            }
            if (all) return { correct: true, revealPositions: [] };
        }
    }

    // Positions where the guess word is an exact surface match for that target slot.
    const exactReveal = guessWords.length === targetWords.length
        ? guessWords.reduce((acc, g, i) => { if (g === targetWords[i]) acc.push(i); return acc; }, [])
        : [];

    // SAME WORD COUNT
    if (guessWords.length === n) {
        const matches = guessWords.map((g, i) => stemWord(g) === stemWord(targetWords[i]));

        // ALL words stem-match but the surface text differs → inflection issue.
        if (matches.every(m => m)) {
            for (let i = 0; i < guessWords.length; i++) {
                if (guessWords[i] !== targetWords[i]) {
                    const hint = variationHint(guessWords[i], targetWords[i]);
                    const posNote = n > 1 ? ` — word #${i + 1} of ${n}` : '';
                    return { correct: false, feedback: `Right idea — try the ${hint} of your guess${posNote}.`, revealPositions: exactReveal };
                }
            }
            return { correct: true, revealPositions: [] };
        }

        // SOME words match positionally → name the correct ones.
        if (matches.some(m => m)) {
            const correctWords = guessWords.filter((g, i) => matches[i]);
            const named = correctWords.map(w => `"${w}"`).join(' and ');
            const verb = correctWords.length > 1 ? 'are' : 'is';
            return { correct: false, feedback: `${named} ${verb} correct — keep working on the rest.`, revealPositions: exactReveal };
        }

        // NONE match positionally, but a word matches somewhere else → wrong spot.
        for (let gi = 0; gi < guessWords.length; gi++) {
            const gStem = stemWord(guessWords[gi]);
            for (let ti = 0; ti < targetWords.length; ti++) {
                if (gStem === stemWord(targetWords[ti])) {
                    return { correct: false, feedback: `"${guessWords[gi]}" is in there, but in a different spot.`, revealPositions: exactReveal };
                }
            }
        }

        return { correct: false, revealPositions: [] };
    }

    // WORD COUNT MISMATCH — find any guess word that stem-matches any target word.
    for (let ti = 0; ti < targetWords.length; ti++) {
        const tStem = stemWord(targetWords[ti]);
        for (let gi = 0; gi < guessWords.length; gi++) {
            const gw = guessWords[gi];
            if (stemWord(gw) === tStem) {
                // Reveal the slot if it's also an exact surface match.
                const revealPos = (gw === targetWords[ti]) ? [ti] : [];
                if (n > 1) {
                    return { correct: false, feedback: `"${gw}" is correct — the answer has ${n} words.`, revealPositions: revealPos };
                }
                return { correct: false, feedback: `Right idea, but it's just 1 word.`, revealPositions: [] };
            }
        }
    }

    // No stem overlap at all — let the AI respond, no scripted feedback.
    return { correct: false, revealPositions: [] };
}

// Returns a noun phrase describing how to transform the guess word into the target word.
function variationHint(guessWord, targetWord) {
    const g = guessWord, t = targetWord;
    const endsAny = (s, arr) => arr.some(suf => s.endsWith(suf));
    // Plural / singular
    if (endsAny(t, ['s', 'es', 'ies']) && !endsAny(g, ['s']) && !g.endsWith('ss')) return 'plural version';
    if (endsAny(g, ['s', 'es', 'ies']) && !endsAny(t, ['s']) && !t.endsWith('ss')) return 'singular version';
    // Gerund
    if (t.endsWith('ing') && !g.endsWith('ing')) return 'gerund (-ing) version';
    if (g.endsWith('ing') && !t.endsWith('ing')) return 'base form';
    // Past tense
    if (t.endsWith('ed') && !g.endsWith('ed')) return 'past-tense (-ed) version';
    if (g.endsWith('ed') && !t.endsWith('ed')) return 'base form';
    // Superlative / comparative
    if (t.endsWith('est') && !g.endsWith('est')) return 'superlative (-est) version';
    if (g.endsWith('est') && !t.endsWith('est')) return 'base form';
    if (t.endsWith('er') && !g.endsWith('er')) return 'comparative (-er) version';
    if (g.endsWith('er') && !t.endsWith('er')) return 'base form';
    // Adverb
    if (t.endsWith('ly') && !g.endsWith('ly')) return 'adverb (-ly) version';
    if (g.endsWith('ly') && !t.endsWith('ly')) return 'base form';
    return 'correct form';
}

function submitSoloGuess(rawGuess) {
    if (soloCardResolving || isPaused || !currentCard) return;

    // "skip" is a command, not a guess — skip the card via the normal skip path.
    if (rawGuess.trim().toLowerCase() === 'skip') {
        ui.soloGuessInput.value = '';
        setTypingPaused(false);
        aiSkipCard(true);
        return;
    }

    soloGuessCount++;
    appendToFeed({ type: 'guess', text: rawGuess });

    const result = evaluateGuess(rawGuess, currentCard.word);

    if (result.correct) {
        ui.soloGuessInput.value = '';
        setTypingPaused(false);
        handleSoloCorrect();
        return;
    }

    // Fill in any word slots the player's guess exactly matched.
    if (result.revealPositions && result.revealPositions.length > 0) {
        const targetWords = currentCard.word.trim().split(/\s+/);
        result.revealPositions.forEach(pos => {
            if (soloRevealedWords[pos] == null) soloRevealedWords[pos] = targetWords[pos];
        });
        renderCardShape(currentCard.word);
    }

    if (result.feedback) {
        appendToFeed({ type: 'feedback', text: result.feedback });
    }

    ui.soloGuessInput.value = '';
    setTypingPaused(false);
    ui.soloGuessInput.focus();

    // Drop any generic queued clues so the next one reacts to THIS guess, then fetch it.
    soloClueQueue = [];
    requestAiClue({ reason: 'guess', lastGuess: rawGuess, feedback: result.feedback });
    scheduleNextClue();
}

function handleSoloCorrect() {
    if (soloCardResolving) return;
    soloCardResolving = true;
    soloClueQueue = [];
    soloAwaitingFirstClue = false;
    clearCluePaceTimer();
    clearAutoSkipTimer();
    clearInterimSubmitTimer();
    stopSpeaking();
    soloRoundScore++;
    ui.soloRoundScoreEl.innerText = soloRoundScore;
    playSound('correct');
    appendToFeed({ type: 'feedback', text: `✓ Correct! The word was "${currentCard.word}"` });

    const completed = {
        word: currentCard.word,
        taboo: [...currentCard.taboo],
        entries: [...soloCurrentEntries],
        status: 'correct'
    };
    soloPlayedCards.push(completed);
    seenWords.push(currentCard);
    saveHistoryToStorage();
    renderPlayedStrip();

    setTimeout(() => {
        if (screens.soloGame.classList.contains('active') && timeLeft > 0) {
            loadNextSoloCard();
        }
    }, SOLO_RESOLVE_DELAY_MS);
}

function aiSkipCard(userInitiated) {
    if (soloCardResolving || !currentCard) return;
    soloCardResolving = true;
    soloClueQueue = [];
    soloAwaitingFirstClue = false;
    setTypingPaused(false);
    clearCluePaceTimer();
    clearAutoSkipTimer();
    clearInterimSubmitTimer();
    stopSpeaking();
    playSound('skip');
    const verb = userInitiated ? 'You skipped' : 'AI gave up';
    appendToFeed({ type: 'feedback', text: `${verb} — the word was "${currentCard.word}"` });

    const completed = {
        word: currentCard.word,
        taboo: [...currentCard.taboo],
        entries: [...soloCurrentEntries],
        status: 'skipped'
    };
    soloPlayedCards.push(completed);
    seenWords.push(currentCard);
    saveHistoryToStorage();
    renderPlayedStrip();

    setTimeout(() => {
        if (screens.soloGame.classList.contains('active') && timeLeft > 0) {
            loadNextSoloCard();
        }
    }, SOLO_RESOLVE_DELAY_MS);
}

function checkAutoSkip() {
    if (soloCardResolving || !currentCard || soloAutoSkipTimer) return;
    const elapsed = (Date.now() - soloCardStartTime) / 1000;
    if (elapsed >= soloAiSkipThreshold.time || soloGuessCount >= soloAiSkipThreshold.guesses) {
        // The AI is giving up — but let the player sit with this last clue for a few
        // seconds first (don't yank the card away the instant the clue appears).
        clearCluePaceTimer();        // stop queuing further clues
        soloClueQueue = [];
        soloAutoSkipTimer = setTimeout(() => {
            soloAutoSkipTimer = null;
            if (!soloCardResolving && currentCard) aiSkipCard(false);
        }, AI_SKIP_GRACE_MS);
    }
}

function clearAutoSkipTimer() {
    if (soloAutoSkipTimer) { clearTimeout(soloAutoSkipTimer); soloAutoSkipTimer = null; }
}

function setTypingPaused(state) {
    typingPaused = state;
    if (ui.soloTypingIndicator) ui.soloTypingIndicator.style.display = state ? 'inline' : 'none';
}

function toggleSoloPause() {
    isPaused = !isPaused;
    if (ui.soloPausedIndicator) ui.soloPausedIndicator.style.display = isPaused ? 'inline' : 'none';
    if (isPaused) {
        ui.soloPauseBtn.innerText = 'Resume';
        ui.soloPauseBtn.classList.replace('btn-warning', 'btn-secondary');
        clearCluePaceTimer();
        clearAutoSkipTimer(); // don't let the AI skip while the game is paused
    } else {
        ui.soloPauseBtn.innerText = 'Pause';
        ui.soloPauseBtn.classList.replace('btn-secondary', 'btn-warning');
        if (!soloCardResolving) scheduleNextClue();
        if (useAI) maintainAIBuffer();
    }
}

function renderPlayedStrip() {
    const strip = ui.soloPlayedStrip;
    strip.innerHTML = '';
    soloPlayedCards.forEach((entry, i) => {
        const chip = document.createElement('div');
        chip.className = `solo-played-chip status-${entry.status}`;
        const icon = entry.status === 'correct'
            ? '<i class="fas fa-check"></i>'
            : '<i class="fas fa-forward"></i>';
        chip.innerHTML = `${icon} ${escapeHtml(entry.word)}`;
        chip.addEventListener('click', () => openSoloCardTranscript(i));
        strip.appendChild(chip);
    });
    // Scroll newest into view
    strip.scrollLeft = strip.scrollWidth;
}

function openSoloCardTranscript(playedIndex) {
    const entry = soloPlayedCards[playedIndex];
    if (!entry) return;
    ui.soloCardModalTitle.innerHTML = `<i class="fas fa-id-card"></i> ${escapeHtml(entry.word)}`;
    const statusLabel = entry.status === 'correct'
        ? '<span style="color:#27ae60; font-weight:bold;"><i class="fas fa-check-circle"></i> Solved</span>'
        : '<span style="color:#7f8c8d;"><i class="fas fa-forward"></i> Skipped</span>';
    ui.soloCardModalStatus.innerHTML = statusLabel;
    ui.soloCardModalTaboo.innerHTML = '<strong>Taboo words:</strong> ' + entry.taboo.map(t => escapeHtml(t)).join(', ');

    const transcript = entry.entries.map(e => {
        const cls = `solo-feed-entry ${e.type}`;
        const bubbleCls = `solo-bubble ${e.type}`;
        const content = e.html || escapeHtml(e.text);
        return `<div class="${cls}"><div class="${bubbleCls}">${content}</div></div>`;
    }).join('');
    ui.soloCardModalTranscript.innerHTML = transcript || '<div class="solo-feed-entry feedback"><div class="solo-bubble feedback">(no entries)</div></div>';

    ui.soloCardModal.classList.add('active');
}

function endSoloRound() {
    clearInterval(timerInterval);
    clearCluePaceTimer();
    clearAutoSkipTimer();
    clearInterimSubmitTimer();
    voiceInput.stop();
    stopSpeaking();
    soloClueQueue = [];
    soloAwaitingFirstClue = false;
    setTypingPaused(false);

    setSoloLoadingState(false);
    soloAiClueInFlight = false;

    // If a card was in progress, mark it skipped
    if (currentCard && !soloCardResolving) {
        soloPlayedCards.push({
            word: currentCard.word,
            taboo: [...(currentCard.taboo || [])],
            entries: [...soloCurrentEntries],
            status: 'skipped'
        });
        seenWords.push(currentCard);
        saveHistoryToStorage();
    }
    currentCard = null;

    if (typeof gtag !== 'undefined') {
        gtag('event', 'solo_round_end', {
            round: soloHistoryLog.length + 1,
            score: soloRoundScore,
            cards_played: soloPlayedCards.length
        });
    }

    soloTotalScore += soloRoundScore;
    soloHistoryLog.push({
        round: soloHistoryLog.length + 1,
        score: soloRoundScore,
        cards: [...soloPlayedCards]
    });

    aiBuffer = [];
    isBackgroundFetching = false;

    // End-game check
    if (!infiniteRounds && soloHistoryLog.length >= totalRounds) {
        showSoloGameOver();
        return;
    }

    updateTurnScreenUI();
    showScreen('turn');
    triggerAIPreFetch();
}

function showSoloGameOver() {
    const total = soloTotalScore;
    const rounds = soloHistoryLog.length;
    const totalCards = soloHistoryLog.reduce((s, r) => s + r.cards.length, 0);
    const correctCards = soloHistoryLog.reduce((s, r) => s + r.cards.filter(c => c.status === 'correct').length, 0);

    let summary = `&#127942; You scored <strong>${total}</strong>!`;
    if (rounds > 0) summary += `<br><span style="font-size: 1rem; color:#666; font-weight:normal;">${correctCards} of ${totalCards} cards correct across ${rounds} round${rounds === 1 ? '' : 's'}</span>`;
    ui.soloGoSummary.innerHTML = `<span class="go-winner-team t1-score">${summary}</span>`;
    ui.soloGoFinalScore.innerText = total;

    const catLabel = currentCategory === 'Custom'
        ? 'Custom &middot; ' + (customCategoryText || 'AI')
        : currentCategory;
    ui.soloGoMeta.innerHTML = 'Category: <strong>' + catLabel + '</strong>';

    if (soloHistoryLog.length === 0) {
        ui.soloGoHistoryList.innerHTML = '<li class="history-placeholder">No rounds played.</li>';
    } else {
        ui.soloGoHistoryList.innerHTML = [...soloHistoryLog].reverse().map((log, index) => {
            const realIndex = soloHistoryLog.length - 1 - index;
            return `
            <li class="history-item">
                <span class="hg-round hist-round">Round ${log.round}</span>
                <span class="hist-score t1-score">${log.score}</span>
                <span class="hist-score">${log.cards.length}</span>
                <button class="details-btn" onclick="openSoloRoundDetails(${realIndex})"><i class="fas fa-search"></i></button>
            </li>`;
        }).join('');
    }

    showScreen('soloGameover');
}

window.openSoloRoundDetails = function(index) {
    const log = soloHistoryLog[index];
    if (!log) return;
    document.getElementById('details-round-title').innerHTML = `<i class="fas fa-list-alt"></i> Round ${log.round} — Score ${log.score}`;

    const renderCardsList = (cards) => {
        if (!cards || cards.length === 0) {
            return `<li><span style="color:#aaa; font-weight:normal;">No cards played</span></li>`;
        }
        return cards.map((c, i) => {
            const icon = c.status === 'correct'
                ? '<i class="fas fa-check-circle status-icon correct"></i>'
                : '<i class="fas fa-minus-circle status-icon skip"></i>';
            return `<li><span style="cursor:pointer; text-decoration:underline;" onclick="openSoloCardTranscriptFromHistory(${index}, ${i})">${escapeHtml(c.word)}</span> ${icon}</li>`;
        }).join('');
    };

    // Reuse the details modal but show solo info: cards list in t1 column, empty in t2
    document.getElementById('t1-details-list').innerHTML = renderCardsList(log.cards);
    document.getElementById('t2-details-list').innerHTML = '';
    // Hide the t2 column in solo
    const t2Header = document.querySelectorAll('#round-details-modal .details-team')[1];
    if (t2Header) t2Header.style.display = gameMode === 'solo' ? 'none' : '';
    const t1Header = document.querySelectorAll('#round-details-modal .details-team')[0];
    if (t1Header) {
        const h3 = t1Header.querySelector('h3');
        if (h3) h3.innerText = 'Cards';
    }
    ui.detailsModal.classList.add('active');
};

window.openSoloCardTranscriptFromHistory = function(roundIndex, cardIndex) {
    const log = soloHistoryLog[roundIndex];
    if (!log || !log.cards[cardIndex]) return;
    const entry = log.cards[cardIndex];
    // Temporarily swap into modal
    ui.soloCardModalTitle.innerHTML = `<i class="fas fa-id-card"></i> ${escapeHtml(entry.word)}`;
    const statusLabel = entry.status === 'correct'
        ? '<span style="color:#27ae60; font-weight:bold;"><i class="fas fa-check-circle"></i> Solved</span>'
        : '<span style="color:#7f8c8d;"><i class="fas fa-forward"></i> Skipped</span>';
    ui.soloCardModalStatus.innerHTML = statusLabel;
    ui.soloCardModalTaboo.innerHTML = '<strong>Taboo words:</strong> ' + entry.taboo.map(t => escapeHtml(t)).join(', ');
    const transcript = entry.entries.map(e => {
        const cls = `solo-feed-entry ${e.type}`;
        const bubbleCls = `solo-bubble ${e.type}`;
        const content = e.html || escapeHtml(e.text);
        return `<div class="${cls}"><div class="${bubbleCls}">${content}</div></div>`;
    }).join('');
    ui.soloCardModalTranscript.innerHTML = transcript || '<div class="solo-feed-entry feedback"><div class="solo-bubble feedback">(no entries)</div></div>';
    // Close the details modal first
    ui.detailsModal.classList.remove('active');
    ui.soloCardModal.classList.add('active');
};

function getFilteredDeck() {
    if (currentCategory === "Custom") {
        const customLower = customCategoryText.trim().toLowerCase();
        if (!customLower) return [...wordDeck]; 
        
        const filtered = wordDeck.filter(card => card.category.toLowerCase().includes(customLower));
        return filtered.length > 0 ? filtered : [...wordDeck]; 
    }
    return currentCategory === "All" ? [...wordDeck] : wordDeck.filter(card => card.category === currentCategory);
}

function validateInputs(categoryInput, customInput, errorMsg) {
    if (categoryInput.value === 'Custom' && !customInput.value.trim()) {
        errorMsg.style.display = 'block';
        customInput.classList.add('input-error');
        customInput.focus();
        return false;
    }
    errorMsg.style.display = 'none';
    customInput.classList.remove('input-error');
    return true;
}

function resetDeck() {
    activeDeckCategory = currentCategory;
    activeCustomText = customCategoryText;
    let baseDeck = getFilteredDeck();
    unseenWords = baseDeck.filter(baseCard => !seenWords.some(seenCard => seenCard.word === baseCard.word));
    currentCard = null;
    aiBuffer = [];
}

function initializeGame() {
    if (!validateInputs(ui.catInputSetup, ui.customCatInputSetup, ui.errorMsgSetup)) return;

    timeLimit = parseInt(ui.timeInputSetup.value) || 90;
    syncCategories(ui.catInputSetup);
    syncCustomText(ui.customCatInputSetup);
    syncRounds(ui.roundsSelectSetup);
    ui.timeInputTurn.value = timeLimit;

    if (!audioCtx) audioCtx = new AudioContext();

    if (typeof gtag !== 'undefined') {
        gtag('event', 'game_start', { category: currentCategory, use_ai: useAI, mode: gameMode });
    }

    resetScores();
    showScreen('turn');

    triggerAIPreFetch();
}

function resetScores() {
    totalScores = { 1: 0, 2: 0 };
    currentTeam = 1;
    roundCounter = 1;
    historyLog = [];
    // Solo state
    soloTotalScore = 0;
    soloRoundScore = 0;
    soloHistoryLog = [];
    soloPlayedCards = [];
    soloCurrentEntries = [];
    resetDeck();
    updateTurnScreenUI();
}

function startTurn() {
    if (!validateInputs(ui.catInputTurn, ui.customCatInputTurn, ui.errorMsgTurn)) return;

    syncCategories(ui.catInputTurn);
    syncCustomText(ui.customCatInputTurn);

    // FIX: Compare against actual built deck state rather than what was loosely stored before the listener ran
    if (currentCategory !== activeDeckCategory || customCategoryText !== activeCustomText) {
        resetDeck();
    }

    timeLimit = parseInt(ui.timeInputTurn.value) || 90;
    syncRounds(ui.roundsSelectTurn);

    if (typeof gtag !== 'undefined') {
        gtag('event', 'turn_start', { team: currentTeam, round: roundCounter, category: currentCategory });
    }

    timeLeft = timeLimit;
    currentRoundScore = 0;
    currentRoundWords = [];
    isPaused = false;
    isFetching = false;

    ui.timerDisplay.innerText = timeLeft;
    ui.currentRoundScore.innerText = currentRoundScore;
    ui.pauseBtn.innerText = "Pause";
    ui.pauseBtn.classList.replace('btn-secondary', 'btn-warning');

    // Reset timer bar
    if (ui.timerBar) {
        ui.timerBar.style.transition = 'none';
        ui.timerBar.style.width = '100%';
        ui.timerBar.classList.remove('danger');
        // Re-enable transition after reset (next frame)
        requestAnimationFrame(() => {
            ui.timerBar.style.transition = 'width 0.9s linear, background-color 0.3s';
        });
    }

    showScreen('game');
    loadNextCard();
    
    timerInterval = setInterval(() => {
        if (!isPaused && !isFetching) {
            timeLeft--;
            ui.timerDisplay.innerText = timeLeft;

            // Update timer bar
            if (ui.timerBar) {
                ui.timerBar.style.width = (timeLeft / timeLimit * 100) + '%';
                if (timeLeft <= 10) ui.timerBar.classList.add('danger');
            }

            if (timeLeft <= 10 && timeLeft > 0) {
                playSound('tick');
            }

            if (timeLeft <= 0) {
                playSound('taboo');
                endTurn();
            }
        }
    }, 1000);
}

function getNextDeckCard() {
    if (unseenWords.length === 0) {
        let baseDeck = getFilteredDeck();
        unseenWords = [...baseDeck];
        seenWords = seenWords.filter(seenCard => !baseDeck.some(baseCard => baseCard.word === seenCard.word));
        saveHistoryToStorage();
    }
    const randomIndex = Math.floor(Math.random() * unseenWords.length);
    return unseenWords.splice(randomIndex, 1)[0]; 
}

function triggerAIPreFetch() {
    if (!useAI || isBackgroundFetching) return;
    const epoch = fetchEpoch;
    if (typeof gtag !== 'undefined' && customCategoryText.trim()) {
        gtag('event', 'ai_category_used', { topic: customCategoryText.trim() });
    }
    fillBufferFromLocal();
    if (aiBuffer.length < 10) {
        isBackgroundFetching = true;
        fetchAIBatch(10)
            .then(cards => {
                if (fetchEpoch !== epoch) return;
                if (cards?.length) aiBuffer.push(...cards);
                isBackgroundFetching = false;
            })
            .catch(e => {
                if (fetchEpoch === epoch) isBackgroundFetching = false;
                console.error("Pre-fetch failed:", e);
            });
    }
}

function fillBufferFromLocal() {
    if (!useAI) return;
    const currentTopic = customCategoryText.trim().toLowerCase();
    
    const availableLocalCards = aiDeck.filter(c =>
        c.topic === currentTopic &&
        !seenWords.some(sw => stemWord(sw.word) === stemWord(c.word)) &&
        !aiBuffer.some(buf => stemWord(buf.word) === stemWord(c.word)) &&
        (!currentCard || stemWord(currentCard.word) !== stemWord(c.word))
    );
    
    availableLocalCards.sort(() => Math.random() - 0.5);
    
    while(aiBuffer.length < 10 && availableLocalCards.length > 0) {
        aiBuffer.push(availableLocalCards.pop());
    }
}

async function loadNextCard() {
    if (useAI) {
        const requestedRound = roundCounter;
        fillBufferFromLocal();

        if (aiBuffer.length === 0) {
            setLoadingState(true);
            
            if (isBackgroundFetching) {
                while (isBackgroundFetching && aiBuffer.length === 0) {
                    await new Promise(r => setTimeout(r, 200));
                }
            } else {
                try {
                    isBackgroundFetching = true;
                    const newCards = await fetchAIBatch(10);
                    if (newCards && newCards.length > 0 && roundCounter === requestedRound) {
                        aiBuffer.push(...newCards);
                    }
                } catch (e) { console.error("Batch load failed:", e); } finally { isBackgroundFetching = false; }
            }
            
            if (aiBuffer.length === 0 && roundCounter === requestedRound) {
                try {
                    isBackgroundFetching = true;
                    const emergencyCards = await fetchAIBatch(10);
                    if (emergencyCards && emergencyCards.length > 0 && roundCounter === requestedRound) {
                        aiBuffer.push(...emergencyCards);
                    }
                } catch (e) { console.error("Emergency load failed:", e); } finally { isBackgroundFetching = false; }
            }
            
            if (roundCounter !== requestedRound || !useAI || !screens.game.classList.contains('active')) {
                setLoadingState(false);
                isFetching = false;
                return; 
            }
            
            setLoadingState(false);
        }

        if (aiBuffer.length > 0) {
            currentCard = aiBuffer.shift();
            renderCard(currentCard);
        } else {
            currentCard = getNextDeckCard();
            renderCard(currentCard);
        }
        maintainAIBuffer(); 
    } else {
        currentCard = getNextDeckCard();
        renderCard(currentCard);
    }
}

async function maintainAIBuffer() {
    if (isBackgroundFetching || !useAI || isPaused) return;
    const epoch = fetchEpoch;
    fillBufferFromLocal();
    if (aiBuffer.length < 5) {
        isBackgroundFetching = true;
        try {
            const newCards = await fetchAIBatch(10);
            if (fetchEpoch === epoch && newCards?.length && useAI) {
                aiBuffer.push(...newCards);
            }
        } catch (e) { console.error("Background buffer failed", e); }
        finally { if (fetchEpoch === epoch) isBackgroundFetching = false; }
    }
}

async function fetchAIBatch(count = 5) {
    let avoidWords = [
        ...seenWords.map(c => c.word), 
        ...aiDeck.map(c => c.word), 
        ...aiBuffer.map(c => c.word)
    ];
    
    if (currentCard) {
        avoidWords.push(currentCard.word);
    }

    avoidWords = [...new Set(avoidWords.map(w => w.toLowerCase()))].filter(Boolean);

    let avoidPrompt = "";
    if (avoidWords.length > 0) {
        const recentAvoids = avoidWords.slice(-50);
        avoidPrompt = `\nCRITICAL: DO NOT use any of these words as the Target: ${recentAvoids.join(', ')}.`;
    }

    const requestedTopic = customCategoryText.trim().toLowerCase();
    const requestedCategory = currentCategory;
    
    let subject = requestedCategory === "Custom" ? `the topic: "${requestedTopic || 'interesting random facts'}"` : `the category: "${requestedCategory}"`;
    const prompt = `You are a Taboo game card generator. Generate exactly ${count} UNIQUE target words and 5 taboo words for each, related to ${subject}. The taboo words are the most common words people use to describe the target word.${avoidPrompt} Output ONLY valid JSON in this exact format, with no markdown styling, returning an array of exactly ${count} objects: [{"word": "Target1", "taboo": ["Word1", "Word2", "Word3", "Word4", "Word5"]}, {"word": "Target2", "taboo": ["Word1", "Word2", "Word3", "Word4", "Word5"]}]`;
    
    const proxyUrl = "https://taboosey-proxy.robertchenmit.workers.dev"; 
    
    const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
    });

    if (!response.ok) throw new Error(`Proxy/API Error ${response.status}: ${await response.text()}`);

    const data = await response.json();
    let jsonText = data.text.replace(/```json/g, '').replace(/```/g, '').trim();
    jsonText = jsonText.replace(/,\s*([}\]])/g, '$1');
    const arrayStart = jsonText.indexOf('[');
    const arrayEnd = jsonText.lastIndexOf(']');
    if (arrayStart === -1 || arrayEnd === -1) throw new Error("No JSON array found in response");
    jsonText = jsonText.slice(arrayStart, arrayEnd + 1);

    let cardDataArray;
    try {
        cardDataArray = JSON.parse(jsonText);
    } catch {
        // Malformed JSON mid-response: extract whatever complete card objects exist
        cardDataArray = [];
        const cardRegex = /\{"word"\s*:\s*"([^"]+)"\s*,\s*"taboo"\s*:\s*\[([^\]]+)\]\s*\}/g;
        let m;
        while ((m = cardRegex.exec(jsonText)) !== null) {
            try { cardDataArray.push(JSON.parse(m[0])); } catch {}
        }
    }
    const avoidStems = new Set(avoidWords.map(stemWord));
    const validCards = [];

    for (let card of cardDataArray) {
        const wordStem = stemWord(card.word);
        if (!avoidStems.has(wordStem) && !validCards.some(v => stemWord(v.word) === wordStem)) {
            card.category = "Custom";
            card.topic = requestedTopic; 
            
            validCards.push(card);
            aiDeck.push(card); 
        }
    }
    saveHistoryToStorage();
    return validCards;
}

function renderCard(card) {
    ui.targetWord.innerText = card.word;
    ui.tabooWords.innerHTML = card.taboo.map(w => `<li>${w}</li>`).join('');
}

function setLoadingState(loading) {
    isFetching = loading;
    ui.loadingOverlay.style.display = loading ? 'block' : 'none';
    ui.cardContent.style.display = loading ? 'none' : 'block';
    ui.gameButtons.forEach(btn => btn.disabled = loading);
}

function handleGuess(points) {
    if (isPaused || isFetching) return; 
    
    currentRoundScore = Math.max(0, currentRoundScore + points);
    ui.currentRoundScore.innerText = currentRoundScore;
    
    ui.activeCard.classList.remove('flash-green', 'flash-red');
    void ui.activeCard.offsetWidth; 
    
    if (points > 0) {
        ui.activeCard.classList.add('flash-green');
        playSound('correct');
    } else if (points < 0) {
        ui.activeCard.classList.add('flash-red');
        playSound('taboo');
    } else {
        playSound('skip');
    }

    if (currentCard) {
        seenWords.push(currentCard);
        currentRoundWords.push({ word: currentCard.word, status: points });
        saveHistoryToStorage(); 
    }
    
    loadNextCard();
}

function togglePause() {
    isPaused = !isPaused;
    if (ui.pausedIndicator) ui.pausedIndicator.style.display = isPaused ? 'inline' : 'none';
    if (isPaused) {
        ui.pauseBtn.innerText = "Resume";
        ui.pauseBtn.classList.replace('btn-warning', 'btn-secondary');
    } else {
        ui.pauseBtn.innerText = "Pause";
        ui.pauseBtn.classList.replace('btn-secondary', 'btn-warning');
        if (useAI) maintainAIBuffer();
    }
}

function endTurn() {
    clearInterval(timerInterval);

    isFetching = false;
    setLoadingState(false);

    if (currentCard) {
        seenWords.push(currentCard);
        saveHistoryToStorage();
        currentCard = null;
    }

    if (typeof gtag !== 'undefined') {
        gtag('event', 'round_end', { team: currentTeam, score: currentRoundScore, words_played: currentRoundWords.length });
    }

    totalScores[currentTeam] += currentRoundScore;
    const actualRound = Math.ceil(roundCounter / 2);

    if (currentTeam === 1) {
        historyLog.push({ round: actualRound, t1: currentRoundScore, t1Words: [...currentRoundWords], t2: '?', t2Words: [] });
    } else {
        if (historyLog.length > 0) {
            historyLog[historyLog.length - 1].t2 = currentRoundScore;
            historyLog[historyLog.length - 1].t2Words = [...currentRoundWords];
        } else {
            historyLog.push({ round: actualRound, t1: '?', t1Words: [], t2: currentRoundScore, t2Words: [...currentRoundWords] });
        }
    }

    currentTeam = currentTeam === 1 ? 2 : 1;
    roundCounter++;

    aiBuffer = [];
    isBackgroundFetching = false;

    // Check end condition: both teams just played a full round and target reached
    const completedFullRounds = Math.floor(roundCounter / 2);
    if (!infiniteRounds && currentTeam === 1 && completedFullRounds >= totalRounds) {
        showGameOver();
        return;
    }

    updateTurnScreenUI();
    showScreen('turn');
    triggerAIPreFetch();
}

function updateTurnScreenUI() {
    if (gameMode === 'solo') {
        // Single-column view of solo history; Team-2 nodes hidden by CSS .solo-mode-active
        ui.t1ScoreDisplay.innerText = soloTotalScore;
        ui.t2ScoreDisplay.innerText = '';

        let labelEl = screens.turn.querySelector('.t1-label');
        if (labelEl) labelEl.innerText = 'Your Score';

        let announcement;
        if (soloHistoryLog.length === 0) {
            announcement = 'Round 1';
        } else {
            announcement = `Time's Up! Round ${soloHistoryLog.length + 1}`;
        }
        ui.teamAnnouncement.innerText = announcement;

        if (soloHistoryLog.length === 0) {
            ui.historyList.innerHTML = `<li class="history-placeholder">No rounds played yet.</li>`;
        } else {
            ui.historyList.innerHTML = [...soloHistoryLog].reverse().map((log, index) => {
                const realIndex = soloHistoryLog.length - 1 - index;
                const cardCount = log.cards ? log.cards.length : 0;
                return `
                <li class="history-item">
                    <span class="hg-round hist-round">Round ${log.round}</span>
                    <span class="hg-t1 hist-score t1-score">${log.score}</span>
                    <span class="hg-blank hist-vs"></span>
                    <span class="hg-t2 hist-score">${cardCount}</span>
                    <button class="details-btn" onclick="openSoloRoundDetails(${realIndex})"><i class="fas fa-search"></i></button>
                </li>
            `;}).join('');
        }
    } else {
        ui.t1ScoreDisplay.innerText = totalScores[1];
        ui.t2ScoreDisplay.innerText = totalScores[2];

        // Restore label in case we came back from solo mode
        let labelEl = screens.turn.querySelector('.t1-label');
        if (labelEl) labelEl.innerText = 'Team 1';

        let announcement = `Team ${currentTeam}'s Turn`;
        if (roundCounter > 1) announcement = `Time's Up! ` + announcement;
        ui.teamAnnouncement.innerText = announcement;

        if (historyLog.length === 0) {
            ui.historyList.innerHTML = `<li class="history-placeholder">No rounds played yet.</li>`;
        } else {
            ui.historyList.innerHTML = [...historyLog].reverse().map((log, index) => {
                const realIndex = historyLog.length - 1 - index;
                return `
                <li class="history-item">
                    <span class="hg-round hist-round">Round ${log.round}</span>
                    <span class="hg-t1 hist-score t1-score">${log.t1}</span>
                    <span class="hg-blank hist-vs">-</span>
                    <span class="hg-t2 hist-score t2-score">${log.t2}</span>
                    <button class="details-btn" onclick="openRoundDetails(${realIndex})"><i class="fas fa-search"></i></button>
                </li>
            `}).join('');
        }
    }

    const now = Date.now();
    if (now - lastAdRefreshTime > 30000) {
        try {
            (adsbygoogle = window.adsbygoogle || []).push({});
            lastAdRefreshTime = now;
        } catch (e) {
            console.log("AdSense logic skipped or failed.");
        }
    }
}

window.openRoundDetails = function(index) {
    const log = historyLog[index];
    document.getElementById('details-round-title').innerHTML = `<i class="fas fa-list-alt"></i> Round ${log.round} Details`;

    const renderWords = (words) => {
        if (!words || words.length === 0) return `<li><span style="color:#aaa; font-weight:normal;">No words played</span></li>`;
        return words.map(w => {
            let icon = `<i class="fas fa-minus-circle status-icon skip"></i>`;
            if (w.status > 0) icon = `<i class="fas fa-check-circle status-icon correct"></i>`;
            if (w.status < 0) icon = `<i class="fas fa-times-circle status-icon taboo"></i>`;
            return `<li><span>${w.word}</span> ${icon}</li>`;
        }).join('');
    };

    document.getElementById('t1-details-list').innerHTML = renderWords(log.t1Words);
    document.getElementById('t2-details-list').innerHTML = renderWords(log.t2Words);
    ui.detailsModal.classList.add('active');
};

// Keyboard shortcuts (desktop): Space/→ = Correct, ↓ = Skip, ←/Backspace = Taboo
document.addEventListener('keydown', (e) => {
    if (!screens.game.classList.contains('active') || isPaused || isFetching) return;
    // Don't fire if focus is on an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        handleGuess(1);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleGuess(0);
    } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault();
        handleGuess(-1);
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (audioCtx && audioCtx.state === 'running') audioCtx.suspend();
        if (!isPaused) {
            if (screens.game.classList.contains('active')) togglePause();
            else if (screens.soloGame.classList.contains('active')) toggleSoloPause();
        }
    } else {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }
});

if (window.Capacitor) {
    const { App } = Capacitor.Plugins;

    App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) {
            voiceInput.stop();
            stopSpeaking();
            if (!isPaused) {
                if (screens.game.classList.contains('active')) togglePause();
                else if (screens.soloGame.classList.contains('active')) toggleSoloPause();
            }
        }
    });

    App.addListener('backButton', () => {
        if (screens.setup.classList.contains('active')) {
            App.exitApp();
        } else if (screens.game.classList.contains('active') || screens.soloGame.classList.contains('active')) {
            // Quit confirmation
            showCustomModal('<i class="fas fa-home"></i> Quit Round?', "End the current round and return to the menu?", true, () => {
                if (screens.soloGame.classList.contains('active')) endSoloRound();
                else endTurn();
            });
        } else {
            showScreen('setup');
        }
    });
}

if ('serviceWorker' in navigator && !window.Capacitor) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.error('SW registration failed:', err));
    });
}

(function setupInstall() {
    if (window.Capacitor) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isIOSSafari = isIOS && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const bannerDismissed = localStorage.getItem('tabooseyAndroidInstallDismissed') === '1';
    let isInstalled = isStandalone || localStorage.getItem('tabooseyInstalled') === '1';

    let deferredPrompt = null;

    const banner = document.getElementById('android-install-banner');
    const bannerInstallBtn = document.getElementById('android-install-btn');
    const bannerDismissBtn = document.getElementById('android-install-dismiss');
    const aboutHint = document.getElementById('about-install-hint');
    const aboutBtn = document.getElementById('about-install-btn');

    function manualHint() {
        if (isIOSSafari) {
            return 'On iPhone: tap the <i class="fas fa-arrow-up-from-bracket"></i> Share button, then <strong>Add to Home Screen</strong>.';
        }
        if (isIOS) {
            return 'Installing on iPhone only works from Safari. Open <strong>taboosey.com</strong> in Safari, then tap <i class="fas fa-arrow-up-from-bracket"></i> Share &rarr; <strong>Add to Home Screen</strong>.';
        }
        if (isAndroid) {
            return 'On Android: open the Chrome menu (<i class="fas fa-ellipsis-vertical"></i>) and choose <strong>Install app</strong>.';
        }
        return 'To install, open your browser menu or click the install icon in the address bar (Chrome/Edge).';
    }

    function render() {
        if (!aboutHint) return;
        if (isInstalled) {
            aboutHint.innerHTML = '<i class="fas fa-check"></i> Taboosey is installed on this device.';
            if (aboutBtn) aboutBtn.style.display = 'none';
        } else if (deferredPrompt) {
            aboutHint.innerHTML = 'Click <strong>Install App</strong> below to add Taboosey to your device.';
            if (aboutBtn) aboutBtn.style.display = 'inline-block';
        } else {
            aboutHint.innerHTML = manualHint();
            if (aboutBtn) aboutBtn.style.display = 'none';
        }
    }
    render();

    function markInstalled() {
        isInstalled = true;
        localStorage.setItem('tabooseyInstalled', '1');
        if (banner) banner.style.display = 'none';
        render();
    }

    async function triggerInstall() {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (outcome === 'accepted') markInstalled();
        else render();
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        if (isInstalled) return;
        render();
        if (banner && !bannerDismissed) banner.style.display = 'flex';
    });

    if (!isInstalled && navigator.getInstalledRelatedApps) {
        navigator.getInstalledRelatedApps().then(apps => {
            if (apps.some(app => app.platform === 'webapp')) markInstalled();
        }).catch(() => {});
    }

    if (bannerInstallBtn) bannerInstallBtn.addEventListener('click', triggerInstall);
    if (aboutBtn) aboutBtn.addEventListener('click', triggerInstall);

    if (bannerDismissBtn) {
        bannerDismissBtn.addEventListener('click', () => {
            if (banner) banner.style.display = 'none';
            localStorage.setItem('tabooseyAndroidInstallDismissed', '1');
        });
    }

    window.addEventListener('appinstalled', markInstalled);
})();

(function showIosInstallHint() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isSafari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    const dismissed = localStorage.getItem('tabooseyIosInstallDismissed') === '1';
    if (!isIOS || !isSafari || isStandalone || dismissed) return;

    const banner = document.getElementById('ios-install-banner');
    const dismiss = document.getElementById('ios-install-dismiss');
    if (!banner || !dismiss) return;
    banner.style.display = 'flex';
    dismiss.addEventListener('click', () => {
        banner.style.display = 'none';
        localStorage.setItem('tabooseyIosInstallDismissed', '1');
    });
})();
