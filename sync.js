/* --- 雲端同步（Firebase：Google 登入 + Firestore） ---
 * 資料仍以 localStorage 為主，這裡只負責和雲端互相同步：
 *   users/{uid}/kv/{名稱}   任務庫、行程、時長設定、今日蕃茄數，各一份（以最後寫入為準）
 *   users/{uid}/logs/{id}   每筆時間記錄一份，兩台裝置的記錄會合併
 * 正在進行的計時狀態不同步。
 */
import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '10.12.2';
const META_KEY = 'pomodoro_sync_meta'; // 同步用的本機資訊：上次登入的帳號、還沒傳上去的項目、已知的雲端記錄

const app = window.pomodoroApp;
const K = app.keys;
// 雲端文件名稱 ↔ localStorage key
const KV = { categories: K.categories, schedule: K.schedule, timer: K.timer, stats: K.stats };
const KV_NAME = Object.fromEntries(Object.entries(KV).map(([name, key]) => [key, name]));

let fb = null;            // 載入後的 Firebase 函式
let auth = null, db = null;
let uid = null;
let unsubscribers = [];
let applying = false;     // 正在把雲端資料寫回本機，這期間的變動不要再傳上去
let pushTimer = null;
let knownRemoteLogs = new Set();
let status = 'off';

const fab = document.getElementById('syncFab');
const statusEl = document.getElementById('syncStatus');
const signInBtn = document.getElementById('syncSignIn');
const signOutBtn = document.getElementById('syncSignOut');

/* --- 本機同步資訊 --- */
function readMeta() {
    try { return { uid: null, dirty: {}, logIds: [], ...JSON.parse(localStorage.getItem(META_KEY) || '{}') }; }
    catch (err) { return { uid: null, dirty: {}, logIds: [] }; }
}
function writeMeta(meta) { localStorage.setItem(META_KEY, JSON.stringify(meta)); }
// 每次標記都換一個版本號：上傳途中又有新修改時，上傳完不會誤把新修改當成已同步
function markDirty(key) {
    const meta = readMeta();
    meta.dirty[key] = `${Date.now()}-${Math.random()}`;
    writeMeta(meta);
}
function clearDirty(key, version) {
    const meta = readMeta();
    if (version === undefined || meta.dirty[key] === version) delete meta.dirty[key];
    writeMeta(meta);
}
function rememberLogIds() { const meta = readMeta(); meta.logIds = [...knownRemoteLogs]; writeMeta(meta); }

const logId = l => `${l.start}_${l.mode}`;

/* --- 狀態顯示 --- */
const STATUS_TEXT = {
    off: '尚未登入。登入後，登入同一個 Google 帳號的裝置會自動同步。',
    connecting: '連線中…',
    syncing: '同步中…',
    ok: '已同步',
    offline: '目前離線，恢復連線後會自動上傳',
    error: '同步失敗，請稍後再試'
};
function setStatus(next, detail) {
    status = next;
    fab.dataset.state = next;
    const who = auth && auth.currentUser ? `${auth.currentUser.email}\n` : '';
    statusEl.textContent = who + (detail || STATUS_TEXT[next]);
    signInBtn.style.display = uid ? 'none' : '';
    signOutBtn.style.display = uid ? '' : 'none';
}
function refreshStatus() {
    if (!uid) return setStatus('off');
    if (!navigator.onLine) return setStatus('offline');
    setStatus(Object.keys(readMeta().dirty).length ? 'syncing' : 'ok');
}
window.addEventListener('online', refreshStatus);
window.addEventListener('offline', refreshStatus);

/* --- 本機有變動：記下來，稍後上傳 --- */
window.addEventListener('pomodoro:change', (e) => {
    const key = e.detail.key;
    if (applying || (!KV_NAME[key] && key !== K.logs)) return;
    markDirty(key);
    if (!uid) return; // 還沒登入：登入時再一起處理
    schedulePush();
});

function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, 800);
    refreshStatus();
}

async function flush() {
    clearTimeout(pushTimer);
    if (!uid) return;
    const dirty = { ...readMeta().dirty };
    try {
        await Promise.all(Object.entries(dirty).map(([key, version]) =>
            (key === K.logs ? pushLogs() : pushKv(key)).then(() => clearDirty(key, version))));
        refreshStatus();
    } catch (err) {
        console.error('[sync] 上傳失敗', err);
        setStatus('error');
    }
}

async function pushKv(key) {
    const ref = fb.doc(db, 'users', uid, 'kv', KV_NAME[key]);
    const value = localStorage.getItem(key);
    if (value === null) await fb.deleteDoc(ref);
    else await fb.setDoc(ref, { value, updatedAt: Date.now() });
}

// 記錄用差異上傳：本機有、雲端沒有的新增；雲端有、本機刪掉的刪除
async function pushLogs() {
    const local = app.loadLogs();
    const localIds = new Set(local.map(logId));
    const toAdd = local.filter(l => !knownRemoteLogs.has(logId(l)));
    const toDelete = [...knownRemoteLogs].filter(id => !localIds.has(id));
    const ops = [
        ...toAdd.map(l => batch => batch.set(fb.doc(db, 'users', uid, 'logs', logId(l)), { value: JSON.stringify(l) })),
        ...toDelete.map(id => batch => batch.delete(fb.doc(db, 'users', uid, 'logs', id)))
    ];
    for (let i = 0; i < ops.length; i += 400) { // Firestore 每批最多 500 筆
        const batch = fb.writeBatch(db);
        ops.slice(i, i + 400).forEach(op => op(batch));
        await batch.commit();
    }
    toAdd.forEach(l => knownRemoteLogs.add(logId(l)));
    toDelete.forEach(id => knownRemoteLogs.delete(id));
    rememberLogIds();
}

/* --- 雲端有變動：寫回本機並更新畫面 --- */
function applyLocal(key, value) {
    if (localStorage.getItem(key) === value) return;
    applying = true;
    try {
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
        app.applyRemote(key);
    } finally { applying = false; }
}

function onKvSnapshot(snap) {
    const dirty = readMeta().dirty;
    snap.docChanges().forEach(change => {
        const key = KV[change.doc.id];
        if (!key || dirty[key]) return; // 本機有還沒傳上去的修改：以本機為準
        applyLocal(key, change.type === 'removed' ? null : change.doc.data().value);
    });
    refreshStatus();
}

function onLogsSnapshot(snap) {
    const remote = new Map(snap.docs.map(d => [d.id, d.data().value]));
    let local = app.loadLogs();
    const localIds = new Set(local.map(logId));
    let changed = false;

    // 其他裝置新增的記錄（已知但本機沒有的，是這台裝置自己刪的，不要加回來）
    remote.forEach((value, id) => {
        if (!localIds.has(id) && !knownRemoteLogs.has(id)) { local.push(JSON.parse(value)); changed = true; }
    });
    // 其他裝置刪掉的記錄（以前在雲端、現在不見了）
    const removed = [...knownRemoteLogs].filter(id => !remote.has(id));
    if (removed.length) { local = local.filter(l => !removed.includes(logId(l))); changed = true; }

    knownRemoteLogs = new Set(remote.keys());
    rememberLogIds();
    if (changed) {
        applying = true;
        try { app.saveLogs(local); app.applyRemote(K.logs); } finally { applying = false; }
    }

    // 本機有雲端沒有的（或已過期被刪掉的），排程上傳
    const now = app.loadLogs();
    const nowIds = new Set(now.map(logId));
    if (now.some(l => !remote.has(logId(l))) || [...remote.keys()].some(id => !nowIds.has(id))) {
        markDirty(K.logs);
        schedulePush();
    }
}

/* --- 登入後第一次對齊 --- */
function localHasData() {
    const sched = JSON.parse(localStorage.getItem(K.schedule) || '[]');
    return localStorage.getItem(K.categories) !== null || sched.length > 0;
}

async function onSignedIn(user) {
    uid = user.uid;
    setStatus('connecting');
    const meta = readMeta();
    const sameAccount = meta.uid === uid;
    knownRemoteLogs = new Set(sameAccount ? meta.logIds : []);

    const snap = await fb.getDocs(fb.collection(db, 'users', uid, 'kv'));
    const cloud = {};
    snap.forEach(d => { cloud[d.id] = d.data().value; });
    const cloudHasData = Object.keys(cloud).length > 0;

    let useCloud = cloudHasData;
    if (cloudHasData && !sameAccount && localHasData()) {
        useCloud = confirm(
            '雲端已經有資料。\n\n' +
            '按「確定」：改用雲端的任務庫、行程與設定（這台裝置的會被取代）\n' +
            '按「取消」：用這台裝置的資料覆蓋雲端\n\n' +
            '時間記錄兩邊都會保留並合併。');
    }

    const dirtyKeys = Object.keys(meta.dirty).filter(k => KV_NAME[k]);
    if (useCloud) {
        // 同一個帳號且離線時改過的項目，以本機為準
        Object.entries(KV).forEach(([name, key]) => {
            if (sameAccount && dirtyKeys.includes(key)) return;
            if (name in cloud) applyLocal(key, cloud[name]);
        });
    } else {
        app.ensureSaved();
        Object.values(KV).forEach(key => { if (localStorage.getItem(key) !== null) markDirty(key); });
    }

    const m = readMeta(); m.uid = uid; writeMeta(m);
    unsubscribers = [
        fb.onSnapshot(fb.collection(db, 'users', uid, 'kv'), onKvSnapshot, err => { console.error('[sync]', err); setStatus('error'); }),
        fb.onSnapshot(fb.collection(db, 'users', uid, 'logs'), onLogsSnapshot, err => { console.error('[sync]', err); setStatus('error'); })
    ];
    await flush();
}

function onSignedOut() {
    unsubscribers.forEach(u => u());
    unsubscribers = [];
    uid = null;
    refreshStatus();
}

/* --- 給 script.js 用 --- */
window.pomodoroSync = {
    isSignedIn: () => !!uid,
    flush,
    // 重置全部時一併清空雲端
    async resetCloud() {
        if (!uid) return;
        const [kv, logs] = await Promise.all([
            fb.getDocs(fb.collection(db, 'users', uid, 'kv')),
            fb.getDocs(fb.collection(db, 'users', uid, 'logs'))
        ]);
        const refs = [...kv.docs, ...logs.docs].map(d => d.ref);
        for (let i = 0; i < refs.length; i += 400) {
            const batch = fb.writeBatch(db);
            refs.slice(i, i + 400).forEach(r => batch.delete(r));
            await batch.commit();
        }
        const meta = readMeta(); meta.dirty = {}; meta.logIds = []; writeMeta(meta);
    }
};

/* --- 啟動 --- */
async function start() {
    if (!firebaseConfig) return; // 還沒設定 Firebase：不顯示同步功能
    fab.style.display = '';
    setStatus('connecting', '載入同步功能中…');
    try {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
        const [appMod, authMod, fsMod] = await Promise.all([
            import(`${base}/firebase-app.js`),
            import(`${base}/firebase-auth.js`),
            import(`${base}/firebase-firestore.js`)
        ]);
        fb = { ...authMod, ...fsMod };
        const fbApp = appMod.initializeApp(firebaseConfig);
        auth = authMod.getAuth(fbApp);
        db = fsMod.getFirestore(fbApp);
    } catch (err) {
        console.error('[sync] 無法載入 Firebase', err);
        setStatus('error', '無法載入同步功能（可能是離線），網頁仍可照常使用。');
        return;
    }

    signInBtn.onclick = async () => {
        const provider = new fb.GoogleAuthProvider();
        try {
            await fb.signInWithPopup(auth, provider);
        } catch (err) {
            // 彈出視窗被擋時改用整頁跳轉登入
            if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
                await fb.signInWithRedirect(auth, provider);
            } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
                console.error('[sync] 登入失敗', err);
                setStatus('error', `登入失敗：${err.code || err.message}`);
            }
        }
    };
    signOutBtn.onclick = () => {
        if (confirm('登出後這台裝置會停止同步（本機資料會保留）。確定登出？')) fb.signOut(auth);
    };

    fb.getRedirectResult(auth).catch(err => console.error('[sync] 登入失敗', err));
    fb.onAuthStateChanged(auth, user => {
        if (user) onSignedIn(user).catch(err => { console.error('[sync]', err); setStatus('error'); });
        else onSignedOut();
    });
}

start();
