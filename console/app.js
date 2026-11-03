/** MemStack console app — views, i18n, drawer, dialogs, import/export. Native ESM, no build. */

import { createGraphView } from './graph3d.js'

const KIND_ORDER = ['decision', 'constraint', 'gotcha', 'preference', 'open-question']
const STAGE_ORDER = ['fresh', 'stable', 'fading', 'dormant']
const STAGE_COLOR = { fresh: 'var(--ok)', stable: 'var(--accent)', fading: 'var(--warn)', dormant: 'var(--bad)' }

const ICONS = {
  pin: '<path d="M9 4h6l-1 6 4 3v2H6v-2l4-3-1-6Z"/><path d="M12 15v5"/>',
  pinOff: '<path d="M9 4h6l-1 6 4 3v2h-6"/><path d="M12 15v5"/>',
  review: '<path d="M4 12a8 8 0 1 1 2.4 5.7"/><path d="M4 20v-5h5"/><path d="m9 12 2 2 4-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  archive: '<path d="M4 5h16v4H4z"/><path d="M6 9v10h12V9"/><path d="M10 13h4"/>',
  restore: '<path d="M4 12a8 8 0 1 0 8-8"/><path d="M4 4v6h6"/>',
  graph: '<circle cx="6" cy="7" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="12" cy="18" r="2"/><path d="m8 8 3 8m5-8-3 8M8 7h8"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
}

const I18N = {
  zh: {
    brandSub: '记忆图谱',
    navGraph: '图谱', navMemories: '记忆', navBanks: '记忆库', navData: '数据',
    connected: '本地', searchPh: '搜索主题 / 结论 / 标签 / 否决方案',
    refresh: '刷新', newEntry: '新建记忆',
    viewGraphTitle: '记忆图谱',
    viewGraphSub: (n, m, r) => `${n} 个节点 · ${m} 条关系 · 平均留存 ${r}%`,
    viewMemTitle: '记忆',
    viewMemSub: '按留存率浏览、复习与编辑；留存量决定它被注入的概率，而不是真假',
    viewBanksTitle: '记忆库',
    viewBanksSub: '按工作区隔离；主题库可跨项目复用，全局库存长期偏好',
    viewDataTitle: '数据',
    viewDataSub: '导出、导入与备份；JSON bundle 可在机器之间搬迁',
    graphFilters: '筛选', autoRotate: '自动旋转', toggle3d: '2D', toggle3dBack: '3D', resetView: '重置视角',
    graphEmptyTitle: '还没有可显示的节点', graphEmptyHint: '写入一条记忆后，这里会长出第一颗节点；也可以放宽左侧筛选。',
    graphHint: '拖拽旋转 · 滚轮缩放 · 点击查看详情',
    bankNode: (n) => `${n} 条记忆`,
    loadMore: '显示更多',
    newBankTitle: '新建主题库', newBankHint: '跨项目领域知识，可关联到任意工作区',
    bankNamePh: '库名称', bankDescPh: '一句话描述（出现在可检索提示里）', createBank: '创建',
    linksTitle: '库关联', linksHint: '注入 = 把对方条目放进上下文；检索 = 允许 agent 主动查询',
    sourceBank: '源库',
    exportTitle: '导出', exportHint: '可迁移到另一台机器',
    exportBody: 'JSON bundle 包含全部历史（含已取代条目）；Markdown 适合进 git 或直接阅读。',
    exportJson: '导出 JSON bundle', exportMd: '导出 Markdown', dataFile: '数据文件',
    importTitle: '导入', importHint: '合并或整库替换，导入前自动备份',
    dropTitle: '拖入 bundle，或点击选择', dropHint: '支持 memstack.bundle.json 与旧版 state.json',
    importMerge: '合并（保留双方）', importReplace: '替换（清空本地）', importRun: '开始导入',
    statsTitle: '分布', reviewTitle: '待复习', reviewHint: '留存率最低的记忆，确认后会更牢固',
    fieldBank: '记忆库', fieldKind: '类型', fieldTopic: '主题键', fieldClaim: '结论（一句话）',
    fieldDetail: '详情 / 依据', fieldTags: '标签（逗号分隔）', fieldRejected: '已否决的方案',
    addRejected: '+ 添加一条', fieldPin: '固定（不参与预算截断、衰减更慢）',
    cancel: '取消', save: '保存', editBank: '编辑记忆库', fieldTitle: '名称', fieldDesc: '描述', confirm: '确认',
    editEntry: '编辑记忆', createEntry: '新建记忆',
    kind: { decision: '决策', constraint: '约束', gotcha: '坑', preference: '偏好', 'open-question': '未决' },
    status: { active: '生效', superseded: '已取代', archived: '已停用', candidate: '候选' },
    stage: { fresh: '新鲜', stable: '稳定', fading: '淡化', dormant: '沉寂' },
    bankKind: { workspace: '工作区', topic: '主题库', global: '全局' },
    sort: { retentionAsc: '留存率低→高', retentionDesc: '留存率高→低', updated: '最近更新', created: '最近创建', topic: '主题' },
    filterAll: '全部', filterStatus: '状态', filterKind: '类型', filterEdge: '关系',
    edge: { contains: '归属', supersede: '取代', relation: '显式关系', topic: '主题同族', tag: '同标签', 'bank-link': '库关联' },
    rel: { related: '相关', refines: '细化', depends: '依赖', contradicts: '矛盾' },
    action: { pin: '固定', unpin: '取消固定', review: '复习', archive: '停用', restore: '启用', edit: '编辑', delete: '删除', open: '查看' },
    pinBadge: '固定', stale: '待复习',
    count: (shown, total) => `显示 ${shown} / ${total} 条`,
    noMemories: '没有匹配的记忆。换个筛选条件，或新建一条。',
    metrics: { entries: '条目', active: '生效', retention: '平均留存' },
    bankActions: { graph: '在图谱中查看', edit: '编辑', archive: '停用', restore: '启用', delete: '删除' },
    linkRecall: '注入', linkQuery: '可检索', onlyBank: '只有一个库时没有可关联对象',
    stageDist: '留存分布', kindDist: '类型分布', reviewEmpty: '没有需要复习的记忆',
    importReport: '导入报告', backup: '备份', conflicts: '冲突',
    reportBanks: (a, m) => `库：新增 ${a} · 匹配 ${m}`,
    reportEntries: (a, s, r) => `条目：新增 ${a} · 跳过 ${s} · 重映射 ${r}`,
    reportLinks: (a, s) => `关联：新增 ${a} · 跳过 ${s}`,
    sectionDetail: '详情', sectionRejected: '已否决', sectionRelations: '关系', sectionChain: '取代链', sectionMeta: '元信息', sectionDecay: '留存',
    noDetail: '（无详情）', noRelations: '（暂无关系）', addRelation: '添加', relationTarget: '目标条目', relationType: '类型',
    meta: { bank: '记忆库', created: '创建', updated: '更新', recalled: '被注入', reviewed: '复习', confidence: '置信', due: '下次复习', stability: '稳定度', age: '已过' },
    confidence: { verified: '已验证', tentative: '待验证' },
    retention: '留存率', days: '天', reviewNow: '确认仍成立', markOutdated: '标记过时',
    bankOverview: '记忆库概览', openBank: '查看库内记忆',
    confirmDeleteEntry: '永久删除这条记忆？被它取代的旧结论会自动恢复为生效。',
    confirmDeleteBank: '删除这个库及其中全部条目？此操作不可恢复。',
    confirmReplace: '替换会清空本地全部记忆，只保留导入文件中的内容。确定继续？',
    toastSaved: '已保存', toastDeleted: '已删除', toastReviewed: '已复习，留存率已重置', toastArchived: '已停用',
    toastRestored: '已启用', toastImported: '导入完成', toastCopied: '已复制',
    opFailed: '操作失败：', loadFailed: '加载失败：', importFailed: '导入失败：', fileReadFailed: '文件读取失败：',
    offline: '连接断开', online: '本地',
    confirmTitle: '确认操作',
    relationAdded: '关系已建立', relationRemoved: '关系已移除', reviewHintQueue: '先确认结论是否仍成立，再点击复习。',
    demoNote: '演示数据', allBanks: '全部库',
  },
  en: {
    brandSub: 'memory graph',
    navGraph: 'Graph', navMemories: 'Memories', navBanks: 'Banks', navData: 'Data',
    connected: 'local', searchPh: 'Search topic / claim / tags / rejected',
    refresh: 'Refresh', newEntry: 'New memory',
    viewGraphTitle: 'Memory graph',
    viewGraphSub: (n, m, r) => `${n} nodes · ${m} relations · ${r}% retention`,
    viewMemTitle: 'Memories',
    viewMemSub: 'Browse, review and edit by retention — decay changes recall odds, not truth',
    viewBanksTitle: 'Banks',
    viewBanksSub: 'Workspace-scoped by default; topic banks are reusable across projects',
    viewDataTitle: 'Data',
    viewDataSub: 'Export, import and back up; the JSON bundle moves between machines',
    graphFilters: 'Filters', autoRotate: 'Auto-rotate', toggle3d: '2D', toggle3dBack: '3D', resetView: 'Reset view',
    graphEmptyTitle: 'No nodes to show', graphEmptyHint: 'Record a memory to grow the first node, or relax the filters.',
    graphHint: 'Drag to rotate · scroll to zoom · click for details',
    bankNode: (n) => `${n} memories`,
    loadMore: 'Show more',
    newBankTitle: 'New topic bank', newBankHint: 'Cross-project knowledge, linkable to any workspace',
    bankNamePh: 'Bank name', bankDescPh: 'One-line description (shown in the searchable hint)', createBank: 'Create',
    linksTitle: 'Bank links', linksHint: 'Inject = put entries in context; query = allow the agent to search them',
    sourceBank: 'Source bank',
    exportTitle: 'Export', exportHint: 'Portable to another machine',
    exportBody: 'The JSON bundle keeps full history (including superseded entries); Markdown is for git or reading.',
    exportJson: 'Export JSON bundle', exportMd: 'Export Markdown', dataFile: 'Data file',
    importTitle: 'Import', importHint: 'Merge or replace; a backup is written first',
    dropTitle: 'Drop a bundle, or click to choose', dropHint: 'memstack.bundle.json or a legacy state.json',
    importMerge: 'Merge (keep both)', importReplace: 'Replace (wipe local)', importRun: 'Import',
    statsTitle: 'Distribution', reviewTitle: 'Needs review', reviewHint: 'Lowest retention first; confirming makes them stick',
    fieldBank: 'Bank', fieldKind: 'Kind', fieldTopic: 'Topic key', fieldClaim: 'Claim (one sentence)',
    fieldDetail: 'Detail / rationale', fieldTags: 'Tags (comma separated)', fieldRejected: 'Rejected approaches',
    addRejected: '+ Add one', fieldPin: 'Pin (no budget cut, slower decay)',
    cancel: 'Cancel', save: 'Save', editBank: 'Edit bank', fieldTitle: 'Name', fieldDesc: 'Description', confirm: 'Confirm',
    editEntry: 'Edit memory', createEntry: 'New memory',
    kind: { decision: 'decision', constraint: 'constraint', gotcha: 'gotcha', preference: 'preference', 'open-question': 'open' },
    status: { active: 'active', superseded: 'superseded', archived: 'disabled', candidate: 'candidate' },
    stage: { fresh: 'fresh', stable: 'stable', fading: 'fading', dormant: 'dormant' },
    bankKind: { workspace: 'workspace', topic: 'topic', global: 'global' },
    sort: { retentionAsc: 'Retention low→high', retentionDesc: 'Retention high→low', updated: 'Recently updated', created: 'Recently created', topic: 'Topic' },
    filterAll: 'All', filterStatus: 'Status', filterKind: 'Kind', filterEdge: 'Edges',
    edge: { contains: 'belongs', supersede: 'supersedes', relation: 'explicit', topic: 'topic family', tag: 'shared tag', 'bank-link': 'bank link' },
    rel: { related: 'related', refines: 'refines', depends: 'depends', contradicts: 'contradicts' },
    action: { pin: 'Pin', unpin: 'Unpin', review: 'Review', archive: 'Disable', restore: 'Enable', edit: 'Edit', delete: 'Delete', open: 'Open' },
    pinBadge: 'pinned', stale: 'needs review',
    count: (shown, total) => `${shown} of ${total}`,
    noMemories: 'No matching memory. Adjust the filters or create one.',
    metrics: { entries: 'entries', active: 'active', retention: 'avg retention' },
    bankActions: { graph: 'Show in graph', edit: 'Edit', archive: 'Disable', restore: 'Enable', delete: 'Delete' },
    linkRecall: 'inject', linkQuery: 'searchable', onlyBank: 'Nothing to link while only one bank exists',
    stageDist: 'Retention', kindDist: 'Kinds', reviewEmpty: 'Nothing needs review',
    importReport: 'Import report', backup: 'Backup', conflicts: 'conflicts',
    reportBanks: (a, m) => `Banks: +${a} · matched ${m}`,
    reportEntries: (a, s, r) => `Entries: +${a} · skipped ${s} · remapped ${r}`,
    reportLinks: (a, s) => `Links: +${a} · skipped ${s}`,
    sectionDetail: 'Detail', sectionRejected: 'Rejected', sectionRelations: 'Relations', sectionChain: 'Supersede chain', sectionMeta: 'Meta', sectionDecay: 'Retention',
    noDetail: '(no detail)', noRelations: '(no relations yet)', addRelation: 'Add', relationTarget: 'Target entry', relationType: 'Type',
    meta: { bank: 'Bank', created: 'Created', updated: 'Updated', recalled: 'Injected', reviewed: 'Reviews', confidence: 'Confidence', due: 'Next review', stability: 'Stability', age: 'Age' },
    confidence: { verified: 'verified', tentative: 'tentative' },
    retention: 'Retention', days: 'days', reviewNow: 'Still true', markOutdated: 'Mark outdated',
    bankOverview: 'Bank overview', openBank: 'Show memories',
    confirmDeleteEntry: 'Permanently delete this memory? The conclusion it superseded becomes active again.',
    confirmDeleteBank: 'Delete this bank and all its entries? This cannot be undone.',
    confirmReplace: 'Replace wipes all local memories and keeps only the imported file. Continue?',
    toastSaved: 'Saved', toastDeleted: 'Deleted', toastReviewed: 'Reviewed — retention reset', toastArchived: 'Disabled',
    toastRestored: 'Enabled', toastImported: 'Imported', toastCopied: 'Copied',
    opFailed: 'Action failed: ', loadFailed: 'Load failed: ', importFailed: 'Import failed: ', fileReadFailed: 'File read failed: ',
    offline: 'offline', online: 'local',
    confirmTitle: 'Confirm',
    relationAdded: 'Relation created', relationRemoved: 'Relation removed', reviewHintQueue: 'Confirm the conclusion is still true, then review.',
    demoNote: 'demo data', allBanks: 'All banks',
  },
}

const storedLang = localStorage.getItem('memstack.lang')
const forcedLang = new URLSearchParams(location.search).get('lang')
if (forcedLang === 'zh' || forcedLang === 'en') localStorage.setItem('memstack.lang', forcedLang)
const preferredLang = forcedLang === 'zh' || forcedLang === 'en' ? forcedLang : storedLang
let lang = preferredLang === 'zh' || preferredLang === 'en' ? preferredLang : ((navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en')
const forcedTheme = new URLSearchParams(location.search).get('theme')
if (forcedTheme === 'light' || forcedTheme === 'dark') localStorage.setItem('memstack.theme', forcedTheme)
const storedTheme = localStorage.getItem('memstack.theme')
document.documentElement.dataset.theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'dark'

const state = {
  data: null,
  graph: null,
  view: 'graph',
  query: '',
  memLimit: 60,
  memFilters: { bank: '', status: 'active', kind: '', sort: 'updated' },
  graphFilters: { banks: new Set(), kinds: new Set(KIND_ORDER), statuses: new Set(['active', 'superseded']), edges: new Set(['contains', 'supersede', 'relation', 'topic', 'bank-link']) },
  graphOptions: { rotate: true, mode: '3d' },
  selectedId: null,
  drawerBankId: null,
  editingEntryId: null,
  editingBankId: null,
  pendingImport: null,
  graphReady: false,
  lastSignature: '',
}

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const t = (key, ...args) => {
  const value = I18N[lang][key] ?? I18N.zh[key] ?? key
  return typeof value === 'function' ? value(...args) : value
}
const icon = (path, size = 15) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${path}</svg>`
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

let graphView = null
let graphTimer = null
let searchTimer = null

// ------------------------------------------------------------------ helpers

function kindClass(kind) { return `kind-${kind}` }
function stageOf(entry) { return entry.stage ?? 'fresh' }
function retentionPercent(entry) { return Math.round((entry.retention ?? 0) * 100) }
function relativeTime(value) {
  if (!value) return '—'
  const diff = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diff)) return '—'
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return lang === 'zh' ? '刚刚' : 'now'
  if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 60) return lang === 'zh' ? `${days} 天前` : `${days}d ago`
  const months = Math.round(days / 30)
  return lang === 'zh' ? `${months} 个月前` : `${months}mo ago`
}
function dateTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
}
function findEntry(id) { return state.data?.entries.find((entry) => entry.id === id) ?? null }
function findBank(id) { return state.data?.banks.find((bank) => bank.id === id) ?? null }
function activeBanks() { return (state.data?.banks ?? []).filter((bank) => !bank.archivedAt) }

function toast(message, kind = 'ok') {
  const wrap = $('#toastWrap')
  const node = document.createElement('div')
  node.className = `toast${kind === 'error' ? ' is-error' : ''}`
  node.textContent = message
  wrap.append(node)
  setTimeout(() => node.remove(), 3600)
}

function download(url) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

async function fetchJson(url, options) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options })
  let body = null
  try { body = await response.json() } catch { body = {} }
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}

async function mutate(url, body, method = 'POST') {
  const data = await fetchJson(url, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  applyData(data)
  return data
}

function applyData(data) {
  state.data = data
  state.lastSignature = signature(data)
  if (!state.graphFilters.banks.size) {
    for (const bank of data.banks) state.graphFilters.banks.add(bank.id)
  } else {
    for (const bank of data.banks) if (!state.graphFilters.banks.has(bank.id) && !state.knownBanks?.has(bank.id)) state.graphFilters.banks.add(bank.id)
  }
  state.knownBanks = new Set(data.banks.map((bank) => bank.id))
  renderAll()
  scheduleGraph()
}

function signature(data) {
  const entries = data.entries ?? []
  const latest = entries.reduce((max, entry) => (entry.updatedAt > max ? entry.updatedAt : max), '')
  return `${data.banks?.length}:${entries.length}:${latest}:${data.links?.length}:${data.summary?.averageRetention}`
}

// ------------------------------------------------------------------- i18n

function applyI18n() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = `MemStack · ${t('viewGraphTitle')}`
  for (const node of $$('[data-i18n]')) {
    const value = t(node.dataset.i18n)
    if (typeof value === 'string') node.textContent = value
  }
  for (const node of $$('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder)
  const modeLabel = document.querySelector('[data-graph="mode"] span')
  if (modeLabel) modeLabel.textContent = state.graphOptions.mode === '3d' ? t('toggle3d') : t('toggle3dBack')
  $('#langBtn').textContent = lang === 'zh' ? 'EN' : '中文'
  $('#globalSearch').placeholder = t('searchPh')
  updateChrome()
}

// ------------------------------------------------------------------ loading

async function loadState({ silent = false } = {}) {
  const data = await fetchJson('/api/state')
  const changed = signature(data) !== state.lastSignature
  state.data = data
  state.lastSignature = signature(data)
  if (!silent || changed) {
    renderAll()
    if (changed) scheduleGraph()
  }
  setOnline(true)
  return data
}

function setOnline(online) {
  const node = $('#conn')
  node.classList.toggle('is-offline', !online)
  node.querySelector('span').textContent = online ? t('connected') : t('offline')
}

async function refreshGraph() {
  if (!state.data) return
  try {
    const graph = await fetchJson('/api/graph')
    state.graph = graph
    state.graphReady = true
    renderGraphFilters()
    syncGraph()
  } catch (error) {
    toast(t('loadFailed') + error.message, 'error')
  }
}

function scheduleGraph() {
  if (state.view !== 'graph') return
  clearTimeout(graphTimer)
  graphTimer = setTimeout(refreshGraph, 120)
}

async function poll() {
  if (document.visibilityState !== 'visible' || !state.data) return
  try {
    const data = await fetchJson('/api/state')
    if (signature(data) === state.lastSignature) return
    state.data = data
    state.lastSignature = signature(data)
    renderAll()
    scheduleGraph()
  } catch {
    setOnline(false)
  }
}

// ----------------------------------------------------------------- rendering

function renderAll() {
  if (!state.data) return
  renderChrome()
  if (state.view === 'memories') renderMemories()
  if (state.view === 'banks') renderBanks()
  if (state.view === 'data') renderData()
  if (state.view === 'graph') renderGraphFilters()
  renderDrawer()
  applyI18n()
}

const REVIEW_LIMIT = 8

/** The lowest-retention active entries; the rail count and the review list share this slice. */
function reviewCandidates() {
  return (state.data?.entries ?? [])
    .filter((entry) => entry.status === 'active')
    .sort((a, b) => (a.retention ?? 0) - (b.retention ?? 0))
    .slice(0, REVIEW_LIMIT)
}

function renderChrome() {
  const { summary } = state.data
  const graphSummary = state.graph?.summary
  $('#navGraphCount').textContent = graphSummary?.nodes ?? summary.entries + summary.banks
  $('#navMemCount').textContent = summary.active || 0
  $('#navBankCount').textContent = state.data.banks.length
  const reviewCount = reviewCandidates().length
  $('#railStats').innerHTML = [
    [t('metrics').active, summary.active],
    [t('metrics').entries, summary.entries],
    [t('metrics').retention, `${Math.round(summary.averageRetention * 100)}%`],
    [lang === 'zh' ? '待复习' : 'review', reviewCount],
  ]
    .map(([label, value]) => `<div class="rail-stat"><span>${esc(label)}</span><b>${value ?? 0}</b></div>`)
    .join('')
}

function updateChrome() {
  const summary = state.data?.summary
  const graphSummary = state.graph?.summary
  const titles = {
    graph: [
      t('viewGraphTitle'),
      t(
        'viewGraphSub',
        graphSummary?.nodes ?? summary?.entries ?? 0,
        graphSummary?.edges ?? summary?.links ?? 0,
        Math.round((summary?.averageRetention ?? 0) * 100),
      ),
    ],
    memories: [t('viewMemTitle'), t('viewMemSub')],
    banks: [t('viewBanksTitle'), t('viewBanksSub')],
    data: [t('viewDataTitle'), t('viewDataSub')],
  }
  const [title, subtitle] = titles[state.view] ?? titles.graph
  $('#viewTitle').textContent = title
  $('#viewSubtitle').textContent = subtitle
}

// ------------------------------------------------------------------ graph

function initGraph() {
  graphView = createGraphView($('#graphCanvas'), {
    tooltip: $('#graphTooltip'),
    onSelect(node) {
      if (!node) {
        state.selectedId = null
        state.drawerBankId = null
        renderDrawer()
        return
      }
      pauseGraphRotation()
      if (node.type === 'bank') {
        state.selectedId = null
        state.drawerBankId = node.id
        renderDrawer()
      } else {
        state.selectedId = node.id
        state.drawerBankId = null
        renderDrawer()
      }
    },
    onHover() {},
    formatTooltip(node) {
      if (node.type === 'bank') {
        return `<div class="tt-topic">${esc(node.label)}</div><div class="tt-claim">${esc(node.description || t('bankOverview'))}</div><div class="tt-meta">${esc(t('bankNode', node.entryCount ?? 0))}</div>`
      }
      return `<div class="tt-topic">${esc(node.topic ?? node.label)}</div><div class="tt-claim">${esc(node.claim ?? '')}</div><div class="tt-meta">${esc(t('kind')[node.kind] ?? node.kind)} · ${esc(t('status')[node.status] ?? node.status)} · ${t('retention')} ${retentionPercent(node)}%</div>`
    },
    palette: themePalette(),
  })
  if (!state.graphOptions.rotate) graphView.setOptions({ autoRotate: false })
  graphView.setActive(state.view === 'graph')
}

function themePalette() {
  if (document.documentElement.dataset.theme === 'light') {
    return {
      label: 'rgba(15, 23, 42, 0.92)',
      labelMuted: 'rgba(51, 65, 85, 0.9)',
      labelPanel: 'rgba(255, 255, 255, 0.86)',
      labelShadow: 'rgba(255, 255, 255, 0.9)',
      hoverRing: 'rgba(15, 23, 42, 0.8)',
      selectRing: '#0f172a',
      bank: '#0284c7',
      bankArchived: '#94a3b8',
    }
  }
  return {
    label: 'rgba(232, 238, 247, 0.92)',
    labelMuted: 'rgba(148, 163, 184, 0.9)',
    labelPanel: 'rgba(8, 11, 17, 0.82)',
    labelShadow: 'rgba(0, 0, 0, 0.75)',
    hoverRing: 'rgba(255, 255, 255, 0.85)',
    selectRing: '#ffffff',
    bank: '#7dd3fc',
    bankArchived: '#475569',
  }
}

function graphFiltered() {
  if (!state.graph) return { nodes: [], edges: [] }
  const filters = state.graphFilters
  const bankOk = (bankId) => filters.banks.size === 0 || filters.banks.has(bankId)
  const nodes = state.graph.nodes.filter((node) => {
    if (node.type === 'bank') return bankOk(node.id) && (filters.statuses.has('active') || node.status === 'archived')
    return bankOk(node.bankId) && filters.kinds.has(node.kind) && filters.statuses.has(node.status)
  })
  const ids = new Set(nodes.map((node) => node.id))
  const edges = state.graph.edges.filter((edge) => filters.edges.has(edge.type) && ids.has(edge.source) && ids.has(edge.target))
  return { nodes, edges }
}

function syncGraph() {
  if (!graphView || !state.graph) return
  const filtered = graphFiltered()
  if (state.selectedId && !filtered.nodes.some((node) => node.id === state.selectedId)) {
    state.selectedId = null
    renderDrawer()
  }
  graphView.setData(filtered)
  $('#graphEmpty').hidden = filtered.nodes.length > 0
  const query = state.query.trim().toLowerCase()
  if (query) {
    const ids = new Set(
      filtered.nodes
        .filter((node) => node.type === 'entry' && `${node.topic} ${node.claim} ${(node.tags ?? []).join(' ')}`.toLowerCase().includes(query))
        .map((node) => node.id),
    )
    graphView.setOptions({ highlight: ids })
  } else {
    graphView.setOptions({ highlight: null })
  }
  updateChrome()
}

function renderGraphFilters() {
  const banks = state.data?.banks ?? []
  const filters = state.graphFilters
  if (!filters.banks.size) for (const bank of banks) filters.banks.add(bank.id)
  $('#graphBankChips').innerHTML = [
    `<button class="chip${filters.banks.size === banks.length || filters.banks.size === 0 ? ' is-on' : ''}" data-bank-filter="*">${esc(t('filterAll'))}</button>`,
    ...banks.map((bank) => {
      const on = filters.banks.has(bank.id)
      return `<button class="chip${on ? ' is-on' : ''}" data-bank-filter="${esc(bank.id)}" title="${esc(bank.description || bank.title)}">${esc(bank.title)}</button>`
    }),
  ].join('')
  $('#graphKindChips').innerHTML = KIND_ORDER.map((kind) => {
    const on = filters.kinds.has(kind)
    return `<button class="chip${on ? ' is-on' : ''}" data-kind-filter="${kind}" style="--c:${kindColor(kind)}"><i style="background:${kindColor(kind)}"></i>${esc(t('kind')[kind])}</button>`
  }).join('')
  const statusChips = ['active', 'superseded', 'archived'].map((status) => {
    const on = filters.statuses.has(status)
    return `<button class="chip${on ? ' is-on' : ''}" data-status-filter="${status}">${esc(t('status')[status])}</button>`
  }).join('')
  $('#graphKindChips').innerHTML += statusChips
  $('#graphEdgeChips').innerHTML = ['contains', 'supersede', 'relation', 'topic', 'tag', 'bank-link'].map((type) => {
    const on = filters.edges.has(type)
    return `<button class="chip${on ? ' is-on' : ''}" data-edge-filter="${type}">${esc(t('edge')[type])}</button>`
  }).join('')
  $('#graphLegend').innerHTML = KIND_ORDER.map((kind) => `<span><i style="background:${kindColor(kind)}"></i>${esc(t('kind')[kind])}</span>`).join('')
}

function kindColor(kind) {
  return { decision: '#60a5fa', constraint: '#fbbf24', gotcha: '#f87171', preference: '#a78bfa', 'open-question': '#34d399' }[kind] ?? '#94a3b8'
}

// --------------------------------------------------------------- memories

function renderMemories() {
  const data = state.data
  const banks = data.banks
  const bankSelect = $('#memBank')
  const statusSelect = $('#memStatus')
  const kindSelect = $('#memKind')
  const sortSelect = $('#memSort')
  bankSelect.innerHTML = `<option value="">${esc(t('allBanks'))}</option>` + banks.map((bank) => `<option value="${esc(bank.id)}">${esc(bank.title)}</option>`).join('')
  statusSelect.innerHTML = ['active', 'all', 'superseded', 'archived'].map((status) => `<option value="${status}">${status === 'all' ? esc(t('filterAll')) : esc(t('status')[status])}</option>`).join('')
  kindSelect.innerHTML = `<option value="">${esc(t('filterAll'))}</option>` + KIND_ORDER.map((kind) => `<option value="${kind}">${esc(t('kind')[kind])}</option>`).join('')
  sortSelect.innerHTML = Object.entries(t('sort')).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('')
  bankSelect.value = state.memFilters.bank
  statusSelect.value = state.memFilters.status
  kindSelect.value = state.memFilters.kind
  sortSelect.value = state.memFilters.sort

  const query = state.query.trim().toLowerCase()
  const rows = data.entries
    .filter((entry) => !state.memFilters.bank || entry.bankId === state.memFilters.bank)
    .filter((entry) => state.memFilters.status === 'all' || entry.status === state.memFilters.status)
    .filter((entry) => !state.memFilters.kind || entry.kind === state.memFilters.kind)
    .filter((entry) => !query || `${entry.topic} ${entry.claim} ${entry.detail ?? ''} ${(entry.tags ?? []).join(' ')} ${(entry.rejected ?? []).map((item) => item.option).join(' ')}`.toLowerCase().includes(query))
    .sort(sortEntries(state.memFilters.sort))

  $('#memCount').textContent = t('count', Math.min(rows.length, state.memLimit), rows.length)
  $('#memMore').hidden = rows.length <= state.memLimit
  if (!rows.length) {
    $('#memList').innerHTML = `<div class="empty-state">${esc(t('noMemories'))}</div>`
    return
  }
  $('#memList').innerHTML = rows.slice(0, state.memLimit).map((entry) => {
    const percent = retentionPercent(entry)
    const stage = stageOf(entry)
    const bank = findBank(entry.bankId)
    return `<div class="mem-row ${kindClass(entry.kind)}" data-entry="${esc(entry.id)}">
      <span class="kind-line"></span>
      <span class="mem-kind"><i></i>${esc(t('kind')[entry.kind] ?? entry.kind)}</span>
      <div class="mem-main">
        <div class="mem-topic">${esc(entry.topic)}${entry.pinned ? ` <span class="badge is-pinned">${esc(t('pinBadge'))}</span>` : ''}${entry.status !== 'active' ? ` <span class="badge">${esc(t('status')[entry.status])}</span>` : ''}</div>
        <div class="mem-claim">${esc(entry.claim)}</div>
      </div>
      <div class="mem-bank"><span>${esc(bank?.title ?? entry.bankId)}</span></div>
      <div class="mem-retention status-${entry.status}">
        <div class="ret-bar"><b style="--r:${percent}%;--stage-color:${STAGE_COLOR[stage]}"></b></div>
        <div class="ret-text"><span>${percent}%</span><span>${esc(t('stage')[stage])}</span></div>
      </div>
      <div class="mem-time">${esc(relativeTime(entry.updatedAt))}</div>
      <div class="mem-actions">
        <button type="button" data-act="pin" data-id="${esc(entry.id)}" title="${esc(entry.pinned ? t('action').unpin : t('action').pin)}">${icon(entry.pinned ? ICONS.pinOff : ICONS.pin, 14)}</button>
        <button type="button" data-act="edit" data-id="${esc(entry.id)}" title="${esc(t('action').edit)}">${icon(ICONS.edit, 14)}</button>
        <button type="button" class="danger" data-act="delete" data-id="${esc(entry.id)}" title="${esc(t('action').delete)}">${icon(ICONS.trash, 14)}</button>
      </div>
    </div>`
  }).join('')
}

function sortEntries(mode) {
  return (a, b) => {
    if (mode === 'retentionAsc') return (a.retention ?? 0) - (b.retention ?? 0)
    if (mode === 'retentionDesc') return (b.retention ?? 0) - (a.retention ?? 0)
    if (mode === 'created') return a.createdAt < b.createdAt ? 1 : -1
    if (mode === 'topic') return a.topic < b.topic ? -1 : 1
    return a.updatedAt < b.updatedAt ? 1 : -1
  }
}

// ------------------------------------------------------------------ banks

function renderBanks() {
  const entries = state.data.entries
  const metrics = (bank) => {
    const rows = entries.filter((entry) => entry.bankId === bank.id)
    const active = rows.filter((entry) => entry.status === 'active')
    const average = active.length ? active.reduce((sum, entry) => sum + (entry.retention ?? 0), 0) / active.length : 0
    return { total: rows.length, active: active.length, retention: Math.round(average * 100) }
  }
  $('#bankCards').innerHTML = state.data.banks.map((bank) => {
    const stat = metrics(bank)
    return `<div class="bank-card${bank.archivedAt ? ' is-archived' : ''}">
      <div class="bank-card-head">
        <h3>${esc(bank.title)}</h3>
        <span class="badge">${esc(t('bankKind')[bank.kind] ?? bank.kind)}</span>
      </div>
      <div class="bank-desc">${esc(bank.description || '—')}</div>
      <div class="bank-metrics">
        <div class="metric"><b>${stat.total}</b><span>${esc(t('metrics').entries)}</span></div>
        <div class="metric"><b>${stat.active}</b><span>${esc(t('metrics').active)}</span></div>
        <div class="metric"><b>${stat.retention}%</b><span>${esc(t('metrics').retention)}</span></div>
      </div>
      <div class="bank-actions">
        <button type="button" data-bank-act="graph" data-id="${esc(bank.id)}">${esc(t('bankActions').graph)}</button>
        <button type="button" data-bank-act="edit" data-id="${esc(bank.id)}">${esc(t('bankActions').edit)}</button>
        <button type="button" data-bank-act="${bank.archivedAt ? 'restore' : 'archive'}" data-id="${esc(bank.id)}">${esc(bank.archivedAt ? t('bankActions').restore : t('bankActions').archive)}</button>
        <button type="button" class="danger" data-bank-act="delete" data-id="${esc(bank.id)}">${esc(t('bankActions').delete)}</button>
      </div>
    </div>`
  }).join('')

  const source = $('#linkSource')
  const previous = source.value
  source.innerHTML = state.data.banks.map((bank) => `<option value="${esc(bank.id)}">${esc(bank.title)}</option>`).join('')
  const preferred = activeBanks().find((bank) => bank.kind === 'workspace') ?? state.data.banks[0]
  source.value = state.data.banks.some((bank) => bank.id === previous) ? previous : preferred?.id ?? ''
  renderLinks()
}

function renderLinks() {
  const from = $('#linkSource').value
  const targets = state.data.banks.filter((bank) => bank.id !== from)
  if (!targets.length) {
    $('#linkList').innerHTML = `<div class="muted">${esc(t('onlyBank'))}</div>`
    return
  }
  $('#linkList').innerHTML = targets.map((bank) => {
    const link = state.data.links.find((item) => item.fromBankId === from && item.toBankId === bank.id)
    return `<div class="link-row" data-from="${esc(from)}" data-to="${esc(bank.id)}">
      <span class="grow">${esc(bank.title)}${bank.archivedAt ? ' · ' + esc(t('status').archived) : ''}</span>
      <label><input type="checkbox" data-field="recall"${link?.recall ? ' checked' : ''} /> ${esc(t('linkRecall'))}</label>
      <label><input type="checkbox" data-field="query"${!link || link.query ? ' checked' : ''} /> ${esc(t('linkQuery'))}</label>
    </div>`
  }).join('')
}

// ------------------------------------------------------------------- data

function renderData() {
  const { summary, file } = state.data
  $('#dataPath').textContent = file
  const stages = summary.byStage ?? {}
  const stageTotal = STAGE_ORDER.reduce((sum, stage) => sum + (stages[stage] ?? 0), 0) || 1
  const kinds = summary.byKind ?? {}
  $('#statsBody').innerHTML = [
    `<div class="panel-label">${esc(t('stageDist'))}</div>`,
    ...STAGE_ORDER.map((stage) => {
      const value = stages[stage] ?? 0
      return `<div class="stage-row"><span>${esc(t('stage')[stage])}</span><div class="bar"><b style="width:${Math.round((value / stageTotal) * 100)}%;background:${STAGE_COLOR[stage]}"></b></div><span>${value}</span></div>`
    }),
    `<div class="panel-label" style="margin-top:8px">${esc(t('kindDist'))}</div>`,
    ...KIND_ORDER.map((kind) => {
      const value = kinds[kind] ?? 0
      const max = Math.max(1, ...Object.values(kinds))
      return `<div class="stage-row"><span>${esc(t('kind')[kind])}</span><div class="bar"><b style="width:${Math.round((value / max) * 100)}%;background:${kindColor(kind)}"></b></div><span>${value}</span></div>`
    }),
  ].join('')

  const candidates = reviewCandidates()
  $('#reviewList').innerHTML = candidates.length
    ? candidates.map((entry) => `<div class="review-item">
        <div><div class="topic">${esc(entry.topic)}</div><div class="claim">${esc(entry.claim)}</div></div>
        <div style="display:flex;align-items:center;gap:8px"><span class="ret">${retentionPercent(entry)}%</span><button type="button" data-review="${esc(entry.id)}">${esc(t('action').review)}</button></div>
      </div>`).join('')
    : `<div class="muted">${esc(t('reviewEmpty'))}</div>`
}

function showImportReport(report) {
  const node = $('#importReport')
  const lines = [
    `${t('importReport')} · ${report.mode}`,
    t('reportBanks', report.banksAdded, report.banksMapped),
    t('reportEntries', report.entriesAdded, report.entriesSkipped, report.entriesRemapped),
    t('reportLinks', report.linksAdded, report.linksSkipped),
    `${t('conflicts')}: ${report.conflicts.length}`,
    report.backup ? `${t('backup')}: ${report.backup}` : '',
    ...report.conflicts.slice(0, 12).map((conflict) => `- ${JSON.stringify(conflict)}`),
  ].filter(Boolean)
  node.hidden = false
  node.textContent = lines.join('\n')
}

// ----------------------------------------------------------------- drawer

function renderDrawer() {
  requestAnimationFrame(syncDrawerInset)
  const drawer = $('#drawer')
  if (state.drawerBankId) {
    const bank = findBank(state.drawerBankId)
    if (!bank) { drawer.hidden = true; return }
    renderBankDrawer(bank)
    drawer.hidden = false
    return
  }
  if (!state.selectedId) {
    drawer.hidden = true
    return
  }
  const entry = findEntry(state.selectedId)
  if (!entry) { drawer.hidden = true; return }
  drawer.hidden = false
  $('#drawerKind').textContent = t('kind')[entry.kind] ?? entry.kind
  $('#drawerKind').className = `badge ${kindClass(entry.kind)}`
  $('#drawerTopic').textContent = entry.topic
  const chain = chainOf(entry)
  const incoming = state.data.entries.flatMap((other) =>
    (other.relations ?? []).filter((relation) => relation.target === entry.id).map((relation) => ({ other, relation })),
  )
  const percent = retentionPercent(entry)
  const stage = stageOf(entry)
  const curve = retentionCurve(entry)
  const canRestore = entry.status === 'archived'

  $('#drawerBody').innerHTML = `
    <p class="drawer-claim">${esc(entry.claim)}</p>
    <div class="tag-list">${(entry.tags ?? []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}${entry.pinned ? `<span class="badge is-pinned">${esc(t('pinBadge'))}</span>` : ''}<span class="badge">${esc(t('status')[entry.status])}</span></div>

    <div class="decay-card">
      <div class="decay-head"><b style="color:${STAGE_COLOR[stage]}">${percent}%</b><span>${esc(t('retention'))} · ${esc(t('stage')[stage])}</span></div>
      <svg class="decay-chart" viewBox="0 0 300 72" preserveAspectRatio="none">${curve}</svg>
      <div class="decay-meta"><span>${esc(t('meta').stability)} ${Math.round(entry.stabilityDays ?? 0)} ${esc(t('days'))}</span><span>${esc(t('meta').due)} ${esc(dateTime(entry.nextReviewAt))}</span></div>
    </div>

    <section class="drawer-section"><h4>${esc(t('sectionDetail'))}</h4><p>${entry.detail ? esc(entry.detail) : `<span class="muted">${esc(t('noDetail'))}</span>`}</p></section>

    ${(entry.rejected ?? []).length ? `<section class="drawer-section"><h4>${esc(t('sectionRejected'))}</h4><ul class="rejected-list">${entry.rejected.map((item) => `<li><b>${esc(item.option)}</b>${item.reason ? ` <span>— ${esc(item.reason)}</span>` : ''}</li>`).join('')}</ul></section>` : ''}

    <section class="drawer-section"><h4>${esc(t('sectionRelations'))}</h4>
      <div class="relations">
        ${(entry.relations ?? []).map((relation) => {
          const target = findEntry(relation.target)
          return `<div class="relation-row"><span class="rel-type">${esc(t('rel')[relation.type] ?? relation.type)}</span><span class="rel-target">${esc(target?.topic ?? relation.target)}</span><button type="button" data-unrelate="${esc(relation.target)}" title="remove">${icon(ICONS.close, 12)}</button></div>`
        }).join('')}
        ${incoming.map(({ other, relation }) => `<div class="relation-row"><span class="rel-type">← ${esc(t('rel')[relation.type] ?? relation.type)}</span><span class="rel-target">${esc(other.topic)}</span></div>`).join('')}
        ${!(entry.relations ?? []).length && !incoming.length ? `<div class="muted" style="font-size:12px;padding:4px 0">${esc(t('noRelations'))}</div>` : ''}
      </div>
      <div class="add-relation" style="margin-top:8px">
        <select data-rel-target>
          <option value="">${esc(t('relationTarget'))}</option>
          ${state.data.entries.filter((other) => other.id !== entry.id).map((other) => `<option value="${esc(other.id)}">${esc(other.topic)}</option>`).join('')}
        </select>
        <select data-rel-type>${['related', 'refines', 'depends', 'contradicts'].map((type) => `<option value="${type}">${esc(t('rel')[type])}</option>`).join('')}</select>
        <button class="ghost-btn small" type="button" data-add-relation>${esc(t('addRelation'))}</button>
      </div>
    </section>

    ${chain.length > 1 ? `<section class="drawer-section"><h4>${esc(t('sectionChain'))}</h4><div class="chain">${chain.map((item) => `<div class="chain-item${item.id === entry.id ? ' is-current' : ''}"><span class="dot"></span><div><div class="claim">${esc(item.claim)}</div><div class="meta">${esc(t('status')[item.status])} · ${esc(relativeTime(item.updatedAt))}</div></div></div>`).join('')}</div></section>` : ''}

    <section class="drawer-section"><h4>${esc(t('sectionMeta'))}</h4>
      <div class="meta-grid">
        <span>${esc(t('meta').bank)}</span><b>${esc(findBank(entry.bankId)?.title ?? entry.bankId)}</b>
        <span>${esc(t('meta').confidence)}</span><b>${esc(t('confidence')[entry.confidence] ?? entry.confidence)}</b>
        <span>${esc(t('meta').created)}</span><b>${esc(dateTime(entry.createdAt))}</b>
        <span>${esc(t('meta').updated)}</span><b>${esc(dateTime(entry.updatedAt))}</b>
        <span>${esc(t('meta').recalled)}</span><b>${entry.recalledCount ?? 0}</b>
        <span>${esc(t('meta').reviewed)}</span><b>${entry.reviewCount ?? 0}</b>
      </div>
    </section>

    <div class="drawer-actions">
      ${entry.status === 'active' ? `<button class="primary-btn" type="button" data-drawer-act="review">${icon(ICONS.review)} ${esc(t('reviewNow'))}</button>` : ''}
      ${entry.status === 'active' ? `<button class="ghost-btn" type="button" data-drawer-act="outdated">${esc(t('markOutdated'))}</button>` : ''}
      <button class="ghost-btn" type="button" data-drawer-act="edit">${icon(ICONS.edit)} ${esc(t('action').edit)}</button>
      <button class="ghost-btn" type="button" data-drawer-act="pin">${icon(entry.pinned ? ICONS.pinOff : ICONS.pin)} ${esc(entry.pinned ? t('action').unpin : t('action').pin)}</button>
      ${canRestore ? `<button class="ghost-btn" type="button" data-drawer-act="restore">${icon(ICONS.restore)} ${esc(t('action').restore)}</button>` : `<button class="ghost-btn" type="button" data-drawer-act="archive">${icon(ICONS.archive)} ${esc(t('action').archive)}</button>`}
      <button class="danger-btn" type="button" data-drawer-act="delete">${icon(ICONS.trash)} ${esc(t('action').delete)}</button>
    </div>
  `
  void incoming
}

function renderBankDrawer(bank) {  const rows = state.data.entries.filter((entry) => entry.bankId === bank.id)
  const active = rows.filter((entry) => entry.status === 'active')
  const average = active.length ? Math.round((active.reduce((sum, entry) => sum + (entry.retention ?? 0), 0) / active.length) * 100) : 0
  $('#drawerKind').textContent = t('bankKind')[bank.kind] ?? bank.kind
  $('#drawerKind').className = 'badge'
  $('#drawerTopic').textContent = bank.title
  $('#drawerBody').innerHTML = `
    <p class="drawer-claim">${esc(bank.description || t('bankOverview'))}</p>
    <div class="decay-card">
      <div class="decay-head"><b>${rows.length}</b><span>${esc(t('metrics').entries)} · ${active.length} ${esc(t('metrics').active)} · ${esc(t('metrics').retention)} ${average}%</span></div>
    </div>
    <div class="drawer-actions">
      <button class="primary-btn" type="button" data-bank-drawer="open">${esc(t('openBank'))}</button>
      <button class="ghost-btn" type="button" data-bank-drawer="edit">${esc(t('bankActions').edit)}</button>
    </div>
  `
}

function syncDrawerInset() {
  const drawer = $('#drawer')
  const open = !drawer.hidden && window.innerWidth > 900
  graphView?.setInsetRight(open ? drawer.getBoundingClientRect().width : 0)
}

function chainOf(entry) {  const byId = new Map(state.data.entries.map((item) => [item.id, item]))
  const chain = []
  const seen = new Set()
  let cursor = entry
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.unshift(cursor)
    cursor = cursor.supersedes ? byId.get(cursor.supersedes) : null
  }
  cursor = entry.supersededBy ? byId.get(entry.supersededBy) : null
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.push(cursor)
    cursor = cursor.supersededBy ? byId.get(cursor.supersededBy) : null
  }
  return chain
}

function retentionCurve(entry) {
  const halfLife = Math.max(0.5, Number(entry.stabilityDays) || 30)
  const anchor = new Date(entry.lastReviewedAt ?? entry.createdAt ?? Date.now())
  const now = Date.now()
  const age = Math.max(0, (now - anchor.getTime()) / 86400000)
  const span = Math.max(halfLife * 2, age * 1.2, 14)
  const points = 36
  const path = []
  for (let index = 0; index < points; index += 1) {
    const days = (span / (points - 1)) * index
    const retention = 0.5 ** (days / halfLife)
    const x = 4 + (days / span) * 292
    const y = 68 - retention * 60
    path.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
  }
  const nowX = clamp(4 + (age / span) * 292, 4, 296)
  return `<defs><linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(125,211,252,0.32)"/><stop offset="1" stop-color="rgba(125,211,252,0)"/></linearGradient></defs>
    <path d="${path.join(' ')} L296,72 L4,72 Z" fill="url(#curveFill)" />
    <path d="${path.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.6" />
    <line x1="${nowX}" y1="4" x2="${nowX}" y2="70" stroke="var(--line-strong)" stroke-dasharray="3 3" />
    <circle cx="${nowX}" cy="${68 - (entry.retention ?? 0) * 60}" r="2.6" fill="var(--accent)" />`
}

// ------------------------------------------------------------------- forms

function openEntryDialog(entry = null) {
  state.editingEntryId = entry?.id ?? null
  $('#entryDialogTitle').textContent = entry ? t('editEntry') : t('createEntry')
  const bankSelect = $('#fieldBank')
  bankSelect.innerHTML = state.data.banks.map((bank) => `<option value="${esc(bank.id)}">${esc(bank.title)}</option>`).join('')
  const defaultBank = activeBanks().find((bank) => bank.kind === 'workspace') ?? activeBanks()[0] ?? state.data.banks[0]
  bankSelect.value = entry?.bankId ?? defaultBank?.id ?? ''
  bankSelect.disabled = Boolean(entry)
  $('#fieldKind').innerHTML = KIND_ORDER.map((kind) => `<option value="${kind}">${esc(t('kind')[kind])}</option>`).join('')
  $('#fieldKind').value = entry?.kind ?? 'decision'
  $('#fieldTopic').value = entry?.topic ?? ''
  $('#fieldClaim').value = entry?.claim ?? ''
  $('#fieldDetail').value = entry?.detail ?? ''
  $('#fieldTags').value = (entry?.tags ?? []).join(', ')
  $('#fieldPin').checked = Boolean(entry?.pinned)
  const editor = $('#rejectedEditor')
  editor.innerHTML = ''
  for (const item of entry?.rejected ?? []) addRejectedRow(item.option, item.reason)
  if (!editor.children.length) addRejectedRow()
  $('#entryDialog').showModal()
  $('#fieldTopic').focus()
}

function addRejectedRow(option = '', reason = '') {
  const row = document.createElement('div')
  row.className = 'rejected-row'
  row.innerHTML = `<input type="text" data-option placeholder="option" value="${esc(option)}" />
    <input type="text" data-reason placeholder="reason" value="${esc(reason)}" />
    <button type="button" data-remove>${icon(ICONS.close, 13)}</button>`
  row.querySelector('[data-remove]').addEventListener('click', () => row.remove())
  $('#rejectedEditor').append(row)
}

function collectForm() {
  const rejected = $$('#rejectedEditor .rejected-row')
    .map((row) => ({ option: row.querySelector('[data-option]').value.trim(), reason: row.querySelector('[data-reason]').value.trim() }))
    .filter((item) => item.option)
  return {
    bankId: $('#fieldBank').value,
    kind: $('#fieldKind').value,
    topic: $('#fieldTopic').value.trim(),
    claim: $('#fieldClaim').value.trim(),
    detail: $('#fieldDetail').value.trim(),
    tags: $('#fieldTags').value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    rejected,
    pinned: $('#fieldPin').checked,
  }
}

async function submitEntry(event) {
  event.preventDefault()
  const form = collectForm()
  if (!form.topic || !form.claim) {
    toast(lang === 'zh' ? '主题键与结论不能为空' : 'Topic and claim are required', 'error')
    return
  }
  try {
    if (state.editingEntryId) {
      await mutate(`/api/entry/${encodeURIComponent(state.editingEntryId)}`, {
        topic: form.topic,
        kind: form.kind,
        claim: form.claim,
        detail: form.detail,
        tags: form.tags,
        rejected: form.rejected,
        pinned: form.pinned,
      })
    } else {
      await mutate('/api/entry', {
        bankId: form.bankId,
        topic: form.topic,
        kind: form.kind,
        claim: form.claim,
        detail: form.detail,
        tags: form.tags,
        rejected: form.rejected,
        pinned: form.pinned,
      })
    }
    $('#entryDialog').close()
    toast(t('toastSaved'))
  } catch (error) {
    toast(t('opFailed') + error.message, 'error')
  }
}

function openBankDialog(bank) {
  state.editingBankId = bank.id
  $('#bankFieldTitle').value = bank.title
  $('#bankFieldDesc').value = bank.description ?? ''
  $('#bankDialog').showModal()
  $('#bankFieldTitle').focus()
}

async function submitBank(event) {
  event.preventDefault()
  const title = $('#bankFieldTitle').value.trim()
  if (!title) return
  try {
    await mutate(`/api/bank/${encodeURIComponent(state.editingBankId)}`, { title, description: $('#bankFieldDesc').value.trim() })
    $('#bankDialog').close()
    toast(t('toastSaved'))
  } catch (error) {
    toast(t('opFailed') + error.message, 'error')
  }
}

function confirmAction(text) {
  return new Promise((resolve) => {
    const dialog = $('#confirmDialog')
    $('#confirmTitle').textContent = t('confirmTitle')
    $('#confirmText').textContent = text
    $('#confirmOk').textContent = t('confirm')
    const onClose = () => {
      dialog.removeEventListener('close', onClose)
      resolve(dialog.returnValue === 'ok')
    }
    dialog.addEventListener('close', onClose)
    dialog.showModal()
  })
}

// ------------------------------------------------------------------ events

function setView(view, { writeHash = true } = {}) {
  if (!['graph', 'memories', 'banks', 'data'].includes(view)) view = 'graph'
  state.view = view
  if (writeHash && location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`)
  $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view))
  $$('.view').forEach((section) => section.classList.toggle('is-active', section.dataset.view === view))
  if (view === 'graph') {
    graphView?.setActive(true)
    requestAnimationFrame(() => graphView?.resize())
    refreshGraph()
  } else {
    graphView?.setActive(false)
  }
  renderAll()
  updateChrome()
}

async function performEntryAction(act, id) {
  const entry = findEntry(id)
  if (!entry) return
  try {
    if (act === 'pin') await mutate(`/api/entry/${encodeURIComponent(id)}/pin`)
    else if (act === 'review') { await mutate(`/api/entry/${encodeURIComponent(id)}/review`); toast(t('toastReviewed')) }
    else if (act === 'archive') { await mutate(`/api/entry/${encodeURIComponent(id)}/archive`); toast(t('toastArchived')) }
    else if (act === 'restore') { await mutate(`/api/entry/${encodeURIComponent(id)}/restore`); toast(t('toastRestored')) }
    else if (act === 'delete') {
      if (!(await confirmAction(t('confirmDeleteEntry')))) return
      await mutate(`/api/entry/${encodeURIComponent(id)}/delete`, undefined, 'POST')
      state.selectedId = null
      toast(t('toastDeleted'))
    } else if (act === 'edit') openEntryDialog(entry)
    else if (act === 'outdated') {
      await mutate(`/api/entry/${encodeURIComponent(id)}/archive`)
      toast(t('toastArchived'))
    } else if (act === 'open') {
      state.selectedId = id
      state.drawerBankId = null
      renderDrawer()
    }
  } catch (error) {
    toast(t('opFailed') + error.message, 'error')
  }
}

function bindEvents() {
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)))
  $('#refreshBtn').addEventListener('click', () => loadState().then(() => refreshGraph()).catch((error) => toast(t('loadFailed') + error.message, 'error')))
  $('#newEntryBtn').addEventListener('click', () => openEntryDialog())

  $('#globalSearch').addEventListener('input', (event) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.query = event.target.value
      if (state.view === 'memories') renderMemories()
      if (state.view === 'graph') syncGraph()
      state.memLimit = 60
    }, 100)
  })

  for (const [id, key] of [['memBank', 'bank'], ['memStatus', 'status'], ['memKind', 'kind'], ['memSort', 'sort']]) {
    $(`#${id}`).addEventListener('change', (event) => {
      state.memFilters[key] = event.target.value
      state.memLimit = 60
      renderMemories()
    })
  }
  $('#memMore').addEventListener('click', () => { state.memLimit += 60; renderMemories() })

  $('#reviewList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-review]')
    if (button) performEntryAction('review', button.dataset.review)
  })

  $('#memList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]')
    if (button) {
      event.stopPropagation()
      performEntryAction(button.dataset.act, button.dataset.id)
      return
    }
    const row = event.target.closest('.mem-row')
    if (row) {
      state.selectedId = row.dataset.entry
      state.drawerBankId = null
      renderDrawer()
      syncDrawerInset()
      graphView?.focus(row.dataset.entry)
    }
  })

  $('#drawerClose').addEventListener('click', () => {
    state.selectedId = null
    state.drawerBankId = null
    renderDrawer()
    graphView?.select(null)
  })

  $('#drawerBody').addEventListener('click', async (event) => {
    const unrelate = event.target.closest('[data-unrelate]')
    if (unrelate && state.selectedId) {
      try {
        await mutate(`/api/entry/${encodeURIComponent(state.selectedId)}/relate?target=${encodeURIComponent(unrelate.dataset.unrelate)}`, undefined, 'DELETE')
        toast(t('relationRemoved'))
      } catch (error) { toast(t('opFailed') + error.message, 'error') }
      return
    }
    const addRelation = event.target.closest('[data-add-relation]')
    if (addRelation && state.selectedId) {
      const target = $('#drawerBody [data-rel-target]').value
      const type = $('#drawerBody [data-rel-type]').value
      if (!target) return
      try {
        await mutate(`/api/entry/${encodeURIComponent(state.selectedId)}/relate`, { target, type })
        toast(t('relationAdded'))
      } catch (error) { toast(t('opFailed') + error.message, 'error') }
      return
    }
    const bankDrawer = event.target.closest('[data-bank-drawer]')
    if (bankDrawer && state.drawerBankId) {
      const bank = findBank(state.drawerBankId)
      if (bankDrawer.dataset.bankDrawer === 'edit' && bank) openBankDialog(bank)
      if (bankDrawer.dataset.bankDrawer === 'open' && bank) {
        setView('memories')
        state.memFilters.bank = bank.id
        state.drawerBankId = null
        renderDrawer()
        renderMemories()
      }
      return
    }
    const action = event.target.closest('[data-drawer-act]')
    if (action && state.selectedId) performEntryAction(action.dataset.drawerAct, state.selectedId)
  })

  $('#graphFilters').addEventListener('click', (event) => {
    const bankChip = event.target.closest('[data-bank-filter]')
    if (bankChip) {
      const filters = state.graphFilters
      const all = state.data.banks.map((bank) => bank.id)
      if (bankChip.dataset.bankFilter === '*') {
        filters.banks = new Set(all)
        state.graphFilters.banks = filters.banks
      } else {
        const id = bankChip.dataset.bankFilter
        if (filters.banks.has(id)) filters.banks.delete(id)
        else filters.banks.add(id)
        if (filters.banks.size === 0) for (const bankId of all) filters.banks.add(bankId)
      }
      renderGraphFilters()
      syncGraph()
      return
    }
    const kindChip = event.target.closest('[data-kind-filter]')
    if (kindChip) {
      const kind = kindChip.dataset.kindFilter
      if (state.graphFilters.kinds.has(kind)) state.graphFilters.kinds.delete(kind)
      else state.graphFilters.kinds.add(kind)
      renderGraphFilters()
      syncGraph()
      return
    }
    const statusChip = event.target.closest('[data-status-filter]')
    if (statusChip) {
      const status = statusChip.dataset.statusFilter
      if (state.graphFilters.statuses.has(status)) state.graphFilters.statuses.delete(status)
      else state.graphFilters.statuses.add(status)
      renderGraphFilters()
      syncGraph()
      return
    }
    const edgeChip = event.target.closest('[data-edge-filter]')
    if (edgeChip) {
      const type = edgeChip.dataset.edgeFilter
      if (state.graphFilters.edges.has(type)) state.graphFilters.edges.delete(type)
      else state.graphFilters.edges.add(type)
      renderGraphFilters()
      syncGraph()
    }
  })

  $$('[data-graph]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.graph
      if (action === 'rotate') {
        state.graphOptions.rotate = !state.graphOptions.rotate
        button.setAttribute('aria-pressed', String(state.graphOptions.rotate))
        graphView?.setOptions({ autoRotate: state.graphOptions.rotate })
      } else if (action === 'mode') {
        state.graphOptions.mode = state.graphOptions.mode === '3d' ? '2d' : '3d'
        graphView?.setOptions({ mode: state.graphOptions.mode })
        button.querySelector('span').textContent = state.graphOptions.mode === '3d' ? t('toggle3d') : t('toggle3dBack')
      } else if (action === 'reset') {
        graphView?.resetView()
      }
    })
  })

  $('#bankCards').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-bank-act]')
    if (!button) return
    const bank = findBank(button.dataset.id)
    if (!bank) return
    const act = button.dataset.bankAct
    try {
      if (act === 'graph') {
        for (const id of state.graphFilters.banks) {
          if (id !== bank.id) state.graphFilters.banks.delete(id)
        }
        state.graphFilters.banks.add(bank.id)
        setView('graph')
        syncGraph()
        return
      }
      if (act === 'edit') { openBankDialog(bank); return }
      if (act === 'delete') {
        if (!(await confirmAction(t('confirmDeleteBank')))) return
      }
      await mutate(`/api/bank/${encodeURIComponent(bank.id)}/${act}`, undefined, 'POST')
      if (act !== 'delete') toast(act === 'archive' ? t('toastArchived') : t('toastRestored'))
      else toast(t('toastDeleted'))
    } catch (error) { toast(t('opFailed') + error.message, 'error') }
  })

  $('#linkSource').addEventListener('change', renderLinks)
  $('#linkList').addEventListener('change', async (event) => {
    const row = event.target.closest('.link-row')
    if (!row) return
    const recall = row.querySelector('[data-field="recall"]').checked
    const query = row.querySelector('[data-field="query"]').checked
    try {
      if (!recall && !query) {
        await mutate(`/api/link?from=${encodeURIComponent(row.dataset.from)}&to=${encodeURIComponent(row.dataset.to)}`, undefined, 'DELETE')
      } else {
        await mutate('/api/link', { fromBankId: row.dataset.from, toBankId: row.dataset.to, recall, query })
      }
    } catch (error) { toast(t('opFailed') + error.message, 'error') }
  })

  $('#createBankBtn').addEventListener('click', async () => {
    const title = $('#newBankTitle').value.trim()
    if (!title) return
    try {
      await mutate('/api/bank', { title, description: $('#newBankDesc').value.trim() })
      $('#newBankTitle').value = ''
      $('#newBankDesc').value = ''
      toast(t('toastSaved'))
    } catch (error) { toast(t('opFailed') + error.message, 'error') }
  })

  $('#entryForm').addEventListener('submit', submitEntry)
  $('#bankForm').addEventListener('submit', submitBank)
  $('#addRejectedBtn').addEventListener('click', () => addRejectedRow())
  $$('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()))

  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('memstack.theme', next)
    graphView?.setOptions({ palette: themePalette() })
  })

  $('#langBtn').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh'
    localStorage.setItem('memstack.lang', lang)
    applyI18n()
    renderAll()
    renderGraphFilters()
  })

  $('#exportJson').addEventListener('click', () => download('/api/export?format=json'))
  $('#exportMd').addEventListener('click', () => download('/api/export?format=markdown'))

  const dropzone = $('#dropzone')
  const fileInput = $('#importFile')
  dropzone.addEventListener('click', () => fileInput.click())
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('is-over') })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'))
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault()
    dropzone.classList.remove('is-over')
    const file = event.dataTransfer?.files?.[0]
    if (file) readImport(file)
  })
  fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) readImport(fileInput.files[0]) })
  dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.click() })

  $('#importRun').addEventListener('click', runImport)

  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    if (event.key === '/' && !typing) {
      event.preventDefault()
      $('#globalSearch').focus()
    }
    if (event.key === 'Escape' && !typing) {
      state.selectedId = null
      state.drawerBankId = null
      renderDrawer()
      graphView?.select(null)
    }
    if (!typing && ['1', '2', '3', '4'].includes(event.key)) {
      setView(['graph', 'memories', 'banks', 'data'][Number(event.key) - 1])
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll()
  })
  window.addEventListener('resize', () => requestAnimationFrame(syncDrawerInset))
}

async function readImport(file) {
  state.pendingImport = null
  $('#importRun').disabled = true
  try {
    const text = await file.text()
    JSON.parse(text)
    state.pendingImport = { name: file.name, text }
    $('#importRun').disabled = false
    const node = $('#importReport')
    node.hidden = false
    node.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`
  } catch (error) {
    toast(t('fileReadFailed') + error.message, 'error')
  }
}

async function runImport() {
  if (!state.pendingImport) return
  const mode = $('#importMode').value
  if (mode === 'replace' && !(await confirmAction(t('confirmReplace')))) return
  $('#importRun').disabled = true
  try {
    const data = await fetchJson('/api/import', {
      method: 'POST',
      body: JSON.stringify({ bundle: JSON.parse(state.pendingImport.text), mode }),
    })
    applyData(data)
    data.report.backup = data.backup ?? ''
    showImportReport(data.report)
    toast(t('toastImported'))
    state.pendingImport = null
    $('#importFile').value = ''
    refreshGraph()
  } catch (error) {
    toast(t('importFailed') + error.message, 'error')
  } finally {
    $('#importRun').disabled = !state.pendingImport
  }
}

// -------------------------------------------------------------------- boot

function boot() {
  applyI18n()
  bindEvents()
  initGraph()
  const initial = location.hash.slice(1)
  setView(['graph', 'memories', 'banks', 'data'].includes(initial) ? initial : 'graph', { writeHash: false })
  loadState()
    .then(async () => {
      await refreshGraph()
      openHashEntry()
    })
    .catch((error) => toast(t('loadFailed') + error.message, 'error'))
  setInterval(poll, 5000)
  window.addEventListener('hashchange', () => {
    const hash = location.hash.slice(1)
    if (hash.startsWith('entry=')) {
      openHashEntry()
      return
    }
    if (['graph', 'memories', 'banks', 'data'].includes(hash) && hash !== state.view) setView(hash, { writeHash: false })
  })
}

function pauseGraphRotation() {
  if (!state.graphOptions.rotate) return
  state.graphOptions.rotate = false
  graphView?.setOptions({ autoRotate: false })
  const button = $('[data-graph="rotate"]')
  if (button) {
    button.setAttribute('aria-pressed', 'false')
    button.classList.remove('active')
  }
}

function openHashEntry() {
  const hash = location.hash.slice(1)
  if (!hash.startsWith('entry=') || !state.data) return
  const id = decodeURIComponent(hash.slice('entry='.length))
  if (!findEntry(id)) return
  state.selectedId = id
  state.drawerBankId = null
  renderDrawer()
  syncDrawerInset()
  graphView?.select(id)
  graphView?.focus(id)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
