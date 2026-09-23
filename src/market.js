'use strict';

const { db, save } = require('./db');
const { parseMarketPage, fetchHtml } = require('./parser');
const { toNumber, now, sleep, cleanText } = require('./util');

const MARKET_BASE = 'https://comeback.pw/cats/';

function marketServer() {
    return cleanText(db.settings.marketServer) || '146';
}

function buildMarketUrl(externalId, show, server) {
    return (
        MARKET_BASE +
        (server || marketServer()) +
        '/?item_id=' +
        encodeURIComponent(externalId) +
        '&show=' +
        show +
        '&page=1'
    );
}

/*
 * Запрашивает рынок товара: продавцов (show=sell, по возрастанию цены)
 * и покупателей (show=buy, по убыванию цены). Два запроса подряд с
 * паузой, чтобы не словить бан.
 */
async function fetchMarket(externalId, server) {
    const sellUrl = buildMarketUrl(externalId, 'sell', server);

    const sellHtml = await fetchHtml(sellUrl);

    const sellOffers = parseMarketPage(sellHtml, sellUrl)
        .filter(offer => offer.sellPrice > 0)
        .sort((a, b) => a.sellPrice - b.sellPrice);

    await sleep(1200);

    const buyUrl = buildMarketUrl(externalId, 'buy', server);

    const buyHtml = await fetchHtml(buyUrl);

    const buyOffers = parseMarketPage(buyHtml, buyUrl)
        .filter(offer => offer.buyPrice > 0)
        .sort((a, b) => b.buyPrice - a.buyPrice);

    const sample =
        sellOffers.find(o => o.name) ||
        buyOffers.find(o => o.name) ||
        null;

    return {
        server: server || marketServer(),
        sellOffers,
        buyOffers,
        marketSellPrice: sellOffers.length ? sellOffers[0].sellPrice : 0,
        marketBuyPrice: buyOffers.length ? buyOffers[0].buyPrice : 0,
        name: sample ? sample.name : '',
        image: sample ? sample.image : '',
        externalId: sample ? sample.externalId : String(externalId),
        fetchedAt: now()
    };
}

/*
 * Обновляет рыночные данные товара.
 *
 * Баг comeback: иногда отдаёт не всех продавцов, из-за чего цена
 * может резко измениться. Если отклонение от прошлой цены больше
 * порога — помечаем товар как подозрительный, НЕ перезаписываем
 * доверенную цену и просим очередь повторить обновление позже.
 *
 * Возвращает { requeue, deferMs, suspicious } для очереди.
 */
async function updateProductMarket(product, job) {
    const server = marketServer();

    const market = await fetchMarket(product.externalId, server);

    const retries = job ? toNumber(job.retries) : 0;
    const maxRetries = job ? toNumber(job.maxRetries, 3) : 3;

    const threshold = toNumber(db.settings.priceDeviationThreshold, 0.3);

    const previous =
        product.market && toNumber(product.market.sellPrice) > 0
            ? toNumber(product.market.sellPrice)
            : 0;

    const incoming = market.marketSellPrice;

    let suspicious = false;

    if (previous > 0 && incoming > 0) {
        const deviation = Math.abs(incoming - previous) / previous;

        if (deviation > threshold) {
            suspicious = true;
        }
    }

    // Подтягиваем имя/иконку для товаров, добавленных вручную по id.
    if (market.name && (!product.name || /^Товар\s/.test(product.name))) {
        product.name = market.name;
    }

    if (market.image && !product.image) {
        product.image = market.image;
    }

    product.market = product.market || {};

    product.market.server = market.server;
    product.market.sellOffers = market.sellOffers.slice(0, 12);
    product.market.buyOffers = market.buyOffers.slice(0, 12);
    product.market.buyPrice = market.marketBuyPrice;
    product.market.updatedAt = market.fetchedAt;
    product.market.sellOffersCount = market.sellOffers.length;
    product.market.buyOffersCount = market.buyOffers.length;

    const canRetry = retries < Math.max(0, maxRetries - 1);

    if (suspicious && canRetry && incoming > 0) {
        // Не доверяем резкой цене — оставляем прошлую, помечаем.
        product.market.suspicious = true;
        product.market.suspiciousSellPrice = incoming;
        product.market.suspiciousAt = market.fetchedAt;
        product.market.previousSellPrice = previous;

        if (!(toNumber(product.market.sellPrice) > 0)) {
            product.market.sellPrice = previous;
        }

        product.updatedAt = now();

        save();

        return {
            requeue: true,
            deferMs: Math.max(2000, toNumber(db.settings.updateIntervalMs, 7000)),
            suspicious: true
        };
    }

    // Принимаем цену (обычное обновление или последняя попытка).
    product.market.previousSellPrice = previous;
    product.market.sellPrice = incoming || previous;
    product.market.suspicious = false;
    product.market.suspiciousSellPrice = null;
    product.market.suspiciousAt = null;

    product.updatedAt = now();

    save();

    return { requeue: false, suspicious: false };
}

module.exports = {
    fetchMarket,
    updateProductMarket,
    buildMarketUrl,
    marketServer
};
