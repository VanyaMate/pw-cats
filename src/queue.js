'use strict';

const { db } = require('./db');
const { sleep, now, createId } = require('./util');

/*
 * Единая очередь обновлений. Все запросы к comeback.pw (обновление кота,
 * обновление рыночной цены товара) проходят через неё ПО ОЧЕРЕДИ с
 * интервалом, без параллельных запросов, чтобы не забанили.
 *
 * Поддерживает отложенный повтор (deferredUntil) и ретраи — нужно для
 * обхода бага comeback, когда отдаёт не всех продавцов.
 */

const queue = [];

/*
 * Журнал выполненных задач. Фронт опрашивает очередь и по seq понимает,
 * что задача только что закончилась, — после этого он перезагружает
 * данные и перерисовывает таблицы, не дожидаясь, пока очередь опустеет.
 */
const completed = [];

const COMPLETED_LIMIT = 60;

let seq = 0;

/*
 * Отмена увеличивает поколение: задачи, поставленные до отмены, больше
 * не возвращаются в очередь (повтор при подозрительной цене).
 */
let generation = 0;

let workerRunning = false;
let current = null;

function intervalMs() {
    return Math.max(1000, Number(db.settings.updateIntervalMs) || 7000);
}

function makeJob(type, refId, name, task, options) {
    const opts = options || {};

    return {
        id: type + ':' + refId,
        jobId: createId(),
        type,
        refId,
        name: name || type,
        task,
        retries: 0,
        maxRetries: opts.maxRetries === undefined ? 3 : opts.maxRetries,
        deferredUntil: 0,
        enqueuedAt: now(),
        generation,
        lastError: null
    };
}

function remember(job, result) {
    seq += 1;

    const error = result && result.error ? result.error : null;

    completed.push({
        seq,
        id: job.id,
        type: job.type,
        refId: job.refId,
        name: job.name,
        ok: !error,
        error,
        retries: job.retries,
        at: now()
    });

    if (completed.length > COMPLETED_LIMIT) {
        completed.splice(0, completed.length - COMPLETED_LIMIT);
    }
}

function startWorker() {
    if (workerRunning) {
        return;
    }

    workerRunning = true;

    (async () => {
        try {
            while (queue.length) {
                const readyIndex = queue.findIndex(
                    job => job.deferredUntil <= Date.now()
                );

                if (readyIndex === -1) {
                    const nextTime = Math.min(
                        ...queue.map(job => job.deferredUntil)
                    );

                    await sleep(Math.max(250, nextTime - Date.now()));

                    continue;
                }

                const job = queue.splice(readyIndex, 1)[0];

                current = {
                    id: job.id,
                    type: job.type,
                    name: job.name,
                    retries: job.retries,
                    startedAt: now()
                };

                let result = null;

                try {
                    result = await job.task(job);
                } catch (error) {
                    job.lastError = error.message;
                    result = { error: error.message };
                }

                current = null;

                remember(job, result);

                if (
                    result &&
                    result.requeue &&
                    job.generation === generation &&
                    job.retries < job.maxRetries
                ) {
                    job.retries += 1;
                    job.deferredUntil =
                        Date.now() + (result.deferMs || intervalMs());

                    queue.push(job);
                }

                await sleep(intervalMs());
            }
        } finally {
            workerRunning = false;
            current = null;
        }
    })();
}

/*
 * options.front — поставить в начало очереди, чтобы задача выполнилась
 * сразу после текущей (интервал между запросами всё равно сохраняется).
 */
function enqueue(job, options) {
    const index = queue.findIndex(item => item.id === job.id);

    if (index !== -1) {
        queue.splice(index, 1);
    }

    job.generation = generation;

    if (options && options.front) {
        queue.unshift(job);
    } else {
        queue.push(job);
    }

    startWorker();

    return true;
}

function enqueueIfAbsent(job) {
    if (queue.some(item => item.id === job.id)) {
        return false;
    }

    job.generation = generation;

    queue.push(job);

    startWorker();

    return true;
}

/*
 * Отменить очередь: сбрасываем всё, что ещё не началось. Текущая задача
 * уже в работе — её не прерываем (запрос к comeback всё равно уйдёт),
 * но в повтор она больше не встанет.
 */
function cancel() {
    const removed = queue.length;

    queue.length = 0;

    generation += 1;

    return { removed, current: current ? current.id : null };
}

/*
 * Сколько задач ещё ждут своей очереди (текущая в работе не считается:
 * она уже выбрана из очереди). Нужно заданиям вроде «переноса цен»,
 * которые обязаны идти строго после всех обновлений.
 */
function pendingCount() {
    return queue.length;
}

function status() {
    return {
        running: workerRunning,
        intervalMs: intervalMs(),
        current,
        length: queue.length,
        lastSeq: seq,
        completed: completed.slice(-12),
        items: queue.map(job => ({
            id: job.id,
            type: job.type,
            name: job.name,
            retries: job.retries,
            maxRetries: job.maxRetries,
            deferred: job.deferredUntil > Date.now(),
            deferredUntil: job.deferredUntil
        }))
    };
}

module.exports = {
    makeJob,
    enqueue,
    enqueueIfAbsent,
    cancel,
    pendingCount,
    status
};
