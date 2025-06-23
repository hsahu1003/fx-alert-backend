const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
// Render.com पोर्ट को अपने आप सेट करेगा, इसलिए हम उसे process.env.PORT से लेंगे
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

//Render पर यह जाँचने के लिए कि सर्वर चल रहा है या नहीं
app.get('/', (req, res) => {
    res.send('FX Alert Backend is running!');
});

const TWELVE_DATA_API_KEY = '211d01dc9a234426b787d02f8b8bd19a';

let alerts = [];
let alertIdCounter = 1;
let lastPrices = {};

app.post('/set-alert', (req, res) => {
    const newAlert = req.body;
    newAlert.id = alertIdCounter++;
    console.log('New Alert Set:', newAlert);
    alerts.push(newAlert);
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

const checkAlerts = async () => {
    if (alerts.length === 0) return;
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
                if (alert.symbol === htmlSymbol) {
                    let conditionMet = false;
                    if (alert.condition === '>' && currentPrice > alert.value && previousPrice <= alert.value) conditionMet = true;
                    else if (alert.condition === '<' && currentPrice < alert.value && previousPrice >= alert.value) conditionMet = true;
                    if (conditionMet) {
                        console.log(`\nALERT TRIGGERED: ${alert.symbol} ${alert.condition} ${alert.value} at ${new Date().toLocaleTimeString()}\n`);
                    }
                }
            });
            lastPrices[htmlSymbol] = currentPrice;
        }
    } catch (error) {
        console.error('Error fetching prices or checking alerts:', error.message);
    }
};

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    setInterval(checkAlerts, 30000);
});