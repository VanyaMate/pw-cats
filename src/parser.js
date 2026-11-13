'use strict';

const cheerio = require('cheerio');
const { http, USER_AGENT } = require('./config');
const {
    cleanText,
    parseCount,
    parsePrice,
    absoluteUrl,
    buildShopUrl,
    sleep
} = require('./util');

/*
 * Цена в тултипе плитки: "Цена: 1,190,000 (79,730,000)".
 *
 * Первая цифра — цена за штуку так, как её показывает игра, вторая —
 * сумма за партию (первая умноженная на количество). data-price у той
 * же плитки отличается: на продаже он в 1.02-1.13 раза больше, в скупе
 * в 0.88-0.98 раза меньше, то есть содержит комиссию сайта. Игровую
 * цену берём из тултипа, data-price остаётся запасным вариантом на
 * случай, если описания у плитки нет.
 *
 * При quantity = 1 скобок в тултипе нет, там только цена за штуку.
 */
function parseTooltipPrice(descHtml) {
    const empty = { unit: 0, total: 0 };

    if (!descHtml) {
        return empty;
    }

    const text = cleanText(
        cheerio.load(descHtml)('.info_item_value').first().text()
    );

    const numbers = text.match(/[\d][\d.,\s]*/g) || [];

    return {
        unit: parsePrice(numbers[0]),
        total: parsePrice(numbers[1])
    };
}

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

        const tooltip = parseTooltipPrice(node.attr('data-desc'));

        items.push({
            externalId,

            name:
                cleanText(node.attr('data-name')) ||
                `Товар ${externalId}`,

            count: parseCount(node.attr('data-count')),

            price: tooltip.unit || parsePrice(node.attr('data-price')),

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

/*
 * Анти-бот comeback.pw (появился в ночь на 2026-11-03).
 *
 * Без cookies вместо витрины приходит заглушка: крутящийся GIF и скрипт,
 * который берёт код из cookie __js_p_, считает по нему __jhash_ тем же
 * циклом get_jhash, пишет __jua_ с юзер-агентом и перезагружает страницу.
 * Сервер проверяет хэш, ставит __hash_ и делает 302 на этот же адрес —
 * настоящая страница приходит только по этому редиректу.
 *
 * Набор cookie держим в памяти процесса: прогретая сессия отдаёт любую
 * страницу магазина и рынка одним запросом, повторный челлендж не нужен.
 */

const CHALLENGE_MARKERS = [
    'gorizontal-vertikal',
    'get_jhash'
];

const CHALLENGE_ATTEMPTS = 6;

const CHALLENGE_PAUSE_MS = 400;

const cookies = new Map();

function isChallengePage(html) {
    return CHALLENGE_MARKERS.every(marker => html.includes(marker));
}

function rememberCookies(setCookieHeaders) {
    for (const header of setCookieHeaders || []) {
        const pair = String(header).split(';')[0];

        const index = pair.indexOf('=');

        if (index > 0) {
            cookies.set(
                pair.slice(0, index).trim(),
                pair.slice(index + 1).trim()
            );
        }
    }
}

function cookieHeader() {
    return Array.from(cookies.entries())
        .map(([name, value]) => name + '=' + value)
        .join('; ');
}

/*
 * Копия get_jhash со страницы-заглушки. Все операнды положительны и не
 * превышают 2^31, поэтому побитовые операции в Node дают тот же
 * результат, что в браузере.
 */
function solveJhash(code) {
    let x = 123456789;
    let k = 0;

    for (let i = 0; i < 1677696; i++) {
        x = ((x + code) ^ (x + (x % 3) + (x % 17) + code) ^ i) % 16776960;

        if (x % 117 === 0) {
            k = (k + 1) % 1111;
        }
    }

    return k;
}

/*
 * fixedEncodeURIComponent из того же скрипта: encodeURIComponent не
 * трогает !'()* , а для cookie их экранируют вручную.
 */
function encodeUserAgent(value) {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        character =>
            '%' + character.charCodeAt(0).toString(16)
    );
}

/*
 * Пройти челлендж: посчитать __jhash_ по актуальному __js_p_.
 * Возвращает false, если сервер не выдал код — дальше дергаться бессмысленно.
 */
function solveChallenge() {
    const parts = cleanText(cookies.get('__js_p_') || '').split(',');

    const code = Number(parts[0]);

    if (!parts[0] || !Number.isInteger(code)) {
        return false;
    }

    cookies.set('__jhash_', String(solveJhash(code)));
    cookies.set('__jua_', encodeUserAgent(USER_AGENT));

    return true;
}

/*
 * Забрать HTML страницы, при необходимости пройдя анти-бот.
 * Бросает ошибку, если comeback так и не отдал страницу: молчаливый
 * пустой разбор раньше прятал проблему — коты оставались «онлайн» без
 * товаров.
 */
async function fetchHtml(url) {
    let target = url;

    for (let attempt = 1; attempt <= CHALLENGE_ATTEMPTS; attempt++) {
        const response = await http.get(target, {
            headers: {
                Cookie: cookieHeader(),
                Referer: url
            }
        });

        rememberCookies(response.headers['set-cookie']);

        const html = String(response.data || '');

        const redirected =
            response.status >= 300 && response.status < 400 &&
            response.headers.location;

        if (html && !isChallengePage(html)) {
            return html;
        }

        if (redirected) {
            target = absoluteUrl(response.headers.location, target);

            continue;
        }

        if (!solveChallenge()) {
            break;
        }

        await sleep(CHALLENGE_PAUSE_MS);
    }

    throw new Error(
        'comeback.pw не отдал страницу: не пройдена проверка ' +
        'анти-бота (' + url + ')'
    );
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

        /*
         * Цены плитки: .sell_search и .buy_search — цифры сайта с
         * комиссией, тултип — игровая цена. Сторона определяется по
         * тому, какой блок непустой: на странице продавцов заполнен
         * sell_search, на странице покупателей — buy_search.
         */
        const siteSellPrice = parsePrice(
            node.find('.sell_search').first().text()
        );

        const siteBuyPrice = parsePrice(
            node.find('.buy_search').first().text()
        );

        const tooltip = parseTooltipPrice(icon.attr('data-desc'));

        const sellPrice = siteSellPrice > 0
            ? (tooltip.unit ||
                siteSellPrice ||
                parsePrice(icon.attr('data-price')))
            : 0;

        const buyPrice = siteBuyPrice > 0
            ? (tooltip.unit || siteBuyPrice)
            : 0;

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
    parseTooltipPrice,
    fetchHtml,
    fetchShop,
    isChallengePage,
    solveJhash
};
