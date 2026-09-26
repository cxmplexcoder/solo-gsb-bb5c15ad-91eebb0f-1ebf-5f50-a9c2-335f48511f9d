'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  doc: null, // 当前文稿
  pendingSel: null, // 旧稿中待添加批注的选区 {start, end}
  manualFor: null, // 正在手动定位的批注 id
};

// ---------- 工具 ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

function saved() {
  $('saveHint').textContent = `已保存 ${new Date().toLocaleTimeString()}`;
}

/** 计算选区节点在容器内的字符偏移（容器由若干文本节点组成） */
function offsetOf(container, node, offset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return pos + offset;
    pos += n.textContent.length;
  }
  return pos;
}

/** 读取容器内当前选区的 [start, end)，无选区返回 null */
function selectionRange(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return null;
  const a = offsetOf(container, sel.anchorNode, sel.anchorOffset);
  const b = offsetOf(container, sel.focusNode, sel.focusOffset);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return end > start ? { start, end } : null;
}

/**
 * 把文本渲染为带高亮的 HTML（marks: [{start, end, cls, aid}]）。
 * 支持重叠：在所有区间边界处切分文本，被多条批注覆盖的片段使用 hl-overlap 样式，
 * 并把全部批注 id 写入 data-aids，保证重叠范围内的每条批注都能被查看和选中，
 * 不会像简单平铺那样跳过后续批注。
 */
function renderWithMarks(text, marks) {
  const valid = marks
    .filter((m) => m.start != null && m.end != null && m.start < m.end)
    .sort((a, b) => a.start - b.start);
  if (!valid.length) return escapeHtml(text);
  const cuts = new Set([0, text.length]);
  for (const m of valid) {
    cuts.add(m.start);
    cuts.add(m.end);
  }
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    if (s >= e) continue;
    const seg = escapeHtml(text.slice(s, e));
    const covering = valid.filter((m) => m.start <= s && m.end >= e);
    if (!covering.length) {
      html += seg;
    } else if (covering.length === 1) {
      html += `<mark class="${covering[0].cls}" data-aids="${covering[0].aid}">${seg}</mark>`;
    } else {
      const aids = covering.map((m) => m.aid).join(' ');
      html += `<mark class="hl-overlap" data-aids="${aids}" title="${covering.length} 条批注在此重叠，点击查看全部">${seg}</mark>`;
    }
  }
  return html;
}

// ---------- 文稿管理 ----------

async function refreshDocList(selectId) {
  const docs = await api('GET', '/api/documents');
  const sel = $('docSelect');
  sel.innerHTML = docs
    .map((d) => `<option value="${d.id}">${escapeHtml(d.title)}（批注 ${d.annotationCount}）</option>`)
    .join('');
  if (selectId && docs.some((d) => d.id === selectId)) sel.value = selectId;
  return docs;
}

async function loadDoc(id) {
  state.doc = await api('GET', `/api/documents/${id}`);
  state.pendingSel = null;
  state.manualFor = null;
  $('emptyState').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('annotForm').classList.add('hidden');
  $('manualBanner').classList.add('hidden');
  $('oldInput').value = state.doc.oldText || '';
  $('newInput').value = state.doc.newText || '';
  $('oldMsg').textContent = '';
  $('migrateMsg').textContent = '';
  renderOldView();
  renderAnnotList();
  renderResults();
}

// ---------- ① 旧稿与批注 ----------

function renderOldView() {
  const doc = state.doc;
  if (!doc) return;
  const marks = doc.annotations.map((a) => ({
    start: a.oldStart, end: a.oldEnd, cls: 'hl-old', aid: a.id,
  }));
  $('oldView').innerHTML = renderWithMarks(doc.oldText || '', marks);
}

function renderAnnotList() {
  const doc = state.doc;
  if (!doc) return;
  $('annotCount').textContent = `共 ${doc.annotations.length} 条`;
  $('annotList').innerHTML = doc.annotations
    .map((a) => `
      <div class="annot-card">
        <div class="quote">${escapeHtml(a.quote)}</div>
        <div class="comment">${escapeHtml(a.comment)}</div>
        <div class="ops">
          <button class="danger small" data-del="${a.id}">删除</button>
        </div>
      </div>`)
    .join('') || '<p class="hint">暂无批注：在上方旧稿中框选文字即可添加。</p>';
  $('annotList').querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('删除这条批注？')) return;
      state.doc = await api('DELETE', `/api/documents/${state.doc.id}/annotations/${btn.dataset.del}`);
      renderOldView();
      renderAnnotList();
      renderResults();
      saved();
    });
  });
}

// ---------- ② 新稿与迁移 ----------

const STATUS_LABEL = {
  matched: '已定位',
  manual: '人工指定',
  pending: '待处理',
  unmigrated: '未迁移',
};
const REASON_LABEL = {
  unique: '新稿中仅出现一次',
  context: '多处出现，已按前后文区分',
  not_found: '新稿中未找到原文（可能已删除或改写）',
  ambiguous: '多处出现且前后文相近，需人工选择',
  human: '由人工指定位置',
};

function snippet(text, start, end) {
  const before = text.slice(Math.max(0, start - 15), start);
  const mid = text.slice(start, end);
  const after = text.slice(end, end + 15);
  return `…${escapeHtml(before)}<b>【${escapeHtml(mid)}】</b>${escapeHtml(after)}…`;
}

function renderResults() {
  const doc = state.doc;
  if (!doc) return;
  const text = doc.newText || '';
  hideOverlapPicker();

  // 左栏：新稿 + 高亮（重叠段不跳过后续批注，点击可逐条查看）
  const marks = doc.annotations
    .filter((a) => a.newStart != null)
    .map((a) => ({
      start: a.newStart,
      end: a.newEnd,
      cls: a.status === 'manual' ? 'hl-manual' : a.status === 'matched' ? 'hl-matched' : 'hl-pending',
      aid: a.id,
    }));
  $('newView').innerHTML = renderWithMarks(text, marks);
  $('newView').querySelectorAll('mark[data-aids]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      const aids = el.dataset.aids.split(' ');
      if (aids.length === 1) flashCard(aids[0]);
      else showOverlapPicker(ev.clientX, ev.clientY, aids);
    });
  });

  // 批注 → 所属重叠组 的索引，用于在卡片上标注
  const groupOf = new Map();
  (doc.overlapGroups || []).forEach((g) => g.members.forEach((m) => groupOf.set(m.id, g)));

  // 右栏：批注卡片
  $('resultList').innerHTML = doc.annotations
    .map((a) => {
      const cands = (a.candidates || [])
        .map((c, i) => `
          <button class="candidate" data-aid="${a.id}" data-start="${c.start}" data-end="${c.end}">
            候选${i + 1}：${snippet(text, c.start, c.end)}
            <span class="score">${c.fuzzy ? `相似度 ${c.score}` : `上下文得分 ${c.score}`}</span>
          </button>`)
        .join('');
      const pos = a.newStart != null
        ? `<div class="hint">位置：${snippet(text, a.newStart, a.newEnd)}</div>`
        : '';
      const g = groupOf.get(a.id);
      const overlapBadge = g
        ? `<span class="badge badge-overlap" title="与第 ${g.id} 组内其他批注范围重叠">⚠ 重叠组 ${g.id}</span>`
        : '';
      return `
        <div class="result-card st-${a.status}" data-card="${a.id}">
          <div class="ops">
            <span class="badge badge-${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
            ${overlapBadge}
            <span class="hint">${REASON_LABEL[a.reason] || ''}</span>
          </div>
          <div class="quote">${escapeHtml(a.quote)}</div>
          <div class="comment">${escapeHtml(a.comment)}</div>
          ${pos}
          ${cands ? `<div class="hint">可选位置：</div>${cands}` : ''}
          <div class="ops">
            <button class="ghost small" data-manual="${a.id}">手动定位</button>
          </div>
        </div>`;
    })
    .join('') || '<p class="hint">暂无批注。</p>';

  $('resultList').querySelectorAll('[data-manual]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = state.doc.annotations.find((x) => x.id === btn.dataset.manual);
      state.manualFor = a.id;
      $('manualQuote').textContent = a.quote;
      $('manualBanner').classList.remove('hidden');
      $('newView').focus();
    });
  });
  $('resultList').querySelectorAll('.candidate').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await setPosition(btn.dataset.aid, Number(btn.dataset.start), Number(btn.dataset.end));
    });
  });

  renderOverlapGroups();
}

// ---------- 重叠复核 ----------

/** 滚动到指定批注卡片并闪烁提示 */
function flashCard(aid) {
  const card = $('resultList').querySelector(`[data-card="${aid}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1200);
}

/** 重叠段被点击时弹出选择器，列出该处全部批注，逐条可选 */
function showOverlapPicker(x, y, aids) {
  hideOverlapPicker();
  const doc = state.doc;
  const menu = document.createElement('div');
  menu.id = 'overlapPicker';
  menu.className = 'overlap-picker';
  menu.innerHTML =
    `<div class="picker-title">此处有 ${aids.length} 条批注重叠，选择要查看的一条：</div>` +
    aids
      .map((aid) => {
        const a = doc.annotations.find((x2) => x2.id === aid);
        if (!a) return '';
        return `
          <button class="picker-item" data-pick="${aid}">
            <span class="badge badge-${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
            <span class="picker-comment">${escapeHtml(a.comment)}</span>
            <span class="picker-quote">${escapeHtml(a.quote)}</span>
          </button>`;
      })
      .join('');
  document.body.appendChild(menu);
  // 防止超出视口
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 12))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 12))}px`;
  menu.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      hideOverlapPicker();
      flashCard(btn.dataset.pick);
    });
  });
  // 点击选择器外部时关闭（延迟绑定，避开触发本次打开的点击）
  setTimeout(() => document.addEventListener('click', onPickerOutsideClick), 0);
}

function onPickerOutsideClick(e) {
  const p = $('overlapPicker');
  if (p && !p.contains(e.target)) hideOverlapPicker();
}

function hideOverlapPicker() {
  const p = $('overlapPicker');
  if (p) p.remove();
  document.removeEventListener('click', onPickerOutsideClick);
}

/** 渲染重叠复核面板：列出每个冲突组的全部批注及范围 */
function renderOverlapGroups() {
  const doc = state.doc;
  const groups = (doc && doc.overlapGroups) || [];
  const panel = $('overlapPanel');
  if (!groups.length) {
    panel.classList.add('hidden');
    $('overlapList').innerHTML = '';
    return;
  }
  const text = doc.newText || '';
  panel.classList.remove('hidden');
  $('overlapCount').textContent =
    `共 ${groups.length} 组冲突；修改任一位置后自动重算，待处理/未迁移批注不参与分组`;
  $('overlapList').innerHTML = groups
    .map((g) => {
      const members = g.members
        .map((m) => `
          <div class="group-member">
            <span class="badge badge-${m.status}">${STATUS_LABEL[m.status] || m.status}</span>
            <span class="range">[${m.newStart}, ${m.newEnd})</span>
            <span class="quote">${escapeHtml(m.quote)}</span>
            <span class="comment">${escapeHtml(m.comment)}</span>
            <button class="ghost small" data-goto="${m.id}">查看卡片</button>
          </div>`)
        .join('');
      return `
        <div class="overlap-group">
          <div class="group-head">
            <b>第 ${g.id} 组</b>
            <span class="badge badge-${g.type}">${g.type === 'identical' ? '完全相同' : '部分交叠'}</span>
            <span class="hint">覆盖范围 [${g.start}, ${g.end})：${snippet(text, g.start, g.end)}</span>
            <button class="ghost small" data-jump="${g.id}">跳转到新稿位置</button>
          </div>
          ${members}
        </div>`;
    })
    .join('');
  $('overlapList').querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => jumpToGroup(Number(btn.dataset.jump)));
  });
  $('overlapList').querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => flashCard(btn.dataset.goto));
  });
}

/** 在左侧新稿中滚动到冲突组位置，并闪烁该组所有高亮片段 */
function jumpToGroup(gid) {
  const g = (state.doc.overlapGroups || []).find((x) => x.id === gid);
  if (!g) return;
  const ids = new Set(g.members.map((m) => m.id));
  const segs = [...$('newView').querySelectorAll('mark[data-aids]')].filter((el) =>
    el.dataset.aids.split(' ').some((id) => ids.has(id))
  );
  if (!segs.length) return;
  segs[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  segs.forEach((el) => el.classList.add('flash'));
  setTimeout(() => segs.forEach((el) => el.classList.remove('flash')), 1200);
}

async function setPosition(aid, start, end) {
  state.doc = await api(
    'PUT',
    `/api/documents/${state.doc.id}/annotations/${aid}/position`,
    { start, end }
  );
  state.manualFor = null;
  $('manualBanner').classList.add('hidden');
  renderResults();
  saved();
  toast('位置已保存');
}

async function migrate() {
  state.doc = await api('POST', `/api/documents/${state.doc.id}/migrate`);
  renderResults();
  saved();
  const matched = state.doc.annotations.filter((a) => a.status === 'matched').length;
  const pending = state.doc.annotations.filter((a) => a.status === 'pending').length;
  const msg = `迁移完成：已定位 ${matched} 条，待处理 ${pending} 条`;
  $('migrateMsg').textContent = msg;
  toast(msg);
}

// ---------- 事件绑定 ----------

$('btnNewDoc').addEventListener('click', async () => {
  const title = prompt('文稿标题：', '未命名文稿');
  if (title === null) return;
  const doc = await api('POST', '/api/documents', { title });
  await refreshDocList(doc.id);
  await loadDoc(doc.id);
  saved();
});

$('btnDeleteDoc').addEventListener('click', async () => {
  if (!state.doc || !confirm(`删除文稿「${state.doc.title}」及其全部批注？`)) return;
  await api('DELETE', `/api/documents/${state.doc.id}`);
  state.doc = null;
  const docs = await refreshDocList();
  if (docs.length) await loadDoc(docs[0].id);
  else {
    $('workspace').classList.add('hidden');
    $('emptyState').classList.remove('hidden');
  }
});

$('docSelect').addEventListener('change', (e) => loadDoc(e.target.value));

$('btnSaveOld').addEventListener('click', async () => {
  try {
    const { doc, dropped } = await api('PUT', `/api/documents/${state.doc.id}/old`, {
      oldText: $('oldInput').value,
    });
    state.doc = doc;
    renderOldView();
    renderAnnotList();
    renderResults();
    saved();
    $('oldMsg').textContent = dropped ? `已保存；${dropped} 条批注因超出新文稿范围被移除` : '已保存';
    toast('旧稿已保存');
  } catch (e) {
    alert(e.message);
  }
});

// 在旧稿中框选文字 → 弹出批注表单
$('oldView').addEventListener('mouseup', () => {
  setTimeout(() => {
    if (!state.doc || !state.doc.oldText) return;
    const range = selectionRange($('oldView'));
    if (!range) return;
    state.pendingSel = range;
    $('annotQuote').textContent = `选中：${state.doc.oldText.slice(range.start, range.end)}`;
    $('annotComment').value = '';
    $('annotForm').classList.remove('hidden');
    $('annotComment').focus();
  }, 0);
});

$('btnAddAnnot').addEventListener('click', async () => {
  if (!state.pendingSel) return;
  try {
    state.doc = await api('POST', `/api/documents/${state.doc.id}/annotations`, {
      start: state.pendingSel.start,
      end: state.pendingSel.end,
      comment: $('annotComment').value,
    });
    state.pendingSel = null;
    $('annotForm').classList.add('hidden');
    window.getSelection().removeAllRanges();
    renderOldView();
    renderAnnotList();
    saved();
    toast('批注已添加');
  } catch (e) {
    alert(e.message);
  }
});

$('btnCancelAnnot').addEventListener('click', () => {
  state.pendingSel = null;
  $('annotForm').classList.add('hidden');
});

$('btnSaveNewMigrate').addEventListener('click', async () => {
  try {
    state.doc = await api('PUT', `/api/documents/${state.doc.id}/new`, {
      newText: $('newInput').value,
    });
    await migrate();
  } catch (e) {
    alert(e.message);
  }
});

$('btnRemigrate').addEventListener('click', async () => {
  try {
    await migrate();
  } catch (e) {
    alert(e.message);
  }
});

// 手动定位模式下，在新稿中框选文字即作为该批注的位置
$('newView').addEventListener('mouseup', () => {
  setTimeout(async () => {
    if (!state.manualFor || !state.doc) return;
    const range = selectionRange($('newView'));
    if (!range) return;
    window.getSelection().removeAllRanges();
    await setPosition(state.manualFor, range.start, range.end);
  }, 0);
});

$('btnCancelManual').addEventListener('click', () => {
  state.manualFor = null;
  $('manualBanner').classList.add('hidden');
});

// ---------- 启动 ----------

(async () => {
  const docs = await refreshDocList();
  if (docs.length) await loadDoc(docs[0].id);
  else $('emptyState').classList.remove('hidden');
})().catch((e) => alert(e.message));
