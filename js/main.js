const repo='jamnaga/wtf-modpack';
const apiRoot=`https://api.github.com/repos/${repo}`;
const themeBtn=document.getElementById('theme-toggle');
const darkAlert=document.getElementById('dark-alert');
let latestRelease;

// Controllo del dominio ufficiale
function checkDomain() {
  const officialDomain = 'gangdrogacity.xyz';
  const currentDomain = window.location.hostname;
  
  if (currentDomain !== officialDomain) {
    showDomainWarning();
    return false;
  }
  return true;
}

function showDomainWarning() {
  // Crea overlay per l'avviso
  const overlay = document.createElement('div');
  overlay.id = 'domain-warning-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.9);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(5px);
  `;
  
  // Crea contenuto dell'avviso
  const warningBox = document.createElement('div');
  warningBox.style.cssText = `
    background: var(--bs-body-bg, white);
    color: var(--bs-body-color, black);
    border-radius: 15px;
    padding: 2rem;
    max-width: 500px;
    margin: 1rem;
    text-align: center;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    border: 2px solid var(--accent-color, #007bff);
  `;
  
  warningBox.innerHTML = `
    <div style="font-size: 3rem; margin-bottom: 1rem;">⚠️</div>
    <h3 style="color: var(--accent-color, #007bff); margin-bottom: 1rem;">Dominio Cambiato!</h3>
    <p style="margin-bottom: 1.5rem; line-height: 1.5;">
      Il dominio ufficiale del GDC Modpack è cambiato.<br>
      Per garantirti sempre l'ultima versione e la massima sicurezza, 
      ti invitiamo a utilizzare il nuovo dominio ufficiale.
    </p>
    <p style="margin-bottom: 2rem; font-weight: bold; color: var(--accent-color, #007bff);">
      Nuovo dominio: <code style="background: var(--bs-gray-100, #f8f9fa); padding: 0.25rem 0.5rem; border-radius: 4px;">https://gangdrogacity.xyz/</code>
    </p>
    <div style="display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap;">
      <a href="https://gangdrogacity.xyz/" 
         style="background: var(--accent-color, #007bff); color: white; padding: 0.75rem 1.5rem; 
                border-radius: 8px; text-decoration: none; font-weight: bold; 
                transition: all 0.3s ease; display: inline-block;">
        Vai al Sito Ufficiale
      </a>
      <button id="continue-anyway" 
              style="background: transparent; color: var(--bs-body-color, black); 
                     padding: 0.75rem 1.5rem; border: 2px solid var(--bs-border-color, #dee2e6); 
                     border-radius: 8px; cursor: pointer; font-weight: bold;
                     transition: all 0.3s ease;">
        Continua Comunque
      </button>
    </div>
    <p style="margin-top: 1rem; font-size: 0.875rem; color: var(--bs-text-muted, #6c757d);">
      Aggiorna i tuoi segnalibri per non perdere gli aggiornamenti!
    </p>
  `;
  
  // Aggiungi eventi hover per i pulsanti
  const continueBtn = warningBox.querySelector('#continue-anyway');
  continueBtn.addEventListener('mouseover', function() {
    this.style.backgroundColor = 'var(--bs-gray-100, #f8f9fa)';
  });
  continueBtn.addEventListener('mouseout', function() {
    this.style.backgroundColor = 'transparent';
  });
  
  // Evento per continuare comunque
  continueBtn.addEventListener('click', function() {
    overlay.remove();
  });
  
  overlay.appendChild(warningBox);
  document.body.appendChild(overlay);
  
  // Nascondi il contenuto principale
  document.querySelector('.container').style.display = 'none';
}

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
  // Controlla prima il dominio
  if (!checkDomain()) {
    return; // Se il dominio non è quello ufficiale, mostra l'avviso e ferma l'inizializzazione
  }
  
  init();

  // Gestisco il pulsante di chiusura dell'avviso dark mode
  document.querySelector('#dark-alert .close-alert').addEventListener('click', function() {
    hideDarkAlert();
  });
});
