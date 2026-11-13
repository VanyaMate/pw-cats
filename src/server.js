'use strict';

const path = require('path');
const express = require('express');

const { PORT, PROXY_URL } = require('./config');
const { db, save } = require('./db');
const {
    createId,
    now,
    toNumber,
    toInt,
    sleep,
    normalizeUrl,
    cleanText,
    getCatIdFromUrl,
    getQueryParameter
} = require('./util');
const { findProductById, findProduct, getOrCreateProduct, shopUnitPrice } = require('./products');
const {
    getOrCreateCatItem,
    calculateItem,
    calculateCatStats,
    calculateCatStatsDetailed,
    carryTargets,
    sumStats
} = require('./calculate');
const { makeSnapshot, dailySeries, sumDays } = require('./history');
const { updateCat } = require('./update');
const { updateProductMarket } = require('./market');
const { applyMarketPricesToAll } = require('./prices');
const {
    makeJob,
    enqueue,
    enqueueIfAbsent,
    cancel: cancelQueue,
    pendingCount,
    status: queueStatus
} = require('./queue');

const app = express();

app.use(express.json({ limit: '2mb' }));

app.use(
    express.static(path.join(__dirname, '..', 'public'))
);

/*
 * Фабрики заданий для очереди обновлений.
 * Все обращения к comeback.pw идут через очередь по очереди.
 */
function catUpdateJob(catId, name) {
    return makeJob('cat', catId, name || 'кот', async job => {
        const cat = db.cats.find(c => c.id === job.refId);

        if (!cat) {
            return { error: 'Кот не найден' };
        }

        job.name = cat.name;

        cat.updating = true;
        cat.updateError = null;
        save();

        try {
            const result = await updateCat(cat);

            cat.updating = false;
            save();

            return { ok: true, result };
        } catch (error) {
            cat.updating = false;
            cat.updateError = error.message;
            save();

            return { error: error.message };
        }
    });
}

function marketUpdateJob(productId, name) {
    return makeJob(
        'market',
        productId,
        name || 'товар',
        async job => {
            const product = db.products.find(
                p => p.id === job.refId
            );

            if (!product) {
                return { error: 'Товар не найден' };
            }

            job.name = product.name;

            return await updateProductMarket(product);
        }
    );
}

/*
 * Обновить рыночные цены всех товаров, которые стоят в этом коте.
 * Товары берём из строк кота, порядок — как в таблице.
 */
function catProductPriceJob(catId, name) {
    return makeJob('catPrices', catId, name || 'кот', async job => {
        const cat = db.cats.find(c => c.id === job.refId);

        if (!cat) {
            return { error: 'Кот не найден' };
        }

        job.name = cat.name;

        let queued = 0;

        for (const item of cat.items) {
            const product = findProductById(item.productId);

            if (!product) {
                continue;
            }

            // В начало не просим: пусть идут за текущими задачами.
            enqueue(marketUpdateJob(product.id, product.name));

            queued++;
        }

        return { ok: true, queued };
    });
}

function buildCatResponse(cat) {
    return {
        ...cat,

        items: cat.items
            .map(item => {
                const product = findProductById(item.productId);

                if (!product) {
                    return null;
                }

                const calculated = calculateItem(item, product, cat);

                return {
                    ...item,

                    productId: product.id,
                    externalId: product.externalId,
                    name: product.name,
                    image: product.image,
                    configured: product.configured,

                    ...calculated
                };
            })
            .filter(Boolean)
    };
}

function findCat(id) {
    return db.cats.find(cat => cat.id === id);
}

/*
 * "front" в запросе — поставить задачу в начало очереди, чтобы она
 * выполнилась сразу после текущей.
 */
function frontOf(req) {
    return { front: Boolean(req.body && req.body.front) };
}

/*
|--------------------------------------------------------------------------
| STATE / SETTINGS
|--------------------------------------------------------------------------
*/

/*
 * Товар для фронта. goldUnitPrice — производная цена одной штуки в
 * золоте, если выкупать её за голду: курс голды × цена партии в голде
 * / количество в партии. Считается products.shopUnitPrice, чтобы
 * формула совпадала с расчётами рекомендованных цен.
 */
function productResponse(product) {
    return {
        ...product,
        goldUnitPrice: shopUnitPrice(product)
    };
}

app.get('/api/state', (req, res) => {
    res.json({
        settings: db.settings,
        products: db.products.map(productResponse),
        cats: db.cats.map(buildCatResponse)
    });
});

app.put('/api/settings', (req, res) => {
    db.settings.updateIntervalMs = Math.max(
        1000,
        toInt(req.body.updateIntervalMs, 7000)
    );

    db.settings.goldPrice = Math.max(
        0,
        toNumber(req.body.goldPrice)
    );

    if (req.body.marketServer !== undefined) {
        db.settings.marketServer =
            cleanText(req.body.marketServer) || '146';
    }

    if (req.body.priceDeviationThreshold !== undefined) {
        db.settings.priceDeviationThreshold = Math.min(
            5,
            Math.max(0.01, toNumber(req.body.priceDeviationThreshold, 0.3))
        );
    }

    save();

    res.json(db.settings);
});

/*
|--------------------------------------------------------------------------
| CATS
|--------------------------------------------------------------------------
*/

app.post('/api/cats', (req, res) => {
    const url = normalizeUrl(req.body.url);

    if (!url) {
        return res
            .status(400)
            .json({ error: 'Не указана ссылка comeback.pw' });
    }

    const cat = {
        id: createId(),

        name:
            cleanText(req.body.name) ||
            `Кот ${db.cats.length + 1}`,

        url,

        comebackCatId: getCatIdFromUrl(url),
        shopId: getQueryParameter(url, 'shop'),

        parsedName: '',
        shopName: '',
        location: '',
        x: null,
        y: null,

        items: [],

        updating: false,
        updateError: null,
        online: null,

        createdAt: now(),
        lastUpdatedAt: null
    };

    db.cats.push(cat);

    save();

    res.json(buildCatResponse(cat));
});

app.put('/api/cats/:id', (req, res) => {
    const cat = findCat(req.params.id);

    if (!cat) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    if (req.body.name !== undefined) {
        cat.name = cleanText(req.body.name);
    }

    if (req.body.url !== undefined) {
        cat.url = normalizeUrl(req.body.url);
        cat.comebackCatId = getCatIdFromUrl(cat.url);
        cat.shopId = getQueryParameter(cat.url, 'shop');
    }

    save();

    res.json(buildCatResponse(cat));
});

app.delete('/api/cats/:id', (req, res) => {
    const index = db.cats.findIndex(
        cat => cat.id === req.params.id
    );

    if (index === -1) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    db.cats.splice(index, 1);

    save();

    res.json({ ok: true });
});

/*
 * Настройка источника докупки у позиции кота.
 *
 *   null или { type: 'auto' }   — самый дешёвый источник (как считалось раньше)
 *   { type: 'cat', catId }      — скуп конкретного кота, в том числе своего
 *   { type: 'market' }          — быстрая покупка по цене продажи на рынке
 *   { type: 'gold' }            — магазин за голду
 *   { type: 'manual', price }   — цена вручную, price может быть пока 0
 *
 * Возвращает { source } либо { error }: кота с таким id быть не может, а
 * незаполненная ручная цена остаётся настройкой "вручную" — расчёт в этот
 * момент сам откатится на авто.
 */
function normalizeBuySource(value) {
    if (value === null || value === undefined) {
        return { source: null };
    }

    if (typeof value !== 'object') {
        return { error: 'Источник докупки должен быть объектом' };
    }

    const type = cleanText(value.type);

    if (!type || type === 'auto') {
        return { source: null };
    }

    if (type === 'cat') {
        const catId = cleanText(value.catId);

        if (!findCat(catId)) {
            return { error: 'Кот-источник не найден' };
        }

        return { source: { type: 'cat', catId } };
    }

    if (type === 'gold') {
        return { source: { type: 'gold' } };
    }

    if (type === 'market') {
        return { source: { type: 'market' } };
    }

    if (type === 'manual') {
        return {
            source: {
                type: 'manual',
                price: Math.max(0, toNumber(value.price))
            }
        };
    }

    return { error: 'Неизвестный тип источника докупки' };
}

/*
|--------------------------------------------------------------------------
| CAT ITEMS
|--------------------------------------------------------------------------
*/

app.put('/api/cats/:catId/items/:productId', (req, res) => {
    const cat = findCat(req.params.catId);

    if (!cat) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    const product = findProductById(req.params.productId);

    if (!product) {
        return res.status(404).json({ error: 'Товар не найден' });
    }

    const item = getOrCreateCatItem(cat, product);

    if (req.body.sellTarget !== undefined) {
        item.sellTarget = Math.max(0, toInt(req.body.sellTarget));
    }

    if (req.body.buyTarget !== undefined) {
        item.buyTarget = Math.max(0, toInt(req.body.buyTarget));
    }

    if (req.body.buySource !== undefined) {
        const normalized = normalizeBuySource(req.body.buySource);

        if (normalized.error) {
            return res.status(400).json({ error: normalized.error });
        }

        item.buySource = normalized.source;
    }

    save();

    res.json(buildCatResponse(cat));
});

/*
|--------------------------------------------------------------------------
| PRODUCTS
|--------------------------------------------------------------------------
*/

app.put('/api/products/:id', (req, res) => {
    const product = findProductById(req.params.id);

    if (!product) {
        return res.status(404).json({ error: 'Товар не найден' });
    }

    const priceFields = [
        'buyPrice',
        'sellPrice',
        'goldShopPrice',
        'goldShopAmount',
        'goldPrice'
    ];

    for (const field of priceFields) {
        if (req.body[field] !== undefined) {
            product[field] = Math.max(0, toNumber(req.body[field]));
        }
    }

    product.configured =
        product.buyPrice > 0 ||
        product.sellPrice > 0 ||
        product.goldShopPrice > 0 ||
        product.goldPrice > 0;

    product.updatedAt = now();

    save();

    res.json(productResponse(product));
});

/*
|--------------------------------------------------------------------------
| PRODUCTS MARKET (рыночная цена, продавцы, ручное добавление по id)
|--------------------------------------------------------------------------
*/

/*
 * Добавить товар вручную по внешнему id. Создаёт заглушку и ставит
 * в очередь на обновление рынка — после чего товар подгружается.
 */
app.post('/api/products', (req, res) => {
    const externalId = cleanText(req.body.externalId);

    if (!/^\d+$/.test(externalId)) {
        return res
            .status(400)
            .json({ error: 'Укажите числовой id товара' });
    }

    const existing = findProduct(externalId);

    if (existing) {
        enqueue(marketUpdateJob(existing.id, existing.name));

        return res.json({ ok: true, existed: true, product: existing });
    }

    const product = getOrCreateProduct({
        externalId,
        name: 'Товар ' + externalId,
        image: '',
        description: ''
    });

    save();

    enqueue(marketUpdateJob(product.id, product.name));

    res.json({ ok: true, existed: false, product });
});

app.post('/api/products/:id/update-price', (req, res) => {
    const product = findProductById(req.params.id);

    if (!product) {
        return res.status(404).json({ error: 'Товар не найден' });
    }

    enqueue(marketUpdateJob(product.id, product.name), frontOf(req));

    res.json({ ok: true, queued: true });
});

app.post('/api/products/update-all-prices', (req, res) => {
    let count = 0;

    for (const product of db.products) {
        enqueue(marketUpdateJob(product.id, product.name));
        count++;
    }

    res.json({ ok: true, queued: count });
});

/*
 * Обновить рынок всех товаров и сразу перенести рыночные цены в ручные
 * — и скупа, и продажи.
 *
 * Перенос встаёт в очередь последним заданием, поэтому считает по уже
 * свежим ценам, а не по тем, что лежали до нажатия.
 */
app.post('/api/products/update-all-prices-carry', (req, res) => {
    const products = [...db.products];

    for (const product of products) {
        enqueue(marketUpdateJob(product.id, product.name));
    }

    enqueue(makeJob(
        'applyPricesAll',
        'all',
        'перенос цен',
        () => {
            /*
             * Перенос обязан идти строго последним: задания рынка
             * возвращаются в очередь на повтор, когда цена кажется
             * подозрительной, и тогда перенос считал бы по устаревшим
             * цифрам. Пока в очереди есть хоть одна задача — уступаем
             * ей место и встаём в хвост.
             */
            if (pendingCount() > 0) {
                return { requeue: true };
            }

            return applyMarketPricesToAll();
        },
        { maxRetries: 500 }
    ));

    res.json({ ok: true, queued: products.length + 1 });
});

/*
 * Перенести рыночную цену в ручную (sell или buy).
 */
app.put('/api/products/:id/apply-market', (req, res) => {
    const product = findProductById(req.params.id);

    if (!product) {
        return res.status(404).json({ error: 'Товар не найден' });
    }

    const market = product.market || {};

    const side = req.body.side === 'buy' ? 'buy' : 'sell';

    const price =
        side === 'buy'
            ? toNumber(market.buyPrice)
            : toNumber(market.sellPrice);

    if (price <= 0) {
        return res
            .status(400)
            .json({ error: 'Нет рыночной цены для переноса' });
    }

    if (side === 'buy') {
        product.buyPrice = price;
    } else {
        product.sellPrice = price;
    }

    product.configured =
        product.buyPrice > 0 ||
        product.sellPrice > 0 ||
        product.goldShopPrice > 0 ||
        product.goldPrice > 0;

    product.updatedAt = now();

    save();

    res.json(productResponse(product));
});

/*
|--------------------------------------------------------------------------
| UPDATE (через очередь, по очереди, без параллельных запросов)
|--------------------------------------------------------------------------
*/

app.post('/api/cats/:id/update', (req, res) => {
    const cat = findCat(req.params.id);

    if (!cat) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    enqueue(catUpdateJob(cat.id, cat.name), frontOf(req));

    res.json({ ok: true, queued: true });
});

app.post('/api/cats/update-all', (req, res) => {
    const options = frontOf(req);

    // В начало очереди встаёт последняя поставленная задача,
    // поэтому список идём задом наперёд — порядок останется привычным.
    const cats = options.front ? [...db.cats].reverse() : db.cats;

    for (const cat of cats) {
        enqueue(catUpdateJob(cat.id, cat.name), options);
    }

    res.json({ ok: true, queued: cats.length });
});

/*
 * Обновить рыночные цены всех товаров этого кота. Сама задача встаёт в
 * очередь как обычно, а уже из неё расставляет задания рынка по товарам
 * — так интервал между запросами к comeback не ломается.
 */
app.post('/api/cats/:id/update-product-prices', (req, res) => {
    const cat = findCat(req.params.id);

    if (!cat) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    if ((cat.items || []).length === 0) {
        return res.status(400).json({ error: 'У кота нет товаров' });
    }

    enqueue(catProductPriceJob(cat.id, cat.name), frontOf(req));

    res.json({ ok: true, queued: cat.items.length });
});

app.get('/api/queue', (req, res) => {
    res.json(queueStatus());
});

/*
 * Отменить очередь: всё, что ещё не началось, убирается. Текущая задача
 * доходит до конца (запрос к comeback уже ушёл), но в повтор не встанет.
 */
app.delete('/api/queue', (req, res) => {
    res.json({ ok: true, ...cancelQueue() });
});

/*
|--------------------------------------------------------------------------
| CARRY / RESET
|--------------------------------------------------------------------------
*/

/*
 * Перенос текущих количеств в "должно быть"
 * без записи в статистику.
 */
app.post('/api/cats/:id/carry', (req, res) => {
    const cat = findCat(req.params.id);

    if (!cat) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    carryTargets(cat);

    save();

    res.json(buildCatResponse(cat));
});

/*
 * Перенос сразу у всех котов — кнопка на верхней панели.
 */
app.post('/api/cats/carry-all', (req, res) => {
    for (const cat of db.cats) {
        carryTargets(cat);
    }

    save();

    res.json({ ok: true, cats: db.cats.length });
});

/*
 * Сброс: закрывает текущий период (дописывает его в статистику),
 * затем переносит текущие количества в "должно быть".
 */
app.post('/api/cats/:id/reset', (req, res) => {
    const cat = findCat(req.params.id);

    if (!cat) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    const { stats: period, items } = calculateCatStatsDetailed(cat);

    db.stats.push({
        id: createId(),
        type: 'period',
        catId: cat.id,
        createdAt: now(),
        ...period,
        items
    });

    db.history.push({
        id: createId(),
        type: 'reset',
        catId: cat.id,
        createdAt: now(),
        snapshot: makeSnapshot(cat)
    });

    carryTargets(cat);

    save();

    res.json({ ok: true, period, items });
});

app.post('/api/reset-all', (req, res) => {
    const periods = [];

    for (const cat of db.cats) {
        const { stats: period, items } =
            calculateCatStatsDetailed(cat);

        db.stats.push({
            id: createId(),
            type: 'period',
            catId: cat.id,
            createdAt: now(),
            ...period,
            items
        });

        periods.push({ catId: cat.id, period, items });

        carryTargets(cat);
    }

    db.history.push({
        id: createId(),
        type: 'reset-all',
        createdAt: now(),
        cats: db.cats.map(cat => ({
            catId: cat.id,
            snapshot: makeSnapshot(cat)
        }))
    });

    save();

    res.json({ ok: true, periods });
});

/*
|--------------------------------------------------------------------------
| STATISTICS / HISTORY
|--------------------------------------------------------------------------
*/

app.get('/api/stats/cat/:id', (req, res) => {
    const cat = findCat(req.params.id);

    if (!cat) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    const { stats: current, items: currentItems } =
        calculateCatStatsDetailed(cat);

    const periods = db.stats
        .filter(entry => entry.catId === cat.id)
        .slice(-50)
        .reverse();

    const cumulative = sumStats([current, ...periods]);

    res.json({ current, currentItems, cumulative, periods });
});

/*
 * Ряд по дням для графика на странице кота: история обновлений
 * пересчитывается в продажи/закупки по дням.
 *
 * Закрытые периоды (сбросы) в ряд не попадают — они показаны отдельной
 * строкой, чтобы одна и та же активность не считалась дважды.
 */
app.get('/api/stats/cat/:id/daily', (req, res) => {
    const cat = findCat(req.params.id);

    if (!cat) {
        return res.status(404).json({ error: 'Кот не найден' });
    }

    const days = dailySeries(
        cat.id,
        Math.max(1, Math.min(120, toInt(req.query.days, 31)))
    );

    const closed = db.stats.filter(entry => entry.catId === cat.id);

    res.json({
        days,
        totals: sumDays(days),
        closed: {
            periods: closed.length,
            ...sumStats(closed)
        }
    });
});

app.get('/api/stats/all', (req, res) => {
    const cats = db.cats.map(cat => {
        const current = calculateCatStats(cat);

        const periods = db.stats.filter(
            entry => entry.catId === cat.id
        );

        const cumulative = sumStats([current, ...periods]);

        return {
            catId: cat.id,
            name: cat.name,
            current,
            cumulative
        };
    });

    const total = sumStats(cats.map(entry => entry.current));

    const cumulativeTotal = sumStats(
        cats.map(entry => entry.cumulative)
    );

    res.json({ total, cumulativeTotal, cats });
});

app.get('/api/history/:catId', (req, res) => {
    const limit = Math.min(
        1000,
        Math.max(1, toInt(req.query.limit, 100))
    );

    res.json(
        db.history
            .filter(entry => entry.catId === req.params.catId)
            .slice(-limit)
            .reverse()
    );
});

app.listen(PORT, () => {
    console.log(`PW Cats запущен на http://localhost:${PORT}`);
    console.log(`Прокси: ${PROXY_URL}`);
});
