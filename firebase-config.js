// 從 Firebase 主控台「專案設定 → 你的應用程式」複製的網頁設定。
// 這些值放在公開的地方沒關係：資料能不能讀寫，是由 Firestore 規則決定（只有登入的本人能存取自己的資料）。
// 設為 null 時網頁會照常運作，只是不顯示雲端同步。
export const firebaseConfig = {
  apiKey: "AIzaSyDIBPkcn7YDK_KFsLbwOTsLR3wBVvUi_Yg",
  authDomain: "pomodoro-2cd61.firebaseapp.com",
  projectId: "pomodoro-2cd61",
  storageBucket: "pomodoro-2cd61.firebasestorage.app",
  messagingSenderId: "62323459051",
  appId: "1:62323459051:web:349bb27538f463315f8fae"
};
