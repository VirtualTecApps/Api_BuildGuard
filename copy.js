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
const cors = require('cors');


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
app.use(cors());

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
let labeledDescriptors = [];

async function loadModels() {
  if (!modelsLoaded) {
    await faceapi.nets.ssdMobilenetv1.loadFromDisk('./models');
    await faceapi.nets.faceLandmark68Net.loadFromDisk('./models');
    await faceapi.nets.faceRecognitionNet.loadFromDisk('./models');
    modelsLoaded = true;
  }
}

// Función para extraer características faciales, del iris y de la oreja
async function extractFeatures(imageBuffer) {
  const img = await canvas.loadImage(imageBuffer);
  const detection = await faceapi.detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    throw new Error('No se detectó ninguna cara en la imagen');
  }

  const landmarks = detection.landmarks;
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const jawOutline = landmarks.getJawOutline();

  // Extraer características del iris (simplificado)
  const irisFeatures = extractIrisFeatures(img, leftEye, rightEye);

  // Extraer características de la oreja (simplificado)
  const earFeatures = extractEarFeatures(img, jawOutline);

  return {
    faceDescriptor: detection.descriptor,
    irisFeatures,
    earFeatures
  };
}

function extractIrisFeatures(img, leftEye, rightEye) {
  // Implementación simplificada
  const leftIrisCenter = getCenterPoint(leftEye);
  const rightIrisCenter = getCenterPoint(rightEye);
  return [...leftIrisCenter, ...rightIrisCenter];
}

function extractEarFeatures(img, jawOutline) {
  // Implementación simplificada
  const earPoints = jawOutline.slice(0, 5);
  return earPoints.reduce((acc, point) => [...acc, point.x, point.y], []);
}

function getCenterPoint(points) {
  const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return [x, y];
}

// Modificar la función loadKnownFaces
async function loadKnownFaces() {
  const snapshot = await apps.firestore().collection("registered_users").get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const nombre = data.nombre;
    const imageUrl = data.imageUrl;
    const uid = data.uid;
    const label = {uid: uid, name: nombre, imageUrl: imageUrl};
    const descriptors = [];
    const irisFeatures = [];
    const earFeatures = [];

    for (const url of data.imageUrl) {
      const buffer = await loadImageFromFirebase(url);
      const features = await extractFeatures(buffer);
      descriptors.push(features.faceDescriptor);
      irisFeatures.push(features.irisFeatures);
      earFeatures.push(features.earFeatures);
    }

    if (descriptors.length > 0) {
      labeledDescriptors.push({
        label: JSON.stringify(label),
        descriptors,
        irisFeatures,
        earFeatures
      });
    }
  }
}

// Modificar la función findSimilarFaces
async function findSimilarFaces(queryFeatures, n = 5) {
  const similarities = [];

  for (const labeled of labeledDescriptors) {
    for (let i = 0; i < labeled.descriptors.length; i++) {
      const faceDistance = faceapi.euclideanDistance(queryFeatures.faceDescriptor, labeled.descriptors[i]);
      const irisDistance = euclideanDistance(queryFeatures.irisFeatures, labeled.irisFeatures[i]);
      const earDistance = euclideanDistance(queryFeatures.earFeatures, labeled.earFeatures[i]);
      
      // Combinar las distancias (ajusta los pesos según sea necesario)
      const combinedDistance = 0.6 * faceDistance + 0.2 * irisDistance + 0.2 * earDistance;

      similarities.push({
        label: labeled.label,
        distance: combinedDistance,
        earDistance:earDistance,
        irisDistance:irisDistance,
        index: i
      });
    }
  }

  similarities.sort((a, b) => a.distance - b.distance);
  return similarities.slice(0, n);
}

function euclideanDistance(arr1, arr2) {
  return Math.sqrt(arr1.reduce((sum, val, i) => sum + Math.pow(val - arr2[i], 2), 0));
}

// Modificar el endpoint /recognize-similars
app.post('/recognize-similars', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send({message:'No se ha subido ningún archivo.'});
  }
  try {
    await loadModels();
    if (labeledDescriptors.length === 0) await loadKnownFaces();

    const queryFeatures = await extractFeatures(req.file.buffer);
    const similarFaces = await findSimilarFaces(queryFeatures);

    const similarFacesWithInfo = similarFaces.map((face) => ({
      recognizedPerson: JSON.parse(face.label),
      distance: face.distance,
      index: face.index
    }));

    res.json({similarFacesWithInfo, message: "Imagen analizada"});
  } catch (error) {
    console.error('Error en el reconocimiento de rostros similares:', error);
    res.status(500).send({message:'Error en el reconocimiento de rostros similares'});
  }
});

// Modificar el endpoint /recognize
app.post('/recognize', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send({message:'No se ha subido ningún archivo.'});
  }

  try {
    await loadModels();
    if (labeledDescriptors.length === 0) await loadKnownFaces();

    const queryFeatures = await extractFeatures(req.file.buffer);
    const similarFaces = await findSimilarFaces(queryFeatures, 1);
    const bestMatch = similarFaces[0];
    let recognizedPerson = "unknown";
    if (bestMatch && bestMatch.distance < 0.6) { // Ajusta este umbral según sea necesario
      recognizedPerson = JSON.parse(bestMatch.label);
    }

    res.json({
      recognizedPerson: recognizedPerson,
      irisDistance:bestMatch.irisDistance,
      earDistance:bestMatch.earDistance,
      confidence: 1 - (bestMatch ? bestMatch.distance : 1),
      message: "Imagen analizada"
    });
  } catch (error) {
    console.error('Error en el reconocimiento facial:', error);
    res.status(500).send({message:'Error en el reconocimiento facial'});
  }
});

// Iniciar el servidor
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  await loadModels();
  console.log(`Servidor ejecutándose en http://localhost:${port}`);
});
