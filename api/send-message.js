/*
* =================================================================
* File: `api/send-message.js`
* =================================================================
*
* This new module allows your dashboard to send messages and
* logs the outbound message to the database.
*
*/

const https = require('https');
const querystring = require('querystring');
const admin = require('firebase-admin');

// --- Firebase Initialization ---
let db;
try {
  if (!admin.apps.length) {
    const serviceAccountString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(serviceAccountString);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  db = admin.firestore();
} catch (error) {
  console.error('Firebase Admin Initialization Error:', error);
}

// --- Gupshup Helper Function ---
async function sendGupshupText(phone, message) {
    const messagePayload = querystring.stringify({
        'channel': 'whatsapp',
        'source': process.env.GUPSHUP_SOURCE_NUMBER,
        'destination': phone,
        'message': message,
        'src.name': process.env.GUPSHUP_APP_NAME
    });
    
    const options = {
        hostname: 'api.gupshup.io',
        path: `/wa/api/v1/msg`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'apikey': process.env.GUPSHUP_API_KEY,
            'Content-Length': messagePayload.length
        }
    };

    return new Promise((resolve, reject) => {
        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data);
                }
            });
        });
        request.on('error', (error) => reject(error));
        request.write(messagePayload);
        request.end();
    });
}

// --- Body Parser ---
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch(e) {
                reject(new Error("Failed to parse request body."));
            }
        });
    });
}

// --- Main Handler ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const { phone, message } = await parseBody(req);

        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required.' });
        }

        // Send the message via Gupshup
        const gupshupResponse = await sendGupshupText(phone, message);

        // Log the message you just sent to the database
        if (db) {
             await db.collection('conversations').doc(phone).collection('messages').add({
                customerPhone: phone,
                direction: 'outbound',
                content: message,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        res.status(200).json({ success: true, response: gupshupResponse });

    } catch (error) {
        console.error("Send Message API Error:", error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
};
