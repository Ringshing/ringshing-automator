/*
* =================================================================
* File: `api/shopify-webhook.js`
* =================================================================
*
* This is the final, production-ready version. It includes robust
* error handling for the database connection.
*
*/

const https = require('https');
const crypto = require('crypto');
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


// --- Helper Functions ---

function normalizePhoneNumber(phone) {
    if (!phone) return null;
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) {
        return `92${cleaned.substring(1)}`;
    }
    if (cleaned.startsWith('92')) {
        return cleaned;
    }
    if (cleaned.length === 10) {
        return `92${cleaned}`;
    }
    return cleaned;
}

async function shopifyFetch({ query, variables }) {
    return new Promise((resolve, reject) => {
        const queryData = JSON.stringify({ query, variables });
        const options = {
            hostname: process.env.SHOPIFY_STORE_URL,
            path: '/admin/api/2024-07/graphql.json',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': queryData.length,
                'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN,
            }
        };
        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.errors) reject(new Error(JSON.stringify(result.errors)));
                    else resolve(result.data);
                } catch (e) {
                    reject(new Error(`Failed to parse Shopify response: ${data}`));
                }
            });
        });
        request.on('error', (error) => reject(error));
        request.write(queryData);
        request.end();
    });
}

async function sendGupshupTemplateMessage(phone, params) {
    const templateObject = {
        "id": process.env.GUPSHUP_COD_TEMPLATE_ID,
        "params": params
    };

    const messagePayload = querystring.stringify({
        'channel': 'whatsapp',
        'source': process.env.GUPSHUP_SOURCE_NUMBER,
        'destination': phone,
        'template': JSON.stringify(templateObject),
        'src.name': process.env.GUPSHUP_APP_NAME
    });

    const options = {
        hostname: 'api.gupshup.io',
        path: `/wa/api/v1/template/msg`,
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

function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => { resolve(body); });
    });
}

// --- Main Webhook Handler ---

module.exports = async (req, res) => {
    try {
        const rawBody = await parseBody(req);
        const hmac = req.headers['x-shopify-hmac-sha256'];
        const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

        const hash = crypto
            .createHmac('sha256', secret)
            .update(rawBody, 'utf8')
            .digest('base64');

        if (hash !== hmac) {
            return res.status(401).send('Unauthorized');
        }

        const order = JSON.parse(rawBody);

        if (order.gateway && order.gateway.toLowerCase().includes('bank deposit')) {
            return res.status(200).send('OK: Bank Deposit order, no action taken.');
        }

        const orderId = `gid://shopify/Order/${order.id}`;
        const orderName = order.name;
        const customerName = order.customer?.first_name || 'Valued Customer';
        let phone = normalizePhoneNumber(order.shipping_address?.phone || order.customer?.phone || order.phone);
        
        const productName = order.line_items[0]?.name || 'Your Jewelry';
        const orderAmount = `${parseFloat(order.total_price).toFixed(0)} PKR`;
        const advancePaymentValue = parseFloat(order.total_price) * 0.01;
        const advancePayment = `${advancePaymentValue.toFixed(0)} PKR`;
        const shippingAddress = order.shipping_address ? `${order.shipping_address.address1}, ${order.shipping_address.city}` : 'Address not provided';
        
        if (!phone) {
            return res.status(200).send('OK: No phone number.');
        }

        const templateParams = [customerName, orderName, productName, orderAmount, advancePayment, shippingAddress];
        await sendGupshupTemplateMessage(phone, templateParams);

        if (!db) {
            console.error("Firestore db object is not available. Cannot log message.");
        } else {
            const messageLog = {
                customerPhone: phone,
                direction: 'outbound',
                content: `Sent COD confirmation for order ${orderName}`,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };
            await db.collection('conversations').doc(phone).collection('messages').add(messageLog);
        }

        const tagMutation = `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;
        await shopifyFetch({ query: tagMutation, variables: { id: orderId, tags: ["COD-Confirmation-Sent"] } });

        console.log(`Real-time confirmation sent for new order ${orderName}`);
        res.status(200).send('Webhook processed successfully.');

    } catch (error) {
        console.error("Shopify Webhook Error:", error);
        res.status(500).send('Error processing webhook.');
    }
};
