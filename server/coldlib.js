// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    if (current.source === '人工' && row.source === '自动') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const previous = current;
      if (previous) {
        previous.endAt = row.at;
        previous.minutes += previous.lastGapMinutes || 0;
        previous.peakC = value > previous.peakC ? value : previous.peakC;
        previous.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度
function mktCelsius(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return null;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

// 数据充分性：一条有效记录都没有、或者记录覆盖不住在库时段
//（入库→首条记录、末条记录→判定参考时刻之间存在超过断链门槛的空档），都算数据不足
function coverageStats(data, batch, referenceAt) {
  const settings = data.settings;
  const gapLimit = Number(settings.chainGapMinutes);
  const rows = effectiveRecords(data, batch.id);
  const refAt = referenceAt || store.nowText();
  const isNow = !referenceAt;
  const issues = [];
  const spanMinutes = (a, b) => Math.max(0, store.minutesBetween(a, b));

  if (!rows.length) {
    const minutes = spanMinutes(batch.loadedAt, refAt);
    issues.push({
      key: 'noRecord',
      text: '没有任何有效温度记录',
      detail: '批次自 ' + batch.loadedAt + ' 入库以来一条有效温度记录都没有，无法判定全程温度是否合格',
      from: batch.loadedAt,
      to: refAt,
      minutes,
    });
    return {
      adequate: false, referenceAt: refAt, recordCount: 0,
      requiredFrom: batch.loadedAt, requiredTo: refAt,
      firstAt: '', lastAt: '', issues, uncoveredMinutes: minutes,
    };
  }

  const firstAt = rows[0].at;
  const lastAt = rows[rows.length - 1].at;
  const headMinutes = spanMinutes(batch.loadedAt, firstAt);
  if (headMinutes > gapLimit) {
    issues.push({
      key: 'headGap',
      text: '入库后到首条记录之间没有温度覆盖',
      detail: '入库时刻 ' + batch.loadedAt + ' 到首条记录 ' + firstAt + ' 之间有 ' + headMinutes + ' 分钟没有任何温度记录（门槛 ' + gapLimit + ' 分钟），缺少这段时间的温度覆盖',
      from: batch.loadedAt,
      to: firstAt,
      minutes: headMinutes,
    });
  }
  const tailMinutes = spanMinutes(lastAt, refAt);
  if (tailMinutes > gapLimit) {
    const endDesc = isNow ? '当前' : '判定时刻 ' + refAt;
    issues.push({
      key: 'tailGap',
      text: '末条记录之后到' + (isNow ? '当前' : '判定时刻') + '没有温度覆盖',
      detail: '末条记录 ' + lastAt + ' 之后到' + endDesc + ' 有 ' + tailMinutes + ' 分钟没有任何温度记录（门槛 ' + gapLimit + ' 分钟），缺少这段时间的温度覆盖',
      from: lastAt,
      to: refAt,
      minutes: tailMinutes,
    });
  }

  return {
    adequate: issues.length === 0, referenceAt: refAt, recordCount: rows.length,
    requiredFrom: batch.loadedAt, requiredTo: refAt,
    firstAt, lastAt, issues,
    uncoveredMinutes: issues.reduce((acc, i) => acc + i.minutes, 0),
  };
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

// 判定参考时刻：在办批次看当前（返回 null 表示用当前时刻）；已经有放行/拒收结论的批次回看当时决定时刻
function referenceAtFor(data, batch) {
  if (batch.status === '在库' || batch.status === '待放行' || !batch.status) return null;
  if (batch.decidedAt) return batch.decidedAt;
  const releases = data.releases.filter((r) => r.batchId === batch.id).sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
  return releases.length ? releases[0].decidedAt : null;
}

// 放行判定：数据充分性是前置闸门；之后再看最长超限、累计超限、断链、探头校准四条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const referenceAt = referenceAtFor(data, batch);
  const coverage = coverageStats(data, batch, referenceAt);
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const conditions = [
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
    { key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在校准有效期内' },
  ];
  const criteriaPass = conditions.every((c) => c.ok);
  const failed = conditions.filter((c) => !c.ok).map((c) => c.key);
  let verdict;
  let conclusion;
  if (!coverage.adequate) {
    verdict = 'insufficientData';
    conclusion = '数据不足，不能放行';
    failed.push('data');
  } else if (criteriaPass) {
    verdict = 'pass';
    conclusion = '满足放行条件';
  } else {
    verdict = 'fail';
    conclusion = '未满足放行条件';
  }
  return {
    verdict,
    conclusion,
    dataAdequate: coverage.adequate,
    coverage,
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    conditions,
    pass: coverage.adequate && criteriaPass,
    failed,
  };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  coverageStats,
  referenceAtFor,
  releaseCheck,
};
