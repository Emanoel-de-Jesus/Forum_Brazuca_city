(function(){
  const $ = (id)=>document.getElementById(id);
  document.body.classList.add('bz-enterprise-bg');
  async function getJson(url, opts){const r=await fetch(url,{cache:'no-store',credentials:'same-origin',...(opts||{})});return r.json();}
  function fmt(n){return Number(n||0).toLocaleString('pt-BR');}
  function createEnterprisePanel(data){
    const shell=document.querySelector('#app-shell main')||document.querySelector('#app-shell')||document.body;
    if($('brazuca-live-panel')) return;
    const panel=document.createElement('section'); panel.id='brazuca-live-panel'; panel.className='max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-6';
    panel.innerHTML=`<div class="bz-hero bz-glass rounded-3xl p-5 sm:p-7"><div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5"><div><span class="bz-pill">Fórum oficial integrado ao jogo</span><h1 class="mt-3 font-cyber text-3xl sm:text-5xl font-black tracking-wider text-white">Brazuca RP <span class="text-samp-neon">Central</span></h1><p class="mt-3 max-w-2xl text-slate-300">Conta, personagem, RG, staff, membros e comunidade puxados do mesmo ecossistema MySQL usado pela API e pela Gamemode.</p></div><div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-3 min-w-[260px]"><div class="bz-stat"><span class="text-xs uppercase tracking-widest text-slate-400">Membros</span><strong id="bz-members">0</strong></div><div class="bz-stat"><span class="text-xs uppercase tracking-widest text-slate-400">Personagens</span><strong id="bz-chars">0</strong></div><div class="bz-stat"><span class="text-xs uppercase tracking-widest text-slate-400">Online Fórum</span><strong id="bz-online">0</strong></div><div class="bz-stat"><span class="text-xs uppercase tracking-widest text-slate-400">Staff</span><strong id="bz-staff">0</strong></div></div></div><div id="bz-db-status" class="mt-4 text-xs text-slate-400"></div></div>`;
    shell.prepend(panel); updatePanel(data);
  }
  function updatePanel(payload){const d=payload?.data||payload||{}; if(!$('bz-members')) return; $('bz-members').textContent=fmt(d.members); $('bz-chars').textContent=fmt(d.characters); $('bz-online').textContent=fmt(d.online); $('bz-staff').textContent=fmt(d.staff); const schema=d.schema; $('bz-db-status').innerHTML=d.connected?`<span class="text-emerald-300">● MySQL conectado</span> • tabela detectada: <b>${schema?.accountTable||'auto'}</b>`:`<span class="text-red-300">● MySQL indisponível</span> • confira o endpoint e as credenciais do banco no .env`;}
  async function refresh(){try{const data=await getJson('/api/brazuca/overview');createEnterprisePanel(data);updatePanel(data);}catch(e){createEnterprisePanel({data:{connected:false}});}}
  const oldUpdate=window.updateStats; window.updateStats=function(){try{oldUpdate&&oldUpdate.apply(this,arguments)}finally{refresh();}};
  const oldLogin=window.handleLogin; if(typeof oldLogin==='function'){window.handleLogin=async function(ev){
    ev.preventDefault(); const identifier=$('auth-login-identifier')?.value?.trim(); const password=$('auth-login-password')?.value||'';
    try{const r=await getJson('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier,password})}); if(r.ok&&r.user){window.currentUser=r.user; localStorage.setItem('brazuca_forum_current_user',JSON.stringify(r.user)); if(typeof showApp==='function') showApp(); if(typeof addActivityLog==='function') addActivityLog('Login MySQL Brazuca',r.user,{source:r.user.source}); if(typeof renderAll==='function') renderAll(); refresh(); return;} const fb=$('auth-feedback'); if(fb) fb.textContent=r.error||'Não foi possível entrar.';}catch(e){return oldLogin.apply(this,arguments);}
  };}
  document.addEventListener('DOMContentLoaded',refresh); setInterval(refresh,30000);
})();

/* Interacao responsiva da tela de autenticacao */
(function(){
  function setupAuthMotion(){
    const authScreen=document.getElementById('auth-screen');
    const authPanel=authScreen?.querySelector('.auth-panel-glow');
    if(!authScreen||!authPanel||window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let framePending=false;
    let pointerX=50;
    let pointerY=50;
    function updateMotion(){
      framePending=false;
      const rotateY=(pointerX-50)*.08;
      const rotateX=(50-pointerY)*.055;
      const shiftX=(pointerX-50)*.035;
      const shiftY=(pointerY-50)*.025;
      authScreen.style.setProperty('--auth-pointer-x',`${pointerX}%`);
      authScreen.style.setProperty('--auth-pointer-y',`${pointerY}%`);
      authPanel.style.setProperty('--auth-rotate-x',`${rotateX.toFixed(2)}deg`);
      authPanel.style.setProperty('--auth-rotate-y',`${rotateY.toFixed(2)}deg`);
      authPanel.style.setProperty('--auth-shift-x',`${shiftX.toFixed(2)}px`);
      authPanel.style.setProperty('--auth-shift-y',`${shiftY.toFixed(2)}px`);
    }
    function handlePointerMove(event){
      const bounds=authScreen.getBoundingClientRect();
      pointerX=Math.max(0,Math.min(100,(event.clientX-bounds.left)/bounds.width*100));
      pointerY=Math.max(0,Math.min(100,(event.clientY-bounds.top)/bounds.height*100));
      if(!framePending){framePending=true;requestAnimationFrame(updateMotion);}
    }
    function resetMotion(){
      pointerX=50; pointerY=50;
      if(!framePending){framePending=true;requestAnimationFrame(updateMotion);}
    }
    authScreen.addEventListener('pointermove',handlePointerMove,{passive:true});
    authScreen.addEventListener('pointerleave',resetMotion,{passive:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',setupAuthMotion,{once:true});
  else setupAuthMotion();
})();

/* Brazuca RP Enterprise v3 - migração de nomes e reforço mobile */
(function(){
  function brazucaTextFix(){
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); const nodes=[]; while(walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(n=>{ if(/Nexus|NEXUS/i.test(n.nodeValue)) n.nodeValue=n.nodeValue.replace(/NEXUS RPG/g,'BRAZUCA RP').replace(/Nexus RPG/g,'Brazuca RP').replace(/Nexus AC Launcher/g,'Brazuca RP Launcher').replace(/Nexus/g,'Brazuca'); });
    document.title=(document.title||'Brazuca RP').replace(/Nexus|NEXUS/g,'Brazuca');
  }
  function migrateLocalConfig(){
    try{
      ['brazuca_forum_state','forumState','brazucaForumState'].forEach(k=>{
        const raw=localStorage.getItem(k); if(!raw||!/Nexus|NEXUS/.test(raw)) return;
        localStorage.setItem(k, raw.replace(/NEXUS RPG/g,'BRAZUCA RP').replace(/Nexus RPG/g,'Brazuca RP').replace(/Nexus AC Launcher/g,'Brazuca RP Launcher'));
      });
    }catch(e){}
    if(window.currentConfig){
      if(/Nexus|NEXUS/.test(String(window.currentConfig.heroTitle||''))) window.currentConfig.heroTitle='BEM-VINDO AO BRAZUCA RP';
      if(/Nexus/i.test(String(window.currentConfig.forumTitle||''))) window.currentConfig.forumTitle='Brazuca RP | Fórum Oficial';
    }
  }
  function improveMobileCards(){
    document.querySelectorAll('[id^="sec-"] .grid').forEach(el=>el.style.minWidth='0');
    const hero=document.getElementById('hero-title'); if(hero && !hero.dataset.bzFixed){ hero.dataset.bzFixed='1'; hero.innerHTML=(hero.textContent||'BEM-VINDO AO BRAZUCA RP').replace('BRAZUCA RP','<span class="text-samp-neon">BRAZUCA RP</span>'); }
    const desc=document.getElementById('hero-description'); if(desc && /Nexus/i.test(desc.textContent||'')) desc.textContent=desc.textContent.replace(/Nexus RPG/gi,'Brazuca RP');
  }
  const oldApply=window.applyLoadedState; if(typeof oldApply==='function') window.applyLoadedState=function(parsed){ if(parsed&&parsed.config){ parsed.config.heroTitle=String(parsed.config.heroTitle||'').replace(/NEXUS RPG/g,'BRAZUCA RP').replace(/Nexus RPG/g,'Brazuca RP'); parsed.config.forumTitle=String(parsed.config.forumTitle||'Brazuca RP | Fórum Oficial').replace(/Nexus/gi,'Brazuca'); } return oldApply.call(this,parsed); };
  const oldRenderAll=window.renderAll; if(typeof oldRenderAll==='function') window.renderAll=function(){ const r=oldRenderAll.apply(this,arguments); setTimeout(()=>{migrateLocalConfig();brazucaTextFix();improveMobileCards();},0); return r; };
  document.addEventListener('DOMContentLoaded',()=>{migrateLocalConfig(); setTimeout(()=>{brazucaTextFix();improveMobileCards();},80); setTimeout(()=>{brazucaTextFix();improveMobileCards();},800);});
})();
