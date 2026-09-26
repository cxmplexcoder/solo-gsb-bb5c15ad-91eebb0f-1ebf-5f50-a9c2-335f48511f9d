'use strict';

/**
 * 人工复核签收。
 *
 * 规则：
 *  - 仅「已定位（matched）/ 人工指定（manual）」的批注可标记复核结论
 *    （已核准 approved / 需调整 needs_adjustment）；待处理、未迁移批注不能核准；
 *  - 每条结论都绑定签署当时的状态：新稿全文（SHA-256 指纹）、批注原文与内容、
 *    迁移状态及新区间——任一绑定值改变，旧结论即不再适用于当前情形；
 *  - 任何写盘前调用 reconcileReviews 核对：绑定值一致的结论保留
 *    （重复迁移得到完全相同的结果时结论自然保留），不一致的一律自动清除，
 *    避免旧核准误用于新位置。
 */

const crypto = require('crypto');

const VERDICTS = ['approved', 'needs_adjustment'];

/** 可复核的迁移状态 */
const REVIEWABLE_STATUS = ['matched', 'manual'];

/** 新稿全文指纹：绑定的是「当时的新稿全文」，内容一变指纹即变 */
function newTextHash(newText) {
  return crypto.createHash('sha256').update(String(newText || '')).digest('hex');
}

/** 复核结论的绑定值：新稿全文指纹 + 批注原文与内容 + 迁移状态 + 新区间 */
function bindingOf(doc, a) {
  return {
    newTextHash: newTextHash(doc.newText),
    quote: a.quote,
    comment: a.comment,
    status: a.status,
    newStart: a.newStart,
    newEnd: a.newEnd,
  };
}

function sameBinding(x, y) {
  return (
    Boolean(x && y) &&
    x.newTextHash === y.newTextHash &&
    x.quote === y.quote &&
    x.comment === y.comment &&
    x.status === y.status &&
    x.newStart === y.newStart &&
    x.newEnd === y.newEnd
  );
}

function isReviewable(a) {
  return REVIEWABLE_STATUS.includes(a.status);
}

/**
 * 核对全部批注的复核结论，清除绑定值已失效的结论。
 * @returns {number} 被清除的结论条数
 */
function reconcileReviews(doc) {
  let cleared = 0;
  for (const a of doc.annotations || []) {
    if (!a.review) continue;
    if (!sameBinding(a.review.binding, bindingOf(doc, a))) {
      a.review = null;
      cleared++;
    }
  }
  return cleared;
}

/**
 * 当前有效的复核数量统计。
 * unreviewed 仅统计「可复核但尚未复核」的批注（已定位/人工指定），
 * 待处理、未迁移批注不可复核，不计入。
 */
function reviewStats(annotations) {
  const stats = { approved: 0, needsAdjustment: 0, unreviewed: 0 };
  for (const a of annotations || []) {
    if (a.review && a.review.verdict === 'approved') stats.approved++;
    else if (a.review && a.review.verdict === 'needs_adjustment') stats.needsAdjustment++;
    else if (isReviewable(a)) stats.unreviewed++;
  }
  return stats;
}

module.exports = {
  VERDICTS,
  REVIEWABLE_STATUS,
  bindingOf,
  reconcileReviews,
  reviewStats,
  isReviewable,
};
