const firebase = require('firebase/compat/app');
require('firebase/compat/storage');
require('firebase/compat/firestore');

const apps = firebase.initializeApp({
    apiKey: "AIzaSyCmp7bPMUZ2rh97WHtOtA04XLMNyRJl0F0",
    authDomain: "findme-50347.firebaseapp.com",
    projectId: "findme-50347",
    storageBucket: "findme-50347.appspot.com",
    messagingSenderId: "1024419484713",
    appId: "1:1024419484713:web:811503d30904b455147838"
});

module.exports = { apps };
