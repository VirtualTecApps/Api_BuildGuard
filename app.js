const express = require('express');
const multer = require('multer');
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');
const sharp = require('sharp'); // Para redimensionar imágenes
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
const fs = require('fs');
const path = require('path');
const { apps } = require('./firebaseAll');
const admin = require('firebase-admin');
require('dotenv').config(); // Cargar las variables de .env
const cors = require('cors');

const serviceAccount ={
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
  storageBucket:  process.env.storageBucket
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());

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
async function findSimilarFaces(queryDescriptor, n = 5) {
  const similarities = [];

  for (const labeledDescriptor of labeledDescriptors) {
    for (let i = 0; i < labeledDescriptor.descriptors.length; i++) {
      const distance = faceapi.euclideanDistance(queryDescriptor, labeledDescriptor.descriptors[i]);
      similarities.push({
        label: labeledDescriptor.label,
        distance: distance, 
        index: i
      }); 
    }
  }

  similarities.sort((a, b) => a.distance - b.distance);
  return similarities.slice(0, n);
}

// Función para redimensionar imágenes y extraer descriptores faciales
async function getDescriptors(imageBuffer) {
  // Redimensionar la imagen a un tamaño estándar (por ejemplo, 160x160)
  const resizedImageBuffer = await sharp(imageBuffer)
  .resize(320, 240, {
    fit: sharp.fit.inside,
    withoutEnlargement: true
  })
  .toBuffer();
  
  const img2 = await canvas.loadImage(imageBuffer);
  const img = await canvas.loadImage(resizedImageBuffer);
  //console.log("-----------------------------------------------------------------");
 // console.log("img: ",img);
  //console.log("img2: ",img2);
  const detections = await faceapi.detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();
  
  return detections ? detections.descriptor : null;
}
const loadImageFromFirebase = async (path) => {
  const bucket = admin.storage().bucket();
  //console.log(path);
  const div = path.split("%2F");
  //console.log(div);
  const pt = `users/${div[1]}/uploads/${div[3].split("?")[0]}`;

  const file = bucket.file(pt); 
  const [exists] = await file.exists();

  if (!exists) {
    throw new Error(`No se encontró el archivo: ${path}`);
  }

  const [fileBuffer] = await file.download();
  return fileBuffer;
}; 
// Cargar descriptores conocidos
let labeledDescriptors = [];
async function loadKnownFaces() {
  const snapshot = await apps.firestore().collection("registered_users").get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const nombre = data.nombre;
    const uid = data.uid;
    let imageUrls = data.imageUrl; // Suponiendo que es un array de URLs
    const descriptors = [];
    
    for (const imageUrl of imageUrls) {
      const buffer = await loadImageFromFirebase(imageUrl);
      const descriptor = await getDescriptors(buffer);

      if (descriptor) {
        descriptors.push(descriptor);
       // console.log("descriptor: ",descriptor);
      } else {
        // Si no se detecta un rostro, eliminar la URL de imageUrls
        imageUrls = imageUrls.filter(url => url !== imageUrl);
        console.log(`Eliminada la imagen ${imageUrl} para el usuario ${data.nombre} por no detectar rostro.`);
      }
    }

    // Actualizar la lista de imageUrls en Firestore
    await apps.firestore().collection("registered_users").doc(uid).update({
      imageUrl: imageUrls
    });

    if (descriptors.length > 0) {
      labeledDescriptors.push(new faceapi.LabeledFaceDescriptors(JSON.stringify({ uid: uid, name: nombre, imageUrl: imageUrls }), descriptors));
      //console.log(labeledDescriptors);
      
    }
  }
}
async function listenForChanges() {
  const usersCollection = apps.firestore().collection("registered_users");

  usersCollection.onSnapshot(async (snapshot) => {
    labeledDescriptors = [];
    await loadKnownFaces();  // Recargar los rostros conocidos al detectar cambios
    console.log('Datos de usuarios actualizados desde Firestore');
  });
}

listenForChanges();
// Nuevo endpoint para reconocer rostros similares
app.post('/recognize-similars', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send({message: 'No se ha subido ningún archivo.'});
  }

  try {
    await loadModels();
    if (labeledDescriptors.length === 0) await loadKnownFaces();
    const resizedImageBuffer = await sharp(req.file.buffer)
    .resize(320, 240, {
      fit: sharp.fit.inside,
      withoutEnlargement: true
    })
    .toBuffer();
    const img2 = await canvas.loadImage(resizedImageBuffer);
    console.log("img2: ",img2);
    const queryDescriptor = await getDescriptors(resizedImageBuffer);
    if (!queryDescriptor) {
      return res.status(400).send({message: 'No se detectó ninguna cara en la imagen.'});
    }

    const similarFaces = await findSimilarFaces(queryDescriptor);

    // Obtener información adicional de Firestore
    const similarFacesWithInfo = await Promise.all(similarFaces.map(async (face) => {
      return {
        recognizedPerson: JSON.parse(face.label),
        distance: face.distance,
        index: face.index
      };
    }));

    res.json({similarFacesWithInfo, message: "Imagen analizada"});
  } catch (error) {
    console.error('Error en el reconocimiento de rostros similares:', error);
    res.status(500).send({message: 'Error en el reconocimiento de rostros similares'});
  }
});

// Endpoint para reconocimiento facial
app.post('/recognize', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send({message: 'No se ha subido ningún archivo.'});
  }

  try {
    await loadModels();
    if (labeledDescriptors.length === 0) await loadKnownFaces();
    const resizedImageBuffer = await sharp(req.file.buffer)
    .resize(320, 240, {
      fit: sharp.fit.inside,
      withoutEnlargement: true
    })
    .toBuffer();
    const img2 = await canvas.loadImage(resizedImageBuffer);
    console.log("img2: ",img2);
    const descriptor = await getDescriptors(resizedImageBuffer);
    if (!descriptor) {
      return res.status(400).send({message: 'No se detectó ninguna cara en la imagen.'});
    }

    const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors);
    const match = faceMatcher.findBestMatch(descriptor);
    let recoP = match.label;
    const umbral = 0.5;
    if (recoP !== "unknown") {
      recoP = JSON.parse(recoP);
    }
    
    res.json({
      recognizedPerson: recoP,
      confidence: 1 - match.distance,
      message: "Imagen analizada"
    });
  } catch (error) {
    console.error('Error en el reconocimiento facial:', error);
    res.status(500).send({message: 'Error en el reconocimiento facial'});
  }
});

// Iniciar el servidor
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  await loadModels();
  console.log(`Servidor ejecutándose en http://localhost:${port}`);
});
