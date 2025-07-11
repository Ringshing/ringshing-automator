/*
* =================================================================
* File: `utils/firebase.js`
* =================================================================
*
* This module initializes a secure connection to your
* Firestore database using the Base64 encoded service account key.
*
*/

const admin = require('firebase-admin');

try {
  // Check if the app is already initialized to prevent errors
  if (!admin.apps.length) {
    // Decode the Base64 string from environment variables to get the JSON key
    const serviceAccountString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(serviceAccountString);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
} catch (error) {
  console.error('Firebase Admin Initialization Error:', error);
}

// Export the database instance for use in other modules
const db = admin.firestore();
module.exports = { db };
