'use strict';

const cheerio = require('cheerio');
const { http } = require('./config');
const {
    cleanText,
    parseCount,
    parsePrice,
    absoluteUrl,
    buildShopUrl
} = require('./util');

/*
 * Разбор одной страницы магазина.
 *
 * Товары лежат в витрине кота:
 *   .container_sell img.item_shop  — продажа
 *   .container_buy  img.item_shop  — скупка
 *
 * <img class="item_shop" data-id data-name data-count data-price data-desc src>
 *
 * side = 'sell' | 'buy' — какой контейнер читать.
 */
function parseShopPage(html, pageUrl, side) {
    const $ = cheerio.load(html);

    const items = [];

    const container =
        side === 'buy' ? '.container_buy' : '.container_sell';

    $(container + ' img.item_shop[data-id]').each((_, element) => {
        const node = $(element);

        const externalId = cleanText(node.attr('data-id'));

        if (!externalId) {
            return;
        }

        items.push({
            externalId,

            name:
                cleanText(node.attr('data-name')) ||
                `Товар ${externalId}`,

            count: parseCount(node.attr('data-count')),

            price: parsePrice(node.attr('data-price')),

            image: absoluteUrl(node.attr('src') || '', pageUrl),

            description: node.attr('data-desc') || ''
        });
    });

    const unique = new Map();

    for (const item of items) {
        unique.set(item.externalId, item);
    }

    const title = cleanText($('title').first().text());

    /*
     * Offline-кот: вместо витрины страница отдаёт
     * <p class="error-message">Магазин не найден</p>
     */
    const shopNotFound = /магазин не найден/i.test(
        cleanText($('#content').text())
    );

    const meta = {
        title,
        shopNotFound,
        catName: '',
        shopName: '',
        location: '',
        x: null,
        y: null
    };

    /*
     * Витрина кота:
     * <div class="shop_charactername">
     *   <p class="nameshop">
     *     <span class="footer_title_shop">Магазин</span>
     *     960.000
     *     <span class="coordinate_shop">552 670 <b>Мир ГДС</b></span>
     *   </p>
     * </div>
     *
     * "Магазин" — это лейбл, а настоящее имя ("960.000")
     * лежит текстом между лейблом и координатами.
     */

    const nameshop = $('.nameshop').first();

    if (nameshop.length) {
        const nameClone = nameshop.clone();

        nameClone.find('.footer_title_shop').remove();
        nameClone.find('.coordinate_shop').remove();

        meta.shopName = cleanText(nameClone.text());
    }

    if (!meta.shopName) {
        meta.shopName = cleanText(
            $('.footer_title_shop').first().text()
        );
    }

    const coordElement = $('.coordinate_shop').first();

    if (coordElement.length) {
        const coordText = cleanText(coordElement.text());

        const numbers = coordText.match(/-?\d+(?:[.,]\d+)?/g);

        if (numbers && numbers.length >= 2) {
            meta.x = Number(numbers[0].replace(',', '.'));
            meta.y = Number(numbers[1].replace(',', '.'));
        }

        const locationElement = coordElement.find('b').first();

        meta.location = locationElement.length
            ? cleanText(locationElement.text())
            : cleanText(
                coordText.replace(/^-?\d+(?:[.,]\d+)?\s*-?\d+(?:[.,]\d+)?\s*/, '')
            );
    }

    /*
     * Биржа голды:
     * <div class="server__gold">
     *   <div class="gold_buy"><p class="buy_price">865000<span>50</span></p>...</div>
     *   <div class="gold_sell"><p class="sell_price">909000<span>70</span></p>...</div>
     * </div>
     */
    const goldBoard = { buy: [], sell: [] };

    const readGoldRows = (selector, list) => {
        $(selector).each((_, element) => {
            const node = $(element);

            const amount = cleanText(node.find('span').first().text());

            const priceText = cleanText(
                node.clone().find('span').remove().end().text()
            );

            const price = parsePrice(priceText);

            if (price > 0) {
                list.push({ price, amount: parseCount(amount) });
            }
        });
    };

    readGoldRows(
        '.server__gold .gold_buy .buy_price',
        goldBoard.buy
    );

    readGoldRows(
        '.server__gold .gold_sell .sell_price',
        goldBoard.sell
    );

    meta.goldBoard = goldBoard;

    return {
        items: Array.from(unique.values()),
        meta
    };
}

async function fetchHtml(url) {
    const response = await http.get(url);

    return String(response.data || '');
}

/*
 * Разбор страницы рынка товара (поиск по item_id).
 *
 * Каждый продавец/покупатель — блок .cats__item:
 *   - без data-type      -> лавка/кот (ник, магазин, координаты)
 *   - data-type="auction"-> комиссионка/аукцион ("Комиссионный магазин",
 *                            в data-name ника есть "Осталось HH:MM:SS")
 *
 *   .charactername_search      — ник (текст) + data-name (ID/магазин/осталось)
 *   .icon_search               — data-name (имя), data-id (externalId), src
 *   .item-count.small-find     — количество
 *   .sell_search / .buy_search — цена продажи / покупки
 *   .coordinate_search         — "X Y <b>Локация</b>" или "<span>Комиссионный магазин</span>"
 */
function parseMarketPage(html, pageUrl) {
    const $ = cheerio.load(html);

    const offers = [];

    $('.cats__item').each((_, element) => {
        const node = $(element);

        const icon = node.find('.icon_search').first();

        const externalId =
            cleanText(icon.attr('data-id')) ||
            cleanText(node.attr('data-item-id'));

        const name =
            cleanText(icon.attr('data-name')) ||
            cleanText(node.find('.itemname_search').first().text());

        const source =
            node.attr('data-type') === 'auction' ? 'auction' : 'shop';

        const charNode = node.find('.charactername_search').first();

        const nick = cleanText(charNode.text());

        /*
         * data-name ника содержит HTML:
         *   лавка:    ...<p class='info_item_value'>НАЗВАНИЕ</p>...
         *   аукцион:  ...Осталось 28:13:53
         */
        let shopName = '';
        let timeLeft = '';

        const charAttr = charNode.attr('data-name') || '';

        if (charAttr) {
            const $inner = cheerio.load(charAttr);

            shopName = cleanText(
                $inner('.info_item_value').first().text()
            );

            const timeMatch = cleanText($inner.text()).match(
                /Осталось\s*([\d:]+)/i
            );

            if (timeMatch) {
                timeLeft = timeMatch[1];
            }
        }

        const sellPrice =
            parsePrice(node.find('.sell_search').first().text()) ||
            parsePrice(icon.attr('data-price'));

        const buyPrice = parsePrice(
            node.find('.buy_search').first().text()
        );

        const count =
            parseCount(node.find('.item-count').first().text()) ||
            parseCount(icon.attr('data-count'));

        const coordNode = node.find('.coordinate_search').first();

        const coordText = cleanText(coordNode.text());

        let location = '';
        let x = null;
        let y = null;

        const boldLocation = coordNode.find('b').first();

        if (boldLocation.length) {
            location = cleanText(boldLocation.text());

            const numbers = coordText.match(/-?\d+(?:[.,]\d+)?/g);

            if (numbers && numbers.length >= 2) {
                x = Number(numbers[0].replace(',', '.'));
                y = Number(numbers[1].replace(',', '.'));
            }
        } else {
            location = coordText;
        }

        offers.push({
            id: cleanText(node.attr('data-id')),
            externalId,
            name,
            source,
            nick,
            shopName,
            timeLeft,
            sellPrice,
            buyPrice,
            count,
            location,
            x,
            y,
            image: absoluteUrl(icon.attr('src') || '', pageUrl)
        });
    });

    return offers;
}

/*
 * Обход всех страниц магазина (sell или buy).
 */
async function fetchShop(baseUrl, show) {
    const allItems = new Map();

    let meta = {};

    for (let page = 1; page <= 50; page++) {
        const url = buildShopUrl(baseUrl, show, page);

        const html = await fetchHtml(url);

        const parsed = parseShopPage(html, url, show);

        if (page === 1) {
            meta = parsed.meta;
        }

        if (parsed.items.length === 0) {
            break;
        }

        let newItems = 0;

        for (const item of parsed.items) {
            if (!allItems.has(item.externalId)) {
                newItems++;
            }

            allItems.set(item.externalId, item);
        }

        if (page > 1 && newItems === 0) {
            break;
        }

        if (parsed.items.length < 20) {
            break;
        }
    }

    return {
        items: Array.from(allItems.values()),
        meta
    };
}

module.exports = {
    parseShopPage,
    parseMarketPage,
    fetchHtml,
    fetchShop
};
