const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// --- Firebase सेटअप ---
// सुनिश्चित करें कि आपकी 'firebase-service-account.json' फ़ाइल इसी फोल्डर में है
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

// डिवाइस टोकन रजिस्टर करने के लिए
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

// --- मुख्य अलर्ट चेकिंग और नोटिफिकेशन फंक्शन (सुधरा हुआ) ---
const checkAlerts = async () => {
    if (alerts.length === 0 || deviceTokens.size === 0) {
        return; // अगर कोई अलर्ट या डिवाइस नहीं है, तो कुछ न करें
    }

    const symbols = [...new Set(alerts.map(a => a.symbol.replace('-', '/')))];
    if (symbols.length === 0) return;

    try {
        const url = `https://api.twelvedata.com/price?symbol=${symbols.join(',')}&apikey=${TWELVE_DATA_API_KEY}`;
        const response = await fetch(url);
        const priceData = await response.json();
        const prices = priceData.code >= 400 ? {} : priceData;

        const triggeredAlerts = [];

        for (const symbolKey in prices) {
            if (!prices[symbolKey] || !prices[symbolKey].price) continue;
            
            const currentPrice = parseFloat(prices[symbolKey].price);
            const htmlSymbol = symbolKey.replace('/', '-');
            const previousPrice = lastPrices[htmlSymbol] || currentPrice;

            alerts.forEach(alert => {
                if (alert.symbol === htmlSymbol) {
                    let conditionMet = false;
                    if (alert.condition === '>' && currentPrice > alert.value && previousPrice <= alert.value) conditionMet = true;
                    else if (alert.condition === '<' && currentPrice < alert.value && previousPrice >= alert.value) conditionMet = true;
                    
                    if (conditionMet) {
                        console.log(`ALERT TRIGGERED: ${alert.symbol} at ${currentPrice} (Condition: ${alert.condition} ${alert.value})`);
                        triggeredAlerts.push(alert);
                    }
                }
            });
            lastPrices[htmlSymbol] = currentPrice;
        }

        if (triggeredAlerts.length > 0 && deviceTokens.size > 0) {
            const tokens = Array.from(deviceTokens);
            const triggeredAlertIds = [];

            // सभी ट्रिगर हुए अलर्ट्स के लिए एक-एक करके नोटिफिकेशन भेजें
            for (const alert of triggeredAlerts) {
                const messageBody = alert.type === 'indicator'
                    ? `Price ${alert.condition === '>' ? 'crossed above' : 'crossed below'} ${alert.name} at ${alert.value.toFixed(4)}`
                    : `Price ${alert.condition === '>' ? 'crossed above' : 'crossed below'} ${alert.value.toFixed(4)}`;

                // यह मैसेज ऑब्जेक्ट है जिसे Firebase को भेजना है
                const message = {
                    notification: {
                        title: `🔔 Alert: ${alert.symbol}`,
                        body: messageBody
                    },
                    tokens: tokens, // सभी रजिस्टर्ड डिवाइस को भेजें
                    android: {
                        priority: 'high',
                        notification: { sound: 'default', channelId: 'fcm_default_channel' }
                    },
                    apns: {
                        payload: { aps: { sound: 'default' } }
                    }
                };
                
                try {
                    // *** यही वह लाइन थी जिसे ठीक किया गया है ***
                    // अब यह सही तरीके से नोटिफिकेशन भेजेगा
                    const response = await admin.messaging().sendMulticast(message);
                    console.log(response.successCount + ` messages sent successfully for alert ID ${alert.id}`);
                    triggeredAlertIds.push(alert.id);
                } catch (error) {
                    console.error(`Error sending message for alert ID ${alert.id}:`, error);
                }
            }

            // जो अलर्ट्स भेजे जा चुके हैं, उन्हें मुख्य लिस्ट से हटा दें
            if (triggeredAlertIds.length > 0) {
                alerts = alerts.filter(a => !triggeredAlertIds.includes(a.id));
                console.log(`Removed ${triggeredAlertIds.length} triggered alerts from the active list.`);
            }
        }

    } catch (error) {
        console.error('Error in checkAlerts function:', error.message);
    }
};

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    setInterval(checkAlerts, 30000); // हर 30 सेकंड में अलर्ट चेक करें
});