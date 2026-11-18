/* 版本編號：每次更新網站都要改（格式：年.月.日.當天第幾次），設定視窗與使用說明的最下面會顯示 */
const APP_VERSION = '2026.11.18.1';

/* 登入門檻：這台裝置以前登入並確認過權限，就先把登入畫面收起來（離線也能用）；
 * 之後由 sync.js 確認登入狀態，沒登入或沒權限會再蓋回去。 */
try {
    if (JSON.parse(localStorage.getItem('pomodoro_sync_meta') || '{}').uid) document.documentElement.classList.add('unlocked');
} catch (err) {}
const isUnlocked = () => document.documentElement.classList.contains('unlocked');

/* --- 偏好設定（只存在這台裝置，不同步）：外觀、音量、常駐通知 --- */
const STORAGE_KEY_PREFS = 'pomodoro_prefs_v1';
const IS_TOUCH = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
const prefs = loadPrefs();
function loadPrefs() {
    const defaults = { theme: 'auto', volume: 1, statusNotify: IS_TOUCH, bgAudio: IS_TOUCH, aiAsks: ['plan', 'review'] };
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
    master.gain.value = Math.min(volume, 1) ** 2; // 平方：滑桿每一格聽起來的差距比較平均
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
const STORAGE_KEY_REMIND = 'pomodoro_reminders_v1'; // 定時提醒
const STORAGE_KEY_DONE = 'pomodoro_done_v1'; // 完成任務的歷史（保留一年）
const REMIND_FIRED_KEY = 'pomodoro_reminder_fired'; // 這台裝置今天已經響過的提醒（不同步）
const LOG_KEEP_DAYS = 365;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
// 獎勵（點數、商店、等級）。這幾個常數放在這裡，因為載入時 restoreTimerState() 就會用到（更新點數顯示）
const STORAGE_KEY_REWARDS = 'pomodoro_rewards_v1';
const REWARD_LIVE_DAYS = 7;  // 最近幾天的點數直接從記錄算（記錄改了會跟著變），更早的結算後存成每日總數
const REWARD_MAX_WEIGHT = 50;
const REWARD_UNIT_SEC = 15 * 60; // 點數依專注時間計算：類別設定的是「每 15 分鐘幾點」
const REWARD_DEFAULT_OTHER = 5; // 不在任務庫或沒選任務的蕃茄，每顆幾點
const REWARD_TITLES = ['蕃茄種子', '冒出新芽', '小小幼苗', '長出綠葉', '開出黃花', '結出青果', '慢慢轉紅', '熟透的蕃茄', '蕃茄農夫', '蕃茄大師'];
const REWARD_DEFAULT_SHOP = [
    { id: 'd1', name: '玩 30 分鐘手遊', cost: 20 },
    { id: 'd2', name: '看一集影片', cost: 15 },
    { id: 'd3', name: '耍廢 1 小時', cost: 40 },
    { id: 'd4', name: '玩 1 小時單機遊戲', cost: 40 }
];

/* 資料檢查：匯入的檔案與雲端來的資料都先過這裡，格式不對的部分直接丟掉 */
function cleanText(v, max = 200) { return typeof v === 'string' ? v.slice(0, max) : ''; }
// 顏色只接受 #hex 或 rgb()/rgba()，避免被塞進奇怪的 CSS
function cleanColor(v) {
    const m = typeof v === 'string' && v.trim().match(/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))(\s|$)/i);
    return m ? m[1] : '#999999';
}
// 預估蕃茄數：1–12
function cleanEst(v) { const n = Math.round(Number(v)); return n >= 1 && n <= 12 ? n : 1; }
// 類別的 tasks 維持單純的名稱清單（舊版網頁也讀得懂）；
// 預估蕃茄數與固定任務（repeat：星期幾，0 = 週日）另外放在 meta[任務名稱]
function cleanCategories(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 100).filter(c => c && typeof c === 'object').map(c => {
        const tasks = (Array.isArray(c.tasks) ? c.tasks : []).slice(0, 300).map(t => cleanText(t)).filter(Boolean);
        const meta = {};
        const rawMeta = c.meta && typeof c.meta === 'object' ? c.meta : {};
        tasks.forEach(name => {
            const m = Object.prototype.hasOwnProperty.call(rawMeta, name) ? rawMeta[name] : null;
            if (!m || typeof m !== 'object') return;
            const est = cleanEst(m.est);
            const repeat = Array.isArray(m.repeat) ? [...new Set(m.repeat.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
            if (est !== 1 || repeat.length) meta[name] = { est, repeat };
        });
        return { title: cleanText(c.title, 100) || '未命名', color: cleanColor(c.color), tasks, meta };
    });
}
function newItemId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function cleanSchedule(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = {};
    return raw.slice(0, 500).filter(t => t && typeof t === 'object' && cleanText(t.name))
        .map(t => {
            const name = cleanText(t.name);
            // 每個行程項目有自己的編號。舊資料沒有編號時，用「名稱＋第幾個」產生，
            // 這樣兩台裝置對同一份舊資料會算出一樣的編號
            const n = seen[name] = (seen[name] || 0) + 1;
            const item = { id: cleanText(t.id, 40) || `old:${name}:${n}`, name, color: cleanColor(t.color) };
            if (t.done) { item.done = true; item.doneAt = Number.isFinite(t.doneAt) ? t.doneAt : Date.now(); }
            if (t.est != null) item.est = cleanEst(t.est);
            // did：這張卡已經完成幾顆；last：最後一次記帳的那段專注的開始時間（防止重複記）
            if (t.did > 0) item.did = Math.min(999, Math.floor(t.did));
            if (t.last != null) item.last = cleanText(String(t.last), 20);
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
    if (l.manual) entry.manual = true; // 事後補登的
    return entry;
}
// 完成任務的歷史：[{id（行程卡的編號）, name, color, at（完成時間）}]，依完成時間排序，保留一年
function cleanDone(raw) {
    if (!Array.isArray(raw)) return [];
    const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    const seen = new Set();
    return raw.filter(d => d && typeof d === 'object' && cleanText(d.name) && Number.isFinite(d.at) && d.at >= cutoff)
        .map(d => ({ id: cleanText(d.id, 40), name: cleanText(d.name), color: cleanColor(d.color), at: d.at }))
        .filter(d => d.id && !seen.has(d.id) && seen.add(d.id))
        .sort((a, b) => a.at - b.at)
        .slice(-5000);
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
let forcedRev = 0;        // 見 saveTimerState：自動結束時，狀態的版本時間用「預計結束時間」而不是現在
const NOTIFY_TAG = 'pomodoro-phase';   // 「時間到」的通知
const STATUS_TAG = 'pomodoro-status';  // 計時中的常駐通知
const REMIND_TAG = 'pomodoro-remind';  // 定時提醒的通知（點了只回到網頁，不會開始計時）

let keepAliveAudio = null;    // 手機背景保持計時用的靜音音訊，見 updateKeepAlive
let keepAliveStopTimer = null;
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
// 蕃茄的定義：
//   - 倒數：完成一段專注算一顆
//   - 正數：每滿一段「專注時長」算一顆
//   - 不管哪一種，專注不到 5 分鐘都不算（避免誤觸或測試用的超短時長灌水）
const MIN_POMODORO_SEC = 5 * 60;
function pomodorosOf(l) {
    if (l.mode !== 'focus' || l.actualSec < MIN_POMODORO_SEC) return 0;
    if (!l.countUp) return l.completed ? 1 : 0;
    return Math.min(l.pomodoros || 0, Math.floor(l.actualSec / MIN_POMODORO_SEC));
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
async function notify(body, tag = NOTIFY_TAG) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const options = { body, tag, renotify: true, icon: 'icons/icon-192.png' };
    const reg = await getSwRegistration();
    // 手機瀏覽器只能透過 service worker 發通知
    if (reg && reg.active) { try { await reg.showNotification('蕃茄鐘', options); return; } catch (err) {} }
    try {
        const n = new Notification('蕃茄鐘', options);
        n.onclick = () => { window.focus(); n.close(); if (tag === NOTIFY_TAG) startFromPrompt(); };
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

/* 背景保持計時（手機）：手機關掉螢幕或切到別的 App 時會暫停網頁，時間到也響不了、發不了通知。
 * 計時中在背景循環播放一段聽不到的聲音，讓系統把網頁當成正在播放音樂而繼續執行。
 * 鎖定畫面可能出現播放器控制列，上面顯示這一段幾點結束，按暫停就是暫停計時。
 * 瀏覽器只允許在使用者點擊之後開始播放，所以重新整理後要等第一次點擊才會恢復。 */
function silentAudioUrl() {
    const rate = 8000, n = rate; // 1 秒、8kHz、16 位元單聲道
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    // 振幅只有 ±2（最大 32767），人耳聽不到，但不是完全無聲，系統才會當成「正在播放」
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 2 : -2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function updateKeepAlive() {
    const want = isRunning && !!prefs.bgAudio;
    clearTimeout(keepAliveStopTimer);
    if (want) {
        if (!keepAliveAudio) {
            keepAliveAudio = new Audio(silentAudioUrl());
            keepAliveAudio.loop = true;
            keepAliveAudio.volume = 1;
        }
        if (keepAliveAudio.paused) keepAliveAudio.play().catch(() => {}); // 還沒有點擊過頁面時會被拒絕，等下次點擊
        if ('mediaSession' in navigator && !videoPip) {
            try {
                const end = isCountUp() ? '正數計時中' : `${clockText(endTime)} 結束`;
                navigator.mediaSession.metadata = new MediaMetadata({ title: `${modeLabel()} · ${end}`, artist: '蕃茄鐘', artwork: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }] });
                navigator.mediaSession.playbackState = 'playing';
            } catch (err) {}
            setMediaSessionHandlers({ play: () => { if (!isRunning) toggleTimer(); }, pause: () => { if (isRunning) toggleTimer(); } });
        }
    } else if (keepAliveAudio && !keepAliveAudio.paused) {
        // 多播幾秒再停：時間到的提示音與通知需要網頁還醒著
        keepAliveStopTimer = setTimeout(() => {
            if (isRunning) return;
            keepAliveAudio.pause();
            if ('mediaSession' in navigator && !videoPip) { try { navigator.mediaSession.playbackState = 'paused'; } catch (err) {} }
        }, 6000);
    }
}
// 重新整理後還在計時：第一次點擊頁面時恢復背景音訊
document.addEventListener('pointerdown', () => { if (isRunning && prefs.bgAudio && (!keepAliveAudio || keepAliveAudio.paused)) updateKeepAlive(); });

async function updateWakeLock() {
    updateKeepAlive();
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
    updateRewardBadge();
}

// 目前任務 = 凹槽第一張卡片
function getCurrentCard() { return document.querySelector('#scheduleSlot .task-card:not(.drop-placeholder):not(.done)'); }
function getCurrentTask() {
    const card = getCurrentCard();
    return card ? card.querySelector('.task-name').innerText : '';
}

const cardEst = card => (card.dataset.est ? cleanEst(card.dataset.est) : 1);
const cardDid = card => Math.max(0, Math.floor(Number(card.dataset.did)) || 0);

// 把剛完成的蕃茄記到「開始這一段時的那張卡」上；做滿預估顆數就自動標記完成，輪到下一個任務。
// sessionStart 用來避免重複記：兩台裝置同步計時時，同一段會在兩邊各結束一次
function creditCard(cardId, earned, sessionStart) {
    if (!cardId || !(earned > 0)) return;
    const card = [...document.querySelectorAll('#scheduleSlot .task-card')].find(c => c.dataset.id === cardId);
    if (!card || card.dataset.last === String(sessionStart)) return;
    card.dataset.did = cardDid(card) + earned;
    card.dataset.last = sessionStart;
    if (!card.classList.contains('done') && cardDid(card) >= cardEst(card)) toggleDone(card, true); // 會存檔
    else saveSchedule();
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

// 今天各任務的專注秒數（含正在進行的這一段）與完成的蕃茄數
function todayTaskStats() {
    const today = todayKey();
    const map = {};
    const get = name => map[name] || (map[name] = { sec: 0, pomo: 0 });
    loadLogs().forEach(l => {
        if (l.mode !== 'focus' || !l.task) return;
        if (dateKey(l.start) === today) get(l.task).sec += l.actualSec;
        if (dateKey(l.end) === today) get(l.task).pomo += pomodorosOf(l);
    });
    if (session && session.mode === 'focus' && session.task) {
        const live = session.activeMs + (isRunning ? Date.now() - session.segStart : 0);
        get(session.task).sec += Math.round(live / 1000);
    }
    return map;
}

// 從現在起再做完 k 顆蕃茄要多久（秒），含中間的休息：
// 每顆之間休息一次，輪到「幾顆一次」時是長休息；正在進行的這一段已經過的時間不重算
function secondsForTomatoes(k) {
    if (k <= 0) return 0;
    const count = getTodayCount(), every = longEvery();
    const longs = Math.max(0, Math.floor((count + k - 1) / every) - Math.floor(count / every));
    let sec = k * timerSettings.focus + Math.max(0, k - 1 - longs) * timerSettings.short + longs * timerSettings.long;
    if (mode !== 'focus') sec += timeLeft;                                                         // 現在在休息：先把休息過完
    else if (session && !session.countUp) sec -= Math.max(0, timerSettings.focus - timeLeft);     // 這顆已經做了一部分
    return Math.max(0, sec);
}

// 更新行程卡片下方的「已完成／預估 🍅」，以及每張卡與整份行程的預計完成時間。
// 進度是每張卡各自記的（同名的兩張卡不會互相影響），預計時間照行程順序往下累加
function refreshScheduleTimes() {
    lastTimesRefresh = Date.now();
    let cumulative = 0;
    document.querySelectorAll('#scheduleSlot .task-card:not(.drop-placeholder)').forEach(card => {
        const el = card.querySelector('.task-time');
        if (!el) return;
        const est = cardEst(card), did = cardDid(card);
        el.textContent = `${did}/${est}🍅`;
        const name = card.querySelector('.task-name').innerText;
        if (card.classList.contains('done')) { card.title = name; delete card.dataset.eta; return; }
        cumulative += Math.max(0, est - did);
        card.dataset.eta = Date.now() + secondsForTomatoes(cumulative) * 1000;
        card.title = `${name}｜預計 ${clockText(Number(card.dataset.eta))} 做完`;
    });
    document.getElementById('schedulePlan').textContent = cumulative
        ? `剩 ${cumulative} 顆 · 約 ${clockText(Date.now() + secondsForTomatoes(cumulative) * 1000)} 做完` : '';
}

function saveTimerState() {
    // 計時狀態也會同步到其他裝置。rev 是這個狀態的版本時間，兩台裝置的狀態衝突時新的贏：
    // 使用者按下去的操作用現在的時間；時間到自動結束則用「預計結束時間」。
    // 這樣一台睡著的手機醒來後補做的「自動結束」，不會蓋掉另一台之後才按的操作。
    const rev = forcedRev || Date.now();
    storeSet(STORAGE_KEY_STATE, JSON.stringify({ mode, timeLeft, endTime, elapsed, countStart, isRunning, session, rev }));
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
        const card = mode === 'focus' ? getCurrentCard() : null;
        session = { mode, task: mode === 'focus' ? getCurrentTask() : '', cardId: card ? card.dataset.id : null, start: Date.now(),
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
    const cardId = session && session.cardId, sessionStart = session && session.start;
    if (mode === 'focus' && session) {
        // 一顆的長度＝專注時長，但最短以 5 分鐘計
        session.pomodoros = Math.floor(session.activeMs / 1000 / Math.max(timerSettings.focus, MIN_POMODORO_SEC));
    }
    const wasFocus = mode === 'focus';
    const rewardStart = wasFocus ? rewardSummary() : null;
    endSession(true); // 寫入記錄後，今日蕃茄數就會包含這次的
    const after = getTodayCount(), earned = after - before;
    creditCard(cardId, earned, sessionStart);
    let next = 'focus';
    // 這次跨過「幾顆一次長休息」的倍數就進長休息
    if (wasFocus) next = earned && Math.floor(after / longEvery()) > Math.floor(before / longEvery()) ? 'long' : 'short';
    switchMode(next);
    const gain = rewardStart ? rewardGainText(rewardStart) : '';
    if (gain) { playTone('alarm'); showToast(`專注結束！${gain}`, null, null, 6000); }
    autoDriveSave(false);
}

// completed = true 表示這段是自然結束；earned 是這一段實際算到幾顆蕃茄（太短的不算）
function advancePhase(completed, earned = 0) {
    let next = 'focus';
    if (mode === 'focus') {
        const count = getTodayCount(); // 自然結束時，剛完成的這顆已經寫入記錄
        next = (completed && earned > 0 && count % longEvery() === 0) ? 'long' : 'short';
    }
    switchMode(next);
}

function finishPhase() {
    const finished = mode;
    const auto = !!timerSettings.autoStart;
    forcedRev = endTime || Date.now();
    let rewardStart = null; // 完成前的點數，用來算這顆賺了多少
    try {
        const before = getTodayCount();
        if (finished === 'focus') rewardStart = rewardSummary();
        const cardId = session && session.cardId, sessionStart = session && session.start;
        stopTimer(); endSession(true);
        const earned = getTodayCount() - before;
        creditCard(cardId, earned, sessionStart);
        advancePhase(true, earned); // 切到下一段；預設停在那裡等使用者按開始
        if (auto) startTimer();
    } finally { forcedRev = 0; }
    const gain = rewardStart ? rewardGainText(rewardStart) : '';
    announce(finished === 'focus'
        ? `專注結束！${gain ? gain + ' ' : ''}接下來是${MODE_LABELS[mode]}（${formatTime(timerSettings[mode])}）`
        : (auto ? '休息結束，下一顆蕃茄開始了！' : '休息結束，準備開始下一顆蕃茄！'), auto);
    autoDriveSave(false);
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
    if (!document.hidden) { stopAttention(); checkNewDay(); } // 網頁開著跨過午夜，回來時也算新的一天
    updateWakeLock(); // 分頁到背景時螢幕鎖會被系統收回，回來時重新取得
});
window.addEventListener('focus', stopAttention);
// 鍵盤快捷鍵：空白鍵開始／暫停、S 跳過、R 重置（打字或視窗開著時不作用）
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || !isUnlocked()) return;
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
        else if (e.data.tag === REMIND_TAG) { /* 定時提醒：回到網頁就好，提示列上有「開始」 */ }
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
        const meta = {};
        group.querySelectorAll('.task-card').forEach(card => {
            const name = card.querySelector('.task-name').innerText;
            tasks.push(name);
            const est = cleanEst(card.dataset.est), repeat = cardRepeat(card);
            if (est !== 1 || repeat.length) meta[name] = { est, repeat };
        });
        categories.push({ title, color, tasks, meta });
    });
    storeSet(STORAGE_KEY_CATS, JSON.stringify(categories));
}

function saveSchedule() {
    const schedule = [];
    document.querySelectorAll('#scheduleSlot .task-card:not(.drop-placeholder)').forEach(card => {
        const item = { id: card.dataset.id, name: card.querySelector('.task-name').innerText, color: card.dataset.color || card.querySelector('.tag').style.background };
        if (card.classList.contains('done')) { item.done = true; item.doneAt = Number(card.dataset.doneAt) || Date.now(); }
        if (card.dataset.est) item.est = cleanEst(card.dataset.est);
        if (cardDid(card)) item.did = cardDid(card);
        if (card.dataset.last) item.last = card.dataset.last;
        schedule.push(item);
    });
    storeSet(STORAGE_KEY_SCHED, JSON.stringify(schedule));
    recordDone(schedule);
    updateCurrentTask();
    updateDoneToggle();
}

function loadDone() { return cleanDone(readStoredJSON(STORAGE_KEY_DONE)); }
// 行程卡標記完成時記進歷史、取消完成時從歷史移除；卡片之後被清掉（隔天、刪除）歷史仍保留
function recordDone(schedule) {
    const byId = new Map(loadDone().map(d => [d.id, d]));
    let changed = false;
    schedule.forEach(t => {
        if (!t || !t.id) return;
        const d = byId.get(t.id);
        if (t.done && Number.isFinite(t.doneAt)) {
            const entry = { id: t.id, name: t.name, color: cleanColor(t.color), at: t.doneAt };
            if (!d || JSON.stringify(d) !== JSON.stringify(entry)) { byId.set(t.id, entry); changed = true; }
        } else if (!t.done && d) { byId.delete(t.id); changed = true; }
    });
    if (changed) storeSet(STORAGE_KEY_DONE, JSON.stringify(cleanDone([...byId.values()])));
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
    kept.forEach(t => appendScheduleCard(t.name, t.color, null, t.done ? t.doneAt : null, t.est, t.id, t));
    if (kept.length !== items.length) saveSchedule();
    // 別台裝置（可能是舊版、不會記歷史）傳來的完成狀態也記進歷史。
    // 排到稍後做：套用雲端資料的當下寫入的變動不會被上傳
    setTimeout(() => recordDone(items), 0);
    updateCurrentTask();
    updateDoneToggle();
}

function renderCategoriesFromStorage() {
    paletteContainer.querySelectorAll('.category-group').forEach(g => g.remove());
    const savedCats = readStoredJSON(STORAGE_KEY_CATS);
    if (Array.isArray(savedCats)) {
        cleanCategories(savedCats).forEach(cat => createCategoryDOM(cat.title, cat.color, cat.tasks, cat.meta));
    } else {
        createCategoryDOM('工作', '#ff6b6b', ['寫代碼']);
        createCategoryDOM('健康', '#1dd1a1', ['喝水']);
    }
    paletteContainer.appendChild(addCatBtn);
}

function createCategoryDOM(titleText, color, tasks = [], meta = {}) {
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

    tasks.forEach(taskName => createTaskDOM(grid, taskName, color, meta[taskName]));

    group.appendChild(header);
    group.appendChild(grid);

    paletteContainer.insertBefore(group, addCatBtn);
}

function createTaskDOM(container, name, color, meta) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.color = color;
    card.title = '點一下排入今日行程';
    if (meta) { card.dataset.est = meta.est; card.dataset.repeat = (meta.repeat || []).join(','); }

    // 點卡片 = 排入行程；改名和刪除走右上角的 ✎
    card.onclick = () => {
        if (card.querySelector('input')) return;
        const taskName = card.querySelector('.task-name').innerText;
        // 行程最後一個任務剛好是它：不另外加一張，直接多排一顆
        const existing = stackTarget(taskName);
        if (existing) { playTone('drop'); changeCardEst(existing, 1); }
        else addToSchedule(taskName, card.dataset.color, true, null, cleanEst(card.dataset.est));
        card.classList.remove('added'); void card.offsetWidth; card.classList.add('added');
    };
    card.oncontextmenu = (e) => { e.preventDefault(); removePaletteTask(card); };

    const edit = document.createElement('span');
    edit.className = 'edit-icon'; edit.textContent = '✎'; edit.title = '編輯任務';
    edit.onclick = (e) => { e.stopPropagation(); playTone('click'); editTaskName(card); };

    const tag = document.createElement('div');
    tag.className = 'tag'; tag.style.background = color;
    const text = document.createElement('div');
    text.className = 'task-name'; text.innerText = name;
    const badge = document.createElement('div');
    badge.className = 'task-time';
    card.appendChild(edit); card.appendChild(tag); card.appendChild(text); card.appendChild(badge);
    updatePaletteBadge(card);

    card.style.opacity = 0; container.appendChild(card);
    requestAnimationFrame(() => { card.style.transition = 'opacity 0.3s'; card.style.opacity = 1; });
    return card;
}

function removePaletteTask(card) {
    const name = card.querySelector('.task-name').innerText;
    withUndo(STORAGE_KEY_CATS, `已從任務庫移除「${name}」`, () => { card.remove(); saveCategories(); });
}

/* 任務編輯視窗：名稱、預估蕃茄數、固定任務（每週哪幾天自動排進行程） */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const mondayFirst = (a, b) => ((a + 6) % 7) - ((b + 6) % 7);
function cardRepeat(card) { return (card.dataset.repeat || '').split(',').filter(Boolean).map(Number); }
function repeatText(repeat) {
    if (!repeat.length) return '';
    return repeat.length === 7 ? '每天' : repeat.slice().sort(mondayFirst).map(d => WEEKDAY_NAMES[d]).join('');
}
// 任務庫卡片下方的小字：預估顆數與固定的星期
function updatePaletteBadge(card) {
    const est = cleanEst(card.dataset.est);
    const parts = [];
    if (est > 1) parts.push(`${est}🍅`);
    const rt = repeatText(cardRepeat(card));
    if (rt) parts.push(rt);
    card.querySelector('.task-time').textContent = parts.join(' ');
}

let editingCard = null, editorEst = 1, editorRepeat = new Set();
function renderTaskEditor() {
    document.getElementById('taskEstValue').textContent = editorEst;
    document.querySelectorAll('#taskRepeat .seg-btn').forEach(b => b.classList.toggle('active', editorRepeat.has(Number(b.dataset.day))));
}
function editTaskName(card) {
    editingCard = card;
    editorEst = cleanEst(card.dataset.est);
    editorRepeat = new Set(cardRepeat(card));
    const input = document.getElementById('taskEditName');
    input.value = card.querySelector('.task-name').innerText;
    renderTaskEditor();
    toggleModal(true, 'taskModal');
    input.focus(); input.select();
}
function saveTaskEditor() {
    const card = editingCard;
    toggleModal(false, 'taskModal');
    if (!card || !card.isConnected) return;
    const name = document.getElementById('taskEditName').value.trim();
    if (name === '') { removePaletteTask(card); return; }
    card.querySelector('.task-name').innerText = name;
    card.dataset.est = editorEst;
    card.dataset.repeat = [...editorRepeat].sort().join(',');
    updatePaletteBadge(card);
    saveCategories();
}
document.getElementById('taskEstMinus').addEventListener('click', () => { playTone('click'); editorEst = Math.max(1, editorEst - 1); renderTaskEditor(); });
document.getElementById('taskEstPlus').addEventListener('click', () => { playTone('click'); editorEst = Math.min(12, editorEst + 1); renderTaskEditor(); });
document.getElementById('taskRepeat').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    playTone('click');
    const day = Number(btn.dataset.day);
    if (editorRepeat.has(day)) editorRepeat.delete(day); else editorRepeat.add(day);
    renderTaskEditor();
});
document.getElementById('taskSave').addEventListener('click', saveTaskEditor);
document.getElementById('taskEditName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveTaskEditor(); });
document.getElementById('taskDelete').addEventListener('click', () => {
    toggleModal(false, 'taskModal');
    if (editingCard && editingCard.isConnected) removePaletteTask(editingCard);
});

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
    localStorage.removeItem(STORAGE_KEY_REWARDS);
    localStorage.removeItem(STORAGE_KEY_REMIND);
    localStorage.removeItem(STORAGE_KEY_DONE);
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
    } else if (card && !e.target.closest('.delete-icon, .done-icon, .edit-icon, .est-btn, input')) {
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
        if (dropped) addToSchedule(d.el.querySelector('.task-name').innerText, d.el.dataset.color, true, before, cleanEst(d.el.dataset.est));
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

function addToSchedule(name, color, sound = true, before = null, est = null) {
    if(sound) playTone('drop');
    // 沒指定位置（點一下加入）就排在還沒完成的任務最後、已完成的前面
    appendScheduleCard(name, color, before || slot.querySelector('.task-card.done'), null, est);
    saveSchedule();
}

// 只建立卡片、不存檔（從儲存的資料重畫時用，避免把剛收到的雲端資料又當成本機修改傳回去）
function appendScheduleCard(name, color, before = null, doneAt = null, est = null, id = null, progress = null) {
    const div = document.createElement('div');
    div.className = 'task-card';
    div.dataset.color = color;
    div.dataset.id = id || newItemId();
    if (progress && progress.did) div.dataset.did = progress.did;
    if (progress && progress.last) div.dataset.last = progress.last;
    if (est) div.dataset.est = cleanEst(est);
    if (doneAt) { div.classList.add('done'); div.dataset.doneAt = doneAt; }

    // 卡片上不放小按鈕：點一下卡片，在操作面板裡完成、調整顆數或移除
    div.onclick = () => { playTone('click'); openCardPanel(div); };

    const tag = document.createElement('div'); tag.className = 'tag'; tag.style.background = color;
    const text = document.createElement('div'); text.className = 'task-name'; text.innerText = name;
    const time = document.createElement('div'); time.className = 'task-time';

    div.appendChild(tag); div.appendChild(text); div.appendChild(time);
    slot.insertBefore(div, before);
    return div;
}

/* 行程任務的操作面板（手機從下方滑出，按鈕夠大） */
let panelCard = null;
function renderCardPanel() {
    const card = panelCard;
    // 面板開著時行程被重畫（例如雲端同步進來），原本那張卡已經不在了
    if (!card || !card.isConnected) { panelCard = null; document.getElementById('cardModal').classList.remove('show'); return; }
    const name = card.querySelector('.task-name').innerText;
    const done = card.classList.contains('done');
    const s = todayTaskStats()[name] || { sec: 0, pomo: 0 };
    document.getElementById('cardTitle').textContent = name;
    const info = [`這張卡已完成 ${cardDid(card)}／${cardEst(card)} 顆`];
    if (s.sec >= 60) info.push(`這個任務今天共專注 ${Math.round(s.sec / 60)} 分鐘`);
    if (!done && card.dataset.eta) info.push(`預計 ${clockText(Number(card.dataset.eta))} 做完`);
    document.getElementById('cardInfo').textContent = info.join('　');
    document.getElementById('cardEst').textContent = card.dataset.est ? cleanEst(card.dataset.est) : 1;
    document.getElementById('cardStepper').style.display = done ? 'none' : '';
    document.getElementById('cardDone').textContent = done ? '↩ 取消完成' : '✓ 完成';
}
function openCardPanel(card) { panelCard = card; renderCardPanel(); toggleModal(true, 'cardModal'); }
function closeCardPanel() { document.getElementById('cardModal').classList.remove('show'); }
function panelAction(fn) {
    const card = panelCard;
    if (!card || !card.isConnected) { closeCardPanel(); return; }
    fn(card);
}
document.getElementById('cardMinus').addEventListener('click', () => panelAction(card => { playTone('click'); changeCardEst(card, -1); renderCardPanel(); }));
document.getElementById('cardPlus').addEventListener('click', () => panelAction(card => { playTone('click'); changeCardEst(card, 1); renderCardPanel(); }));
document.getElementById('cardDone').addEventListener('click', () => panelAction(card => { closeCardPanel(); toggleDone(card); }));
document.getElementById('cardRemove').addEventListener('click', () => panelAction(card => {
    closeCardPanel();
    const name = card.querySelector('.task-name').innerText;
    withUndo(STORAGE_KEY_SCHED, `已從行程移除「${name}」`, () => { card.remove(); saveSchedule(); });
}));

// 新加入的任務可以疊到哪張卡上：只有「還沒完成的最後一張」剛好是同一個任務時才疊，
// 這樣才排得出「日文 → 午餐 → 日文」，不會被併成「日文 ×2 → 午餐」
function stackTarget(name) {
    const undone = slot.querySelectorAll('.task-card:not(.done):not(.drop-placeholder)');
    const last = undone[undone.length - 1];
    return last && last.querySelector('.task-name').innerText === name ? last : null;
}

// 調整行程卡片的預估蕃茄數（1–12）
function changeCardEst(card, delta) {
    const current = card.dataset.est ? cleanEst(card.dataset.est) : 1;
    card.dataset.est = Math.min(12, Math.max(1, current + delta));
    card.classList.remove('added'); void card.offsetWidth; card.classList.add('added');
    saveSchedule(); // 會一併更新卡片上的顆數與預計完成時間
}

// 完成的任務劃掉並移到最下面；再按一次取消，回到未完成的最後
function toggleDone(card, quiet = false) {
    const done = !card.classList.contains('done');
    if (done) {
        card.classList.add('done');
        card.dataset.doneAt = Date.now();
        slot.appendChild(card);
        if (!quiet) playTone('drop');
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
        status: l.manual ? `補登（${pomodorosOf(l)} 🍅）`
            : !l.completed ? '中斷' : (l.countUp && l.mode === 'focus' ? `完成（${pomodorosOf(l)} 🍅）` : '完成')
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

    const done = loadDone().filter(d => { const k = dateKey(d.at); return k >= from && k <= statsEnd; });
    const doneByDay = Object.fromEntries(days.map(d => [d, []]));
    done.forEach(d => doneByDay[dateKey(d.at)].push(d));

    const totalSec = logs.reduce((sum, l) => sum + l.actualSec, 0);
    const totalPomo = logs.reduce((sum, l) => sum + pomodorosOf(l), 0);
    const activeDays = days.filter(d => perDay[d].sec > 0).length;
    document.getElementById('statsTitle').textContent = `每週統計（${shortDate(from)} – ${shortDate(statsEnd)}）`;
    document.getElementById('statsSummary').textContent = totalSec
        ? `專注 ${minutesText(totalSec)} 分鐘 · ${totalPomo} 🍅 · 有記錄的 ${activeDays} 天平均每天 ${minutesText(totalSec / activeDays)} 分鐘`
        : '這一週沒有專注記錄。';
    if (done.length) document.getElementById('statsSummary').textContent += ` · 完成 ${done.length} 項任務`;
    document.getElementById('statsPrev').disabled = !allFocus.some(l => dateKey(l.start) < from) && !loadDone().some(d => dateKey(d.at) < from);
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
        const doneEl = document.createElement('div'); doneEl.className = 'stats-day';
        doneEl.textContent = doneByDay[d].length ? `✓${doneByDay[d].length}` : ' ';
        col.appendChild(value); col.appendChild(bar); col.appendChild(label); col.appendChild(pomoEl); col.appendChild(doneEl);
        chart.appendChild(col);
    });

    const sorted = obj => Object.values(obj).sort((a, b) => b.sec - a.sec);
    fillStatsList('statsTasks', sorted(byTask).slice(0, 12));
    fillStatsList('statsCats', sorted(byCat));
    fillStatsDone(days, doneByDay);
}

// 每天完成的任務：每天一行「完成 N 項」，點開看是哪些、幾點完成
function fillStatsDone(days, doneByDay) {
    const box = document.getElementById('statsDone');
    box.innerHTML = '';
    const withDone = days.filter(d => doneByDay[d].length).reverse(); // 新的日子在上面
    if (!withDone.length) {
        const empty = document.createElement('div'); empty.className = 'stats-empty'; empty.textContent = '這一週沒有完成的任務';
        box.appendChild(empty);
        return;
    }
    withDone.forEach((d, i) => {
        const det = document.createElement('details'); det.className = 'stats-done-day';
        if (i === 0) det.open = true;
        const sum = document.createElement('summary');
        sum.textContent = `${weekdayText(d)} ${shortDate(d)} · 完成 ${doneByDay[d].length} 項`;
        det.appendChild(sum);
        doneByDay[d].forEach(t => {
            const row = document.createElement('div'); row.className = 'stats-done-row';
            const dot = document.createElement('span'); dot.className = 'stats-done-dot'; dot.style.background = t.color;
            const name = document.createElement('span'); name.className = 'stats-row-name'; name.textContent = t.name;
            const time = document.createElement('span'); time.className = 'stats-row-val'; time.textContent = clockText(t.at);
            row.appendChild(dot); row.appendChild(name); row.appendChild(time);
            det.appendChild(row);
        });
        box.appendChild(det);
    });
}

window.openStatsModal = function() { statsEnd = todayKey(); renderStats(); toggleModal(true, 'statsModal'); };
function shiftStats(dir) {
    const next = addDays(statsEnd, dir * 7);
    if (next > todayKey()) return;
    playTone('click');
    statsEnd = next;
    renderStats();
}

/* --- 今日開始：每天第一次開啟時，處理之前沒做完的任務與今天的固定任務 --- */
let dayPending = null; // 視窗開著時的候選清單：{ leftovers: [卡片], repeats: [{name, color, est}] }

// 今天的固定任務裡，行程還沒有的
function dueRepeats() {
    const dow = new Date().getDay();
    const inSchedule = new Set([...slot.querySelectorAll('.task-card .task-name')].map(e => e.innerText));
    const list = [];
    document.querySelectorAll('.task-palette .task-card').forEach(card => {
        const name = card.querySelector('.task-name').innerText;
        if (!cardRepeat(card).includes(dow) || inSchedule.has(name) || list.some(t => t.name === name)) return;
        list.push({ name, color: card.dataset.color, est: cleanEst(card.dataset.est) });
    });
    return list;
}

function checkRow(text, detail) {
    const label = document.createElement('label'); label.className = 'check-row';
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = true;
    const span = document.createElement('span'); span.textContent = text;
    if (detail) { const small = document.createElement('small'); small.textContent = detail; span.appendChild(small); }
    label.appendChild(box); label.appendChild(span);
    return label;
}

// 「今天開始了沒」記在時長設定裡一起同步：手機早上處理過，電腦就不會再問一次
function markDayStarted() { timerSettings.dayStarted = todayKey(); saveTimerSettings(); }

function checkNewDay() {
    const today = todayKey();
    if (timerSettings.dayStarted === today || drag || !isUnlocked() || document.querySelector('.modal-overlay.show')) return;
    const firstTime = !timerSettings.dayStarted; // 第一次有這個功能：行程裡的不算「之前沒做完」
    const leftovers = firstTime ? [] : [...slot.querySelectorAll('.task-card:not(.done):not(.drop-placeholder)')];
    const repeats = dueRepeats();
    if (!leftovers.length && !repeats.length) { markDayStarted(); return; }

    dayPending = { leftovers, repeats };
    document.getElementById('dayTitle').textContent = `今日開始（${shortDate(today)} ${weekdayText(today)}）`;
    const fill = (boxId, listId, rows) => {
        document.getElementById(boxId).style.display = rows.length ? '' : 'none';
        const list = document.getElementById(listId);
        list.innerHTML = '';
        rows.forEach(r => list.appendChild(r));
    };
    fill('dayLeftoverBox', 'dayLeftovers', leftovers.map(card =>
        checkRow(card.querySelector('.task-name').innerText, card.dataset.est ? `預估 ${cleanEst(card.dataset.est)} 顆` : '')));
    fill('dayRepeatBox', 'dayRepeats', repeats.map(t => checkRow(t.name, `預估 ${t.est} 顆`)));
    toggleModal(true, 'dayModal');
}

function confirmNewDay() {
    const pending = dayPending;
    dayPending = null;
    toggleModal(false, 'dayModal');
    if (!pending) return;
    const checks = id => [...document.querySelectorAll(`#${id} input`)].map(i => i.checked);
    const keep = checks('dayLeftovers'), add = checks('dayRepeats');
    pending.leftovers.forEach((card, i) => { if (!keep[i] && card.isConnected) card.remove(); });
    pending.repeats.forEach((t, i) => {
        if (add[i]) appendScheduleCard(t.name, t.color, slot.querySelector('.task-card.done'), null, t.est);
    });
    saveSchedule();
    markDayStarted();
}
document.getElementById('dayConfirm').addEventListener('click', confirmNewDay);
document.getElementById('dayAskAi').addEventListener('click', () => { confirmNewDay(); openAiModal(); });

/* --- AI 助理：把資料整理成一段文字給 AI，再把 AI 排的行程貼回來 --- */
const AI_ASK_TEXT = {
    plan: '**排今天的行程**：根據任務庫、目前行程和最近的記錄，排出我今天接下來要做的任務，以及每個任務幾顆蕃茄，並簡短說明理由。排的量要實際，參考我最近每天實際完成的顆數。',
    review: '**今日檢討**：總結我今天做了什麼、專注品質如何（中斷多不多），指出一個做得好的地方和一個可以改進的地方，並建議明天的重點。',
    week: '**每週回顧**：比較最近 7 天和前 7 天，指出時間主要花在哪裡、哪幾天或哪些任務落後，給我 2 到 3 個下週可以調整的具體建議。',
    month: '**每月回顧**：看最近 30 天的趨勢（哪幾週多、哪幾週少、各任務的比重），指出明顯的模式，給我下個月的建議。'
};

function focusLogsBetween(from, to) {
    return loadLogs().filter(l => { if (l.mode !== 'focus') return false; const d = dateKey(l.start); return d >= from && d <= to; });
}
// 每天一列的彙總表
function dailyTable(days) {
    const logs = focusLogsBetween(days[0], days[days.length - 1]);
    const lines = ['| 日期 | 專注(分) | 蕃茄 | 中斷次數 |', '|---|---:|---:|---:|'];
    days.forEach(d => {
        const day = logs.filter(l => dateKey(l.start) === d);
        const sec = day.reduce((sum, l) => sum + l.actualSec, 0);
        const pomo = day.reduce((sum, l) => sum + pomodorosOf(l), 0);
        lines.push(`| ${d} ${weekdayText(d)} | ${minutesText(sec)} | ${pomo} | ${day.filter(l => !l.completed).length} |`);
    });
    return lines;
}
function taskTotalLines(from, to) {
    const byTask = {};
    focusLogsBetween(from, to).forEach(l => { const k = l.task || '（未指定）'; byTask[k] = (byTask[k] || 0) + l.actualSec; });
    const entries = Object.entries(byTask).sort((a, b) => b[1] - a[1]);
    return entries.length ? entries.map(([task, sec]) => `- ${mdCell(task)}：${minutesText(sec)} 分鐘`) : ['- （沒有記錄）'];
}

function buildAiText(asks, note) {
    const today = todayKey();
    const has = k => asks.includes(k);
    const min = sec => Math.round(sec / 60);
    const lines = [
        '你是我的時間管理秘書。以下是我的蕃茄鐘網頁匯出的資料，請根據它回答。',
        `現在時間：${today} ${weekdayText(today)} ${clockText(Date.now())}`, '',
        '## 請幫我做這些事', ''
    ];
    asks.forEach((k, i) => lines.push(`${i + 1}. ${AI_ASK_TEXT[k]}`));
    lines.push('', '請用繁體中文回答，簡潔一點。');
    if (has('plan')) {
        lines.push('', '行程請放在回覆的最後，用程式碼區塊、一行一個任務，格式如下（我會把它貼回網頁）：', '',
            '```', '任務名稱 x 蕃茄數', '```', '',
            '任務庫裡已有的任務，名稱請一字不差；也可以加入新任務。');
    }
    if (note) lines.push('', '## 補充說明', '', note);

    lines.push(...aiDataLines(has));
    return lines.join('\n') + '\n';
}

// 各段資料（計時設定、任務庫、今日行程與記錄、最近 7／30 天）。has(k) 決定要不要放某個請求需要的段落
function aiDataLines(has) {
    const today = todayKey();
    const min = sec => Math.round(sec / 60);
    const lines = [];
    lines.push('', '## 計時設定', '',
        `- 一顆蕃茄＝專注 ${min(timerSettings.focus)} 分鐘，短休息 ${min(timerSettings.short)} 分鐘，長休息 ${min(timerSettings.long)} 分鐘（每 ${longEvery()} 顆一次）`,
        `- 今天已完成 ${getTodayCount()} 顆`);

    const cats = cleanCategories(readStoredJSON(STORAGE_KEY_CATS) || []);
    if (has('plan')) {
        lines.push('', '## 任務庫', '');
        cats.forEach(c => {
            const tasks = c.tasks.map(t => {
                const m = c.meta[t];
                const extra = [];
                if (m && m.est > 1) extra.push(`預估 ${m.est} 顆`);
                if (m && m.repeat.length) extra.push(`固定：${repeatText(m.repeat)}`);
                return extra.length ? `${t}（${extra.join('，')}）` : t;
            });
            lines.push(`- ${mdCell(c.title)}：${tasks.length ? tasks.map(mdCell).join('、') : '（沒有任務）'}`);
        });
        if (!cats.length) lines.push('- （空的）');
    }

    if (has('plan') || has('review')) {
        const stats = todayTaskStats();
        const sched = cleanSchedule(readStoredJSON(STORAGE_KEY_SCHED));
        lines.push('', '## 今日行程', '');
        sched.forEach((t, i) => {
            const s = stats[t.name] || { sec: 0, pomo: 0 };
            const extra = [];
            if (t.est) extra.push(`預估 ${t.est} 顆`);
            if (t.did) extra.push(`已完成 ${t.did} 顆`);
            if (s.sec >= 60) extra.push(`這個任務今天共專注 ${min(s.sec)} 分鐘`);
            lines.push(`${i + 1}. [${t.done ? 'x' : ' '}] ${mdCell(t.name)}${extra.length ? `（${extra.join('，')}）` : ''}`);
        });
        if (!sched.length) lines.push('（還沒有排任務）');

        const todayLogs = getLogsByDate(today);
        lines.push('', '## 今日記錄', '');
        if (todayLogs.length) {
            lines.push('| 開始 | 結束 | 類型 | 任務 | 實際(分) | 狀態 |', '|---|---|---|---|---:|---|');
            // 給 AI 讀的文字不放表情符號（有些工具讀檔時會變成亂碼），改寫成「顆」
            todayLogs.map(logRow).forEach(r => lines.push(`| ${r.start} | ${r.end} | ${r.type} | ${mdCell(r.task)} | ${r.actual} | ${r.status.replace(' 🍅', ' 顆')} |`));
        } else lines.push('（今天還沒有記錄）');
    }

    if (has('plan') || has('week')) {
        const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
        lines.push('', '## 最近 7 天', '', ...dailyTable(days), '', '各任務專注時間：', ...taskTotalLines(days[0], today));
        if (has('week')) {
            const prev = Array.from({ length: 7 }, (_, i) => addDays(today, i - 13));
            lines.push('', '## 前 7 天（比較用）', '', ...dailyTable(prev), '', '各任務專注時間：', ...taskTotalLines(prev[0], prev[6]));
        }
    }
    if (has('month')) {
        const days = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
        lines.push('', '## 最近 30 天', '', ...dailyTable(days), '', '各任務專注時間：', ...taskTotalLines(days[0], today));
    }
    return lines;
}

/* --- 存到 Google 雲端硬碟：把同一份資料存成一個檔案，讓 AI 透過雲端硬碟讀取 --- */
function buildDriveText() {
    const today = todayKey();
    return [
        '# 蕃茄鐘記錄', '',
        `更新時間：${today} ${weekdayText(today)} ${clockText(Date.now())}`,
        '（這份檔案由蕃茄鐘網頁自動產生，每次儲存都會整份覆蓋。1 顆蕃茄＝一段專注。）',
        ...aiDataLines(() => true)
    ].join('\n') + '\n';
}

function renderDriveStatus(result) {
    const status = document.getElementById('driveStatus');
    const link = document.getElementById('driveLink');
    const id = timerSettings.driveFileId;
    link.style.display = id ? '' : 'none';
    if (id) link.href = `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
    const last = prefs.driveSavedAt ? `這台裝置上次儲存：${shortDate(dateKey(prefs.driveSavedAt))} ${clockText(prefs.driveSavedAt)}` : '';
    if (!result || result.ok) { status.textContent = last || '還沒有存過。'; return; }
    const messages = {
        'signed-out': '同步還沒連上，請稍後再試。',
        'need-auth': '授權過期了，請再按一次「存到雲端硬碟」。',
        'popup': '授權視窗被瀏覽器擋住了，請允許彈出式視窗後再按一次。',
        'cancelled': '授權視窗被關掉了，沒有儲存。',
        'mismatch': '授權時選的 Google 帳號和登入的帳號不同，請選同一個帳號。',
        'no-scope': '沒有取得雲端硬碟的權限。請再按一次，並在 Google 的畫面勾選允許存取雲端硬碟檔案。',
        'api-disabled': '這個 Firebase 專案還沒啟用 Google Drive API，請先到 Google Cloud 主控台啟用。'
    };
    status.textContent = (messages[result.reason] || `儲存失敗：${result.detail || result.reason}`) + (last ? `\n${last}` : '');
}

let driveBusy = false;
async function saveToDrive(interactive) {
    const sync = window.pomodoroSync;
    if (!sync || !sync.driveSave || driveBusy) return null;
    driveBusy = true;
    try {
        const result = await sync.driveSave(interactive);
        if (result.ok) { prefs.driveSavedAt = Date.now(); savePrefs(); }
        return result;
    } catch (err) {
        return { ok: false, reason: 'error', detail: String((err && (err.code || err.message)) || err) };
    } finally { driveBusy = false; }
}
document.getElementById('driveSave').addEventListener('click', async () => {
    playTone('click');
    document.getElementById('driveStatus').textContent = '儲存中…';
    const result = await saveToDrive(true);
    if (result) renderDriveStatus(result);
});

// 自動更新：只有存過一次（已經有檔案）才會做；授權過期時不跳視窗，mayAsk 時用提示列問一次
function autoDriveSave(mayAsk) {
    if (!timerSettings.driveFileId || !isUnlocked()) return;
    saveToDrive(false).then(result => {
        if (!result) return;
        if (result.ok) { renderDriveStatus(result); return; }
        if (result.reason !== 'need-auth' || !mayAsk || prefs.driveAskedDay === todayKey()) return;
        prefs.driveAskedDay = todayKey(); savePrefs(); // 一天最多問一次
        showToast('雲端硬碟的授權過期了，要重新授權並更新檔案嗎？', '更新', async () => {
            const r = await saveToDrive(true);
            if (r) renderDriveStatus(r);
        }, 12000);
    });
}

function selectedAiAsks() {
    return [...document.querySelectorAll('#aiAsks input:checked')].map(i => i.value).filter(v => AI_ASK_TEXT[v]);
}
function updateAiPreview() {
    const asks = selectedAiAsks();
    document.getElementById('aiPreview').textContent = asks.length
        ? buildAiText(asks, document.getElementById('aiNote').value.trim())
        : '請至少勾選一項。';
    document.getElementById('aiCopy').disabled = !asks.length;
}
window.openAiModal = function() {
    const saved = Array.isArray(prefs.aiAsks) ? prefs.aiAsks : [];
    document.querySelectorAll('#aiAsks input').forEach(i => { i.checked = saved.includes(i.value); });
    document.getElementById('aiPlanStatus').textContent = '';
    renderDriveStatus();
    updateAiPreview();
    toggleModal(true, 'aiModal');
};
document.getElementById('aiAsks').addEventListener('change', () => {
    prefs.aiAsks = selectedAiAsks(); savePrefs(); // 記住這次勾的，下次打開沿用
    updateAiPreview();
});
document.getElementById('aiNote').addEventListener('input', updateAiPreview);
document.getElementById('aiCopy').addEventListener('click', async () => {
    updateAiPreview(); // 用按下當時的最新資料
    const asks = selectedAiAsks();
    if (!asks.length) return;
    const ok = await copyText(buildAiText(asks, document.getElementById('aiNote').value.trim()));
    playTone('click');
    const btn = document.getElementById('aiCopy');
    btn.textContent = ok ? '✓ 已複製，貼到 AI 吧' : '複製失敗，請從預覽手動複製';
    setTimeout(() => { btn.textContent = '📋 複製'; }, 2500);
});

// 解析 AI 回覆的行程：一行一個任務，可帶「x 3」「×3」「（3 顆）」「：3」這類顆數
function parsePlan(text) {
    const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    const body = blocks.length ? blocks[blocks.length - 1][1] : text; // 有程式碼區塊就只看最後一個
    const items = [];
    body.split(/\r?\n/).forEach(raw => {
        let line = raw.trim();
        if (!line || /^[#|>]/.test(line) || /^[-=*_\s|:]+$/.test(line)) return; // 空行、標題、表格、分隔線
        line = line.replace(/\*\*/g, '').replace(/^(?:[-*•‧]|\d+\s*[.)、．])\s*/, '').replace(/^\[[ xX✓]?\]\s*/, '').trim();
        let est = null;
        const m = line.match(/^(.*?)\s*(?:[x×✕＊*]\s*(\d{1,2})\s*顆?|[（(]\s*(\d{1,2})\s*顆?(?:蕃茄)?\s*[)）]|[:：]\s*(\d{1,2})\s*顆?|\s(\d{1,2})\s*顆(?:蕃茄)?)\s*$/i);
        if (m && m[1].trim()) { line = m[1].trim(); est = Number(m[2] || m[3] || m[4] || m[5]); }
        const name = cleanText(line).trim();
        if (!name || name === '任務名稱 x 蕃茄數' || items.length >= 50) return;
        items.push({ name, est });
    });
    return items;
}

function applyAiPlan(replace) {
    const status = document.getElementById('aiPlanStatus');
    const items = parsePlan(document.getElementById('aiPlan').value);
    if (!items.length) { status.textContent = '沒有讀到任務。請一行寫一個任務，例如「寫報告 x 3」。'; return; }
    // 任務庫裡有的任務沿用它的顏色與預估顆數
    const library = {};
    document.querySelectorAll('.task-palette .task-card').forEach(card => {
        const name = card.querySelector('.task-name').innerText;
        if (!library[name]) library[name] = { color: card.dataset.color, est: cleanEst(card.dataset.est) };
    });
    let unknown = 0;
    withUndo(STORAGE_KEY_SCHED, replace ? `已用 AI 的行程取代（${items.length} 個任務）` : `已排入 AI 的行程（${items.length} 個任務）`, () => {
        if (replace) slot.querySelectorAll('.task-card:not(.done)').forEach(card => card.remove()); // 已完成的留著
        items.forEach(item => {
            const known = library[item.name];
            if (!known) unknown++;
            const est = item.est ? cleanEst(item.est) : (known ? known.est : 1);
            // 和手動操作一致：只有行程最後一個任務剛好相同時才把顆數加上去，否則另外一張
            const existing = stackTarget(item.name);
            if (existing) existing.dataset.est = Math.min(12, (existing.dataset.est ? cleanEst(existing.dataset.est) : 1) + est);
            else appendScheduleCard(item.name, known ? known.color : '#999999', slot.querySelector('.task-card.done'), null, est);
        });
        saveSchedule();
    });
    status.textContent = `已排入 ${items.length} 個任務` + (unknown ? `，其中 ${unknown} 個不在任務庫（灰色）` : '') + '。';
    document.getElementById('aiPlan').value = '';
}
document.getElementById('aiPlanReplace').addEventListener('click', () => applyAiPlan(true));
document.getElementById('aiPlanAppend').addEventListener('click', () => applyAiPlan(false));

/* --- 設定視窗 --- */
function renderSettings() {
    document.querySelectorAll('#setTheme .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.value === prefs.theme));
    const level = Math.round(Math.min(1, Math.max(0, Number(prefs.volume) || 0)) * 10);
    document.getElementById('setVolume').value = level;
    document.getElementById('setVolumeValue').textContent = level ? level : '靜音';
    document.getElementById('setLongValue').textContent = longEvery();
    document.getElementById('setAutoStart').checked = !!timerSettings.autoStart;
    document.getElementById('setStatusNotify').checked = !!prefs.statusNotify;
    document.getElementById('setBgAudio').checked = !!prefs.bgAudio;
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
document.getElementById('setVolume').addEventListener('input', (e) => {
    prefs.volume = Number(e.target.value) / 10; savePrefs();
    renderSettings();
});
document.getElementById('setVolume').addEventListener('change', () => playTone('alarm')); // 放開滑桿時試聽
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
document.getElementById('setBgAudio').addEventListener('change', (e) => {
    prefs.bgAudio = e.target.checked; savePrefs();
    updateKeepAlive();
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

async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (err) { // 部分環境（例如直接開本機檔案）不支援 Clipboard API，改用舊方法
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;user-select:text;';
        document.body.appendChild(ta); ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        ta.remove();
        return ok;
    }
}

window.copyLog = async function() {
    const logs = getLogsByDate(logViewDate);
    if (!logs.length) { alert('這天沒有記錄'); return; }
    const text = buildMarkdown(logs, logViewDate);
    const ok = await copyText(text);
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
    // 優先用播放器的子母畫面（Chrome／Edge 會直接跳出；Firefox 沒有這個功能，會顯示面板請使用者自己按）
    const canVideoPip = document.pictureInPictureEnabled && 'requestPictureInPicture' in HTMLVideoElement.prototype;
    if (canVideoPip || !window.documentPictureInPicture) { await openVideoPip(); return; }
    try { await openDocPip(); } catch (err) { await openVideoPip(); }
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
            <div class="vp-hint">${IS_TOUCH
                ? `這個瀏覽器不能由網頁開子母畫面。可以按「全螢幕」把它當成全螢幕時鐘；有些手機瀏覽器在全螢幕時回到桌面，會把它縮成小視窗。`
                : `把滑鼠移到下方畫面上，按右側出現的「子母畫面」按鈕（或按 <b>Ctrl+Shift+]</b>），時間就會浮在所有視窗上方。<br>
                   小視窗上的<b>暫停鍵</b>可以開始／暫停計時。<br>
                   這個面板要留著，關掉會一起關閉懸浮時間。`}
            </div>
            <button class="action-btn vp-full">⛶ 全螢幕</button>`;
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true;
        panel.appendChild(video);
        document.body.appendChild(panel);
        panel.querySelector('.modal-close').onclick = () => closeVideoPip();
        panel.querySelector('.vp-full').onclick = () => {
            playTone('click');
            video.play().catch(() => {});
            try {
                if (video.requestFullscreen) video.requestFullscreen().catch(() => {});
                else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone 的 Safari
            } catch (err) {}
        };

        videoPip = { canvas, video, panel, stream: null, openedAt: Date.now() };
        drawPipCanvas(); // 先畫一張，串流才有畫面
        videoPip.stream = canvas.captureStream();
        video.srcObject = videoPip.stream;
        // 影片要一直播放畫面才會更新，所以被按了暫停就馬上繼續播，並把這一下當成「開始／暫停計時」
        video.addEventListener('pause', () => {
            const vp = videoPip;
            if (!vp || vp.video !== video) return;
            video.play().catch(() => {});
            // 剛開啟時瀏覽器自己觸發的暫停不算。手機上關掉小視窗也會觸發暫停，分不出是不是使用者按的，
            // 所以手機只靠下面的 Media Session 按鍵控制計時
            if (!IS_TOUCH && Date.now() - vp.openedAt > 1000) toggleTimer();
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

/* --- 任務庫與行程的合併 ---
 * 兩台裝置各自改了同一份資料時，不再是「後傳的整份蓋掉先傳的」，而是逐項合併。
 * 做法是三方比對：base（上次兩邊一致時的內容）、local（這台現在的）、remote（雲端現在的）。
 *   - 某一項只有一邊改過 → 用改過的那邊
 *   - 一邊新增的 → 留下
 *   - 一邊刪掉、另一邊沒動過 → 刪掉；另一邊也改過 → 留下改過的
 *   - 兩邊都改了同一項 → 以這台裝置的為準
 */
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 幫清單的每一項配上辨識用的 id；同名的第二個之後加上 #2、#3
function withIds(list, keyOf) {
    const seen = {};
    return list.map(item => {
        const k = keyOf(item);
        const n = seen[k] = (seen[k] || 0) + 1;
        return { id: n > 1 ? `${k}#${n}` : k, item };
    });
}

function mergeList(base, local, remote, mergeItem = (b, l, r) => (b !== undefined && sameJSON(l, b) ? r : l)) {
    const B = new Map(base.map(x => [x.id, x.item]));
    const L = new Map(local.map(x => [x.id, x.item]));
    const R = new Map(remote.map(x => [x.id, x.item]));
    const out = new Map();
    local.forEach(({ id, item }) => {
        if (R.has(id)) out.set(id, mergeItem(B.get(id), item, R.get(id)));
        else if (B.has(id) && sameJSON(item, B.get(id))) return; // 對方刪了，這邊沒動過
        else out.set(id, item);                                   // 這邊新增的，或對方刪了但這邊改過
    });
    remote.forEach(({ id, item }) => { if (!L.has(id) && !B.has(id)) out.set(id, item); }); // 對方新增的

    // 順序：這邊沒調過順序就照對方的，否則照這邊的；另一邊新增的項目插在它原本前一項的後面
    const ids = list => list.map(x => x.id);
    const inAll = id => B.has(id) && L.has(id) && R.has(id);
    const localMoved = !sameJSON(ids(local).filter(inAll), ids(base).filter(inAll));
    const [backbone, other] = localMoved ? [local, remote] : [remote, local];
    const order = ids(backbone).filter(id => out.has(id));
    const src = ids(other);
    src.forEach((id, i) => {
        if (!out.has(id) || order.includes(id)) return;
        const pred = src.slice(0, i).reverse().find(p => order.includes(p));
        order.splice(pred === undefined ? 0 : order.indexOf(pred) + 1, 0, id);
    });
    return order.map(id => out.get(id));
}

function mergeCategory(b, l, r) {
    const names = c => withIds(c ? c.tasks : [], t => t);
    const tasks = mergeList(names(b), names(l), names(r));
    const meta = {};
    tasks.forEach(t => {
        const bm = b && b.meta[t], lm = l.meta[t], rm = r.meta[t];
        const pick = sameJSON(lm, bm) ? rm : lm;
        if (pick) meta[t] = pick;
    });
    return { title: l.title, color: b && l.color === b.color ? r.color : l.color, tasks, meta };
}

function mergeStored(key, baseStr, localStr, remoteStr) {
    const parse = s => { try { return JSON.parse(s || '[]'); } catch (err) { return []; } };
    if (key === STORAGE_KEY_CATS) {
        const prep = s => withIds(cleanCategories(parse(s)), c => c.title);
        return JSON.stringify(mergeList(prep(baseStr), prep(localStr), prep(remoteStr), mergeCategory));
    }
    if (key === STORAGE_KEY_SCHED) {
        const prep = s => withIds(cleanSchedule(parse(s)), t => t.id);
        return JSON.stringify(mergeList(prep(baseStr), prep(localStr), prep(remoteStr)));
    }
    if (key === STORAGE_KEY_REWARDS) return mergeRewards(baseStr, localStr, remoteStr);
    if (key === STORAGE_KEY_REMIND) {
        const prep = s => withIds(cleanReminders(parse(s)), r => r.id);
        return JSON.stringify(mergeList(prep(baseStr), prep(localStr), prep(remoteStr)));
    }
    if (key === STORAGE_KEY_DONE) {
        const prep = s => withIds(cleanDone(parse(s)), d => d.id);
        return JSON.stringify(cleanDone(mergeList(prep(baseStr), prep(localStr), prep(remoteStr))));
    }
    if (key === STORAGE_KEY_TIMER) return mergeTimer(baseStr, localStr, remoteStr);
    return localStr;
}

// 時長設定逐欄合併：這台裝置沒改過的欄位用對方的，兩邊都改了同一欄以這台為準
function mergeTimer(baseStr, localStr, remoteStr) {
    const obj = s => {
        try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
        catch (err) { return {}; }
    };
    const b = obj(baseStr), l = obj(localStr), r = obj(remoteStr);
    const out = {};
    new Set([...Object.keys(l), ...Object.keys(r)]).forEach(k => {
        const v = sameJSON(l[k], b[k]) ? r[k] : l[k];
        if (v !== undefined) out[k] = v;
    });
    return JSON.stringify(out);
}

// 套用另一台裝置傳來的計時狀態（已經寫進 localStorage）
function adoptRemoteTimerState() {
    isRunning = false;
    clearInterval(tickTimer); clearTimeout(finishTimer);
    const s = readStoredJSON(STORAGE_KEY_STATE);
    session = null;
    if (s && s.session) timerSettings.countUp = !!s.session.countUp; // 倒數／正數跟著那一段走
    if (!s) { timeLeft = timerSettings[mode]; elapsed = 0; }          // 對方重置了全部資料
    if (s && s.isRunning) { hideToast(); stopAttention(); }
    restoreTimerState();
    updateWakeLock();
}

/* --- 獎勵：專注賺點數、商店兌換、依累計點數升級 ---
 * 資料（pomodoro_rewards_v1）：
 *   weights  { 類別名稱: 每顆幾點 }，沒設定的類別用 defaultWeight 猜；other：不在任務庫或沒選任務的
 *   shop     [{id, name, cost}]  商店項目（還沒存過時用 REWARD_DEFAULT_SHOP）
 *   redeems  [{id, at, name, cost}]  還沒結算的兌換
 *   accounts [{id, name, budget, rate, base}]  帳戶：每月最多能用星星存入多少（budget，0＝不能存星星）、
 *            匯率（rate：1 星換多少錢）、每月固定底薪（base，例如吃飯錢，不靠星星）
 *   deposits [{id, at, acc, stars, amount}]  星星存入帳戶
 *   grants   [{id, at, acc, amount}]         每月底薪（id 為 b:帳戶:YYYY-MM，兩台裝置各自發也不會重複）
 *   expenses [{id, at, acc, name, amount}]   支出（可以透支）
 *   transfers [{id, at, from, to, amount}]   帳戶之間轉帳
 *   days     { 'YYYY-MM-DD': {e: 賺到, s: 兌換花掉的星星} }  已結算的日子
 *            （舊版的 d／x 是存入、支出娛樂帳戶的錢，仍會讀取）
 *   archive  { 'YYYY-MM': { 帳戶: [存入, 底薪, 支出, 轉入, 轉出, 存入用掉的星星] } }
 *            錢的明細和時間記錄一樣保留一年，更早的月份結算成每月總數（見 settleRewards）
 * 舊版的 fund（單一娛樂基金）讀取時會轉成編號 fun 的「娛樂」帳戶。
 * 點數不另外存「餘額」：某一天在 days 裡就用結算的數字，否則從時間記錄與 redeems 現算。
 * 最近 REWARD_LIVE_DAYS 天不結算，所以修改、刪除最近的記錄會反映在點數上；記錄保留一年後刪掉也不影響已結算的點數。 */
function cleanInt(v, min, max, d) { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : d; }
function cleanRewards(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = { weights: {}, redeems: [], days: {}, archive: {} };
    if (r.weights && typeof r.weights === 'object') {
        Object.keys(r.weights).slice(0, 100).forEach(k => {
            const w = cleanInt(r.weights[k], 0, REWARD_MAX_WEIGHT, null);
            if (w !== null && cleanText(k, 100)) out.weights[cleanText(k, 100)] = w;
        });
    }
    const other = cleanInt(r.other, 0, REWARD_MAX_WEIGHT, null);
    if (other !== null) out.other = other;
    if (Array.isArray(r.shop)) {
        out.shop = r.shop.slice(0, 100).filter(s => s && typeof s === 'object' && cleanText(s.name))
            .map(s => ({ id: cleanText(s.id, 40) || newItemId(), name: cleanText(s.name, 100), cost: cleanInt(s.cost, 1, 9999, 10) }));
    }
    if (Array.isArray(r.redeems)) {
        out.redeems = r.redeems.slice(-2000).filter(x => x && typeof x === 'object' && Number.isFinite(x.at))
            .map(x => ({ id: cleanText(x.id, 40) || newItemId(), at: x.at, name: cleanText(x.name, 100), cost: cleanInt(x.cost, 0, 99999, 0) }));
    }
    if (r.days && typeof r.days === 'object') {
        Object.keys(r.days).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).slice(-5000).forEach(k => {
            const d = r.days[k] || {};
            const day = { e: cleanInt(d.e, 0, 1e7, 0), s: cleanInt(d.s, 0, 1e7, 0) };
            ['d', 'x'].forEach(f => { const n = cleanInt(d[f], 0, 1e9, 0); if (n) day[f] = n; }); // 舊版娛樂基金的存入／支出
            out.days[k] = day;
        });
    }
    const rateOf = v => { const n = Math.round(Number(v) * 100) / 100; return n > 0 && n <= 10000 ? n : 1; };
    if (r.rate && typeof r.rate === 'object') {
        out.rate = {
            mode: ['goal', 'history', 'manual'].includes(r.rate.mode) ? r.rate.mode : 'goal',
            goalMin: cleanInt(r.rate.goalMin, 15, 1440, 120), goalDays: cleanInt(r.rate.goalDays, 1, 31, 25)
        };
    }
    let accounts = Array.isArray(r.accounts) ? r.accounts : null;
    if (!accounts && r.fund && typeof r.fund === 'object') accounts = [{ id: 'fun', name: '娛樂', budget: r.fund.budget, rate: r.fund.rate, base: 0 }];
    if (accounts) {
        const seen = new Set();
        out.accounts = accounts.slice(0, 20).filter(a => a && typeof a === 'object').map(a => ({
            id: cleanText(a.id, 40) || newItemId(), name: cleanText(a.name, 40) || '帳戶',
            budget: cleanInt(a.budget, 0, 1e6, 0), rate: rateOf(a.rate), base: cleanInt(a.base, 0, 1e6, 0)
        })).filter(a => !seen.has(a.id) && seen.add(a.id));
    }
    // 同一個編號只留第一筆（例如兩台裝置各自發了同一個月的底薪）
    const list = (v, keep) => {
        if (!Array.isArray(v)) return [];
        const seen = new Set();
        return v.slice(-10000).filter(x => x && typeof x === 'object' && Number.isFinite(x.at)).map(keep)
            .filter(x => !seen.has(x.id) && seen.add(x.id));
    };
    const id = x => cleanText(x.id, 40) || newItemId();
    const acc = v => cleanText(v, 40) || 'fun';
    out.deposits = list(r.deposits, x => ({ id: id(x), at: x.at, acc: acc(x.acc), stars: cleanInt(x.stars, 1, 1e7, 1), amount: cleanInt(x.amount, 0, 1e9, 0) }));
    out.grants = list(r.grants, x => ({ id: id(x), at: x.at, acc: acc(x.acc), amount: cleanInt(x.amount, 0, 1e9, 0) }));
    out.expenses = list(r.expenses, x => ({ id: id(x), at: x.at, acc: acc(x.acc), name: cleanText(x.name, 100), amount: cleanInt(x.amount, 1, 1e9, 1) }));
    out.transfers = list(r.transfers, x => ({ id: id(x), at: x.at, from: acc(x.from), to: acc(x.to), amount: cleanInt(x.amount, 1, 1e9, 1) }))
        .filter(x => x.from !== x.to);
    if (r.archive && typeof r.archive === 'object') {
        Object.keys(r.archive).filter(k => /^\d{4}-\d{2}$/.test(k)).slice(-600).forEach(m => {
            const month = r.archive[m] && typeof r.archive[m] === 'object' ? r.archive[m] : {};
            out.archive[m] = {};
            Object.keys(month).slice(0, 50).forEach(a => {
                const v = Array.isArray(month[a]) ? month[a] : [];
                out.archive[m][cleanText(a, 40)] = [0, 1, 2, 3, 4, 5].map(i => cleanInt(v[i], 0, 1e12, 0));
            });
        });
    }
    return out;
}
function rewardAccounts(r) { return r.accounts || []; }
function loadRewards() { return cleanRewards(readStoredJSON(STORAGE_KEY_REWARDS)); }
function saveRewards(r) { storeSet(STORAGE_KEY_REWARDS, JSON.stringify(r)); }
function rewardShop(r) { return r.shop || REWARD_DEFAULT_SHOP; }

// 類別還沒設定點數時的預設：娛樂類 0 點、生活類 5 點、其他 10 點
function defaultWeight(title) {
    if (/耍廢|遊戲|手遊|單機|娛樂|休閒|追劇|廢片|放鬆/.test(title)) return 0;
    if (/健康|生活|家事|吃飯|休息/.test(title)) return 5;
    return 10;
}
function rewardCategories() { return cleanCategories(readStoredJSON(STORAGE_KEY_CATS) || []); }
function weightOfCategory(r, title) { return Object.prototype.hasOwnProperty.call(r.weights, title) ? r.weights[title] : defaultWeight(title); }
function otherWeight(r) { return r.other != null ? r.other : REWARD_DEFAULT_OTHER; }

// 回傳「任務名稱 → 每顆幾點」的函式（任務屬於哪個類別，用目前任務庫的名稱對照）
function rewardWeigher(r) {
    const byTask = {};
    rewardCategories().forEach(c => c.tasks.forEach(t => { if (!(t in byTask)) byTask[t] = weightOfCategory(r, c.title); }));
    return task => (Object.prototype.hasOwnProperty.call(byTask, task) ? byTask[task] : otherWeight(r));
}

// 一筆記錄賺幾點：有算成蕃茄的專注（規則同今日蕃茄數），依實際分鐘數 × 類別的「每 15 分鐘幾點」
function rewardStarsOf(l, weigh) {
    return pomodorosOf(l) > 0 ? Math.round(l.actualSec / REWARD_UNIT_SEC * weigh(l.task)) : 0;
}

// 尚未結算的日子：每天賺到與花掉的點數
function liveRewardDays(r) {
    const weigh = rewardWeigher(r);
    const days = {};
    const day = d => days[d] || (days[d] = { e: 0, s: 0, ds: 0 });
    loadLogs().forEach(l => {
        const d = dateKey(l.end);
        if (r.days[d]) return;
        const p = rewardStarsOf(l, weigh);
        if (p) day(d).e += p;
    });
    r.redeems.forEach(x => { const d = dateKey(x.at); if (!r.days[d]) day(d).s += x.cost; });
    // 存入帳戶的星星（ds）只用來顯示；它不結算，總數直接從 deposits 算
    r.deposits.forEach(x => { const d = dateKey(x.at); if (!r.days[d]) day(d).ds += x.stars; });
    return days;
}

// 等級：Lv.N 需要累計 50 × N × (N − 1) 點（Lv.2 = 100、Lv.3 = 300、Lv.4 = 600…）
function levelNeed(n) { return 50 * n * (n - 1); }
function levelOf(earned) {
    let n = 1;
    while (earned >= levelNeed(n + 1)) n++;
    return n;
}
function levelTitle(n) { return REWARD_TITLES[n - 1] || '蕃茄傳說'; }

function rewardSummary(r = loadRewards()) {
    const live = liveRewardDays(r);
    let earned = 0, spent = 0, last30 = 0;
    const from30 = addDays(todayKey(), -29);
    [...Object.entries(r.days), ...Object.entries(live)].forEach(([date, d]) => {
        earned += d.e; spent += d.s;
        if (date >= from30) last30 += d.e;
    });
    r.deposits.forEach(x => { spent += x.stars; });
    Object.values(r.archive).forEach(m => Object.values(m).forEach(v => { spent += v[5]; }));
    const today = live[todayKey()] || r.days[todayKey()] || { e: 0, s: 0, ds: 0 };
    return { earned, spent, balance: earned - spent, today, live, level: levelOf(earned), last30 };
}

// 結算：把 REWARD_LIVE_DAYS 天以前的日子存成每日總數，並刪掉那些日子的兌換明細
function settleRewards() {
    const r = loadRewards();
    const cutoff = addDays(todayKey(), -(REWARD_LIVE_DAYS - 1));
    const live = liveRewardDays(r);
    const old = Object.keys(live).filter(d => d < cutoff);
    const recent = x => dateKey(x.at) >= cutoff;
    const archived = archiveOldMoney(r);
    if (!old.length && r.redeems.every(recent) && !archived) return;
    old.forEach(d => { r.days[d] = { e: live[d].e, s: live[d].s }; });
    r.redeems = r.redeems.filter(recent);
    saveRewards(r);
}

// 錢的明細保留一年：一年前那個月之前的月份，結算成每個帳戶的每月總數。回傳有沒有變動
function archiveOldMoney(r) {
    const keepFrom = addDays(todayKey(), -LOG_KEEP_DAYS).slice(0, 7); // 這個月份（含）之後的明細保留
    const monthOf = x => dateKey(x.at).slice(0, 7);
    const lists = ['deposits', 'grants', 'expenses', 'transfers'];
    if (lists.every(k => r[k].every(x => monthOf(x) >= keepFrom))) return false;
    const fresh = {}; // 這次才結算的月份（別台裝置已經結算過的月份，直接丟掉明細）
    const add = (m, acc, i, v) => {
        if (r.archive[m] && !fresh[m]) return;
        if (!r.archive[m]) { r.archive[m] = {}; fresh[m] = true; }
        const row = r.archive[m][acc] || (r.archive[m][acc] = [0, 0, 0, 0, 0, 0]);
        row[i] += v;
    };
    const old = x => monthOf(x) < keepFrom;
    r.deposits.filter(old).forEach(x => { add(monthOf(x), x.acc, 0, x.amount); add(monthOf(x), x.acc, 5, x.stars); });
    r.grants.filter(old).forEach(x => add(monthOf(x), x.acc, 1, x.amount));
    r.expenses.filter(old).forEach(x => add(monthOf(x), x.acc, 2, x.amount));
    r.transfers.filter(old).forEach(x => { add(monthOf(x), x.to, 3, x.amount); add(monthOf(x), x.from, 4, x.amount); });
    lists.forEach(k => { r[k] = r[k].filter(x => !old(x)); });
    return true;
}

// 主畫面的點數按鈕
function updateRewardBadge() {
    const btn = document.getElementById('pointsBtn');
    if (!btn) return;
    const s = rewardSummary();
    btn.textContent = `⭐ ${s.balance}`;
    btn.title = `Lv.${s.level} ${levelTitle(s.level)}，今天賺到 ${s.today.e} 點`;
    if (document.getElementById('rewardModal').classList.contains('show')) renderRewards();
}

// 剛完成蕃茄時的提示文字（例如「+20 ⭐」，升級時加上新等級）。before：完成前的 rewardSummary()
function rewardGainText(before) {
    const after = rewardSummary();
    const gained = after.earned - before.earned;
    if (gained <= 0) return '';
    let text = `+${gained} ⭐`;
    if (after.level > before.level) text += `，升到 Lv.${after.level}「${levelTitle(after.level)}」！`;
    return text;
}

function rewardRow(className) { const row = document.createElement('div'); row.className = className; return row; }
function rewardEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
}

function renderRewards() {
    const r = loadRewards();
    const s = rewardSummary(r);
    const lv = s.level, from = levelNeed(lv), to = levelNeed(lv + 1);
    document.getElementById('rwLevel').textContent = `Lv.${lv} ${levelTitle(lv)}`;
    document.getElementById('rwBalance').textContent = `⭐ ${s.balance}`;
    document.getElementById('rwLevelFill').style.width = `${Math.min(100, (s.earned - from) / (to - from) * 100)}%`;
    document.getElementById('rwLevelNote').textContent =
        `累計 ${s.earned} 點，再 ${to - s.earned} 點升到 Lv.${lv + 1} · 今天 +${s.today.e}` + (s.today.s ? `、−${s.today.s}` : '');

    // 商店
    const shop = document.getElementById('rwShop');
    shop.innerHTML = '';
    const items = rewardShop(r);
    if (!items.length) shop.appendChild(rewardEl('div', 'stats-empty', '商店是空的，在下面新增你想要的獎勵'));
    items.forEach(item => {
        const row = rewardRow('rw-item');
        row.appendChild(rewardEl('span', 'rw-item-name', item.name));
        row.appendChild(rewardEl('span', 'rw-item-cost', `${item.cost} ⭐`));
        const buy = rewardEl('button', 'rw-buy', s.balance >= item.cost ? '兌換' : `差 ${item.cost - s.balance}`);
        buy.disabled = s.balance < item.cost;
        buy.addEventListener('click', () => redeemReward(item));
        const del = rewardEl('button', 'rw-del', '✕');
        del.title = '從商店移除';
        del.addEventListener('click', () => removeShopItem(item));
        row.appendChild(buy); row.appendChild(del);
        shop.appendChild(row);
    });

    // 每顆蕃茄的點數
    const box = document.getElementById('rwWeights');
    box.innerHTML = '';
    const weightRow = (label, color, value, onChange) => {
        const row = rewardRow('setting-row');
        const name = rewardEl('span', 'setting-label rw-cat');
        if (color) { const dot = rewardEl('span', 'rw-dot'); dot.style.background = color; name.appendChild(dot); }
        name.appendChild(document.createTextNode(label));
        const stepper = rewardRow('stepper');
        const minus = rewardEl('button', 'seg-btn', '−'), plus = rewardEl('button', 'seg-btn', '＋');
        minus.setAttribute('aria-label', '減少'); plus.setAttribute('aria-label', '增加');
        minus.addEventListener('click', () => onChange(Math.max(0, value - 1)));
        plus.addEventListener('click', () => onChange(Math.min(REWARD_MAX_WEIGHT, value + 1)));
        stepper.appendChild(minus); stepper.appendChild(rewardEl('span', null, String(value))); stepper.appendChild(plus);
        row.appendChild(name); row.appendChild(stepper);
        box.appendChild(row);
    };
    const changeWeight = mutate => v => { playTone('click'); const x = loadRewards(); mutate(x, v); saveRewards(x); updateRewardBadge(); };
    const seen = new Set();
    rewardCategories().forEach(c => {
        if (seen.has(c.title)) return; seen.add(c.title);
        weightRow(c.title, c.color, weightOfCategory(r, c.title), changeWeight((x, v) => { x.weights[c.title] = v; }));
    });
    weightRow('其他（不在任務庫、沒選任務）', null, otherWeight(r), changeWeight((x, v) => { x.other = v; }));

    renderFund(r, s);

    // 最近的紀錄：每天賺到多少，以及還沒結算的兌換、存入、支出（可以取消）
    const hist = document.getElementById('rwHistory');
    hist.innerHTML = '';
    const dates = Object.keys(s.live).sort().reverse();
    if (!dates.length) hist.appendChild(rewardEl('div', 'stats-empty', '最近 7 天沒有點數紀錄'));
    dates.forEach(d => {
        const day = s.live[d];
        hist.appendChild(rewardEl('div', 'rw-day', `${shortDate(d)}（${weekdayText(d)}）賺到 ${day.e} 點`
            + (day.s ? `，兌換 ${day.s} 點` : '') + (day.ds ? `，存入帳戶 ${day.ds} 點` : '')));
        const name = id => { const a = rewardAccounts(r).find(x => x.id === id); return a ? a.name : '已刪除的帳戶'; };
        const entries = [
            ...r.redeems.map(x => ({ at: x.at, text: x.name, val: `−${x.cost} ⭐`, title: '取消這次兌換（退回點數）', undo: () => cancelRewardEntry('redeems', x.id) })),
            ...r.deposits.map(x => ({ at: x.at, text: `存入「${name(x.acc)}」`, val: `−${x.stars} ⭐ → ${money(x.amount)}`, title: '取消這次存入（退回星星）', undo: () => cancelRewardEntry('deposits', x.id) })),
            ...r.grants.map(x => ({ at: x.at, text: `「${name(x.acc)}」本月底薪`, val: `+${money(x.amount)}` })),
            ...r.expenses.map(x => ({ at: x.at, text: `${name(x.acc)}：${x.name || '支出'}`, val: `−${money(x.amount)}`, title: '刪除這筆支出', undo: () => cancelRewardEntry('expenses', x.id) })),
            ...r.transfers.map(x => ({ at: x.at, text: `轉帳 ${name(x.from)} → ${name(x.to)}`, val: money(x.amount), title: '取消這次轉帳', undo: () => cancelRewardEntry('transfers', x.id) }))
        ];
        entries.filter(x => dateKey(x.at) === d).sort((a, b) => b.at - a.at).forEach(x => {
            const row = rewardRow('rw-item rw-redeem');
            row.appendChild(rewardEl('span', 'rw-item-name', `${clockText(x.at)} ${x.text}`));
            row.appendChild(rewardEl('span', 'rw-item-cost', x.val));
            if (x.undo) {
                const cancel = rewardEl('button', 'rw-del', '✕');
                cancel.title = x.title;
                cancel.addEventListener('click', x.undo);
                row.appendChild(cancel);
            }
            hist.appendChild(row);
        });
    });
}

function redeemReward(item) {
    const r = loadRewards();
    if (rewardSummary(r).balance < item.cost) return;
    const entry = { id: newItemId(), at: Date.now(), name: item.name, cost: item.cost };
    r.redeems.push(entry);
    saveRewards(r);
    playTone('alarm');
    updateRewardBadge();
    showToast(`已兌換「${item.name}」，−${item.cost} ⭐ 好好享受！`, '復原', () => cancelRedeem(entry.id, true), 8000);
}
function cancelRedeem(id, quiet) { cancelRewardEntry('redeems', id, quiet); }
// 取消一筆兌換／存入／支出（list：redeems、deposits、expenses）
function cancelRewardEntry(list, id, quiet) {
    const r = loadRewards();
    r[list] = r[list].filter(x => x.id !== id);
    saveRewards(r);
    if (!quiet) playTone('delete');
    updateRewardBadge();
}

/* 帳戶：像自由業者付薪水給自己。星星依各帳戶的匯率存成錢（每月存入有上限），
 * 必要開銷的帳戶可以設每月底薪（不靠星星），支出可以透支，帳戶之間可以轉帳（但當月沒用完的底薪不能轉出）。
 * 這只是記帳，不會動到真正的錢。 */
function money(n) { return `NT$${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('zh-TW')}`; }
function thisMonth() { return todayKey().slice(0, 7); }
// 建議匯率：所有能存星星的帳戶的每月上限加總 ÷ 最近 30 天賺到的星星（記錄太少時當作一個月 300 星）。
// 大家用同一個匯率，照最近的努力程度剛好能把每個帳戶存滿
function suggestedRate(totalBudget, last30) { return Math.max(0.01, Math.round(totalBudget / Math.max(last30, 300) * 100) / 100); }

/* 匯率的三種算法（rate.mode）：
 *   goal     依每天目標（預設）：每月目標星星＝每天目標分鐘 ÷ 15 × 10 星 × 每月目標天數，
 *            匯率＝所有帳戶的每月存入上限加總 ÷ 每月目標星星。做到目標剛好存滿；匯率固定，不會因為偷懶變高
 *   history  依過去表現：按「重算」時用最近 30 天賺到的星星算，記錄滿 14 天才能算，而且只會調低不會調高
 *   manual   每個帳戶自己填 */
function rateSettings(r) { return { mode: 'goal', goalMin: 120, goalDays: 25, ...(r.rate || {}) }; }
function goalMonthStars(rs) { return Math.round(rs.goalMin / 15 * 10 * rs.goalDays); }
function starBudgetTotal(accounts) { return accounts.reduce((sum, a) => sum + (a.budget || 0), 0); }
function goalRate(total, rs) { const t = goalMonthStars(rs); return t && total ? Math.max(0.01, Math.round(total / t * 100) / 100) : 1; }
function accRate(r, a) { const rs = rateSettings(r); return rs.mode === 'goal' ? goalRate(starBudgetTotal(rewardAccounts(r)), rs) : a.rate; }
// 有記錄的天數（從第一筆專注記錄到今天），依過去表現至少要 14 天
function historyDays() {
    const logs = loadLogs().filter(l => l.mode === 'focus');
    if (!logs.length) return 0;
    return Math.round((new Date(`${todayKey()}T00:00`) - new Date(`${dateKey(logs[0].start)}T00:00`)) / 86400000) + 1;
}

// 各帳戶的餘額與本月數字：balance、monthIn（本月用星星存入的錢，計入上限）、monthBase（本月底薪）、monthOut（本月支出）
function accountStats(r) {
    const month = thisMonth(), inMonth = at => dateKey(at).startsWith(month);
    const st = {};
    rewardAccounts(r).forEach(a => { st[a.id] = { balance: 0, monthIn: 0, monthBase: 0, monthOut: 0 }; });
    const add = (id, k, v) => { if (st[id]) st[id][k] += v; };
    r.deposits.forEach(x => { add(x.acc, 'balance', x.amount); if (inMonth(x.at)) add(x.acc, 'monthIn', x.amount); });
    r.grants.forEach(x => { add(x.acc, 'balance', x.amount); if (inMonth(x.at)) add(x.acc, 'monthBase', x.amount); });
    r.expenses.forEach(x => { add(x.acc, 'balance', -x.amount); if (inMonth(x.at)) add(x.acc, 'monthOut', x.amount); });
    r.transfers.forEach(x => { add(x.from, 'balance', -x.amount); add(x.to, 'balance', x.amount); });
    Object.values(r.archive).forEach(m => Object.entries(m).forEach(([acc, v]) => add(acc, 'balance', v[0] + v[1] - v[2] + v[3] - v[4])));
    Object.entries(r.days).forEach(([d, v]) => { // 舊版娛樂基金已結算的存入／支出
        add('fun', 'balance', (v.d || 0) - (v.x || 0));
        if (d.startsWith(thisMonth())) { add('fun', 'monthIn', v.d || 0); add('fun', 'monthOut', v.x || 0); }
    });
    return st;
}
// 這次最多能存入幾顆星：不超過星星餘額，也不超過這個帳戶本月剩下的額度
function maxDepositStars(acc, rate, st, starBalance) {
    if (!acc || !acc.budget) return 0;
    const room = Math.max(0, acc.budget - st.monthIn);
    return Math.max(0, Math.min(starBalance, Math.floor(room / rate + 1e-9)));
}
// 最多能轉出多少：本月底薪還沒花掉的部分要留著
function transferable(st) { return Math.max(0, st.balance - Math.max(0, st.monthBase - st.monthOut)); }

// 每月底薪：每個月第一次打開時發放（編號含月份，兩台裝置各自發也只會算一次）
function grantBaseSalaries() {
    const r = loadRewards();
    const month = thisMonth();
    let changed = false;
    rewardAccounts(r).forEach(a => {
        const id = `b:${a.id}:${month}`;
        if (!a.base || r.grants.some(g => g.id === id)) return;
        r.grants.push({ id, at: Date.now(), acc: a.id, amount: a.base });
        changed = true;
    });
    if (changed) saveRewards(r);
}

function fundMsg(text, bad) { const el = document.getElementById('fdMsg'); el.textContent = text; el.classList.toggle('bad', !!bad); }
function accById(r, id) { return rewardAccounts(r).find(a => a.id === id); }

// 下拉選單：保留原本選的帳戶
function fillAccountSelect(id, accounts) {
    const sel = document.getElementById(id);
    const keep = sel.value;
    sel.innerHTML = '';
    accounts.forEach(a => { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; sel.appendChild(o); });
    if (accounts.some(a => a.id === keep)) sel.value = keep;
}
function updateFundPreview() {
    const r = loadRewards();
    const acc = accById(r, document.getElementById('fdDepAcc').value);
    const n = cleanInt(document.getElementById('fdStars').value, 1, 1e7, null);
    const input = document.getElementById('fdStars');
    document.getElementById('fdPreview').textContent = acc && n ? `＝${money(Math.floor(n * accRate(r, acc)))}` : '';
    if (acc) {
        const st = accountStats(r)[acc.id], max = maxDepositStars(acc, accRate(r, acc), st, rewardSummary(r).balance);
        input.placeholder = max ? `幾顆星（最多 ${max}）` : (st.monthIn >= acc.budget ? '本月額度已滿' : '星星不夠');
    }
}

function renderFund(r, s) {
    const accounts = rewardAccounts(r);
    const st = accountStats(r);
    document.getElementById('fdSetup').style.display = accounts.length ? 'none' : '';
    document.getElementById('fdOps').style.display = accounts.length ? '' : 'none';
    const list = document.getElementById('acList');
    list.innerHTML = '';
    accounts.forEach(a => {
        const x = st[a.id];
        const row = rewardRow('rw-item ac-row');
        const info = rewardRow('ac-info');
        info.appendChild(rewardEl('div', 'ac-name', a.name));
        const parts = [];
        if (a.budget) parts.push(`本月存入 ${money(x.monthIn)}／${money(a.budget)} · 1 ⭐ = NT$${accRate(r, a)}`);
        if (a.base) parts.push(`底薪 ${money(a.base)}／月`);
        if (x.monthOut) parts.push(`本月支出 ${money(x.monthOut)}`);
        info.appendChild(rewardEl('div', 'ac-note', parts.join(' · ') || '只能用轉帳或底薪存錢'));
        const bal = rewardEl('span', 'rw-money' + (x.balance < 0 ? ' bad' : ''), money(x.balance));
        row.appendChild(info); row.appendChild(bal);
        list.appendChild(row);
    });
    const total = accounts.reduce((sum, a) => sum + st[a.id].balance, 0);
    document.getElementById('fdNote').textContent = accounts.length
        ? `全部帳戶合計 ${money(total)}`
        : '先設定每月的娛樂預算，網頁會依你最近的努力程度算出星星的匯率。之後可以在「帳戶設定」新增吃飯、購物等帳戶。';

    const starAccounts = accounts.filter(a => a.budget > 0);
    fillAccountSelect('fdDepAcc', starAccounts);
    document.getElementById('fdDepRow').style.display = starAccounts.length ? '' : 'none';
    fillAccountSelect('fdExpAcc', accounts);
    fillAccountSelect('fdFrom', accounts);
    fillAccountSelect('fdTo', accounts);
    if (accounts.length > 1 && document.getElementById('fdFrom').value === document.getElementById('fdTo').value) {
        document.getElementById('fdTo').value = accounts.find(a => a.id !== document.getElementById('fdFrom').value).id;
    }
    document.getElementById('fdTrRow').style.display = accounts.length > 1 ? '' : 'none';
    updateFundPreview();
}

// 第一次使用：只填娛樂預算，建立「娛樂」帳戶
function setFundBudget() {
    const input = document.getElementById('fdBudgetNew');
    const budget = cleanInt(input.value, 1, 1e6, null);
    if (budget === null) { input.focus(); return; }
    const r = loadRewards();
    const rate = goalRate(budget, rateSettings(r));
    r.accounts = [...rewardAccounts(r), { id: 'fun', name: '娛樂', budget, rate, base: 0 }];
    saveRewards(r);
    playTone('click');
    input.value = '';
    fundMsg(`已建立「娛樂」帳戶，1 ⭐ = NT$${rate}`);
    renderAccountSettings();
    updateRewardBadge();
}

function depositFund() {
    const r = loadRewards();
    const acc = accById(r, document.getElementById('fdDepAcc').value);
    if (!acc) return;
    const s = rewardSummary(r), st = accountStats(r)[acc.id];
    const input = document.getElementById('fdStars');
    const rate = accRate(r, acc);
    const max = maxDepositStars(acc, rate, st, s.balance);
    const n = cleanInt(input.value, 1, 1e7, null);
    if (n === null) { if (max) input.value = max; updateFundPreview(); input.focus(); return; } // 沒填：先幫你填最多能存的
    if (n > s.balance) { fundMsg(`星星不夠，目前只有 ${s.balance} 顆`, true); return; }
    if (n > max) { fundMsg(`「${acc.name}」本月額度只剩 ${money(Math.max(0, acc.budget - st.monthIn))}，最多存 ${max} 顆星`, true); return; }
    const entry = { id: newItemId(), at: Date.now(), acc: acc.id, stars: n, amount: Math.floor(n * rate) };
    r.deposits.push(entry);
    saveRewards(r);
    playTone('alarm');
    input.value = '';
    fundMsg(`已存入「${acc.name}」${money(entry.amount)}`);
    updateRewardBadge();
    showToast(`${n} ⭐ 已存成「${acc.name}」${money(entry.amount)}`, '復原', () => cancelRewardEntry('deposits', entry.id, true), 8000);
}

function addFundExpense() {
    const nameEl = document.getElementById('fdExpName'), amountEl = document.getElementById('fdExpAmount');
    const amount = cleanInt(amountEl.value, 1, 1e9, null);
    if (amount === null) { amountEl.focus(); return; }
    const r = loadRewards();
    const acc = accById(r, document.getElementById('fdExpAcc').value);
    if (!acc) return;
    r.expenses.push({ id: newItemId(), at: Date.now(), acc: acc.id, name: nameEl.value.trim().slice(0, 100) || '支出', amount });
    saveRewards(r);
    playTone('click');
    nameEl.value = ''; amountEl.value = '';
    const left = accountStats(r)[acc.id].balance;
    fundMsg(left < 0 ? `已記錄支出，「${acc.name}」透支 ${money(-left)}，之後存入就會補回來` : `已記錄支出，「${acc.name}」剩下 ${money(left)}`, left < 0);
    updateRewardBadge();
}

function transferFund() {
    const amountEl = document.getElementById('fdTrAmount');
    const amount = cleanInt(amountEl.value, 1, 1e9, null);
    if (amount === null) { amountEl.focus(); return; }
    const r = loadRewards();
    const from = accById(r, document.getElementById('fdFrom').value), to = accById(r, document.getElementById('fdTo').value);
    if (!from || !to) return;
    if (from.id === to.id) { fundMsg('轉出和轉入要選不同的帳戶', true); return; }
    const st = accountStats(r)[from.id], max = transferable(st);
    if (amount > max) {
        fundMsg(st.monthBase > st.monthOut && st.balance > 0
            ? `「${from.name}」本月底薪還沒用完的部分要留著，最多可轉 ${money(max)}`
            : `「${from.name}」餘額不夠，最多可轉 ${money(max)}`, true);
        return;
    }
    r.transfers.push({ id: newItemId(), at: Date.now(), from: from.id, to: to.id, amount });
    saveRewards(r);
    playTone('click');
    amountEl.value = '';
    fundMsg(`已從「${from.name}」轉 ${money(amount)} 到「${to.name}」`);
    updateRewardBadge();
}

/* 帳戶設定：只在打開「帳戶設定」或儲存後重畫，避免同步更新時蓋掉正在輸入的內容 */
function accountEditCard(a) {
    const card = rewardRow('ac-edit');
    card.dataset.id = a.id;
    const field = (label, cls, value, attrs) => {
        const wrap = rewardEl('label', 'ac-field');
        wrap.appendChild(rewardEl('span', null, label));
        const input = document.createElement('input');
        input.className = `text-input ${cls}`;
        Object.entries(attrs).forEach(([k, v]) => input.setAttribute(k, v));
        input.value = value;
        wrap.appendChild(input);
        return wrap;
    };
    const head = rewardRow('ac-edit-head');
    const name = field('名稱', 'ac-in-name', a.name, { type: 'text', maxlength: '40' });
    const del = rewardEl('button', 'rw-del', '✕');
    del.title = '刪除這個帳戶';
    del.addEventListener('click', () => card.remove());
    head.appendChild(name); head.appendChild(del);
    card.appendChild(head);
    const grid = rewardRow('ac-edit-grid');
    grid.appendChild(field('每月星星存入上限 NT$', 'ac-in-budget', a.budget || '', { type: 'number', min: '0', max: '1000000', placeholder: '0＝不存星星' }));
    const rateField = field('1 ⭐ = NT$', 'ac-in-rate', a.rate, { type: 'number', min: '0.01', max: '10000', step: '0.01' });
    rateField.querySelector('input').disabled = rateSettings(loadRewards()).mode !== 'manual'; // 只有手動時能直接改
    grid.appendChild(rateField);
    grid.appendChild(field('每月底薪 NT$', 'ac-in-base', a.base || '', { type: 'number', min: '0', max: '1000000', placeholder: '0＝沒有' }));
    card.appendChild(grid);
    return card;
}
function renderAccountSettings() {
    const r = loadRewards(), rs = rateSettings(r);
    document.querySelectorAll('#rateMode .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === rs.mode));
    document.getElementById('rateGoalBox').style.display = rs.mode === 'goal' ? '' : 'none';
    document.getElementById('fdRecalc').style.display = rs.mode === 'history' ? '' : 'none';
    document.getElementById('goalMin').value = rs.goalMin;
    document.getElementById('goalDays').value = rs.goalDays;
    updateRateNote();
    const box = document.getElementById('acSettingsList');
    box.innerHTML = '';
    rewardAccounts(r).forEach(a => {
        const card = accountEditCard(a);
        if (rs.mode === 'goal') card.querySelector('.ac-in-rate').value = accRate(r, a); // 顯示依目標算出的匯率
        box.appendChild(card);
    });
}
// 匯率說明：目前的算法算出多少，以及最近表現和目標的比較
function updateRateNote() {
    const r = loadRewards(), rs = rateSettings(r), s = rewardSummary(r), days = historyDays();
    const el = document.getElementById('rateModeNote');
    if (rs.mode === 'goal') {
        const goalMin = cleanInt(document.getElementById('goalMin').value, 15, 1440, rs.goalMin);
        const goalDays = cleanInt(document.getElementById('goalDays').value, 1, 31, rs.goalDays);
        const target = goalMonthStars({ goalMin, goalDays });
        const total = starBudgetTotal(rewardAccounts(r));
        let text = `每月目標 ${target} 星（每天 ${goalMin} 分鐘 × ${goalDays} 天，以每 15 分鐘 10 星的類別計）`;
        text += total ? `，所有帳戶每月上限合計 ${money(total)}，所以 1 ⭐ = NT$${goalRate(total, { goalMin, goalDays })}。` : '。';
        if (days >= 14) {
            const pct = Math.round(s.last30 / target * 100);
            text += `最近 30 天賺到 ${s.last30} 星，是目標的 ${pct}%。`;
            if (pct >= 120) text += '已經連續超過目標，可以考慮把每天目標調高。';
        } else text += `記錄滿 14 天後，這裡會告訴你最近的表現和目標差多少（目前 ${days} 天）。`;
        el.textContent = text;
    } else if (rs.mode === 'history') {
        el.textContent = days >= 14
            ? `按「依最近 30 天重算匯率」：所有帳戶的每月上限合計 ÷ 最近 30 天賺到的星星（${s.last30} 星）。為了不讓偷懶的月份換到更好的匯率，重算只會調低、不會調高；想調高請改用手動。`
            : `「依過去表現」需要至少 14 天的記錄才準（目前 ${days} 天），在那之前建議先用「依每天目標」。`;
    } else {
        el.textContent = '每個帳戶的匯率自己填，按「儲存」後生效。';
    }
}
function setRateMode(mode) {
    const r = loadRewards();
    const rs = rateSettings(r);
    // 從「依目標」換到其他方式時，先把目前算出的匯率存進各帳戶，避免匯率突然跳回很久以前的數字
    if (rs.mode === 'goal' && mode !== 'goal') rewardAccounts(r).forEach(a => { a.rate = accRate(r, a); });
    r.rate = { ...rs, mode };
    saveRewards(r);
    playTone('click');
    fundMsg('');
    renderAccountSettings();
    updateRewardBadge();
}
document.getElementById('rateMode').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) setRateMode(b.dataset.mode); });
['goalMin', 'goalDays'].forEach(id => document.getElementById(id).addEventListener('input', updateRateNote));
function addAccountCard() {
    playTone('click');
    const s = rewardSummary();
    const r = loadRewards();
    const card = accountEditCard({ id: newItemId(), name: '', budget: 0, rate: rewardAccounts(r).length ? accRate(r, rewardAccounts(r)[0]) : 1, base: 0 });
    document.getElementById('acSettingsList').appendChild(card);
    card.querySelector('.ac-in-name').focus();
}
function saveAccountSettings() {
    const r = loadRewards();
    const st = accountStats(r);
    const cards = [...document.querySelectorAll('#acSettingsList .ac-edit')];
    const accounts = [];
    for (const card of cards) {
        const val = cls => card.querySelector(cls).value.trim();
        const name = val('.ac-in-name').slice(0, 40);
        const budget = val('.ac-in-budget') === '' ? 0 : cleanInt(val('.ac-in-budget'), 0, 1e6, null);
        const base = val('.ac-in-base') === '' ? 0 : cleanInt(val('.ac-in-base'), 0, 1e6, null);
        const rate = Math.round(Number(val('.ac-in-rate')) * 100) / 100;
        if (!name) { fundMsg('每個帳戶都要有名稱', true); card.querySelector('.ac-in-name').focus(); return; }
        if (budget === null || base === null || !(rate > 0 && rate <= 10000)) { fundMsg(`「${name}」的數字不對`, true); return; }
        accounts.push({ id: card.dataset.id, name, budget, rate, base });
    }
    const removed = rewardAccounts(r).filter(a => !accounts.some(x => x.id === a.id));
    const withMoney = removed.filter(a => st[a.id] && st[a.id].balance !== 0);
    if (withMoney.length && !confirm(`刪除「${withMoney.map(a => a.name).join('」「')}」？裡面的餘額也會一起消失。`)) return;
    r.accounts = accounts;
    const rs = rateSettings(r);
    if (rs.mode === 'goal') {
        const goalMin = cleanInt(document.getElementById('goalMin').value, 15, 1440, null);
        const goalDays = cleanInt(document.getElementById('goalDays').value, 1, 31, null);
        if (goalMin === null || goalDays === null) { fundMsg('每天目標要在 15–1440 分鐘之間，每月目標天數 1–31 天', true); return; }
        r.rate = { ...rs, goalMin, goalDays };
    }
    saveRewards(r);
    grantBaseSalaries(); // 新設了底薪的帳戶，這個月的底薪馬上發
    playTone('click');
    fundMsg('已儲存帳戶設定');
    renderAccountSettings();
    updateRewardBadge();
}
function recalcFundRate() {
    const cards = [...document.querySelectorAll('#acSettingsList .ac-edit')];
    const total = cards.reduce((sum, c) => sum + (cleanInt(c.querySelector('.ac-in-budget').value, 0, 1e6, 0) || 0), 0);
    if (!total) { fundMsg('先設定至少一個帳戶的每月星星存入上限', true); return; }
    const days = historyDays();
    if (days < 14) { fundMsg(`記錄要滿 14 天才能依過去表現計算（目前 ${days} 天）`, true); return; }
    const last30 = rewardSummary().last30;
    if (!last30) { fundMsg('最近 30 天沒有賺到星星，沒辦法計算', true); return; }
    const rate = Math.max(0.01, Math.round(total / last30 * 100) / 100);
    let lowered = 0;
    cards.forEach(c => {
        if (!cleanInt(c.querySelector('.ac-in-budget').value, 1, 1e6, null)) return;
        const input = c.querySelector('.ac-in-rate'), cur = Number(input.value);
        if (!(cur > 0) || rate < cur) { input.value = rate; lowered++; } // 只調低
    });
    playTone('click');
    fundMsg(lowered ? `已填入 NT$${rate}，按「儲存」後生效` : `算出來是 NT$${rate}，沒有比目前的低，所以不變（重算只會調低）`);
}

document.getElementById('fdSetBudget').addEventListener('click', setFundBudget);
document.getElementById('fdDeposit').addEventListener('click', depositFund);
document.getElementById('fdExpense').addEventListener('click', addFundExpense);
document.getElementById('fdTransfer').addEventListener('click', transferFund);
document.getElementById('fdStars').addEventListener('input', updateFundPreview);
document.getElementById('fdDepAcc').addEventListener('change', updateFundPreview);
document.getElementById('acAdd').addEventListener('click', addAccountCard);
document.getElementById('fdSaveSettings').addEventListener('click', saveAccountSettings);
document.getElementById('fdRecalc').addEventListener('click', recalcFundRate);
document.getElementById('fdSettings').addEventListener('toggle', (e) => { if (e.target.open) renderAccountSettings(); });
[['fdBudgetNew', setFundBudget], ['fdStars', depositFund], ['fdExpName', addFundExpense], ['fdExpAmount', addFundExpense], ['fdTrAmount', transferFund]].forEach(([id, fn]) =>
    document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } }));
function removeShopItem(item) {
    const r = loadRewards();
    const before = rewardShop(r).slice();
    r.shop = before.filter(x => x.id !== item.id);
    saveRewards(r);
    playTone('delete');
    updateRewardBadge();
    showToast(`已從商店移除「${item.name}」`, '復原', () => { const x = loadRewards(); x.shop = before; saveRewards(x); updateRewardBadge(); }, 7000);
}
function addShopItem() {
    const nameEl = document.getElementById('rwNewName'), costEl = document.getElementById('rwNewCost');
    const name = nameEl.value.trim().slice(0, 100);
    const cost = cleanInt(costEl.value, 1, 9999, null);
    if (!name) { nameEl.focus(); return; }
    if (cost === null) { costEl.focus(); return; }
    const r = loadRewards();
    r.shop = [...rewardShop(r), { id: newItemId(), name, cost }];
    saveRewards(r);
    playTone('click');
    nameEl.value = ''; costEl.value = '';
    updateRewardBadge();
}
document.getElementById('rwAdd').addEventListener('click', addShopItem);
['rwNewName', 'rwNewCost'].forEach(id => document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addShopItem(); }
}));

/* 匯出獎勵明細：每日、每週（週一到週日）、每月 */
let exUnit = 'day', exAnchor = todayKey();

function exportRange() {
    if (exUnit === 'day') return { from: exAnchor, to: exAnchor, label: `${shortDate(exAnchor)}（${weekdayText(exAnchor)}）` };
    if (exUnit === 'week') {
        const back = (new Date(`${exAnchor}T00:00`).getDay() + 6) % 7; // 距離週一幾天
        const from = addDays(exAnchor, -back), to = addDays(from, 6);
        return { from, to, label: `${shortDate(from)} – ${shortDate(to)}` };
    }
    const from = `${exAnchor.slice(0, 7)}-01`;
    const to = addDays(nextMonthStart(from), -1);
    return { from, to, label: `${from.slice(0, 4)} 年 ${Number(from.slice(5, 7))} 月` };
}
function nextMonthStart(first) {
    const y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7));
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
function shiftExport(dir) {
    if (exUnit === 'day') exAnchor = addDays(exAnchor, dir);
    else if (exUnit === 'week') exAnchor = addDays(exAnchor, dir * 7);
    else {
        const first = `${exAnchor.slice(0, 7)}-01`;
        exAnchor = dir > 0 ? nextMonthStart(first) : addDays(first, -1).slice(0, 7) + '-01';
    }
    if (exAnchor > todayKey()) exAnchor = todayKey();
    playTone('click');
    renderExport();
}

// 這段期間的明細列與總計
function rewardExportData(from, to) {
    const r = loadRewards();
    const s = rewardSummary(r);
    const accName = id => { const a = rewardAccounts(r).find(x => x.id === id); return a ? a.name : '已刪除的帳戶'; };
    const inRange = at => { const d = dateKey(at); return d >= from && d <= to; };
    const rows = [];
    const sum = { e: 0, redeem: 0, depositStars: 0, acc: {} };
    const accSum = id => sum.acc[id] || (sum.acc[id] = { dep: 0, base: 0, exp: 0, tin: 0, tout: 0 });
    const row = (at, date, type, account, item, stars, amount) => rows.push({ at, date, time: at ? clockText(at) : '', type, account, item, stars, amount });

    // 每天賺到的星星（一天一列）；已結算日子的兌換只剩合計
    const pomos = {};
    loadLogs().forEach(l => { const d = dateKey(l.end); if (d >= from && d <= to) pomos[d] = (pomos[d] || 0) + pomodorosOf(l); });
    for (let d = from; d <= to; d = addDays(d, 1)) {
        const settled = r.days[d], live = s.live[d];
        const e = settled ? settled.e : (live ? live.e : 0);
        if (e) { row(0, d, '賺星星', '', `完成 ${pomos[d] || 0} 顆蕃茄`, e, ''); sum.e += e; }
        if (settled && settled.s) { row(0, d, '兌換（合計）', '', '這天的兌換', -settled.s, ''); sum.redeem += settled.s; }
    }
    r.redeems.filter(x => inRange(x.at)).forEach(x => { row(x.at, dateKey(x.at), '兌換', '', x.name, -x.cost, ''); sum.redeem += x.cost; });
    r.deposits.filter(x => inRange(x.at)).forEach(x => {
        row(x.at, dateKey(x.at), '存入', accName(x.acc), '星星存入帳戶', -x.stars, x.amount);
        sum.depositStars += x.stars; accSum(x.acc).dep += x.amount;
    });
    r.grants.filter(x => inRange(x.at)).forEach(x => { row(x.at, dateKey(x.at), '底薪', accName(x.acc), '每月底薪', '', x.amount); accSum(x.acc).base += x.amount; });
    r.expenses.filter(x => inRange(x.at)).forEach(x => { row(x.at, dateKey(x.at), '支出', accName(x.acc), x.name || '支出', '', -x.amount); accSum(x.acc).exp += x.amount; });
    r.transfers.filter(x => inRange(x.at)).forEach(x => {
        row(x.at, dateKey(x.at), '轉帳', `${accName(x.from)} → ${accName(x.to)}`, '帳戶之間轉帳', '', x.amount);
        accSum(x.from).tout += x.amount; accSum(x.to).tin += x.amount;
    });
    rows.sort((a, b) => (a.date === b.date ? (a.at || 0) - (b.at || 0) : a.date < b.date ? -1 : 1));

    // 超過一年、已結算的月份只剩總數
    const archivedMonths = Object.keys(r.archive).filter(m => m >= from.slice(0, 7) && m <= to.slice(0, 7));
    archivedMonths.forEach(m => Object.entries(r.archive[m]).forEach(([acc, v]) => {
        const a = accSum(acc);
        a.dep += v[0]; a.base += v[1]; a.exp += v[2]; a.tin += v[3]; a.tout += v[4];
        sum.depositStars += v[5];
    }));
    const lines = [`賺到 ${sum.e} 顆星，兌換 ${sum.redeem} 顆，存入帳戶 ${sum.depositStars} 顆`];
    Object.entries(sum.acc).forEach(([id, a]) => {
        const parts = [];
        if (a.dep) parts.push(`存入 ${money(a.dep)}`);
        if (a.base) parts.push(`底薪 ${money(a.base)}`);
        if (a.exp) parts.push(`支出 ${money(a.exp)}`);
        if (a.tin) parts.push(`轉入 ${money(a.tin)}`);
        if (a.tout) parts.push(`轉出 ${money(a.tout)}`);
        if (parts.length) lines.push(`${accName(id)}：${parts.join('、')}`);
    });
    if (archivedMonths.length) lines.push('（超過一年的明細已結算，只有每月總數）');
    return { rows, lines };
}

function rewardCSV(data) {
    const header = ['日期', '時間', '類型', '帳戶', '內容', '星星', '金額(NT$)'];
    const rows = data.rows.map(x => [x.date, x.time, x.type, x.account, x.item, x.stars, x.amount]);
    // 數字直接輸出（csvCell 會在負號前加 ' 防止被當成公式，數字不需要）
    const cell = v => (typeof v === 'number' ? String(v) : csvCell(v));
    return '﻿' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
function rewardMarkdown(data, label) {
    const lines = [`# 獎勵明細：${label}`, '', ...data.lines.map(l => `- ${mdCell(l)}`), ''];
    if (data.rows.length) {
        lines.push('| 日期 | 時間 | 類型 | 帳戶 | 內容 | 星星 | 金額(NT$) |', '|---|---|---|---|---|---:|---:|');
        data.rows.forEach(x => lines.push(`| ${[x.date, x.time, x.type, x.account, x.item, x.stars, x.amount].map(mdCell).join(' | ')} |`));
    } else lines.push('（這段期間沒有明細）');
    return lines.join('\n') + '\n';
}

function renderExport() {
    const { from, to, label } = exportRange();
    document.querySelectorAll('#exUnit .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.unit === exUnit));
    document.getElementById('exLabel').textContent = label;
    document.getElementById('exNext').disabled = to >= todayKey();
    // 最早可以看到：一年前，或更早已結算（只剩總數）的月份
    const months = Object.keys(loadRewards().archive).sort();
    const earliest = months.length && `${months[0]}-01` < addDays(todayKey(), -LOG_KEEP_DAYS) ? `${months[0]}-01` : addDays(todayKey(), -LOG_KEEP_DAYS);
    document.getElementById('exPrev').disabled = from <= earliest;
    const data = rewardExportData(from, to);
    document.getElementById('exSummary').textContent = data.lines.join('\n') + `\n共 ${data.rows.length} 筆明細`;
}
function doExport(kind) {
    const { from, to, label } = exportRange();
    const data = rewardExportData(from, to);
    const name = exUnit === 'day' ? from : exUnit === 'week' ? `${from}_${to}` : from.slice(0, 7);
    playTone('click');
    if (kind === 'csv') downloadFile(`rewards_${name}.csv`, rewardCSV(data), 'text/csv;charset=utf-8');
    else if (kind === 'md') downloadFile(`rewards_${name}.md`, rewardMarkdown(data, label), 'text/markdown;charset=utf-8');
    else copyText(rewardMarkdown(data, label)).then(ok => {
        const btn = document.getElementById('exCopy');
        btn.textContent = ok ? '✓ 已複製' : '複製失敗';
        setTimeout(() => { btn.textContent = '📋 複製'; }, 1500);
    });
}
document.getElementById('exUnit').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    playTone('click');
    exUnit = btn.dataset.unit; exAnchor = todayKey();
    renderExport();
});
document.getElementById('exPrev').addEventListener('click', () => shiftExport(-1));
document.getElementById('exNext').addEventListener('click', () => shiftExport(1));
document.getElementById('exCsv').addEventListener('click', () => doExport('csv'));
document.getElementById('exMd').addEventListener('click', () => doExport('md'));
document.getElementById('exCopy').addEventListener('click', () => doExport('copy'));
document.getElementById('exDetails').addEventListener('toggle', (e) => { if (e.target.open) { exUnit = 'day'; exAnchor = todayKey(); renderExport(); } });

function openRewards() { settleRewards(); grantBaseSalaries(); fundMsg(''); renderRewards(); toggleModal(true, 'rewardModal'); }

// 兩台裝置都改過獎勵資料時的合併：商店與兌換逐項合併，點數設定逐類別，已結算的日子取比較大的數字
function mergeRewards(baseStr, localStr, remoteStr) {
    const parse = s => { try { return cleanRewards(JSON.parse(s || 'null')); } catch (err) { return cleanRewards(null); } };
    const b = parse(baseStr), l = parse(localStr), r = parse(remoteStr);
    const pick = (bv, lv, rv) => (sameJSON(lv, bv) ? rv : lv);
    const out = { weights: {}, redeems: [], deposits: [], grants: [], expenses: [], transfers: [], days: {}, archive: {} };
    new Set([...Object.keys(b.weights), ...Object.keys(l.weights), ...Object.keys(r.weights)]).forEach(k => {
        const v = pick(b.weights[k], l.weights[k], r.weights[k]);
        if (v !== undefined) out.weights[k] = v;
    });
    const other = pick(b.other, l.other, r.other);
    if (other !== undefined) out.other = other;
    const shop = pick(b.shop, l.shop, r.shop) === undefined ? undefined
        : mergeList(withIds(rewardShop(b), x => x.id), withIds(rewardShop(l), x => x.id), withIds(rewardShop(r), x => x.id));
    if (shop !== undefined) out.shop = shop;
    const rate = pick(b.rate, l.rate, r.rate);
    if (rate !== undefined) out.rate = rate;
    const accounts = pick(b.accounts, l.accounts, r.accounts) === undefined ? undefined
        : mergeList(withIds(rewardAccounts(b), x => x.id), withIds(rewardAccounts(l), x => x.id), withIds(rewardAccounts(r), x => x.id));
    if (accounts !== undefined) out.accounts = accounts;
    const mergeById = k => mergeList(withIds(b[k], y => y.id), withIds(l[k], y => y.id), withIds(r[k], y => y.id)).sort((x, y) => x.at - y.at);
    ['redeems', 'deposits', 'grants', 'expenses', 'transfers'].forEach(k => { out[k] = mergeById(k); });
    [l.days, r.days].forEach(days => Object.entries(days).forEach(([d, v]) => {
        const cur = out.days[d] || {};
        const m = {};
        ['e', 's', 'd', 'x'].forEach(k => { const n = Math.max(cur[k] || 0, v[k] || 0); if (n || k === 'e' || k === 's') m[k] = n; });
        out.days[d] = m;
    }));
    // 已結算的月份：每個欄位取較大的數字，並丟掉那些月份的明細
    [l.archive, r.archive].forEach(arc => Object.entries(arc).forEach(([m, accs]) => {
        const cur = out.archive[m] || (out.archive[m] = {});
        Object.entries(accs).forEach(([acc, v]) => { cur[acc] = cur[acc] ? cur[acc].map((n, i) => Math.max(n, v[i])) : v.slice(); });
    }));
    ['deposits', 'grants', 'expenses', 'transfers'].forEach(k => { out[k] = out[k].filter(x => !out.archive[dateKey(x.at).slice(0, 7)]); });
    // 已經結算的日子，不再保留那天的兌換明細
    out.redeems = out.redeems.filter(x => !out.days[dateKey(x.at)]);
    return JSON.stringify(out);
}

/* --- 定時提醒：例如「每週一三五 18:00 倒垃圾，接著吃飯」 ---
 * 資料（pomodoro_reminders_v1，會同步）：[{id, time: 'HH:MM', name, days: [星期幾，0＝週日], date（沒選星期幾時：只有這一天）, next（接著排入的任務）}]
 * 響過的提醒記在這台裝置（pomodoro_reminder_fired），每台裝置各自提醒。
 * 網頁要還在執行才響得了：手機關掉螢幕、又沒在計時的時候會被暫停，所以另外提供「加到 Google 日曆」。 */
function cleanTime(v) {
    const m = typeof v === 'string' && v.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
}
function cleanReminders(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw.slice(0, 100).filter(x => x && typeof x === 'object').map(x => {
        const days = Array.isArray(x.days) ? [...new Set(x.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
        const out = { id: cleanText(x.id, 40) || newItemId(), time: cleanTime(x.time), name: cleanText(x.name, 100), days };
        if (!days.length) out.date = typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : todayKey();
        const next = cleanText(x.next, 100);
        if (next) out.next = next;
        return out;
    }).filter(x => x.time && x.name && !seen.has(x.id) && seen.add(x.id));
}
function loadReminders() { return cleanReminders(readStoredJSON(STORAGE_KEY_REMIND)); }
function saveReminders(list) { storeSet(STORAGE_KEY_REMIND, JSON.stringify(list)); }
function remindsOn(rem, date) { return rem.days.length ? rem.days.includes(new Date(`${date}T00:00`).getDay()) : rem.date === date; }
function remindAt(rem, date) { return new Date(`${date}T${rem.time}`).getTime(); }
function readFired() { try { return JSON.parse(localStorage.getItem(REMIND_FIRED_KEY) || '{}') || {}; } catch (err) { return {}; } }
function markFired(id) {
    const f = readFired(), today = todayKey();
    f[id] = today;
    Object.keys(f).forEach(k => { if (f[k] !== today) delete f[k]; });
    localStorage.setItem(REMIND_FIRED_KEY, JSON.stringify(f));
}
// 任務在任務庫裡的顏色與預估顆數（找不到就用灰色、1 顆）
function taskInfo(name) {
    for (const c of cleanCategories(readStoredJSON(STORAGE_KEY_CATS) || [])) {
        if (c.tasks.includes(name)) return { color: c.color, est: c.meta[name] ? c.meta[name].est : 1 };
    }
    return { color: '#999999', est: 1 };
}

// 每 15 秒、以及切回網頁時檢查一次
function checkReminders() {
    if (!isUnlocked()) return;
    const now = Date.now(), today = todayKey(), fired = readFired();
    loadReminders().forEach(rem => {
        if (!remindsOn(rem, today) || fired[rem.id] === today) return;
        const at = remindAt(rem, today);
        if (now < at) return;
        markFired(rem.id);
        if (now - at > 3 * 3600 * 1000) return; // 超過 3 小時才打開網頁的，就不補提醒了
        fireReminder(rem, at);
    });
    renderReminders();
}
function fireReminder(rem, at) {
    playTone('alarm');
    setTimeout(() => playTone('alarm'), 700);
    setTimeout(() => playTone('alarm'), 1400);
    const late = Date.now() - at > 2 * 60 * 1000 ? `（${rem.time} 的提醒）` : '';
    const msg = `⏰ ${rem.time} ${rem.name}${rem.next ? `，接著${rem.next}` : ''}${late}`;
    showToast(msg, '開始', () => startReminder(rem), 10 * 60 * 1000);
    if (document.hidden || !document.hasFocus()) { startAttention(); notify(msg, REMIND_TAG); }
}
// 按「開始」：把提醒的任務（和接著的任務）放到任務條最上面
function startReminder(rem) {
    const slotEl = document.getElementById('scheduleSlot');
    const first = slotEl.querySelector('.task-card:not(.drop-placeholder)');
    const a = taskInfo(rem.name);
    const card = appendScheduleCard(rem.name, a.color, first, null, a.est);
    if (rem.next) { const b = taskInfo(rem.next); appendScheduleCard(rem.next, b.color, card.nextSibling, null, b.est); }
    playTone('drop');
    saveSchedule();
    refreshScheduleTimes();
}

function renderReminders() {
    const box = document.getElementById('reminderList');
    if (!box) return;
    const list = loadReminders();
    // 過期的單次提醒自動刪掉
    const today = todayKey();
    const kept = list.filter(r => r.days.length || r.date >= today);
    if (kept.length !== list.length) saveReminders(kept);
    const fired = readFired(), now = Date.now();
    // 行程預計做完的時間：提醒落在這之前，表示行程會經過它
    const etas = [...document.querySelectorAll('#scheduleSlot .task-card:not(.done)')].map(c => Number(c.dataset.eta) || 0);
    const planEnd = etas.length ? Math.max(...etas) : 0;
    box.innerHTML = '';
    if (!kept.length) {
        box.appendChild(rewardEl('div', 'reminder-empty', '還沒有提醒，例如「18:00 倒垃圾」'));
        return;
    }
    kept.slice().sort((a, b) => a.time.localeCompare(b.time)).forEach(rem => {
        const row = rewardEl('button', 'reminder-row');
        const isToday = remindsOn(rem, today), at = remindAt(rem, today);
        if (isToday && fired[rem.id] !== today && at > now) row.classList.add('upcoming');
        if (!isToday || fired[rem.id] === today || at <= now) row.classList.add('past');
        row.appendChild(rewardEl('span', 'reminder-time', rem.time));
        row.appendChild(rewardEl('span', 'reminder-name', rem.name + (rem.next ? ` → ${rem.next}` : '')));
        let note = rem.days.length ? repeatText(rem.days) : (rem.date === today ? '今天' : shortDate(rem.date));
        if (isToday) {
            if (fired[rem.id] === today || at <= now) note += ' · 已提醒';
            else {
                const min = Math.round((at - now) / 60000);
                note += ` · 還有 ${min >= 60 ? `${Math.floor(min / 60)} 小時 ${min % 60} 分` : `${min} 分`}`;
                if (planEnd > at) note += ' · 行程會經過';
            }
        }
        row.appendChild(rewardEl('span', 'reminder-note', note));
        row.addEventListener('click', () => { playTone('click'); openReminderEditor(rem); });
        box.appendChild(row);
    });
}

/* 新增／編輯提醒的視窗 */
let remEditing = null, remDays = new Set();
function fillTaskDatalist() {
    const dl = document.getElementById('remTaskList');
    dl.innerHTML = '';
    const names = new Set();
    cleanCategories(readStoredJSON(STORAGE_KEY_CATS) || []).forEach(c => c.tasks.forEach(t => names.add(t)));
    names.forEach(n => { const o = document.createElement('option'); o.value = n; dl.appendChild(o); });
}
function renderRemDays() {
    document.querySelectorAll('#remDays .seg-btn').forEach(b => b.classList.toggle('active', remDays.has(Number(b.dataset.day))));
    document.getElementById('remDaysNote').textContent = remDays.size ? `每週${repeatText([...remDays])}提醒` : '沒選星期幾：只有今天提醒一次';
}
function openReminderEditor(rem) {
    remEditing = rem || null;
    remDays = new Set(rem ? rem.days : []);
    fillTaskDatalist();
    document.getElementById('remTitle').textContent = rem ? '編輯提醒' : '新增提醒';
    document.getElementById('remTime').value = rem ? rem.time : '';
    document.getElementById('remName').value = rem ? rem.name : '';
    document.getElementById('remNext').value = rem && rem.next ? rem.next : '';
    document.getElementById('remDelete').style.display = rem ? '' : 'none';
    document.getElementById('remMsg').textContent = '';
    renderRemDays();
    toggleModal(true, 'reminderModal');
    if (!rem) document.getElementById('remTime').focus();
}
function readReminderForm() {
    const time = cleanTime(document.getElementById('remTime').value);
    const name = document.getElementById('remName').value.trim().slice(0, 100);
    const next = document.getElementById('remNext').value.trim().slice(0, 100);
    const msg = document.getElementById('remMsg');
    if (!time) { msg.textContent = '請選擇時間'; document.getElementById('remTime').focus(); return null; }
    if (!name) { msg.textContent = '請填要做什麼'; document.getElementById('remName').focus(); return null; }
    const rem = { id: remEditing ? remEditing.id : newItemId(), time, name, days: [...remDays].sort() };
    if (!rem.days.length) rem.date = todayKey();
    if (next) rem.next = next;
    return rem;
}
function saveReminderForm() {
    const rem = readReminderForm();
    if (!rem) return;
    const list = loadReminders().filter(r => r.id !== rem.id);
    list.push(rem);
    saveReminders(list);
    // 改了時間：今天如果已經響過、但新的時間還沒到，讓它再響一次
    const f = readFired();
    if (f[rem.id] && remindAt(rem, todayKey()) > Date.now()) { delete f[rem.id]; localStorage.setItem(REMIND_FIRED_KEY, JSON.stringify(f)); }
    playTone('click');
    toggleModal(false, 'reminderModal');
    renderReminders();
    requestNotifyPermission();
}
function deleteReminder() {
    if (!remEditing) return;
    const removed = remEditing;
    const before = localStorage.getItem(STORAGE_KEY_REMIND);
    saveReminders(loadReminders().filter(r => r.id !== removed.id));
    playTone('delete');
    toggleModal(false, 'reminderModal');
    renderReminders();
    showToast(`已刪除提醒「${removed.name}」`, '復原', () => { if (before !== null) storeSet(STORAGE_KEY_REMIND, before); renderReminders(); }, 7000);
}

// 「加到 Google 日曆」：開一個預先填好的 Google 日曆活動頁面（不需要額外權限），儲存後由日曆 App 準時通知
function calendarUrl(rem) {
    const pad = n => String(n).padStart(2, '0');
    const fmt = ms => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`; };
    let date = rem.date || todayKey();
    if (rem.days.length) { // 第一個還沒過的日子
        for (let i = 0; i < 8; i++) {
            const d = addDays(todayKey(), i);
            if (remindsOn(rem, d) && remindAt(rem, d) > Date.now()) { date = d; break; }
        }
    }
    const start = remindAt(rem, date);
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: rem.name + (rem.next ? `，接著${rem.next}` : ''),
        dates: `${fmt(start)}/${fmt(start + 15 * 60 * 1000)}`,
        details: '由蕃茄鐘建立的提醒'
    });
    try { params.set('ctz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (err) {}
    if (rem.days.length) {
        const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
        params.set('recur', `RRULE:FREQ=WEEKLY;BYDAY=${rem.days.map(d => codes[d]).join(',')}`);
    }
    return `https://calendar.google.com/calendar/render?${params}`;
}
function addReminderToCalendar() {
    const rem = readReminderForm();
    if (!rem) return;
    playTone('click');
    window.open(calendarUrl(rem), '_blank', 'noopener');
    document.getElementById('remMsg').textContent = '已開啟 Google 日曆。儲存活動後，記得確認通知時間設成「活動開始時」。提醒本身也記得按「儲存」。';
}

document.getElementById('reminderAdd').addEventListener('click', () => { playTone('click'); openReminderEditor(null); });
document.getElementById('remDays').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    playTone('click');
    const d = Number(b.dataset.day);
    remDays.has(d) ? remDays.delete(d) : remDays.add(d);
    renderRemDays();
});
document.getElementById('remSave').addEventListener('click', saveReminderForm);
document.getElementById('remDelete').addEventListener('click', deleteReminder);
document.getElementById('remCalendar').addEventListener('click', addReminderToCalendar);
['remTime', 'remName', 'remNext'].forEach(id => document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveReminderForm(); }
}));


/* --- 補登：有做事但忘了計時，事後把專注時間加進記錄 --- */
// 補登的一筆當成「正數」記錄：每滿一段專注時長算一顆蕃茄，點數也照算；manual 標示是補登的
function openManualLog() {
    fillTaskDatalist();
    const isToday = logViewDate === todayKey();
    const mins = 25;
    // 預設「現在往前推 25 分鐘」；補別天的時候預設 09:00
    const start = isToday ? new Date(Date.now() - mins * 60000) : new Date(`${logViewDate}T09:00`);
    document.getElementById('mlTitle').textContent = `補登專注（${logViewDate} ${weekdayText(logViewDate)}）`;
    document.getElementById('mlTime').value = clockText(start.getTime());
    document.getElementById('mlMin').value = mins;
    document.getElementById('mlTask').value = isToday ? getCurrentTask() : '';
    document.getElementById('mlMsg').textContent = '';
    updateManualNote();
    toggleModal(true, 'manualLogModal');
    document.getElementById('mlTask').focus();
}
function manualPomodoros(sec) {
    return sec >= MIN_POMODORO_SEC ? Math.floor(sec / Math.max(MIN_POMODORO_SEC, timerSettings.focus)) : 0;
}
function updateManualNote() {
    const min = Number(document.getElementById('mlMin').value);
    const note = document.getElementById('mlNote');
    if (!(min > 0)) { note.textContent = ''; return; }
    const n = manualPomodoros(Math.round(min * 60));
    const per = Math.round(Math.max(MIN_POMODORO_SEC, timerSettings.focus) / 60);
    note.textContent = n ? `算 ${n} 顆蕃茄（每滿 ${per} 分鐘一顆），獎勵點數照算` : `不滿 ${per} 分鐘：只記時間，不算蕃茄和點數`;
}
function saveManualLog() {
    const msg = document.getElementById('mlMsg');
    const time = cleanTime(document.getElementById('mlTime').value);
    const min = Math.round(Number(document.getElementById('mlMin').value));
    const task = cleanText(document.getElementById('mlTask').value.trim().slice(0, 100));
    if (!time) { msg.textContent = '請填開始時間'; document.getElementById('mlTime').focus(); return; }
    if (!(min >= 1 && min <= 720)) { msg.textContent = '分鐘數請填 1 到 720'; document.getElementById('mlMin').focus(); return; }
    const start = new Date(`${logViewDate}T${time}`).getTime();
    const end = start + min * 60000;
    if (!Number.isFinite(start)) { msg.textContent = '時間格式不對'; return; }
    if (end > Date.now() + 60000) { msg.textContent = '結束時間還沒到，不能補登未來的時間'; return; }
    const logs = loadLogs();
    const clash = logs.find(l => l.mode === 'focus' && l.start < end && l.end > start);
    if (clash) { msg.textContent = `和 ${clockText(clash.start)}–${clockText(clash.end)} 的專注記錄重疊了，請調整時間`; return; }
    let s = start; // 同步用「開始時間＋類型」當編號，不能重複
    while (logs.some(l => l.mode === 'focus' && l.start === s)) s++;
    const actualSec = min * 60;
    const pomodoros = manualPomodoros(actualSec);
    logs.push({ start: s, end, mode: 'focus', task, plannedSec: actualSec, actualSec, completed: true, countUp: true, pomodoros, manual: true });
    logs.sort((a, b) => a.start - b.start);
    saveLogs(logs);
    // 今天的補登：推進今日行程上還沒完成的同名卡片
    let credited = '';
    if (logViewDate === todayKey() && pomodoros > 0 && task) {
        const card = [...document.querySelectorAll('#scheduleSlot .task-card:not(.drop-placeholder):not(.done)')]
            .find(c => c.querySelector('.task-name').innerText === task);
        if (card) { creditCard(card.dataset.id, pomodoros, `m${s}`); credited = '，行程進度也已推進'; }
    }
    playTone('click');
    toggleModal(false, 'manualLogModal');
    rerenderKey(STORAGE_KEY_LOG);
    showToast(`已補登 ${min} 分鐘${pomodoros ? `（${pomodoros} 🍅）` : ''}${credited}`, null, null, 4000);
}
document.getElementById('mlSave').addEventListener('click', saveManualLog);
document.getElementById('mlMin').addEventListener('input', updateManualNote);
document.querySelectorAll('#mlQuick .seg-btn').forEach(b => b.addEventListener('click', () => {
    playTone('click');
    document.getElementById('mlMin').value = b.dataset.min;
    if (logViewDate === todayKey()) // 今天：開始時間跟著改成「現在往前推」
        document.getElementById('mlTime').value = clockText(Date.now() - Number(b.dataset.min) * 60000);
    updateManualNote();
}));
['mlTime', 'mlMin', 'mlTask'].forEach(id => document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveManualLog(); }
}));

/* 已完成的任務：收成任務條下方的一行，點了才展開 */
function updateDoneToggle() {
    const slotEl = document.getElementById('scheduleSlot'), btn = document.getElementById('doneToggle');
    if (!slotEl || !btn) return;
    const n = slotEl.querySelectorAll('.task-card.done').length;
    slotEl.classList.toggle('show-done', !!prefs.showDone);
    btn.style.display = n ? '' : 'none';
    btn.textContent = `✓ 已完成 ${n} 項 ${prefs.showDone ? '▴' : '▾'}`;
}
document.getElementById('doneToggle').addEventListener('click', () => {
    playTone('click');
    prefs.showDone = !prefs.showDone; savePrefs();
    updateDoneToggle();
});

/* --- 8. 給同步模組 (sync.js) 用的介面 --- */
window.pomodoroApp = {
    keys: { categories: STORAGE_KEY_CATS, schedule: STORAGE_KEY_SCHED, timer: STORAGE_KEY_TIMER, state: STORAGE_KEY_STATE, logs: STORAGE_KEY_LOG, rewards: STORAGE_KEY_REWARDS, reminders: STORAGE_KEY_REMIND, done: STORAGE_KEY_DONE },

    // 雲端硬碟的檔案：內容與檔案編號（編號放在時長設定裡一起同步，兩台裝置寫同一個檔案）
    buildDriveText,
    getDriveFileId: () => timerSettings.driveFileId || null,
    setDriveFileId(id) { timerSettings.driveFileId = id; saveTimerSettings(); },

    // 可以逐項合併的資料（時長設定是逐欄合併）
    mergeable: [STORAGE_KEY_CATS, STORAGE_KEY_SCHED, STORAGE_KEY_REWARDS, STORAGE_KEY_REMIND, STORAGE_KEY_DONE, STORAGE_KEY_TIMER],
    merge: mergeStored,

    // 計時狀態的版本時間（越大越新）；其他資料沒有版本，回傳 null
    revOf(key, value) {
        if (key !== STORAGE_KEY_STATE) return null;
        try { return Number(JSON.parse(value || 'null').rev) || 0; } catch (err) { return 0; }
    },
    loadLogs, saveLogs,

    // 預設類別還沒存過時先存起來，才有東西可以上傳
    ensureSaved() { if (!localStorage.getItem(STORAGE_KEY_CATS)) saveCategories(); },

    // 雲端的新資料已寫進 localStorage，依種類更新畫面
    applyRemote(key) {
        // 正在拖曳或編輯類別名稱時先不重畫，稍後再套用
        if (drag || paletteContainer.contains(document.activeElement) || document.getElementById('taskModal').classList.contains('show')) {
            setTimeout(() => this.applyRemote(key), 1000);
            return;
        }
        if (key === STORAGE_KEY_CATS) { renderCategoriesFromStorage(); updateRewardBadge(); } // 點數依任務所屬類別計算
        else if (key === STORAGE_KEY_SCHED) renderScheduleFromStorage();
        else if (key === STORAGE_KEY_REWARDS) updateRewardBadge();
        else if (key === STORAGE_KEY_REMIND) renderReminders();
        else if (key === STORAGE_KEY_DONE) { if (document.getElementById('statsModal').classList.contains('show')) renderStats(); }
        // 另一台裝置開始、暫停或切換了計時：照它的狀態接續。
        // 排到稍後再做，這樣接續後如果馬上發現時間已到而結束，產生的變動才會正常同步出去
        else if (key === STORAGE_KEY_STATE) setTimeout(adoptRemoteTimerState, 0);
        else if (key === STORAGE_KEY_LOG) {
            updateModeUI(); // 今日蕃茄數是從記錄算的
            if (document.getElementById('logModal').classList.contains('show')) renderLogModal();
        } else if (key === STORAGE_KEY_TIMER) {
            const incoming = loadTimerSettings();
            if (session) incoming.countUp = timerSettings.countUp; // 進行中的這一段不切換倒數／正數
            Object.assign(timerSettings, incoming);
            if (!session && !isRunning) { timeLeft = timerSettings[mode]; elapsed = 0; }
            updateModeUI(); updateDisplay(); renderSettings();
            // 別台裝置已經處理過「今日開始」：這裡還開著的話就收掉
            if (dayPending && timerSettings.dayStarted === todayKey()) { dayPending = null; toggleModal(false, 'dayModal'); }
        }
    }
};

/* --- 9. 按鈕綁定 ---
 * HTML 裡不寫 onclick：這樣內容安全政策才能禁止所有寫在網頁裡的程式碼，只執行這幾個檔案。 */
const ACTIONS = {
    'open-help': () => toggleModal(true),
    'open-settings': () => { renderSettings(); toggleModal(true, 'settingsModal'); },
    'open-stats': () => openStatsModal(),
    'open-ai': () => openAiModal(),
    'open-rewards': () => openRewards(),
    'stats-prev': () => shiftStats(-1),
    'stats-next': () => shiftStats(1),
    'open-sync': () => toggleModal(true, 'syncModal'),
    'open-float': () => openFloating(),
    'open-log': () => openLogModal(),
    'export-data': () => exportData(),
    'import-data': () => document.getElementById('importFile').click(),
    'log-prev': () => shiftLogDate(-1),
    'log-next': () => shiftLogDate(1),
    'manual-log': () => openManualLog(),
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
        if (e.target !== overlay && !e.target.closest('.modal-close')) return;
        if (overlay.id === 'dayModal') confirmNewDay(); // 點外面關掉＝照目前勾選的開始今天
        else toggleModal(false, overlay.id);
    });
});

window.addEventListener('DOMContentLoaded', () => {
    initApp();
    document.querySelectorAll('.app-version').forEach(el => { el.textContent = `版本 ${APP_VERSION}`; });
    // 這台裝置上次看到的是別的版本：提示已經更新（第一次開啟不提示）
    if (prefs.lastVersion && prefs.lastVersion !== APP_VERSION) showToast(`已更新到版本 ${APP_VERSION}`, null, null, 6000);
    if (prefs.lastVersion !== APP_VERSION) { prefs.lastVersion = APP_VERSION; savePrefs(); }
    renderReminders();
    setInterval(checkReminders, 15000);
    setTimeout(checkReminders, 3000); // 等同步把別台裝置的提醒帶進來
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminders(); });
    setTimeout(checkNewDay, 2500); // 稍等一下，讓雲端同步先把別台裝置的最新狀態帶進來
    setTimeout(() => autoDriveSave(true), 9000); // 每次開啟也更新一次雲端硬碟的檔案（等同步連上之後）
});
