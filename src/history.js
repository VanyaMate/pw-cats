'use strict';

const { db } = require('./db');
const { toNumber } = require('./util');

function makeSnapshot(cat) {
    return cat.items.map(item => ({
        productId: item.productId,
        sellCurrent: toNumber(item.sellCurrent),
        buyCurrent: toNumber(item.buyCurrent),
        sellPrice: toNumber(item.sellPrice),
        buyPrice: toNumber(item.buyPrice)
    }));
}

function compareSnapshots(before, after) {
    const beforeMap = new Map(
        before.map(item => [item.productId, item])
    );

    const changes = [];

    for (const current of after) {
        const previous = beforeMap.get(current.productId);

        if (!previous) {
            changes.push({
                productId: current.productId,
                type: 'added'
            });

            continue;
        }

        const fields = [
            'sellCurrent',
            'buyCurrent',
            'sellPrice',
            'buyPrice'
        ];

        for (const field of fields) {
            if (previous[field] !== current[field]) {
                changes.push({
                    productId: current.productId,
                    field,
                    from: previous[field],
                    to: current[field]
                });
            }
        }
    }

    return changes;
}

/*
 * Ряд по дням для графика и срезов "неделя / месяц".
 *
 * db.history хранит снапшот витрины после каждого обновления кота, а
 * цели ("должно быть") между обновлениями не меняются — значит минус в
 * количестве на продаже = товар продали, минус на скупке = кот выкупил у
 * игрока. Прибыль дня = выручка минус закупки.
 */
function localDayKey(value) {
    const date = new Date(value);

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return date.getFullYear() + '-' + month + '-' + day;
}

function emptyDay(key) {
    return {
        date: key,
        sold: 0,
        bought: 0,
        revenue: 0,
        purchaseCost: 0,
        profit: 0
    };
}

function dailySeries(catId, days) {
    const count = Math.max(
        1,
        Math.min(120, Math.floor(toNumber(days, 30)) || 30)
    );

    const updates = db.history
        .filter(
            entry =>
                entry.catId === catId &&
                entry.type === 'update' &&
                Array.isArray(entry.snapshot)
        )
        .sort(
            (a, b) =>
                new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime()
        );

    const previousByProduct = new Map();
    const buckets = new Map();

    for (const entry of updates) {
        const key = localDayKey(entry.createdAt);

        let bucket = buckets.get(key);

        if (!bucket) {
            bucket = emptyDay(key);
            buckets.set(key, bucket);
        }

        for (const current of entry.snapshot) {
            const before = previousByProduct.get(current.productId);

            previousByProduct.set(current.productId, current);

            if (!before) {
                continue;
            }

            const sold = Math.max(
                0,
                toNumber(before.sellCurrent) -
                    toNumber(current.sellCurrent)
            );

            const bought = Math.max(
                0,
                toNumber(before.buyCurrent) - toNumber(current.buyCurrent)
            );

            const sellPrice =
                toNumber(current.sellPrice) || toNumber(before.sellPrice);

            const buyPrice =
                toNumber(current.buyPrice) || toNumber(before.buyPrice);

            bucket.sold += sold;
            bucket.bought += bought;
            bucket.revenue += sold * sellPrice;
            bucket.purchaseCost += bought * buyPrice;
        }
    }

    for (const bucket of buckets.values()) {
        bucket.profit = bucket.revenue - bucket.purchaseCost;
    }

    // Дни идут подряд от сегодняшнего, пустые заполняются нулями.
    const series = [];

    const today = new Date();

    for (let offset = count - 1; offset >= 0; offset--) {
        const date = new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate() - offset
        );

        const key = localDayKey(date);

        series.push(buckets.get(key) || emptyDay(key));
    }

    return series;
}

function sumDays(days) {
    const totals = {
        sold: 0,
        bought: 0,
        revenue: 0,
        purchaseCost: 0,
        profit: 0
    };

    for (const day of days) {
        totals.sold += day.sold;
        totals.bought += day.bought;
        totals.revenue += day.revenue;
        totals.purchaseCost += day.purchaseCost;
        totals.profit += day.profit;
    }

    return totals;
}

module.exports = {
    makeSnapshot,
    compareSnapshots,
    dailySeries,
    sumDays
};
