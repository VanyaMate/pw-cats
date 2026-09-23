'use strict';

const crypto = require('crypto');

function createId() {
    return crypto.randomUUID();
}

function now() {
    return new Date().toISOString();
}

function toNumber(value, fallback = 0) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}

function toInt(value, fallback = 0) {
    return Math.floor(
        toNumber(value, fallback)
    );
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function normalizeUrl(value) {
    let url = String(value || '').trim();

    if (!url) {
        return '';
    }

    if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
    }

    return url;
}

function cleanText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

/*
 * Цены и количества на comeback.pw — целые неотрицательные числа, но на
 * странице рынка они разделены запятой по тысячам ("39,699" = 39699),
 * а в витрине кота и на бирже идут без разделителей ("42500"). Поэтому
 * просто отбрасываем всё, кроме цифр.
 */
function parsePrice(value) {
    if (value === undefined || value === null) {
        return 0;
    }

    const text = String(value).replace(/\D/g, '');

    if (!text) {
        return 0;
    }

    const result = Number(text);

    return Number.isFinite(result) ? result : 0;
}

function parseCount(value) {
    return Math.max(0, Math.floor(parsePrice(value)));
}

function absoluteUrl(url, baseUrl) {
    try {
        return new URL(url, baseUrl).toString();
    } catch {
        return url || '';
    }
}

function getCatIdFromUrl(url) {
    try {
        const parsed = new URL(normalizeUrl(url));
        const match = parsed.pathname.match(/\/cats\/(\d+)/i);

        return match ? match[1] : '';
    } catch {
        return '';
    }
}

function getQueryParameter(url, parameter) {
    try {
        const parsed = new URL(normalizeUrl(url));

        return parsed.searchParams.get(parameter) || '';
    } catch {
        return '';
    }
}

function buildShopUrl(baseUrl, show, page) {
    const url = new URL(normalizeUrl(baseUrl));

    url.searchParams.delete('item_id');
    url.searchParams.set('show', show);
    url.searchParams.set('page', String(page));

    return url.toString();
}

module.exports = {
    createId,
    now,
    toNumber,
    toInt,
    sleep,
    normalizeUrl,
    cleanText,
    parsePrice,
    parseCount,
    absoluteUrl,
    getCatIdFromUrl,
    getQueryParameter,
    buildShopUrl
};
