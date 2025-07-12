/*
* =================================================================
* File: `api/gupshup-webhook.js`
* =================================================================
*
* This is the final, corrected version. It fixes a syntax error
* that was causing the server to crash.
*
*/

const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');
const admin = require('firebase-admin');

// --- Firebase Initialization with Logging ---
let db;
try {
  if (!admin.apps.length) {
    const serviceAccountString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(serviceAccountString);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin Initialized Successfully in gupshup-webhook.");
  }
  db = admin.firestore();
} catch (error) {
  console.error('Firebase Admin Initialization Error in gupshup-webhook:', error);
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

async function getGeminiResponse(prompt) {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`;
    
    const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }]
    };

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const result = await response.json();
    
    if (result.candidates && result.candidates.length > 0) {
        return result.candidates[0].content.parts[0].text;
    } else {
        return "I'm sorry, I'm having a little trouble thinking right now. A human representative will be with you shortly.";
    }
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error("Failed to parse request body."));
            }
        });
    });
}

// --- Main Webhook Handler ---

module.exports = async (req, res) => {
    if (req.method === 'GET') {
        return res.status(200).send('Webhook is active and listening for POST requests from Gupshup.');
    }
    
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const incomingMessage = await parseBody(req);

        if (incomingMessage.type !== 'message') {
            return res.status(200).send('OK: Not a user message.');
        }

        const customerReply = incomingMessage.payload?.payload?.text;
        const customerPhone = incomingMessage.payload?.sender?.phone;

        if (!customerReply || !customerPhone) {
            return res.status(200).send('OK: Incomplete payload.');
        }

        if (db) {
            await db.collection('conversations').doc(customerPhone).collection('messages').add({
                customerPhone: customerPhone,
                direction: 'inbound',
                content: customerReply,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        const knowledgeBase = {
            storeName: "Ringshing.com",
            location: "Block, Ground floor, Pace/ B1, 96-B MM Alam Rd, Block B1 Block B 1 Gulberg III, Lahore, 54660",
            specialty: "Premium Moissanite and Diamond Jewellery",
            paymentMethods: "Cash on Delivery (with 1% advance) and Bank Deposit.",
            currentCampaigns: [
                { name: "Summer Sale", details: "15% off on all necklaces until the end of July." },
                { name: "New Customer Welcome", details: "A special 10% discount for your next purchase." }
            ],
            goldPriceEstimate: {
                ratePerGram24k: 21500,
                gramsForSmallRing: 4,
                gramsForLargeRing: 6
            }
        };
    
        const orderQuery = `
            query {
                orders(first: 1, query: "phone:${customerPhone} tag:'COD-Confirmation-Sent'", sortKey: CREATED_AT, reverse: true) {
                    edges {
                        node {
                            id
                            name
                            customer { id, firstName }
                        }
                    }
                }
            }
        `;
        const orderData = await shopifyFetch({ query: orderQuery });
        const order = orderData.orders.edges[0]?.node;

        const aiPersonaPrompt = `You are 'Sana', a senior, friendly, and professional sales representative for ${knowledgeBase.storeName}. Your primary goal is to be helpful and conversational. Follow these rules strictly:
        **Rule 0: Your Introduction** When responding to a customer for the first time in a conversation, you MUST start your message with: "Assalam o Alaikum! I am Sana, your AI assistant from Ringshing. Please note that my responses are AI-generated. How may I help you?" After this introduction, you will then answer the customer's specific question.
        1. **Your Knowledge Source:** Your ONLY source of truth is the provided KNOWLEDGE BASE and any real-time PRODUCT DATA provided. Do not use any external information.
        2. **Be Conversational:** Keep your answers short, natural, and friendly. Do NOT repeat information the customer already knows (like their order number) unless they ask.
        3. **Handle Roman Urdu:** Understand and respond naturally to Roman Urdu inquiries.
        4. **Product Questions:** If the user asks about products, use the provided PRODUCT DATA to answer. If no products are found, ask clarifying questions to help you search better (e.g., "Could you tell me a bit more about the style you're looking for?").
        5. **Boundaries:** If a question is clearly outside of your knowledge base (e.g., politics, personal opinions), you MUST respond with only this exact phrase: "I'm sorry, I can only assist with questions about our products and your order. A human representative will be with you shortly to help with that."`;

        
        let responseMessage;
        
        if (order && customerReply === 'Confirm Order') {
            const tagMutation = `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: ["COD-Confirmed"]) { userErrors { field message } } }`;
            await shopifyFetch({ query: tagMutation, variables: { id: order.id } });
            responseMessage = `Thank you! Your order #${order.name} has been confirmed.`;
        
        } else if (order && customerReply === 'Cancel Order') {
            const cancelMutation = `mutation orderCancel($id: ID!) { orderCancel(id: $id) { order { id } userErrors { field message } } }`;
            await shopifyFetch({ query: cancelMutation, variables: { id: order.id } });
            responseMessage = `Your order #${order.name} has been cancelled as requested.`;
        
        } else if (customerReply === 'Get payment Details') {
            responseMessage = "Thank you for confirming! You can send the advance payment to the following bank account:\n\nBank: [Your Bank Name]\nAccount Title: [Your Account Title]\nAccount Number: [Your Account Number]\n\nPlease send a screenshot of the receipt to this number once completed.";

        } else if (customerReply === 'Need Information') {
            const customerName = order ? order.customer.firstName : "Valued Customer";
            const orderContext = order ? `They are asking about their recent order, #${order.name}.` : `This is a general inquiry.`;
            const aiPrompt = `${aiPersonaPrompt}\n\nKNOWLEDGE BASE: ${JSON.stringify(knowledgeBase)}\n\nCONTEXT: A customer named ${customerName} has clicked 'Need Information'. ${orderContext} Their message is: "${customerReply}". Please formulate a response based on your instructions.`;
            responseMessage = await getGeminiResponse(aiPrompt);

            if (responseMessage.includes("A human representative will be with you shortly")) {
                const customerId = order ? order.customer.id : (await shopifyFetch({query: `{customers(first:1, query:"phone:${customerPhone}"){edges{node{id}}}}`})).customers.edges[0]?.node.id;
                if (customerId) {
                    const tagMutation = `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: ["human-assistance-required"]) { userErrors { field message } } }`;
                    await shopifyFetch({ query: tagMutation, variables: { id: customerId } });
                }
            }
        
        } else {
            const customerId = order ? order.customer.id : (await shopifyFetch({query: `{customers(first:1, query:"phone:${customerPhone}"){edges{node{id}}}}`})).customers.edges[0]?.node.id;
            if (customerId) {
                const tagMutation = `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: ["human-assistance-required"]) { userErrors { field message } } }`;
                await shopifyFetch({ query: tagMutation, variables: { id: customerId } });
            }
            responseMessage = "Thank you for your message. A representative will get back to you shortly.";
        }

        await sendGupshupText(customerPhone, responseMessage);
        
        if (db) {
            await db.collection('conversations').doc(customerPhone).collection('messages').add({
                customerPhone: customerPhone,
                direction: 'outbound',
                content: responseMessage,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        res.status(200).send('OK: Processed.');

    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send('Error processing webhook.');
    }
};
