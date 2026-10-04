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

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准；停用探头名下的记录不参与判定
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const stopped = {};
  for (const p of data.probes) if (p.status === '停用') stopped[p.id] = true;
  const active = rows.filter((r) => !stopped[r.probeId]);
  const picked = {};
  const order = [];
  for (const row of active) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    if (row.source === '人工') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开；每段时长按相邻记录的实际时刻差累加
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  let lastPointAt = '';
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      if (current) {
        current.minutes += store.minutesBetween(lastPointAt, row.at);
        current.endAt = row.at;
        current.peakC = value > current.peakC ? value : current.peakC;
        current.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      lastPointAt = row.at;
    } else {
      current = null;
      lastPointAt = '';
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

// 断链：相邻记录的时刻差超过门槛；缺口时长按实际时刻差算
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: minutes });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT（平均动力学温度）：MKT = -Ea / (R * ln((Σ e^(-Ea/(R*T))) / n)) - 273.15，T 用开尔文；
// 不是把温度取平均。没有参与计算的记录时返回 null（不能算，不能当作 0）。
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return null;
  const ea = Number(settings.mktActivationEnergy);
  const r = Number(settings.gasConstant);
  const n = rows.length;
  let sum = 0;
  for (const row of rows) {
    const kelvin = Number(row.temperatureC) + 273.15;
    sum += Math.exp(-ea / (r * kelvin));
  }
  const mktKelvin = -ea / (r * Math.log(sum / n));
  return store.round(mktKelvin - 273.15, 2);
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

// 记录覆盖充分性：参与判定的有效记录要覆盖整个在库时段。
// 在库窗口 = 入库时刻 到 判定时刻（在库/待放行）或放行/拒收时刻（已决）。
// 头部/尾部缺口按实际时刻差算，内部缺口就是断链（首尾各容忍一个记录间隔）。
function coverageStats(data, batch) {
  const settings = data.settings;
  const interval = Number(settings.recordIntervalMinutes);
  const tolerance = interval; // 入库后的第一条、当前的最后一条，允许晚/早一个记录间隔
  const rows = effectiveRecords(data, batch.id);
  const rawCount = recordsOfBatch(data, batch.id).length;

  let endAt = '';
  if (batch.status === '已放行' || batch.status === '已拒收') {
    endAt = batch.decidedAt || '';
    if (!endAt) {
      const decided = data.releases
        .filter((r) => r.batchId === batch.id)
        .map((r) => r.decidedAt)
        .sort()
        .pop();
      endAt = decided || '';
    }
  }
  if (!endAt) endAt = store.nowText();
  const startAt = String(batch.loadedAt || '');

  // 已决批次只看决定时刻之前（含）的记录，决定之后补录的不改变当时的覆盖情况
  const windowRows = endAt && (batch.status === '已放行' || batch.status === '已拒收')
    ? rows.filter((r) => r.at <= endAt)
    : rows;

  const missing = [];
  if (!windowRows.length) {
    missing.push({
      kind: 'all',
      from: startAt,
      to: endAt,
      minutes: startAt ? store.minutesBetween(startAt, endAt) : 0,
      text: '一条有效温度记录都没有，在库时段 ' + (startAt || '?') + ' 至 ' + endAt + ' 全程无记录覆盖',
    });
    return {
      startAt, endAt, intervalMinutes: interval,
      rawRecordCount: rawCount, effectiveRecordCount: 0,
      expectedCount: 0, missingCount: 0, missingMinutes: missing.reduce((a, m) => a + m.minutes, 0),
      gaps: missing, sufficient: false,
    };
  }

  const firstAt = windowRows[0].at;
  const lastAt = windowRows[windowRows.length - 1].at;

  const head = startAt ? store.minutesBetween(startAt, firstAt) : 0;
  if (startAt && head > tolerance) {
    missing.push({ kind: 'head', from: startAt, to: firstAt, minutes: head, text: '入库后 ' + head + ' 分钟（' + startAt + ' 至 ' + firstAt + '）没有温度记录' });
  }
  const tail = store.minutesBetween(lastAt, endAt);
  if (tail > tolerance) {
    missing.push({ kind: 'tail', from: lastAt, to: endAt, minutes: tail, text: '最近一条记录在 ' + lastAt + '，到 ' + endAt + ' 已有 ' + tail + ' 分钟没有记录覆盖' });
  }
  for (let i = 1; i < windowRows.length; i += 1) {
    const minutes = store.minutesBetween(windowRows[i - 1].at, windowRows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      missing.push({ kind: 'gap', from: windowRows[i - 1].at, to: windowRows[i].at, minutes, text: windowRows[i - 1].at + ' 至 ' + windowRows[i].at + ' 间隔 ' + minutes + ' 分钟无记录（断链）' });
    }
  }

  // 应有条数：窗口时长按记录间隔折算（至少 1 条），头部容忍一个间隔
  const windowMinutes = startAt ? Math.max(0, store.minutesBetween(startAt, endAt) - tolerance) : 0;
  const expectedCount = Math.max(1, Math.floor(windowMinutes / interval) + 1);
  const missingMinutes = missing.reduce((a, m) => a + m.minutes, 0);
  return {
    startAt, endAt, intervalMinutes: interval,
    rawRecordCount: rawCount, effectiveRecordCount: windowRows.length,
    expectedCount, missingCount: windowRows.length < expectedCount ? expectedCount - windowRows.length : 0,
    missingMinutes, gaps: missing,
    sufficient: missing.length === 0,
  };
}

// 放行判定：先看数据是否足以判定，再看最长超限、累计超限、断链、探头校准四条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = accumulatedExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const coverage = coverageStats(data, batch);

  // 数据闸：一条有效记录都没有、或记录覆盖不住在库时段，直接“数据不足，不能放行”，
  // 四条温度判据此时没有评价意义，不再逐条给出满足。
  const conditions = [];
  let verdict = 'pass';
  let verdictText = '满足放行条件';
  let pass = true;
  let failed = [];

  if (!coverage.sufficient) {
    verdict = 'insufficient';
    verdictText = '数据不足，不能放行';
    pass = false;
    failed = ['coverage'];
  } else {
    conditions.push(
      { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
      { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟（按批次周期累计，跨月不重置）' },
      { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
      { key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在校准有效期内' }
    );
    pass = conditions.every((c) => c.ok);
    failed = conditions.filter((c) => !c.ok).map((c) => c.key);
    if (!pass) { verdict = 'fail'; verdictText = '未满足放行条件'; }
  }

  return {
    verdict,
    verdictText,
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    coverage,
    conditions,
    pass,
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
  coverageStats,
  releaseCheck,
};
