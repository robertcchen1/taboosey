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

let timeLimit = 60;
let currentCategory = "All";
let customCategoryText = "";
let timeLeft = 0;
let timerInterval = null;
let isPaused = false;
let isMuted = false;
let lastAdRefreshTime = 0;

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

// --- Sound Engine (Web Audio API) ---
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function playSound(type) {
    if (isMuted) return;
    
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t = audioCtx.currentTime;

    // Helper function to create true overlapping chimes
    const playChime = (freq, startTime, duration) => {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        osc.type = 'sine'; // Pure tone for a bell/chime feel
        osc.frequency.setValueAtTime(freq, startTime);
        
        // Percussive bell envelope: fast attack, long smooth fade out
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(0.25, startTime + 0.02); 
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration); 
        
        osc.start(startTime);
        osc.stop(startTime + duration);
    };

    if (type === 'correct') {
        // Lowered pitch: Happy ascending chime (C5 -> E5)
        playChime(523.25, t, 0.5); 
        playChime(659.25, t + 0.1, 0.7); 
        
    } else if (type === 'taboo') {
        // Kept taboo at the same soft octave for balance (Eb5 -> C5)
        playChime(622.25, t, 0.5);
        playChime(523.25, t + 0.15, 0.7);
        
    } else if (type === 'skip') {
        // Single neutral chime (G5)
        playChime(783.99, t, 0.4);
        
    } else if (type === 'tick') {
        // Soft UI tick
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
    game: document.getElementById('game-screen')
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
    clearMemoryLink: document.getElementById('clear-memory-link')
};

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
    ui.customCatInputSetup.value = text;
    ui.customCatInputTurn.value = text;
    customCategoryText = text;

    if (text.trim() !== "") {
        ui.errorMsgSetup.style.display = 'none';
        ui.errorMsgTurn.style.display = 'none';
        ui.customCatInputSetup.classList.remove('input-error');
        ui.customCatInputTurn.classList.remove('input-error');
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
        navTabs.forEach(t => t.classList.remove('active'));
        sitePages.forEach(p => p.classList.remove('active'));
        
        tab.classList.add('active');
        document.getElementById(tab.getAttribute('data-target')).classList.add('active');
    });
});

ui.catInputSetup.addEventListener('change', (e) => syncCategories(e.target));
ui.catInputTurn.addEventListener('change', (e) => syncCategories(e.target));
ui.customCatInputSetup.addEventListener('input', (e) => syncCustomText(e.target));
ui.customCatInputTurn.addEventListener('input', (e) => syncCustomText(e.target));

ui.muteBtn.addEventListener('click', () => toggleMute());

ui.homeBtn.addEventListener('click', () => {
    showCustomModal('<i class="fas fa-home"></i> Quit Game?', "Return to the main menu? The current game's scores will be lost.", true, () => {
        showScreen('setup');
    });
});

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

document.getElementById('start-game-btn').addEventListener('click', initializeGame);
document.getElementById('start-turn-btn').addEventListener('click', startTurn);
document.getElementById('reset-scores-btn').addEventListener('click', resetScores);
document.getElementById('correct-btn').addEventListener('click', () => handleGuess(1));
document.getElementById('skip-btn').addEventListener('click', () => handleGuess(0));
document.getElementById('taboo-btn').addEventListener('click', () => handleGuess(-1));
ui.pauseBtn.addEventListener('click', togglePause);
ui.endRoundBtn.addEventListener('click', endTurn);

function showScreen(screenName) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screenName].classList.add('active');
    ui.homeBtn.style.display = screenName === 'turn' ? 'flex' : 'none';
}

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
    let baseDeck = getFilteredDeck();
    unseenWords = baseDeck.filter(baseCard => !seenWords.some(seenCard => seenCard.word === baseCard.word));
    currentCard = null;
    aiBuffer = [];
}

function initializeGame() {
    if (!validateInputs(ui.catInputSetup, ui.customCatInputSetup, ui.errorMsgSetup)) return;

    timeLimit = parseInt(ui.timeInputSetup.value) || 60;
    syncCategories(ui.catInputSetup);
    syncCustomText(ui.customCatInputSetup);
    ui.timeInputTurn.value = timeLimit; 
    
    if (!audioCtx) audioCtx = new AudioContext();
    
    resetScores();
    showScreen('turn');
}

function resetScores() {
    totalScores = { 1: 0, 2: 0 };
    currentTeam = 1;
    roundCounter = 1;
    historyLog = [];
    resetDeck(); 
    updateTurnScreenUI();
}

function startTurn() {
    if (!validateInputs(ui.catInputTurn, ui.customCatInputTurn, ui.errorMsgTurn)) return;

    timeLimit = parseInt(ui.timeInputTurn.value) || 60;

    let oldCategory = currentCategory;
    let oldCustomText = customCategoryText;
    
    syncCategories(ui.catInputTurn);
    syncCustomText(ui.customCatInputTurn);
    
    if (currentCategory !== oldCategory || customCategoryText !== oldCustomText) {
        resetDeck();
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
    
    showScreen('game');
    loadNextCard();
    
    timerInterval = setInterval(() => {
        if (!isPaused && !isFetching) {
            timeLeft--;
            ui.timerDisplay.innerText = timeLeft;
            
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

function fillBufferFromLocal() {
    if (!useAI) return;
    const currentTopic = customCategoryText.trim().toLowerCase();
    
    const availableLocalCards = aiDeck.filter(c => 
        c.topic === currentTopic && 
        !seenWords.some(sw => sw.word === c.word) &&
        !aiBuffer.some(buf => buf.word === c.word)
    );
    
    availableLocalCards.sort(() => Math.random() - 0.5);
    
    while(aiBuffer.length < 5 && availableLocalCards.length > 0) {
        aiBuffer.push(availableLocalCards.pop());
    }
}

async function loadNextCard() {
    if (useAI) {
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
                    const newCards = await fetchAIBatch(5);
                    if (newCards && newCards.length > 0) aiBuffer.push(...newCards);
                } catch (e) { console.error("Batch load failed:", e); } finally { isBackgroundFetching = false; }
            }
            
            if (aiBuffer.length === 0) {
                try {
                    isBackgroundFetching = true;
                    const emergencyCards = await fetchAIBatch(10);
                    if (emergencyCards && emergencyCards.length > 0) aiBuffer.push(...emergencyCards);
                } catch (e) { console.error("Emergency load failed:", e); } finally { isBackgroundFetching = false; }
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
    
    fillBufferFromLocal();
    
    if (aiBuffer.length < 3) {
        isBackgroundFetching = true;
        try {
            const newCards = await fetchAIBatch(5);
            if (newCards && newCards.length > 0) aiBuffer.push(...newCards);
        } catch (e) { console.error("Background buffer failed", e); } finally { isBackgroundFetching = false; }
    }
}

async function fetchAIBatch(count = 5) {
    let avoidWords = [...seenWords.map(c => c.word), ...aiDeck.map(c => c.word), ...aiBuffer.map(c => c.word)];
    avoidWords = [...new Set(avoidWords)].filter(Boolean);
    
    let avoidPrompt = "";
    if (avoidWords.length > 0) {
        const recentAvoids = avoidWords.slice(-100); 
        avoidPrompt = `\nCRITICAL: DO NOT use any of these words as the Target: ${recentAvoids.join(', ')}.`;
    }

    const currentTopic = customCategoryText.trim().toLowerCase();
    let subject = currentCategory === "Custom" ? `the topic: "${customCategoryText || 'interesting random facts'}"` : `the category: "${currentCategory}"`;
    const prompt = `You are a Taboo game card generator. Generate exactly ${count} UNIQUE target words and 5 taboo words for each, related to ${subject}. The taboo words are the most common words people use to describe the target word.${avoidPrompt} Output ONLY valid JSON in this exact format, with no markdown styling, returning an array of exactly ${count} objects: [{"word": "Target1", "taboo": ["Word1", "Word2", "Word3", "Word4", "Word5"]}, {"word": "Target2", "taboo": ["Word1", "Word2", "Word3", "Word4", "Word5"]}]`;
    
    const proxyUrl = "https://taboosey-proxy.robertchenmit.workers.dev"; 
    
    // Inject model preference per user instruction explicitly
    const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: "gemma-3", contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!response.ok) throw new Error(`Proxy/API Error ${response.status}: ${await response.text()}`);

    const data = await response.json();
    let jsonText = data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
    
    const cardDataArray = JSON.parse(jsonText);
    const validCards = [];

    for (let card of cardDataArray) {
        if (!avoidWords.includes(card.word) && !validCards.some(v => v.word === card.word)) {
            card.category = "Custom";
            card.topic = currentTopic;
            
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
    
    if (currentCard) {
        seenWords.push(currentCard);
        saveHistoryToStorage(); 
        currentCard = null; 
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
    
    updateTurnScreenUI();
    showScreen('turn');
}

function updateTurnScreenUI() {
    ui.t1ScoreDisplay.innerText = totalScores[1];
    ui.t2ScoreDisplay.innerText = totalScores[2];
    
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

if (window.Capacitor) {
    const { App } = Capacitor.Plugins;

    App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) {
            if (!isPaused && screens.game.classList.contains('active')) {
                togglePause();
            }
        }
    });

    App.addListener('backButton', () => {
        if (screens.setup.classList.contains('active')) {
            App.exitApp();
        } else if (screens.game.classList.contains('active')) {
            ui.homeBtn.click(); 
        } else {
            showScreen('setup');
        }
    });
}
