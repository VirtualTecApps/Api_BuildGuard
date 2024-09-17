const express = require('express');
const multer = require('multer');
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
const fs = require('fs');
const path = require('path');
const { apps } = require('./firebaseAll');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
require('dotenv').config(); // Cargar las variables de .env
const privateKey = process.env.PRIVATE_KEY;


const serviceAccount = {
  type: "service_account",
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.PRIVATE_KEY_ID,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'), // Reemplazar saltos de línea en la clave
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.CLIENT_ID,
  auth_uri: process.env.AUTH_URI,
  token_uri: process.env.TOKEN_URI,
  auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.CLIENT_CERT_URL
};

// Inicializa Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'findme-50347.appspot.com'
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const loadImageFromFirebase = async (path) => {
  const bucket = admin.storage().bucket();
  const div = path.split("%2F");
  const pt = `users/${div[1]}/uploads/${div[3].split("?")[0]}`;

  const file = bucket.file(pt);
  const [exists] = await file.exists();

  if (!exists) {
    throw new Error(`No se encontró el archivo: ${path}`);
  }

  const [fileBuffer] = await file.download();
  return fileBuffer;
};

// Inicializa los modelos de face-api.js
let modelsLoaded = false;
async function loadModels() {
  if (!modelsLoaded) {
    await faceapi.nets.ssdMobilenetv1.loadFromDisk('./models');
    await faceapi.nets.faceLandmark68Net.loadFromDisk('./models');
    await faceapi.nets.faceRecognitionNet.loadFromDisk('./models');
    modelsLoaded = true;
  }
}

// Función para extraer descriptores faciales
async function getDescriptors(imageBuffer) {
  const img = await canvas.loadImage(imageBuffer);
  const detections = await faceapi.detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();
  return detections ? detections.descriptor : null;
}

// Cargar descriptores conocidos
let labeledDescriptors = [];
async function loadKnownFaces() {
  const snapshot = await apps.firestore().collection("registered_users").get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const nombre = data.nombre;
    const uid = data.uid;
    label = {uid:uid,name:nombre}
    const descriptors = [];
    for (const imageUrl of data.imageUrl) {
      const buffer = await loadImageFromFirebase(imageUrl);
      const descriptor = await getDescriptors(buffer);
      if (descriptor) descriptors.push(descriptor);
    }
    if (descriptors.length > 0) {
      labeledDescriptors.push(new faceapi.LabeledFaceDescriptors(JSON.stringify(label), descriptors));
    }
  }
}

// Endpoint para reconocimiento facial
app.post('/recognize', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No se ha subido ningún archivo.');
  }

  try {
    await loadModels();
    if (labeledDescriptors.length === 0) await loadKnownFaces();

    const descriptor = await getDescriptors(req.file.buffer);
    if (!descriptor) {
      return res.status(400).send('No se detectó ninguna cara en la imagen.');
    }

    const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors);
    const match = faceMatcher.findBestMatch(descriptor);
    let recoP = match.label;

    if(recoP !=="unknown"){
      recoP = JSON.parse(recoP);
    }
    res.json({
      recognizedPerson: recoP,
      confidence: 1 - match.distance
    });
  } catch (error) {
    console.error('Error en el reconocimiento facial:', error);
    res.status(500).send('Error en el reconocimiento facial');
  }
});

// Iniciar el servidor
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  await loadModels();
  console.log(`Servidor ejecutándose en http://localhost:${port}`);
});
