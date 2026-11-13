'use strict';

const state = {
    settings: { updateIntervalMs: 7000, goldPrice: 0 },
    products: [],
    cats: [],
    selectedCatId: null,
    updateAllRunning: false,
    queue: { running: false, length: 0, current: null, items: [], completed: [] },
    productsModalOpen: false,
    daily: {},
    dailyLoading: new Set(),
    dailyRange: 'month'
};

const productsUI = {
    query: '',
    focusId: null,
    expanded: new Set()
};

/*
|--------------------------------------------------------------------------
| API
|--------------------------------------------------------------------------
*/

async function api(method, url, body) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };

    if (body !== undefined) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    const text = await response.text();

    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
        throw new Error(data.error || ('HTTP ' + response.status));
    }

    return data;
}

async function loadState() {
    const data = await api('GET', '/api/state');

    state.settings = data.settings;
    state.products = data.products;
    state.cats = data.cats;

    if (
        state.selectedCatId &&
        !state.cats.some(cat => cat.id === state.selectedCatId)
    ) {
        state.selectedCatId = null;
    }
}

/*
|--------------------------------------------------------------------------
| FORMAT HELPERS
|--------------------------------------------------------------------------
*/

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function money(value) {
    const number = Number(value) || 0;

    return number.toLocaleString('ru-RU', {
        maximumFractionDigits: 0
    });
}

function quantity(value) {
    return (Number(value) || 0).toLocaleString('ru-RU');
}

function formatDate(value) {
    if (!value) {
        return '—';
    }

    try {
        return new Date(value).toLocaleString('ru-RU');
    } catch {
        return '—';
    }
}

function currentCat() {
    return state.cats.find(cat => cat.id === state.selectedCatId) || null;
}

/*
 * Цвет для значения прибыли:
 * положительная — зелёный, отрицательная — красный, ноль — серый.
 */
function profitColorClass(value) {
    const number = Number(value) || 0;

    if (number > 0) {
        return 'pos';
    }

    if (number < 0) {
        return 'neg';
    }

    return 'muted-val';
}

/*
 * Короткая запись больших чисел — для подписей на графике.
 */
function shortMoney(value) {
    const number = Number(value) || 0;
    const abs = Math.abs(number);

    if (abs >= 1000000) {
        return (number / 1000000).toFixed(1).replace('.', ',') + 'м';
    }

    if (abs >= 1000) {
        return Math.round(number / 1000) + 'к';
    }

    return String(Math.round(number));
}

function dayLabel(dateKey) {
    return dateKey.slice(8, 10) + '.' + dateKey.slice(5, 7);
}

/*
|--------------------------------------------------------------------------
| ПЕРЕРИСОВКА БЕЗ ПОТЕРИ ФОКУСА
|--------------------------------------------------------------------------
|
 * Во время работы очереди таблицы перерисовываются на каждом шаге,
 * поэтому запоминаем активное поле, позицию курсора и скролл, а после
 * render возвращаем их — иначе невозможно вводить количества «на лету».
 */
function focusSnapshot() {
    const active = document.activeElement;

    const attrs = [];

    if (active && active.matches && active.matches('input, select, textarea')) {
        if (active.id) attrs.push('[id=' + cssEscape(active.id) + ']');

        for (const name of ['data-p', 'data-product', 'data-f', 'data-field']) {
            const value = active.getAttribute(name);

            if (value) {
                attrs.push('[' + name + '=' + cssEscape(value) + ']');
            }
        }
    }

    let caret = null;

    if (active && active.type !== undefined && active.type !== 'number') {
        try {
            caret = active.selectionStart;
        } catch {
            caret = null;
        }
    }

    return {
        selector: attrs.length
            ? 'input, select, textarea' + attrs.join('')
            : null,
        caret,
        contentTop: document.getElementById('content').scrollTop,
        modalTop: modalBody.scrollTop,
        catListTop: document.getElementById('cat-list').scrollTop
    };
}

function cssEscape(value) {
    if (window.CSS && CSS.escape) {
        return CSS.escape(value);
    }

    return '"' + String(value).replace(/["\\]/g, '\\$&') + '"';
}

function restoreFocus(snapshot) {
    document.getElementById('content').scrollTop = snapshot.contentTop;
    document.getElementById('cat-list').scrollTop = snapshot.catListTop;
    modalBody.scrollTop = snapshot.modalTop;

    if (!snapshot.selector) {
        return;
    }

    const target = document.querySelector(snapshot.selector);

    if (!target) {
        return;
    }

    target.focus({ preventScroll: true });

    if (snapshot.caret !== null) {
        try {
            target.setSelectionRange(snapshot.caret, snapshot.caret);
        } catch {
            /* у number-полей позиция курсора недоступна */
        }
    }
}

/*
|--------------------------------------------------------------------------
| MODAL
|--------------------------------------------------------------------------
*/

const modalRoot = document.getElementById('modal-root');
const modalBody = document.getElementById('modal-body');

function openModal(html, wide) {
    modalBody.innerHTML = html;
    modalBody.classList.toggle('modal-wide', Boolean(wide));
    modalRoot.classList.remove('hidden');
}

function closeModal() {
    modalRoot.classList.add('hidden');
    modalBody.innerHTML = '';
    modalBody.classList.remove('modal-wide');
    state.productsModalOpen = false;
}

modalRoot.addEventListener('click', event => {
    if (event.target.hasAttribute('data-close')) {
        closeModal();
    }
});

/*
|--------------------------------------------------------------------------
| RENDER: SIDEBAR
|--------------------------------------------------------------------------
*/

/*
 * Статус кота: comeback отдаёт "Магазин не найден", когда кот убран,
 * поэтому offline = магазин не найден, online = в витрине что-то стоит.
 */
function catStatusBadge(cat) {
    if (cat.online === true) {
        return '<span class="cat-status online" title="Магазин найден, товары стоят">online</span>';
    }

    if (cat.online === false) {
        return '<span class="cat-status offline" title="Магазин не найден — кот offline">offline</span>';
    }

    return '<span class="cat-status unknown" title="Кот ещё не обновлялся">—</span>';
}

function renderCatList() {
    const list = document.getElementById('cat-list');

    if (state.cats.length === 0) {
        list.innerHTML =
            '<div class="cat-sub" style="padding:12px;color:var(--muted)">' +
            'Котов пока нет. Добавьте первого.' +
            '</div>';

        return;
    }

    list.innerHTML = state.cats
        .map(cat => {
            const active =
                cat.id === state.selectedCatId ? ' active' : '';

            const updating =
                cat.updating || updatingRefIds('cat').has(cat.id);

            const sub = cat.shopName || cat.location || 'не обновлён';

            const totals = catTotals(cat);

            return (
                '<div class="cat-entry' + active + '" data-cat="' + cat.id + '">' +
                '<div class="cat-title">' +
                '<span class="spin cat-spin' + (updating ? '' : ' hidden') + '"></span>' +
                escapeHtml(cat.name) +
                catStatusBadge(cat) +
                '</div>' +
                '<div class="cat-sub">' + escapeHtml(sub) + '</div>' +
                '<div class="cat-sub cat-money">' +
                '<span class="' + profitColorClass(totals.profit) + '">прибыль ' +
                money(totals.profit) + '</span>' +
                ' · <span class="' + (totals.restockCost > 0 ? '' : 'muted-val') + '">докупить на ' +
                money(totals.restockCost) + '</span>' +
                '</div>' +
                '</div>'
            );
        })
        .join('');

    list.querySelectorAll('[data-cat]').forEach(element => {
        element.addEventListener('click', () => {
            selectCat(element.getAttribute('data-cat'));
        });
    });
}

function selectCat(id) {
    state.selectedCatId = id;

    if (state.daily[id] && state.daily[id].failed) {
        delete state.daily[id];
    }

    renderCatList();
    renderContent();
}

/*
|--------------------------------------------------------------------------
| RENDER: CONTENT
|--------------------------------------------------------------------------
*/

function renderContent() {
    const content = document.getElementById('content');

    const cat = currentCat();

    if (!cat) {
        content.innerHTML =
            '<div class="empty">Выберите кота слева или добавьте нового.</div>';

        return;
    }

    content.innerHTML = renderCat(cat);

    bindCatEvents(cat);
}

function statCard(label, value, className) {
    return (
        '<div class="stat-card">' +
        '<div class="label">' + escapeHtml(label) + '</div>' +
        '<div class="value ' + (className || '') + '">' + value + '</div>' +
        '</div>'
    );
}

function catTotals(cat) {
    const totals = {
        sold: 0,
        bought: 0,
        revenue: 0,
        purchaseCost: 0,
        restockCost: 0,
        profit: 0
    };

    for (const item of cat.items) {
        totals.sold += item.sold;
        totals.bought += item.bought;
        totals.revenue += item.revenue;
        totals.purchaseCost += item.purchaseCost;
        totals.restockCost += item.restockCost;
        totals.profit += item.profit;
    }

    return totals;
}

function renderCat(cat) {
    const totals = catTotals(cat);

    const coords =
        cat.x !== null && cat.y !== null
            ? 'X: ' + cat.x + '  Y: ' + cat.y
            : 'координаты неизвестны';

    const offlineNote =
        cat.online === false
            ? '<div class="neg">Кот offline: comeback отдаёт «Магазин не найден», ' +
              'данные показаны по последнему успешному обновлению.</div>'
            : '';

    const head =
        '<div class="cat-head">' +
        '<div>' +
        '<h2>' + escapeHtml(cat.name) + ' ' + catStatusBadge(cat) + '</h2>' +
        '<div class="meta-line">Магазин: ' + escapeHtml(cat.shopName || '—') +
        ' · ' + escapeHtml(cat.parsedName || '') + '</div>' +
        '<div class="meta-line">Локация: ' + escapeHtml(cat.location || '—') +
        ' · ' + escapeHtml(coords) + '</div>' +
        '<div class="meta-line">Ссылка: <a href="' + escapeHtml(cat.url) +
        '" target="_blank" rel="noopener">' + escapeHtml(cat.url) + '</a></div>' +
        '<div class="meta-line">Обновлён: ' + formatDate(cat.lastUpdatedAt) +
        (cat.updateError
            ? ' · <span class="neg">ошибка: ' + escapeHtml(cat.updateError) + '</span>'
            : '') +
        '</div>' +
        offlineNote +
        '</div>' +
        '<div class="cat-head-actions">' +
        '<button class="btn btn-primary" data-act="update">' +
        (cat.updating ? 'Обновление…' : 'Обновить') + '</button>' +
        '<button class="btn" data-act="update-front" ' +
        'title="Поставить в начало очереди — обновится сразу после текущей задачи">Обновить сразу</button>' +
        '<button class="btn" data-act="product-prices" ' +
        'title="Обновить рыночные цены всех товаров этого кота (задания встанут в общую очередь)">Цены товаров</button>' +
        '<button class="btn" data-act="carry">Перенос</button>' +
        '<button class="btn" data-act="stats">Статистика</button>' +
        '<button class="btn" data-act="reset">Сброс</button>' +
        '<button class="btn" data-act="edit">Изменить</button>' +
        '<button class="btn btn-danger" data-act="delete">Удалить</button>' +
        '</div>' +
        '</div>';

    const stats =
        '<div class="stats">' +
        statCard('Продано', quantity(totals.sold)) +
        statCard('Куплено', quantity(totals.bought)) +
        statCard('Выручка', money(totals.revenue)) +
        statCard('Затраты', money(totals.purchaseCost + totals.restockCost)) +
        statCard(
            'Прибыль',
            money(totals.profit),
            profitColorClass(totals.profit)
        ) +
        '</div>';

    return (
        head +
        stats +
        renderItemsTable(cat) +
        renderDailyBlock(cat)
    );
}

function renderItemsTable(cat) {
    if (cat.items.length === 0) {
        return (
            '<div class="empty">Товаров пока нет. Нажмите «Обновить», ' +
            'чтобы спарсить магазин.</div>'
        );
    }

    const groupRow =
        '<tr>' +
        '<th rowspan="2" class="grp-item">Товар</th>' +
        '<th colspan="5" class="grp-sell grp-head">Продажа</th>' +
        '<th colspan="5" class="grp-buy grp-head">Покупка</th>' +
        '<th colspan="5" class="grp-total grp-head">Итог</th>' +
        '</tr>';

    const labelRow =
        '<tr>' +
        '<th class="grp-sell">Должно</th>' +
        '<th class="grp-sell">Тек</th>' +
        '<th class="grp-sell">Продано</th>' +
        '<th class="grp-sell">Цена</th>' +
        '<th class="grp-sell">Рек</th>' +
        '<th class="grp-buy">Должно</th>' +
        '<th class="grp-buy">Тек</th>' +
        '<th class="grp-buy">Куплено</th>' +
        '<th class="grp-buy">Цена</th>' +
        '<th class="grp-buy">Рек</th>' +
        '<th class="grp-total">Докупить</th>' +
        '<th class="grp-total">Где дешевле</th>' +
        '<th class="grp-total">Цена</th>' +
        '<th class="grp-total">Прибыль</th>' +
        '<th class="grp-total">За шт</th>' +
        '</tr>';

    const rows = cat.items
        .map(item => renderItemRow(cat, item))
        .join('');

    return (
        '<div class="table-wrap"><table class="table-compact">' +
        '<thead>' + groupRow + labelRow + '</thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table></div>'
    );
}

function renderItemRow(cat, item) {
    const nameClass = item.configured ? '' : ' class="unconfigured"';

    const badge = item.configured
        ? ''
        : ' <span class="badge warn">не настроен</span>';

    const first =
        '<td class="grp-item"><div class="item-cell">' +
        (item.image
            ? '<img src="' + escapeHtml(item.image) + '" alt="" />'
            : '') +
        '<span' + nameClass + '>' + escapeHtml(item.name) + '</span>' +
        badge +
        '<button class="btn btn-small btn-market" data-act="open-product" ' +
        'data-product="' + item.productId + '" ' +
        'title="Открыть базу товаров с продавцами этого товара">Продавцы</button>' +
        '</div></td>';

    const sellTarget =
        '<td class="grp-sell"><input class="cell-input" type="number" min="0" ' +
        'data-field="sellTarget" data-product="' + item.productId + '" ' +
        'value="' + (item.sellTarget || 0) + '" /></td>';

    const buyTarget =
        '<td class="grp-buy"><input class="cell-input" type="number" min="0" ' +
        'data-field="buyTarget" data-product="' + item.productId + '" ' +
        'value="' + (item.buyTarget || 0) + '" /></td>';

    const soldClass = item.sold > 0 ? '' : ' muted-val';
    const boughtClass = item.bought > 0 ? '' : ' muted-val';
    const needClass = item.needToBuy > 0 ? '' : ' muted-val';
    const profitClass = profitColorClass(item.profit);

    /*
     * Если товар стоит у кота и в скупе, и в продаже, купленное в
     * собственном скупе идёт в тот же запас и снаружи докупать его не
     * нужно. Показываем зачёт подписью под цифрой, чтобы "докупить"
     * не выглядело потерянным объёмом.
     */
    const covered = item.coveredByBuy > 0
        ? '<div class="src-note">своим скупе: ' +
            quantity(item.coveredByBuy) + '</div>'
        : '';

    const needCell =
        '<td class="grp-total' + needClass + '">' +
        quantity(item.needToBuy) + covered + '</td>';

    // Место и цена докупки: закрепленное место или самый дешёвый источник.
    const wherePrice = item.bestBuyPrice > 0
        ? money(item.bestBuyPrice)
        : '<span class="muted-val">—</span>';

    const whereCell =
        '<td class="grp-total grp-where">' +
        buySourceSelect(cat, item) +
        '<div class="src-note">' + escapeHtml(item.bestBuyLabel) + '</div>' +
        '</td>';

    return (
        '<tr>' +
        first +
        sellTarget +
        '<td class="grp-sell">' + quantity(item.sellCurrent) + '</td>' +
        '<td class="grp-sell' + soldClass + '">' + quantity(item.sold) + '</td>' +
        '<td class="grp-sell">' + money(item.sellPrice) + '</td>' +
        '<td class="grp-sell">' + money(item.recommendedSell) + '</td>' +
        buyTarget +
        '<td class="grp-buy">' + quantity(item.buyCurrent) + '</td>' +
        '<td class="grp-buy' + boughtClass + '">' + quantity(item.bought) + '</td>' +
        '<td class="grp-buy">' + money(item.buyPrice) + '</td>' +
        '<td class="grp-buy">' + money(item.recommendedBuy) + '</td>' +
        needCell +
        whereCell +
        '<td class="grp-total grp-where-price">' + wherePrice + '</td>' +
        '<td class="grp-total ' + profitClass + '">' + money(item.profit) + '</td>' +
        '<td class="grp-total ' + profitClass + '">' + money(item.profitPerSale) + '</td>' +
        '</tr>'
    );
}

/*
 * Выбор источника докупки для позиции. Значение — 'auto', 'gold',
 * 'manual' или 'cat:<id>'; цена вручную доезжает отдельным полем.
 */
function buySourceSelect(cat, item) {
    const source = item.buySource || { type: 'auto' };

    const value =
        source.type === 'cat'
            ? 'cat:' + source.catId
            : source.type === 'gold' || source.type === 'manual' || source.type === 'market'
                ? source.type
                : 'auto';

    const cats = [...state.cats].sort((a, b) =>
        String(a.name || a.shopName || '').localeCompare(
            String(b.name || b.shopName || ''),
            'ru'
        )
    );

    const options = ['<option value="auto">Авто (дешевле всего)</option>'];

    for (const other of cats) {
        const label =
            'Скуп: ' + (other.name || other.shopName || 'кот') +
            (other.id === cat.id ? ' (этот кот)' : '');

        options.push(
            '<option value="cat:' + escapeHtml(other.id) + '"' +
            (value === 'cat:' + other.id ? ' selected' : '') + '>' +
            escapeHtml(label) + '</option>'
        );
    }

    options.push(
        '<option value="market"' + (value === 'market' ? ' selected' : '') +
        '>Быстрая покупка (рынок)</option>',
        '<option value="gold"' + (value === 'gold' ? ' selected' : '') +
        '>Магазин (голда)</option>',
        '<option value="manual"' + (value === 'manual' ? ' selected' : '') +
        '>Цена вручную</option>'
    );

    const priceInput = value === 'manual'
        ? '<input class="src-price-input" type="number" min="0" step="1" ' +
            'placeholder="цена" ' +
            'data-product="' + item.productId + '" ' +
            'value="' + (source.price || '') + '" />'
        : '';

    return (
        '<select class="cell-select" data-product="' + item.productId + '">' +
        options.join('') +
        '</select>' + priceInput
    );
}

/*
|--------------------------------------------------------------------------
| ДНЕВНАЯ СТАТИСТИКА КОТА (график + срезы "неделя / месяц")
|--------------------------------------------------------------------------
*/

const DAILY_RANGES = { week: 7, month: 31 };

function sumSeries(series) {
    const totals = {
        sold: 0, bought: 0, revenue: 0, purchaseCost: 0, profit: 0
    };

    for (const day of series) {
        totals.sold += day.sold;
        totals.bought += day.bought;
        totals.revenue += day.revenue;
        totals.purchaseCost += day.purchaseCost;
        totals.profit += day.profit;
    }

    return totals;
}

/*
 * Столбики прибыли по дням: выше нуля — плюс, ниже — минус.
 * Наведение на столбик показывает выручку и закупки дня.
 */
function dailyChart(series) {
    const width = 760;
    const height = 190;
    const topPad = 18;
    const bottomPad = 30;
    const plotHeight = height - topPad - bottomPad;
    const zeroY = topPad + plotHeight / 2;

    const maxAbs = Math.max(1, ...series.map(day => Math.abs(day.profit)));
    const scale = (plotHeight / 2) / maxAbs;

    const slot = width / Math.max(1, series.length);
    const barWidth = Math.max(2, slot * 0.62);

    const r = value => Math.round(value * 10) / 10;

    const bars = series
        .map((day, index) => {
            const barHeight = Math.max(2, Math.abs(day.profit) * scale);
            const x = index * slot + (slot - barWidth) / 2;
            const y = day.profit >= 0 ? zeroY - barHeight : zeroY;

            const cls = day.profit > 0
                ? 'bar-pos'
                : day.profit < 0
                    ? 'bar-neg'
                    : 'bar-zero';

            const tip = dayLabel(day.date) +
                ' · прибыль ' + money(day.profit) +
                ' · выручка ' + money(day.revenue) +
                ' · закупки ' + money(day.purchaseCost) +
                ' · продано ' + quantity(day.sold) +
                ' · куплено ' + quantity(day.bought);

            return (
                '<rect class="' + cls + '" x="' + r(x) + '" y="' + r(y) +
                '" width="' + r(barWidth) + '" height="' + r(barHeight) + '">' +
                '<title>' + escapeHtml(tip) + '</title></rect>'
            );
        })
        .join('');

    const labelStep = Math.max(1, Math.ceil(series.length / 8));

    const labels = series
        .map((day, index) => {
            if (index % labelStep !== 0) {
                return '';
            }

            return '<text class="tick" x="' + r(index * slot + slot / 2) +
                '" y="' + (height - 10) + '" text-anchor="middle">' +
                dayLabel(day.date) + '</text>';
        })
        .join('');

    return (
        '<svg class="daily-chart" viewBox="0 0 ' + width + ' ' + height + '">' +
        '<line class="axis" x1="0" y1="' + r(zeroY) + '" x2="' + width +
        '" y2="' + r(zeroY) + '" />' +
        '<text class="tick" x="2" y="' + (topPad - 6) + '">+' +
        shortMoney(maxAbs) + '</text>' +
        '<text class="tick" x="2" y="' + (height - bottomPad - 4) + '">−' +
        shortMoney(maxAbs) + '</text>' +
        bars + labels +
        '</svg>'
    );
}

function dailyRangeButton(name, label) {
    return (
        '<button class="btn btn-small' +
        (state.dailyRange === name ? ' btn-primary' : '') +
        '" data-range="' + name + '">' + label + '</button>'
    );
}

function dailyClosedLine(closed) {
    if (!closed || !closed.periods) {
        return '';
    }

    return (
        '<div class="meta-line">Закрытых периодов: ' + closed.periods +
        ', прибыль в них <span class="' + profitColorClass(closed.profit) + '">' +
        money(closed.profit) + '</span> (сбросы в график не входят, чтобы не считать одно дважды).</div>'
    );
}

function dailyBlockHtml(cat) {
    const cached = state.daily[cat.id];

    const head =
        '<div class="daily-head">' +
        '<h3>Статистика по дням</h3>' +
        '<div class="range-switch">' +
        dailyRangeButton('week', 'Неделя') +
        dailyRangeButton('month', 'Месяц') +
        '</div>' +
        '</div>';

    if (!cached) {
        return head + '<div class="muted-val">загрузка…</div>';
    }

    if (cached.failed) {
        return head + '<div class="neg">Не удалось загрузить статистику по дням.</div>';
    }

    const days = DAILY_RANGES[state.dailyRange] || DAILY_RANGES.month;

    const series = cached.days.slice(-days);

    const totals = sumSeries(series);

    const active = series.filter(day => day.sold || day.bought).length;

    const cards =
        '<div class="stats">' +
        statCard('Продано', quantity(totals.sold)) +
        statCard('Куплено', quantity(totals.bought)) +
        statCard('Выручка', money(totals.revenue)) +
        statCard('Закупки', money(totals.purchaseCost)) +
        statCard('Прибыль', money(totals.profit), profitColorClass(totals.profit)) +
        '</div>';

    if (!cached.days.some(day => day.sold || day.bought)) {
        return head + cards + dailyClosedLine(cached.closed) +
            '<div class="muted-val">Пока нечего показывать: график строится по ' +
            'разнице двух обновлений подряд — сколько товара ушло с витрины и ' +
            'сколько кот выкупил. Обновите кота ещё раз после продаж, и дни ' +
            'появятся.</div>';
    }

    return head + cards + dailyChart(series) +
        '<div class="meta-line">Столбик — прибыль за день ' +
        '(выручка минус закупки), наведение — подробности. ' +
        'Дней с движениями: ' + active + ' из ' + series.length + '.</div>' +
        dailyClosedLine(cached.closed);
}

function renderDailyBlock(cat) {
    ensureDaily(cat.id, false);

    return (
        '<div class="daily-box" id="cat-daily" data-cat="' + cat.id + '">' +
        dailyBlockHtml(cat) +
        '</div>'
    );
}

function paintDailyBlock(catId) {
    const box = document.getElementById('cat-daily');

    const cat = state.cats.find(item => item.id === catId);

    if (!box || !cat || box.getAttribute('data-cat') !== catId) {
        return;
    }

    box.innerHTML = dailyBlockHtml(cat);

    bindDailyControls(catId);
}

function bindDailyControls(catId) {
    const box = document.getElementById('cat-daily');

    if (!box) {
        return;
    }

    box.querySelectorAll('[data-range]').forEach(button => {
        button.addEventListener('click', () => {
            state.dailyRange = button.getAttribute('data-range');

            paintDailyBlock(catId);
        });
    });
}

async function ensureDaily(catId, force) {
    if (!force && (state.daily[catId] || state.dailyLoading.has(catId))) {
        return;
    }

    state.dailyLoading.add(catId);

    try {
        state.daily[catId] = await api(
            'GET',
            '/api/stats/cat/' + catId + '/daily?days=' + DAILY_RANGES.month
        );

        paintDailyBlock(catId);
    } catch {
        state.daily[catId] = { failed: true, days: [] };

        paintDailyBlock(catId);
    } finally {
        state.dailyLoading.delete(catId);
    }
}

/*
|--------------------------------------------------------------------------
| CAT EVENTS
|--------------------------------------------------------------------------
*/

function bindCatEvents(cat) {
    const content = document.getElementById('content');

    content
        .querySelectorAll('[data-act]')
        .forEach(button => {
            button.addEventListener('click', () => {
                const action = button.getAttribute('data-act');

                if (action === 'update') {
                    updateCurrentCat(cat, false);
                } else if (action === 'update-front') {
                    updateCurrentCat(cat, true);
                } else if (action === 'carry') {
                    carryCurrentCat(cat);
                } else if (action === 'product-prices') {
                    updateCatProductPrices(cat);
                } else if (action === 'stats') {
                    openCatStats(cat);
                } else if (action === 'reset') {
                    resetCurrentCat(cat);
                } else if (action === 'edit') {
                    catDialog(cat);
                } else if (action === 'delete') {
                    deleteCurrentCat(cat);
                } else if (action === 'open-product') {
                    openProductFromCat(button.getAttribute('data-product'));
                }
            });
        });

    content
        .querySelectorAll('input.cell-input')
        .forEach(input => {
            input.addEventListener('change', () => {
                updateCatItem(
                    cat.id,
                    input.getAttribute('data-product'),
                    input.getAttribute('data-field'),
                    input.value
                );
            });
        });

    content
        .querySelectorAll('select.cell-select')
        .forEach(select => {
            select.addEventListener('change', () => {
                saveBuySource(
                    cat.id,
                    select.getAttribute('data-product'),
                    select.value
                );
            });
        });

    content
        .querySelectorAll('input.src-price-input')
        .forEach(input => {
            input.addEventListener('change', () => {
                saveBuySource(
                    cat.id,
                    input.getAttribute('data-product'),
                    'manual',
                    input.value
                );
            });
        });

    bindDailyControls(cat.id);
}

async function updateCatItem(catId, productId, field, value) {
    try {
        const updated = await api(
            'PUT',
            '/api/cats/' + catId + '/items/' + productId,
            { [field]: Number(value) || 0 }
        );

        const index = state.cats.findIndex(c => c.id === catId);

        if (index !== -1) {
            state.cats[index] = updated;
        }

        // Итоги кота видны и в списке слева — обновляем оба.
        renderCatList();
        renderContent();
    } catch (error) {
        alert(error.message);
    }
}

/*
 * Сохранить источник докупки позиции. 'auto' шлём как null — так на
 * сервере хранится «ничего не закреплено».
 */
async function saveBuySource(catId, productId, value, manualPrice) {
    let buySource = null;

    if (value === 'gold') {
        buySource = { type: 'gold' };
    } else if (value === 'market') {
        buySource = { type: 'market' };
    } else if (value === 'manual') {
        buySource = { type: 'manual', price: Number(manualPrice) || 0 };
    } else if (value.indexOf('cat:') === 0) {
        buySource = { type: 'cat', catId: value.slice(4) };
    }

    try {
        const updated = await api(
            'PUT',
            '/api/cats/' + catId + '/items/' + productId,
            { buySource }
        );

        const index = state.cats.findIndex(c => c.id === catId);

        if (index !== -1) {
            state.cats[index] = updated;
        }

        renderCatList();
        renderContent();
    } catch (error) {
        alert(error.message);
    }
}

/*
 * Цены товаров этого кота: ставим в общую очередь одну задачу, она
 * сама расставит задания рынка по строкам кота.
 */
async function updateCatProductPrices(cat) {
    if (!cat.items || cat.items.length === 0) {
        alert('У кота нет товаров.');
        return;
    }

    try {
        await api('POST', '/api/cats/' + cat.id + '/update-product-prices');

        startQueuePolling();
    } catch (error) {
        alert(error.message);
    }
}

/*
 * front = true ставит задачу в начало очереди: она выполнится сразу
 * после текущей, не дожидаясь остальных.
 */
async function updateCurrentCat(cat, front) {
    if (!cat) {
        return;
    }

    cat.updating = true;
    renderCatList();
    renderContent();

    try {
        await api('POST', '/api/cats/' + cat.id + '/update', {
            front: Boolean(front)
        });

        startQueuePolling();
    } catch (error) {
        cat.updating = false;
        alert('Ошибка обновления: ' + error.message);
        renderContent();
    }
}

async function carryCurrentCat(cat) {
    if (
        !confirm(
            'Перенести все текущие количества в «должно быть» без записи в статистику?'
        )
    ) {
        return;
    }

    try {
        const updated = await api('POST', '/api/cats/' + cat.id + '/carry');

        const index = state.cats.findIndex(c => c.id === cat.id);

        if (index !== -1) {
            state.cats[index] = updated;
        }

        renderCatList();
        renderContent();
    } catch (error) {
        alert(error.message);
    }
}

async function resetCurrentCat(cat) {
    if (
        !confirm(
            'Сброс: текущий период будет дописан в статистику, ' +
            'а текущие количества перенесены в «должно быть». Продолжить?'
        )
    ) {
        return;
    }

    try {
        await api('POST', '/api/cats/' + cat.id + '/reset');

        // Сброс дописывает закрытый период — ряд по дням берём заново.
        state.daily[cat.id] = null;

        await loadState();

        renderCatList();
        renderContent();
    } catch (error) {
        alert(error.message);
    }
}

async function deleteCurrentCat(cat) {
    if (!confirm('Удалить кота "' + cat.name + '"?')) {
        return;
    }

    try {
        await api('DELETE', '/api/cats/' + cat.id);

        state.selectedCatId = null;

        await loadState();

        renderCatList();
        renderContent();
    } catch (error) {
        alert(error.message);
    }
}

/*
|--------------------------------------------------------------------------
| CREATE / EDIT CAT
|--------------------------------------------------------------------------
*/

function catDialog(cat) {
    const editing = Boolean(cat);

    openModal(
        '<h3>' + (editing ? 'Изменить кота' : 'Новый кот') + '</h3>' +
        '<div class="field">' +
        '<label>Имя</label>' +
        '<input id="cat-name" value="' + escapeHtml(cat ? cat.name : '') + '" />' +
        '</div>' +
        '<div class="field">' +
        '<label>Ссылка на comeback.pw</label>' +
        '<input id="cat-url" placeholder="comeback.pw/cats/146/?...&shop=19831968" ' +
        'value="' + escapeHtml(cat ? cat.url : '') + '" />' +
        '</div>' +
        '<div class="modal-actions">' +
        '<button class="btn" data-close>Отмена</button>' +
        '<button class="btn btn-primary" id="cat-save">Сохранить</button>' +
        '</div>'
    );

    modalBody
        .querySelectorAll('[data-close]')
        .forEach(b => b.addEventListener('click', closeModal));

    document.getElementById('cat-save').addEventListener('click', async () => {
        const name = document.getElementById('cat-name').value.trim();
        const url = document.getElementById('cat-url').value.trim();

        if (!url) {
            alert('Укажите ссылку.');
            return;
        }

        try {
            if (editing) {
                const updated = await api('PUT', '/api/cats/' + cat.id, {
                    name,
                    url
                });

                const index = state.cats.findIndex(c => c.id === cat.id);

                if (index !== -1) {
                    state.cats[index] = updated;
                }
            } else {
                const created = await api('POST', '/api/cats', { name, url });

                state.cats.push(created);
                state.selectedCatId = created.id;
            }

            closeModal();

            renderCatList();
            renderContent();
        } catch (error) {
            alert(error.message);
        }
    });
}

/*
|--------------------------------------------------------------------------
| QUEUE (очередь обновлений — всё по очереди, без параллельных запросов)
|--------------------------------------------------------------------------
*/

const banner = document.getElementById('update-banner');

let queueCanceled = false;

function renderBanner() {
    const queue = state.queue || {};

    const busy = queue.running || queue.length > 0;

    if (!busy) {
        queueCanceled = false;
        banner.innerHTML = '';
        banner.classList.add('hidden');
        return;
    }

    const currentLabel = queue.current
        ? (queue.current.type === 'cat' ? 'кот' : 'цена товара') +
          ' ' + (queue.current.name || '')
        : 'пауза ' + Math.round((queue.intervalMs || 0) / 1000) +
          ' с до следующего запроса';

    const pending = queue.length > 0
        ? ' · в очереди ' + queue.length +
          ' <button class="btn btn-small" id="btn-cancel-queue">Отменить очередь</button>'
        : ' · очередь пуста, заканчивается текущая задача';

    banner.innerHTML =
        '<span class="banner-text">' +
        (queueCanceled ? '⏹ отменено · ' : '') +
        '⟳ Обновление: ' + escapeHtml(currentLabel) + pending +
        '</span>';

    const cancel = document.getElementById('btn-cancel-queue');

    if (cancel) {
        cancel.addEventListener('click', cancelQueue);
    }

    banner.classList.remove('hidden');
}

async function cancelQueue() {
    if (!confirm('Отменить очередь обновления? Текущая задача закончится, остальные будут убраны.')) {
        return;
    }

    try {
        await api('DELETE', '/api/queue');

        queueCanceled = true;

        await reloadKeepingView();

        startQueuePolling();
    } catch (error) {
        alert(error.message);
    }
}

let queuePollTimer = null;

/* Опрос ещё не завершился, а таймера уже нет — не запускаем второй цикл. */
let pollInFlight = false;

/*
 * Журнал выполненных задач (queue.completed) растёт по seq. Если seq
 * больше уже показанного — данные на сервере изменились, и их нужно
 * перерисовать сразу, не дожидаясь, пока очередь опустеет.
 *
 * null — ещё не было ни одного опроса, базовый seq возьмём из первого.
 */
let lastCompletedSeq = null;

/*
 * id задач очереди имеют вид "cat:<catId>" / "market:<productId>".
 * Собираем refId всех активных (выполняемых или стоящих) задач типа type.
 */
function updatingRefIds(type) {
    const ids = new Set();
    const queue = state.queue || {};
    const jobs = [];

    if (queue.current) {
        jobs.push(queue.current);
    }

    if (Array.isArray(queue.items)) {
        jobs.push(...queue.items);
    }

    for (const job of jobs) {
        if (!job || job.type !== type || !job.id) {
            continue;
        }

        const separator = job.id.indexOf(':');

        ids.add(separator === -1 ? job.id : job.id.slice(separator + 1));
    }

    return ids;
}

/*
 * Индексы обновлений рисуются не перерисовкой всего списка, а
 * переключением уже отрендеренных спиннеров — иначе поллинг очереди
 * сбрасывал бы фокус ввода и раскрытые строки.
 */
function renderUpdatingIndicators() {
    const catIds = updatingRefIds('cat');
    const productIds = updatingRefIds('market');

    document.querySelectorAll('#cat-list .cat-entry[data-cat]').forEach(entry => {
        const spinner = entry.querySelector('.cat-spin');

        if (spinner) {
            spinner.classList.toggle(
                'hidden',
                !catIds.has(entry.getAttribute('data-cat'))
            );
        }
    });

    document.querySelectorAll('#modal-body [data-spin-pid]').forEach(spinner => {
        spinner.classList.toggle(
            'hidden',
            !productIds.has(spinner.getAttribute('data-spin-pid'))
        );
    });
}

/*
 * Перезагружаем данные и перерисовываем всё открытое, сохраняя фокус
 * ввода и прокрутку — это и есть «обновление видно сразу».
 */
async function reloadKeepingView() {
    const snapshot = focusSnapshot();

    await loadState();

    renderCatList();
    renderContent();

    if (state.productsModalOpen) {
        openProducts();
    }

    restoreFocus(snapshot);
    renderUpdatingIndicators();
}

async function applyCompletions() {
    const queue = state.queue || {};

    const completed = queue.completed || [];

    /*
     * Первый опрос: отсчитываем от того, что уже накопилось на сервере до
     * открытия страницы, — перерисовывать по старым записям нечего. Всё,
     * что закончится после этого, прилетает сюда как seq больше базового.
     */
    if (lastCompletedSeq === null) {
        lastCompletedSeq = typeof queue.lastSeq === 'number'
            ? queue.lastSeq
            : completed.length;

        return;
    }

    if (!completed.length) {
        return;
    }

    const fresh = completed.filter(entry => entry.seq > lastCompletedSeq);

    lastCompletedSeq = completed[completed.length - 1].seq;

    if (!fresh.length) {
        return;
    }

    // Обновлённый кот меняет и график по дням — подтягиваем ряд.
    for (const entry of fresh) {
        if (entry.type === 'cat' && entry.ok) {
            ensureDaily(entry.refId, true);
        }
    }

    await reloadKeepingView();
}

async function refreshQueue() {
    queuePollTimer = null;
    pollInFlight = true;

    try {
        await pollQueue();
    } finally {
        pollInFlight = false;
    }
}

async function pollQueue() {
    let queue;

    try {
        queue = await api('GET', '/api/queue');
    } catch {
        schedulePoll(3000);
        return;
    }

    state.queue = queue;

    renderUpdatingIndicators();

    /*
     * Перерисовка по завершённым задачам не должна ронять цикл опроса:
     * иначе одна ошибка в рендере лишает страницу и индикаторов, и
     * живых обновлений до самой перезагрузки.
     */
    try {
        await applyCompletions();
    } catch (error) {
        console.error('Не удалось перерисовать данные очереди:', error);
    }

    renderBanner();

    const busy = queue.running || queue.length > 0;

    if (busy) {
        schedulePoll(1500);
    }
}

function schedulePoll(delay) {
    if (queuePollTimer) {
        clearTimeout(queuePollTimer);
    }

    queuePollTimer = setTimeout(refreshQueue, delay);
}

function startQueuePolling() {
    if (queuePollTimer || pollInFlight) {
        return;
    }

    refreshQueue();
}

async function updateAllCats(front) {
    if (state.cats.length === 0) {
        alert('Нет котов для обновления.');
        return;
    }

    try {
        await api('POST', '/api/cats/update-all', {
            front: Boolean(front)
        });

        startQueuePolling();
    } catch (error) {
        alert('Ошибка обновления всех: ' + error.message);
    }
}

/*
|--------------------------------------------------------------------------
| PRODUCTS BASE
|--------------------------------------------------------------------------
*/

function sourceLabel(source) {
    return source === 'auction'
        ? 'Комиссионка/аукцион'
        : 'Коты/лавки';
}

function renderOffersList(offers, side) {
    if (!offers || offers.length === 0) {
        return '<div class="muted-val">нет предложений</div>';
    }

    return offers
        .slice(0, 8)
        .map(offer => {
            const price =
                side === 'sell' ? offer.sellPrice : offer.buyPrice;

            const who =
                offer.nick ||
                offer.shopName ||
                '—';

            const where =
                offer.source === 'auction'
                    ? (offer.location || 'Комиссионный магазин') +
                      (offer.timeLeft ? ' · осталось ' + offer.timeLeft : '')
                    : (offer.location || '') +
                      (offer.x !== null && offer.x !== undefined
                          ? ' (' + offer.x + ' ' + offer.y + ')'
                          : '');

            return (
                '<div class="offer-row' +
                (offer.anomaly ? ' offer-anomaly' : '') + '">' +
                '<span class="offer-src src-' + offer.source + '">' +
                sourceLabel(offer.source) + '</span>' +
                '<span class="offer-who">' + escapeHtml(who) +
                (offer.shopName && offer.nick
                    ? ' <span class="muted-val">· ' + escapeHtml(offer.shopName) + '</span>'
                    : '') +
                (offer.own
                    ? ' <span class="badge own" title="Это ваша же витрина: в расчёт рыночной цены не берётся">свой кот</span>'
                    : '') + '</span>' +
                '<span class="offer-price">' + money(price) +
                (offer.anomaly
                    ? ' <span class="badge warn" title="Мелкий объём по цене сильно выше кластера - в расчёт рыночной цены не берётся">всплеск</span>'
                    : '') +
                '</span>' +
                '<span class="offer-count">×' + quantity(offer.count) + '</span>' +
                '<span class="offer-where">' + escapeHtml(where) + '</span>' +
                '</div>'
            );
        })
        .join('');
}

function renderSellersDetail(product) {
    const market = product.market;

    if (!market) {
        return '<div class="muted-val">Рынок ещё не обновлялся. Нажмите «Обновить».</div>';
    }

    return (
        '<div class="sellers-grid">' +
        '<div class="sellers-col">' +
        '<div class="sellers-title">Покупают (дороже сверху)</div>' +
        renderOffersList(market.buyOffers, 'buy') +
        '</div>' +
        '<div class="sellers-col">' +
        '<div class="sellers-title">Продают (дешевле сверху)</div>' +
        renderOffersList(market.sellOffers, 'sell') +
        '</div>' +
        '</div>' +
        '<div class="muted-val" style="margin-top:6px">Сервер ' +
        escapeHtml(market.server || '?') + ' · обновлено ' +
        formatDate(market.updatedAt) + '</div>'
    );
}

function renderMarketCell(product) {
    const market = product.market;
    const pid = product.id;

    const buttons =
        '<div class="market-actions">' +
        '<button class="btn btn-small" data-act="upd-price" data-p="' + pid + '">Обновить цену</button>' +
        '<button class="btn btn-small" data-act="upd-price-front" data-p="' + pid + '" ' +
        'title="Поставить в начало очереди — обновится сразу после текущей задачи">сразу</button>' +
        '<button class="btn btn-small" data-act="toggle-sellers" data-p="' + pid + '">Продавцы</button>' +
        '</div>';

    if (!market || (!market.sellPrice && !market.buyPrice)) {
        return (
            '<div class="market-cell">' +
            '<span class="muted-val">нет данных</span>' +
            buttons +
            '</div>'
        );
    }

    const jump = market.jump
        ? '<div class="suspicious">⚠ цена продажи резко изменилась: ' +
          money(market.jump.from) + ' → ' + money(market.jump.to) +
          ' · новая принята сразу</div>'
        : '';

    const skip = product.carrySkip || {};

    const skipNote = side => skip[side]
        ? '<div class="badge warn" title="Перенос пропущен: новая цена отличается от ручной больше чем на порог отклонения из Настроек">' +
          'скачок ' + money(skip[side].from) + ' → ' + money(skip[side].to) +
          '</div>'
        : '';

    return (
        '<div class="market-cell">' +
        '<div class="market-line">покупка: <b>' + money(market.buyPrice) + '</b> ' +
        '<button class="btn btn-small" data-act="apply" data-side="buy" data-p="' + pid + '">перенести</button>' +
        skipNote('buy') + '</div>' +
        '<div class="market-line">продажа: <b>' + money(market.sellPrice) + '</b> ' +
        '<button class="btn btn-small" data-act="apply" data-side="sell" data-p="' + pid + '">перенести</button>' +
        skipNote('sell') + '</div>' +
        buttons +
        jump +
        '</div>'
    );
}

/*
 * Единственное место, решающее, какие строки таблицы товаров видно.
 * Строку продавцов скрывает только класс hidden: раньше фильтр ставил
 * ещё и inline styledisplay, который переключение класса не сбрасывало,
 * и строка раскрывалась лишь после повторного открытия окна.
 */
function syncProductsVisibility() {
    const query = productsUI.query.trim().toLowerCase();

    modalBody.querySelectorAll('tbody tr[data-pid]').forEach(row => {
        const pid = row.getAttribute('data-pid');
        const name = row.getAttribute('data-name') || '';

        const match = productsUI.focusId
            ? pid === productsUI.focusId
            : name.includes(query);

        row.style.display = match ? '' : 'none';

        const sellersRow = modalBody.querySelector(
            'tr[data-sellers="' + pid + '"]'
        );

        if (sellersRow) {
            sellersRow.classList.toggle(
                'hidden',
                !(match && productsUI.expanded.has(pid))
            );
        }
    });
}

/*
 * Открывает базу товаров, показывая только этот товар, сразу с
 * раскрытыми продавцами.
 */
function openProductFromCat(productId) {
    const product = state.products.find(item => item.id === productId);

    if (!product) {
        alert('Товар не найден в базе.');
        return;
    }

    productsUI.focusId = productId;
    productsUI.query = product.name;
    productsUI.expanded.add(productId);

    openProducts();
}

function openProducts() {
    state.productsModalOpen = true;

    const updatingProducts = updatingRefIds('market');

    const rows = state.products
        .map(product => {
            const badge = product.configured
                ? '<span class="badge ok">настроен</span>'
                : '<span class="badge warn">не настроен</span>';

            /*
             * Ячейка цены в две строки: сверху ручная цена (она и
             * участвует в расчётах, если задана), снизу автоматическая
             * цена с рынка — только чтение.
             */
            const priceCell = (field, auto) => {
                const manual = Number(product[field]) || 0;

                const autoLine = auto > 0
                    ? 'авто ' + money(auto)
                    : '<span class="muted-val">авто нет</span>';

                return (
                    '<td class="price-cell">' +
                    '<input class="cell-input cell-input-wide' +
                    (manual > 0 ? ' price-used' : '') + '" type="number" min="0" ' +
                    'step="any" data-p="' + product.id + '" data-f="' + field +
                    '" value="' + manual + '" ' +
                    'title="Ручная цена: если задана, используется она" />' +
                    '<div class="auto-line' + (manual > 0 ? '' : ' price-used') + '" ' +
                    'title="Автоматическая цена с рынка, обновляется кнопкой цен">' +
                    autoLine + '</div>' +
                    '</td>'
                );
            };

            const expanded = productsUI.expanded.has(product.id);

            const goldUnit = product.goldUnitPrice > 0
                ? money(product.goldUnitPrice)
                : '<span class="muted-val">—</span>';

            const market = product.market || {};

            const input = (field, value) =>
                '<td><input class="cell-input cell-input-wide" type="number" min="0" ' +
                'step="any" data-p="' + product.id + '" data-f="' + field +
                '" value="' + (value || 0) + '" /></td>';

            const mainRow =
                '<tr data-name="' + escapeHtml(product.name.toLowerCase()) + '" data-pid="' + product.id + '">' +
                '<td><div class="item-cell">' +
                '<span class="spin row-spin' + (updatingProducts.has(product.id) ? '' : ' hidden') + '" data-spin-pid="' + product.id + '"></span>' +
                (product.image
                    ? '<img src="' + escapeHtml(product.image) + '" alt="" />'
                    : '') +
                '<span>' + escapeHtml(product.name) + '</span> ' + badge +
                '</div></td>' +
                priceCell('buyPrice', Number(market.buyPrice) || 0) +
                priceCell('sellPrice', Number(market.sellPrice) || 0) +
                input('goldShopPrice', product.goldShopPrice) +
                input('goldShopAmount', product.goldShopAmount) +
                '<td class="gold-unit" data-gold-unit="' + product.id + '">' + goldUnit + '</td>' +
                '<td class="market-td">' + renderMarketCell(product) + '</td>' +
                '</tr>';

            const sellersRow =
                '<tr class="sellers-row' + (expanded ? '' : ' hidden') + '" ' +
                'data-sellers="' + product.id + '" data-name="' +
                escapeHtml(product.name.toLowerCase()) + '">' +
                '<td colspan="7">' + renderSellersDetail(product) + '</td></tr>';

            return mainRow + sellersRow;
        })
        .join('');

    openModal(
        '<h3>База товаров</h3>' +
        '<div class="products-toolbar">' +
        '<input id="product-search" type="search" placeholder="Поиск по названию…" value="' +
        escapeHtml(productsUI.query) + '" />' +
        '<div class="add-product">' +
        '<input id="add-product-id" type="number" min="1" placeholder="id товара" />' +
        '<button class="btn" id="add-product-btn">Добавить по ID</button>' +
        '</div>' +
        '<button class="btn" id="update-all-prices">Обновить цены всех</button>' +
        '<button class="btn" id="update-all-prices-carry" ' +
        'title="Обновить рынок всех товаров, а когда очередь дойдёт до конца — перенести рыночные цены скупа и продажи в ручные. Всплески предложений уже отсеяны; скачки относительно ручной цены пропускаются и помечаются">Обновить и перенести цены всех</button>' +
        '</div>' +
        '<p class="meta-line">Каждая цена в две строки: сверху ручная (если ' +
        'заполнена, расчёты используют её), снизу автоматическая с рынка ' +
        '(только чтение, обновляется кнопками цен). Цена покупки стоит слева, ' +
        'она обычно больше цены продажи. «Цена в шопе» — в голде за партию, ' +
        '«Кол-во за цену» — сколько штук за эту цену, «Цена за шт (из голды)» ' +
        'считается сама: курс голды × цена в шопе / кол-во. Курс голды ' +
        'задаётся в Настройках. В списке продавцов и покупателей метка ' +
        '«свой кот» — это ваша витрина, её цена в рынок не входит.</p>' +
        '<div class="table-wrap"><table>' +
        '<thead><tr>' +
        '<th>Товар</th><th>Цена покупки</th><th>Цена продажи</th>' +
        '<th>Цена в шопе (голда)</th><th>Кол-во за цену</th>' +
        '<th>Цена за шт (из голды)</th><th>Рынок</th>' +
        '</tr></thead>' +
        '<tbody>' +
        (rows || '<tr><td colspan="7">Товаров нет</td></tr>') +
        '</tbody>' +
        '</table></div>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-primary" data-close>Готово</button>' +
        '</div>',
        true
    );

    bindProductsEvents();
}

function bindProductsEvents() {
    modalBody
        .querySelectorAll('[data-close]')
        .forEach(b => b.addEventListener('click', async () => {
            state.productsModalOpen = false;
            await loadState();
            closeModal();
            renderContent();
        }));

    const search = document.getElementById('product-search');

    search.addEventListener('input', () => {
        productsUI.query = search.value;
        productsUI.focusId = null;

        syncProductsVisibility();
    });

    document.getElementById('add-product-btn').addEventListener('click', async () => {
        const idInput = document.getElementById('add-product-id');
        const externalId = idInput.value.trim();

        if (!externalId) {
            alert('Введите id товара.');
            return;
        }

        try {
            const created = await api('POST', '/api/products', { externalId });

            idInput.value = '';

            await loadState();

            productsUI.focusId = null;
            productsUI.query = '';
            productsUI.expanded.add(created.product.id);

            openProducts();
            startQueuePolling();
        } catch (error) {
            alert(error.message);
        }
    });

    document.getElementById('update-all-prices').addEventListener('click', async () => {
        try {
            await api('POST', '/api/products/update-all-prices');
            startQueuePolling();
        } catch (error) {
            alert(error.message);
        }
    });

    document.getElementById('update-all-prices-carry').addEventListener('click', async () => {
        if (state.products.length === 0) {
            alert('Нет товаров для обновления.');
            return;
        }

        if (
            !confirm(
                'Обновить рынок всех товаров, а когда очередь дойдёт до конца — ' +
                'перенести рыночные цены скупа и продажи в ручные поля? ' +
                'Цены с резким скачком относительно ручной будут пропущены и помечены.'
            )
        ) {
            return;
        }

        try {
            await api('POST', '/api/products/update-all-prices-carry');

            // Перенос — последнее задание очереди, ждём её опросом.
            startQueuePolling();
        } catch (error) {
            alert(error.message);
        }
    });

    modalBody.querySelectorAll('input[data-p][data-f]').forEach(input => {
        input.addEventListener('change', async () => {
            const id = input.getAttribute('data-p');
            const field = input.getAttribute('data-f');

            try {
                const updated = await api('PUT', '/api/products/' + id, {
                    [field]: Number(input.value) || 0
                });

                const index = state.products.findIndex(p => p.id === id);

                if (index !== -1) {
                    state.products[index] = updated;
                }

                // Цена из голды производная — пересчитываем её на месте,
                // не перерисовывая таблицу (иначе теряется фокус ввода).
                const cell = modalBody.querySelector(
                    '[data-gold-unit="' + id + '"]'
                );

                if (cell) {
                    cell.innerHTML = updated.goldUnitPrice > 0
                        ? money(updated.goldUnitPrice)
                        : '<span class="muted-val">—</span>';
                }
            } catch (error) {
                alert(error.message);
            }
        });
    });

    modalBody.querySelectorAll('[data-act="apply"]').forEach(button => {
        button.addEventListener('click', async () => {
            const id = button.getAttribute('data-p');
            const side = button.getAttribute('data-side');

            try {
                const updated = await api(
                    'PUT',
                    '/api/products/' + id + '/apply-market',
                    { side }
                );

                const index = state.products.findIndex(p => p.id === id);
                if (index !== -1) {
                    state.products[index] = updated;
                }

                const field = side === 'buy' ? 'buyPrice' : 'sellPrice';
                const input = modalBody.querySelector(
                    'input[data-p="' + id + '"][data-f="' + field + '"]'
                );
                if (input) {
                    input.value = updated[field] || 0;
                }
            } catch (error) {
                alert(error.message);
            }
        });
    });

    /*
     * Обновление цены товара: обычная постановка в очередь и «сразу» —
     * в начало, чтобы товар обработался следующим.
     */
    modalBody.querySelectorAll('[data-act^="upd-price"]').forEach(button => {
        button.addEventListener('click', async () => {
            const id = button.getAttribute('data-p');

            try {
                await api('POST', '/api/products/' + id + '/update-price', {
                    front: button.getAttribute('data-act') === 'upd-price-front'
                });

                startQueuePolling();
            } catch (error) {
                alert(error.message);
            }
        });
    });

    modalBody.querySelectorAll('[data-act="toggle-sellers"]').forEach(button => {
        button.addEventListener('click', () => {
            const id = button.getAttribute('data-p');

            if (productsUI.expanded.has(id)) {
                productsUI.expanded.delete(id);
            } else {
                productsUI.expanded.add(id);
            }

            syncProductsVisibility();
        });
    });

    syncProductsVisibility();
}

/*
|--------------------------------------------------------------------------
| SETTINGS
|--------------------------------------------------------------------------
*/

function renderGoldBoard() {
    const board = state.settings.goldBoard;

    if (!board || (!board.buy.length && !board.sell.length)) {
        return (
            '<div class="field"><label>Биржа голды</label>' +
            '<div class="meta-line">Нет данных. Обновите хотя бы одного кота — ' +
            'курс подтянется со страницы автоматически.</div></div>'
        );
    }

    const rows = (list, cls) =>
        list
            .slice(0, 5)
            .map(
                row =>
                    '<span class="badge ' + cls + '">' +
                    money(row.price) + ' · ' + quantity(row.amount) +
                    '</span>'
            )
            .join(' ');

    return (
        '<div class="field">' +
        '<label>Биржа голды (сервер ' + escapeHtml(board.server || '?') +
        ', ' + escapeHtml(board.catName || '') + ', ' +
        formatDate(board.updatedAt) + ')</label>' +
        '<div class="meta-line" style="margin-bottom:6px">Покупка: ' +
        (rows(board.buy, 'ok') || '—') + '</div>' +
        '<div class="meta-line" style="margin-bottom:8px">Продажа: ' +
        (rows(board.sell, 'warn') || '—') + '</div>' +
        '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-small" id="gold-apply-buy">Курс покупки: ' +
        money(board.bestBuy) + '</button>' +
        '<button class="btn btn-small" id="gold-apply-sell">Курс продажи: ' +
        money(board.bestSell) + '</button>' +
        '</div>' +
        '</div>'
    );
}

function openSettings() {
    openModal(
        '<h3>Настройки</h3>' +
        '<div class="grid-2">' +
        '<div class="field">' +
        '<label>Курс голды (голда → золото игры)</label>' +
        '<input id="set-gold" type="number" min="0" step="any" value="' +
        (state.settings.goldPrice || 0) + '" />' +
        '</div>' +
        '<div class="field">' +
        '<label>Интервал между обновлениями, мс</label>' +
        '<input id="set-interval" type="number" min="1000" step="500" value="' +
        (state.settings.updateIntervalMs || 7000) + '" />' +
        '</div>' +
        '<div class="field">' +
        '<label>Сервер для рынка товаров</label>' +
        '<input id="set-market-server" type="text" value="' +
        escapeHtml(state.settings.marketServer || '146') + '" />' +
        '</div>' +
        '<div class="field">' +
        '<label>Порог отклонения цены (доля, 0.3 = 30%)</label>' +
        '<input id="set-deviation" type="number" min="0.01" max="5" step="0.05" value="' +
        (state.settings.priceDeviationThreshold || 0.3) + '" />' +
        '</div>' +
        '</div>' +
        '<p class="meta-line">Если рыночная цена товара изменится сильнее порога — ' +
        'это могут быть последствия бага comeback (показаны не все продавцы). ' +
        'Такой товар помечается и снова ставится в очередь на обновление позже.</p>' +
        renderGoldBoard() +
        '<div class="modal-actions">' +
        '<button class="btn" data-close>Отмена</button>' +
        '<button class="btn btn-primary" id="set-save">Сохранить</button>' +
        '</div>'
    );

    modalBody
        .querySelectorAll('[data-close]')
        .forEach(b => b.addEventListener('click', closeModal));

    const goldInput = document.getElementById('set-gold');
    const board = state.settings.goldBoard;

    if (board) {
        const applyBuy = document.getElementById('gold-apply-buy');
        const applySell = document.getElementById('gold-apply-sell');

        if (applyBuy) {
            applyBuy.addEventListener('click', () => {
                goldInput.value = board.bestBuy || 0;
            });
        }

        if (applySell) {
            applySell.addEventListener('click', () => {
                goldInput.value = board.bestSell || 0;
            });
        }
    }

    document.getElementById('set-save').addEventListener('click', async () => {
        try {
            await api('PUT', '/api/settings', {
                goldPrice: Number(goldInput.value) || 0,
                updateIntervalMs:
                    Number(document.getElementById('set-interval').value) || 7000,
                marketServer:
                    document.getElementById('set-market-server').value.trim() || '146',
                priceDeviationThreshold:
                    Number(document.getElementById('set-deviation').value) || 0.3
            });

            // Пересчитываем рекомендованные цены/прибыль на сервере.
            await loadState();

            closeModal();
            renderCatList();
            renderContent();
        } catch (error) {
            alert(error.message);
        }
    });
}

/*
|--------------------------------------------------------------------------
| STATISTICS
|--------------------------------------------------------------------------
*/

function statsCards(s) {
    return (
        '<div class="stats">' +
        statCard('Продано', quantity(s.sold)) +
        statCard('Куплено', quantity(s.bought)) +
        statCard('Выручка', money(s.revenue)) +
        statCard('Закупки', money(s.purchaseCost)) +
        statCard('Докупка', money(s.restockCost)) +
        statCard('Прибыль', money(s.profit), profitColorClass(s.profit)) +
        '</div>'
    );
}

function itemsBreakdown(items) {
    if (!items || items.length === 0) {
        return '<span class="muted-val">нет движений</span>';
    }

    return items
        .map(
            entry =>
                '<span class="breakdown-item">' +
                escapeHtml(entry.name) + ': ' +
                (entry.sold > 0
                    ? '<span class="pos">продано ' + quantity(entry.sold) + '</span>'
                    : '') +
                (entry.sold > 0 && entry.bought > 0 ? ', ' : '') +
                (entry.bought > 0
                    ? '<span class="neg">куплено ' + quantity(entry.bought) + '</span>'
                    : '') +
                '</span>'
        )
        .join('<br>');
}

function periodsTable(periods) {
    if (!periods || periods.length === 0) {
        return '<div class="meta-line">Закрытых периодов пока нет.</div>';
    }

    const rows = periods
        .map(
            p =>
                '<tr>' +
                '<td>' + formatDate(p.createdAt) + '</td>' +
                '<td>' + quantity(p.sold) + '</td>' +
                '<td>' + quantity(p.bought) + '</td>' +
                '<td>' + money(p.revenue) + '</td>' +
                '<td class="' + profitColorClass(p.profit) + '">' +
                money(p.profit) + '</td>' +
                '<td class="breakdown-cell">' + itemsBreakdown(p.items) + '</td>' +
                '</tr>'
        )
        .join('');

    return (
        '<div class="table-wrap"><table>' +
        '<thead><tr><th>Закрыт</th><th>Продано</th><th>Куплено</th>' +
        '<th>Выручка</th><th>Прибыль</th><th>Товары</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table></div>'
    );
}

async function openCatStats(cat) {
    try {
        const data = await api('GET', '/api/stats/cat/' + cat.id);

        openModal(
            '<h3>Статистика: ' + escapeHtml(cat.name) + '</h3>' +
            '<div class="meta-line">Текущий период</div>' +
            statsCards(data.current) +
            '<div class="breakdown-box">' +
            itemsBreakdown(data.currentItems) +
            '</div>' +
            '<div class="meta-line">Накопительно (с закрытыми периодами)</div>' +
            statsCards(data.cumulative) +
            '<div class="meta-line" style="margin-top:12px">История периодов</div>' +
            periodsTable(data.periods) +
            '<div class="modal-actions">' +
            '<button class="btn btn-primary" data-close>Закрыть</button>' +
            '</div>'
        );

        modalBody
            .querySelectorAll('[data-close]')
            .forEach(b => b.addEventListener('click', closeModal));
    } catch (error) {
        alert(error.message);
    }
}

async function openAllStats() {
    try {
        const data = await api('GET', '/api/stats/all');

        const rows = data.cats
            .map(
                cat =>
                    '<tr>' +
                    '<td>' + escapeHtml(cat.name) + '</td>' +
                    '<td>' + quantity(cat.current.sold) + '</td>' +
                    '<td>' + quantity(cat.current.bought) + '</td>' +
                    '<td>' + money(cat.current.revenue) + '</td>' +
                    '<td class="' + profitColorClass(cat.current.profit) + '">' +
                    money(cat.current.profit) + '</td>' +
                    '<td class="' + profitColorClass(cat.cumulative.profit) + '">' +
                    money(cat.cumulative.profit) + '</td>' +
                    '</tr>'
            )
            .join('');

        openModal(
            '<h3>Сводная статистика</h3>' +
            '<div class="meta-line">Текущий период (все коты)</div>' +
            statsCards(data.total) +
            '<div class="meta-line">Накопительно (все коты, все периоды)</div>' +
            statsCards(data.cumulativeTotal) +
            '<div class="table-wrap"><table>' +
            '<thead><tr><th>Кот</th><th>Продано</th><th>Куплено</th>' +
            '<th>Выручка</th><th>Прибыль (период)</th><th>Прибыль (накопл.)</th></tr></thead>' +
            '<tbody>' + (rows || '<tr><td colspan="6">Нет данных</td></tr>') + '</tbody>' +
            '</table></div>' +
            '<div class="modal-actions">' +
            '<button class="btn btn-primary" data-close>Закрыть</button>' +
            '</div>'
        );

        modalBody
            .querySelectorAll('[data-close]')
            .forEach(b => b.addEventListener('click', closeModal));
    } catch (error) {
        alert(error.message);
    }
}

/*
 * Глобальные действия над всеми котами — они на верхней панели,
 * потому что сброс/перенос нужны сразу после отчёта, а не внутри него.
 */
async function carryAllCats() {
    if (!confirm('Перенести текущие количества в «должно быть» у всех котов?')) {
        return;
    }

    try {
        await api('POST', '/api/cats/carry-all');

        await reloadKeepingView();
    } catch (error) {
        alert(error.message);
    }
}

async function resetAllCats() {
    if (
        !confirm(
            'Сброс всех: текущие периоды будут дописаны в статистику, ' +
            'а текущие количества перенесены в «должно быть». Продолжить?'
        )
    ) {
        return;
    }

    try {
        await api('POST', '/api/reset-all');

        // У всех котов дописан закрытый период — сбрасываем весь кэш рядов.
        state.daily = {};

        await reloadKeepingView();
    } catch (error) {
        alert(error.message);
    }
}

/*
|--------------------------------------------------------------------------
| BOOT
|--------------------------------------------------------------------------
*/

document.getElementById('btn-add-cat').addEventListener('click', () => catDialog(null));
document.getElementById('btn-update-all').addEventListener('click', () => updateAllCats(false));
document.getElementById('btn-carry-all').addEventListener('click', carryAllCats);
document.getElementById('btn-reset-all').addEventListener('click', resetAllCats);
document.getElementById('btn-products').addEventListener('click', () => {
    productsUI.focusId = null;

    openProducts();
});
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-all-stats').addEventListener('click', openAllStats);

(async function boot() {
    try {
        await loadState();

        if (state.cats.length > 0) {
            state.selectedCatId = state.cats[0].id;
        }

        renderCatList();
        renderContent();

        startQueuePolling();
    } catch (error) {
        document.getElementById('content').innerHTML =
            '<div class="empty">Не удалось загрузить данные: ' +
            escapeHtml(error.message) + '</div>';
    }
})();
