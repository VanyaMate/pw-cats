'use strict';

const { db, save } = require('./db');
const { fetchShop } = require('./parser');
const { getOrCreateProduct, findProductById } = require('./products');
const { getOrCreateCatItem } = require('./calculate');
const { makeSnapshot, compareSnapshots } = require('./history');
const { createId, now, sleep } = require('./util');

const HISTORY_LIMIT = 50000;

/*
 * Обновление одного кота:
 * парсит страницы продажи и скупки, добавляет товары
 * в общую базу, обновляет количества/цены, пишет историю.
 */
async function updateCat(cat) {
    const before = makeSnapshot(cat);

    const sell = await fetchShop(cat.url, 'sell');

    await sleep(1000);

    const buy = await fetchShop(cat.url, 'buy');

    const sellMap = new Map();
    const buyMap = new Map();

    for (const item of sell.items) {
        sellMap.set(item.externalId, item);
    }

    for (const item of buy.items) {
        buyMap.set(item.externalId, item);
    }

    const allItems = [...sell.items, ...buy.items];

    for (const parsedItem of allItems) {
        const product = getOrCreateProduct(parsedItem);

        const catItem = getOrCreateCatItem(cat, product);

        const sellItem = sellMap.get(product.externalId);
        const buyItem = buyMap.get(product.externalId);

        if (sellItem) {
            catItem.sellCurrent = sellItem.count;
            catItem.sellPrice = sellItem.price;
            catItem.lastSellUpdate = now();

            product.lastSellPrice = sellItem.price;
        }

        if (buyItem) {
            catItem.buyCurrent = buyItem.count;
            catItem.buyPrice = buyItem.price;
            catItem.lastBuyUpdate = now();

            product.lastBuyPrice = buyItem.price;
        }
    }

    /*
     * Раскупленные позиции. Товар, который весь разошёлся (или который кот
     * выкупил в скупе), из сетки магазина исчезает, и на страницы он больше
     * не попадает. Без этого прохода строка навсегда замирала на последней
     * виденной цифре: sold = target - current давал ноль, и прибыль по коту
     * оказывалась заниженной (на a020 так прятались три позиции).
     *
     * Цену не трогаем — другой цены, чем последняя известная, у нас нет.
     * Если магазин отдал "Магазин не найден" (кот убран), витрина не видна
     * целиком, обнулять не по чему — такие строки остаются как есть.
     */
    const sellSeen = !(sell.meta || {}).shopNotFound;
    const buySeen = !(buy.meta || {}).shopNotFound;

    for (const catItem of cat.items) {
        const product = findProductById(catItem.productId);

        if (!product) {
            continue;
        }

        const externalId = product.externalId;

        if (sellSeen && !sellMap.has(externalId)) {
            if (catItem.sellCurrent !== 0) {
                catItem.sellCurrent = 0;
                catItem.lastSellUpdate = now();
            }
        }

        if (buySeen && !buyMap.has(externalId)) {
            if (catItem.buyCurrent !== 0) {
                catItem.buyCurrent = 0;
                catItem.lastBuyUpdate = now();
            }
        }
    }

    const meta = sell.meta || {};

    /*
     * Статус кота: comeback отдаёт "Магазин не найден", когда кот убран
     * (offline). Если хоть что-то стоит в витрине — кот online.
     */
    const offline =
        allItems.length === 0 &&
        Boolean((sell.meta || {}).shopNotFound || (buy.meta || {}).shopNotFound);

    cat.online = !offline;

    if (meta.catName) {
        cat.parsedName = meta.catName;
    }

    if (meta.shopName) {
        cat.shopName = meta.shopName;
    }

    if (meta.location) {
        cat.location = meta.location;
    }

    if (meta.x !== null) {
        cat.x = meta.x;
    }

    if (meta.y !== null) {
        cat.y = meta.y;
    }

    /*
     * Биржа голды со страницы кота —
     * сохраняем актуальный курс для настроек.
     */
    if (meta.goldBoard) {
        const buy = meta.goldBoard.buy || [];
        const sell = meta.goldBoard.sell || [];

        db.settings.goldBoard = {
            buy,
            sell,
            bestBuy: buy.length
                ? Math.min(...buy.map(row => row.price))
                : 0,
            bestSell: sell.length
                ? Math.min(...sell.map(row => row.price))
                : 0,
            server: cat.comebackCatId || '',
            catName: cat.name,
            updatedAt: now()
        };
    }

    cat.lastUpdatedAt = now();

    const after = makeSnapshot(cat);

    const changes = compareSnapshots(before, after);

    db.history.push({
        id: createId(),
        type: 'update',
        catId: cat.id,
        createdAt: now(),
        changes,
        snapshot: after
    });

    if (db.history.length > HISTORY_LIMIT) {
        db.history.splice(
            0,
            db.history.length - HISTORY_LIMIT
        );
    }

    save();

    return {
        sellItems: sell.items.length,
        buyItems: buy.items.length,
        changes: changes.length,
        offline
    };
}

module.exports = {
    updateCat
};
