'use strict';

const { db } = require('./db');
const { createId, now, toNumber } = require('./util');

function findProduct(externalId) {
    return db.products.find(
        product => String(product.externalId) === String(externalId)
    );
}

function findProductById(id) {
    return db.products.find(product => product.id === id);
}

/*
 * Неизвестный товар автоматически создаётся
 * и помечается как "не настроенный" (configured: false).
 */
function getOrCreateProduct(parsedItem) {
    let product = findProduct(parsedItem.externalId);

    if (!product) {
        product = {
            id: createId(),

            externalId: String(parsedItem.externalId),

            name: parsedItem.name,

            image: parsedItem.image,

            description: parsedItem.description,

            configured: false,

            buyPrice: 0,
            sellPrice: 0,

            goldShopPrice: 0,
            goldShopAmount: 0,
            goldPrice: 0,

            lastSellPrice: 0,
            lastBuyPrice: 0,

            market: null,

            createdAt: now(),
            updatedAt: now()
        };

        db.products.push(product);
    } else {
        if (parsedItem.name) {
            product.name = parsedItem.name;
        }

        if (parsedItem.image) {
            product.image = parsedItem.image;
        }

        if (parsedItem.description) {
            product.description = parsedItem.description;
        }

        product.updatedAt = now();
    }

    return product;
}

function effectiveGoldPrice(product) {
    return (
        toNumber(product.goldPrice) ||
        toNumber(db.settings.goldPrice)
    );
}

/*
 * Цена одной штуки товара в игровом золоте,
 * если покупать её в магазине за голду.
 *
 * goldShopPrice  — цена в голде за партию
 * goldShopAmount — сколько штук за эту цену (по умолчанию 1)
 * goldPrice      — курс голды (золото за 1 голду)
 *
 * Пример: 9 голды за 10 чешуек, курс 100000
 *   -> (9 / 10) * 100000 = 90000 за штуку.
 */
function shopUnitPrice(product) {
    const goldShopPrice = toNumber(product.goldShopPrice);
    const goldPrice = effectiveGoldPrice(product);

    if (goldShopPrice <= 0 || goldPrice <= 0) {
        return 0;
    }

    const amount = Math.max(1, toNumber(product.goldShopAmount) || 1);

    return (goldShopPrice / amount) * goldPrice;
}

/*
 * Рекомендованная цена.
 *
 * sell: ручная цена продажи -> цена из магазина за голду -> последняя из парсера
 * buy:  минимум из (ручная цена скупа, цена из магазина за голду)
 *       -> если ничего не задано, последняя из парсера
 */
function getRecommendedPrice(product, side) {
    const shop = shopUnitPrice(product);

    if (side === 'sell') {
        const manualSell = toNumber(product.sellPrice);

        if (manualSell > 0) {
            return manualSell;
        }

        if (shop > 0) {
            return shop;
        }

        return toNumber(product.lastSellPrice);
    }

    const manualBuy = toNumber(product.buyPrice);

    const candidates = [manualBuy, shop].filter(value => value > 0);

    if (candidates.length) {
        return Math.min(...candidates);
    }

    return toNumber(product.lastBuyPrice);
}

/*
 * Где дешевле всего докупить товар.
 *
 * Сравниваем места и берём самое дешёвое:
 *
 * 1. Магазин за голду: цена партии в голде / количество × курс голды.
 * 2. Скуп у котов — коты, которые покупают этот товар у игроков
 *    (включая самого кота, для которого считается позиция). Цена скупа —
 *    item.buyPrice, для текущего кота дополнительно fallback на
 *    lastBuyPrice из парсера.
 * 3. Скуп из базы товаров — ручная цена скупа product.buyPrice.
 *
 * При равных ценах остаётся уже выбранный вариант: голда проверяется
 * первой, и именно она выигрывает равенство (запас там не кончается).
 *
 * Возвращает { type, label, price, available, catId } или null.
 */
function bestBuySource(product, currentCatId) {
    let best = null;

    const shop = shopUnitPrice(product);

    if (shop > 0) {
        best = {
            type: 'gold',
            label: 'Магазин (голда)',
            price: shop,
            available: Infinity,
            catId: null
        };
    }

    for (const cat of db.cats) {
        const item = cat.items.find(
            catItem => catItem.productId === product.id
        );

        if (!item) {
            continue;
        }

        const isCurrentCat = cat.id === currentCatId;

        const price =
            toNumber(item.buyPrice) ||
            (isCurrentCat ? toNumber(product.lastBuyPrice) : 0);

        if (price <= 0) {
            continue;
        }

        const catLabel =
            cat.name || cat.parsedName || cat.shopName || 'Кот';

        const candidate = {
            type: 'cat',
            label: isCurrentCat
                ? 'Скуп (этот кот)'
                : 'Скуп: ' + catLabel,
            price,
            available: toNumber(item.buyCurrent),
            catId: cat.id
        };

        if (candidate.price < priceOf(best)) {
            best = candidate;
        }
    }

    const fromBase = toNumber(product.buyPrice);

    if (fromBase > 0 && fromBase < priceOf(best)) {
        best = {
            type: 'base',
            label: 'Скуп (из базы)',
            price: fromBase,
            available: 0,
            catId: null
        };
    }

    return best;
}

function priceOf(source) {
    return source ? source.price : Infinity;
}

module.exports = {
    findProduct,
    findProductById,
    getOrCreateProduct,
    getRecommendedPrice,
    bestBuySource,
    effectiveGoldPrice,
    shopUnitPrice
};
