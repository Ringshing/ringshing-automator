/*
* =================================================================
* File: `api/test-trigger.js`
* =================================================================
*
* This is a powerful testing tool. Visiting its URL will simulate
* a real Shopify webhook for new orders or abandoned checkouts.
*
*/

const https = require('https');
const crypto = require('crypto');

// --- Main Test Function ---

module.exports = async (req, res) => {
    try {
        // Determine which event to simulate based on the URL query
        // e.g., .../api/test-trigger?event=order
        // or .../api/test-trigger?event=checkout
        const eventType = req.url.split('?event=')[1] || 'order';
        
        let mockupData;
        let webhookTopic;

        console.log(`--- Running Manual Test Trigger for: ${eventType} ---`);

        // --- Mockup Data Section ---
        if (eventType === 'order') {
            webhookTopic = 'orders/create';
            mockupData = {
                id: 1234567890123,
                name: '#TEST-9999',
                gateway: 'Cash on Delivery', // Ensure this matches your logic
                total_price: '7500.00',
                customer: {
                    first_name: 'Test',
                    last_name: 'Order',
                    phone: '923367136436'
                },
                line_items: [{
                    name: 'Simulated Test Product - Ring'
                }],
                shipping_address: {
                    address1: '456 Test Avenue',
                    city: 'Testville',
                    phone: '923367136436'
                }
            };
        } else if (eventType === 'checkout') {
            webhookTopic = 'checkouts/create';
            mockupData = {
                id: 9876543210987,
                abandoned_checkout_url: 'https://ringshing.com/cart/recover?...',
                customer: {
                    first_name: 'Potential',
                    last_name: 'Customer',
                    phone: '923367136436'
                },
                line_items: [{
                    title: 'Almost Purchased - Necklace'
                }]
            };
        } else {
            return res.status(400).send('Invalid event type. Use ?event=order or ?event=checkout');
        }
        // --- End of Mockup Data ---

        const rawBody = JSON.stringify(mockupData);
        const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

        // 1. Create a valid HMAC signature, just like Shopify does
        const hmac = crypto
            .createHmac('sha256', secret)
            .update(rawBody, 'utf8')
            .digest('base64');

        // 2. Prepare the request to our own webhook endpoint
        const options = {
            hostname: 'automator-ringshing.vercel.app', // Your live server URL
            path: '/api/shopify-webhook',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Hmac-Sha256': hmac, // Send the signature we just created
                'X-Shopify-Topic': webhookTopic,
                'Content-Length': rawBody.length
            }
        };

        // 3. Make the request to our own server, simulating Shopify
        await new Promise((resolve, reject) => {
            const request = https.request(options, (response) => {
                response.on('data', () => {}); // We don't need to read the response data
                response.on('end', resolve);
            });
            request.on('error', (error) => reject(error));
            request.write(rawBody);
            request.end();
        });

        console.log(`Successfully triggered webhook for ${eventType}.`);
        res.status(200).send(`Successfully triggered webhook for ${eventType}. Check the Vercel logs for details.`);

    } catch (error) {
        console.error("Test Trigger Error:", error);
        res.status(500).send(`An error occurred in the test trigger: ${error.message}`);
    }
};
