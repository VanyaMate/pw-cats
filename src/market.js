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
 * Отсеиваем всплески в предложениях.
 *
 * Пример скупа: 4419 по 1000, 1000 по 1022, 996 по 1021 и одна сотня
 * по 2000. Дорогие мелкие заявки — не цена рынка: по ним товар реально
 * не выкупить, а при выборе цены они перебивают нормальный кластер.
 *
 * Кластер строим по объёму: берём предложения по убыванию количества,
 * пока они не покроют 80% суммарного объёма. Лучшая цена кластера —
 * максимальная для скупа и минимальная для продажи. Предложение
 * считается всплеском, если оно хуже кластера больше чем на 15% и при
 * этом меньше 25% медианного объёма кластера.
 *
 * В списке предложений всплеск остаётся с пометкой: его видно, но в
 * цену он не входит.
 */

const CLUSTER_COVERAGE = 0.8;

const ANOMALY_PRICE_GAP = 0.15;

const ANOMALY_VOLUME_SHARE = 0.25;

function offerPrice(offer, side) {
    return side === 'buy'
        ? toNumber(offer.buyPrice)
        : toNumber(offer.sellPrice);
}

/*
 * Магазины, которые принадлежат нашим же котам: id магазина берём из
 * ссылки кота (параметр shop=), он же приходит в предложении рынка.
 * Свой витриной рынок не бывает — свои предложения показывают, сколько
 * просим мы, а не сколько стоит товар у людей, поэтому в цену они не
 * входят, но остаются в списке с пометкой.
 */
function ownShopIds() {
    const ids = new Set();

    for (const cat of db.cats) {
        const match = /shop=(\d+)/.exec(cat.url || '');

        if (match) {
            ids.add(match[1]);
        }
    }

    return ids;
}

function markOwnOffers(offers, ids) {
    for (const offer of offers) {
        offer.own = ids.has(String(offer.id));
    }

    return offers;
}

/*
 * Предложения, по которым считаем рынок: чужие и с непустой ценой.
 */
function pricePool(offers, side) {
    return offers.filter(
        offer => !offer.own && offerPrice(offer, side) > 0
    );
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);

    if (!sorted.length) {
        return 0;
    }

    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

/*
 * Помечает всплески прямо в массиве предложений, чтобы фронт их видел.
 */
function markAnomalies(offers, side) {
    const priced = pricePool(offers, side);

    for (const offer of offers) {
        offer.anomaly = false;
    }

    // Пока предложений мало, кластер построить нельзя — ничего не режем.
    if (priced.length < 3) {
        return offers;
    }

    const total = priced.reduce(
        (sum, offer) => sum + toNumber(offer.count),
        0
    );

    if (total <= 0) {
        return offers;
    }

    const byVolume = [...priced].sort(
        (a, b) => toNumber(b.count) - toNumber(a.count)
    );

    const cluster = [];
    let covered = 0;

    for (const offer of byVolume) {
        cluster.push(offer);

        covered += toNumber(offer.count);

        if (covered >= total * CLUSTER_COVERAGE) {
            break;
        }
    }

    const prices = cluster.map(offer => offerPrice(offer, side));

    const bestClusterPrice = side === 'buy'
        ? Math.max(...prices)
        : Math.min(...prices);

    const volumeLimit = median(cluster.map(o => toNumber(o.count))) *
        ANOMALY_VOLUME_SHARE;

    for (const offer of priced) {
        if (cluster.includes(offer)) {
            continue;
        }

        const price = offerPrice(offer, side);

        const worseThanCluster = side === 'buy'
            ? price > bestClusterPrice * (1 + ANOMALY_PRICE_GAP)
            : price < bestClusterPrice * (1 - ANOMALY_PRICE_GAP);

        offer.anomaly = worseThanCluster && toNumber(offer.count) < volumeLimit;
    }

    return offers;
}

/*
 * Цена рынка без всплесков: лучшая среди чистых предложений, а если все
 * оказались всплеском — прежний максимум/минимум.
 */
function cleanMarketPrice(offers, side) {
    const values = pricePool(offers, side).map(
        offer => offerPrice(offer, side)
    );

    if (!values.length) {
        return 0;
    }

    const clean = pricePool(offers, side)
        .filter(offer => !offer.anomaly)
        .map(offer => offerPrice(offer, side));

    const pool = clean.length ? clean : values;

    return side === 'buy'
        ? Math.max(...pool)
        : Math.min(...pool);
}

/*
 * Запрашивает рынок товара: продавцов (show=sell, по возрастанию цены)
 * и покупателей (show=buy, по убыванию цены). Два запроса подряд с
 * паузой, чтобы не словить бан.
 */
async function fetchMarket(externalId, server) {
    const own = ownShopIds();

    const sellUrl = buildMarketUrl(externalId, 'sell', server);

    const sellHtml = await fetchHtml(sellUrl);

    const sellOffers = markOwnOffers(
        parseMarketPage(sellHtml, sellUrl).filter(offer => offer.sellPrice > 0),
        own
    );

    markAnomalies(sellOffers, 'sell');

    sellOffers.sort((a, b) => a.sellPrice - b.sellPrice);

    await sleep(1200);

    const buyUrl = buildMarketUrl(externalId, 'buy', server);

    const buyHtml = await fetchHtml(buyUrl);

    const buyOffers = markOwnOffers(
        parseMarketPage(buyHtml, buyUrl).filter(offer => offer.buyPrice > 0),
        own
    );

    markAnomalies(buyOffers, 'buy');

    buyOffers.sort((a, b) => b.buyPrice - a.buyPrice);

    const sample =
        sellOffers.find(o => o.name) ||
        buyOffers.find(o => o.name) ||
        null;

    return {
        server: server || marketServer(),
        sellOffers,
        buyOffers,
        marketSellPrice: cleanMarketPrice(sellOffers, 'sell'),
        marketBuyPrice: cleanMarketPrice(buyOffers, 'buy'),
        name: sample ? sample.name : '',
        image: sample ? sample.image : '',
        externalId: sample ? sample.externalId : String(externalId),
        fetchedAt: now()
    };
}

/*
 * Обновляет рыночные данные товара.
 *
 * Рыночная цена — автоматическая: она пишется всегда и сразу, в том же
 * задании очереди. Раньше при отклонении больше порога цена НЕ
 * принималась, а товар уезжал в конец очереди на повтор: на длинной
 * очереди это минуты ожидания, а при каждом новом «обновить цены всех»
 * счётчик повторов обнулялся, и цифра не обновлялась вовсе. Порог
 * отклонения оставлен только как пометка jump для глаза — беречь
 * РУЧНЫЕ цены при переносе по-прежнему должен prices.js, а не сбор
 * рынка.
 */
async function updateProductMarket(product) {
    const market = await fetchMarket(
        product.externalId,
        marketServer()
    );

    const threshold = toNumber(db.settings.priceDeviationThreshold, 0.3);

    const previous = product.market
        ? toNumber(product.market.sellPrice)
        : 0;

    const incomingSell = toNumber(market.marketSellPrice);
    const incoming = incomingSell || previous;

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
    product.market.sellOffersCount = market.sellOffers.length;
    product.market.buyOffersCount = market.buyOffers.length;

    product.market.buyPrice = toNumber(market.marketBuyPrice) ||
        toNumber(product.market.buyPrice);

    product.market.sellPrice = incoming;
    product.market.updatedAt = market.fetchedAt;
    product.market.previousSellPrice = previous;

    const jumped =
        previous > 0 &&
        incoming > 0 &&
        Math.abs(incoming - previous) / previous > threshold;

    if (jumped) {
        product.market.jump = {
            from: previous,
            to: incoming,
            at: market.fetchedAt
        };
    } else {
        delete product.market.jump;
    }

    // Старые поля suspicious больше не участвуют в логике обновления.
    delete product.market.suspicious;
    delete product.market.suspiciousSellPrice;
    delete product.market.suspiciousAt;

    product.updatedAt = now();

    save();

    return { jumped, sellPrice: incoming, buyPrice: product.market.buyPrice };
}

module.exports = {
    fetchMarket,
    updateProductMarket,
    buildMarketUrl,
    marketServer,
    markAnomalies,
    cleanMarketPrice
};
