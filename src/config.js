'use strict';

const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PORT = Number(process.env.PORT) || 3030;

const DB_FILE = path.join(
    __dirname,
    '..',
    'pw-cats.json'
);

const PROXY_URL =
    process.env.PROXY_URL ||
    'socks5://127.0.0.1:3066';

const proxyAgent =
    new HttpsProxyAgent(PROXY_URL);

const http = axios.create({
    httpAgent: proxyAgent,
    httpsAgent: proxyAgent,
    proxy: false,
    timeout: 30000,

    headers: {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',

        'Accept-Language':
            'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});

module.exports = {
    PORT,
    DB_FILE,
    PROXY_URL,
    http
};
