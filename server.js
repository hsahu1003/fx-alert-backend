const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// --- Firebase सेटअप ---
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
let deviceTokens = new Set();
let alertIdCounter = 1;
let lastPrices = {};

// --- API Endpoints ---
app.get('/', (req, res) => {
    res.send('FX Alert Backend is running and ready for notifications!');
});

app.post('/register-device', (req, res) => {
    const { token } = req.body;
    if (token) {
        deviceTokens.add(token);
        console.log(`Device registered or refreshed. Total devices: ${deviceTokens.size}`);
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
    // पहली बार के लिए पिछली कीमत को तुरंत सेट कर दें ताकि इंतज़ार न करना पड़े
    const htmlSymbol = newAlert.symbol.replace('/', '-');
    if (!lastPrices[htmlSymbol]) {
        lastPrices[htmlSymbol] = 0; // एक शुरुआती वैल्यू
    }
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

// --- मुख्य अलर्ट चेकिंग फंक्शन (अंतिम सुधार के साथ) ---
const checkAlerts = async () => {
    if (alerts.length === 0) {
        return;
    }

    const symbols = [...new Set(alerts.map(a => a.symbol.replace('-', '/')))];
    if (symbols.length === 0) return;

    try {
        const url = `https://api.twelvedata.com/price?symbol=${symbols.join(',')}&apikey=${TWELVE_DATA_API_KEY}`;
        const response = await fetch(url);
        const priceData = await response.json();
        
        console.log("--- Checking Prices ---");
        console.log("Fetched Prices from API:", priceData);

        let prices = {};
        if (priceData.price) {
            prices[symbols[0]] = priceData;
        } else if (priceData.code < 400) {
            prices = priceData;
        }

        const triggeredAlerts = [];

        for (const symbolKey in prices) {
            if (!prices[symbolKey] || !prices[symbolKey].price) continue;
            
            const currentPrice = parseFloat(prices[symbolKey].price);
            const htmlSymbol = symbolKey.replace('/', '-');
            
            // *** यही वह लाइन है जिसे अंतिम बार ठीक किया गया है ***
            // अगर पिछली कीमत 0 है (यानी पहली बार), तो उसे वर्तमान कीमत के बराबर मान लो
            const previousPrice = lastPrices[htmlSymbol] === 0 ? currentPrice : lastPrices[htmlSymbol];

            console.log(`[DEBUG] Checking ${htmlSymbol}: Current=${currentPrice}, Previous=${previousPrice}`);

            alerts.forEach(alert => {
                if (alert.symbol === htmlSymbol) {
                    let conditionMet = false;
                    
                    if (alert.condition === '>' && currentPrice >= alert.value && previousPrice < alert.value) {
                        conditionMet = true;
                    } else if (alert.condition === '<' && currentPrice <= alert.value && previousPrice > alert.value) {
                        conditionMet = true;
                    }
                    
                    if (conditionMet) {
                        console.log(`✅ ALERT TRIGGERED: ${alert.symbol} at ${currentPrice}`);
                        triggeredAlerts.push(alert);
                    }
                }
            });
            lastPrices[htmlSymbol] = currentPrice;
        }

        if (triggeredAlerts.length > 0 && deviceTokens.size > 0) {
            const tokens = Array.from(deviceTokens);
            const triggeredAlertIds = triggeredAlerts.map(a => a.id);

            for (const alert of triggeredAlerts) {
                const messageBody = `Price ${alert.condition === '>' ? 'crossed above' : 'crossed below'} ${alert.value.toFixed(4)}`;
                const message = {
                    notification: { title: `🔔 Alert: ${alert.symbol}`, body: messageBody },
                    tokens: tokens,
                    android: { priority: 'high', notification: { sound: 'default', channelId: 'fcm_default_channel' } },
                    apns: { payload: { aps: { sound: 'default' } } }
                };
                
                try {
                    const response = await admin.messaging().sendMulticast(message);
                    console.log(`✅ Notification sent for alert ID ${alert.id}. Success: ${response.successCount}`);
                } catch (error) {
                    console.error(`❌ Error sending notification for alert ID ${alert.id}:`, error);
                }
            }

            alerts = alerts.filter(a => !triggeredAlertIds.includes(a.id));
            console.log(`Removed ${triggeredAlertIds.length} triggered alerts.`);
        }

    } catch (error) {
        console.error('❌ Error in checkAlerts function:', error.message);
    }
};

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    setInterval(checkAlerts, 60000);
});