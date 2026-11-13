'use strict';

const { db } = require('./db');
const { toNumber } = require('./util');
const {
    findProductById,
    getRecommendedPrice,
    bestBuySource,
    shopUnitPrice,
    quickBuyPrice
} = require('./products');

function getCatItem(cat, productId) {
    return cat.items.find(item => item.productId === productId);
}

function getOrCreateCatItem(cat, product) {
    let item = getCatItem(cat, product.id);

    if (!item) {
        item = {
            productId: product.id,

            sellTarget: 0,
            buyTarget: 0,

            sellCurrent: 0,
            buyCurrent: 0,

            sellPrice: 0,
            buyPrice: 0,

            /*
             * Откуда докупаем этот товар именно в этом коте. null значит
             * "авто" — самый дешёвый источник, как считалось раньше.
             */
            buySource: null,

            lastSellUpdate: null,
            lastBuyUpdate: null
        };

        cat.items.push(item);
    }

    return item;
}

/*
 * Цена и место докупки для одной позиции кота.
 *
 * item.buySource может закреплять источник:
 *   { type: 'cat', catId }     — скуп конкретного кота (в том числе своего)
 *   { type: 'market' }         — быстрая покупка: цена продажи товара на рынке
 *   { type: 'gold' }           — магазин за голду
 *   { type: 'manual', price }  — цена вручную
 *   null или { type: 'auto' }  — самый дешёвый источник (bestBuySource)
 *
 * Если у закреплённого источника цены пока нет (скуп ещё не обновили,
 * курс голды пустой, цена вручную не введена), откатываемся на авто:
 * незаполненная настройка не должна обнулять расчёт.
 */
function resolveBuySource(product, cat, item) {
    /*
     * Откат на авто: подпись честно говорит, что закрепленное место
     * цены не дало, иначе в строке было бы непонятно, почему выбран
     * один кот, а считается по другому.
     */
    const auto = (note) => {
        const source = bestBuySource(product, cat ? cat.id : undefined);

        if (source && note) {
            source.label += ' · ' + note;
        }

        return source;
    };

    const source = item && item.buySource;

    if (!source || !source.type || source.type === 'auto') {
        return auto();
    }

    if (source.type === 'manual') {
        const price = toNumber(source.price);

        if (price > 0) {
            return {
                type: 'manual',
                label: 'Цена вручную',
                price,
                available: Infinity,
                catId: null
            };
        }

        return auto('цена не введена');
    }

    if (source.type === 'market') {
        const price = quickBuyPrice(product);

        if (price > 0) {
            return {
                type: 'market',
                label: 'Быстрая покупка (рынок)',
                price,
                available: Infinity,
                catId: null
            };
        }

        return auto('рынок молчит');
    }

    if (source.type === 'gold') {
        const price = shopUnitPrice(product);

        if (price > 0) {
            return {
                type: 'gold',
                label: 'Магазин (голда)',
                price,
                available: Infinity,
                catId: null
            };
        }

        return auto('голда не настроена');
    }

    if (source.type === 'cat') {
        const target = db.cats.find(other => other.id === source.catId);

        const targetItem = target
            ? getCatItem(target, product.id)
            : null;

        const price = toNumber(targetItem && targetItem.buyPrice);

        if (target && targetItem && price > 0) {
            const label = cat && target.id === cat.id
                ? 'Скуп (этот кот)'
                : 'Скуп: ' + (target.name || target.shopName || 'Кот');

            return {
                type: 'cat',
                label,
                price,
                available: toNumber(targetItem.buyCurrent),
                catId: target.id
            };
        }

        return auto(
            target
                ? 'у этого кота цены нет'
                : 'кот-источник удалён'
        );
    }

    return auto();
}

/*
 * Расчёт всех производных значений по одной позиции кота.
 */
function calculateItem(item, product, cat) {
    const sellTarget = toNumber(item.sellTarget);
    const sellCurrent = toNumber(item.sellCurrent);
    const buyTarget = toNumber(item.buyTarget);
    const buyCurrent = toNumber(item.buyCurrent);

    // продано = должно быть на продаже - текущее количество
    const sold = Math.max(0, sellTarget - sellCurrent);

    // куплено = должно быть на покупке - текущее количество
    const bought = Math.max(0, buyTarget - buyCurrent);

    // сколько нужно докупить, чтобы вернуть запас к sellTarget
    const needTotal = Math.max(0, sellTarget - sellCurrent);

    /*
     * Если товар стоит у кота и в скупе, и в продаже, купленное в
     * собственном скупе уходит в тот же запас, докупать его снаружи не
     * нужно. Без зачёта одна партия попадала и в bought, и в restockCost.
     */
    const coveredByBuy = Math.min(needTotal, bought);

    const needToBuy = needTotal - coveredByBuy;

    const sellPrice =
        toNumber(item.sellPrice) ||
        toNumber(product.lastSellPrice);

    const buyPrice =
        toNumber(item.buyPrice) ||
        toNumber(product.lastBuyPrice);

    const recommendedSell = getRecommendedPrice(product, 'sell');
    const recommendedBuy = getRecommendedPrice(product, 'buy');

    // Откуда докупаем: закрепленное место позиции или самый дешёвый источник.
    const source = resolveBuySource(product, cat, item);

    const bestBuyPrice = source ? source.price : recommendedBuy;

    const bestBuyLabel = source
        ? source.label
        : recommendedBuy > 0
            ? 'Скуп (последняя цена)'
            : 'нет источника';

    // Финансовая модель (в деньгах):
    //   выручка   = sold * фактическая цена продажи
    //   покупки   = bought * фактическая цена покупки
    //   докупка   = needToBuy * цена источника докупки
    //               (needToBuy уже за вычетом того, что кот купит сам)
    //   прибыль   = выручка - покупки - докупка
    const revenue = sold * sellPrice;
    const purchaseCost = bought * buyPrice;
    const restockCost = needToBuy * bestBuyPrice;

    const profit = revenue - purchaseCost - restockCost;

    const profitPerSale = sold > 0 ? profit / sold : 0;

    return {
        sellTarget,
        sellCurrent,
        sold,

        sellPrice,
        recommendedSell,

        buyTarget,
        buyCurrent,
        bought,

        buyPrice,
        recommendedBuy,

        needTotal,
        coveredByBuy,
        needToBuy,
        bestBuyPrice,
        bestBuyLabel,
        bestBuyType: source ? source.type : 'none',
        buySourceCatId: source ? source.catId : null,

        revenue,
        purchaseCost,
        restockCost,

        profit,
        profitPerSale
    };
}

function emptyStats() {
    return {
        sold: 0,
        bought: 0,
        revenue: 0,
        purchaseCost: 0,
        restockCost: 0,
        profit: 0
    };
}

function calculateCatStats(cat) {
    return calculateCatStatsDetailed(cat).stats;
}

/*
 * То же, что calculateCatStats, но дополнительно
 * возвращает разбивку по товарам: сколько каждого
 * товара было продано / куплено за период.
 */
function calculateCatStatsDetailed(cat) {
    const stats = emptyStats();

    const items = [];

    for (const item of cat.items) {
        const product = findProductById(item.productId);

        if (!product) {
            continue;
        }

        const calculated = calculateItem(item, product, cat);

        stats.sold += calculated.sold;
        stats.bought += calculated.bought;
        stats.revenue += calculated.revenue;
        stats.purchaseCost += calculated.purchaseCost;
        stats.restockCost += calculated.restockCost;
        stats.profit += calculated.profit;

        if (calculated.sold > 0 || calculated.bought > 0) {
            items.push({
                productId: product.id,
                name: product.name,
                sold: calculated.sold,
                bought: calculated.bought,
                revenue: calculated.revenue,
                profit: calculated.profit
            });
        }
    }

    return { stats, items };
}

function calculateAllStats() {
    const total = emptyStats();

    const cats = db.cats.map(cat => {
        const stats = calculateCatStats(cat);

        return {
            catId: cat.id,
            name: cat.name,
            ...stats
        };
    });

    for (const stats of cats) {
        total.sold += stats.sold;
        total.bought += stats.bought;
        total.revenue += stats.revenue;
        total.purchaseCost += stats.purchaseCost;
        total.restockCost += stats.restockCost;
        total.profit += stats.profit;
    }

    return { total, cats };
}

/*
 * Перенос всех текущих количеств в "должно быть".
 * Используется кнопкой "Перенос" и сбросом.
 */
function carryTargets(cat) {
    for (const item of cat.items) {
        item.sellTarget = toNumber(item.sellCurrent);
        item.buyTarget = toNumber(item.buyCurrent);
    }
}

/*
 * Сумма нескольких наборов статистики
 * (текущий период + закрытые периоды).
 */
function sumStats(list) {
    const result = emptyStats();

    for (const stats of list) {
        result.sold += toNumber(stats.sold);
        result.bought += toNumber(stats.bought);
        result.revenue += toNumber(stats.revenue);
        result.purchaseCost += toNumber(stats.purchaseCost);
        result.restockCost += toNumber(stats.restockCost);
        result.profit += toNumber(stats.profit);
    }

    return result;
}

module.exports = {
    getCatItem,
    getOrCreateCatItem,
    resolveBuySource,
    calculateItem,
    calculateCatStats,
    calculateCatStatsDetailed,
    calculateAllStats,
    emptyStats,
    carryTargets,
    sumStats
};
