/* --- 偏好設定（只存在這台裝置，不同步）：外觀、音量、常駐通知 --- */
const STORAGE_KEY_PREFS = 'pomodoro_prefs_v1';
const IS_TOUCH = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
const prefs = loadPrefs();
function loadPrefs() {
    const defaults = { theme: 'auto', volume: 1, statusNotify: IS_TOUCH };
    try {
        const p = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS) || '{}');
        return { ...defaults, ...(p && typeof p === 'object' ? p : {}) };
    } catch (err) { return defaults; }
}
function savePrefs() { localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(prefs)); }

const darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function resolvedTheme() {
    if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
}
function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#2b2f36' : '#e0e5ec';
}
applyTheme();
if (darkQuery) darkQuery.addEventListener('change', () => { applyTheme(); refreshThemeDependents(); });

/* --- 0. 音效系統 --- */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playTone(type) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const volume = Number(prefs.volume);
    if (!(volume > 0)) return; // 靜音
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    const master = audioCtx.createGain();
    master.gain.value = Math.min(volume, 1);
    osc.connect(gainNode);
    gainNode.connect(master);
    master.connect(audioCtx.destination);
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
const STORAGE_KEY_STATE = 'pomodoro_state_v5'; // 計時狀態，重新整理後可接續
const STORAGE_KEY_LOG = 'pomodoro_log_v1';     // 時間記錄
const LOG_KEEP_DAYS = 365;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/* 資料檢查：匯入的檔案與雲端來的資料都先過這裡，格式不對的部分直接丟掉 */
function cleanText(v, max = 200) { return typeof v === 'string' ? v.slice(0, max) : ''; }
// 顏色只接受 #hex 或 rgb()/rgba()，避免被塞進奇怪的 CSS
function cleanColor(v) {
    const m = typeof v === 'string' && v.trim().match(/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))(\s|$)/i);
    return m ? m[1] : '#999999';
}
function cleanCategories(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 100).filter(c => c && typeof c === 'object').map(c => ({
        title: cleanText(c.title, 100) || '未命名',
        color: cleanColor(c.color),
        tasks: (Array.isArray(c.tasks) ? c.tasks : []).slice(0, 300).map(t => cleanText(t)).filter(Boolean)
    }));
}
function cleanSchedule(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 500).filter(t => t && typeof t === 'object' && cleanText(t.name))
        .map(t => {
            const item = { name: cleanText(t.name), color: cleanColor(t.color) };
            if (t.done) { item.done = true; item.doneAt = Number.isFinite(t.doneAt) ? t.doneAt : Date.now(); }
            return item;
        });
}
const LOG_MODES = ['focus', 'short', 'long'];
function cleanLog(l) {
    if (!l || typeof l !== 'object' || !Number.isFinite(l.start) || !LOG_MODES.includes(l.mode)) return null;
    const num = (v, d = 0) => Number.isFinite(v) && v >= 0 ? v : d;
    const entry = {
        start: l.start, end: num(l.end, l.start), mode: l.mode, task: cleanText(l.task),
        plannedSec: num(l.plannedSec), actualSec: num(l.actualSec), completed: !!l.completed
    };
    if (l.countUp) { entry.countUp = true; entry.pomodoros = Math.floor(num(l.pomodoros)); }
    return entry;
}
function readStoredJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (err) { return null; }
}

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
        categories: readStoredJSON(STORAGE_KEY_CATS) || [],
        schedule: readStoredJSON(STORAGE_KEY_SCHED) || [],
        logs: loadLogs(),
        timestamp: new Date().toISOString()
    };
    downloadFile(`pomodoro_backup_${todayKey()}.json`, JSON.stringify(data, null, 2), 'application/json');
};

window.importData = function(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = ''; // 讓同一個檔案可以再選一次
    if (file.size > MAX_IMPORT_BYTES) { alert('檔案太大，不是這個網頁匯出的備份檔。'); return; }
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('format');
            const hasCats = Array.isArray(data.categories), hasSched = Array.isArray(data.schedule), hasLogs = Array.isArray(data.logs);
            if (!hasCats && !hasSched && !hasLogs) throw new Error('format');
            if (hasCats) storeSet(STORAGE_KEY_CATS, JSON.stringify(cleanCategories(data.categories)));
            if (hasSched) storeSet(STORAGE_KEY_SCHED, JSON.stringify(cleanSchedule(data.schedule)));
            if (hasLogs) { // 記錄用合併，避免蓋掉這台裝置自己的記錄
                const logs = loadLogs();
                const seen = new Set(logs.map(l => `${l.start}|${l.mode}`));
                data.logs.map(cleanLog).filter(Boolean).forEach(l => {
                    if (!seen.has(`${l.start}|${l.mode}`)) { seen.add(`${l.start}|${l.mode}`); logs.push(l); }
                });
                saveLogs(logs);
            }
            if (window.pomodoroSync) await window.pomodoroSync.flush(); // 重新整理前先把匯入的資料傳上雲端
            alert('匯入成功！'); location.reload();
        } catch (err) { alert('檔案格式不對，沒有匯入任何資料。'); }
    };
    reader.readAsText(file);
};

/* --- 2. 蕃茄鐘（專注／休息循環） --- */
const MODE_LABELS = { focus: '專注', short: '短休息', long: '長休息' };
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
let attentionTimer = null; let attentionOn = false; // 時間到時讓分頁標題閃爍
let toastTimer = null;
let wakeLock = null;  // 計時中不讓螢幕自動關閉
let logCache = { raw: null, logs: [] }; // 時間記錄的解析快取，見 loadLogs
let lastTimesRefresh = 0; // 上次更新行程卡片「今日已花時間」的時間點
let statusSig = '';       // 目前顯示中的常駐通知內容，內容沒變就不重發
const NOTIFY_TAG = 'pomodoro-phase';   // 「時間到」的通知
const STATUS_TAG = 'pomodoro-status';  // 計時中的常駐通知

const timeDisplay = document.getElementById('time');
const startBtn = document.getElementById('startBtn');

function loadTimerSettings() {
    const defaults = { focus: 25 * 60, short: 5 * 60, long: 15 * 60, countUp: false, longEvery: 4, autoStart: false };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY_TIMER) || '{}') }; }
    catch (err) { return defaults; }
}
function saveTimerSettings() { storeSet(STORAGE_KEY_TIMER, JSON.stringify(timerSettings)); }
// 每完成幾顆蕃茄換一次長休息
function longEvery() {
    const n = Math.round(Number(timerSettings.longEvery));
    return n >= 2 && n <= 8 ? n : 4;
}

function todayKey() { return new Date().toLocaleDateString('sv'); } // 本地時區的 YYYY-MM-DD
// 一筆專注記錄換算成幾顆蕃茄（正數的一段可能換算成好幾顆）
function pomodorosOf(l) {
    if (l.mode !== 'focus') return 0;
    return l.countUp ? (l.pomodoros || 0) : (l.completed ? 1 : 0);
}
// 今日蕃茄數直接從時間記錄算（以結束時間為準，跨午夜的那顆算在結束的那天）。
// 記錄是逐筆同步的，兩台裝置各自完成的蕃茄會加總，不會互相覆蓋。
function getTodayCount() {
    const today = todayKey();
    return loadLogs().reduce((sum, l) => sum + (dateKey(l.end) === today ? pomodorosOf(l) : 0), 0);
}

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
    document.title = attentionOn ? '🔔 時間到！' : `${text} - ${modeLabel()}`;
    updateFloating();
}

// 目前這一段的進度 0–1。倒數：已過時間／預計時長；正數專注：距離下一顆蕃茄
function phaseProgress() {
    if (isCountUp()) return mode === 'focus' ? (elapsed % timerSettings.focus) / timerSettings.focus : 0;
    const planned = session && session.plannedSec ? session.plannedSec : timerSettings[mode];
    return planned > 0 ? Math.min(1, Math.max(0, 1 - timeLeft / planned)) : 0;
}

/* 時間到的提醒：不再跳出會卡住頁面的對話框，改成畫面上的提示列、分頁標題閃爍與系統通知 */
function showToast(msg, actionLabel, onAction, duration = 15000) {
    const toast = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
    const btn = document.getElementById('toastAction');
    btn.style.display = actionLabel ? '' : 'none';
    btn.textContent = actionLabel || '';
    btn.onclick = () => { hideToast(); if (onAction) onAction(); };
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, duration);
}
function hideToast() {
    clearTimeout(toastTimer);
    document.getElementById('toast').classList.remove('show');
}

function startAttention() {
    stopAttention();
    attentionOn = true; updateDisplay();
    attentionTimer = setInterval(() => { attentionOn = !attentionOn; updateDisplay(); }, 1000);
}
function stopAttention() {
    if (!attentionTimer) return;
    clearInterval(attentionTimer); attentionTimer = null;
    attentionOn = false; updateDisplay();
}

function requestNotifyPermission() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try {
        const p = Notification.requestPermission();
        if (p && p.then) p.then(() => { statusSig = ''; updateStatusNotification(); }).catch(() => {});
    } catch (err) {}
}
async function getSwRegistration() {
    try { return 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null; }
    catch (err) { return null; }
}
async function notify(body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const options = { body, tag: NOTIFY_TAG, renotify: true, icon: 'icons/icon-192.png' };
    const reg = await getSwRegistration();
    // 手機瀏覽器只能透過 service worker 發通知
    if (reg && reg.active) { try { await reg.showNotification('蕃茄鐘', options); return; } catch (err) {} }
    try {
        const n = new Notification('蕃茄鐘', options);
        n.onclick = () => { window.focus(); n.close(); startFromPrompt(); };
    } catch (err) {}
}
async function clearNotifications() {
    const reg = await getSwRegistration();
    if (!reg || !reg.getNotifications) return;
    try { (await reg.getNotifications({ tag: NOTIFY_TAG })).forEach(n => n.close()); } catch (err) {}
}

// 從提示列或通知按下去：開始已經切好的下一段
function startFromPrompt() { if (!isRunning) startTimer(); }

// started = true：已經自動開始下一段，提示列就不用「開始」按鈕
function announce(msg, started) {
    playTone('alarm');
    setTimeout(() => playTone('alarm'), 700);
    setTimeout(() => playTone('alarm'), 1400);
    showToast(msg, started ? null : '開始', startFromPrompt);
    if (document.hidden || !document.hasFocus()) { startAttention(); notify(msg); }
}

async function updateWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (isRunning && !document.hidden) {
        if (wakeLock) return;
        try {
            const lock = await navigator.wakeLock.request('screen');
            if (wakeLock || !isRunning) { lock.release().catch(() => {}); return; }
            wakeLock = lock;
            lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
        } catch (err) { /* 省電模式等情況會被拒絕，不影響計時 */ }
    } else if (wakeLock) {
        const lock = wakeLock; wakeLock = null;
        lock.release().catch(() => {});
    }
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
    let filled = count % longEvery();
    if (filled === 0 && count > 0 && mode === 'long') filled = longEvery(); // 長休息時顯示滿格
    document.getElementById('cycleDots').innerHTML = Array.from({ length: longEvery() },
        (_, i) => `<span class="dot${i < filled ? ' filled' : ''}"></span>`).join('');
    document.getElementById('pomoCount').innerText = `今日 ${count} 🍅`;
    updateCurrentTask();
}

// 目前任務 = 凹槽第一張卡片
function getCurrentTask() {
    const first = document.querySelector('#scheduleSlot .task-card:not(.drop-placeholder):not(.done) .task-name');
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
    // 標出行程裡的目前任務（第一張還沒完成的）
    const cards = [...document.querySelectorAll('#scheduleSlot .task-card:not(.drop-placeholder)')];
    const current = cards.find(c => !c.classList.contains('done'));
    cards.forEach(c => c.classList.toggle('current', c === current));
    refreshScheduleTimes();
    updateFloating();
}

// 今天各任務已經專注的秒數（含正在進行的這一段）
function todayTaskSeconds() {
    const today = todayKey();
    const map = {};
    loadLogs().forEach(l => {
        if (l.mode === 'focus' && l.task && dateKey(l.start) === today) map[l.task] = (map[l.task] || 0) + l.actualSec;
    });
    if (session && session.mode === 'focus' && session.task) {
        const live = session.activeMs + (isRunning ? Date.now() - session.segStart : 0);
        map[session.task] = (map[session.task] || 0) + Math.round(live / 1000);
    }
    return map;
}
function refreshScheduleTimes() {
    lastTimesRefresh = Date.now();
    const map = todayTaskSeconds();
    document.querySelectorAll('#scheduleSlot .task-card:not(.drop-placeholder)').forEach(card => {
        const el = card.querySelector('.task-time');
        if (!el) return;
        const sec = map[card.querySelector('.task-name').innerText] || 0;
        el.textContent = sec >= 60 ? `${Math.round(sec / 60)} 分` : '';
    });
}

function saveTimerState() {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify({ mode, timeLeft, endTime, elapsed, countStart, isRunning, session }));
    updateStatusNotification();
}

// 計時中的常駐通知。網頁到背景後會被系統暫停，沒辦法每秒更新，
// 所以顯示不會過時的資訊：倒數顯示「幾點結束」，正數顯示「幾點開始」
async function updateStatusNotification() {
    let title = '', body = '';
    if (prefs.statusNotify && session && 'Notification' in window && Notification.permission === 'granted') {
        const label = modeLabel(session.mode, !!session.countUp);
        if (isRunning) {
            title = session.countUp ? `${label}中 · ${clockText(session.start)} 開始` : `${label}中 · ${clockText(endTime)} 結束`;
        } else {
            title = session.countUp ? `${label}已暫停 · 已過 ${formatTime(elapsed)}` : `${label}已暫停 · 剩 ${formatTime(timeLeft)}`;
        }
        body = session.mode === 'focus' ? (session.task || '未指定任務') : '休息時間';
    }
    const sig = `${title}|${body}`;
    if (sig === statusSig) return;
    statusSig = sig;
    const reg = await getSwRegistration();
    if (!reg || !reg.active) return;
    try {
        if (!title) { (await reg.getNotifications({ tag: STATUS_TAG })).forEach(n => n.close()); return; }
        await reg.showNotification(title, { body, tag: STATUS_TAG, silent: true, renotify: false, icon: 'icons/icon-192.png' });
    } catch (err) {}
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
    if (Date.now() - lastTimesRefresh > 30000) refreshScheduleTimes();
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
    hideToast(); stopAttention(); clearNotifications(); updateWakeLock();
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
    updateWakeLock();
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
    endSession(true); // 寫入記錄後，今日蕃茄數就會包含這次的
    let next = 'focus';
    if (mode === 'focus') {
        const after = before + earned;
        // 這次跨過 4 的倍數就進長休息
        next = earned && Math.floor(after / longEvery()) > Math.floor(before / longEvery()) ? 'long' : 'short';
    }
    switchMode(next);
}

// completed = true 表示這段是自然結束（計入完成數）；false 表示按了「跳過」
function advancePhase(completed) {
    let next = 'focus';
    if (mode === 'focus') {
        const count = getTodayCount(); // 自然結束時，剛完成的這顆已經寫入記錄
        next = (completed && count > 0 && count % longEvery() === 0) ? 'long' : 'short';
    }
    switchMode(next);
}

function finishPhase() {
    const finished = mode;
    stopTimer(); endSession(true);
    advancePhase(true); // 切到下一段；預設停在那裡等使用者按開始
    const auto = !!timerSettings.autoStart;
    if (auto) startTimer();
    announce(finished === 'focus'
        ? `專注結束！接下來是${MODE_LABELS[mode]}（${formatTime(timerSettings[mode])}）`
        : (auto ? '休息結束，下一顆蕃茄開始了！' : '休息結束，準備開始下一顆蕃茄！'), auto);
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
    requestNotifyPermission(); // 第一次按開始時詢問是否允許通知（瀏覽器規定要由點擊觸發）
    toggleTimer();
});
function toggleTimer() {
    if (isRunning) { stopTimer(); setStartBtn('resume'); updateDisplay(); saveTimerState(); }
    else startTimer();
}
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
document.addEventListener('visibilitychange', () => {
    tick(); // 切回分頁時立即校正畫面
    if (!document.hidden) stopAttention();
    updateWakeLock(); // 分頁到背景時螢幕鎖會被系統收回，回來時重新取得
});
window.addEventListener('focus', stopAttention);
// 鍵盤快捷鍵：空白鍵開始／暫停、S 跳過、R 重置（打字或視窗開著時不作用）
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (document.querySelector('.modal-overlay.show')) return;
    if (e.code === 'Space') {
        if (t.closest && t.closest('button')) return; // 焦點在按鈕上時，空白鍵本來就會按下那個按鈕
        e.preventDefault(); startBtn.click();
    } else if (e.code === 'KeyS') document.getElementById('skipBtn').click();
    else if (e.code === 'KeyR') document.getElementById('resetBtn').click();
});
document.addEventListener('pointerdown', stopAttention);
document.getElementById('toastClose').addEventListener('click', hideToast);
if ('serviceWorker' in navigator) {
    // 點了系統通知：service worker 會把視窗叫到前面，再通知這裡開始下一段
    navigator.serviceWorker.addEventListener('message', (e) => {
        if (!e.data || e.data.type !== 'notification-click') return;
        // 點常駐通知只是回到網頁（系統會把通知收掉，這裡補發一則）；點「時間到」的通知才開始下一段
        if (e.data.tag === STATUS_TAG) { statusSig = ''; updateStatusNotification(); }
        else startFromPrompt();
    });
    if (location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

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
    updateStatusNotification();
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
        const item = { name: card.querySelector('.task-name').innerText, color: card.dataset.color || card.querySelector('.tag').style.background };
        if (card.classList.contains('done')) { item.done = true; item.doneAt = Number(card.dataset.doneAt) || Date.now(); }
        schedule.push(item);
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
    const items = cleanSchedule(readStoredJSON(STORAGE_KEY_SCHED));
    const today = todayKey();
    const kept = items.filter(t => !(t.done && dateKey(t.doneAt) !== today)); // 前幾天完成的任務清掉
    kept.forEach(t => appendScheduleCard(t.name, t.color, null, t.done ? t.doneAt : null));
    if (kept.length !== items.length) saveSchedule();
    updateCurrentTask();
}

function renderCategoriesFromStorage() {
    paletteContainer.querySelectorAll('.category-group').forEach(g => g.remove());
    const savedCats = readStoredJSON(STORAGE_KEY_CATS);
    if (Array.isArray(savedCats)) {
        cleanCategories(savedCats).forEach(cat => createCategoryDOM(cat.title, cat.color, cat.tasks));
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
    delCatBtn.onclick = () => withUndo(STORAGE_KEY_CATS, `已刪除類別「${title.innerText}」`, () => { group.remove(); saveCategories(); });
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
    addBtn.title = '新增任務';
    addBtn.onclick = () => { playTone('click'); const card = createTaskDOM(grid, '新任務', color); saveCategories(); editTaskName(card); };

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
    card.title = '點一下排入今日行程';

    // 點卡片 = 排入行程；改名和刪除走右上角的 ✎
    card.onclick = () => {
        if (card.querySelector('input')) return;
        addToSchedule(card.querySelector('.task-name').innerText, card.dataset.color);
        card.classList.remove('added'); void card.offsetWidth; card.classList.add('added');
    };
    card.oncontextmenu = (e) => { e.preventDefault(); removePaletteTask(card); };

    const edit = document.createElement('span');
    edit.className = 'edit-icon'; edit.textContent = '✎'; edit.title = '改名（清空即刪除）';
    edit.onclick = (e) => { e.stopPropagation(); playTone('click'); editTaskName(card); };

    const tag = document.createElement('div');
    tag.className = 'tag'; tag.style.background = color;
    const text = document.createElement('div');
    text.className = 'task-name'; text.innerText = name;
    card.appendChild(edit); card.appendChild(tag); card.appendChild(text);

    card.style.opacity = 0; container.appendChild(card);
    requestAnimationFrame(() => { card.style.transition = 'opacity 0.3s'; card.style.opacity = 1; });
    return card;
}

function removePaletteTask(card) {
    const name = card.querySelector('.task-name').innerText;
    withUndo(STORAGE_KEY_CATS, `已從任務庫移除「${name}」`, () => { card.remove(); saveCategories(); });
}

function editTaskName(card) {
    if (card.querySelector('input')) return;
    const nameEl = card.querySelector('.task-name');
    inlineEdit(nameEl, 'task-edit-input', (value) => {
        if (value === '') removePaletteTask(card);
        else { nameEl.innerText = value; saveCategories(); }
    });
}

// 把一段文字暫時換成輸入框：Enter 或點到別處確定，Esc 取消
function inlineEdit(el, className, onCommit, initial = el.innerText) {
    const input = document.createElement('input');
    input.className = className; input.value = initial; input.maxLength = 200;
    el.style.display = 'none';
    el.parentNode.insertBefore(input, el.nextSibling);
    let finished = false;
    const finish = (commit) => {
        if (finished) return;
        finished = true;
        const value = input.value.trim();
        input.remove(); el.style.display = '';
        if (commit && value !== initial) onCommit(value);
    };
    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.focus(); input.select();
}

/* 可復原的刪除：先記下這份資料原本的內容，動手後在提示列給「復原」 */
function withUndo(key, msg, mutate) {
    if (key === STORAGE_KEY_CATS && localStorage.getItem(key) === null) saveCategories(); // 預設類別還沒存過
    const before = localStorage.getItem(key);
    mutate();
    playTone('delete');
    showToast(msg, '復原', () => {
        if (before === null) storeRemove(key); else storeSet(key, before);
        rerenderKey(key);
    }, 7000);
}
function rerenderKey(key) {
    if (key === STORAGE_KEY_CATS) renderCategoriesFromStorage();
    else if (key === STORAGE_KEY_SCHED) renderScheduleFromStorage();
    else if (key === STORAGE_KEY_LOG) {
        updateModeUI(); // 今日蕃茄數與各任務時間都是從記錄算的
        if (document.getElementById('logModal').classList.contains('show')) renderLogModal();
        if (document.getElementById('statsModal').classList.contains('show')) renderStats();
    }
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
    } else if (card && !e.target.closest('.delete-icon, .done-icon, .edit-icon, input')) {
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
    // 沒指定位置（點一下加入）就排在還沒完成的任務最後、已完成的前面
    appendScheduleCard(name, color, before || slot.querySelector('.task-card.done'));
    saveSchedule();
}

// 只建立卡片、不存檔（從儲存的資料重畫時用，避免把剛收到的雲端資料又當成本機修改傳回去）
function appendScheduleCard(name, color, before = null, doneAt = null) {
    const div = document.createElement('div');
    div.className = 'task-card';
    div.dataset.color = color;
    if (doneAt) { div.classList.add('done'); div.dataset.doneAt = doneAt; }

    const delBtn = document.createElement('span');
    delBtn.textContent = '✕'; delBtn.className = 'delete-icon'; delBtn.title = '從行程移除';
    delBtn.onclick = () => withUndo(STORAGE_KEY_SCHED, `已從行程移除「${name}」`, () => { div.remove(); saveSchedule(); });

    const doneBtn = document.createElement('span');
    doneBtn.textContent = '✓'; doneBtn.className = 'done-icon'; doneBtn.title = '完成／取消完成';
    doneBtn.onclick = () => toggleDone(div);

    const tag = document.createElement('div'); tag.className = 'tag'; tag.style.background = color;
    const text = document.createElement('div'); text.className = 'task-name'; text.innerText = name;
    const time = document.createElement('div'); time.className = 'task-time';

    div.appendChild(delBtn); div.appendChild(doneBtn); div.appendChild(tag); div.appendChild(text); div.appendChild(time);
    slot.insertBefore(div, before);
    return div;
}

// 完成的任務劃掉並移到最下面；再按一次取消，回到未完成的最後
function toggleDone(card) {
    const done = !card.classList.contains('done');
    if (done) {
        card.classList.add('done');
        card.dataset.doneAt = Date.now();
        slot.appendChild(card);
        playTone('drop');
    } else {
        card.classList.remove('done');
        delete card.dataset.doneAt;
        slot.insertBefore(card, slot.querySelector('.task-card.done'));
        playTone('click');
    }
    saveSchedule();
}

window.clearSchedule = function() {
    if (!slot.querySelector('.task-card')) return;
    withUndo(STORAGE_KEY_SCHED, '已清空今日行程', () => { slot.innerHTML = ''; saveSchedule(); });
};

/* --- 6. 時間記錄與匯出 --- */
// 記錄一年可能有幾千筆，解析結果快取起來（logCache），內容沒變就不重新解析
function loadLogs() {
    const raw = localStorage.getItem(STORAGE_KEY_LOG);
    if (raw !== logCache.raw) {
        let logs = [];
        try { const parsed = JSON.parse(raw || '[]'); if (Array.isArray(parsed)) logs = parsed.map(cleanLog).filter(Boolean); } catch (err) {}
        logCache = { raw, logs };
    }
    return logCache.logs.slice();
}

// 儲存時順便刪掉超過保留天數的記錄
function saveLogs(logs) {
    const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    const kept = logs.map(cleanLog).filter(l => l && l.start >= cutoff).sort((a, b) => a.start - b.start);
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
        done: focus.reduce((sum, l) => sum + pomodorosOf(l), 0),
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
    ['時間', '類型', '任務', '實際', '狀態', ''].forEach(h => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
    const body = table.createTBody();
    logs.forEach(l => {
        const r = logRow(l);
        const tr = body.insertRow();
        if (r.status === '中斷') tr.className = 'interrupted';
        tr.insertCell().textContent = `${r.start}–${r.end}`;
        tr.insertCell().textContent = r.type;
        const taskCell = tr.insertCell(); taskCell.className = 'log-task';
        const taskText = document.createElement('span'); taskText.textContent = r.task; taskCell.appendChild(taskText);
        if (l.mode === 'focus') { // 專注的任務名稱可以點一下修改
            taskCell.classList.add('editable'); taskCell.title = '點一下修改任務名稱';
            taskCell.onclick = () => editLogTask(l, taskText);
        }
        tr.insertCell().textContent = `${r.actual} 分`;
        tr.insertCell().textContent = r.status;
        const del = tr.insertCell(); del.className = 'log-del'; del.textContent = '✕'; del.title = '刪除這一筆';
        del.onclick = () => deleteLog(l);
    });
}

const sameLog = (a, b) => a.start === b.start && a.mode === b.mode;

function editLogTask(l, textEl) {
    if (textEl.parentNode.querySelector('input')) return;
    inlineEdit(textEl, 'log-edit-input', (value) => {
        const logs = loadLogs();
        const target = logs.find(x => sameLog(x, l));
        if (!target) return;
        target.task = value;
        // 同步是用「開始時間＋類型」辨識每一筆。內容改了就把開始時間挪 1 毫秒換一個編號，
        // 其他裝置才會把它當成新的一筆收下來（舊的那筆會被刪掉）
        let start = target.start + 1;
        while (logs.some(x => x !== target && x.mode === target.mode && x.start === start)) start++;
        target.start = start;
        saveLogs(logs);
        rerenderKey(STORAGE_KEY_LOG);
    }, l.task || '');
}

function deleteLog(l) {
    withUndo(STORAGE_KEY_LOG, '已刪除一筆記錄', () => {
        saveLogs(loadLogs().filter(x => !sameLog(x, l)));
        rerenderKey(STORAGE_KEY_LOG);
    });
}

/* --- 每週統計 --- */
let statsEnd = todayKey(); // 目前顯示的這 7 天的最後一天

function addDays(date, n) {
    const d = new Date(`${date}T00:00`);
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('sv');
}
const shortDate = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

function statsRow(name, sec, maxSec, color) {
    const row = document.createElement('div'); row.className = 'stats-row';
    const n = document.createElement('span'); n.className = 'stats-row-name'; n.textContent = name;
    const v = document.createElement('span'); v.className = 'stats-row-val'; v.textContent = `${minutesText(sec)} 分`;
    const track = document.createElement('div'); track.className = 'stats-row-track';
    const fill = document.createElement('div'); fill.className = 'stats-row-fill';
    fill.style.width = `${maxSec ? Math.max(2, sec / maxSec * 100) : 0}%`;
    fill.style.background = color;
    track.appendChild(fill);
    row.appendChild(n); row.appendChild(v); row.appendChild(track);
    return row;
}

function fillStatsList(id, entries) {
    const box = document.getElementById(id);
    box.innerHTML = '';
    if (!entries.length) {
        const empty = document.createElement('div'); empty.className = 'stats-empty'; empty.textContent = '這一週沒有專注記錄';
        box.appendChild(empty);
        return;
    }
    const max = entries[0].sec;
    entries.forEach(e => box.appendChild(statsRow(e.name, e.sec, max, e.color)));
}

function renderStats() {
    const today = todayKey();
    const days = Array.from({ length: 7 }, (_, i) => addDays(statsEnd, i - 6));
    const from = days[0];
    const allFocus = loadLogs().filter(l => l.mode === 'focus');
    const logs = allFocus.filter(l => { const d = dateKey(l.start); return d >= from && d <= statsEnd; });

    // 任務屬於哪個類別：用目前任務庫的名稱對照，找不到的歸到「其他」
    const taskCat = {};
    cleanCategories(readStoredJSON(STORAGE_KEY_CATS) || []).forEach(c => c.tasks.forEach(t => { if (!taskCat[t]) taskCat[t] = c; }));

    const perDay = Object.fromEntries(days.map(d => [d, { sec: 0, pomo: 0 }]));
    const byTask = {}, byCat = {};
    logs.forEach(l => {
        const day = perDay[dateKey(l.start)];
        day.sec += l.actualSec; day.pomo += pomodorosOf(l);
        const cat = taskCat[l.task];
        const taskName = l.task || '（未指定）';
        if (!byTask[taskName]) byTask[taskName] = { name: taskName, sec: 0, color: cat ? cat.color : '#999999' };
        byTask[taskName].sec += l.actualSec;
        const catName = cat ? cat.title : '其他';
        if (!byCat[catName]) byCat[catName] = { name: catName, sec: 0, color: cat ? cat.color : '#999999' };
        byCat[catName].sec += l.actualSec;
    });

    const totalSec = logs.reduce((sum, l) => sum + l.actualSec, 0);
    const totalPomo = logs.reduce((sum, l) => sum + pomodorosOf(l), 0);
    const activeDays = days.filter(d => perDay[d].sec > 0).length;
    document.getElementById('statsTitle').textContent = `每週統計（${shortDate(from)} – ${shortDate(statsEnd)}）`;
    document.getElementById('statsSummary').textContent = totalSec
        ? `專注 ${minutesText(totalSec)} 分鐘 · ${totalPomo} 🍅 · 有記錄的 ${activeDays} 天平均每天 ${minutesText(totalSec / activeDays)} 分鐘`
        : '這一週沒有專注記錄。';
    document.getElementById('statsPrev').disabled = !allFocus.some(l => dateKey(l.start) < from);
    document.getElementById('statsNext').disabled = statsEnd >= today;

    const chart = document.getElementById('statsChart');
    chart.innerHTML = '';
    const maxSec = Math.max(...days.map(d => perDay[d].sec), 1);
    days.forEach(d => {
        const { sec, pomo } = perDay[d];
        const col = document.createElement('div');
        col.className = 'stats-col' + (sec ? '' : ' empty') + (d === today ? ' today' : '');
        const value = document.createElement('div'); value.className = 'stats-value';
        value.textContent = sec ? `${Math.round(sec / 60)}分` : '';
        const bar = document.createElement('div'); bar.className = 'stats-bar';
        bar.style.height = `${Math.round(sec / maxSec * 100)}px`;
        const label = document.createElement('div'); label.className = 'stats-day';
        label.textContent = `${weekdayText(d)} ${shortDate(d)}`;
        const pomoEl = document.createElement('div'); pomoEl.className = 'stats-day';
        pomoEl.textContent = pomo ? `${pomo}🍅` : ' ';
        col.appendChild(value); col.appendChild(bar); col.appendChild(label); col.appendChild(pomoEl);
        chart.appendChild(col);
    });

    const sorted = obj => Object.values(obj).sort((a, b) => b.sec - a.sec);
    fillStatsList('statsTasks', sorted(byTask).slice(0, 12));
    fillStatsList('statsCats', sorted(byCat));
}

window.openStatsModal = function() { statsEnd = todayKey(); renderStats(); toggleModal(true, 'statsModal'); };
function shiftStats(dir) {
    const next = addDays(statsEnd, dir * 7);
    if (next > todayKey()) return;
    playTone('click');
    statsEnd = next;
    renderStats();
}

/* --- 設定視窗 --- */
function renderSettings() {
    document.querySelectorAll('#setTheme .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.value === prefs.theme));
    document.querySelectorAll('#setVolume .seg-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.value) === Number(prefs.volume)));
    document.getElementById('setLongValue').textContent = longEvery();
    document.getElementById('setAutoStart').checked = !!timerSettings.autoStart;
    document.getElementById('setStatusNotify').checked = !!prefs.statusNotify;
}
// 主題換了之後，懸浮小視窗也要跟著換
function refreshThemeDependents() {
    if (pipWindow) pipWindow.document.documentElement.dataset.theme = resolvedTheme();
    updateFloating();
}
document.getElementById('setTheme').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    playTone('click');
    prefs.theme = btn.dataset.value; savePrefs();
    applyTheme(); refreshThemeDependents(); renderSettings();
});
document.getElementById('setVolume').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    prefs.volume = Number(btn.dataset.value); savePrefs();
    renderSettings();
    playTone('alarm'); // 試聽
});
function changeLongEvery(delta) {
    playTone('click');
    timerSettings.longEvery = Math.min(8, Math.max(2, longEvery() + delta));
    saveTimerSettings(); updateModeUI(); renderSettings();
}
document.getElementById('setLongMinus').addEventListener('click', () => changeLongEvery(-1));
document.getElementById('setLongPlus').addEventListener('click', () => changeLongEvery(1));
document.getElementById('setAutoStart').addEventListener('change', (e) => {
    timerSettings.autoStart = e.target.checked; saveTimerSettings();
});
document.getElementById('setStatusNotify').addEventListener('change', (e) => {
    prefs.statusNotify = e.target.checked; savePrefs();
    if (e.target.checked) requestNotifyPermission();
    statusSig = ''; updateStatusNotification();
});

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
    if (!confirm('清除所有時間記錄（含過去一年）？今日蕃茄數也會歸零，此動作無法復原。')) return;
    storeRemove(STORAGE_KEY_LOG);
    playTone('delete');
    renderLogModal();
    updateModeUI();
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
        doc.querySelector('.mini-progress-fill').style.width = `${phaseProgress() * 100}%`;
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
    pipWindow = await documentPictureInPicture.requestWindow({ width: 260, height: 185 });
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
    doc.documentElement.dataset.theme = resolvedTheme();
    doc.body.className = 'mini-body';
    doc.body.innerHTML = `
        <div class="mini">
            <div class="mini-top"><span class="mini-mode"></span><span class="mini-task"></span></div>
            <div class="mini-time"></div>
            <div class="mini-progress"><div class="mini-progress-fill"></div></div>
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

// 其他瀏覽器：把時間畫到 canvas，轉成影片後用子母畫面顯示。
// 子母畫面上只有影片的播放／暫停鍵可以按，所以把它當成「開始／暫停計時」的開關
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
                小視窗上的<b>暫停鍵</b>可以開始／暫停計時。<br>
                這個面板要留著，關掉會一起關閉懸浮時間。
            </div>`;
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true;
        panel.appendChild(video);
        document.body.appendChild(panel);
        panel.querySelector('.modal-close').onclick = () => closeVideoPip();

        videoPip = { canvas, video, panel, stream: null, openedAt: Date.now() };
        drawPipCanvas(); // 先畫一張，串流才有畫面
        videoPip.stream = canvas.captureStream();
        video.srcObject = videoPip.stream;
        // 影片要一直播放畫面才會更新，所以被按了暫停就馬上繼續播，並把這一下當成「開始／暫停計時」
        video.addEventListener('pause', () => {
            const vp = videoPip;
            if (!vp || vp.video !== video) return;
            video.play().catch(() => {});
            if (Date.now() - vp.openedAt > 1000) toggleTimer(); // 剛開啟時瀏覽器自己觸發的暫停不算
        });
        // Chrome／Safari 的子母畫面會改走 Media Session 的按鍵
        setMediaSessionHandlers({ play: toggleTimer, pause: toggleTimer, nexttrack: () => document.getElementById('skipBtn').click() });
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
    setMediaSessionHandlers({ play: null, pause: null, nexttrack: null });
    stopFloatingTicker();
};

function setMediaSessionHandlers(handlers) {
    if (!('mediaSession' in navigator)) return;
    Object.entries(handlers).forEach(([action, fn]) => {
        try { navigator.mediaSession.setActionHandler(action, fn); } catch (err) {}
    });
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

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
    const css = getComputedStyle(document.body);
    const cssVar = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const accent = cssVar('--accent-color', '#ff6b6b');
    const font = '"Helvetica Neue", Arial, "Microsoft JhengHei", sans-serif';

    ctx.fillStyle = cssVar('--bg-color', '#e0e5ec'); ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 14);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    const task = currentTaskName();
    ctx.font = `bold 36px ${font}`; ctx.fillStyle = accent;
    ctx.fillText(fitText(ctx, task ? `${modeLabel()} · ${task}` : modeLabel(), W - 60), W / 2, 62);

    ctx.font = `300 160px ${font}`; ctx.fillStyle = cssVar('--text-color', '#4a4a4a');
    ctx.fillText(formatTime(shownSeconds()), W / 2, 172);

    // 進度條
    const barX = 60, barY = 262, barW = W - 120, barH = 14;
    ctx.fillStyle = resolvedTheme() === 'dark' ? '#454b55' : '#c9d1db'; roundRect(ctx, barX, barY, barW, barH, barH / 2); ctx.fill();
    const fillW = barW * phaseProgress();
    if (fillW >= barH) { ctx.fillStyle = accent; roundRect(ctx, barX, barY, fillW, barH, barH / 2); ctx.fill(); }

    ctx.font = `28px ${font}`; ctx.fillStyle = cssVar('--faint', '#777');
    ctx.fillText(isRunning ? '計時中 · 按暫停鍵可暫停' : (session ? '已暫停 · 按暫停鍵繼續' : '按暫停鍵開始'), W / 2, 318);
}

/* --- 8. 給同步模組 (sync.js) 用的介面 --- */
window.pomodoroApp = {
    keys: { categories: STORAGE_KEY_CATS, schedule: STORAGE_KEY_SCHED, timer: STORAGE_KEY_TIMER, logs: STORAGE_KEY_LOG },
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
        else if (key === STORAGE_KEY_LOG) {
            updateModeUI(); // 今日蕃茄數是從記錄算的
            if (document.getElementById('logModal').classList.contains('show')) renderLogModal();
        } else if (key === STORAGE_KEY_TIMER) {
            const incoming = loadTimerSettings();
            if (session) incoming.countUp = timerSettings.countUp; // 進行中的這一段不切換倒數／正數
            Object.assign(timerSettings, incoming);
            if (!session && !isRunning) { timeLeft = timerSettings[mode]; elapsed = 0; }
            updateModeUI(); updateDisplay(); renderSettings();
        }
    }
};

/* --- 9. 按鈕綁定 ---
 * HTML 裡不寫 onclick：這樣內容安全政策才能禁止所有寫在網頁裡的程式碼，只執行這幾個檔案。 */
const ACTIONS = {
    'open-help': () => toggleModal(true),
    'open-settings': () => { renderSettings(); toggleModal(true, 'settingsModal'); },
    'open-stats': () => openStatsModal(),
    'stats-prev': () => shiftStats(-1),
    'stats-next': () => shiftStats(1),
    'open-sync': () => toggleModal(true, 'syncModal'),
    'open-float': () => openFloating(),
    'open-log': () => openLogModal(),
    'export-data': () => exportData(),
    'import-data': () => document.getElementById('importFile').click(),
    'log-prev': () => shiftLogDate(-1),
    'log-next': () => shiftLogDate(1),
    'export-csv': () => exportLog('csv'),
    'export-md': () => exportLog('md'),
    'copy-log': () => copyLog(),
    'export-all': () => exportAllLogs(),
    'clear-logs': () => clearLogs(),
    'clear-schedule': () => clearSchedule(),
    'reset-all': () => resetToDefault(),
    'add-category': () => addNewCategory()
};
document.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', () => ACTIONS[el.dataset.action]());
});
document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => setTimer(Number(btn.dataset.min)));
});
document.getElementById('importFile').addEventListener('change', (e) => importData(e.target));
// 手機的 ☰ 選單：點一下展開，選了項目或點到外面就收起來
const fabBar = document.getElementById('fabBar');
document.getElementById('fabToggle').addEventListener('click', () => { playTone('click'); fabBar.classList.toggle('open'); });
document.addEventListener('click', (e) => {
    if (e.target.closest('#fabToggle')) return;
    fabBar.classList.remove('open');
});
// 點視窗外面或右上角 × 關閉
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.modal-close')) toggleModal(false, overlay.id);
    });
});

window.addEventListener('DOMContentLoaded', initApp);
