'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { locate, CONTEXT_LEN } = require('./lib/match');
const { computeOverlapGroups } = require('./lib/overlap');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DOCS_DIR = path.join(DATA_DIR, 'documents');

fs.mkdirSync(DOCS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 存储（每份文稿一个 JSON 文件） ----------

function docFile(id) {
  return path.join(DOCS_DIR, `${id}.json`);
}

function loadDoc(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  const f = docFile(id);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveDoc(doc) {
  doc.updatedAt = new Date().toISOString();
  fs.writeFileSync(docFile(doc.id), JSON.stringify(doc, null, 2));
}

function summary(doc) {
  return {
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    annotationCount: doc.annotations.length,
    pendingCount: doc.annotations.filter((a) => a.status === 'pending').length,
    hasOldText: Boolean(doc.oldText),
    hasNewText: Boolean(doc.newText),
  };
}

function resetMigration(a) {
  a.status = 'unmigrated';
  a.reason = null;
  a.newStart = null;
  a.newEnd = null;
  a.candidates = [];
}

/**
 * 返回给前端的文稿视图：附带按当前位置即时计算的重叠冲突组。
 * 派生数据不写入磁盘，每次迁移、人工定位或任何位置变动后随响应重新计算。
 */
function docJson(doc) {
  return { ...doc, overlapGroups: computeOverlapGroups(doc.annotations) };
}

function notFound(res) {
  res.status(404).json({ error: '文稿不存在' });
}

// ---------- API ----------

// 文稿列表
app.get('/api/documents', (req, res) => {
  const docs = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), 'utf8')))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(summary);
  res.json(docs);
});

// 新建文稿
app.post('/api/documents', (req, res) => {
  const title = String((req.body && req.body.title) || '').trim() || '未命名文稿';
  const now = new Date().toISOString();
  const doc = {
    id: crypto.randomBytes(8).toString('hex'),
    title,
    oldText: '',
    newText: '',
    annotations: [],
    createdAt: now,
    updatedAt: now,
  };
  saveDoc(doc);
  res.status(201).json(docJson(doc));
});

// 文稿详情
app.get('/api/documents/:id', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  res.json(docJson(doc));
});

// 删除文稿
app.delete('/api/documents/:id', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  fs.unlinkSync(docFile(doc.id));
  res.json({ ok: true });
});

// 保存/替换旧稿：按已有批注的偏移量重算选中文本与前后文，越界批注被移除
app.put('/api/documents/:id/old', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const oldText = req.body && req.body.oldText;
  if (typeof oldText !== 'string' || !oldText.trim()) {
    return res.status(400).json({ error: '旧稿内容不能为空' });
  }
  doc.oldText = oldText;
  let dropped = 0;
  doc.annotations = doc.annotations.filter((a) => {
    if (a.oldEnd > oldText.length) {
      dropped++;
      return false;
    }
    a.quote = oldText.slice(a.oldStart, a.oldEnd);
    a.prefix = oldText.slice(Math.max(0, a.oldStart - CONTEXT_LEN), a.oldStart);
    a.suffix = oldText.slice(a.oldEnd, a.oldEnd + CONTEXT_LEN);
    resetMigration(a);
    return true;
  });
  saveDoc(doc);
  res.json({ doc: docJson(doc), dropped });
});

// 添加批注（记录选中文本及其前后文，供迁移时消歧）
app.post('/api/documents/:id/annotations', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const { start, end, comment } = req.body || {};
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > doc.oldText.length ||
    start >= end
  ) {
    return res.status(400).json({ error: '选区无效' });
  }
  if (!comment || !String(comment).trim()) {
    return res.status(400).json({ error: '批注内容不能为空' });
  }
  const a = {
    id: crypto.randomBytes(8).toString('hex'),
    oldStart: start,
    oldEnd: end,
    quote: doc.oldText.slice(start, end),
    prefix: doc.oldText.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: doc.oldText.slice(end, end + CONTEXT_LEN),
    comment: String(comment).trim(),
    createdAt: new Date().toISOString(),
  };
  resetMigration(a);
  doc.annotations.push(a);
  saveDoc(doc);
  res.status(201).json(docJson(doc));
});

// 删除批注
app.delete('/api/documents/:id/annotations/:aid', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const before = doc.annotations.length;
  doc.annotations = doc.annotations.filter((a) => a.id !== req.params.aid);
  if (doc.annotations.length === before) {
    return res.status(404).json({ error: '批注不存在' });
  }
  saveDoc(doc);
  res.json(docJson(doc));
});

// 保存/替换新稿：所有批注的迁移结果作废，需重新迁移
app.put('/api/documents/:id/new', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const newText = req.body && req.body.newText;
  if (typeof newText !== 'string' || !newText.trim()) {
    return res.status(400).json({ error: '新稿内容不能为空' });
  }
  doc.newText = newText;
  doc.annotations.forEach(resetMigration);
  saveDoc(doc);
  res.json(docJson(doc));
});

// 执行迁移：对每条批注在新稿中重新定位
app.post('/api/documents/:id/migrate', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  if (!doc.newText) return res.status(400).json({ error: '请先保存新稿' });
  for (const a of doc.annotations) {
    const r = locate(a, doc.newText);
    a.status = r.status;
    a.reason = r.reason;
    a.newStart = r.newStart;
    a.newEnd = r.newEnd;
    a.candidates = r.candidates;
  }
  saveDoc(doc);
  res.json(docJson(doc));
});

// 人工指定批注在新稿中的位置（采用候选或框选后调用）
app.put('/api/documents/:id/annotations/:aid/position', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const a = doc.annotations.find((x) => x.id === req.params.aid);
  if (!a) return res.status(404).json({ error: '批注不存在' });
  const { start, end } = req.body || {};
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > doc.newText.length ||
    start >= end
  ) {
    return res.status(400).json({ error: '位置无效' });
  }
  a.newStart = start;
  a.newEnd = end;
  a.status = 'manual';
  a.reason = 'human';
  saveDoc(doc);
  res.json(docJson(doc));
});

app.listen(PORT, () => {
  console.log(`文稿批注迁移工具已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
