const root=document.querySelector('#app');
const toastRoot=document.querySelector('#toast-root');
const state={me:null,orgs:[],orgId:localStorage.getItem('relay.orgId'),sse:null};

const esc=(v='')=>String(v).replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt=(v)=>v?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(v)):'—';
const ago=(v)=>{if(!v)return'—';const s=Math.floor((Date.now()-new Date(v))/1000);if(s<60)return`${Math.max(0,s)}s ago`;if(s<3600)return`${Math.floor(s/60)}m ago`;if(s<86400)return`${Math.floor(s/3600)}h ago`;return`${Math.floor(s/86400)}d ago`};
const stateLabel=(v)=>({OPERATIONAL:'Operational',DEGRADED_PERFORMANCE:'Degraded performance',PARTIAL_OUTAGE:'Partial outage',MAJOR_OUTAGE:'Major outage',MAINTENANCE:'Maintenance'}[v]??v);
const statusLabel=(v)=>({INVESTIGATING:'Investigating',IDENTIFIED:'Identified',MONITORING:'Monitoring',RESOLVED:'Resolved'}[v]??v);
const badgeState=(v)=>`<span class="badge state-${esc(v)}"><span class="dot"></span>${esc(stateLabel(v))}</span>`;
const badgeSeverity=(v)=>`<span class="badge sev-${esc(v)}"><span class="dot"></span>${esc(v)}</span>`;
const badgeStatus=(v)=>`<span class="badge status-${esc(v)}"><span class="dot"></span>${esc(statusLabel(v))}</span>`;

function toast(message,type='info'){const el=document.createElement('div');el.className=`toast ${type==='error'?'error':''}`;el.textContent=message;toastRoot.replaceChildren(el);setTimeout(()=>el.remove(),4200)}

// Shared modal behavior: initial focus inside the dialog, Escape to close,
// Tab cycling within the dialog, and focus restored to the invoking control.
function openModal(backdrop){
  document.body.append(backdrop);
  const previous=document.activeElement;
  const dialog=backdrop.querySelector('[role="dialog"]')??backdrop.querySelector('.modal');
  if(dialog){dialog.setAttribute('tabindex','-1');const first=dialog.querySelector('input:not([type=hidden]),select,textarea,button');(first??dialog).focus({preventScroll:true})}
  const focusables=()=>[...backdrop.querySelectorAll('button,input,select,textarea,a[href]')].filter((el)=>!el.disabled);
  const onKeydown=(e)=>{
    if(e.key==='Escape'){e.stopPropagation();close()}
    else if(e.key==='Tab'){const list=focusables();if(!list.length)return;const first=list[0],last=list[list.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&(document.activeElement===last||!backdrop.contains(document.activeElement))){e.preventDefault();first.focus()}}
  };
  document.addEventListener('keydown',onKeydown,true);
  backdrop.addEventListener('mousedown',(e)=>{if(e.target===backdrop)close()});
  function close(){document.removeEventListener('keydown',onKeydown,true);backdrop.remove();if(previous&&previous.isConnected)previous.focus({preventScroll:true})}
  return{close};
}

async function api(path,{method='GET',body,headers={}}={}){
  const response=await fetch(path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
  let payload={};try{payload=await response.json()}catch{}
  if(!response.ok){const error=new Error(payload?.error?.message??`Request failed (${response.status}).`);error.status=response.status;error.code=payload?.error?.code;throw error}
  if(payload.warnings?.length)toast(payload.warnings.map((x)=>x.message).join(' '),'error');
  return payload.data;
}

function navigate(path){history.pushState({},'',path);renderRoute().catch(handleFatal)}
window.addEventListener('popstate',()=>renderRoute().catch(handleFatal));
document.addEventListener('click',(event)=>{const a=event.target.closest('a[data-nav]');if(!a)return;if(a.origin!==location.origin)return;event.preventDefault();navigate(a.pathname)});
function handleFatal(error){console.error(error);if(error.status===401){state.me=null;navigate('/signin');return}root.innerHTML=`<div class="onboarding"><div class="card"><h2>Relay hit an error</h2><p class="muted">${esc(error.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`}

function authLayout(kind){
  const isLogin=kind==='login';
  root.innerHTML=`<main class="auth-page">
    <section class="auth-art"><div class="brand"><div class="brand-mark">R</div>Relay</div><div class="auth-copy"><span class="eyebrow">Incident operations, connected</span><h1>Run the incident.<br>Own the story.</h1><p>Coordinate responders, keep an internal timeline, and publish a clean public status from the same canonical incident.</p></div><div class="auth-proof"><span class="proof">Open-source core</span><span class="proof">Self-hostable</span><span class="proof">API-first</span></div></section>
    <section class="auth-panel"><div class="auth-card"><h2>${isLogin?'Welcome back':'Create your account'}</h2><p>${isLogin?'Sign in to your Relay workspace.':'Start a new self-hosted Relay workspace.'}</p>
      <form id="auth-form">${isLogin?'':`<div class="field"><label for="displayName">Display name</label><input class="input" id="displayName" name="displayName" autocomplete="name" required minlength="2"></div>`}<div class="field"><label for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="email" required></div><div class="field"><label for="password">Password</label><input class="input" id="password" name="password" type="password" autocomplete="${isLogin?'current-password':'new-password'}" required minlength="10"></div><button class="btn btn-primary btn-block" type="submit">${isLogin?'Sign in':'Create account'}</button></form>
      <div class="auth-switch">${isLogin?`New to Relay? <a data-nav href="/register">Create an account</a>`:`Already have an account? <a data-nav href="/signin">Sign in</a>`}</div></div></section></main>`;
  document.querySelector('#auth-form').addEventListener('submit',async(e)=>{e.preventDefault();const fd=new FormData(e.currentTarget);const body=Object.fromEntries(fd);try{const data=await api(`/api/v1/auth/${isLogin?'login':'register'}`,{method:'POST',body});state.me=data.user;state.orgs=data.organizations??[];if(state.orgs[0]){state.orgId=state.orgs[0].id;localStorage.setItem('relay.orgId',state.orgId)}navigate('/app')}catch(error){toast(error.message,'error')}});
}

function renderOnboarding(){
  stopSse();root.innerHTML=`<main class="onboarding"><section class="card"><div class="brand"><div class="brand-mark">R</div>Relay</div><h1 style="margin-top:28px">Create your workspace</h1><p class="muted">A workspace is an isolated Relay organization containing your services, components, incidents, and status pages.</p><form id="org-form"><div class="field"><label for="org-name">Organization name</label><input id="org-name" class="input" required minlength="2" placeholder="Acme Operations"></div><div class="field"><label for="org-slug">Slug <span class="muted">(optional)</span></label><input id="org-slug" class="input" placeholder="acme"></div><button class="btn btn-primary" type="submit">Create workspace</button></form></section></main>`;
  document.querySelector('#org-form').addEventListener('submit',async(e)=>{e.preventDefault();try{const org=await api('/api/v1/organizations',{method:'POST',body:{name:document.querySelector('#org-name').value,slug:document.querySelector('#org-slug').value||undefined}});state.orgs=[...state.orgs,{...org,role:'OWNER'}];state.orgId=org.id;localStorage.setItem('relay.orgId',org.id);navigate('/app')}catch(error){toast(error.message,'error')}})
}

const navItems=[['/app','⌂','Overview'],['/app/alerts','◈','Alerts'],['/app/oncall','◷','On-call'],['/app/incidents','⚡','Incidents'],['/app/services','◫','Services'],['/app/components','◉','Components'],['/app/teams','◎','Teams'],['/app/routing','⇶','Routing'],['/app/status-pages','◌','Status pages'],['/app/settings','⚙','Settings']];
function shell(title,content,actions=''){
  const org=state.orgs.find((x)=>x.id===state.orgId)??state.orgs[0];
  const path=location.pathname;
  return `<div class="app-shell"><aside class="sidebar" id="sidebar"><div class="brand"><div class="brand-mark">R</div>Relay</div><div class="workspace-switch"><div class="kicker">Workspace</div><select id="workspace-select" aria-label="Workspace">${state.orgs.map((o)=>`<option value="${esc(o.id)}" ${o.id===state.orgId?'selected':''}>${esc(o.name)}</option>`).join('')}</select></div><nav class="nav">${navItems.map(([href,icon,label])=>`<a data-nav href="${href}" class="${path===href||(href==='/app/incidents'&&path.startsWith('/app/incidents/'))?'active':''}"><span class="nav-icon">${icon}</span>${label}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="user-chip"><div class="avatar">${esc((state.me?.displayName??'?').slice(0,1).toUpperCase())}</div><div class="user-meta"><strong>${esc(state.me?.displayName)}</strong><span>${esc(state.me?.email)}</span></div><button id="logout" class="btn btn-ghost btn-sm" title="Sign out">↪</button></div></div></aside><main class="main"><header class="topbar"><div style="display:flex;align-items:center;gap:10px"><button id="mobile-menu" class="btn btn-ghost btn-sm mobile-menu" aria-label="Open menu">☰</button><div class="topbar-title">${esc(title)}</div></div><div class="topbar-actions">${actions}</div></header><div class="content">${content}</div></main></div>`;
}

function bindShell(){
  document.querySelector('#workspace-select')?.addEventListener('change',(e)=>{state.orgId=e.target.value;localStorage.setItem('relay.orgId',state.orgId);startSse();renderRoute().catch(handleFatal)});
  document.querySelector('#logout')?.addEventListener('click',async()=>{try{await api('/api/v1/auth/logout',{method:'POST'})}catch{}state.me=null;state.orgs=[];state.orgId=null;localStorage.removeItem('relay.orgId');stopSse();navigate('/signin')});
  document.querySelector('#mobile-menu')?.addEventListener('click',()=>document.querySelector('#sidebar')?.classList.toggle('open'));
}

function startSse(){
  stopSse();if(!state.orgId)return;const stream=new EventSource(`/api/v1/organizations/${state.orgId}/events`);stream.addEventListener('relay',()=>{const el=document.activeElement;if(el&&['INPUT','TEXTAREA','SELECT'].includes(el.tagName))return;renderRoute({quiet:true}).catch(()=>{})});state.sse=stream;
}
function stopSse(){state.sse?.close();state.sse=null}

async function ensureMe(){
  if(state.me)return;
  try{const data=await api('/api/v1/me');state.me=data.user;state.orgs=data.organizations??[];if(!state.orgs.some((o)=>o.id===state.orgId))state.orgId=state.orgs[0]?.id;if(state.orgId)localStorage.setItem('relay.orgId',state.orgId)}catch(error){if(error.status===401)return;throw error}
}

function empty(title,text){return `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`}
function incidentRows(incidents){return incidents.map((i)=>`<tr><td><a data-nav class="name-cell" href="/app/incidents/${esc(i.id)}">${esc(i.title)}</a><div class="subtext">Started ${esc(ago(i.startedAt))}</div></td><td>${badgeSeverity(i.severity)}</td><td>${badgeStatus(i.status)}</td><td>${i.responders?.length??0}</td><td>${esc(fmt(i.updatedAt))}</td></tr>`).join('')}

async function renderDashboard(seq=++renderSeq){
  const [services,components,incidents,pages,oncallData,alerts]=await Promise.all([api(`/api/v1/organizations/${state.orgId}/services`),api(`/api/v1/organizations/${state.orgId}/components`),api(`/api/v1/organizations/${state.orgId}/incidents`),api(`/api/v1/organizations/${state.orgId}/status-pages`),api(`/api/v1/organizations/${state.orgId}/oncall/state`).catch(()=>({at:null,oncall:[]})),api(`/api/v1/organizations/${state.orgId}/alerts`).catch(()=>[])]);
  const active=incidents.filter((i)=>i.status!=='RESOLVED');
  const oncallNow=oncallData.oncall.filter((x)=>x.current.resolved);
  const unacked=alerts.filter((a)=>a.routing&&!a.routing.acknowledgedAt);
  const content=`<div class="page-head"><div><h1>Operations overview</h1><p>Current service health and active response work.</p></div><a data-nav class="btn btn-primary" href="/app/incidents">Create incident</a></div><section class="summary-strip" aria-label="Operations summary"><div class="summary-item"><span class="summary-label">Active incidents</span><strong>${active.length}</strong><span class="summary-hint">${active.length?'Requires attention':'Nothing active'}</span></div><div class="summary-item"><span class="summary-label">Services</span><strong>${services.length}</strong><span class="summary-hint">Internal systems</span></div><div class="summary-item"><span class="summary-label">Components</span><strong>${components.length}</strong><span class="summary-hint">Public health surfaces</span></div><div class="summary-item"><span class="summary-label">Status pages</span><strong>${pages.length}</strong><span class="summary-hint">Customer communication</span></div><div class="summary-item"><span class="summary-label">On call</span><strong>${oncallNow.length?esc(oncallNow[0].current.displayName??'1'):'—'}</strong><span class="summary-hint">${oncallNow.length?`${oncallNow.length} schedule${oncallNow.length===1?'':'s'} covered`:'Nobody resolved'}</span></div><div class="summary-item"><span class="summary-label">Unacked alerts</span><strong>${unacked.length}</strong><span class="summary-hint">${unacked.length?'Waiting for a responder':'Nothing waiting'}</span></div></section><section class="section oncall-strip"><div class="section-head"><h2>Who is on call right now?</h2><a data-nav class="btn btn-sm" href="/app/oncall">On-call</a></div>${oncallData.oncall.length?`<div class="oncall-grid">${oncallData.oncall.slice(0,4).map((x)=>`<div class="oncall-card ${x.current.resolved?'live':'idle'}"><div class="oncall-who">${x.current.resolved?`<div class="avatar">${esc((x.current.displayName??'?').slice(0,1).toUpperCase())}</div><div><strong>${esc(x.current.displayName??'Responder')}</strong><span class="subtext">${esc(x.schedule.name)}${x.current.source==='OVERRIDE'?' · override':''}</span></div>`:`<div><strong>No responder</strong><span class="subtext">${esc(x.schedule.name)} · ${esc(routingLabel(x.current.reason))}</span></div>`}</div><div class="oncall-meta"><span class="subtext">Next handoff ${esc(x.current.periodEndsAt?fmtTz(x.current.periodEndsAt,x.schedule.timeZone):(x.next[0]?fmtTz(x.next[0].startsAt,x.schedule.timeZone):'—'))}</span><span class="subtext">${esc(x.schedule.timeZone)}</span></div></div>`).join('')}</div>`:empty('No on-call schedules','Create a responder team and schedule to route alerts to a person.')}</section><section class="section"><div class="section-head"><h2>Active incidents</h2><span>${active.length} open</span></div><div class="table-wrap">${active.length?`<table><thead><tr><th>Incident</th><th>Severity</th><th>Status</th><th>Responders</th><th>Updated</th></tr></thead><tbody>${incidentRows(active)}</tbody></table>`:empty('All systems quiet','Create an incident when service reliability is affected.')}</div></section><section class="section grid grid-2"><div class="card"><div class="section-head"><h2>Component health</h2><span>${components.length} components</span></div>${components.length?components.slice(0,8).map((c)=>`<div class="component-row" style="padding-left:0;padding-right:0;background:transparent"><strong>${esc(c.name)}</strong>${badgeState(c.operationalState)}</div>`).join(''):empty('No components yet','Define public components to power your status page.')}</div><div class="card"><div class="section-head"><h2>Public surfaces</h2><span>${pages.length} pages</span></div>${pages.length?pages.map((p)=>`<div class="component-row" style="padding-left:0;padding-right:0;background:transparent"><div><strong>${esc(p.name)}</strong><div class="subtext">/${esc(p.slug)}</div></div><a class="btn btn-sm" href="/status/${esc(p.slug)}" target="_blank" rel="noopener">View ↗</a></div>`).join(''):empty('No status page','Create a public status page for customer communication.')}</div></section>`;
  if(seq!==renderSeq)return;root.innerHTML=shell('Overview',content);bindShell();startSse();
}

async function renderServices(seq=++renderSeq){
  const [services,teams]=await Promise.all([api(`/api/v1/organizations/${state.orgId}/services`),api(`/api/v1/organizations/${state.orgId}/teams`)]);
  const teamOptions=(selected)=>`<option value="">Unassigned</option>${teams.map((t)=>`<option value="${esc(t.id)}" ${t.id===selected?'selected':''}>${esc(t.name)}</option>`).join('')}`;
  const content=`<div class="page-head"><div><h1>Services</h1><p>Internal technical systems that incidents can affect. Owning a service connects it to a responder team and its on-call schedule.</p></div></div><form id="service-form" class="card panel-form"><div><label class="subtext">Name</label><input class="input" name="name" required placeholder="Checkout API"></div><div class="span-2"><label class="subtext">Description</label><input class="input" name="description" placeholder="Handles checkout requests"></div><button class="btn btn-primary" type="submit">Add service</button></form><div class="table-wrap">${services.length?`<table><thead><tr><th>Name</th><th>State</th><th>Owning team</th><th>Description</th><th>Updated</th></tr></thead><tbody>${services.map((s)=>`<tr><td class="name-cell">${esc(s.name)}<div class="subtext">${esc(s.slug)}</div></td><td>${badgeState(s.operationalState)}</td><td>${canConfigure()?`<select class="select owner-team" data-id="${esc(s.id)}" style="min-width:150px" aria-label="Owning responder team for ${esc(s.name)}">${teamOptions(s.ownerTeamId)}</select>`:(esc(s.ownerTeamName??'Unassigned'))}</td><td>${esc(s.description||'—')}</td><td>${esc(fmt(s.updatedAt))}</td></tr>`).join('')}</tbody></table>`:empty('No services','Add the internal services your team operates.')}</div>`;
  if(seq!==renderSeq)return;root.innerHTML=shell('Services',content);bindShell();document.querySelector('#service-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/v1/organizations/${state.orgId}/services`,{method:'POST',body:{name:f.get('name'),description:f.get('description')}});toast('Service created.');renderServices()}catch(error){toast(error.message,'error')}});document.querySelectorAll('.owner-team').forEach((select)=>select.addEventListener('change',async()=>{try{await api(`/api/v1/organizations/${state.orgId}/services/${select.dataset.id}`,{method:'PATCH',body:{ownerTeamId:select.value||null}});toast('Service ownership updated.');renderServices()}catch(error){toast(error.message,'error');renderServices()}}));startSse();
}

async function renderComponents(seq=++renderSeq){
  const [components,services]=await Promise.all([api(`/api/v1/organizations/${state.orgId}/components`),api(`/api/v1/organizations/${state.orgId}/services`)]);
  const content=`<div class="page-head"><div><h1>Components</h1><p>Customer-visible health components, mapped independently to internal services.</p></div></div><form id="component-form" class="card panel-form"><div><label class="subtext">Name</label><input class="input" name="name" required placeholder="Authentication"></div><div><label class="subtext">Mapped service</label><select class="select" name="serviceId"><option value="">None</option>${services.map((s)=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div><div><label class="subtext">Initial state</label><select class="select" name="operationalState">${['OPERATIONAL','DEGRADED_PERFORMANCE','PARTIAL_OUTAGE','MAJOR_OUTAGE','MAINTENANCE'].map((x)=>`<option>${x}</option>`).join('')}</select></div><button class="btn btn-primary" type="submit">Add component</button></form><div class="table-wrap">${components.length?`<table><thead><tr><th>Name</th><th>State</th><th>Services</th><th>Updated</th></tr></thead><tbody>${components.map((c)=>`<tr><td class="name-cell">${esc(c.name)}<div class="subtext">${esc(c.slug)}</div></td><td><select class="select component-state" data-id="${esc(c.id)}" style="min-width:190px">${['OPERATIONAL','DEGRADED_PERFORMANCE','PARTIAL_OUTAGE','MAJOR_OUTAGE','MAINTENANCE'].map((x)=>`<option value="${x}" ${x===c.operationalState?'selected':''}>${stateLabel(x)}</option>`).join('')}</select></td><td>${c.serviceIds.map((sid)=>esc(services.find((s)=>s.id===sid)?.name??'Unknown')).join(', ')||'—'}</td><td>${esc(fmt(c.updatedAt))}</td></tr>`).join('')}</tbody></table>`:empty('No components','Create public components and map them to internal services.')}</div>`;
  if(seq!==renderSeq)return;root.innerHTML=shell('Components',content);bindShell();document.querySelector('#component-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/v1/organizations/${state.orgId}/components`,{method:'POST',body:{name:f.get('name'),operationalState:f.get('operationalState'),serviceIds:f.get('serviceId')?[f.get('serviceId')]:[]}});toast('Component created.');renderComponents()}catch(error){toast(error.message,'error')}});document.querySelectorAll('.component-state').forEach((select)=>select.addEventListener('change',async()=>{try{await api(`/api/v1/organizations/${state.orgId}/components/${select.dataset.id}`,{method:'PATCH',body:{operationalState:select.value}});toast('Component state updated.')}catch(error){toast(error.message,'error');renderComponents()}}));startSse();
}

function incidentCreateModal(services,components){
  const backdrop=document.createElement('div');backdrop.className='modal-backdrop';backdrop.innerHTML=`<section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>Create incident</h2><button id="close-modal" class="btn btn-ghost btn-sm">✕</button></div><form id="incident-form"><div class="field"><label>Title</label><input class="input" name="title" required minlength="3" placeholder="Checkout requests failing"></div><div class="form-row"><div class="field"><label>Severity</label><select class="select" name="severity">${['SEV1','SEV2','SEV3','SEV4'].map((x)=>`<option>${x}</option>`).join('')}</select></div><div class="field"><label>Initial state</label><input class="input" value="Investigating" disabled></div></div><div class="field"><label>Summary</label><textarea class="textarea" name="summary" placeholder="What is known right now?"></textarea></div><div class="field"><label>Affected services</label><div class="check-grid">${services.map((s)=>`<label class="check"><input type="checkbox" name="service" value="${esc(s.id)}">${esc(s.name)}</label>`).join('')||'<span class="muted">No services yet.</span>'}</div></div><div class="field"><label>Affected public components</label><div class="check-grid">${components.map((c)=>`<label class="check"><input type="checkbox" name="component" value="${esc(c.id)}">${esc(c.name)}</label>`).join('')||'<span class="muted">No components yet.</span>'}</div></div><button class="btn btn-primary btn-block" type="submit">Declare incident</button></form></section>`;const modal=openModal(backdrop);backdrop.querySelector('#close-modal').onclick=modal.close;backdrop.querySelector('#incident-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const incident=await api(`/api/v1/organizations/${state.orgId}/incidents`,{method:'POST',body:{title:f.get('title'),summary:f.get('summary'),severity:f.get('severity'),affectedServiceIds:f.getAll('service'),affectedComponentIds:f.getAll('component')}});modal.close();toast('Incident declared.');navigate(`/app/incidents/${incident.id}`)}catch(error){toast(error.message,'error')}})
}

async function renderIncidents(seq=++renderSeq){
  const [incidents,services,components]=await Promise.all([api(`/api/v1/organizations/${state.orgId}/incidents`),api(`/api/v1/organizations/${state.orgId}/services`),api(`/api/v1/organizations/${state.orgId}/components`)]);
  const content=`<div class="page-head"><div><h1>Incidents</h1><p>Coordinate response and public communication from one incident record.</p></div><button id="new-incident" class="btn btn-primary">Declare incident</button></div><div class="toolbar" style="margin-bottom:12px"><span class="badge">${incidents.filter((i)=>i.status!=='RESOLVED').length} active</span><span class="badge">${incidents.filter((i)=>i.status==='RESOLVED').length} resolved</span></div><div class="table-wrap">${incidents.length?`<table><thead><tr><th>Incident</th><th>Severity</th><th>Status</th><th>Responders</th><th>Updated</th></tr></thead><tbody>${incidentRows(incidents)}</tbody></table>`:empty('No incidents','When something breaks, declare the incident here.')}</div>`;
  if(seq!==renderSeq)return;root.innerHTML=shell('Incidents',content);bindShell();document.querySelector('#new-incident').onclick=()=>incidentCreateModal(services,components);startSse();
}

function impactModal(incident,services,components){
  const backdrop=document.createElement('div');backdrop.className='modal-backdrop';backdrop.innerHTML=`<section class="modal"><div class="modal-head"><h2>Edit affected systems</h2><button id="close-modal" class="btn btn-ghost btn-sm">✕</button></div><form id="impact-form"><div class="field"><label>Services</label><div class="check-grid">${services.map((s)=>`<label class="check"><input type="checkbox" name="service" value="${esc(s.id)}" ${incident.affectedServiceIds.includes(s.id)?'checked':''}>${esc(s.name)}</label>`).join('')}</div></div><div class="field"><label>Public components</label><div class="check-grid">${components.map((c)=>`<label class="check"><input type="checkbox" name="component" value="${esc(c.id)}" ${incident.affectedComponentIds.includes(c.id)?'checked':''}>${esc(c.name)}</label>`).join('')}</div></div><button class="btn btn-primary btn-block">Save impact</button></form></section>`;const modal=openModal(backdrop);backdrop.querySelector('#close-modal').onclick=modal.close;backdrop.querySelector('#impact-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/v1/organizations/${state.orgId}/incidents/${incident.id}`,{method:'PATCH',body:{affectedServiceIds:f.getAll('service'),affectedComponentIds:f.getAll('component')}});modal.close();toast('Affected systems updated.');renderIncident(incident.id)}catch(error){toast(error.message,'error')}})
}

async function renderIncident(incidentId,seq=++renderSeq){
  const [incident,services,components]=await Promise.all([api(`/api/v1/organizations/${state.orgId}/incidents/${incidentId}`),api(`/api/v1/organizations/${state.orgId}/services`),api(`/api/v1/organizations/${state.orgId}/components`)]);
  const serviceNames=incident.affectedServiceIds.map((x)=>services.find((s)=>s.id===x)?.name).filter(Boolean);const componentNames=incident.affectedComponentIds.map((x)=>components.find((c)=>c.id===x)?.name).filter(Boolean);const meResponder=incident.responders.some((r)=>r.userId===state.me.id);
  const content=`<div class="page-head"><div><div class="incident-title-row"><h1>${esc(incident.title)}</h1>${badgeSeverity(incident.severity)}${badgeStatus(incident.status)}</div><div class="meta-row"><span>Started ${esc(fmt(incident.startedAt))}</span><span>Updated ${esc(ago(incident.updatedAt))}</span>${incident.resolvedAt?`<span>Resolved ${esc(fmt(incident.resolvedAt))}</span>`:''}</div></div><div class="toolbar"><button id="edit-impact" class="btn">Edit impact</button>${!meResponder?'<button id="join-incident" class="btn">Join incident</button>':''}${incident.status!=='RESOLVED'?'<button id="resolve-incident" class="btn btn-primary">Resolve</button>':''}</div></div><div class="incident-layout"><div><section class="card"><div class="section-head"><h2>Incident control</h2><span>All changes are timeline events</span></div><p class="muted" style="line-height:1.55">${esc(incident.summary||'No summary has been added.')}</p><div class="workspace-controls"><div class="field" style="margin:0"><label>Severity</label><select id="severity" class="select">${['SEV1','SEV2','SEV3','SEV4'].map((x)=>`<option ${x===incident.severity?'selected':''}>${x}</option>`).join('')}</select></div><div class="field" style="margin:0"><label>Lifecycle state</label><select id="incident-status" class="select" ${incident.status==='RESOLVED'?'disabled':''}>${['INVESTIGATING','IDENTIFIED','MONITORING','RESOLVED'].map((x)=>`<option ${x===incident.status?'selected':''}>${statusLabel(x)}</option>`).join('')}</select></div></div><div class="section"><div class="section-head"><h2>Affected systems</h2></div><div class="chips">${[...serviceNames.map((x)=>`<span class="chip">Service · ${esc(x)}</span>`),...componentNames.map((x)=>`<span class="chip">Component · ${esc(x)}</span>`)].join('')||'<span class="muted">No affected systems selected.</span>'}</div></div></section><section class="card section"><div class="section-head"><h2>Updates</h2><span>Internal notes stay private</span></div><form id="update-form"><textarea class="textarea" name="message" required placeholder="What changed? What should responders or customers know?"></textarea><div class="toolbar" style="margin-top:9px"><label class="check"><input type="radio" name="visibility" value="internal" checked>Internal note</label><label class="check"><input type="radio" name="visibility" value="public">Public update</label><button class="btn btn-primary" type="submit">Publish update</button></div></form><div class="section">${incident.updates.length?incident.updates.slice().reverse().map((u)=>`<article class="update ${u.isPublic?'public':''}"><div class="update-head"><strong>${u.isPublic?'Public update':'Internal note'} · ${esc(u.actor?.displayName??'Responder')}</strong><span>${esc(fmt(u.createdAt))}</span></div><p>${esc(u.message)}</p></article>`).join(''):empty('No updates yet','Post an internal note or customer-facing update.')}</div></section>${incident.status==='RESOLVED'?postmortemEditor(incident):''}</div><aside><section class="card"><div class="section-head"><h2>Responders</h2><span>${incident.responders.length}</span></div>${incident.responders.map((r)=>`<div class="user-chip" style="padding-left:0;padding-right:0"><div class="avatar">${esc((r.user?.displayName??'?')[0])}</div><div class="user-meta"><strong>${esc(r.user?.displayName??'Responder')}</strong><span>Joined ${esc(ago(r.joinedAt))}</span></div></div>`).join('')}</section><section class="card section"><div class="section-head"><h2>Timeline</h2><span>${incident.timeline.length} events</span></div><div class="timeline">${incident.timeline.slice().reverse().map((e)=>`<div class="timeline-item"><div class="event"><strong>${esc(e.eventType.replaceAll('_',' ').toLowerCase().replace(/^./,(c)=>c.toUpperCase()))}</strong>${e.message?`<br><span class="muted">${esc(e.message)}</span>`:''}</div><div class="time">${esc(fmt(e.occurredAt))} · ${esc(e.actor?.displayName??'System')}</div></div>`).join('')}</div></section></aside></div>`;
  if(seq!==renderSeq)return;root.innerHTML=shell('Incident workspace',content,`<a data-nav href="/app/incidents" class="btn btn-ghost">← Incidents</a>`);bindShell();document.querySelector('#edit-impact').onclick=()=>impactModal(incident,services,components);document.querySelector('#join-incident')?.addEventListener('click',async()=>{try{await api(`/api/v1/organizations/${state.orgId}/incidents/${incident.id}/responders`,{method:'POST',body:{}});toast('Joined incident.');renderIncident(incident.id)}catch(error){toast(error.message,'error')}});document.querySelector('#resolve-incident')?.addEventListener('click',async()=>{if(!confirm('Resolve this incident? The public status will update immediately.'))return;try{await api(`/api/v1/organizations/${state.orgId}/incidents/${incident.id}/resolve`,{method:'POST',body:{}});toast('Incident resolved.');renderIncident(incident.id)}catch(error){toast(error.message,'error')}});document.querySelector('#severity').addEventListener('change',async(e)=>{try{await api(`/api/v1/organizations/${state.orgId}/incidents/${incident.id}`,{method:'PATCH',body:{severity:e.target.value}});toast('Severity updated.');renderIncident(incident.id)}catch(error){toast(error.message,'error');renderIncident(incident.id)}});document.querySelector('#incident-status')?.addEventListener('change',async(e)=>{try{await api(`/api/v1/organizations/${state.orgId}/incidents/${incident.id}`,{method:'PATCH',body:{status:e.target.value}});toast('Status updated.');renderIncident(incident.id)}catch(error){toast(error.message,'error');renderIncident(incident.id)}});document.querySelector('#update-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);const message=String(f.get('message')??'').trim();const isPublic=f.get('visibility')==='public';try{if(!isPublic){await api(`/api/v1/organizations/${state.orgId}/incidents/${incident.id}/updates`,{method:'POST',body:{message,isPublic:false}});toast('Internal note added.');renderIncident(incident.id);return}const pages=await api(`/api/v1/organizations/${state.orgId}/status-pages`);const destinations=pages.filter((p)=>(p.componentIds??[]).some((id)=>incident.affectedComponentIds.includes(id)));openPublicUpdateReview({incident,message,componentNames,destinations,onPublished:()=>{toast('Public update published.');renderIncident(incident.id)}})}catch(error){toast(error.message,'error')}});bindPostmortem(incident);startSse();
}

function postmortemEditor(incident){const p=incident.postmortem??{};return `<section class="card section" id="postmortem"><div class="section-head"><h2>Postmortem</h2><span>${p.id?'Saved':'Not created'}</span></div><form id="postmortem-form"><div class="field"><label>Title</label><input class="input" name="title" required value="${esc(p.title??`Postmortem: ${incident.title}`)}"></div><div class="field"><label>Summary</label><textarea class="textarea" name="summary">${esc(p.summary??'')}</textarea></div><div class="field"><label>Impact</label><textarea class="textarea" name="impact">${esc(p.impact??'')}</textarea></div><div class="field"><label>Root cause</label><textarea class="textarea" name="rootCause">${esc(p.rootCause??'')}</textarea></div><div class="field"><label>Resolution</label><textarea class="textarea" name="resolution">${esc(p.resolution??'')}</textarea></div><div class="field"><label>Follow-up actions <span class="muted">one per line</span></label><textarea class="textarea" name="followUpActions">${esc((p.followUpActions??[]).join('\n'))}</textarea></div><button class="btn btn-primary" type="submit">Save postmortem</button></form></section>`}
function bindPostmortem(incident){document.querySelector('#postmortem-form')?.addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/v1/organizations/${state.orgId}/incidents/${incident.id}/postmortem`,{method:'PUT',body:{title:f.get('title'),summary:f.get('summary'),impact:f.get('impact'),rootCause:f.get('rootCause'),resolution:f.get('resolution'),followUpActions:String(f.get('followUpActions')).split('\n').map((x)=>x.trim()).filter(Boolean)}});toast('Postmortem saved.');renderIncident(incident.id)}catch(error){toast(error.message,'error')}})}

// Two-step public communication: compose -> review destination/scope -> explicit publish.
function openPublicUpdateReview({incident,message,componentNames,destinations,onPublished}){
  const backdrop=document.createElement('div');backdrop.className='modal-backdrop';
  const destinationText=destinations.length?destinations.map((p)=>esc(p.name)).join(', '):'No status page includes the affected components yet; this update will be recorded on the incident without appearing on a public page.';
  backdrop.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="review-public-title"><div class="modal-head"><h2 id="review-public-title">Review public update</h2><button id="close-modal" class="btn btn-ghost btn-sm" type="button">✕</button></div><p class="muted">Public updates are visible to customers on status pages. Confirm the message, scope and destination before publishing.</p><div class="review-block"><div class="review-label">Message</div><p>${esc(message)}</p></div><div class="review-block"><div class="review-label">Incident</div><p>${esc(incident.title)} · ${esc(incident.severity)} · ${esc(statusLabel(incident.status))}</p></div><div class="review-block"><div class="review-label">Affected public components</div><p>${componentNames.length?esc(componentNames.join(', ')):'None recorded'}</p></div><div class="review-block"><div class="review-label">Destination status pages</div><p>${destinationText}</p></div><div class="toolbar" style="justify-content:flex-end;margin-top:14px"><button id="cancel-review" class="btn" type="button">Cancel</button><button id="confirm-publish" class="btn btn-primary" type="button">Publish public update</button></div></section>`;
  const modal=openModal(backdrop);
  backdrop.querySelector('#close-modal').onclick=modal.close;
  backdrop.querySelector('#cancel-review').onclick=modal.close;
  backdrop.querySelector('#confirm-publish').onclick=async()=>{try{await api(`/api/v1/organizations/${state.orgId}/incidents/${incident.id}/updates`,{method:'POST',body:{message,isPublic:true}});modal.close();onPublished()}catch(error){toast(error.message,'error')}};
}

async function renderStatusPages(seq=++renderSeq){
  const [pages,components]=await Promise.all([api(`/api/v1/organizations/${state.orgId}/status-pages`),api(`/api/v1/organizations/${state.orgId}/components`)]);
  const content=`<div class="page-head"><div><h1>Status pages</h1><p>Public health surfaces powered by canonical Relay incidents.</p></div></div><form id="page-form" class="card panel-form"><div><label class="subtext">Page name</label><input class="input" name="name" required placeholder="Acme Status"></div><div><label class="subtext">Slug</label><input class="input" name="slug" placeholder="acme"></div><div><label class="subtext">Components</label><select class="select" name="componentId"><option value="">No component</option>${components.map((c)=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div><button class="btn btn-primary" type="submit">Create page</button></form><div class="grid grid-2">${pages.length?pages.map((p)=>`<article class="card"><div class="section-head"><div><h2>${esc(p.name)}</h2><span>/${esc(p.slug)}</span></div>${p.isPublic?'<span class="badge state-OPERATIONAL">Public</span>':'<span class="badge">Private</span>'}</div><p class="muted">${esc(p.branding?.description??'Public incident communication and component health.')}</p><div class="toolbar"><a class="btn btn-primary" href="/status/${esc(p.slug)}" target="_blank" rel="noopener">Open status page ↗</a><span class="badge">${p.componentIds.length} components</span></div></article>`).join(''):empty('No status pages','Create a public page and attach customer-visible components.')}</div>`;
  if(seq!==renderSeq)return;root.innerHTML=shell('Status pages',content);bindShell();document.querySelector('#page-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/v1/organizations/${state.orgId}/status-pages`,{method:'POST',body:{name:f.get('name'),slug:f.get('slug')||undefined,componentIds:f.get('componentId')?[f.get('componentId')]:[],branding:{headline:f.get('name'),description:'Live service health and incident updates.'}}});toast('Status page created.');renderStatusPages()}catch(error){toast(error.message,'error')}});startSse();
}

async function renderSettings(seq=++renderSeq){
  const [org,integrations]=await Promise.all([api(`/api/v1/organizations/${state.orgId}`),api(`/api/v1/organizations/${state.orgId}/integrations`)]);const discord=integrations.find((x)=>x.provider==='DISCORD');
  const members=canConfigure()?await api(`/api/v1/organizations/${state.orgId}/members`).catch(()=>[]):[];
  const identities=canConfigure()?await api(`/api/v1/organizations/${state.orgId}/discord-identities`).catch(()=>[]):[];
  const identityFor=(userId)=>identities.find((x)=>x.userId===userId)?.discordUserId??'';
  const content=`<div class="page-head"><div><h1>Settings</h1><p>Workspace integration and intake configuration.</p></div></div><div class="grid grid-2"><section class="card"><div class="section-head"><h2>Workspace</h2><span>${esc(state.orgs.find((x)=>x.id===state.orgId)?.role??'')}</span></div><div class="field"><label>Name</label><input class="input" value="${esc(org.name)}" disabled></div><div class="field"><label>Slug</label><input class="input" value="${esc(org.slug)}" disabled></div><p class="muted" style="font-size:12px">Alert intake uses this slug in <code>organizationSlug</code>. The intake endpoint is <code>POST /api/v1/alerts</code>.</p></section><section class="card"><div class="section-head"><h2>Discord webhook</h2>${discord?.enabled?'<span class="badge state-OPERATIONAL">Enabled</span>':'<span class="badge">Not configured</span>'}</div><p class="muted">Relay sends incident-created, public-update and resolved notifications, plus routed-alert notifications that name the resolved on-call responder. Webhook secrets are encrypted at rest and never returned by any read.</p><form id="discord-form"><div class="field"><label>Integration name</label><input class="input" name="name" value="${esc(discord?.name??'Incident Operations')}"></div><div class="field"><label>Discord webhook URL</label><input class="input" name="webhookUrl" type="url" required placeholder="https://discord.com/api/webhooks/…" autocomplete="off"></div><button class="btn btn-primary" type="submit">${discord?'Replace webhook':'Configure Discord'}</button></form></section></div>${canConfigure()?`<section class="card section"><div class="section-head"><h2>Responder Discord mapping</h2><span>Optional · no OAuth</span></div><p class="muted">Map a Relay user to their numeric Discord user id so routed-alert notifications can mention the person who is actually on call. Without a mapping the notification still names the responder. Values are numeric snowflakes only, so nothing Markdown-bearing can be injected, and webhook secrets are never shown here.</p><div class="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Discord user id</th><th></th></tr></thead><tbody>${members.map((m)=>`<tr><td class="name-cell">${esc(m.displayName??'—')}<div class="subtext">${esc(m.email??'')}</div></td><td>${esc(m.role)}</td><td><input class="input discord-map" data-user="${esc(m.userId)}" inputmode="numeric" pattern="[0-9]{15,25}" maxlength="25" placeholder="123456789012345678" value="${esc(identityFor(m.userId))}" aria-label="Discord user id for ${esc(m.displayName??'member')}"></td><td><button class="btn btn-sm" data-save-discord="${esc(m.userId)}">Save</button>${identityFor(m.userId)?`<button class="btn btn-sm btn-danger" data-clear-discord="${esc(m.userId)}">Clear</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">No organization members.</td></tr>'}</tbody></table></div></section>`:''}<section class="card section"><div class="section-head"><h2>API</h2><span>v1</span></div><p class="muted">Relay exposes versioned operations under <code>/api/v1</code>, including alert routing, on-call resolution and acknowledgement. Machine-readable OpenAPI is available at <a href="/api/v1/openapi.json" target="_blank">/api/v1/openapi.json ↗</a>.</p></section>`;
  if(seq!==renderSeq)return;root.innerHTML=shell('Settings',content);bindShell();document.querySelector('#discord-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/v1/organizations/${state.orgId}/integrations/discord`,{method:'PUT',body:{name:f.get('name'),webhookUrl:f.get('webhookUrl'),enabled:true}});toast('Discord integration configured.');renderSettings()}catch(error){toast(error.message,'error')}});
  document.querySelectorAll('[data-save-discord]').forEach((btn)=>btn.addEventListener('click',async()=>{const input=document.querySelector(`.discord-map[data-user="${btn.dataset.saveDiscord}"]`);const value=String(input?.value??'').trim();if(!/^[0-9]{15,25}$/.test(value)){toast('Discord user id must be 15-25 digits.','error');input?.focus();return}btn.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/discord-identities/${btn.dataset.saveDiscord}`,{method:'PUT',body:{discordUserId:value}});toast('Discord mapping saved.');renderSettings()}catch(error){toast(error.message,'error');btn.disabled=false}}));
  document.querySelectorAll('[data-clear-discord]').forEach((btn)=>btn.addEventListener('click',async()=>{btn.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/discord-identities/${btn.dataset.clearDiscord}`,{method:'DELETE'});toast('Discord mapping removed.');renderSettings()}catch(error){toast(error.message,'error');btn.disabled=false}}));
  startSse();
}

async function renderPublic(seq=++renderSeq){
  stopSse();const match=location.pathname.match(/^\/status\/([a-z0-9-]+)(?:\/incidents\/([a-zA-Z0-9_-]+))?/);if(!match)throw new Error('Invalid status page path.');const slug=match[1],incidentId=match[2];
  if(incidentId){const incident=await api(`/api/v1/public/status/${slug}/incidents/${incidentId}`);if(seq!==renderSeq)return;root.innerHTML=`<main class="public-page"><div class="public-shell"><header class="public-head"><div class="brand"><div class="brand-mark">R</div>Relay</div><a data-nav href="/status/${esc(slug)}" class="btn btn-ghost">← Status</a></header><article class="incident-public"><div class="incident-title-row"><h1 style="font-size:26px">${esc(incident.title)}</h1>${badgeStatus(incident.status)}</div><div class="meta">Started ${esc(fmt(incident.startedAt))}${incident.resolvedAt?` · Resolved ${esc(fmt(incident.resolvedAt))}`:''}</div>${incident.updates.length?incident.updates.slice().reverse().map((u)=>`<div class="public-update"><p>${esc(u.message)}</p><time>${esc(fmt(u.createdAt))}</time></div>`).join(''):'<p class="muted">No public updates have been posted.</p>'}</article><div class="status-footer">Powered by Relay · Open-source incident operations</div></div></main>`;return}
  const data=await api(`/api/v1/public/status/${slug}`);const healthy=data.overallStatus==='OPERATIONAL';if(seq!==renderSeq)return;root.innerHTML=`<main class="public-page"><div class="public-shell"><header class="public-head"><div class="public-brand">${esc(data.page.name)}<small>Service status</small></div><div class="brand"><div class="brand-mark" style="width:28px;height:28px;border-radius:8px">R</div><span style="font-size:12px;color:var(--muted)">Relay</span></div></header><section class="public-hero"><div class="status-orb state-${esc(data.overallStatus)}"></div><h1>${healthy?'All systems operational':stateLabel(data.overallStatus)}</h1><p>${esc(data.page.branding?.description??'Live service health and incident updates.')}</p></section><div class="status-banner"><div><strong>Current status</strong><div class="subtext">Updated from active incident impact</div></div>${badgeState(data.overallStatus)}</div><section><div class="section-head"><h2>Components</h2><span>${data.components.length}</span></div><div class="component-list">${data.components.length?data.components.map((c)=>`<div class="component-row"><strong>${esc(c.name)}</strong>${badgeState(c.effectiveState)}</div>`).join(''):empty('No components','This status page has no components yet.')}</div></section>${data.activeIncidents.length?`<section class="section"><div class="section-head"><h2>Active incidents</h2><span>${data.activeIncidents.length}</span></div>${data.activeIncidents.map((i)=>publicIncidentCard(i,slug)).join('')}</section>`:''}<section class="section"><div class="section-head"><h2>Recent incidents</h2><span>${data.recentIncidents.length}</span></div>${data.recentIncidents.length?data.recentIncidents.map((i)=>publicIncidentCard(i,slug)).join(''):empty('No recent incidents','Resolved incident history will appear here.')}</section><div class="status-footer">Powered by Relay · Open-source incident operations</div></div></main>`;
}
function publicIncidentCard(i,slug){return `<article class="incident-public"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div><h3><a data-nav href="/status/${esc(slug)}/incidents/${esc(i.id)}">${esc(i.title)}</a></h3><div class="meta">${esc(fmt(i.startedAt))}${i.resolvedAt?` → ${esc(fmt(i.resolvedAt))}`:''}</div></div>${badgeStatus(i.status)}</div>${i.updates.length?`<div class="public-update"><p>${esc(i.updates.at(-1).message)}</p><time>${esc(fmt(i.updates.at(-1).createdAt))}</time></div>`:''}</article>`}


// ---------------------------------------------------------------------------
// Relay 0.2 — alert routing and on-call surfaces.
//
// These screens follow the existing Quiet Operations direction: compact
// operational rows rather than large cards, state always communicated with a
// text label (never colour alone), and configuration controls hidden for roles
// the server would reject anyway. Hiding is convenience only - every operation
// below is authorized server-side.
// ---------------------------------------------------------------------------
const myRole=()=>state.orgs.find((x)=>x.id===state.orgId)?.role??'VIEWER';
const canConfigure=()=>['OWNER','ADMIN'].includes(myRole());
const canRespond=()=>['OWNER','ADMIN','RESPONDER'].includes(myRole());

const fmtTz=(v,tz)=>{if(!v)return'—';try{return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:tz}).format(new Date(v))}catch{return fmt(v)}};
const durationLabel=(minutes)=>{const m=Number(minutes);if(!Number.isFinite(m))return'—';if(m%10080===0)return`${m/10080} week${m/10080===1?'':'s'}`;if(m%1440===0)return`${m/1440} day${m/1440===1?'':'s'}`;if(m%60===0)return`${m/60} hour${m/60===1?'':'s'}`;return`${m} minutes`};
const routingLabel=(v)=>({PENDING:'Not evaluated',ROUTED:'Routed',NO_MATCHING_RULE:'No matching rule',SCHEDULE_DISABLED:'Schedule disabled',SCHEDULE_MISSING:'Schedule missing',ROTATION_NOT_STARTED:'Rotation not started',NO_PARTICIPANTS:'No participants',RULE_TARGET_MISSING:'Target missing'}[v]??v??'—');
const notifyLabel=(v)=>({NOT_ATTEMPTED:'Not attempted',SENT:'Notified',FAILED:'Delivery failed',SKIPPED_NO_INTEGRATION:'No Discord integration',SKIPPED_DISABLED:'Discord disabled',SKIPPED_NO_RESPONDER:'No responder to notify'}[v]??v??'—');
const badgeRouting=(v)=>`<span class="badge route-${esc(v??'NONE')}"><span class="dot"></span>${esc(routingLabel(v))}</span>`;
const badgeNotify=(v)=>`<span class="badge notify-${esc(v??'NONE')}">${esc(notifyLabel(v))}</span>`;
const badgeAck=(routing)=>routing?.acknowledgedAt?`<span class="badge ack-yes"><span class="dot"></span>Acknowledged</span>`:`<span class="badge ack-no"><span class="dot"></span>Unacknowledged</span>`;
const badgeBool=(value,yes,no)=>value?`<span class="badge state-OPERATIONAL"><span class="dot"></span>${esc(yes)}</span>`:`<span class="badge"><span class="dot"></span>${esc(no)}</span>`;
const localInputValue=(v)=>{const d=v?new Date(v):new Date();const pad=(n)=>String(n).padStart(2,'0');return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`};
const fromLocalInput=(v)=>{if(!v)return new Date().toISOString();const d=new Date(v);return Number.isNaN(d.getTime())?new Date().toISOString():d.toISOString()};
const COMMON_ZONES=['UTC','Europe/Bucharest','Europe/London','Europe/Berlin','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Asia/Singapore','Asia/Tokyo','Australia/Sydney'];
const INTERVAL_PRESETS=[[1440,'Daily (24 hours)'],[10080,'Weekly (7 days)'],[720,'12 hours'],[20160,'Fortnightly (14 days)']];

function ruleSummary(rule,services){
  const parts=[];
  parts.push(rule.matchServiceId?`Service: ${services.find((s)=>s.id===rule.matchServiceId)?.name??'unknown'}`:'Any service');
  parts.push(rule.matchSource?`Source: ${rule.matchSource}`:'Any source');
  parts.push(rule.matchSeverities?.length?`Severity: ${rule.matchSeverities.join(', ')}`:'Any severity');
  return parts.join(' · ');
}

async function renderAlerts(seq=++renderSeq){
  const alerts=await api(`/api/v1/organizations/${state.orgId}/alerts`);
  const routed=alerts.filter((a)=>a.routing?.resolution==='ROUTED');
  const unacked=alerts.filter((a)=>a.routing&&!a.routing.acknowledgedAt);
  const failed=alerts.filter((a)=>a.routing?.notificationStatus==='FAILED');
  const rows=alerts.map((a)=>{
    const r=a.routing;
    const ackCell=r?badgeAck(r):'<span class="badge">Not evaluated</span>';
    const actions=[];
    if(canRespond()&&r&&!r.acknowledgedAt)actions.push(`<button class="btn btn-sm btn-primary" data-ack="${esc(a.id)}">Acknowledge</button>`);
    if(canRespond()&&!r?.incidentId)actions.push(`<button class="btn btn-sm" data-escalate="${esc(a.id)}">Create incident</button>`);
    if(canRespond()&&(!r||r.resolution!=='ROUTED'))actions.push(`<button class="btn btn-sm" data-reroute="${esc(a.id)}">Re-route</button>`);
    return `<tr>
      <td class="nowrap">${esc(ago(a.receivedAt))}<div class="subtext">${esc(fmt(a.receivedAt))}</div></td>
      <td class="name-cell">${esc(a.title)}<div class="subtext">${esc(a.source)}${a.externalId?` · ${esc(a.externalId)}`:''}</div></td>
      <td>${badgeSeverity(String(a.severity).toUpperCase().startsWith('SEV')?String(a.severity).toUpperCase():'SEV3')}<div class="subtext">${esc(a.severity)}</div></td>
      <td>${esc(a.serviceName??'—')}</td>
      <td>${r?badgeRouting(r.resolution):'<span class="badge">Not evaluated</span>'}<div class="subtext">${r?[r.ruleName,r.scheduleName,r.teamName].filter(Boolean).map(esc).join(' → ')||'—':'—'}</div></td>
      <td>${r?.oncallDisplayName?esc(r.oncallDisplayName):'—'}<div class="subtext">${r?esc(notifyLabel(r.notificationStatus)):'—'}</div></td>
      <td>${ackCell}${r?.acknowledgedAt?`<div class="subtext">${esc(r.acknowledgedByDisplayName??'Responder')} · ${esc(ago(r.acknowledgedAt))}</div>`:''}</td>
      <td><div class="toolbar">${actions.join('')}</div></td>
    </tr>`;
  }).join('');
  const content=`<div class="page-head"><div><h1>Alerts</h1><p>Durable alert intake with routing, on-call resolution and acknowledgement.</p></div></div>
  <section class="summary-strip" aria-label="Alert routing summary"><div class="summary-item"><span class="summary-label">Alerts</span><strong>${alerts.length}</strong><span class="summary-hint">Most recent first</span></div><div class="summary-item"><span class="summary-label">Routed</span><strong>${routed.length}</strong><span class="summary-hint">Matched a routing rule</span></div><div class="summary-item"><span class="summary-label">Unacknowledged</span><strong>${unacked.length}</strong><span class="summary-hint">${unacked.length?'Needs a responder':'Nothing waiting'}</span></div><div class="summary-item"><span class="summary-label">Delivery failed</span><strong>${failed.length}</strong><span class="summary-hint">${failed.length?'Alerts stayed durable':'Discord delivery healthy'}</span></div></section>
  <div class="table-wrap table-scroll-x">${alerts.length?`<table><thead><tr><th>Received</th><th>Alert</th><th>Severity</th><th>Service</th><th>Routing</th><th>On call</th><th>Acknowledgement</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`:empty('No alerts yet','Send one to POST /api/v1/alerts with your workspace slug.')}</div>`;
  if(seq!==renderSeq)return;
  root.innerHTML=shell('Alerts',content);bindShell();
  document.querySelectorAll('[data-ack]').forEach((btn)=>btn.addEventListener('click',async()=>{btn.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/alerts/${btn.dataset.ack}/acknowledge`,{method:'POST',body:{}});toast('Alert acknowledged.');renderAlerts()}catch(error){toast(error.message,'error');btn.disabled=false}}));
  document.querySelectorAll('[data-reroute]').forEach((btn)=>btn.addEventListener('click',async()=>{btn.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/alerts/${btn.dataset.reroute}/route`,{method:'POST',body:{}});toast('Routing re-evaluated.');renderAlerts()}catch(error){toast(error.message,'error');btn.disabled=false}}));
  document.querySelectorAll('[data-escalate]').forEach((btn)=>btn.addEventListener('click',async()=>{const alert=alerts.find((a)=>a.id===btn.dataset.escalate);if(!alert)return;escalateAlertModal(alert)}));
  startSse();
}

function escalateAlertModal(alert){
  const backdrop=document.createElement('div');backdrop.className='modal-backdrop';
  backdrop.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="escalate-title"><div class="modal-head"><h2 id="escalate-title">Create incident from alert</h2><button id="close-modal" class="btn btn-ghost btn-sm" aria-label="Close">✕</button></div>
  <p class="muted" style="margin-top:0">An alert is observed technical signal. Declaring an incident is an explicit operational decision and is never automatic.</p>
  <form id="escalate-form"><div class="field"><label for="esc-title">Incident title</label><input class="input" id="esc-title" name="title" required minlength="3" value="${esc(alert.title)}"></div>
  <div class="form-row"><div class="field"><label for="esc-severity">Severity</label><select class="select" id="esc-severity" name="severity">${['SEV1','SEV2','SEV3','SEV4'].map((x)=>`<option ${x==='SEV3'?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label for="esc-service">Affected service</label><input class="input" id="esc-service" value="${esc(alert.serviceName??'From alert')}" disabled></div></div>
  <div class="field"><label for="esc-summary">Summary</label><textarea class="textarea" id="esc-summary" name="summary">Escalated from alert ${esc(alert.source)}: ${esc(alert.title)}</textarea></div>
  <button class="btn btn-primary btn-block" type="submit">Declare incident</button></form></section>`;
  const modal=openModal(backdrop);
  backdrop.querySelector('#close-modal').onclick=modal.close;
  backdrop.querySelector('#escalate-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);
    try{const incident=await api(`/api/v1/organizations/${state.orgId}/alerts/${alert.id}/incidents`,{method:'POST',body:{title:f.get('title'),summary:f.get('summary'),severity:f.get('severity')}});modal.close();toast('Incident declared from alert.');navigate(`/app/incidents/${incident.id}`)}catch(error){toast(error.message,'error')}});
}

async function renderTeams(seq=++renderSeq){
  const [teams,members,services]=await Promise.all([api(`/api/v1/organizations/${state.orgId}/teams`),api(`/api/v1/organizations/${state.orgId}/members`),api(`/api/v1/organizations/${state.orgId}/services`)]);
  const details=await Promise.all(teams.map((t)=>api(`/api/v1/organizations/${state.orgId}/teams/${t.id}`)));
  const memberById=new Map(members.map((m)=>[m.userId,m]));
  const cards=details.map((team)=>{
    const candidates=members.filter((m)=>!team.members.some((x)=>x.userId===m.userId));
    const owned=services.filter((s)=>s.ownerTeamId===team.id);
    return `<article class="card" data-team="${esc(team.id)}">
      <div class="section-head"><div><h2>${esc(team.name)}</h2><span>/${esc(team.slug)}</span></div>${badgeBool(true,`${team.members.length} member${team.members.length===1?'':'s'}`,'')}</div>
      <p class="muted" style="margin:6px 0 12px">${esc(team.description||'Responder team for on-call ownership.')}</p>
      <div class="section-head"><h2 style="font-size:13px">Members</h2><span>Organization membership is required</span></div>
      <div class="member-list">${team.members.length?team.members.map((m)=>`<div class="user-chip"><div class="avatar">${esc((m.displayName??'?').slice(0,1).toUpperCase())}</div><div class="user-meta"><strong>${esc(m.displayName??'Member')}</strong><span>${esc(m.role??'')} · ${esc(m.email??'')}</span></div>${canConfigure()?`<button class="btn btn-ghost btn-sm" data-remove-member="${esc(team.id)}:${esc(m.userId)}" aria-label="Remove ${esc(m.displayName??'member')} from team">✕</button>`:''}</div>`).join(''):empty('No members','Add organization members to build a rotation.')}</div>
      ${canConfigure()?`<form class="inline-form" data-add-member="${esc(team.id)}"><label class="subtext" for="member-${esc(team.id)}">Add member</label><select class="select" id="member-${esc(team.id)}" name="userId">${candidates.map((m)=>`<option value="${esc(m.userId)}">${esc(m.displayName??m.email)} (${esc(m.role)})</option>`).join('')||'<option value="">No candidates</option>'}</select><button class="btn btn-sm" type="submit" ${candidates.length?'':'disabled'}>Add</button></form>`:''}
      <div class="section-head" style="margin-top:14px"><h2 style="font-size:13px">Owned services</h2><span>${owned.length}</span></div>
      <div class="chips">${owned.length?owned.map((s)=>`<span class="chip">Service · ${esc(s.name)}</span>`).join(''):'<span class="muted">No service ownership assigned. Assign an owning team on the Services screen.</span>'}</div>
    </article>`;
  }).join('');
  const content=`<div class="page-head"><div><h1>Responder teams</h1><p>Teams own on-call schedules and internal services. Membership never bypasses organization membership or RBAC.</p></div></div>
  ${canConfigure()?`<form id="team-form" class="card panel-form"><div><label class="subtext" for="team-name">Team name</label><input class="input" id="team-name" name="name" required minlength="2" placeholder="Core Platform"></div><div><label class="subtext" for="team-slug">Slug</label><input class="input" id="team-slug" name="slug" placeholder="core-platform"></div><div class="span-2"><label class="subtext" for="team-desc">Description</label><input class="input" id="team-desc" name="description" placeholder="Owns checkout and payments"></div><button class="btn btn-primary" type="submit">Create team</button></form>`:''}
  <div class="grid grid-2">${cards||empty('No responder teams','Create a team, add members, then build an on-call schedule.')}</div>`;
  if(seq!==renderSeq)return;
  root.innerHTML=shell('Teams',content);bindShell();
  document.querySelector('#team-form')?.addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/api/v1/organizations/${state.orgId}/teams`,{method:'POST',body:{name:f.get('name'),slug:f.get('slug')||undefined,description:f.get('description')}});toast('Responder team created.');renderTeams()}catch(error){toast(error.message,'error')}});
  document.querySelectorAll('[data-add-member]').forEach((form)=>form.addEventListener('submit',async(e)=>{e.preventDefault();const select=form.querySelector('select');if(!select.value)return;try{await api(`/api/v1/organizations/${state.orgId}/teams/${form.dataset.addMember}/members`,{method:'POST',body:{userId:select.value}});toast('Member added to team.');renderTeams()}catch(error){toast(error.message,'error')}}));
  document.querySelectorAll('[data-remove-member]').forEach((btn)=>btn.addEventListener('click',async()=>{const[teamId,userId]=btn.dataset.removeMember.split(':');try{await api(`/api/v1/organizations/${state.orgId}/teams/${teamId}/members/${userId}`,{method:'DELETE'});toast('Member removed. Rotations were updated.');renderTeams()}catch(error){toast(error.message,'error')}}));
  startSse();
}

async function renderOnCall(seq=++renderSeq){
  const [stateData,teams,members]=await Promise.all([
    api(`/api/v1/organizations/${state.orgId}/oncall/state`),
    api(`/api/v1/organizations/${state.orgId}/teams`),
    api(`/api/v1/organizations/${state.orgId}/members`)
  ]);
  const teamDetails=await Promise.all(teams.map((t)=>api(`/api/v1/organizations/${state.orgId}/teams/${t.id}`)));
  const schedules=stateData.oncall;
  const onCallNow=schedules.filter((s)=>s.current.resolved);
  const hero=schedules.length?`<section class="card oncall-hero" aria-label="Who is on call right now"><div class="section-head"><h2>On call right now</h2><span>Evaluated ${esc(fmt(stateData.at))}</span></div>
    <div class="oncall-grid">${schedules.map((s)=>`<div class="oncall-card ${s.current.resolved?'live':'idle'}">
      <div class="oncall-who">${s.current.resolved?`<div class="avatar lg">${esc((s.current.displayName??'?').slice(0,1).toUpperCase())}</div><div><strong>${esc(s.current.displayName??'Responder')}</strong><span class="subtext">${s.current.source==='OVERRIDE'?'Temporary override':'Rotation'}</span></div>`:`<div><strong>No responder</strong><span class="subtext">${esc(routingLabel(s.current.reason))}</span></div>`}</div>
      <div class="oncall-meta"><span>${esc(s.schedule.name)}</span><span class="subtext">${esc(s.schedule.teamName??'Team')} · every ${esc(durationLabel(s.schedule.rotationIntervalMinutes))}</span></div>
      <div class="oncall-meta"><span>${badgeBool(s.schedule.enabled,'Enabled','Disabled')}</span><span class="subtext">${esc(s.schedule.timeZone)}</span></div>
      <div class="oncall-meta"><span>Next handoff</span><span class="subtext">${s.current.periodEndsAt?`${esc(fmtTz(s.current.periodEndsAt,s.schedule.timeZone))} → ${esc(s.next[0]?.displayName??'—')}`:(s.next[0]?`${esc(fmtTz(s.next[0].startsAt,s.schedule.timeZone))} → ${esc(s.next[0].displayName??'—')}`:'—')}</span></div>
      ${s.activeOverride?`<div class="override-note">Override until ${esc(fmtTz(s.activeOverride.endsAt,s.schedule.timeZone))}${s.activeOverride.reason?` · ${esc(s.activeOverride.reason)}`:''}</div>`:''}
    </div>`).join('')}</div></section>`:'';

  const scheduleRows=schedules.map((s)=>`<tr>
    <td class="name-cell">${esc(s.schedule.name)}<div class="subtext">${esc(s.schedule.teamName??'—')}</div></td>
    <td>${s.current.resolved?esc(s.current.displayName??'Responder'):'—'}<div class="subtext">${esc(routingLabel(s.current.reason))}</div></td>
    <td>${esc(s.schedule.timeZone)}<div class="subtext">every ${esc(durationLabel(s.schedule.rotationIntervalMinutes))}</div></td>
    <td class="nowrap">${s.current.periodEndsAt?esc(fmtTz(s.current.periodEndsAt,s.schedule.timeZone)):(s.next[0]?esc(fmtTz(s.next[0].startsAt,s.schedule.timeZone)):'—')}<div class="subtext">${esc(s.next[0]?.displayName??'—')}</div></td>
    <td>${badgeBool(s.schedule.enabled,'Enabled','Disabled')}${s.activeOverride?`<div class="subtext">Override active</div>`:''}</td>
    <td><div class="toolbar">
      ${canConfigure()?`<button class="btn btn-sm" data-toggle-schedule="${esc(s.schedule.id)}" data-enabled="${s.schedule.enabled?'true':'false'}">${s.schedule.enabled?'Disable':'Enable'}</button><button class="btn btn-sm" data-add-override="${esc(s.schedule.id)}">Override</button>`:''}
      <button class="btn btn-sm" data-schedule-detail="${esc(s.schedule.id)}">Rotation</button>
    </div></td></tr>`).join('');

  const createForm=canConfigure()?`<form id="schedule-form" class="card">
    <div class="section-head"><h2>New on-call schedule</h2><span>Deterministic recurring rotation</span></div>
    <div class="form-row"><div class="field"><label for="sch-name">Schedule name</label><input class="input" id="sch-name" name="name" required minlength="2" placeholder="Primary on-call"></div>
    <div class="field"><label for="sch-team">Responder team</label><select class="select" id="sch-team" name="teamId">${teamDetails.map((t)=>`<option value="${esc(t.id)}">${esc(t.name)} (${t.members.length})</option>`).join('')||'<option value="">No teams yet</option>'}</select></div></div>
    <div class="form-row"><div class="field"><label for="sch-tz">Timezone (IANA)</label><select class="select" id="sch-tz" name="timeZone">${COMMON_ZONES.map((z)=>`<option ${z==='UTC'?'selected':''}>${z}</option>`).join('')}</select><span class="subtext">Used for display and validation. Handoff arithmetic always runs on absolute UTC instants, so DST cannot skip or repeat a shift.</span></div>
    <div class="field"><label for="sch-interval">Handoff interval</label><select class="select" id="sch-interval" name="rotationIntervalMinutes">${INTERVAL_PRESETS.map(([m,label])=>`<option value="${m}">${label}</option>`).join('')}</select></div></div>
    <div class="form-row"><div class="field"><label for="sch-start">Rotation starts (your local time)</label><input class="input" id="sch-start" name="rotationStartsAt" type="datetime-local" value="${esc(localInputValue())}"><span class="subtext" id="sch-start-utc"></span></div>
    <div class="field"><label>Enabled</label><label class="check"><input type="checkbox" name="enabled" checked>Schedule is active</label></div></div>
    <div class="field"><label>Rotation participants</label><span class="subtext">Set the order explicitly. Positions may repeat numbers; ties keep the listed order.</span><div class="check-grid" id="sch-participants"></div></div>
    <button class="btn btn-primary" type="submit" ${teamDetails.length?'':'disabled'}>Create schedule</button>
  </form>`:'';

  const content=`<div class="page-head"><div><h1>On-call</h1><p>Who is responsible right now, who is next, and which temporary overrides are in force.</p></div></div>
  ${hero||empty('No on-call schedules','Create a responder team, then add a schedule to answer “who is on call right now?”.')}
  <section class="section"><div class="section-head"><h2>Schedules</h2><span>${schedules.length}</span></div>
  <div class="table-wrap">${schedules.length?`<table><thead><tr><th>Schedule</th><th>On call now</th><th>Timezone / interval</th><th>Next handoff</th><th>State</th><th>Actions</th></tr></thead><tbody>${scheduleRows}</tbody></table>`:empty('No schedules','Schedules appear here once created.')}</div></section>
  ${createForm}
  <section class="section" id="schedule-detail-section"></section>`;
  if(seq!==renderSeq)return;
  root.innerHTML=shell('On-call',content);bindShell();

  const participantsBox=document.querySelector('#sch-participants');
  const teamSelect=document.querySelector('#sch-team');
  const startInput=document.querySelector('#sch-start');
  const utcHint=document.querySelector('#sch-start-utc');
  const paintParticipants=()=>{
    if(!participantsBox)return;
    const team=teamDetails.find((t)=>t.id===teamSelect?.value);
    participantsBox.innerHTML=(team?.members.length?team.members:[]).map((m,i)=>`<label class="check"><input type="checkbox" name="participant" value="${esc(m.userId)}" data-order="${i}"><span>${esc(m.displayName??m.email)}</span><input class="input order-input" type="number" min="0" step="1" value="${i}" data-order-for="${esc(m.userId)}" aria-label="Rotation position for ${esc(m.displayName??m.email)}"></label>`).join('')||'<span class="muted">This team has no members yet.</span>';
  };
  const paintUtcHint=()=>{if(utcHint&&startInput)utcHint.textContent=`Stored as ${fromLocalInput(startInput.value)} (absolute UTC instant).`;};
  teamSelect?.addEventListener('change',paintParticipants);
  startInput?.addEventListener('input',paintUtcHint);
  paintParticipants();paintUtcHint();

  document.querySelector('#schedule-form')?.addEventListener('submit',async(e)=>{
    e.preventDefault();const f=new FormData(e.currentTarget);
    const chosen=[...e.currentTarget.querySelectorAll('input[name=participant]')].filter((x)=>x.checked);
    const orderOf=(userId)=>{const input=e.currentTarget.querySelector(`[data-order-for="${CSS.escape(userId)}"]`);const n=input?Number(input.value):Number.NaN;return Number.isFinite(n)?n:Number.MAX_SAFE_INTEGER};
    const participantUserIds=chosen.map((x)=>x.value).sort((a,b)=>orderOf(a)-orderOf(b)||chosen.findIndex((x)=>x.value===a)-chosen.findIndex((x)=>x.value===b));
    if(!participantUserIds.length){toast('Select at least one rotation participant.','error');return}
    try{await api(`/api/v1/organizations/${state.orgId}/oncall/schedules`,{method:'POST',body:{name:f.get('name'),teamId:f.get('teamId'),timeZone:f.get('timeZone'),enabled:f.get('enabled')==='on',rotationStartsAt:fromLocalInput(f.get('rotationStartsAt')),rotationIntervalMinutes:Number(f.get('rotationIntervalMinutes')),participantUserIds}});toast('On-call schedule created.');renderOnCall()}catch(error){toast(error.message,'error')}
  });

  document.querySelectorAll('[data-toggle-schedule]').forEach((btn)=>btn.addEventListener('click',async()=>{btn.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/oncall/schedules/${btn.dataset.toggleSchedule}`,{method:'PATCH',body:{enabled:btn.dataset.enabled!=='true'}});toast('Schedule updated.');renderOnCall()}catch(error){toast(error.message,'error');btn.disabled=false}}));
  document.querySelectorAll('[data-add-override]').forEach((btn)=>btn.addEventListener('click',()=>overrideModal(btn.dataset.addOverride,members,schedules.find((s)=>s.schedule.id===btn.dataset.addOverride))));
  document.querySelectorAll('[data-schedule-detail]').forEach((btn)=>btn.addEventListener('click',async()=>{const scheduleId=btn.dataset.scheduleDetail;const box=document.querySelector('#schedule-detail-section');box.innerHTML='<div class="empty">Loading rotation…</div>';try{const data=await api(`/api/v1/organizations/${state.orgId}/oncall/schedules/${scheduleId}/oncall`);box.innerHTML=`<div class="card"><div class="section-head"><h2>${esc(data.schedule.name)} — rotation</h2><span>${esc(data.schedule.timeZone)} · every ${esc(durationLabel(data.schedule.rotationIntervalMinutes))}</span></div><ol class="rotation-list">${data.rotationOrder.map((p)=>`<li><span class="rotation-pos">${p.position+1}</span><strong>${esc(p.displayName??'Member')}</strong><span class="subtext">${esc(p.userId)}</span></li>`).join('')}</ol><div class="section-head" style="margin-top:14px"><h2 style="font-size:13px">Overrides</h2><span>${data.schedule.overrides.length}</span></div>${data.schedule.overrides.length?`<div class="table-wrap"><table><thead><tr><th>Responder</th><th>Window</th><th>Reason</th><th></th></tr></thead><tbody>${data.schedule.overrides.map((o)=>`<tr><td>${esc(o.replacementDisplayName??'—')}</td><td class="nowrap">${esc(fmtTz(o.startsAt,data.schedule.timeZone))} → ${esc(fmtTz(o.endsAt,data.schedule.timeZone))}</td><td>${esc(o.reason||'—')}</td><td>${canConfigure()?`<button class="btn btn-sm btn-danger" data-delete-override="${esc(o.id)}">Delete</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No overrides. The rotation resolves normally.</p>'}</div>`;
    box.querySelectorAll('[data-delete-override]').forEach((del)=>del.addEventListener('click',async()=>{del.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/oncall/overrides/${del.dataset.deleteOverride}`,{method:'DELETE'});toast('Override deleted; the rotation resumed.');renderOnCall()}catch(error){toast(error.message,'error');del.disabled=false}}));
    box.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'nearest'});
  }catch(error){box.innerHTML=`<div class="empty"><strong>Could not load rotation</strong>${esc(error.message)}</div>`}}));
  startSse();
}

function overrideModal(scheduleId,members,schedule){
  const backdrop=document.createElement('div');backdrop.className='modal-backdrop';
  backdrop.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="override-title"><div class="modal-head"><h2 id="override-title">Temporary on-call override</h2><button id="close-modal" class="btn btn-ghost btn-sm" aria-label="Close">✕</button></div>
  <p class="muted" style="margin-top:0">During the window the replacement responder is resolved instead of the rotation. When it expires the rotation resumes unchanged. Overlapping windows are rejected.</p>
  <form id="override-form"><div class="field"><label for="ov-user">Replacement responder</label><select class="select" id="ov-user" name="replacementUserId">${members.map((m)=>`<option value="${esc(m.userId)}">${esc(m.displayName??m.email)} (${esc(m.role)})</option>`).join('')}</select></div>
  <div class="form-row"><div class="field"><label for="ov-start">Starts (local time)</label><input class="input" id="ov-start" name="startsAt" type="datetime-local" required value="${esc(localInputValue())}"></div><div class="field"><label for="ov-end">Ends (local time)</label><input class="input" id="ov-end" name="endsAt" type="datetime-local" required value="${esc(localInputValue(Date.now()+8*3600*1000))}"></div></div>
  <div class="field"><label for="ov-reason">Reason / note</label><input class="input" id="ov-reason" name="reason" maxlength="500" placeholder="Conference coverage"></div>
  <div class="subtext">Schedule timezone: ${esc(schedule?.schedule?.timeZone??'UTC')}</div>
  <button class="btn btn-primary btn-block" type="submit">Create override</button></form></section>`;
  const modal=openModal(backdrop);
  backdrop.querySelector('#close-modal').onclick=modal.close;
  backdrop.querySelector('#override-form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);
    const startsAt=fromLocalInput(f.get('startsAt')),endsAt=fromLocalInput(f.get('endsAt'));
    if(new Date(endsAt)<=new Date(startsAt)){toast('The override must end after it starts.','error');return}
    try{await api(`/api/v1/organizations/${state.orgId}/oncall/schedules/${scheduleId}/overrides`,{method:'POST',body:{replacementUserId:f.get('replacementUserId'),startsAt,endsAt,reason:f.get('reason')}});modal.close();toast('Override created.');renderOnCall()}catch(error){toast(error.message,'error')}});
}

async function renderRouting(seq=++renderSeq){
  const [rules,schedules,services]=await Promise.all([
    api(`/api/v1/organizations/${state.orgId}/routing-rules`),
    api(`/api/v1/organizations/${state.orgId}/oncall/schedules`),
    api(`/api/v1/organizations/${state.orgId}/services`)
  ]);
  const scheduleOptions=schedules.oncall.map((s)=>`<option value="${esc(s.schedule.id)}">${esc(s.schedule.name)}${s.current.resolved?` — ${esc(s.current.displayName??'')}`:' — no responder'}</option>`).join('');
  const rows=rules.map((rule,index)=>`<tr>
    <td class="name-cell">${rule.priority}<div class="subtext">evaluates #${index+1}</div></td>
    <td class="name-cell">${esc(rule.name)}<div class="subtext">${esc(ruleSummary(rule,services))}</div></td>
    <td>${esc(rule.scheduleName??'Missing schedule')}<div class="subtext">On-call schedule</div></td>
    <td>${badgeBool(rule.enabled,'Enabled','Disabled')}</td>
    <td><div class="toolbar">
      ${canConfigure()?`<button class="btn btn-sm" data-toggle-rule="${esc(rule.id)}" data-enabled="${rule.enabled?'true':'false'}">${rule.enabled?'Disable':'Enable'}</button>
      <button class="btn btn-sm" data-priority="${esc(rule.id)}" data-delta="-10" aria-label="Raise priority">↑</button>
      <button class="btn btn-sm" data-priority="${esc(rule.id)}" data-delta="10" aria-label="Lower priority">↓</button>
      <button class="btn btn-sm btn-danger" data-delete-rule="${esc(rule.id)}">Delete</button>`:''}
    </div></td></tr>`).join('');
  const content=`<div class="page-head"><div><h1>Routing rules</h1><p>Rules are evaluated by priority ascending, then creation time, then id. The first match wins, so behaviour never depends on database row order.</p></div></div>
  ${canConfigure()?`<form id="rule-form" class="card">
    <div class="section-head"><h2>New routing rule</h2><span>Conditions are exact matches — no expressions</span></div>
    <div class="form-row"><div class="field"><label for="rule-name">Rule name</label><input class="input" id="rule-name" name="name" required minlength="2" placeholder="Critical checkout alerts"></div>
    <div class="field"><label for="rule-priority">Priority</label><input class="input" id="rule-priority" name="priority" type="number" min="0" max="100000" step="1" value="100"><span class="subtext">Lower evaluates first.</span></div></div>
    <div class="form-row"><div class="field"><label for="rule-service">Service</label><select class="select" id="rule-service" name="matchServiceId"><option value="">Any service</option>${services.map((s)=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="rule-source">Alert source</label><input class="input" id="rule-source" name="matchSource" maxlength="120" placeholder="Any source, e.g. grafana-webhook"><span class="subtext">Case-insensitive exact match.</span></div></div>
    <div class="field"><label>Severities</label><div class="check-grid" id="rule-severities">${['critical','warning','info','page','sev1','sev2','sev3','sev4'].map((s)=>`<label class="check"><input type="checkbox" name="severity" value="${esc(s)}">${esc(s)}</label>`).join('')}</div><span class="subtext">Leave empty to match any severity.</span></div>
    <div class="field"><label for="rule-target">Route to on-call schedule</label><select class="select" id="rule-target" name="targetScheduleId" required>${scheduleOptions||'<option value="">No schedules yet</option>'}</select></div>
    <button class="btn btn-primary" type="submit" ${schedules.oncall.length?'':'disabled'}>Create rule</button>
    ${schedules.oncall.length?'':'<p class="muted">Create a responder team and an on-call schedule first.</p>'}
  </form>`:''}
  <div class="table-wrap">${rules.length?`<table><thead><tr><th>Priority</th><th>Rule</th><th>Routes to</th><th>State</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`:empty('No routing rules','Alerts are stored durably but stay unrouted until a rule matches.')}</div>`;
  if(seq!==renderSeq)return;
  root.innerHTML=shell('Routing',content);bindShell();
  document.querySelector('#rule-form')?.addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);
    try{await api(`/api/v1/organizations/${state.orgId}/routing-rules`,{method:'POST',body:{name:f.get('name'),priority:Number(f.get('priority')),matchServiceId:f.get('matchServiceId')||null,matchSource:f.get('matchSource')||null,matchSeverities:f.getAll('severity'),targetScheduleId:f.get('targetScheduleId')}});toast('Routing rule created.');renderRouting()}catch(error){toast(error.message,'error')}});
  document.querySelectorAll('[data-toggle-rule]').forEach((btn)=>btn.addEventListener('click',async()=>{btn.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/routing-rules/${btn.dataset.toggleRule}`,{method:'PATCH',body:{enabled:btn.dataset.enabled!=='true'}});toast('Rule updated.');renderRouting()}catch(error){toast(error.message,'error');btn.disabled=false}}));
  document.querySelectorAll('[data-priority]').forEach((btn)=>btn.addEventListener('click',async()=>{const rule=rules.find((r)=>r.id===btn.dataset.priority);if(!rule)return;btn.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/routing-rules/${rule.id}`,{method:'PATCH',body:{priority:Math.max(0,Math.min(100000,rule.priority+Number(btn.dataset.delta)))}});renderRouting()}catch(error){toast(error.message,'error');btn.disabled=false}}));
  document.querySelectorAll('[data-delete-rule]').forEach((btn)=>btn.addEventListener('click',async()=>{if(!confirm('Delete this routing rule? Existing routing history is preserved.'))return;btn.disabled=true;try{await api(`/api/v1/organizations/${state.orgId}/routing-rules/${btn.dataset.deleteRule}`,{method:'DELETE'});toast('Routing rule deleted.');renderRouting()}catch(error){toast(error.message,'error');btn.disabled=false}}));
  startSse();
}

let renderSeq=0;

async function renderRoute(){
  const seq=++renderSeq;const path=location.pathname;if(path.startsWith('/status/'))return renderPublic();if(path==='/signin')return authLayout('login');if(path==='/register')return authLayout('register');await ensureMe();if(seq!==renderSeq)return;if(!state.me){return navigate('/signin')}if(!state.orgs.length)return renderOnboarding();if(!state.orgId){state.orgId=state.orgs[0].id;localStorage.setItem('relay.orgId',state.orgId)}
  if(path==='/app'||path==='/')return renderDashboard(seq);if(path==='/app/alerts')return renderAlerts(seq);if(path==='/app/oncall')return renderOnCall(seq);if(path==='/app/teams')return renderTeams(seq);if(path==='/app/routing')return renderRouting(seq);if(path==='/app/services')return renderServices(seq);if(path==='/app/components')return renderComponents(seq);if(path==='/app/incidents')return renderIncidents(seq);const incident=path.match(/^\/app\/incidents\/([a-zA-Z0-9_-]+)$/);if(incident)return renderIncident(incident[1],seq);if(path==='/app/status-pages')return renderStatusPages(seq);if(path==='/app/settings')return renderSettings(seq);navigate('/app');
}

renderRoute().catch(handleFatal);
