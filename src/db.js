'use strict';

const fs = require('fs');
const { DB_FILE } = require('./config');

function createEmptyDatabase() {
    return {
        version: 1,

        settings: {
            updateIntervalMs: 7000,
            goldPrice: 0,
            marketServer: '146',
            priceDeviationThreshold: 0.3
        },

        products: [],

        cats: [],

        history: [],

        stats: []
    };
}

function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        return createEmptyDatabase();
    }

    try {
        const data = JSON.parse(
            fs.readFileSync(DB_FILE, 'utf8')
        );

        const empty = createEmptyDatabase();

        return {
            ...empty,
            ...data,

            settings: {
                ...empty.settings,
                ...(data.settings || {})
            },

            products: Array.isArray(data.products)
                ? data.products
                : [],

            cats: Array.isArray(data.cats)
                ? data.cats.map(withCatStatusFallback)
                : [],

            history: Array.isArray(data.history)
                ? data.history
                : [],

            stats: Array.isArray(data.stats)
                ? data.stats
                : []
        };
    } catch (error) {
        console.error('Ошибка чтения базы:', error.message);

        return createEmptyDatabase();
    }
}

/*
 * Статус online/offline появился позже, чем сами коты. Если в базе его
 * нет — восстанавливаем по последнему разбору: пустая витрина без
 * названия магазина означает, что страница отдала "Магазин не найден",
 * то есть кот offline. При следующем обновлении статус пересчитается
 * по настоящему признаку.
 */
function withCatStatusFallback(cat) {
    if (cat.online !== undefined) {
        return cat;
    }

    if ((cat.items || []).length > 0) {
        cat.online = true;
    } else if (cat.lastUpdatedAt && !cat.shopName) {
        cat.online = false;
    } else {
        cat.online = null;
    }

    return cat;
}

const db = loadDatabase();

function save() {
    const temporaryFile = DB_FILE + '.tmp';

    fs.writeFileSync(
        temporaryFile,
        JSON.stringify(db, null, 2),
        'utf8'
    );

    fs.renameSync(temporaryFile, DB_FILE);
}

module.exports = {
    db,
    save
};
