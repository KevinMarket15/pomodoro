/* --- 0. 音效系統 --- */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playTone(type) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    const now = audioCtx.currentTime;

    if (type === 'click') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        gainNode.gain.setValueAtTime(0.1, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.start(); osc.stop(now + 0.1);
    } else if (type === 'lift') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.linearRampToValueAtTime(400, now + 0.15);
        gainNode.gain.setValueAtTime(0.05, now);
        gainNode.gain.linearRampToValueAtTime(0.001, now + 0.15);
        osc.start(); osc.stop(now + 0.15);
    } else if (type === 'drop') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.1);
        gainNode.gain.setValueAtTime(0.1, now);
        gainNode.gain.linearRampToValueAtTime(0.001, now + 0.2);
        osc.start(); osc.stop(now + 0.2);
    } else if (type === 'alarm') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(880, now + 0.2);
        gainNode.gain.setValueAtTime(0.1, now);
        gainNode.gain.linearRampToValueAtTime(0.001, now + 0.5);
        osc.start(); osc.stop(now + 0.5);
    } else if (type === 'delete') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(10, now + 0.2);
        gainNode.gain.setValueAtTime(0.1, now);
        gainNode.gain.linearRampToValueAtTime(0.001, now + 0.2);
        osc.start(); osc.stop(now + 0.2);
    }
}

/* --- 1. 模態與資料邏輯 --- */
function toggleModal(show, id = 'helpModal') {
    const modal = document.getElementById(id);
    playTone('click');
    show ? modal.classList.add('show') : modal.classList.remove('show');
}

const STORAGE_KEY_CATS = 'pomodoro_categories_v4';
const STORAGE_KEY_SCHED = 'pomodoro_schedule_v4';
const STORAGE_KEY_TIMER = 'pomodoro_timer_v5';
const STORAGE_KEY_STATS = 'pomodoro_stats_v5';
const STORAGE_KEY_STATE = 'pomodoro_state_v5'; // 計時狀態，重新整理後可接續
const STORAGE_KEY_LOG = 'pomodoro_log_v1';     // 時間記錄
const LOG_KEEP_DAYS = 30;

// 會同步到雲端的資料，一律經過這兩個函式寫入，讓同步模組 (sync.js) 知道有變動
function storeSet(key, value) {
    localStorage.setItem(key, value);
    window.dispatchEvent(new CustomEvent('pomodoro:change', { detail: { key } }));
}
function storeRemove(key) {
    localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('pomodoro:change', { detail: { key } }));
}

function downloadFile(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

window.exportData = function() {
    const data = {
        categories: JSON.parse(localStorage.getItem(STORAGE_KEY_CATS) || '[]'),
        schedule: JSON.parse(localStorage.getItem(STORAGE_KEY_SCHED) || '[]'),
        logs: loadLogs(),
        timestamp: new Date().toISOString()
    };
    downloadFile(`pomodoro_backup_${todayKey()}.json`, JSON.stringify(data, null, 2), 'application/json');
};

window.importData = function(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (data.categories) storeSet(STORAGE_KEY_CATS, JSON.stringify(data.categories));
            if (data.schedule) storeSet(STORAGE_KEY_SCHED, JSON.stringify(data.schedule));
            if (Array.isArray(data.logs)) { // 記錄用合併，避免蓋掉這台裝置自己的記錄
                const logs = loadLogs();
                const seen = new Set(logs.map(l => `${l.start}|${l.mode}`));
                data.logs.forEach(l => { if (!seen.has(`${l.start}|${l.mode}`)) logs.push(l); });
                saveLogs(logs);
            }
            if (window.pomodoroSync) await window.pomodoroSync.flush(); // 重新整理前先把匯入的資料傳上雲端
            alert('匯入成功！'); location.reload();
        } catch (err) { alert('檔案錯誤'); }
    };
    reader.readAsText(file);
};

/* --- 2. 蕃茄鐘（專注／休息循環） --- */
const MODE_LABELS = { focus: '專注', short: '短休息', long: '長休息' };
const LONG_BREAK_EVERY = 4; // 每完成幾顆蕃茄換一次長休息
const MIN_LOG_SEC = 10;     // 中斷的時段短於這個秒數就不記錄（避免誤觸）

const timerSettings = loadTimerSettings(); // 各模式時長（秒）
let mode = 'focus';
let timeLeft = timerSettings.focus; // 暫停時的剩餘秒數；計時中由 endTime 推算
let endTime = 0;                    // 計時中：預計結束的時間點 (ms)
let elapsed = 0;                    // 正數模式：已經過的秒數；計時中由 countStart 推算
let countStart = 0;                 // 正數模式計時中：等效的起算時間點 (ms)
let isRunning = false;
let tickTimer = null; let finishTimer = null;
// 目前這一段的記錄資料：{ mode, task, start, plannedSec, activeMs, segStart, lastActive }
let session = null;
let pipWindow = null; // Document Picture-in-Picture 懸浮小視窗（Chrome/Edge）
let videoPip = null;  // 影片子母畫面懸浮時間（Firefox 等）：{ canvas, video, stream, panel }

const timeDisplay = document.getElementById('time');
const startBtn = document.getElementById('startBtn');

function loadTimerSettings() {
    const defaults = { focus: 25 * 60, short: 5 * 60, long: 15 * 60, countUp: false };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY_TIMER) || '{}') }; }
    catch (err) { return defaults; }
}
function saveTimerSettings() { storeSet(STORAGE_KEY_TIMER, JSON.stringify(timerSettings)); }

function todayKey() { return new Date().toLocaleDateString('sv'); } // 本地時區的 YYYY-MM-DD
function getTodayCount() {
    try {
        const stats = JSON.parse(localStorage.getItem(STORAGE_KEY_STATS) || '{}');
        return stats.date === todayKey() ? (stats.count || 0) : 0;
    } catch (err) { return 0; }
}
function setTodayCount(count) { storeSet(STORAGE_KEY_STATS, JSON.stringify({ date: todayKey(), count })); }

function formatTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function isCountUp() { return !!timerSettings.countUp; }

// 正數模式顯示「自由專注／自由休息」
function modeLabel(m = mode, countUp = isCountUp()) {
    if (!countUp) return MODE_LABELS[m];
    return m === 'focus' ? '自由專注' : '自由休息';
}

function shownSeconds() { return isCountUp() ? elapsed : timeLeft; }

function updateDisplay() {
    const text = formatTime(shownSeconds());
    if (document.activeElement !== timeDisplay) timeDisplay.innerText = text;
    document.title = `${text} - ${modeLabel()}`;
    updateFloating();
}

function updateModeUI() {
    const countUp = isCountUp();
    document.body.dataset.mode = mode;
    document.body.dataset.count = countUp ? 'up' : 'down';
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.querySelectorAll('.count-btn').forEach(b => b.classList.toggle('active', (b.dataset.count === 'up') === countUp));
    // 正數沒有目標時間：不能直接輸入時間，「跳過」改成「結束」
    timeDisplay.contentEditable = String(!countUp);
    document.getElementById('skipBtn').textContent = countUp ? '結束' : '跳過';

    const count = getTodayCount();
    let filled = count % LONG_BREAK_EVERY;
    if (filled === 0 && count > 0 && mode === 'long') filled = LONG_BREAK_EVERY; // 長休息時顯示滿格
    document.getElementById('cycleDots').innerHTML = Array.from({ length: LONG_BREAK_EVERY },
        (_, i) => `<span class="dot${i < filled ? ' filled' : ''}"></span>`).join('');
    document.getElementById('pomoCount').innerText = `今日 ${count} 🍅`;
    updateCurrentTask();
}

// 目前任務 = 凹槽第一張卡片
function getCurrentTask() {
    const first = document.querySelector('#scheduleSlot .task-card:not(.drop-placeholder) .task-name');
    return first ? first.innerText : '';
}

// 計時中的任務以開始時的第一張為準
function currentTaskName() {
    if (mode !== 'focus') return '';
    return session && session.mode === 'focus' ? session.task : getCurrentTask();
}

function updateCurrentTask() {
    const el = document.getElementById('currentTask');
    const task = currentTaskName();
    if (mode !== 'focus') el.textContent = '☕ 休息時間';
    else el.textContent = task ? `▶ ${task}` : '凹槽第一個任務 = 目前任務';
    updateFloating();
}

function saveTimerState() {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify({ mode, timeLeft, endTime, elapsed, countStart, isRunning, session }));
}

function setStartBtn(state) {
    startBtn.textContent = { start: '開始', pause: '暫停', resume: '繼續' }[state];
    startBtn.classList.toggle('btn-primary', state === 'pause');
    updateFloating();
}

// 剩餘時間一律用「結束時間 - 現在」推算，背景分頁被降頻或電腦休眠都不會漂移
function getRemaining() { return Math.max(0, Math.ceil((endTime - Date.now()) / 1000)); }
function getElapsed() { return Math.max(0, Math.floor((Date.now() - countStart) / 1000)); }

function tick() {
    if (!isRunning) return;
    if (isCountUp()) { elapsed = getElapsed(); updateDisplay(); return; } // 正數沒有終點，按「結束」才結算
    timeLeft = getRemaining();
    updateDisplay();
    if (timeLeft <= 0) finishPhase();
}

function scheduleTicks() {
    clearInterval(tickTimer); clearTimeout(finishTimer);
    tickTimer = setInterval(tick, 250);                                       // 只負責刷新畫面
    if (isCountUp()) return;
    finishTimer = setTimeout(tick, Math.max(0, endTime - Date.now()) + 50);   // 單次計時器較不受背景降頻影響，讓鈴聲準時
}

function startTimer() {
    const countUp = isCountUp();
    if (!countUp && timeLeft <= 0) timeLeft = timerSettings[mode];
    if (!session) {
        session = { mode, task: mode === 'focus' ? getCurrentTask() : '', start: Date.now(),
                    plannedSec: countUp ? 0 : timeLeft, activeMs: 0, countUp };
    }
    session.segStart = Date.now();
    if (countUp) countStart = Date.now() - elapsed * 1000;
    else endTime = Date.now() + timeLeft * 1000;
    isRunning = true;
    scheduleTicks();
    setStartBtn('pause');
    updateCurrentTask();
    saveTimerState();
}

function stopTimer() {
    if (isRunning) {
        if (isCountUp()) elapsed = getElapsed();
        else timeLeft = getRemaining();
        if (session) {
            // 倒數自然結束時以預計結束時間為準
            const now = isCountUp() ? Date.now() : Math.min(Date.now(), endTime);
            session.activeMs += now - session.segStart;
            session.lastActive = now;
        }
    }
    isRunning = false;
    clearInterval(tickTimer); clearTimeout(finishTimer);
}

// 結束目前這一段並寫入記錄；completed = false 表示中途被重置、跳過或切換
function endSession(completed) {
    if (!session) return;
    const actualSec = Math.round(session.activeMs / 1000);
    // 正數按「結束」也要滿最短秒數才記錄
    if ((completed && !session.countUp) || actualSec >= MIN_LOG_SEC) {
        const entry = {
            start: session.start, end: session.lastActive || session.start,
            mode: session.mode, task: session.task,
            plannedSec: session.plannedSec, actualSec, completed
        };
        if (session.countUp) { entry.countUp = true; entry.pomodoros = session.pomodoros || 0; }
        addLog(entry);
    }
    session = null;
}

function switchMode(next) {
    stopTimer(); endSession(false);
    mode = next;
    timeLeft = timerSettings[mode];
    elapsed = 0;
    setStartBtn('start');
    updateModeUI(); updateDisplay();
    saveTimerState();
}

// 切換倒數／正數：目前這一段視為中斷
function setCountUp(countUp) {
    if (countUp === isCountUp()) return;
    stopTimer(); endSession(false);
    timerSettings.countUp = countUp; saveTimerSettings();
    timeLeft = timerSettings[mode];
    elapsed = 0;
    setStartBtn('start');
    updateModeUI(); updateDisplay();
    saveTimerState();
}

// 正數按「結束」：專注每滿一段專注時長算一顆蕃茄，然後切到下一段
function finishCountUp() {
    stopTimer();
    const before = getTodayCount();
    let earned = 0;
    if (mode === 'focus' && session) {
        earned = Math.floor(session.activeMs / 1000 / timerSettings.focus);
        session.pomodoros = earned;
    }
    endSession(true);
    let next = 'focus';
    if (mode === 'focus') {
        const after = before + earned;
        if (earned) setTodayCount(after);
        // 這次跨過 4 的倍數就進長休息
        next = earned && Math.floor(after / LONG_BREAK_EVERY) > Math.floor(before / LONG_BREAK_EVERY) ? 'long' : 'short';
    }
    switchMode(next);
}

// completed = true 表示這段是自然結束（計入完成數）；false 表示按了「跳過」
function advancePhase(completed) {
    let next = 'focus';
    if (mode === 'focus') {
        let count = getTodayCount();
        if (completed) setTodayCount(++count);
        next = (completed && count % LONG_BREAK_EVERY === 0) ? 'long' : 'short';
    }
    switchMode(next);
}

function finishPhase() {
    const finished = mode;
    stopTimer(); endSession(true);
    playTone('alarm'); // 1. 先觸發音效
    advancePhase(true);
    // 懸浮中不跳 alert：alert 會卡住整個頁面，小視窗也會停止更新。改成多響兩聲提醒
    if (pipWindow || videoPip) {
        setTimeout(() => playTone('alarm'), 700);
        setTimeout(() => playTone('alarm'), 1400);
        return;
    }
    const msg = finished === 'focus'
        ? `專注結束！接下來是${MODE_LABELS[mode]}（${formatTime(timeLeft)}）`
        : '休息結束，準備開始下一顆蕃茄！';
    // 2. 延遲 50 毫秒再跳出彈窗，確保音效在網頁被 alert 凍結前能順利播出來
    setTimeout(() => alert(msg), 50);
}

window.setTimer = function(minutes) {
    playTone('click'); stopTimer(); endSession(false);
    timerSettings[mode] = minutes * 60; saveTimerSettings();
    timeLeft = timerSettings[mode];
    elapsed = 0;
    setStartBtn('start'); updateDisplay(); updateCurrentTask();
    saveTimerState();
};

let editStartText = '';
timeDisplay.addEventListener('focus', () => { editStartText = timeDisplay.innerText.trim(); });
timeDisplay.addEventListener('keydown', (e) => { if(e.key === 'Enter') { e.preventDefault(); timeDisplay.blur(); }});
timeDisplay.addEventListener('blur', () => {
    const raw = timeDisplay.innerText.trim();
    if (raw === editStartText) { updateDisplay(); return; } // 只是點一下沒改，不要動到正在跑的時間
    let m = 0, s = 0;
    if (raw.includes(':')) { const parts = raw.split(':'); m = parseInt(parts[0])||0; s = parseInt(parts[1])||0; }
    else { m = parseInt(raw) || 0; }
    m = Math.min(Math.max(m, 0), 99); s = Math.min(Math.max(s, 0), 59);
    const total = m * 60 + s;
    if (total > 0) {
        timerSettings[mode] = total; saveTimerSettings();
        const wasRunning = isRunning;
        stopTimer();
        timeLeft = total;
        // 中途改時間：預計時長 = 已進行的時間 + 新設定的時間
        if (session) session.plannedSec = Math.round(session.activeMs / 1000) + total;
        if (wasRunning) startTimer(); // 計時中修改：從新時間重新倒數
        else saveTimerState();
    }
    updateDisplay();
});

startBtn.addEventListener('click', () => {
    playTone('click');
    if (isRunning) { stopTimer(); setStartBtn('resume'); updateDisplay(); saveTimerState(); }
    else startTimer();
});
document.getElementById('resetBtn').addEventListener('click', () => {
    playTone('click'); stopTimer(); endSession(false);
    timeLeft = timerSettings[mode];
    elapsed = 0;
    setStartBtn('start'); updateDisplay(); updateCurrentTask();
    saveTimerState();
});
document.getElementById('skipBtn').addEventListener('click', () => {
    playTone('click');
    if (isCountUp()) finishCountUp(); else advancePhase(false);
});
document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => {
    playTone('click'); switchMode(btn.dataset.mode);
}));
document.querySelectorAll('.count-btn').forEach(btn => btn.addEventListener('click', () => {
    playTone('click'); setCountUp(btn.dataset.count === 'up');
}));
document.addEventListener('visibilitychange', tick); // 切回分頁時立即校正畫面

// 重新整理或重開頁面後接續上次的計時
function restoreTimerState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORAGE_KEY_STATE) || 'null'); } catch (err) {}
    if (s && MODE_LABELS[s.mode] && typeof s.timeLeft === 'number') {
        mode = s.mode; timeLeft = s.timeLeft; session = s.session || null;
        elapsed = s.elapsed || 0; countStart = s.countStart || 0;
        if (s.isRunning) { endTime = s.endTime; isRunning = true; scheduleTicks(); setStartBtn('pause'); }
        else setStartBtn(session ? 'resume' : 'start');
    } else {
        setStartBtn('start');
    }
    updateModeUI(); updateDisplay();
    tick(); // 關閉期間已經到時間的話，立即結束這一段
}
restoreTimerState();

/* --- 3. 資料儲存 --- */
function saveCategories() {
    const categories = [];
    document.querySelectorAll('.category-group').forEach(group => {
        const title = group.querySelector('.category-title').innerText;
        const color = group.dataset.color;
        const tasks = [];
        group.querySelectorAll('.task-card').forEach(card => tasks.push(card.querySelector('.task-name').innerText));
        categories.push({ title, color, tasks });
    });
    storeSet(STORAGE_KEY_CATS, JSON.stringify(categories));
}

function saveSchedule() {
    const schedule = [];
    document.querySelectorAll('#scheduleSlot .task-card:not(.drop-placeholder)').forEach(card => {
        schedule.push({ name: card.querySelector('.task-name').innerText, color: card.querySelector('.tag').style.background });
    });
    storeSet(STORAGE_KEY_SCHED, JSON.stringify(schedule));
    updateCurrentTask();
}

/* --- 4. 動態 DOM --- */
const paletteContainer = document.getElementById('paletteContainer');
const addCatBtn = document.querySelector('.add-category-main-btn');

function initApp() {
    renderScheduleFromStorage();
    renderCategoriesFromStorage();
}

function renderScheduleFromStorage() {
    document.getElementById('scheduleSlot').innerHTML = '';
    const savedSchedule = localStorage.getItem(STORAGE_KEY_SCHED);
    if (savedSchedule) JSON.parse(savedSchedule).forEach(t => addToSchedule(t.name, t.color, false));
    updateCurrentTask();
}

function renderCategoriesFromStorage() {
    paletteContainer.querySelectorAll('.category-group').forEach(g => g.remove());
    const savedCats = localStorage.getItem(STORAGE_KEY_CATS);
    if (savedCats) {
        JSON.parse(savedCats).forEach(cat => createCategoryDOM(cat.title, cat.color, cat.tasks));
    } else {
        createCategoryDOM('工作', '#ff6b6b', ['寫代碼']);
        createCategoryDOM('健康', '#1dd1a1', ['喝水']);
    }
    paletteContainer.appendChild(addCatBtn);
}

function createCategoryDOM(titleText, color, tasks = []) {
    const group = document.createElement('div');
    group.className = 'category-group';
    group.dataset.color = color;

    const delCatBtn = document.createElement('div');
    delCatBtn.className = 'del-category-btn';
    delCatBtn.innerText = '刪除類別';
    delCatBtn.onclick = () => { if(confirm('刪除此類別？')) { group.remove(); saveCategories(); }};
    group.appendChild(delCatBtn);

    const header = document.createElement('div');
    header.className = 'category-header';

    const title = document.createElement('div');
    title.className = 'category-title';
    title.contentEditable = true;
    title.innerText = titleText;
    title.addEventListener('blur', saveCategories);
    title.addEventListener('keydown', (e) => { if(e.key==='Enter') e.preventDefault(); });

    const controls = document.createElement('div');
    controls.className = 'cat-controls';

    const addBtn = document.createElement('button');
    addBtn.className = 'add-task-btn';
    addBtn.innerText = '+';
    addBtn.onclick = () => { playTone('click'); createTaskDOM(grid, '新任務', color); saveCategories(); };

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.innerHTML = '☰';
    handle.title = "按住拖曳排序";

    controls.appendChild(addBtn);
    controls.appendChild(handle);

    header.appendChild(title);
    header.appendChild(controls);

    const grid = document.createElement('div');
    grid.className = 'task-grid';

    tasks.forEach(taskName => createTaskDOM(grid, taskName, color));

    group.appendChild(header);
    group.appendChild(grid);

    paletteContainer.insertBefore(group, addCatBtn);
}

function createTaskDOM(container, name, color) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.color = color;

    card.onclick = () => {
        playTone('click');
        const nameSpan = card.querySelector('.task-name');
        const newName = prompt("編輯任務名稱（清空即刪除）:", nameSpan.innerText);
        if (newName === null) return;
        if (newName.trim() === '') {
            if (confirm('從庫中移除此任務？')) { card.remove(); saveCategories(); }
            return;
        }
        nameSpan.innerText = newName; saveCategories();
    };
    card.oncontextmenu = (e) => {
        e.preventDefault();
        if(confirm('從庫中移除此任務？')) { card.remove(); saveCategories(); }
    };

    const tag = document.createElement('div');
    tag.className = 'tag'; tag.style.background = color;
    const text = document.createElement('div');
    text.className = 'task-name'; text.innerText = name;
    card.appendChild(tag); card.appendChild(text);

    card.style.opacity = 0; container.appendChild(card);
    requestAnimationFrame(() => { card.style.transition = 'opacity 0.3s'; card.style.opacity = 1; });
}

window.addNewCategory = function() {
    playTone('click');
    const colors = ['#feca57', '#5f27cd', '#48dbfb', '#ff9ff3', '#ff6b6b', '#1dd1a1'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    createCategoryDOM('新類別', randomColor, ['點我編輯']);
    saveCategories();
};

window.resetToDefault = async function() {
    const syncing = window.pomodoroSync && window.pomodoroSync.isSignedIn();
    if (!confirm(syncing ? '重置所有資料？\n雲端同步的資料也會一併清除，其他裝置會跟著重置。' : '重置所有資料？')) return;
    // 先清雲端，不然重新整理後又會從雲端同步回來
    if (syncing) await window.pomodoroSync.resetCloud();
    localStorage.removeItem(STORAGE_KEY_CATS);
    localStorage.removeItem(STORAGE_KEY_SCHED);
    localStorage.removeItem(STORAGE_KEY_STATE);
    localStorage.removeItem(STORAGE_KEY_LOG);
    location.reload();
}

/* --- 5. 拖曳邏輯（Pointer Events：滑鼠、觸控、觸控筆通用） --- */
const slot = document.getElementById('scheduleSlot');
const LONG_PRESS_MS = 250; // 觸控：長按多久才開始拖曳，避免和捲動衝突
const MOVE_THRESHOLD = 6;  // 滑鼠：移動超過幾 px 才算拖曳，避免和點擊衝突
let drag = null;
let lastPointerType = 'mouse';
let suppressClickUntil = 0;

document.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    if (drag || e.button !== 0) return;
    const base = { pointerId: e.pointerId, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false };

    const handle = e.target.closest('.drag-handle');
    const card = e.target.closest('.task-card');
    if (handle) {
        e.preventDefault();
        drag = { ...base, type: 'category', el: handle.closest('.category-group') };
        activateDrag(); // ☰ 是專用把手，按下就開始
    } else if (card && !e.target.closest('.delete-icon')) {
        drag = { ...base, type: 'task', el: card, origin: slot.contains(card) ? 'groove' : 'palette' };
        if (e.pointerType === 'touch') drag.pressTimer = setTimeout(activateDrag, LONG_PRESS_MS);
    }
});

document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.active) {
        const moved = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
        if (drag.pointerType === 'touch') { if (moved > 10) endDrag(false); } // 手指在滑動 = 想捲動頁面
        else if (moved > MOVE_THRESHOLD) activateDrag();
        return;
    }
    moveGhost(); updateDropTarget();
});

document.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
document.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag && drag.active) endDrag(false); });
// 拖曳中禁止頁面捲動（觸控）
document.addEventListener('touchmove', (e) => { if (drag && drag.active) e.preventDefault(); }, { passive: false });
// 觸控長按會觸發 contextmenu，不能讓它跳出「移除任務」
document.addEventListener('contextmenu', (e) => {
    if (drag || lastPointerType === 'touch') { e.preventDefault(); e.stopPropagation(); }
}, true);
// 拖曳結束後的那次 click 不要觸發編輯
document.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); }
}, true);

function activateDrag() {
    const d = drag;
    if (!d || d.active) return;
    d.active = true;
    clearTimeout(d.pressTimer);
    try { document.documentElement.setPointerCapture(d.pointerId); } catch (err) {}
    playTone('lift');
    if (navigator.vibrate) navigator.vibrate(15);
    document.body.classList.add('is-dragging');

    if (d.type === 'category') {
        d.el.classList.add('sort-dragging');
    } else {
        const r = d.el.getBoundingClientRect();
        d.offsetX = d.startX - r.left; d.offsetY = d.startY - r.top;
        d.ghost = d.el.cloneNode(true);
        d.ghost.className = 'task-card drag-ghost';
        d.ghost.style.cssText = `width:${r.width}px;height:${r.height}px;`;
        document.body.appendChild(d.ghost);
        d.el.classList.add('drag-source');
        if (d.origin === 'groove') {
            d.homeNext = d.el.nextSibling; // 放到外面或取消時要回到這裡
        } else {
            d.placeholder = document.createElement('div');
            d.placeholder.className = 'task-card drop-placeholder';
        }
        moveGhost();
    }
    updateDropTarget();
    d.raf = requestAnimationFrame(autoScroll);
}

function moveGhost() {
    if (!drag.ghost) return;
    drag.ghost.style.transform = `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px) scale(1.05)`;
}

function isOverSlot(x, y) {
    const r = slot.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function restoreGrooveCard(d) {
    if (d.el.nextSibling !== d.homeNext) slot.insertBefore(d.el, d.homeNext);
}

function updateDropTarget() {
    const d = drag;
    if (d.type === 'category') {
        const ref = getDragAfterElement(paletteContainer, d.y) || addCatBtn;
        if (d.el.nextElementSibling !== ref) paletteContainer.insertBefore(d.el, ref);
        return;
    }
    // 凹槽內的卡片直接移動本體；任務庫來的卡片用虛線佔位
    const node = d.origin === 'groove' ? d.el : d.placeholder;
    d.overSlot = isOverSlot(d.x, d.y);
    slot.classList.toggle('drag-over', d.overSlot);
    if (d.overSlot) {
        const before = getSlotInsertBefore(d.x, d.y, node);
        if (node.parentNode !== slot || node.nextSibling !== before) slot.insertBefore(node, before);
    } else if (d.origin === 'groove') {
        restoreGrooveCard(d);
    } else {
        d.placeholder.remove();
    }
}

function endDrag(commit) {
    const d = drag; drag = null;
    if (!d) return;
    clearTimeout(d.pressTimer);
    if (!d.active) return;
    cancelAnimationFrame(d.raf);
    suppressClickUntil = Date.now() + 300;
    document.body.classList.remove('is-dragging');
    try { document.documentElement.releasePointerCapture(d.pointerId); } catch (err) {}

    if (d.type === 'category') {
        d.el.classList.remove('sort-dragging');
        playTone('drop');
        saveCategories();
        return;
    }

    d.ghost.remove();
    d.el.classList.remove('drag-source');
    slot.classList.remove('drag-over');
    const dropped = commit && d.overSlot;
    if (d.origin === 'palette') {
        const before = d.placeholder.nextSibling;
        d.placeholder.remove();
        if (dropped) addToSchedule(d.el.querySelector('.task-name').innerText, d.el.dataset.color, true, before);
    } else if (dropped) {
        playTone('drop'); saveSchedule(); // 調整順序
    } else {
        restoreGrooveCard(d); // 放到凹槽外或取消：回到原位，不刪除
    }
}

// 拖到捲動區域邊緣時自動捲動
function autoScroll() {
    if (!drag || !drag.active) return;
    const { x, y } = drag;
    const EDGE = 50, SPEED = 10;
    for (const el of [slot, paletteContainer]) {
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        if (y < r.top + EDGE) el.scrollTop -= SPEED;
        else if (y > r.bottom - EDGE) el.scrollTop += SPEED;
    }
    if (y < EDGE) window.scrollBy(0, -SPEED);
    else if (y > window.innerHeight - EDGE) window.scrollBy(0, SPEED);
    updateDropTarget();
    drag.raf = requestAnimationFrame(autoScroll);
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.category-group:not(.sort-dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// 找出凹槽中應插在哪張卡片之前（桌機為直排，手機為換行橫排）
function getSlotInsertBefore(x, y, exclude) {
    const rowLayout = getComputedStyle(slot).flexDirection === 'row';
    for (const child of slot.children) {
        if (child === exclude) continue;
        const r = child.getBoundingClientRect();
        if (y < r.top) return child;
        if (y <= r.bottom && (rowLayout ? x < r.left + r.width / 2 : y < r.top + r.height / 2)) return child;
    }
    return null;
}

function addToSchedule(name, color, sound = true, before = null) {
    if(sound) playTone('drop');
    const div = document.createElement('div');
    div.className = 'task-card';
    div.dataset.color = color;

    const delBtn = document.createElement('span');
    delBtn.innerHTML = '✕'; delBtn.className = 'delete-icon';
    delBtn.onclick = function() { playTone('delete'); div.style.transform = 'scale(0)'; setTimeout(() => { div.remove(); saveSchedule(); }, 200); };

    const tag = document.createElement('div'); tag.className = 'tag'; tag.style.background = color;
    const text = document.createElement('div'); text.className = 'task-name'; text.innerText = name;

    div.appendChild(delBtn); div.appendChild(tag); div.appendChild(text);
    slot.insertBefore(div, before); saveSchedule();
}

window.clearSchedule = function() { if(confirm('清空今日行程？')) { playTone('click'); slot.innerHTML = ''; saveSchedule(); } };

/* --- 6. 時間記錄與匯出 --- */
function loadLogs() {
    try {
        const logs = JSON.parse(localStorage.getItem(STORAGE_KEY_LOG) || '[]');
        return Array.isArray(logs) ? logs : [];
    } catch (err) { return []; }
}

// 儲存時順便刪掉超過保留天數的記錄
function saveLogs(logs) {
    const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    const kept = logs.filter(l => l.start >= cutoff).sort((a, b) => a.start - b.start);
    storeSet(STORAGE_KEY_LOG, JSON.stringify(kept));
}

function addLog(entry) { const logs = loadLogs(); logs.push(entry); saveLogs(logs); }

function dateKey(ms) { return new Date(ms).toLocaleDateString('sv'); }
function getLogsByDate(date) { return loadLogs().filter(l => dateKey(l.start) === date); }

let logViewDate = todayKey(); // 記錄視窗目前顯示的日期

// 可切換的日期：有記錄的日子，再加上今天
function getLogDates() {
    const dates = new Set(loadLogs().map(l => dateKey(l.start)));
    dates.add(todayKey());
    return [...dates].sort();
}

function weekdayText(date) { return new Date(`${date}T00:00`).toLocaleDateString('zh-TW', { weekday: 'short' }); }

function clockText(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function minutesText(sec) { return Math.round(sec / 6) / 10; } // 換算成分鐘，取到小數一位

function logRow(l) {
    return {
        date: dateKey(l.start),
        start: clockText(l.start), end: clockText(l.end),
        type: modeLabel(l.mode, !!l.countUp),
        task: l.mode === 'focus' ? (l.task || '（未指定）') : '—',
        planned: l.countUp ? '—' : minutesText(l.plannedSec), actual: minutesText(l.actualSec),
        status: !l.completed ? '中斷' : (l.countUp && l.mode === 'focus' ? `完成（${l.pomodoros || 0} 🍅）` : '完成')
    };
}

function summarizeLogs(logs) {
    const focus = logs.filter(l => l.mode === 'focus');
    const byTask = {};
    focus.forEach(l => { const k = l.task || '（未指定）'; byTask[k] = (byTask[k] || 0) + l.actualSec; });
    return {
        focusSec: focus.reduce((sum, l) => sum + l.actualSec, 0),
        breakSec: logs.filter(l => l.mode !== 'focus').reduce((sum, l) => sum + l.actualSec, 0),
        // 正數的一段可能換算成好幾顆
        done: focus.reduce((sum, l) => sum + (l.countUp ? (l.pomodoros || 0) : (l.completed ? 1 : 0)), 0),
        byTask
    };
}

function csvCell(v) {
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // 避免任務名稱被試算表當成公式
    return `"${s.replace(/"/g, '""')}"`;
}

function buildCSV(logs) {
    const header = ['日期', '開始', '結束', '類型', '任務', '預計分鐘', '實際分鐘', '狀態'];
    const rows = logs.map(logRow).map(r => [r.date, r.start, r.end, r.type, r.task, r.planned, r.actual, r.status]);
    // 開頭的 BOM 讓 Excel 正確辨識 UTF-8 中文
    return '﻿' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

function mdCell(v) { return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function buildMarkdown(logs, date) {
    const s = summarizeLogs(logs);
    const lines = [
        `# 蕃茄鐘記錄 ${date}`, '',
        `- 專注：${minutesText(s.focusSec)} 分鐘（完成 ${s.done} 顆）`,
        `- 休息：${minutesText(s.breakSec)} 分鐘`, ''
    ];
    const tasks = Object.entries(s.byTask);
    if (tasks.length) {
        lines.push('## 各任務專注時間', '');
        tasks.forEach(([task, sec]) => lines.push(`- ${mdCell(task)}：${minutesText(sec)} 分鐘`));
        lines.push('');
    }
    lines.push('## 時間軸', '',
        '| 開始 | 結束 | 類型 | 任務 | 預計(分) | 實際(分) | 狀態 |',
        '|---|---|---|---|---:|---:|---|');
    logs.map(logRow).forEach(r =>
        lines.push(`| ${r.start} | ${r.end} | ${r.type} | ${mdCell(r.task)} | ${r.planned} | ${r.actual} | ${r.status} |`));
    return lines.join('\n') + '\n';
}

function renderLogModal() {
    const isToday = logViewDate === todayKey();
    const logs = getLogsByDate(logViewDate);
    const s = summarizeLogs(logs);
    document.getElementById('logTitle').textContent =
        `${isToday ? '今日記錄' : '記錄'}（${logViewDate} ${weekdayText(logViewDate)}）`;
    document.getElementById('logSummary').textContent = logs.length
        ? `專注 ${minutesText(s.focusSec)} 分鐘（完成 ${s.done} 顆）· 休息 ${minutesText(s.breakSec)} 分鐘`
        : '今天還沒有記錄。每段專注或休息結束時會自動寫入。';
    document.getElementById('logPending').style.display = session && isToday ? '' : 'none';

    const dates = getLogDates();
    document.getElementById('logPrev').disabled = !dates.some(d => d < logViewDate);
    document.getElementById('logNext').disabled = !dates.some(d => d > logViewDate);

    const table = document.getElementById('logTable');
    table.innerHTML = '';
    if (!logs.length) return;
    const head = table.createTHead().insertRow();
    ['時間', '類型', '任務', '實際', '狀態'].forEach(h => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
    const body = table.createTBody();
    logs.map(logRow).forEach(r => {
        const tr = body.insertRow();
        if (r.status === '中斷') tr.className = 'interrupted';
        [`${r.start}–${r.end}`, r.type, r.task, `${r.actual} 分`, r.status].forEach(v => { tr.insertCell().textContent = v; });
    });
}

window.openLogModal = function() { logViewDate = todayKey(); renderLogModal(); toggleModal(true, 'logModal'); };

// 跳到前／後一個有記錄的日子
window.shiftLogDate = function(dir) {
    const dates = getLogDates();
    const target = dir < 0 ? dates.filter(d => d < logViewDate).pop() : dates.find(d => d > logViewDate);
    if (!target) return;
    playTone('click');
    logViewDate = target;
    renderLogModal();
};

window.exportLog = function(format) {
    const date = logViewDate;
    const logs = getLogsByDate(date);
    if (!logs.length) { alert('這天沒有記錄'); return; }
    playTone('click');
    if (format === 'csv') downloadFile(`pomodoro_log_${date}.csv`, buildCSV(logs), 'text/csv;charset=utf-8');
    else downloadFile(`pomodoro_log_${date}.md`, buildMarkdown(logs, date), 'text/markdown;charset=utf-8');
};

window.exportAllLogs = function() {
    const logs = loadLogs();
    if (!logs.length) { alert('還沒有任何記錄'); return; }
    playTone('click');
    const from = dateKey(logs[0].start), to = dateKey(logs[logs.length - 1].start);
    downloadFile(`pomodoro_log_${from}_${to}.csv`, buildCSV(logs), 'text/csv;charset=utf-8');
};

window.copyLog = async function() {
    const logs = getLogsByDate(logViewDate);
    if (!logs.length) { alert('這天沒有記錄'); return; }
    const text = buildMarkdown(logs, logViewDate);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch (err) { // 部分環境（例如直接開本機檔案）不支援 Clipboard API，改用舊方法
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;user-select:text;';
        document.body.appendChild(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch (e) {}
        ta.remove();
    }
    playTone('click');
    const btn = document.getElementById('copyLogBtn');
    btn.textContent = ok ? '✓ 已複製' : '複製失敗';
    setTimeout(() => { btn.textContent = '📋 複製'; }, 1500);
};

window.clearLogs = function() {
    if (!confirm(`清除所有時間記錄（含過去 ${LOG_KEEP_DAYS} 天）？此動作無法復原。`)) return;
    storeRemove(STORAGE_KEY_LOG);
    playTone('delete');
    renderLogModal();
};

saveLogs(loadLogs()); // 開啟時清掉過期記錄

/* --- 7. 懸浮小視窗 --- */
let floatingTickerStop = null;

// 懸浮時用 Worker 計時驅動更新：背景分頁的一般計時器會被降頻，Worker 比較不受影響
function startFloatingTicker() {
    if (floatingTickerStop) return;
    const onTick = () => { tick(); updateFloating(); };
    const useInterval = () => { const id = setInterval(onTick, 500); floatingTickerStop = () => clearInterval(id); };
    try {
        const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 500);'], { type: 'text/javascript' }));
        const worker = new Worker(url);
        worker.onmessage = onTick;
        worker.onerror = () => { worker.terminate(); useInterval(); };
        floatingTickerStop = () => worker.terminate();
    } catch (err) { useInterval(); }
}

function stopFloatingTicker() {
    if (pipWindow || videoPip || !floatingTickerStop) return;
    floatingTickerStop(); floatingTickerStop = null;
}

function updateFloating() {
    if (pipWindow) {
        const doc = pipWindow.document;
        doc.body.dataset.mode = mode;
        doc.querySelector('.mini-mode').textContent = modeLabel();
        doc.querySelector('.mini-task').textContent = currentTaskName();
        doc.querySelector('.mini-time').textContent = formatTime(shownSeconds());
        doc.querySelector('[data-act="start"]').textContent = startBtn.textContent;
        doc.querySelector('[data-act="skip"]').textContent = document.getElementById('skipBtn').textContent;
    }
    if (videoPip) drawPipCanvas();
}

window.openFloating = async function() {
    playTone('click');
    if (pipWindow) { pipWindow.focus(); return; }
    if (window.documentPictureInPicture) {
        try { await openDocPip(); return; } catch (err) { /* 失敗就改用影片子母畫面 */ }
    }
    await openVideoPip();
};

// Chrome/Edge：可以放按鈕的置頂小視窗
async function openDocPip() {
    pipWindow = await documentPictureInPicture.requestWindow({ width: 260, height: 170 });
    const doc = pipWindow.document;
    // 把主頁的樣式複製過去；直接開本機檔案時讀不到規則，改用連結載入
    [...document.styleSheets].forEach(sheet => {
        try {
            const style = doc.createElement('style');
            style.textContent = [...sheet.cssRules].map(r => r.cssText).join('\n');
            doc.head.appendChild(style);
        } catch (err) {
            const link = doc.createElement('link');
            link.rel = 'stylesheet'; link.href = sheet.href;
            doc.head.appendChild(link);
        }
    });
    doc.title = '蕃茄鐘';
    doc.body.className = 'mini-body';
    doc.body.innerHTML = `
        <div class="mini">
            <div class="mini-top"><span class="mini-mode"></span><span class="mini-task"></span></div>
            <div class="mini-time"></div>
            <div class="mini-controls">
                <button class="mini-btn" data-act="start"></button>
                <button class="mini-btn" data-act="skip">跳過</button>
            </div>
        </div>`;
    doc.querySelector('[data-act="start"]').addEventListener('click', () => startBtn.click());
    doc.querySelector('[data-act="skip"]').addEventListener('click', () => document.getElementById('skipBtn').click());
    pipWindow.addEventListener('pagehide', () => { pipWindow = null; stopFloatingTicker(); });
    startFloatingTicker();
    updateFloating();
}

// 其他瀏覽器：把時間畫到 canvas，轉成影片後用子母畫面顯示（只能看，不能按）
async function openVideoPip() {
    if (!videoPip) {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const panel = document.createElement('div');
        panel.className = 'video-pip-panel';
        panel.innerHTML = `
            <button class="modal-close" title="關閉懸浮時間">×</button>
            <div class="vp-hint">
                把滑鼠移到下方畫面上，按右側出現的「子母畫面」按鈕（或按 <b>Ctrl+Shift+]</b>），時間就會浮在所有視窗上方。<br>
                這個面板要留著，關掉會一起關閉懸浮時間。
            </div>`;
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.autoplay = true;
        panel.appendChild(video);
        document.body.appendChild(panel);
        panel.querySelector('.modal-close').onclick = () => closeVideoPip();

        videoPip = { canvas, video, panel, stream: null };
        drawPipCanvas(); // 先畫一張，串流才有畫面
        videoPip.stream = canvas.captureStream();
        video.srcObject = videoPip.stream;
        // 子母畫面裡的暫停鍵不控制計時；被暫停就繼續播放，避免時間停住
        video.addEventListener('pause', () => { if (videoPip) video.play().catch(() => {}); });
        // 用 API 開的子母畫面被關掉時，一併收掉
        video.addEventListener('leavepictureinpicture', () => {
            if (videoPip && !videoPip.panel.classList.contains('show')) closeVideoPip();
        });
        startFloatingTicker();
    }
    try { await videoPip.video.play(); } catch (err) {}
    if (document.pictureInPictureEnabled && videoPip.video.requestPictureInPicture) {
        try { await videoPip.video.requestPictureInPicture(); return; } catch (err) {}
    }
    // Firefox 沒有開啟子母畫面的 API，請使用者自己按影片上的按鈕
    videoPip.panel.classList.add('show');
}

window.closeVideoPip = function() {
    const vp = videoPip;
    if (!vp) return;
    videoPip = null;
    if (document.pictureInPictureElement === vp.video) document.exitPictureInPicture().catch(() => {});
    vp.stream.getTracks().forEach(t => t.stop());
    vp.panel.remove();
    stopFloatingTicker();
};

// 文字太長時截斷並加上「…」
function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length && ctx.measureText(text + '…').width > maxWidth) text = text.slice(0, -1);
    return text + '…';
}

function drawPipCanvas() {
    const { canvas } = videoPip;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const accent = getComputedStyle(document.body).getPropertyValue('--accent-color').trim() || '#ff6b6b';
    const font = '"Helvetica Neue", Arial, "Microsoft JhengHei", sans-serif';

    ctx.fillStyle = '#e0e5ec'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 14);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    const task = currentTaskName();
    ctx.font = `bold 36px ${font}`; ctx.fillStyle = accent;
    ctx.fillText(fitText(ctx, task ? `${modeLabel()} · ${task}` : modeLabel(), W - 60), W / 2, 70);

    ctx.font = `300 170px ${font}`; ctx.fillStyle = '#4a4a4a';
    ctx.fillText(formatTime(shownSeconds()), W / 2, 195);

    ctx.font = `30px ${font}`; ctx.fillStyle = '#888';
    ctx.fillText(isRunning ? '▶ 計時中' : (session ? '⏸ 已暫停' : '等待開始'), W / 2, 315);
}

/* --- 8. 給同步模組 (sync.js) 用的介面 --- */
window.pomodoroApp = {
    keys: { categories: STORAGE_KEY_CATS, schedule: STORAGE_KEY_SCHED, timer: STORAGE_KEY_TIMER, stats: STORAGE_KEY_STATS, logs: STORAGE_KEY_LOG },
    loadLogs, saveLogs,

    // 預設類別還沒存過時先存起來，才有東西可以上傳
    ensureSaved() { if (!localStorage.getItem(STORAGE_KEY_CATS)) saveCategories(); },

    // 雲端的新資料已寫進 localStorage，依種類更新畫面
    applyRemote(key) {
        // 正在拖曳或編輯類別名稱時先不重畫，稍後再套用
        if (drag || paletteContainer.contains(document.activeElement)) {
            setTimeout(() => this.applyRemote(key), 1000);
            return;
        }
        if (key === STORAGE_KEY_CATS) renderCategoriesFromStorage();
        else if (key === STORAGE_KEY_SCHED) renderScheduleFromStorage();
        else if (key === STORAGE_KEY_STATS) updateModeUI();
        else if (key === STORAGE_KEY_LOG) {
            if (document.getElementById('logModal').classList.contains('show')) renderLogModal();
        } else if (key === STORAGE_KEY_TIMER) {
            const incoming = loadTimerSettings();
            if (session) incoming.countUp = timerSettings.countUp; // 進行中的這一段不切換倒數／正數
            Object.assign(timerSettings, incoming);
            if (!session && !isRunning) { timeLeft = timerSettings[mode]; elapsed = 0; }
            updateModeUI(); updateDisplay();
        }
    }
};

window.addEventListener('DOMContentLoaded', initApp);
