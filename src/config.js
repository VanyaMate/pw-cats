'use strict';

const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PORT = Number(process.env.PORT) || 3030;

/*
 * Файл базы можно подменить через DB_FILE — нужно для прогонов на
 * копии данных, чтобы не трогать рабочую базу.
 */
const DB_FILE = process.env.DB_FILE || path.join(
    __dirname,
    '..',
    'pw-cats.json'
);

const PROXY_URL =
    process.env.PROXY_URL ||
    'socks5://127.0.0.1:3066';

const proxyAgent =
    new HttpsProxyAgent(PROXY_URL);

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';

/*
 * maxRedirects: 0 и validateStatus до 400 нужны анти-боту comeback.pw:
 * страница магазина отдаёт 302 на себя же, и по этому редиректу идёт
 * настоящая витрина. Ошибки 4xx/5xx при этом остаются ошибками.
 */
const http = axios.create({
    httpAgent: proxyAgent,
    httpsAgent: proxyAgent,
    proxy: false,
    timeout: 30000,
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 400,

    headers: {
        'User-Agent': USER_AGENT,

        'Accept-Language':
            'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});

module.exports = {
    PORT,
    DB_FILE,
    PROXY_URL,
    USER_AGENT,
    http
};
