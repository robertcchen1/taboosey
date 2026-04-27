// --- State Variables ---
let currentTeam = 1;
let totalScores = { 1: 0, 2: 0 };
let currentRoundScore = 0;
let roundCounter = 1;
let historyLog = [];

let timeLimit = 60;
let currentCategory = "All";
let timeLeft = 0;
let timerInterval = null;
let isPaused = false;

// --- Deck Tracking Variables ---
let unseenWords = [];
let seenWords = []; // Replaces correctWords and skippedWords
let currentCard = null;

// --- DOM Elements ---
const screens = {
    setup: document.getElementById('setup-screen'),
    turn: document.getElementById('turn-screen'),
    game: document.getElementById('game-screen')
};

const ui = {
    timeInputSetup: document.getElementById('time-limit'),
    catInputSetup: document.getElementById('setup-category'),
    timeInputTurn: document.getElementById('turn-time-limit'),
    catInputTurn: document.getElementById('turn-category'),
    timerDisplay: document.getElementById('timer-display'),
    targetWord: document.getElementById('target-word'),
    tabooWords: document.getElementById('taboo-words'),
    teamAnnouncement: document.getElementById('team-announcement'),
    t1ScoreDisplay: document.getElementById('t1-score-display'),
    t2ScoreDisplay: document.getElementById('t2-score-display'),
    currentRoundScore: document.getElementById('current-round-score'),
    historyList: document.getElementById('score-history-list'),
    pauseBtn: document.getElementById('pause-btn'),
    endRoundBtn: document.getElementById('end-round-btn')
};

// --- Event Listeners ---
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

function getFilteredDeck(category) {
    // wordDeck comes from words.js
    let filtered = category === "All" ? [...wordDeck] : wordDeck.filter(card => card.category === category);
    return filtered;
}

function resetDeck(category) {
    unseenWords = getFilteredDeck(category);
    seenWords = [];
    currentCard = null;
}

function initializeGame() {
    timeLimit = parseInt(ui.timeInputSetup.value) || 60;
    currentCategory = ui.catInputSetup.value;
    
    ui.timeInputTurn.value = timeLimit; 
    ui.catInputTurn.value = currentCategory;

    resetScores();
    showScreen('turn');
}

function resetScores() {
    totalScores = { 1: 0, 2: 0 };
    currentTeam = 1;
    roundCounter = 1;
    historyLog = [];
    resetDeck(currentCategory); 
    updateTurnScreenUI();
}

function startTurn() {
    timeLimit = parseInt(ui.timeInputTurn.value) || 60;
    let selectedCategory = ui.catInputTurn.value;
    
    // Refresh deck pools if the category was changed
    if (selectedCategory !== currentCategory) {
        currentCategory = selectedCategory;
        resetDeck(currentCategory);
    }

    timeLeft = timeLimit;
    currentRoundScore = 0;
    isPaused = false;
    
    ui.timerDisplay.innerText = timeLeft;
    ui.currentRoundScore.innerText = currentRoundScore;
    ui.pauseBtn.innerText = "Pause";
    ui.pauseBtn.classList.replace('btn-secondary', 'btn-warning');
    
    showScreen('game');
    loadNextCard();
    
    timerInterval = setInterval(() => {
        if (!isPaused) {
            timeLeft--;
            ui.timerDisplay.innerText = timeLeft;
            if (timeLeft <= 0) endTurn();
        }
    }, 1000);
}

// --- Deck Distribution Logic ---
function getNextDeckCard() {
    // If we run out of unseen words, recycle the seen words back into the deck
    if (unseenWords.length === 0) {
        unseenWords = [...seenWords];
        seenWords = [];
        
        // Failsafe in case both are completely empty
        if (unseenWords.length === 0) unseenWords = getFilteredDeck(currentCategory);
    }

    // Pull a random card from the unseen pool
    const randomIndex = Math.floor(Math.random() * unseenWords.length);
    return unseenWords.splice(randomIndex, 1)[0]; 
}

function loadNextCard() {
    currentCard = getNextDeckCard();
    renderCard(currentCard);
}

function renderCard(card) {
    ui.targetWord.innerText = card.word;
    ui.tabooWords.innerHTML = card.taboo.map(w => `<li>${w}</li>`).join('');
}

function handleGuess(points) {
    if (isPaused) return; 
    
    // Update score
    currentRoundScore = Math.max(0, currentRoundScore + points);
    ui.currentRoundScore.innerText = currentRoundScore;
    
    // Move the current card to the seen pile
    if (currentCard) {
        seenWords.push(currentCard);
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
    }
}

function endTurn() {
    clearInterval(timerInterval);
    
    // The word currently on screen hasn't been guessed. Treat as seen so it doesn't repeat immediately.
    if (currentCard) {
        seenWords.push(currentCard);
        currentCard = null; 
    }
    
    // Log scores
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
    
    // Swap teams and update UI
    currentTeam = currentTeam === 1 ? 2 : 1;
    roundCounter++;
    
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