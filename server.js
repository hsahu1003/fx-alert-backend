const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// --- Firebase सेटअप ---
// सर्विस अकाउंट की को इम्पोर्ट करें
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
// --- Firebase सेटअप का अंत ---

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// --- ग्लोबल वैरिएबल्स ---
const TWELVE_DATA_API_KEY = '211d01dc9a234426b787d02f8b8bd19a';
let alerts = [];
let deviceTokens = new Set(); // डिवाइस टोकन स्टोर करने के लिए
let alertIdCounter = 1;
let lastPrices = {};

// --- API Endpoints ---
app.get('/', (req, res) => {
    res.send('FX Alert Backend is running and ready for notifications!');
});

// नया: डिवाइस टोकन रजिस्टर करने के लिए
app.post('/register-device', (req, res) => {
    const { token } = req.body;
    if (token) {
        deviceTokens.add(token);
        console.log('New device registered:', token);
        res.status(200).send({ message: 'Device registered successfully.' });
    } else {
        res.status(400).send({ message: 'Token is required.' });
    }
});

app.post('/set-alert', (req, res) => {
    const newAlert = req.body;
    newAlert.id = alertIdCounter++;
    alerts.push(newAlert);
    console.log('New Alert Set:', newAlert);
    res.status(200).json({ message: 'Alert set successfully', alert: newAlert });
});

app.get('/get-alerts', (req, res) => {
    res.status(200).json(alerts);
});

app.post('/delete-alert', (req, res) => {
    const { id } = req.body;
    alerts = alerts.filter(alert => alert.id !== id);
    console.log('Alert Deleted: ID', id);
    res.status(200).json({ message: 'Alert deleted successfully' });
});

// --- मुख्य अलर्ट चेकिंग और नोटिफिकेशन फंक्शन ---
const checkAlerts = async () => {
    if (alerts.length === 0 || deviceTokens.size === 0) {
        // अगर कोई अलर्ट या डिवाइस नहीं है, तो कुछ न करें
        return;
    }

    const triggeredAlerts = []; // इस साइकिल में ट्रिगर हुए अलर्ट्स

    const symbols = [...new Set(alerts.map(a => a.symbol.replace('-', '/')))];
    try {
        const url = `https://api.twelvedata.com/price?symbol=${symbols.join(',')}&apikey=${TWELVE_DATA_API_KEY}`;
        const response = await fetch(url);
        const priceData = await response.json();
        const prices = symbols.length === 1 && priceData.price ? { [symbols[0]]: priceData } : priceData;

        for (const symbolKey in prices) {
            if (!prices[symbolKey] || !prices[symbolKey].price) continue;
            const currentPrice = parseFloat(prices[symbolKey].price);
            const htmlSymbol = symbolKey.replace('/', '-');
            const previousPrice = lastPrices[htmlSymbol] || currentPrice;

            alerts.forEach(alert => {
                let conditionMet = false;
                if (alert.symbol === htmlSymbol) {
                    if (alert.condition === '>' && currentPrice > alert.value && previousPrice <= alert.value) conditionMet = true;
                    else if (alert.condition === '<' && currentPrice < alert.value && previousPrice >= alert.value) conditionMet = true;
                    
                    if (conditionMet) {
                        console.log(`ALERT TRIGGERED: ${alert.symbol} ${alert.condition} ${alert.value}`);
                        triggeredAlerts.push(alert);
                    }
                }
            });
            lastPrices[htmlSymbol] = currentPrice;
        }

        // --- अब नोटिफिकेशन भेजें ---
        if (triggeredAlerts.length > 0 && deviceTokens.size > 0) {
            const tokens = Array.from(deviceTokens); // Set को Array में बदलें
            const alert = triggeredAlerts[0]; // अभी हम एक बार में एक ही भेज रहे हैं
            
            const message = {
                notification: {
                    title: `FX Alert: ${alert.symbol}`,
                    body: `Price ${alert.condition === '>' ? 'crossed above' : 'crossed below'} ${alert.value.toFixed(4)}`
                },
                tokens: tokens,
                // एंड्रॉइड के लिए खास सेटिंग्स
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default', // यहाँ हम कस्टम साउंड सेट कर सकते हैं
                        channelId: 'fcm_default_channel' // यह ज़रूरी है
                    }
                }
            };

            // नोटिफिकेशन भेजें
            admin.messaging().sendMulticast(message)
                .then((response) => {
                    console.log(response.successCount + ' messages were sent successfully');
                    // जो अलर्ट भेजा जा चुका है, उसे हटा दें ताकि वह बार-बार न बजे
                    alerts = alerts.filter(a => a.id !== alert.id);
                })
                .catch((error) => {
                    console.log('Error sending message:', error);
                });
        }

    } catch (error) {
        console.error('Error fetching prices or checking alerts:', error.message);
    }
};

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    setInterval(checkAlerts, 30000);
});