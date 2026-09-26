'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  VERDICTS,
  REVIEWABLE_STATUS,
  bindingOf,
  reconcileReviews,
  reviewStats,
  isReviewable,
} = require('../lib/review');

const NEW_TEXT = '第一段：苹果很美味。第二段：香蕉很新鲜。';

function locatedAnn(over = {}) {
  return {
    id: 'a1',
    quote: '苹果',
    comment: '此处用词待商榷',
    status: 'matched',
    newStart: 4,
    newEnd: 6,
    review: null,
    ...over,
  };
}

function docWith(annotations, newText = NEW_TEXT) {
  return { newText, annotations };
}

/** 模拟复核签收：按当前文档状态写入结论与绑定值 */
function sign(doc, a, verdict = 'approved', note = '已核对') {
  a.review = {
    verdict,
    note,
    reviewedAt: new Date().toISOString(),
    binding: bindingOf(doc, a),
  };
}

test('复核结论记录备注、时间与绑定值', () => {
  const a = locatedAnn();
  const doc = docWith([a]);
  sign(doc, a, 'needs_adjustment', '区间偏左');
  assert.equal(a.review.verdict, 'needs_adjustment');
  assert.equal(a.review.note, '区间偏左');
  assert.ok(a.review.reviewedAt);
  assert.equal(a.review.binding.quote, '苹果');
  assert.equal(a.review.binding.comment, '此处用词待商榷');
  assert.equal(a.review.binding.status, 'matched');
  assert.equal(a.review.binding.newStart, 4);
  assert.equal(a.review.binding.newEnd, 6);
  assert.ok(/^[a-f0-9]{64}$/.test(a.review.binding.newTextHash));
});

test('重复迁移得到完全相同的结果 → 结论保留', () => {
  const a = locatedAnn();
  const doc = docWith([a]);
  sign(doc, a);
  // 重新迁移：status/newStart/newEnd 与上次完全一致（新稿、批注均未变）
  const cleared = reconcileReviews(doc);
  assert.equal(cleared, 0);
  assert.equal(a.review.verdict, 'approved');
});

test('新稿全文改变 → 结论自动清除', () => {
  const a = locatedAnn();
  const doc = docWith([a]);
  sign(doc, a);
  doc.newText = NEW_TEXT + '追加一句。';
  assert.equal(reconcileReviews(doc), 1);
  assert.equal(a.review, null);
});

test('批注原文改变（如保存旧稿后重算 quote）→ 结论清除', () => {
  const a = locatedAnn();
  const doc = docWith([a]);
  sign(doc, a);
  a.quote = '苹果很美味';
  assert.equal(reconcileReviews(doc), 1);
  assert.equal(a.review, null);
});

test('批注内容（comment）改变 → 结论清除', () => {
  const a = locatedAnn();
  const doc = docWith([a]);
  sign(doc, a);
  a.comment = '修改后的批注';
  assert.equal(reconcileReviews(doc), 1);
  assert.equal(a.review, null);
});

test('迁移状态改变（matched → pending/manual）→ 结论清除', () => {
  const a = locatedAnn();
  const doc = docWith([a]);
  sign(doc, a);

  a.status = 'pending'; // 重新迁移后找不到位置
  a.newStart = null;
  a.newEnd = null;
  assert.equal(reconcileReviews(doc), 1);
  assert.equal(a.review, null);

  // 人工重新指定到不同位置后也不应复活旧结论
  a.status = 'manual';
  a.newStart = 10;
  a.newEnd = 12;
  assert.equal(reconcileReviews(doc), 0);
  assert.equal(a.review, null);
});

test('新区间改变 → 结论清除；区间不变则保留', () => {
  const a = locatedAnn({ status: 'manual' });
  const doc = docWith([a]);
  sign(doc, a);
  a.newEnd = 8;
  assert.equal(reconcileReviews(doc), 1);
  assert.equal(a.review, null);

  sign(doc, a); // 对新位置重新签收
  assert.equal(reconcileReviews(doc), 0);
  assert.ok(a.review);
});

test('未复核的批注不受核对影响', () => {
  const a = locatedAnn();
  const b = locatedAnn({ id: 'a2' });
  const doc = docWith([a, b]);
  sign(doc, a);
  doc.newText = '全新的文稿。';
  assert.equal(reconcileReviews(doc), 1); // 只清除 a 的结论
  assert.equal(b.review, null);
});

test('仅已定位/人工指定可复核，待处理与未迁移不能核准', () => {
  assert.ok(isReviewable(locatedAnn({ status: 'matched' })));
  assert.ok(isReviewable(locatedAnn({ status: 'manual' })));
  assert.ok(!isReviewable(locatedAnn({ status: 'pending' })));
  assert.ok(!isReviewable(locatedAnn({ status: 'unmigrated' })));
  assert.deepEqual(REVIEWABLE_STATUS, ['matched', 'manual']);
  assert.deepEqual(VERDICTS, ['approved', 'needs_adjustment']);
});

test('复核统计：已核准 / 需调整 / 待复核（待处理与未迁移不计入）', () => {
  const doc = docWith([
    locatedAnn({ id: 'a1' }),
    locatedAnn({ id: 'a2', status: 'manual' }),
    locatedAnn({ id: 'a3' }),
    locatedAnn({ id: 'a4', status: 'pending', newStart: null, newEnd: null }),
    locatedAnn({ id: 'a5', status: 'unmigrated', newStart: null, newEnd: null }),
  ]);
  sign(doc, doc.annotations[0], 'approved');
  sign(doc, doc.annotations[1], 'needs_adjustment');
  const s = reviewStats(doc.annotations);
  assert.deepEqual(s, { approved: 1, needsAdjustment: 1, unreviewed: 1 });
});

test('旧文稿缺少复核字段 → 视为未复核，统计不报错', () => {
  const a = locatedAnn();
  delete a.review; // 模拟旧数据
  const s = reviewStats([a]);
  assert.deepEqual(s, { approved: 0, needsAdjustment: 0, unreviewed: 1 });
  assert.equal(reconcileReviews(docWith([a])), 0);
});
