'use strict';
// UI design fixture only. No network requests or real business operations.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const html = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name) => ICONS[name] || '';
const storageKey = 'yummyai-blueprint-fictional-demo-v1';
const fixture = [
  {id:'DEMO-1001',title:'来图异形抱枕',sku:'DEMO-PILLOW-01',quantity:2,status:'待审核',factory:'华东工厂 A（演示）',issue:'需要核对当前制作稿',source:'演示快照 v1',recipe:'演示配方 v3',note:'演示文字：Luna；图片位置待核对'},
  {id:'DEMO-1002',title:'照片毛毯',sku:'DEMO-BLANKET-01',quantity:1,status:'资料待补',factory:'待分配',issue:'买家原图缺失',source:'演示快照 v1',recipe:'待匹配',note:'保留原始选项；缺图不影响其他完整商品'},
  {id:'DEMO-1003',title:'双面姓名挂牌',sku:'DEMO-TAG-02',quantity:1,status:'待工厂接受',factory:'美国工厂 B（演示）',issue:'等待接受指定文件和交期',source:'演示快照 v2',recipe:'演示配方 v2',note:'正面姓名与背面装饰分别固定版本'},
  {id:'DEMO-1004',title:'照片抱枕',sku:'DEMO-PILLOW-02',quantity:1,status:'结果不确定',factory:'华东工厂 A（演示）',issue:'面单请求结果待核对',source:'演示快照 v1',recipe:'演示配方 v1',note:'演示客户参考 DEMO-LABEL-004；只查询原意图'}
];
const viewNames = {orders:'订单与制作',products:'商品方案',factories:'工厂协同',costs:'合格交付成本',roadmap:'建设阶段'};
const stageData = [
  {id:'S0',name:'定义与基线',packages:'B01—B05',result:'明确要做的业务、维护责任和现有能力',items:['走读真实商品与订单','逐模块判断买、接或建','确认试点、数据字典和迁移回退']},
  {id:'S1',name:'平台与主数据',packages:'B06—B12',result:'安全维护商品和工厂的真实事实',items:['认证、租户与对象权限','私有文件、持久任务和纠错','SPU、规格、工厂能力和稳定导航']},
  {id:'S2',name:'商品到上架包',packages:'B13—B20',result:'得到固定版本、可审核的销售资料包',items:['研究、原创印花和定制定义','销售组合、多面配方和图文','规则快照、预检、审核与导出']},
  {id:'S3',name:'接单与审单',packages:'B21—B26',result:'每条订单商品准确固定制造输入',items:['逐操作核验渠道能力','完整 Custom 资料和来源去重','生效映射、审单修订和异常任务']},
  {id:'S4',name:'制作与审核',packages:'B27—B32',result:'正式文件符合指定供应规范',items:['同样本模型评测与完全成本','模板编辑和服务端技术检查','操作员审核、必要校样与失败修复']},
  {id:'S5',name:'工厂网络',packages:'B33—B38',result:'文件、数量、交期和回执可以追踪',items:['BOM、产能与工厂工作日历','逐商品拆单和受限工厂入口','固定交付、质检和关联返工']},
  {id:'S6',name:'履约与成本',packages:'B39—B46',result:'从备料到交运、售后和利润有证据',items:['采购、收货、库存和三单核对','面单意图、实际交运与售后','财务证据、汇率、对账和贡献利润']},
  {id:'S7',name:'经营与推广',packages:'B47—B54',result:'系统可维护，并能验证跨品类复用',items:['广告、指标和开放接口','恢复演练、真实试点和角色培训','第二品类验证；对外卖家为可选扩展']}
];
let saved = {};
try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { saved = {}; }
const validIds = new Set(fixture.map((row) => row.id));
const validStatuses = new Set(['待审核','资料待补','待工厂接受','结果不确定','工厂已接受']);
const state = {view:viewNames[location.hash.slice(1)] ? location.hash.slice(1) : 'orders',selected:'DEMO-1001',checked:new Set((Array.isArray(saved.checked) ? saved.checked : []).filter((id) => validIds.has(id))),statuses:{},query:'',filter:'全部状态',stage:'S0'};
for (const row of fixture) if (validStatuses.has(saved.statuses?.[row.id])) state.statuses[row.id] = saved.statuses[row.id];
const defaults = {model:360,infra:300,maintenanceHours:12,hourly:200,reviewHours:20,reviewRate:60,amortization:500,accepted:1000};
let costValues = {...defaults};
let toastTimer;
let navigationVersion=0;
const rows = () => fixture.map((row) => ({...row,status:state.statuses[row.id] || row.status}));
const rowById = (id) => rows().find((row) => row.id === id);
function save() { try { localStorage.setItem(storageKey,JSON.stringify({checked:[...state.checked],statuses:state.statuses})); } catch { /* The in-tab demo remains operable without storage. */ } }
function badge(status) { const kind = ['资料待补','结果不确定'].includes(status) ? 'amber' : ['待审核','待工厂接受'].includes(status) ? 'blue' : ''; return '<span class="status '+kind+'">'+html(status)+'</span>'; }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'),3200); }
function pageTitle(eyebrow,title,description,action = '') { return '<div class="page-title"><div><div class="eyebrow">'+eyebrow+'</div><h1>'+title+'</h1><p>'+description+'</p></div>'+action+'</div>'; }
function demoNote(text) { return '<div class="page-note">'+icon('Info')+'<span>'+text+'</span></div>'; }
function closeMenu() { const wasOpen=document.body.classList.contains('menu-open'); document.body.classList.remove('menu-open'); $('#menu-toggle').setAttribute('aria-expanded','false'); $('.shell').inert=false; $('#sidebar').removeAttribute('role'); $('#sidebar').removeAttribute('aria-modal'); if (wasOpen) $('#menu-toggle').focus(); }
function navigate(view, push = true) {
  if (!viewNames[view]) return;
  state.view = view;
  if (push) history.pushState(null,'','#'+view);
  closeMenu();
  const version=++navigationVersion;
  $('#main').setAttribute('aria-busy','true');
  const ready=() => { if (version===navigationVersion) $('#main').setAttribute('aria-busy','false'); };
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion:reduce)').matches) document.startViewTransition(() => render()).finished.catch(() => {}).finally(ready);
  else { render(); ready(); }
}
function render() {
  $('#breadcrumb-current').textContent = viewNames[state.view];
  document.title = viewNames[state.view]+' · YummyAI ERP 设计样稿';
  $$('.nav-item[data-view]').forEach((button) => { button.classList.toggle('active',button.dataset.view === state.view); if (button.dataset.view === state.view) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  const renderer = {orders:renderOrders,products:renderProducts,factories:renderFactories,costs:renderCosts,roadmap:renderRoadmap}[state.view];
  $('#main').innerHTML = '<div class="view-enter">'+renderer()+'</div>';
  if (state.view === 'orders') renderOrderRows();
  if (state.view === 'costs') updateCosts();
}
function renderOrders() {
  const blocked = rows().filter((row) => ['资料待补','结果不确定'].includes(row.status)).length;
  return pageTitle('ORDER OPERATIONS','订单与制作','先解决阻断 再推进每一件定制商品','<button class="button" data-action="show-selected">'+icon('ListChecks')+'查看所选</button>')+
    demoNote('当前为 4 条虚构商品数据 可搜索、筛选、打开详情及演示审核 不连接亚马逊、工厂或物流')+
    '<div class="metric-strip"><div class="metric"><div class="metric-label">演示商品行</div><strong>4</strong><small>逐商品核对资料与制作要求</small></div><div class="metric"><div class="metric-label">需要处理</div><strong>'+blocked+'</strong><small>缺原图或外部结果待核对</small></div><div class="metric"><div class="metric-label">工厂待接受</div><strong class="blue">'+rows().filter((row) => row.status === '待工厂接受').length+'</strong><small>接受文件与实际完工分开</small></div></div>'+
    '<div class="workspace"><section class="surface" aria-label="演示订单列表"><div class="surface-head"><h2>待处理商品</h2><small>虚构场景 · 非真实订单</small></div><div class="toolbar"><label class="search-field">'+icon('Search')+'<input id="order-search" aria-label="搜索演示订单" placeholder="搜索订单 商品或 SKU" value="'+html(state.query)+'"></label><select id="status-filter" aria-label="处理状态">'+['全部状态','待审核','资料待补','待工厂接受','结果不确定','工厂已接受'].map((value) => '<option'+(state.filter === value ? ' selected' : '')+'>'+value+'</option>').join('')+'</select></div><div class="selection-bar"><span id="selection-count"></span><button class="link-button" data-action="clear-selection">清空选择</button><span class="push">选择可在刷新后保留</span></div><div class="table-scroll"><table class="order-table"><thead><tr><th class="check-cell"><input id="select-all" type="checkbox" aria-label="选择当前筛选结果"></th><th>订单商品</th><th>商品与数量</th><th>处理状态</th><th>工厂</th><th>下一步</th></tr></thead><tbody id="order-rows"></tbody></table></div><div id="orders-empty" hidden></div><div class="table-foot"><span id="result-count"></span><span>只展示演示数据</span></div></section><aside class="surface" id="detail-panel" aria-label="订单商品详情"></aside></div>';
}
function filteredRows() { const query = state.query.trim().toLocaleLowerCase(); return rows().filter((row) => (state.filter === '全部状态' || row.status === state.filter) && (!query || [row.id,row.title,row.sku,row.factory,row.issue].join(' ').toLocaleLowerCase().includes(query))); }
function renderOrderRows() {
  const focusedCheck=document.activeElement?.dataset?.check;
  const items = filteredRows();
  if (!items.some((row) => row.id === state.selected)) state.selected=items[0]?.id || null;
  $('#order-rows').innerHTML = items.map((row) => '<tr class="'+(state.selected === row.id ? 'is-active' : '')+'"><td class="check-cell"><input type="checkbox" aria-label="选择 '+row.id+'" data-check="'+row.id+'" '+(state.checked.has(row.id) ? 'checked' : '')+'></td><td><button class="link-button order-id" data-order="'+row.id+'">'+row.id+'</button><span class="row-sub">'+row.sku+'</span></td><td><span class="row-title">'+row.title+'</span><span class="row-sub">'+row.quantity+' 件 · 个性化要求按商品固定</span></td><td>'+badge(row.status)+'</td><td><span class="row-sub">'+html(row.factory)+'</span></td><td><button class="link-button" data-order="'+row.id+'">查看详情 '+icon('ChevronRight')+'</button></td></tr>').join('');
  $('#selection-count').textContent = '已选择 '+state.checked.size+' 条';
  $('[data-action="clear-selection"]').disabled = state.checked.size === 0;
  $('[data-action="show-selected"]').disabled = state.checked.size === 0;
  $('#result-count').textContent = '筛选结果 '+items.length+' / 4 条';
  $('#select-all').checked = items.length > 0 && items.every((row) => state.checked.has(row.id));
  $('#select-all').indeterminate = items.some((row) => state.checked.has(row.id)) && !$('#select-all').checked;
  $('#orders-empty').hidden = items.length > 0;
  $('#orders-empty').innerHTML = items.length ? '' : '<div class="empty">'+icon('SearchX')+'<strong>没有符合条件的演示商品</strong>调整搜索词或状态后继续查看<br><button class="link-button" data-action="clear-filters">清除筛选</button></div>';
  renderDetail();
  if (focusedCheck) document.querySelector('input[data-check="'+focusedCheck+'"]')?.focus({preventScroll:true});
}
function detailMarkup(row) {
  const ready = row.status === '待审核';
  const stage = row.status === '资料待补' ? 0 : ready ? 2 : row.status === '结果不确定' ? 4 : 3;
  const stages = ['原始资料与需求','制作与技术检查','操作员审核','工厂接受指定版本','实际交运与费用'];
  const action = ready ? '<button class="button primary" data-action="review" data-id="'+row.id+'">'+icon('FileCheck2')+'查看审核清单</button>' : row.status === '资料待补' ? '<button class="button" data-action="missing" data-id="'+row.id+'">查看缺项</button>' : row.status === '结果不确定' ? '<button class="button" data-action="uncertain" data-id="'+row.id+'">核对原购单意图</button>' : '<button class="button primary" data-view="factories">查看工厂交付</button>';
  return '<div class="detail detail-enter"><div class="detail-header"><span class="identity-line">'+row.id+'</span>'+badge(row.status)+'</div><h3>'+row.title+'</h3><div class="identity-line">'+row.sku+' · '+row.quantity+' 件</div><div class="evidence-grid"><div class="placeholder-image">'+icon('Image')+'买家原图占位</div><div class="placeholder-image">'+icon('ScanLine')+'制作稿占位</div></div><div class="detail-block"><h4>当前要求与依据</h4><dl class="facts"><dt>需求摘要</dt><dd>'+html(row.note)+'</dd><dt>来源版本</dt><dd>'+row.source+'</dd><dt>制作配方</dt><dd>'+row.recipe+'</dd><dt>下一步</dt><dd>'+row.issue+'</dd></dl></div><div class="detail-block"><h4>商品交付轨迹</h4><ol class="timeline">'+stages.map((label,i) => '<li class="'+(i < stage ? 'done' : i === stage ? 'current' : '')+'">'+label+(i === stage ? ' · 当前阶段' : '')+'</li>').join('')+'</ol></div><div class="detail-block"><div class="detail-actions">'+action+'</div><p class="detail-hint">图片和版本均为占位 当前操作只改变演示状态 不产生真实审核、工厂任务或费用</p></div></div>';
}
function renderDetail() { const row = rowById(state.selected); const target = $('#detail-panel'); if (target) target.innerHTML = row ? detailMarkup(row) : '<div class="empty"><strong>等待选择商品</strong>当前筛选没有结果 调整条件后查看详情</div>'; }
function openOrder(id) { state.selected = id; renderOrderRows(); document.querySelector('[data-order="'+id+'"]')?.focus({preventScroll:true}); if (matchMedia('(max-width:1180px)').matches) { $('#mobile-detail-body').innerHTML = detailMarkup(rowById(id)); $('#detail-dialog').showModal(); } }
function showDialog(title,body) { if ($('#detail-dialog').open) $('#detail-dialog').close(); $('#dialog-heading').textContent = title; $('#dialog-body').innerHTML = body; $('#action-dialog').classList.remove('closing'); if (!$('#action-dialog').open) $('#action-dialog').showModal(); }
function closeDialog(dialog) { if (!dialog.open) return; if (matchMedia('(prefers-reduced-motion:reduce)').matches) { dialog.close(); return; } dialog.classList.add('closing'); setTimeout(() => { dialog.close(); dialog.classList.remove('closing'); },130); }
function reviewDialog(id) { showDialog('核对当前演示稿','<p class="dialog-copy">检查对象 '+id+' 的指定演示版本 下面动作仅用于评审工作台交互</p><ul class="dialog-list"><li>原始图片、文字与选项和本商品一致</li><li>正式文件满足本商品固定的供应规范</li><li>当前文件与审核清单引用相同版本</li><li>客户确认是否需要已按规则单独记录</li></ul><label class="dialog-check"><input id="review-confirm" type="checkbox"><span>我已核对以上演示清单并理解它不构成真实生产审核</span></label><div class="dialog-actions"><button class="button" data-action="close-dialog">返回查看</button><button id="review-submit" class="button primary" disabled data-action="approve" data-id="'+id+'">批准演示稿</button></div>'); }
function renderProducts() {
  return pageTitle('PRODUCT SOLUTION','商品方案','把产品事实 定制方式 生产配方和供应能力放在一起')+demoNote('以下是商品结构与状态的示例 所有规格、工艺和样品仍需以真实供应规范核验')+
    '<section class="surface"><div class="surface-head"><h2>可复用的商品方案</h2><small>载体 → 规格 → 印花 → 销售 SKU → 配方</small></div><div class="table-scroll"><table class="product-table"><thead><tr><th>商品方案</th><th>定制输入</th><th>制造依据</th><th>准备状态</th><th>查看</th></tr></thead><tbody><tr><td><strong>来图异形抱枕</strong><span class="row-sub">DEMO-SPU-01</span></td><td>图片 文字 款式选择</td><td>专门工艺版本<span class="row-sub">尺寸口径与裁线独立检查</span></td><td>'+badge('资料待补')+'</td><td><button class="link-button" data-action="product-detail" data-id="0">查看方案</button></td></tr><tr><td><strong>照片毛毯</strong><span class="row-sub">DEMO-SPU-02</span></td><td>图片 拼图与文字</td><td>印刷区域与材质规范<span class="row-sub">不继承抱枕制造参数</span></td><td><span class="status">模板设计中</span></td><td><button class="link-button" data-action="product-detail" data-id="1">查看方案</button></td></tr><tr><td><strong>双面姓名挂牌</strong><span class="row-sub">DEMO-SPU-03</span></td><td>姓名 正反面选项</td><td>正反面印花绑定<span class="row-sub">字段到制作区域精确映射</span></td><td><span class="status blue">方案演示</span></td><td><button class="link-button" data-action="product-detail" data-id="2">查看方案</button></td></tr></tbody></table></div></section>'+
    '<div class="content-grid section-gap"><section class="surface padded"><h3>商品方案应该交付什么</h3><div class="item-list"><div class="list-item"><div><strong>产品真实事实</strong><p>结构、材质、尺寸口径、重量、包装与允许定制范围</p></div>'+icon('Layers')+'</div><div class="list-item"><div><strong>固定的制作依据</strong><p>规格、模板、印花、规则、供应能力与文件版本</p></div>'+icon('FileCheck2')+'</div><div class="list-item"><div><strong>销售与履约经济模型</strong><p>素材、价格、生产地点、交期及有依据的成本</p></div>'+icon('ChartNoAxesCombined')+'</div></div></section><section class="surface padded"><h3>版本变化如何处理</h3><p class="text-small muted">只升级已固定的印花或工艺版本时 修订配方<br>改变正反面、区域或字段映射等组合身份时 新建销售 SKU<br>已有订单继续使用当时固定的版本</p><a class="button section-gap" href="04-data-and-contracts.md">阅读数据与契约 '+icon('ArrowUpRight')+'</a></section></div>';
}
function renderFactories() {
  const tasks = rows().filter((row) => ['待工厂接受','工厂已接受'].includes(row.status));
  return pageTitle('FACTORY COLLABORATION','工厂协同','围绕指定文件 数量和交期交接每项任务')+demoNote('此页演示受限工厂入口的内容范围 真实对象权限仍需服务器与 RLS 验证')+
    '<div class="content-grid"><section><div class="surface-head" style="padding:0 0 16px;border:0"><h2>指定版本交付任务</h2><small>'+tasks.length+' 项演示任务</small></div>'+tasks.map((row) => '<article class="surface padded factory-task '+(row.status === '工厂已接受' ? 'accepted' : '')+'" style="margin-bottom:15px"><div class="task-title"><div><h2>'+row.title+'</h2><p>'+row.id+' · '+row.factory+'</p></div>'+badge(row.status)+'</div><dl class="facts"><dt>交付文件</dt><dd>DEMO-'+row.id+'-v3.jpg（占位）</dd><dt>指定数量</dt><dd>'+row.quantity+' 件</dd><dt>文件校验</dt><dd>FAKE-HASH-'+row.id.slice(-4)+'（演示标识）</dd><dt>约定交期</dt><dd>演示截止时间 待真实日历核验</dd></dl><div class="task-footer"><small>接收、接受、生产、质检与交运<br>各自保留独立结果</small><div><button class="button" data-action="manifest" data-id="'+row.id+'">查看清单</button><button class="button primary" data-action="factory-accept" data-id="'+row.id+'" '+(row.status === '工厂已接受' ? 'disabled' : '')+'>'+(row.status === '工厂已接受' ? '演示已接受' : '接受演示任务')+'</button></div></div></article>').join('')+'</section><section class="surface padded"><h3>协作入口的最小范围</h3><ol class="timeline"><li class="done">只见被分配的任务与资料</li><li class="done">文件下载固定版本与用途</li><li class="current">接受时核对文件、数量与交期</li><li>进度与质检按真实证据登记</li><li>返工、差异费用与对账单独处理</li></ol><div class="warning-box section-gap">工厂收到文件不等于已经接受<br>接受文件不等于生产完成</div></section></div>';
}
function costField(id,label,small,step = '1') { return '<label class="field">'+label+'<input id="cost-'+id+'" data-cost="'+id+'" type="number" min="'+(id === 'accepted' ? '1' : '0')+'" step="'+step+'" value="'+costValues[id]+'"><small>'+small+'</small></label>'; }
function renderCosts() {
  return pageTitle('UNIT ECONOMICS','合格交付成本','把模型 人工 维护与复核放进同一笔账')+demoNote('所有输入均是假设 可自行调整 原材料中的低模型费不能替代实际交付成本验证')+
    '<div class="content-grid"><section class="surface padded"><h3>每月成本假设 · 人民币</h3><div class="cost-inputs">'+costField('model','模型调用费','元 / 月','0.01')+costField('infra','基础设施','元 / 月','0.01')+costField('maintenanceHours','维护工时','小时 / 月','0.5')+costField('hourly','维护小时成本','元 / 小时','0.01')+costField('reviewHours','业务复核工时','小时 / 月','0.5')+costField('reviewRate','复核小时成本','元 / 小时','0.01')+costField('amortization','开发与其他摊销','元 / 月','0.01')+costField('accepted','验收通过交付数','件 / 月')+'</div><div class="cost-actions"><button class="button" data-action="double-review">复核工时翻倍</button><button class="button" data-action="reset-costs">恢复假设基线</button></div></section><section class="surface padded" aria-live="polite"><div class="eyebrow">每件验收通过交付</div><div id="unit-cost" class="calculation-value"></div><div class="calculation-caption">按完整列出的月度成本 / 合格交付数量</div><div class="cost-breakdown" id="cost-breakdown"></div><p id="cost-error" class="error-copy" hidden></p><div class="warning-box section-gap">便宜的单次调用不一定带来更低的交付成本<br>错误、重试和复核要计入分母对应的实际成本</div><p class="text-small muted">这不是订单商品利润测算 生产、货款、物流和广告等业务成本需要在独立利润模型中核对</p><a href="14-critical-reading-agent-decisions.md">阅读材料辩证分析 '+icon('ArrowUpRight')+'</a></section></div>';
}
function updateCosts() {
  const inputs = $$('[data-cost]');
  const invalid = inputs.some((input) => input.value.trim() === '' || !Number.isFinite(Number(input.value)) || Number(input.value) < (input.dataset.cost === 'accepted' ? 1 : 0) || (input.dataset.cost === 'accepted' && !Number.isInteger(Number(input.value))));
  if (invalid) { $('#unit-cost').textContent = '—'; $('#cost-breakdown').innerHTML = ''; $('#cost-error').hidden = false; $('#cost-error').textContent = '填写非负成本 合格交付数量须为大于零的整数'; return; }
  inputs.forEach((input) => costValues[input.dataset.cost] = Number(input.value));
  const maintenance = costValues.maintenanceHours * costValues.hourly;
  const review = costValues.reviewHours * costValues.reviewRate;
  const total = costValues.model + costValues.infra + maintenance + review + costValues.amortization;
  const money = (value) => '¥'+value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  $('#unit-cost').textContent = money(total / costValues.accepted);
  const values = [['模型与基础设施',costValues.model+costValues.infra],['技术维护',maintenance],['业务复核',review],['开发与其他摊销',costValues.amortization],['月度成本合计',total]];
  $('#cost-breakdown').innerHTML = values.map(([name,value],i) => '<div class="cost-line '+(i === values.length-1 ? 'total' : '')+'"><span>'+name+'</span><strong>'+money(value)+'</strong></div>').join('');
  $('#cost-error').hidden = true;
}
function renderRoadmap() {
  const stage = stageData.find((item) => item.id === state.stage);
  return pageTitle('BUILD THE ERP','建设阶段','每一步交付可验收的业务结果 不以页面数量计进度')+demoNote('所有阶段均为规划 21—35 周是需基线验证的讨论估算 不是交付承诺')+
    '<div class="step-grid">'+stageData.map((item) => '<button class="step-button '+(item.id === state.stage ? 'active' : '')+'" data-stage="'+item.id+'" aria-pressed="'+(item.id === state.stage)+'"><strong>'+item.id+'</strong><span>'+item.name+'</span></button>').join('')+'</div><div class="content-grid"><section class="surface padded stage-detail"><div class="stage-number">'+stage.id+' · '+stage.packages+'</div><h2>'+stage.result+'</h2><ul>'+stage.items.map((value) => '<li>'+value+'</li>').join('')+'</ul><a class="button" href="07-engineering-backlog.md">打开全部工作包 '+icon('ArrowUpRight')+'</a></section><section class="surface padded"><h3>每个工作包的完成条件</h3><ol class="timeline"><li class="done">业务输入输出、权限与异常写清楚</li><li class="done">共享契约、服务、页面与版本贯通</li><li class="current">相关测试和真实可见交互有证据</li><li>测试资源已清理 手册已更新</li><li>外部已成功与技术已完成分开</li></ol></section></div>';
}
document.addEventListener('click',(event) => {
  const target = event.target.closest('button,a');
  if (!target) return;
  if (target.dataset.view) { event.preventDefault(); navigate(target.dataset.view); return; }
  if (target.dataset.order) { openOrder(target.dataset.order); return; }
  if (target.dataset.stage) { state.stage = target.dataset.stage; render(); return; }
  const action = target.dataset.action;
  if (action === 'close-dialog') closeDialog($('#action-dialog'));
  if (action === 'close-detail') closeDialog($('#detail-dialog'));
  if (action === 'clear-selection') { state.checked.clear(); save(); renderOrderRows(); toast('已清空演示选择'); }
  if (action === 'clear-filters') { state.query=''; state.filter='全部状态'; render(); $('#order-search').focus(); }
  if (action === 'show-selected') showDialog('所选演示商品','<p class="dialog-copy">当前选择 '+state.checked.size+' 条 刷新后可以保留选择</p><ul class="dialog-list">'+[...state.checked].map((id) => '<li>'+id+' · '+rowById(id).title+' · '+rowById(id).status+'</li>').join('')+'</ul>');
  if (action === 'review') reviewDialog(target.dataset.id);
  if (action === 'approve' && $('#review-confirm')?.checked) { state.statuses[target.dataset.id]='待工厂接受'; save(); closeDialog($('#action-dialog')); render(); toast('已批准演示稿 仅更新样稿状态'); }
  if (action === 'missing') showDialog('本商品缺少原图','<p class="dialog-copy">保留已提供的文字与选项 给本商品创建补充资料待办 其他完整商品继续处理</p><div class="warning-box">实际系统需通过授权渠道取得原始图片 不以预览图替代原件</div>');
  if (action === 'uncertain') showDialog('核对原购单意图','<p class="dialog-copy">演示参考 DEMO-LABEL-004 外部结果尚未确认 已预留预算继续占用</p><ul class="dialog-list"><li>查询相同账户与原客户参考号</li><li>保存实际订单、费用与面单结果</li><li>一次查询未发现时继续核对 不自动重新购买</li></ul><div class="dialog-actions"><button class="button" data-action="close-dialog">返回查看</button></div>');
  if (action === 'manifest') { const row = rowById(target.dataset.id); showDialog('演示交付清单','<p class="dialog-copy">'+row.id+' · '+row.factory+'</p><dl class="facts"><dt>商品</dt><dd>'+row.title+'</dd><dt>数量</dt><dd>'+row.quantity+' 件</dd><dt>固定版本</dt><dd>演示正式稿 v3</dd><dt>原始依据</dt><dd>'+row.source+' / '+row.recipe+'</dd></dl><p class="detail-hint">这里没有真实文件 不会下载生产包或向工厂发送资料</p>'); }
  if (action === 'factory-accept') showDialog('接受指定演示任务','<p class="dialog-copy">'+target.dataset.id+' 请核对指定文件、数量、工艺与承诺时间</p><label class="dialog-check"><input id="factory-confirm" type="checkbox"><span>已核对本次演示清单 接受不代表生产完成或实际交运</span></label><div class="dialog-actions"><button class="button" data-action="close-dialog">返回</button><button id="factory-submit" class="button primary" disabled data-action="confirm-factory" data-id="'+target.dataset.id+'">确认演示接受</button></div>');
  if (action === 'confirm-factory' && $('#factory-confirm')?.checked) { state.statuses[target.dataset.id]='工厂已接受'; save(); closeDialog($('#action-dialog')); render(); toast('演示已接受 未提交真实工厂任务'); }
  if (action === 'product-detail') showDialog('商品方案包含的固定关系','<p class="dialog-copy">商品事实 → 规格版本 → 原创印花/来图模板 → 多面绑定 → 销售 SKU → 制作配方 → 审核上架包</p><ul class="dialog-list"><li>每个品类读取自己的制造规范</li><li>未知样品、报价与交期保持待核验</li><li>修改未来版本不改写已接订单</li></ul>');
  if (action === 'double-review') { costValues.reviewHours *= 2; $('#cost-reviewHours').value=String(costValues.reviewHours); updateCosts(); }
  if (action === 'reset-costs') { costValues={...defaults}; render(); toast('已恢复虚构成本假设'); }
});
document.addEventListener('input',(event) => { if (event.target.id === 'order-search') { state.query=event.target.value; renderOrderRows(); } if (event.target.dataset.cost) updateCosts(); });
document.addEventListener('change',(event) => {
  const target=event.target;
  if (target.id === 'status-filter') { state.filter=target.value; renderOrderRows(); }
  if (target.dataset.check) { if (target.checked) state.checked.add(target.dataset.check); else state.checked.delete(target.dataset.check); save(); renderOrderRows(); }
  if (target.id === 'select-all') { filteredRows().forEach((row) => { if (target.checked) state.checked.add(row.id); else state.checked.delete(row.id); }); save(); renderOrderRows(); }
  if (target.id === 'review-confirm') $('#review-submit').disabled=!target.checked;
  if (target.id === 'factory-confirm') $('#factory-submit').disabled=!target.checked;
});
$('#menu-toggle').addEventListener('click',() => { const opened=document.body.classList.toggle('menu-open'); $('#menu-toggle').setAttribute('aria-expanded',String(opened)); $('.shell').inert=opened; if (opened) { $('#sidebar').setAttribute('role','dialog'); $('#sidebar').setAttribute('aria-modal','true'); $('.sidebar .nav-item.active').focus(); } else closeMenu(); });
$('#nav-shade').addEventListener('click',closeMenu);
document.addEventListener('keydown',(event) => {
  if (event.key === 'Escape' && document.body.classList.contains('menu-open')) { event.preventDefault(); closeMenu(); }
  if (event.key === 'Tab' && document.body.classList.contains('menu-open')) {
    const focusable=$$('a[href],button:not(:disabled)', $('#sidebar')); const first=focusable[0]; const last=focusable[focusable.length-1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
$('#reset-demo').addEventListener('click',() => { state.statuses={}; state.checked.clear(); state.query=''; state.filter='全部状态'; state.stage='S0'; costValues={...defaults}; try { localStorage.removeItem(storageKey); } catch { /* The in-memory demo still resets when browser storage is unavailable. */ } if ($('#action-dialog').open) $('#action-dialog').close(); if ($('#detail-dialog').open) $('#detail-dialog').close(); render(); toast('已重置所有演示状态和选择'); });
$$('dialog').forEach((dialog) => {
  dialog.addEventListener('cancel',(event) => { event.preventDefault(); closeDialog(dialog); });
  dialog.addEventListener('close',() => { if (document.activeElement === document.body) $('#main').focus(); });
});
window.addEventListener('popstate',() => navigate(viewNames[location.hash.slice(1)] ? location.hash.slice(1) : 'orders',false));
render();
