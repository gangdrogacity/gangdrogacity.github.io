const repo='jamnaga/wtf-modpack';
const apiRoot=`https://api.github.com/repos/${repo}`;
const themeBtn=document.getElementById('theme-toggle');
const darkAlert=document.getElementById('dark-alert');
let latestRelease;

function showRateLimitError(){
  const c=document.querySelector('.container');
  const a=document.createElement('div');
  a.className='alert alert-warning';
  a.textContent='GitHub API rate limit raggiunto.';
  c.prepend(a);
}

function applyTheme(d){
  document.documentElement.classList.toggle('dark-mode',d);
  themeBtn.textContent=d?'Light Mode':'Dark Mode';
  localStorage.setItem('gdcThemeDark',d);
}

function initTheme(){
  const stored=localStorage.getItem('gdcThemeDark');
  const dark=stored===null?true:(stored==='true');
  applyTheme(dark);
  themeBtn.addEventListener('click',()=>{
    const nd=document.documentElement.classList.toggle('dark-mode');
    applyTheme(nd);
    if(nd)hideDarkAlert();
  });
  const dismissed=localStorage.getItem('gdcDarkAlertDismissed')==='true';
  if(!dark&&!dismissed) setTimeout(()=>darkAlert.classList.add('show'),1000);
}

function hideDarkAlert(){
  darkAlert.classList.remove('show');
  localStorage.setItem('gdcDarkAlertDismissed','true');
}

function setupHero(r){
  document.getElementById('hero-version').textContent=r.tag_name;
  document.getElementById('hero-date').textContent=new Date(r.published_at).toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'});
}

function openAssetModal(){
  const mb=document.getElementById('modal-buttons');
  mb.innerHTML='';
  latestRelease.assets.forEach(a=>{
    let l='',c='btn-secondary';
    const n=a.name.toLowerCase();
    if(n==='server.zip'){l='Server';c='btn-primary';}
    else if(n==='client.zip'){l='Client Legacy';c='btn-warning text-dark';}
    else if(n.endsWith('.mrpack')){l='Modrinth';c='btn-success';}
    else if(n==='update.exe'){l='Installer';c='btn-purple';}
    if(l){
      const b=document.createElement('a');
      b.className=`btn ${c} w-100 mb-2`;
      b.href=a.browser_download_url;
      b.textContent=`Scarica ${l}`;
      b.addEventListener('click',()=>bootstrap.Modal.getInstance(document.getElementById('assetModal')).hide());
      mb.appendChild(b);
    }
  });
  new bootstrap.Modal(document.getElementById('assetModal')).show();
}

function showReleaseCards(rs){
  const row=document.getElementById('releases-row');
  row.innerHTML='';
  rs.forEach((r,i)=>{
    const col=document.createElement('div');
    col.className='col-12 col-md-6 col-lg-4';
    const cd=document.createElement('div');
    cd.className='card h-100';
    cd.style.animationDelay=`${(i+1)*100}ms`;
    const bd=document.createElement('div');
    bd.className='card-body d-flex flex-column';
    const t=document.createElement('h6');
    t.className='card-title';
    t.textContent=r.name||r.tag_name;
    bd.appendChild(t);
    if(r.published_at){
      const d=document.createElement('p');
      d.className='card-text text-muted mb-3';
      d.textContent=new Date(r.published_at).toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'});
      bd.appendChild(d);
    }
    const bc=document.createElement('div');
    bc.className='mt-auto d-flex flex-wrap gap-2';
    r.assets.forEach(a=>{
      let l='',c='btn-secondary';
      const n=a.name.toLowerCase();
      if(n==='server.zip'){l='Download Server';c='btn-primary';}
      else if(n==='client.zip'){l='Download Client Legacy';c='btn-warning text-dark';}
      else if(n.endsWith('.mrpack')){l='Download Modrinth';c='btn-success';}
      else if(n==='update.exe'){l='Download Installer';c='btn-purple';}
      if(l){
        const x=document.createElement('a');
        x.className=`btn ${c} btn-sm`;
        x.href=a.browser_download_url;
        x.textContent=l;
        bc.appendChild(x);
      }
    });
    bd.appendChild(bc);
    cd.appendChild(bd);
    col.appendChild(cd);
    row.appendChild(col);
  });
}

async function checkLatest(rs){
  try{
    const r0=rs[0];
    const cmp=await fetch(`${apiRoot}/compare/${encodeURIComponent(r0.tag_name)}...latest`).then(r=>r.json());
    const b=document.getElementById('latest-status');
    if(cmp.status==='identical'||cmp.status==='behind'){
      b.className='badge bg-success';
      b.textContent='Up-to-date';
      const fc=document.querySelector('#releases-row .card');
      if(fc)fc.classList.add('border','border-success','border-2');
    }else{
      b.className='badge bg-secondary';
      b.textContent='Latest';
      const fc=document.querySelector('#releases-row .card.border-success');
      if(fc)fc.classList.remove('border','border-success','border-2');
    }
  }catch(e){
    console.error('Errore nel checkLatest:',e);
  }
}

async function init(){
  // Mostra indicatore di caricamento delle release
  const releasesRow = document.getElementById('releases-row');
  releasesRow.innerHTML = `<div class="text-center my-4"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div> Caricamento release...</div>`;
  
  initTheme();
  
  const ck='gdcReleases', ctsk='gdcReleasesTs', ttl=5*60*1000;
  let rs;
  const now=Date.now();
  
  try{
    const cached=localStorage.getItem(ck), ts=parseInt(localStorage.getItem(ctsk),10)||0;
    if(cached&&now-ts<ttl) rs=JSON.parse(cached);
    else{
      const res=await fetch(`${apiRoot}/releases`);
      if(res.status===403){
        if(cached) rs=JSON.parse(cached);
        else{
          showRateLimitError();
          return;
        }
      }else{
        rs=await res.json();
        localStorage.setItem(ck,JSON.stringify(rs));
        localStorage.setItem(ctsk,now.toString());
      }
    }
  }catch(e){
    console.error('Errore fetch/cache releases:',e);
    const cached=localStorage.getItem(ck);
    if(cached) rs=JSON.parse(cached);
    else{
      showRateLimitError();
      return;
    }
  }
  
  latestRelease=rs[0];
  setupHero(latestRelease);
  showReleaseCards(rs);
  
  document.getElementById('latest-btn').onclick=()=>window.location.href=`https://github.com/${repo}/archive/refs/heads/latest.zip`;
  document.getElementById('hero-download-btn').onclick=openAssetModal;
  
  checkLatest(rs);
}

document.addEventListener('DOMContentLoaded', function() {
  init();
});
