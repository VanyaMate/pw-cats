'use strict';

const { db, save } = require('./db');
const { toNumber, now } = require('./util');

/*
 * Оптовый перенос рыночных цен в ручные поля товара.
 *
 * Берём ровно те цифры, которые показывает кнопка «перенести» у
 * отдельного товара: market.buyPrice и market.sellPrice. Из них
 * market.js уже выбросил всплески предложений, так что в перенос не
 * попадают дорогие заявки с маленьким объёмом.
 *
 * Второй уровень защиты — скачок: если у товара уже была ручная цена и
 * новая отличается от неё больше чем на порог отклонения из Настроек,
 * цену оставляем, а прописываем пометку carrySkip. Иначе один неудачный
 * проход рынка переписал бы половину базы.
 *
 * Пометка снимается, когда цена снова приходит в пределах порога.
 */
function applyMarketPricesToAll() {
    const threshold = toNumber(db.settings.priceDeviationThreshold, 0.3);

    const summary = { applied: 0, skipped: 0, unchanged: 0 };

    for (const product of db.products) {
        const market = product.market || {};

        let touched = false;

        for (const side of ['buy', 'sell']) {
            const field = side === 'buy' ? 'buyPrice' : 'sellPrice';

            const incoming = toNumber(market[field]);
            const current = toNumber(product[field]);

            if (incoming <= 0) {
                continue;
            }

            const jumped =
                current > 0 &&
                Math.abs(incoming - current) / current > threshold;

            product.carrySkip = product.carrySkip || {};

            if (jumped) {
                product.carrySkip[side] = {
                    from: current,
                    to: incoming,
                    at: now()
                };

                summary.skipped++;
                touched = true;

                continue;
            }

            if (product.carrySkip[side]) {
                delete product.carrySkip[side];

                touched = true;
            }

            if (current !== incoming) {
                product[field] = incoming;

                summary.applied++;
                touched = true;
            } else {
                summary.unchanged++;
            }
        }

        if (!Object.keys(product.carrySkip).length) {
            delete product.carrySkip;
        }

        if (touched) {
            product.configured =
                product.buyPrice > 0 ||
                product.sellPrice > 0 ||
                product.goldShopPrice > 0 ||
                product.goldPrice > 0;

            product.updatedAt = now();
        }
    }

    save();

    return { ok: true, ...summary };
}

module.exports = {
    applyMarketPricesToAll
};
