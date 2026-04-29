// --- State Variables ---
let currentTeam = 1;
let totalScores = { 1: 0, 2: 0 };
let currentRoundScore = 0;
let roundCounter = 1;
let historyLog = [];

let timeLimit = 60;
let currentCategory = "All";
let customCategoryText = "";
let timeLeft = 0;
let timerInterval = null;
let isPaused = false;

// --- Deck Tracking Variables (Loaded from LocalStorage) ---
let seenWords = JSON.parse(localStorage.getItem('tabooseySeenWords')) || []; 
let aiGeneratedHistory = JSON.parse(localStorage.getItem('tabooseyAIHistory')) || []; 
let unseenWords = [];
let currentCard = null;

// --- AI Configuration ---
let useAI = false;
let isFetching = false;
let isBackgroundFetching = false;
let aiBuffer = []; // Pre-fetched AI cards (The Bank)

// --- DOM Elements ---
const screens = {
    setup: document.getElementById('setup-screen'),
    turn: document.getElementById('turn-screen'),
    game: document.getElementById('game-screen')
};

const ui = {
    timeInputSetup: document.getElementById('time-limit'),
    catInputSetup: document.getElementById('setup-category'),
    customCatGroupSetup: document.getElementById('custom-cat-group-setup'),
    customCatInputSetup: document.getElementById('custom-cat-input-setup'),
    aiToggleSetup: document.getElementById('ai-toggle-setup'),
    
    timeInputTurn: document.getElementById('turn-time-limit'),
    catInputTurn: document.getElementById('turn-category'),
    customCatGroupTurn: document.getElementById('custom-cat-group-turn'),
    customCatInputTurn: document.getElementById('custom-cat-input-turn'),
    aiToggleTurn: document.getElementById('ai-toggle-turn'),
    
    timerDisplay: document.getElementById('timer-display'),
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

    // Modal Elements
    rulesModal: document.getElementById('rules-modal'),
    openRulesLinks: document.querySelectorAll('.how-to-play-link'),
    closeRulesBtn: document.querySelector('.close-btn'),
    
    // Clear Memory Button
    clearMemoryLink: document.getElementById('clear-memory-link')
};

// --- Storage Helper ---
function saveHistoryToStorage() {
    localStorage.setItem('tabooseySeenWords', JSON.stringify(seenWords));
    localStorage.setItem('tabooseyAIHistory', JSON.stringify(aiGeneratedHistory));
}

// --- Sync Logic for Toggles/Categories ---
function syncCategories(source) {
    const val = source.value;
    ui.catInputSetup.value = val;
    ui.catInputTurn.value = val;
    currentCategory = val;
    
    const showCustom = (val === 'Custom');
    ui.customCatGroupSetup.style.display = showCustom ? 'flex' : 'none';
    ui.customCatGroupTurn.style.display = showCustom ? 'flex' : 'none';

    if (showCustom && !useAI) syncAIToggles(true);
}

function syncCustomText(source) {
    const text = source.value;
    ui.customCatInputSetup.value = text;
    ui.customCatInputTurn.value = text;
    customCategoryText = text;
}

function syncAIToggles(isChecked) {
    useAI = isChecked;
    ui.aiToggleSetup.checked = useAI;
    ui.aiToggleTurn.checked = useAI;

    if (!useAI && currentCategory === "Custom") {
        ui.catInputSetup.value = "All";
        syncCategories(ui.catInputSetup);
    }
}

// --- Event Listeners ---
ui.catInputSetup.addEventListener('change', (e) => syncCategories(e.target));
ui.catInputTurn.addEventListener('change', (e) => syncCategories(e.target));
ui.customCatInputSetup.addEventListener('input', (e) => syncCustomText(e.target));
ui.customCatInputTurn.addEventListener('input', (e) => syncCustomText(e.target));
ui.aiToggleSetup.addEventListener('change', (e) => syncAIToggles(e.target.checked));
ui.aiToggleTurn.addEventListener('change', (e) => syncAIToggles(e.target.checked));

ui.openRulesLinks.forEach(link => {
    link.addEventListener('click', () => ui.rulesModal.classList.add('active'));
});

ui.closeRulesBtn.addEventListener('click', () => ui.rulesModal.classList.remove('active'));
ui.rulesModal.addEventListener('click', (e) => {
    if (e.target === ui.rulesModal) ui.rulesModal.classList.remove('active');
});

// --- Clear Memory Listener ---
ui.clearMemoryLink.addEventListener('click', () => {
    if (confirm("Are you sure you want to reset the deck? This will allow previously played words to appear again.")) {
        localStorage.removeItem('tabooseySeenWords');
        localStorage.removeItem('tabooseyAIHistory');
        
        seenWords = [];
        aiGeneratedHistory = [];
        resetDeck();
        
        alert("Deck memory has been successfully wiped!");
    }
});

document.getElementById('start-game-btn').addEventListener('click', initializeGame);
document.getElementById('start-turn-btn').addEventListener('click', startTurn);
document.getElementById('reset-scores-btn').addEventListener('click', resetScores);
document.getElementById('correct-btn').addEventListener('click', () => handleGuess(1));
document.getElementById('skip-btn').addEventListener('click', () => handleGuess(0));
document.getElementById('taboo-btn').addEventListener('click', () => handleGuess(-1));
ui.pauseBtn.addEventListener('click', togglePause);
ui.endRoundBtn.addEventListener('click', endTurn);

// --- Functions ---
function showScreen(screenName) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screenName].classList.add('active');
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

function resetDeck() {
    let baseDeck = getFilteredDeck();
    unseenWords = baseDeck.filter(baseCard => !seenWords.some(seenCard => seenCard.word === baseCard.word));
    currentCard = null;
    aiBuffer = [];
}

function initializeGame() {
    timeLimit = parseInt(ui.timeInputSetup.value) || 60;
    syncCategories(ui.catInputSetup);
    syncCustomText(ui.customCatInputSetup);
    ui.timeInputTurn.value = timeLimit; 
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
            if (timeLeft <= 0) endTurn();
        }
    }, 1000);
}

// --- Deck Distribution Logic ---
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

async function loadNextCard() {
    if (useAI) {
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
                    if (newCards && newCards.length > 0) {
                        aiBuffer.push(...newCards);
                    }
                } catch (e) {
                    console.error("Batch load failed:", e);
                } finally {
                    isBackgroundFetching = false;
                }
            }
            
            if (aiBuffer.length === 0) {
                try {
                    isBackgroundFetching = true;
                    const emergencyCards = await fetchAIBatch(10);
                    if (emergencyCards && emergencyCards.length > 0) {
                        aiBuffer.push(...emergencyCards);
                    }
                } catch (e) {
                    console.error("Emergency batch load failed:", e);
                } finally {
                    isBackgroundFetching = false;
                }
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
    
    if (aiBuffer.length < 3) {
        isBackgroundFetching = true;
        try {
            const newCards = await fetchAIBatch(5);
            if (newCards && newCards.length > 0) {
                aiBuffer.push(...newCards);
            }
        } catch (e) {
            console.error("Background buffer failed", e);
        } finally {
            isBackgroundFetching = false;
        }
    }
}

async function fetchAIBatch(count = 5) {
    let avoidWords = [
        ...seenWords.map(c => c.word),
        ...aiGeneratedHistory,
        ...aiBuffer.map(c => c.word) 
    ];
    
    avoidWords = [...new Set(avoidWords)].filter(Boolean);
    
    let avoidPrompt = "";
    if (avoidWords.length > 0) {
        const recentAvoids = avoidWords.slice(-100); 
        avoidPrompt = `\nCRITICAL: DO NOT use any of these words as the Target: ${recentAvoids.join(', ')}.`;
    }

    let subject = currentCategory === "Custom" 
        ? `the topic: "${customCategoryText || 'interesting random facts'}"` 
        : `the category: "${currentCategory}"`;

    const prompt = `You are a Taboo game card generator. Generate exactly ${count} UNIQUE target words and 5 taboo words for each, related to ${subject}. The taboo words are the most common words people use to describe the target word.${avoidPrompt} Output ONLY valid JSON in this exact format, with no markdown styling, returning an array of exactly ${count} objects: [{"word": "Target1", "taboo": ["Word1", "Word2", "Word3", "Word4", "Word5"]}, {"word": "Target2", "taboo": ["Word1", "Word2", "Word3", "Word4", "Word5"]}]`;
    
    const proxyUrl = "https://taboosey-proxy.robertchenmit.workers.dev"; 
    
    const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Proxy/API Error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    let jsonText = data.candidates[0].content.parts[0].text;
    jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    const cardDataArray = JSON.parse(jsonText);
    const validCards = [];

    for (let card of cardDataArray) {
        if (!avoidWords.includes(card.word) && !validCards.some(v => v.word === card.word)) {
            validCards.push(card);
            aiGeneratedHistory.push(card.word);
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
    
    if (currentCard) {
        seenWords.push(currentCard);
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
        historyLog.push({ round: actualRound, t1: currentRoundScore, t2: '?' });
    } else {
        if (historyLog.length > 0) {
            historyLog[historyLog.length - 1].t2 = currentRoundScore;
        } else {
            historyLog.push({ round: actualRound, t1: '?', t2: currentRoundScore });
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
    if (roundCounter > 1) {
        announcement = `Time's Up! ` + announcement;
    }
    ui.teamAnnouncement.innerText = announcement;

    if (historyLog.length === 0) {
        ui.historyList.innerHTML = `<li class="history-placeholder">No rounds played yet.</li>`;
    } else {
        ui.historyList.innerHTML = [...historyLog].reverse().map(log => `
            <li class="history-item">
                <span class="hg-round hist-round">Round ${log.round}</span>
                <span class="hg-t1 hist-score t1-score">${log.t1}</span>
                <span class="hg-blank hist-vs">-</span>
                <span class="hg-t2 hist-score t2-score">${log.t2}</span>
            </li>
        `).join('');
    }
}