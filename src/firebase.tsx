import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDOafngoJ3pY_AeMIMjcDOhZK9jAB82L-4",
  authDomain: "medapp-f816a.firebaseapp.com",
  databaseURL: "https://medapp-f816a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "medapp-f816a",
  storageBucket: "medapp-f816a.firebasestorage.app",
  messagingSenderId: "420677292232",
  appId: "1:420677292232:web:56b68d4918343f181d95fd",
  measurementId: "G-LVB1C3RXMF"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
