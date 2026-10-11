// Only the Firebase pieces the site uses; bundled by build-firebase.mjs into vendor/firebase.js.
export { initializeApp } from 'firebase/app';
export { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
export {
  getDatabase, connectDatabaseEmulator, ref, child, get, set, update, push, query, limitToLast,
  onValue, onChildAdded, onChildChanged, serverTimestamp,
} from 'firebase/database';
