'use strict';
// Presentación comercial interactiva (16:9): se genera como un único HTML autónomo, en ES / EN / DE / PT.
// Misma marca y mismos parámetros que la propuesta en hojas; contenido condensado, animado y navegable.
const IDX = { es: 0, en: 1, de: 2, pt: 3 };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
const imgOk = v => typeof v === 'string' && /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
const money = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pn = n => String(n).padStart(2, '0');

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#05080F;font-family:var(--sans);color:var(--ink);-webkit-font-smoothing:antialiased;overflow:hidden}
.deck{position:fixed;inset:0;overflow:hidden;background:radial-gradient(1200px 700px at 50% 40%,#0E1626,#05080F)}
.stage{position:absolute;left:50%;top:50%;width:1280px;height:720px;margin:-360px 0 0 -640px;transform-origin:center center;background:#fff;overflow:hidden;box-shadow:0 30px 120px rgba(0,0,0,.5)}
.slide{position:absolute;inset:0;padding:92px 92px 88px;opacity:0;visibility:hidden;transform:translateX(46px);transition:opacity .55s ease,transform .7s cubic-bezier(.2,.7,.2,1),visibility 0s .7s;overflow:hidden}
.slide.on{opacity:1;visibility:visible;transform:none;transition-delay:0s}
.slide.before{transform:translateX(-46px)}
.s-dark{background:var(--navy);color:#fff;--tx:rgba(255,255,255,.72);--ln:rgba(255,255,255,.16);--cd:rgba(255,255,255,.06);--cdb:rgba(255,255,255,.14);--hd:#fff}
.s-light{background:#fff;color:var(--ink);--tx:var(--text);--ln:var(--line);--cd:var(--soft);--cdb:var(--line);--hd:var(--ink)}
.s-soft{background:var(--soft);color:var(--ink);--tx:var(--text);--ln:var(--line);--cd:#fff;--cdb:var(--line);--hd:var(--ink)}
/* fondos con vida */
.bg{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.blob{position:absolute;border-radius:50%;filter:blur(70px);opacity:.55;animation:float 14s ease-in-out infinite}
.blob.a{width:520px;height:520px;right:-120px;top:-160px;background:rgba(var(--tl-rgb),.55)}
.blob.b{width:420px;height:420px;left:-140px;bottom:-200px;background:rgba(var(--pr-rgb),.5);animation-delay:-6s}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:64px 64px;mask-image:radial-gradient(ellipse at 70% 30%,#000,transparent 70%);-webkit-mask-image:radial-gradient(ellipse at 70% 30%,#000,transparent 70%)}
@keyframes float{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-30px,24px) scale(1.08)}}
.content{position:relative;z-index:1;height:100%}
.eyebrow{font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--teal-l);margin-bottom:18px}
.s-light .eyebrow,.s-soft .eyebrow{color:var(--teal)}
h1,h2{font-weight:600;letter-spacing:-.035em;line-height:1.05;color:var(--hd)}
h1{font-size:72px;max-width:900px}
h2{font-size:54px;max-width:1040px}
h1 em,h2 em{font-style:normal;color:var(--teal-l)}
.s-light h2 em,.s-soft h2 em{color:var(--teal)}
.lead{margin-top:22px;font-size:22px;line-height:1.55;color:var(--tx);max-width:860px}
/* arriba / abajo */
.top{position:absolute;left:0;right:0;top:0;height:64px;z-index:6;display:flex;align-items:center;justify-content:space-between;padding:0 40px;color:#fff;transition:color .4s}
.deck[data-tt=light] .top{color:var(--ink)}
.deck[data-tt=light] .bw,.deck[data-tt=dark] .bc{display:none}
.top .brand img{height:26px;display:block}.top .brand .wm{font-weight:700;font-size:18px;letter-spacing:-.02em}
.top .r{display:flex;align-items:center;gap:18px;font-size:13px;font-weight:500}
.cnt b{font-weight:600}.cnt i{font-style:normal;opacity:.55}
.btn-fs{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-color:color-mix(in srgb,currentColor 35%,transparent);border-radius:999px;padding:7px 14px;cursor:pointer;transition:background .2s}
.btn-fs:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.bar{position:absolute;left:0;top:0;height:3px;background:linear-gradient(90deg,var(--teal),var(--teal-l));z-index:7;transition:width .5s ease}
.nav{position:absolute;left:0;right:0;bottom:0;height:56px;z-index:6;display:flex;align-items:center;justify-content:center;gap:10px;color:#fff;transition:color .4s}
.deck[data-th=light] .nav{color:var(--ink)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.28;border:0;cursor:pointer;transition:all .3s;padding:0}
.dot.on{opacity:1;width:26px;border-radius:99px;background:var(--teal-l)}
.deck[data-th=light] .dot.on{background:var(--teal)}
.arr{position:absolute;top:50%;margin-top:-22px;width:44px;height:44px;border-radius:50%;border:1px solid currentColor;border-color:color-mix(in srgb,currentColor 30%,transparent);background:transparent;color:#fff;cursor:pointer;z-index:6;font-size:18px;transition:all .25s;opacity:.0}
.stage:hover .arr{opacity:.8}.arr:hover{opacity:1!important;background:color-mix(in srgb,currentColor 14%,transparent)}
.deck[data-th=light] .arr{color:var(--ink)}
.arr.l{left:18px}.arr.r{right:18px}
/* revelado */
.rv{opacity:0;transform:translateY(22px)}
.slide.on .rv{animation:rv .8s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--d,0)*90ms + 160ms)}
@keyframes rv{to{opacity:1;transform:none}}
/* fotos */
.bgph{position:absolute;inset:0;z-index:0;background-size:cover;background-position:center;background-color:var(--navy);transform:scale(1.08);transition:transform 10s ease-out}
.slide.on .bgph{transform:scale(1)}
.bgph:after{content:"";position:absolute;inset:0;background:var(--ov)}
.pic{position:absolute;right:92px;top:92px;width:330px;height:134px;border-radius:22px;overflow:hidden;box-shadow:0 26px 60px rgba(15,23,42,.24);z-index:1}
.pic i{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.1);transition:transform 7s ease-out}
.slide.on .pic i{transform:scale(1)}
.pic:after{content:"";position:absolute;inset:0;background:linear-gradient(160deg,rgba(var(--tl-rgb),.22),rgba(11,18,32,.5))}
.pic em{position:absolute;left:16px;bottom:13px;z-index:2;font-style:normal;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#fff}
.hasp h2{font-size:46px;max-width:740px}
.rp.dk{position:relative;overflow:hidden}
.rp.dk>*{position:relative;z-index:1}
.rp .rpph{position:absolute;inset:0;z-index:0;background-size:cover;background-position:center;transform:scale(1.08);transition:transform 9s ease-out}
.slide.on .rp .rpph{transform:scale(1)}
.rp .rpph:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(var(--dk-rgb),.78),rgba(var(--dk-rgb),.94))}
.cover .art.nophoto{height:520px}
.cover .for{display:none}
/* banda de foto a sangre arriba */
.hero{position:absolute;left:0;right:0;top:0;height:244px;z-index:0;overflow:hidden}
.hero i{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.1);transition:transform 10s ease-out}
.slide.on .hero i{transform:scale(1)}
.hero:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(var(--dk-rgb),.94) 0%,rgba(var(--dk-rgb),.7) 55%,rgba(var(--dk-rgb),.38) 100%)}
.hero b{position:absolute;right:70px;bottom:-34px;z-index:2;font-size:230px;font-weight:600;line-height:1;letter-spacing:-.06em;color:transparent;-webkit-text-stroke:1.5px rgba(255,255,255,.34)}
.hasband .bh{height:152px}
.hasband .bh .eyebrow{color:var(--teal-l)}
.hasband .bh h2{color:#fff;font-size:50px}
.hasband .bh h2 em{color:var(--teal-l)}
/* foto enmarcada alta, a un lado */
.sph{position:absolute;top:92px;bottom:88px;width:380px;border-radius:26px;overflow:hidden;box-shadow:0 30px 70px rgba(15,23,42,.28);z-index:1}
.splitL .sph{left:92px}.splitR .sph{right:92px}
.sph i{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.1);transition:transform 9s ease-out}
.slide.on .sph i{transform:scale(1)}
.sph:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(var(--dk-rgb),.05) 30%,rgba(var(--dk-rgb),.86) 100%)}
.sph em{position:absolute;left:30px;right:30px;bottom:30px;z-index:2;font-style:normal;font-size:44px;font-weight:600;line-height:1.02;letter-spacing:-.04em;color:#fff}
.sph em small{display:block;margin-bottom:12px;font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--teal-l)}
.splitL .content{margin-left:430px}
.splitR .content{margin-right:430px}
.splitL .ag{grid-template-columns:1fr;gap:0;margin-top:12px}.splitL .eyebrow{margin-bottom:12px}
.splitL .agi{padding:8px 0;grid-template-columns:50px 1fr 22px}.splitL .agi .n{font-size:22px}
.splitL .agi h3{font-size:18px}.splitL .agi p{font-size:12.5px;margin-top:1px;line-height:1.3}
.splitL h2,.splitR h2{font-size:46px}
.splitR .lead{font-size:18px;max-width:none;margin-top:18px}
.splitR .cards{gap:14px}.splitR .card{padding:20px 20px 18px}
.splitR .card h3{font-size:20px;margin-top:12px}.splitR .card p{font-size:14.5px}
.hasband .c4{gap:16px}.hasband .c4 .card{padding:20px 22px 18px}
.hasband .c4 .card .n{font-size:32px}.hasband .c4 .card h3{margin-top:12px;font-size:20px}
.hasband .c4 .card p{margin-top:9px;font-size:14.5px;line-height:1.5}
.hasband .c4 .out{margin-top:12px;padding-top:10px}.hasband .c4 .out b{font-size:14px;line-height:1.3}
.hasband .dl{margin-top:30px;gap:14px}.hasband .dl div{min-height:92px;padding:16px 22px}
.tl .st .bn{display:none;position:absolute;right:26px;top:34px;font-size:120px;font-weight:600;line-height:1;letter-spacing:-.06em;color:transparent;-webkit-text-stroke:1.5px rgba(255,255,255,.2)}
.cover h1{font-size:82px;line-height:1}
/* portada (rediseño) */
.cover .content{display:block}
.cover .cl{position:absolute;left:0;top:0;bottom:142px;width:720px;display:flex;flex-direction:column;justify-content:center}
.cover .eyebrow{display:flex;align-items:center;gap:14px;margin-bottom:26px}
.cover .eyebrow:before{content:"";width:44px;height:2px;background:var(--teal-l)}
.cover h1{font-size:86px;line-height:.97;letter-spacing:-.05em;max-width:720px}
.cover h1.long{font-size:72px}
.cover .sub{margin-top:24px;font-size:18px;line-height:1.6;max-width:540px;color:rgba(255,255,255,.8)}
.cover .ph3{position:absolute;right:0;top:34px;width:286px;display:grid;gap:12px}
.cover .ph3>div{display:grid;grid-template-columns:54px 1fr;align-items:center;padding:16px 20px;background:rgba(10,16,30,.34);border:1px solid rgba(255,255,255,.2);border-radius:18px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.cover .ph3 i{font-style:normal;font-size:30px;font-weight:300;letter-spacing:-.04em;color:var(--teal-l)}
.cover .ph3 b{display:block;font-size:19px;font-weight:600;letter-spacing:-.02em}
.cover .ph3 small{display:block;margin-top:2px;font-size:12.5px;color:rgba(255,255,255,.7)}
.cover .strip{position:absolute;left:0;right:0;bottom:4px;display:grid;grid-template-columns:1fr 1.15fr .95fr;background:rgba(8,13,24,.42);border:1px solid rgba(255,255,255,.18);border-radius:20px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.cover .strip>div{padding:18px 28px;border-left:1px solid rgba(255,255,255,.14)}
.cover .strip>div:first-child{border-left:0}
.cover .strip small{display:block;margin-bottom:7px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.55)}
.cover .strip b{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;font-size:17px;font-weight:600;letter-spacing:-.01em}
.cover .strip b span{flex-basis:100%;margin-top:-1px;font-size:14px;font-weight:500;color:var(--teal-l)}
.cover .strip b img{height:26px;max-width:110px;object-fit:contain;background:#fff;padding:4px 8px;border-radius:7px}
/* portada */

.cover .for{position:absolute;right:0;top:-34px;text-align:right;font-size:12px;color:rgba(255,255,255,.65);letter-spacing:.06em;text-transform:uppercase}
.cover .for b{display:block;margin-top:6px;font-size:15px;letter-spacing:.02em;text-transform:none;color:#fff;font-weight:600}
.cover .for img{display:block;margin:8px 0 0 auto;max-height:44px;max-width:180px;object-fit:contain;background:#fff;padding:8px 12px;border-radius:8px}
.cover .sub{margin-top:24px;font-size:20px;line-height:1.55;color:rgba(255,255,255,.78);max-width:640px}
.meta{margin-top:40px;display:flex;gap:44px;border-top:1px solid var(--ln);padding-top:22px}
.meta div small{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:6px}
.meta div b{font-size:16px;font-weight:600;line-height:1.35}.meta div span{color:var(--teal-l)}
.art{position:relative;height:520px}
.art svg{position:absolute;inset:0;width:100%;height:100%}
.art .photo{position:absolute;inset:0;border-radius:28px;background-size:cover;background-position:center;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.art .photo:after{content:"";position:absolute;inset:0;border-radius:28px;background:linear-gradient(160deg,rgba(var(--tl-rgb),.18),rgba(11,18,32,.45))}
.chipf{position:absolute;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:14px;padding:12px 16px;font-size:13px;color:#fff;animation:float 9s ease-in-out infinite}
.chipf b{display:block;font-size:22px;font-weight:600;letter-spacing:-.02em}
/* portada editorial */
.cover.ed{background:#F1EEE7}
.cover.ed .content{display:flex;flex-direction:column;justify-content:space-between;margin-right:470px;height:100%}
.edph{position:absolute;right:0;top:0;bottom:0;width:470px;overflow:hidden;z-index:0;background:var(--navy)}
.edph>i{position:absolute;inset:0;background-size:cover;background-position:62% center;transform:scale(1.1);transition:transform 10s ease-out}
.slide.on .edph>i{transform:scale(1)}
.edph:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(var(--dk-rgb),.35) 0%,rgba(var(--dk-rgb),.05) 30%,rgba(var(--dk-rgb),.88) 100%),linear-gradient(135deg,rgba(var(--tl-rgb),.2),transparent 60%)}
.edph .edsvg{position:absolute;inset:60px 40px}
.edl{position:absolute;left:40px;right:40px;bottom:48px;z-index:2;list-style:none;display:grid;gap:0}
.edl li{display:grid;grid-template-columns:44px 1fr auto;align-items:baseline;padding:11px 0;border-top:1px solid rgba(255,255,255,.28);color:#fff}
.edl i{font-style:normal;font-size:13px;font-weight:600;letter-spacing:.08em;color:var(--teal-l)}
.edl b{font-size:19px;font-weight:600;letter-spacing:-.02em}
.edl span{font-size:12.5px;color:rgba(255,255,255,.72)}
.edv{position:absolute;right:20px;top:50%;z-index:2;transform:translateY(-50%) rotate(180deg);writing-mode:vertical-rl;font-size:10.5px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:rgba(255,255,255,.7)}
.cover.ed .badge{position:absolute;left:733px;bottom:156px;width:142px;height:142px;z-index:3;filter:drop-shadow(0 14px 30px rgba(var(--pr-rgb),.45))}
.cover.ed .badge .spin{transform-origin:80px 80px;animation:spin 22s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.edt{display:flex;justify-content:space-between;padding-top:6px;border-top:1.5px solid var(--ink);font-size:11.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--ink)}
.edt span{padding-top:10px}
.edm{margin-top:-6px}
.cover.ed h1{font-size:94px;line-height:.93;letter-spacing:-.05em;max-width:none;color:var(--ink)}
.cover.ed h1.long{font-size:74px}
.cover.ed h1 em{font-style:normal;color:var(--teal)}
.cover.ed .sub{margin-top:26px;max-width:520px;font-size:17px;line-height:1.6;color:var(--text)}
.edb{display:grid;grid-template-columns:1fr 1.15fr 1fr;border-top:1px solid var(--ink)}
.edb>div{padding:16px 22px 0 0}
.edb small{display:block;margin-bottom:6px;font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.edb b{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:16.5px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.edb b span{flex-basis:100%;font-size:13.5px;font-weight:500;color:var(--teal)}
.edb b img{height:54px;max-width:250px;object-fit:contain;object-position:left center;margin-top:-4px}.edb b img.cl-blanco{background:var(--navy);padding:9px 16px;border-radius:10px;height:56px;box-sizing:border-box;margin-top:0}
.deck[data-cv="1"] .top .r{color:#fff}
/* agenda */
.ag{margin-top:34px;display:grid;grid-template-columns:1fr 1fr;gap:0 56px}
.agi{display:grid;grid-template-columns:58px 1fr 22px;align-items:center;gap:6px;padding:22px 0;border-bottom:1px solid var(--ln);cursor:pointer;transition:padding .3s}
.agi:hover{padding-left:12px}
.agi .n{font-size:26px;font-weight:300;color:var(--teal);letter-spacing:-.03em}
.agi h3{font-size:21px;font-weight:600;letter-spacing:-.02em}.agi p{font-size:14.5px;color:var(--tx);margin-top:3px;line-height:1.4}
.agi .go{color:var(--teal);opacity:0;transition:opacity .3s}.agi:hover .go{opacity:1}
/* tarjetas */
.cards{display:grid;gap:20px;margin-top:34px}
.c4{grid-template-columns:repeat(4,1fr)}.c3{grid-template-columns:repeat(3,1fr)}.c2{grid-template-columns:1fr 1fr}
.card{background:var(--cd);border:1px solid var(--cdb);border-radius:20px;padding:26px 26px 22px;transition:transform .35s,box-shadow .35s,border-color .35s}
.card:hover{transform:translateY(-6px);box-shadow:0 18px 40px rgba(15,23,42,.12);border-color:var(--teal)}
.s-dark .card:hover{box-shadow:0 18px 40px rgba(0,0,0,.4)}
.card .n{font-size:40px;font-weight:300;letter-spacing:-.04em;color:var(--teal-l);line-height:1}.s-light .card .n,.s-soft .card .n{color:var(--teal)}
.card h3{margin-top:18px;font-size:22px;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.card p{margin-top:11px;font-size:16px;line-height:1.55;color:var(--tx)}
.out{margin-top:16px;padding-top:12px;border-top:1px solid var(--ln);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--tx)}
.out b{display:block;margin-top:6px;font-size:15px;letter-spacing:0;text-transform:none;color:var(--hd);font-weight:600}
.phase{display:inline-block;margin-top:20px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);background:rgba(var(--pr-rgb),.1);padding:7px 14px;border-radius:99px}
.s-dark .phase{color:var(--teal-l);background:rgba(var(--tl-rgb),.14)}
/* línea de tiempo */
.tl{margin-top:56px;display:grid;grid-template-columns:repeat(3,1fr);gap:0;position:relative}
.tl:before{content:"";position:absolute;left:0;right:0;top:15px;height:2px;background:linear-gradient(90deg,var(--teal-l),rgba(255,255,255,.18))}
.tl .st{position:relative;padding:50px 34px 0 0}
.tl .st:before{content:"";position:absolute;left:0;top:6px;width:20px;height:20px;border-radius:50%;background:var(--navy);border:3px solid var(--teal-l)}
.tl .st small{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--teal-l);font-weight:600}
.tl .st h3{margin-top:12px;font-size:28px;font-weight:600;letter-spacing:-.025em}
.tl .st p{margin-top:12px;font-size:17px;line-height:1.6;color:var(--tx)}
.chips{display:flex;gap:12px;flex-wrap:wrap;margin-top:44px}
.chip{font-size:15px;font-weight:600;padding:10px 20px;border-radius:99px;border:1px solid var(--cdb);background:var(--cd);color:var(--hd)}
/* pasos interactivos */
.stps{margin-top:30px;display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
.stp{background:var(--cd);border:1px solid var(--cdb);border-radius:18px;padding:24px 18px;cursor:pointer;transition:all .35s;position:relative;min-height:160px}
.stp i{font-style:normal;font-size:30px;font-weight:300;color:var(--teal);letter-spacing:-.04em;display:block;line-height:1}
.stp b{display:block;margin-top:16px;font-size:17px;font-weight:600;letter-spacing:-.01em}
.stp:hover{transform:translateY(-4px);border-color:var(--teal)}
.stp.on{background:var(--navy);color:#fff;border-color:var(--navy);transform:translateY(-4px);box-shadow:0 16px 36px rgba(15,23,42,.25)}
.stp.on i{color:var(--teal-l)}
.stdet{margin-top:24px;min-height:100px;background:var(--cd);border:1px solid var(--cdb);border-left:4px solid var(--teal);border-radius:14px;padding:24px 30px;font-size:21px;line-height:1.55;color:var(--hd);transition:opacity .25s}
.stp .d{display:none}
/* portal */
.portal{margin-top:26px;background:#fff;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.45);overflow:hidden;color:var(--ink)}
.portal .tb{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;background:var(--navy);color:#fff;font-size:13px}
.portal .tb .lv{font-size:11px;color:var(--teal-l);display:flex;align-items:center;gap:7px}
.portal .tb .lv:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--teal-l);animation:pulse 1.8s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(var(--tl-rgb),.6)}100%{box-shadow:0 0 0 12px rgba(var(--tl-rgb),0)}}
.tabs{display:flex;gap:4px;padding:10px 16px 0;border-bottom:1px solid var(--line);background:#fff}
.tab{font:inherit;font-size:13.5px;font-weight:600;color:var(--mute);background:none;border:0;padding:10px 16px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .25s}
.tab:hover{color:var(--ink)}.tab.on{color:var(--teal);border-color:var(--teal)}
.pane{display:none;padding:20px 22px 22px;min-height:232px}.pane.on{display:block;animation:rv .5s both}
.kp{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.kp div{border:1px solid var(--line);border-radius:12px;padding:12px 12px 10px}
.kp small{display:block;font-size:10.5px;color:var(--mute);line-height:1.25;height:26px}
.kp b{font-size:26px;font-weight:600;letter-spacing:-.03em}.kp i{display:block;font-style:normal;font-size:11px;color:var(--teal);margin-top:2px}
.kp i.m{color:var(--mute)}
.trend{margin-top:14px;height:84px}
.rows{display:grid;gap:8px}
.rowp{display:grid;grid-template-columns:1.6fr 1fr 1.4fr;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font-size:14px}
.rowp b{font-weight:600}.rowp .tg{font-size:12px;font-weight:600;color:var(--teal);background:rgba(var(--pr-rgb),.1);padding:4px 10px;border-radius:99px;justify-self:start}
.cap{margin-top:10px;font-size:12px;color:rgba(255,255,255,.55)}
/* entregables */
.dl{margin-top:30px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.dl div{background:var(--cd);border:1px solid var(--cdb);border-radius:18px;padding:20px 24px;min-height:108px;display:grid;grid-template-columns:50px 1fr;gap:10px;align-items:start;transition:all .3s}
.dl div:hover{transform:translateY(-4px);border-color:var(--teal)}
.dl b{font-size:28px;font-weight:300;color:var(--teal);letter-spacing:-.03em}.dl span{font-size:17px;line-height:1.5;color:var(--hd)}
/* responsabilidades */
.two{margin-top:34px;display:grid;grid-template-columns:1fr 1.15fr;gap:22px}
.rp{border-radius:22px;padding:38px 40px}
.rp.dk{background:var(--navy);color:#fff}.rp.lt{background:var(--cd);border:1px solid var(--cdb)}
.rp .k{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--teal-l);font-weight:600}.rp.lt .k{color:var(--teal)}
.rp p{margin-top:18px;font-size:21px;line-height:1.6;color:rgba(255,255,255,.85)}
.rp ul{list-style:none;margin-top:14px}.rp li{position:relative;padding:13px 0 13px 28px;font-size:18px;line-height:1.45;border-bottom:1px solid var(--ln)}
.rp li:last-child{border-bottom:0}.rp li:before{content:"";position:absolute;left:2px;top:21px;width:9px;height:9px;border-radius:50%;background:var(--teal)}
/* empresas */
.refs{margin-top:26px;display:grid;grid-template-columns:repeat(2,1fr);gap:26px}
.ref{background:#fff;border:1px solid var(--line);border-radius:24px;padding:26px 34px;display:flex;flex-direction:column;transition:all .35s}
.ref:hover{transform:translateY(-8px);box-shadow:0 22px 50px rgba(15,23,42,.14);border-color:var(--teal)}
.ref .rl{height:112px;border-radius:14px;background:var(--soft);display:flex;align-items:center;justify-content:center;padding:14px}
.ref .rl img{max-width:100%;max-height:76px;object-fit:contain}.ref .rl span{font-size:42px;font-weight:600;color:var(--teal)}
.ref h3{margin-top:20px;font-size:30px;font-weight:600;letter-spacing:-.025em}
.ref .rk{margin-top:7px;font-size:15.5px;font-weight:600;color:var(--teal);text-decoration:none}
.ref p{margin-top:14px;font-size:18px;line-height:1.6;color:var(--text)}
/* alcance */
.terms{margin-top:22px;display:grid;grid-template-columns:1fr 1fr;gap:22px}
.terms>div{border-radius:20px;padding:22px 30px}.terms .in{background:var(--navy);color:#fff}.terms .ex{background:#fff;border:1px solid var(--line)}
.terms h3{font-size:12px;letter-spacing:.1em;text-transform:uppercase;font-weight:600;color:var(--teal-l)}.terms .ex h3{color:var(--mute)}
.terms ul{list-style:none;margin-top:12px}.terms li{position:relative;padding:7px 0 7px 26px;font-size:15.5px;line-height:1.4}
.terms .in li:before{content:"✓";position:absolute;left:0;color:var(--teal-l);font-weight:700}.terms .ex li:before{content:"–";position:absolute;left:3px;color:var(--mute);font-weight:700}
.disc{margin-top:16px;font-size:12.5px;line-height:1.5;color:var(--text);max-width:980px}
/* inversión */
.inv{margin-top:30px;display:grid;grid-template-columns:1.1fr .9fr;gap:26px;align-items:stretch}
.sim{background:var(--cd);border:1px solid var(--cdb);border-radius:24px;padding:34px 38px}
.sim .k{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--teal-l);font-weight:600}
.sim .tot{margin-top:10px;font-size:84px;font-weight:300;letter-spacing:-.05em;line-height:1;color:#fff}
.sim .tot small{font-size:24px;letter-spacing:0;color:var(--tx);margin-left:10px;font-weight:400}
.sim .eq{margin-top:12px;font-size:15px;color:var(--tx)}
.sim input[type=range]{width:100%;margin-top:30px;accent-color:var(--teal-l);height:6px}
.sim .scale{position:relative;height:18px;margin-top:8px;font-size:12px;color:var(--tx)}
.sim .scale span{position:absolute;top:0;transform:translateX(-50%);left:calc(8px + (100% - 16px) * var(--f));white-space:nowrap}
.sim .scale span:last-child{transform:translateX(-85%)}
.sim .rec{margin-top:16px;font-size:13px;color:var(--teal-l)}
.sim .cur{margin-top:10px;font-size:20px;font-weight:600}
.facts{display:grid;gap:14px}
.facts>div{background:var(--cd);border:1px solid var(--cdb);border-radius:20px;padding:22px 26px}
.facts small{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--teal-l);font-weight:600}
.facts b{display:block;margin-top:8px;font-size:26px;font-weight:600;letter-spacing:-.025em}
.facts p{margin-top:6px;font-size:13.5px;color:var(--tx);line-height:1.5}
/* cierre */
.close .content{display:grid;grid-template-columns:1.2fr .8fr;gap:50px;align-items:center}
.cta{display:inline-flex;align-items:center;gap:10px;margin-top:34px;font-size:18px;font-weight:600;color:#06251F;background:linear-gradient(135deg,var(--teal-l),var(--teal));padding:18px 32px;border-radius:99px;text-decoration:none;transition:transform .3s,box-shadow .3s;box-shadow:0 14px 40px rgba(var(--tl-rgb),.35)}
.cta:hover{transform:translateY(-3px);box-shadow:0 20px 50px rgba(var(--tl-rgb),.5)}
.steps{display:grid;gap:14px}
.steps div{display:grid;grid-template-columns:50px 1fr;gap:14px;align-items:center;background:var(--cd);border:1px solid var(--cdb);border-radius:18px;padding:18px 22px;font-size:16px;line-height:1.45}
.steps i{font-style:normal;font-size:28px;font-weight:300;color:var(--teal-l);letter-spacing:-.03em}
.foot{position:absolute;left:92px;right:92px;bottom:70px;display:flex;justify-content:space-between;font-size:12.5px;color:rgba(255,255,255,.5);border-top:1px solid var(--ln);padding-top:14px;z-index:1}
.hint{display:none}
@media (orientation:portrait) and (max-width:700px){.hint{display:block;position:fixed;left:0;right:0;top:0;padding:8px;text-align:center;font-size:12px;background:#000;color:#fff;z-index:99}}
@media (prefers-reduced-motion:reduce){.blob,.chipf{animation:none}.slide{transition:opacity .2s}.slide.on .rv{animation:none;opacity:1;transform:none}.rv{opacity:1;transform:none}}
@media print{
  @page{size:1280px 720px;margin:0}
  html,body{background:#fff;overflow:visible;height:auto;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .deck{position:static;overflow:visible;background:none}
  .stage{position:static;width:1280px;height:auto;margin:0;transform:none!important;box-shadow:none;overflow:visible}
  .slide{position:relative!important;inset:auto!important;width:1280px;height:720px;opacity:1!important;visibility:visible!important;transform:none!important;transition:none!important;break-after:page;page-break-after:always;break-inside:avoid}
  .slide:last-of-type{break-after:auto;page-break-after:auto}
  .top,.nav,.arr,.bar,.hint,.btn-fs{display:none!important}
  .rv{opacity:1!important;transform:none!important;animation:none!important}
  .blob,.chipf{animation:none!important}
  .bgph,.pic i,.sph i,.hero i,.rp .rpph,.edph>i{transform:none!important;transition:none!important}
  .cover.ed .badge .spin{animation:none!important}
  .stp .d{display:none}
  .pane{display:none!important}.pane.on{display:block!important}
}
`;

const JS = `
(function(){
  var deck=document.getElementById('deck'),st=document.getElementById('stage'),sl=[].slice.call(document.querySelectorAll('.slide')),n=sl.length,i=0,bar=document.getElementById('bar'),cur=document.getElementById('cur'),dots=[].slice.call(document.querySelectorAll('.dot'));
  function fit(){var s=Math.min(innerWidth/1280,innerHeight/720);st.style.transform='scale('+s+')';}
  function count(el){var t=parseFloat(el.getAttribute('data-count')),suf=el.getAttribute('data-suf')||'',t0=null,dur=1100;function f(ts){if(t0===null)t0=ts;var k=Math.min(1,(ts-t0)/dur),e=1-Math.pow(1-k,3);el.textContent=Math.round(t*e)+suf;if(k<1)requestAnimationFrame(f);}requestAnimationFrame(f);}
  function go(k,nohash){k=Math.max(0,Math.min(n-1,k));sl.forEach(function(s,j){s.classList.toggle('on',j===k);s.classList.toggle('before',j<k);});i=k;
    deck.setAttribute('data-th',sl[k].getAttribute('data-th')||'dark');deck.setAttribute('data-cv',sl[k].getAttribute('data-cv')||'');deck.setAttribute('data-tt',sl[k].getAttribute('data-tt')||sl[k].getAttribute('data-th')||'dark');
    bar.style.width=((k+1)/n*100)+'%';cur.textContent=('0'+(k+1)).slice(-2);dots.forEach(function(d,j){d.classList.toggle('on',j===k);});
    [].slice.call(sl[k].querySelectorAll('[data-count]')).forEach(count);
    if(!nohash){try{history.replaceState(null,'','#'+(k+1));}catch(e){}}}
  window.go=go;
  document.addEventListener('keydown',function(e){var k=e.key;
    if(k==='ArrowRight'||k==='ArrowDown'||k==='PageDown'||k===' '){e.preventDefault();go(i+1);}
    else if(k==='ArrowLeft'||k==='ArrowUp'||k==='PageUp'){e.preventDefault();go(i-1);}
    else if(k==='Home'){go(0);}else if(k==='End'){go(n-1);}
    else if(k==='f'||k==='F'){fs();}});
  function fs(){var d=document.documentElement;function ask(){try{parent.postMessage({deckFs:1},'*');}catch(e){}}try{if(document.fullscreenElement){document.exitFullscreen();}else if(parent!==window){ask();}else if(d.requestFullscreen){var r=d.requestFullscreen();if(r&&r.catch)r.catch(function(){});}}catch(e){ask();}}
  var b=document.getElementById('fs');if(b)b.addEventListener('click',fs);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&parent!==window){try{parent.postMessage({deckFs:2},'*');}catch(x){}}});
  document.getElementById('prev').addEventListener('click',function(){go(i-1);});document.getElementById('next').addEventListener('click',function(){go(i+1);});
  dots.forEach(function(d,j){d.addEventListener('click',function(){go(j);});});
  var x0=null;document.addEventListener('touchstart',function(e){x0=e.touches[0].clientX;},{passive:true});document.addEventListener('touchend',function(e){if(x0===null)return;var dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>50)go(i+(dx<0?1:-1));x0=null;},{passive:true});
  [].slice.call(document.querySelectorAll('[data-go]')).forEach(function(el){el.addEventListener('click',function(){go(parseInt(el.getAttribute('data-go'),10)-1);});});
  var stps=[].slice.call(document.querySelectorAll('.stp')),det=document.getElementById('stdet');
  function pick(k){stps.forEach(function(s,j){s.classList.toggle('on',j===k);});if(det){det.style.opacity=0;setTimeout(function(){det.textContent=stps[k].querySelector('.d').textContent;det.style.opacity=1;},160);}}
  stps.forEach(function(s,j){s.addEventListener('click',function(){pick(j);});});if(stps.length&&det){det.textContent=stps[0].querySelector('.d').textContent;stps[0].classList.add('on');}
  var tabs=[].slice.call(document.querySelectorAll('.tab')),panes=[].slice.call(document.querySelectorAll('.pane'));
  tabs.forEach(function(t){t.addEventListener('click',function(){var k=t.getAttribute('data-t');tabs.forEach(function(x){x.classList.toggle('on',x===t);});panes.forEach(function(p){p.classList.toggle('on',p.getAttribute('data-p')===k);});[].slice.call(document.querySelectorAll('.pane.on [data-count]')).forEach(count);});});
  var r=document.getElementById('sim');
  if(r){var fee=parseFloat(r.getAttribute('data-fee')),sym=r.getAttribute('data-sym'),rec=parseInt(r.getAttribute('data-rec'),10);
    var fm=function(v){return String(Math.round(v)).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');};
    var upd=function(){var m=parseInt(r.value,10);document.getElementById('simTot').firstChild.nodeValue=sym+fm(fee*m);document.getElementById('simN').textContent=m;document.getElementById('simEq').textContent=sym+fm(fee)+' × '+m;document.getElementById('simRec').style.visibility=(m===rec)?'visible':'hidden';};
    r.addEventListener('input',upd);upd();}
  window.addEventListener('resize',fit);fit();
  var h=parseInt((location.hash||'').replace('#',''),10);go(isNaN(h)?0:h-1,true);
})();
`;

function render(brand, p, lang) {
  const li = IDX[lang] != null ? IDX[lang] : 0;
  const x = (...a) => (a[li] != null ? a[li] : a[0]);
  const b = brand || {};
  const prim = hex(b.color_primary, '#0F9F8F'), light = hex(b.color_light, '#2DD4BF'), dark = hex(b.color_dark, '#0F172A');
  const marca = b.nombre || 'Mi empresa';
  const web = (b.web || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const mail = b.email || '';
  const empresa = p.empresa || 'Cliente';
  const cn = p.empresa ? esc(String(p.empresa).trim().slice(0, 40)) : '';   // nombre del cliente, para personalizar la presentación
  const xp = (g, e) => (cn ? x(...e.map(t => t.split('{c}').join(cn))) : x(...g));   // g: texto genérico, e: texto con {c} = cliente
  const contacto = p.contacto || '';
  const sym = p.moneda || 'US$';
  const fee = Math.max(0, parseInt(p.fee, 10) || 0);
  const meses = Math.max(1, parseInt(p.plazo, 10) || 3);
  const clLogo = p.logoCliente && typeof p.logoCliente === 'object' && imgOk(p.logoCliente[p.logoCliente.usar]) ? p.logoCliente[p.logoCliente.usar] : '';
  const feeNum = sym + money(fee);
  const modeloTxt = p.modelo ? esc(p.modelo) : x('Fee fijo + comisiones', 'Fixed fee + commissions', 'Fixhonorar + Provisionen', 'Fee fixo + comissões');
  const notaPago = p.nota ? esc(p.nota) : x('Pago al inicio de cada periodo.', 'Paid at the start of each period.', 'Zahlung zu Beginn jeder Periode.', 'Pagamento no início de cada período.');
  const feeMes = feeNum + ' ' + x('/ mes', '/ month', '/ Monat', '/ mês');
  const mesesTxt = meses + ' ' + (meses === 1 ? x('mes', 'month', 'Monat', 'mês') : x('meses', 'months', 'Monate', 'meses'));
  const foto = imgOk(p.fotoPortada) ? p.fotoPortada : '';
  const simulador = p.simulador !== false;

  const logos = { blanco: b.logo_white, negro: b.logo_black, color: b.logo_color };
  const pick = (elegido, orden) => { for (const k of [elegido, ...orden]) if (imgOk(logos[k])) return logos[k]; return ''; };
  const dataW = pick(b.logo_oscuro || 'blanco', ['blanco', 'color', 'negro']);
  const dataC = pick(b.logo_claro || 'color', ['color', 'negro', 'blanco']);
  const brandW = dataW ? `<img alt="${esc(marca)}" src="${dataW}">` : `<span class="wm">${esc(marca)}</span>`;
  const brandC = dataC ? `<img alt="${esc(marca)}" src="${dataC}">` : `<span class="wm">${esc(marca)}</span>`;

  const titulo = p.servicio
    ? `${esc(p.servicio)} <em>${esc(p.servicioEm || '')}</em>`
    : x('Sistema de Adquisición <em>Comercial B2B</em>', 'B2B Commercial <em>Acquisition System</em>', 'B2B-<em>Vertriebssystem</em>', 'Sistema de Aquisição <em>Comercial B2B</em>');
  const subj = x('Inicio del Servicio Comercial B2B', 'Start of the B2B Commercial Service', 'Start der B2B-Vertriebsdienstleistung', 'Início do Serviço Comercial B2B');
  const body = x(
    'Hola,\n\nQuiero iniciar el servicio comercial.\n\nPor favor indíquenme la información necesaria para comenzar.\n\nQuedo atento a los siguientes pasos.\n\nSaludos,\n',
    'Hello,\n\nI would like to start the commercial service.\n\nPlease let me know what information you need to get started.\n\nLooking forward to the next steps.\n\nBest regards,\n',
    'Guten Tag,\n\nich möchte die Vertriebsdienstleistung starten.\n\nBitte teilen Sie mir mit, welche Informationen Sie zum Start benötigen.\n\nIch freue mich auf die nächsten Schritte.\n\nMit freundlichen Grüßen\n',
    'Olá,\n\nQuero iniciar o serviço comercial.\n\nPor favor, indiquem-me as informações necessárias para começar.\n\nAguardo os próximos passos.\n\nAtenciosamente,\n'
  ) + contacto + (p.correo ? '\n' + p.correo : '');
  const mailto = mail ? `mailto:${encodeURIComponent(mail).replace(/%40/g, '@')}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}` : '#';

  const refs = Array.isArray(p.referencias) ? p.referencias.filter(r => r && (r.nombre || imgOk(r.logo))).slice(0, 12) : [];
  const nRef = refs.length ? Math.ceil(refs.length / 2) : 0;   // 2 empresas por diapositiva

  // ── textos ──
  const T = {
    agenda: [
      [x('Lo primero que haremos', 'What we will do first', 'Das machen wir zuerst', 'O que faremos primeiro'), x('Investigación comercial para validar la oferta y el mercado real.', 'Commercial research to validate the offer and the real market.', 'Marktrecherche, um Angebot und Markt zu validieren.', 'Pesquisa comercial para validar a oferta e o mercado real.')],
      [x('Del primer mensaje a la optimización', 'From the first message to optimization', 'Von der ersten Nachricht zur Optimierung', 'Da primeira mensagem à otimização'), x('Semanas 2–3 inicio del contacto; desde la semana 4, optimización.', 'Weeks 2–3 outreach start; from week 4, optimization.', 'Wochen 2–3 Beginn der Ansprache; ab Woche 4 Optimierung.', 'Semanas 2–3 início do contato; a partir da semana 4, otimização.')],
      [x('Una secuencia coordinada', 'A coordinated sequence', 'Eine koordinierte Sequenz', 'Uma sequência coordenada'), x('Cómo se trabaja cada cuenta y cómo mejoramos cada mes.', 'How each account is worked and how we improve every month.', 'Wie jeder Account bearbeitet wird und wie wir uns jeden Monat verbessern.', 'Como cada conta é trabalhada e como melhoramos a cada mês.')],
      [x('Tu portal en vivo', 'Your live portal', 'Ihr Live-Portal', 'Seu portal ao vivo'), x('Visibilidad permanente de actividad, respuestas y oportunidades.', 'Permanent visibility of activity, replies and opportunities.', 'Dauerhafte Sicht auf Aktivität, Antworten und Opportunities.', 'Visibilidade permanente da atividade, respostas e oportunidades.')],
      [x('Qué recibes y quién hace qué', 'What you receive and who does what', 'Was Sie erhalten und wer was tut', 'O que você recebe e quem faz o quê'), x('Entregables y responsabilidades de cada parte.', 'Deliverables and responsibilities of each party.', 'Ergebnisse und Verantwortlichkeiten jeder Partei.', 'Entregáveis e responsabilidades de cada parte.')],
    ],
  };
  if (refs.length) T.agenda.push([x('Trabajos destacados', 'Featured work', 'Ausgewählte Projekte', 'Trabalhos em destaque'), x('Algunos de nuestros clientes y lo que logramos junto a ellos.', 'Some of our clients and what we achieved together.', 'Einige unserer Kunden und was wir gemeinsam erreicht haben.', 'Alguns dos nossos clientes e o que conquistamos juntos.')]);
  T.agenda.push([x('Alcance e inversión', 'Scope and investment', 'Umfang und Investition', 'Escopo e investimento'), x('Qué incluye, qué no, y cuánto cuesta.', 'What is included, what is not, and the cost.', 'Was enthalten ist, was nicht, und was es kostet.', 'O que inclui, o que não, e quanto custa.')]);
  T.agenda.push([x('Próximo paso', 'Next step', 'Nächster Schritt', 'Próximo passo'), x('Cómo iniciamos.', 'How we get started.', 'So legen wir los.', 'Como iniciamos.')]);

  // número de diapositiva de cada punto de la agenda: 1 portada, 2 agenda, 3 primeros pasos, 4 contacto, 5 secuencia, 6 optimización, 7 portal, 8 entregables, 9 responsabilidades, [empresas], alcance, inversión, cierre
  const slideOf = [3, 4, 5, 7, 8];
  let nxt = 10;
  if (refs.length) { slideOf.push(nxt); nxt += nRef; }
  slideOf.push(nxt);        // alcance (e inversión)
  slideOf.push(nxt + 2);    // próximo paso

  const rs = (n, h, pTxt, res) => `<div class="card rv" style="--d:${n}"><div class="n">${pn(n)}</div><h3>${h}</h3><p>${pTxt}</p><div class="out">${x('Resultado', 'Outcome', 'Ergebnis', 'Resultado')}<b>${res}</b></div></div>`;

  const S = [];   // diapositivas
  const bgDark = `<div class="bg"><div class="blob a"></div><div class="blob b"></div><div class="grid"></div></div>`;
  // fotos de stock (Unsplash, licencia libre) con tratamiento de color de la marca; se apagan desde el generador
  const fotos = p.fotos !== false;
  const U = id => `https://images.unsplash.com/photo-${id}?fm=jpg&fit=crop&w=1600&q=70`;
  const dkr = rgb(dark);
  const ovL = (a, b2) => `linear-gradient(90deg,rgba(${dkr},${a}) 0%,rgba(${dkr},${b2}) 100%)`;
  const ovV = (a, b2) => `linear-gradient(180deg,rgba(${dkr},${a}) 0%,rgba(${dkr},${b2}) 100%)`;
  const bgPh = (url, ov) => `<div class="bgph" style="background-image:url('${url}');--ov:${ov}"></div><div class="bg"><div class="blob a"></div></div>`;
  const bgFoto = (id, ov) => (fotos ? bgPh(U(id), ov) : bgDark);
  const pic = (id, cap) => (fotos ? `<div class="pic rv" style="--d:2"><i style="background-image:url('${U(id)}')"></i><em>${cap}</em></div>` : '');
  const hp = fotos ? ' hasp' : '';
  const sph = (id, small, big) => (fotos ? `<div class="sph rv" style="--d:1"><i style="background-image:url('${U(id)}')"></i><em><small>${small}</small>${big}</em></div>` : '');
  const hero = (id, n) => (fotos ? `<div class="hero"><i style="background-image:url('${U(id)}')"></i><b>${n}</b></div>` : '');
  const ttAttr = fotos ? 'dark' : 'light';

  // 1 · portada
  const artSvg = `<svg viewBox="0 0 400 520" fill="none"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${prim}"/></linearGradient></defs>
<g stroke="url(#g1)" stroke-width="1.4" opacity=".7"><path d="M60 120 L190 70 L330 140 L270 260 L120 240 Z"/><path d="M190 70 L270 260"/><path d="M60 120 L270 260"/><path d="M330 140 L120 240"/><path d="M120 240 L180 400 L300 360 L270 260"/><path d="M180 400 L90 450"/><path d="M300 360 L350 450"/></g>
<g fill="url(#g1)"><circle cx="60" cy="120" r="9"/><circle cx="190" cy="70" r="12"/><circle cx="330" cy="140" r="9"/><circle cx="270" cy="260" r="14"/><circle cx="120" cy="240" r="10"/><circle cx="180" cy="400" r="12"/><circle cx="300" cy="360" r="9"/><circle cx="90" cy="450" r="7"/><circle cx="350" cy="450" r="7"/></g></svg>`;
  const year = new Date().getFullYear();
  const titLen = String(p.servicio || '').length + String(p.servicioEm || '').length;
  const edPhoto = foto || (fotos ? U('1486406146926-c627a92ad1ab') : '');
  const edPh = (n, h, w) => `<li><i>${n}</i><b>${h}</b><span>${w}</span></li>`;
  const badge = `<svg class="badge rv" style="--d:6" viewBox="0 0 160 160"><defs><path id="cp" d="M80,80 m-57,0 a57,57 0 1,1 114,0 a57,57 0 1,1 -114,0"/></defs><circle cx="80" cy="80" r="79" fill="var(--teal)"/><g class="spin"><text font-size="11" font-weight="600" fill="#fff"><textPath href="#cp" textLength="352" lengthAdjust="spacing">${x('INVESTIGACIÓN · LINKEDIN · CORREO · SEGUIMIENTO · ', 'RESEARCH · LINKEDIN · EMAIL · FOLLOW-UP · ', 'RECHERCHE · LINKEDIN · E-MAIL · NACHFASSEN · ', 'PESQUISA · LINKEDIN · E-MAIL · ACOMPANHAMENTO · ')}</textPath></text></g><path d="M58 102L102 58M102 58H72M102 58V88" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  S.push(`<section class="slide cover ed s-light" data-th="light" data-tt="light" data-cv="1"><div class="edph">${edPhoto ? `<i style="background-image:url('${edPhoto}')"></i>` : `<div class="edsvg">${artSvg}</div>`}<ul class="edl">${edPh('01', x('Investigación', 'Research', 'Recherche', 'Pesquisa'), x('Semanas 1–2', 'Weeks 1–2', 'Wochen 1–2', 'Semanas 1–2'))}${edPh('02', x('Contacto', 'Outreach', 'Ansprache', 'Contato'), x('Semanas 2–3', 'Weeks 2–3', 'Wochen 2–3', 'Semanas 2–3'))}${edPh('03', x('Optimización', 'Optimization', 'Optimierung', 'Otimização'), x('Desde la semana 4', 'From week 4', 'Ab Woche 4', 'A partir da semana 4'))}</ul><span class="edv">${esc(marca)} · ${x('Propuesta comercial', 'Commercial proposal', 'Geschäftsangebot', 'Proposta comercial')} · ${year}</span></div>${badge}<div class="content">
<div class="edt rv" style="--d:0"><span>N.º 01</span><span>${xp(['Propuesta comercial', 'Commercial proposal', 'Geschäftsangebot', 'Proposta comercial'], ['Propuesta para {c}', 'Proposal for {c}', 'Angebot für {c}', 'Proposta para {c}'])}</span><span>${year}</span></div>
<div class="edm"><h1 class="rv${titLen > 38 ? ' long' : ''}" style="--d:1">${titulo}</h1>
<p class="sub rv" style="--d:2">${x('Investigación, prospección y ejecución multicanal para generar oportunidades comerciales de forma estructurada, medible y constante.', 'Research, prospecting and multichannel execution to generate sales opportunities in a structured, measurable and consistent way.', 'Recherche, Prospektion und Multichannel-Umsetzung, um Vertriebschancen strukturiert, messbar und kontinuierlich zu erzeugen.', 'Pesquisa, prospecção e execução multicanal para gerar oportunidades comerciais de forma estruturada, mensurável e constante.')}</p></div>
<div class="edb rv" style="--d:4"><div><small>${x('Preparada para', 'Prepared for', 'Erstellt für', 'Preparada para')}</small><b>${clLogo ? `<img class="cl-${esc(p.logoCliente.usar)}" alt="${esc(empresa)}" src="${clLogo}">` : esc(empresa)}</b></div>
<div><small>${x('Contacto', 'Contact', 'Kontakt', 'Contato')}</small><b>${esc(contacto) || '—'}<span>${esc(p.correo || '')}</span></b></div>
<div><small>${x('Inversión', 'Investment', 'Investition', 'Investimento')}</small><b>${feeMes}<span>${esc(p.inicio || x('Inicio por definir', 'Start date to be defined', 'Startdatum offen', 'Início a definir'))}</span></b></div></div>
</div></section>`);

  // 2 · agenda
  S.push(`<section class="slide s-light${fotos ? ' splitL' : ''}" data-th="light">${sph('1522071820081-009f0129c71c', x('Resumen', 'Overview', 'Überblick', 'Resumo'), xp(['Un plan claro, <br>paso a paso', 'A clear plan, <br>step by step', 'Ein klarer Plan, <br>Schritt für Schritt', 'Um plano claro, <br>passo a passo'], ['Un plan a la medida de <br>{c}', 'A plan tailored to <br>{c}', 'Ein Plan, maßgeschneidert für <br>{c}', 'Um plano sob medida para <br>{c}']))}<div class="content"><div class="eyebrow rv">${x('Contenido', 'Contents', 'Inhalt', 'Conteúdo')}</div>
<h2 class="rv" style="--d:1">${x('Lo que vamos a <em>ver.</em>', 'What we are going to <em>cover.</em>', 'Was wir uns <em>ansehen.</em>', 'O que vamos <em>ver.</em>')}</h2>
<div class="ag">${T.agenda.map((r, i) => `<div class="agi rv" style="--d:${i + 2}" data-go="${slideOf[i]}"><span class="n">${pn(i + 1)}</span><div><h3>${r[0]}</h3><p>${r[1]}</p></div><span class="go">→</span></div>`).join('')}</div></div></section>`);

  // 3 · lo primero que haremos
  S.push(`<section class="slide s-soft${fotos ? ' hasband' : ''}" data-th="light" data-tt="${ttAttr}">${hero('1551288049-bebda4e38f71', '01')}<div class="content"><div class="bh"><div class="eyebrow rv">01 · ${x('Semanas 1–2 · Investigación comercial', 'Weeks 1–2 · Commercial research', 'Wochen 1–2 · Marktrecherche', 'Semanas 1–2 · Pesquisa comercial')}</div>
<h2 class="rv" style="--d:1">${x('Lo primero que <em>haremos.</em>', 'What we will do <em>first.</em>', 'Das machen wir <em>zuerst.</em>', 'O que faremos <em>primeiro.</em>')}</h2></div>
<div class="cards c4" style="margin-top:${fotos ? 30 : 28}px">
${rs(1, x('Clarificamos la oferta', 'We clarify the offer', 'Wir schärfen das Angebot', 'Esclarecemos a oferta'), x('Qué servicio impulsar y qué problema resuelve. Si no está clara, te sugerimos por dónde comenzar.', 'Which service to push and what problem it solves. If it is not clear yet, we suggest where to start.', 'Welche Leistung wir vorantreiben und welches Problem sie löst. Ist sie noch unklar, schlagen wir einen Einstieg vor.', 'Qual serviço impulsionar e que problema resolve. Se ainda não estiver claro, sugerimos por onde começar.'), x('Oferta prioritaria e hipótesis comercial', 'Priority offer and commercial hypothesis', 'Prioritäres Angebot und Vertriebshypothese', 'Oferta prioritária e hipótese comercial'))}
${rs(2, x('Definimos a quién nos dirigimos', 'We define who we target', 'Wir definieren die Zielgruppe', 'Definimos a quem nos dirigimos'), x('Sector, tamaño, ubicación y señales de oportunidad, con criterios claros de inclusión y descarte.', 'Industry, size, location and opportunity signals, with clear inclusion and exclusion criteria.', 'Branche, Größe, Standort und Signale, mit klaren Ein- und Ausschlusskriterien.', 'Setor, tamanho, localização e sinais de oportunidade, com critérios claros de inclusão e descarte.'), x('Perfil de cliente ideal (ICP)', 'Ideal customer profile (ICP)', 'Ideales Kundenprofil (ICP)', 'Perfil de cliente ideal (ICP)'))}
${rs(3, x('Dimensionamos el mercado', 'We size the market', 'Wir vermessen den Markt', 'Dimensionamos o mercado'), x('Validamos el universo real con TAM, SAM y SOM: cuántas empresas existen, cuántas encajan y cuántas podemos alcanzar.', 'We validate the real universe with TAM, SAM and SOM: how many companies exist, fit and are reachable.', 'Wir validieren das reale Universum mit TAM, SAM und SOM: wie viele Unternehmen es gibt, passen und erreichbar sind.', 'Validamos o universo real com TAM, SAM e SOM: quantas empresas existem, se encaixam e podemos alcançar.'), x('Universo de mercado validado', 'Validated market universe', 'Validiertes Marktuniversum', 'Universo de mercado validado'))}
${rs(4, x('Investigamos cuentas y decisores', 'We research accounts and decision-makers', 'Wir recherchieren Accounts und Entscheider', 'Pesquisamos contas e decisores'), x('Priorizamos empresas con encaje real, sin duplicados, e identificamos hasta dos cargos por empresa.', 'We prioritize companies with a real fit, without duplicates, and identify up to two roles per company.', 'Wir priorisieren Unternehmen mit echter Passung, ohne Duplikate, und identifizieren bis zu zwei Rollen je Unternehmen.', 'Priorizamos empresas com encaixe real, sem duplicados, e identificamos até dois cargos por empresa.'), x('Base de cuentas y decisores', 'Account and decision-maker base', 'Account- und Entscheiderbasis', 'Base de contas e decisores'))}
</div></div></section>`);

  // 4 · del primer mensaje a la optimización
  S.push(`<section class="slide s-dark" data-th="dark">${bgFoto('1684610529682-553625a1ffed', ovV(.88, .55))}<div class="content"><div class="eyebrow rv">02 · ${x('Cronograma', 'Timeline', 'Zeitplan', 'Cronograma')}</div>
<h2 class="rv" style="--d:1">${x('Del primer mensaje a la <em>optimización.</em>', 'From the first message to <em>optimization.</em>', 'Von der ersten Nachricht zur <em>Optimierung.</em>', 'Da primeira mensagem à <em>otimização.</em>')}</h2>
<div class="tl">
<div class="st rv" style="--d:2"><b class="bn">01</b><small>${x('Semanas 1–2', 'Weeks 1–2', 'Wochen 1–2', 'Semanas 1–2')}</small><h3>${x('Investigación comercial', 'Commercial research', 'Marktrecherche', 'Pesquisa comercial')}</h3><p>${x('Validamos la oferta, el mercado y las cuentas antes de contactar a nadie.', 'We validate the offer, the market and the accounts before contacting anyone.', 'Wir validieren Angebot, Markt und Accounts, bevor wir jemanden kontaktieren.', 'Validamos a oferta, o mercado e as contas antes de contatar alguém.')}</p></div>
<div class="st rv" style="--d:3"><b class="bn">02</b><small>${x('Semanas 2–3', 'Weeks 2–3', 'Wochen 2–3', 'Semanas 2–3')}</small><h3>${x('Inicio del contacto', 'Outreach start', 'Beginn der Ansprache', 'Início do contato')}</h3><p>${x('Lanzamos la secuencia de LinkedIn y correo de forma progresiva, con mensajes basados en lo que validamos.', 'We launch the LinkedIn and email sequence progressively, with messages based on what we validated.', 'Wir starten die LinkedIn- und E-Mail-Sequenz schrittweise, mit Nachrichten auf Basis des Validierten.', 'Lançamos a sequência de LinkedIn e e-mail de forma progressiva, com mensagens baseadas no que validamos.')}</p></div>
<div class="st rv" style="--d:4"><b class="bn">03</b><small>${x('Semana 4 en adelante', 'Week 4 onward', 'Ab Woche 4', 'A partir da semana 4')}</small><h3>${x('Optimización', 'Optimization', 'Optimierung', 'Otimização')}</h3><p>${x('Mejoramos mensajes, segmentos y decisores según las respuestas reales, con evidencia del mercado.', 'We improve messages, segments and decision-makers based on real replies, with market evidence.', 'Wir verbessern Nachrichten, Segmente und Entscheider anhand echter Antworten, mit Marktevidenz.', 'Melhoramos mensagens, segmentos e decisores conforme as respostas reais, com evidência do mercado.')}</p></div></div>
<div class="chips rv" style="--d:5"><span class="chip">LinkedIn</span><span class="chip">${x('Correo electrónico', 'Email', 'E-Mail', 'E-mail')}</span><span class="chip">${x('Seguimiento automático', 'Automated follow-up', 'Automatisches Nachfassen', 'Acompanhamento automático')}</span><span class="chip">${x('Respuestas con contexto', 'Replies with context', 'Antworten mit Kontext', 'Respostas com contexto')}</span></div></div></section>`);

  // 5 · secuencia coordinada (pasos interactivos)
  const stp = (n, h, d) => `<div class="stp rv" style="--d:${n + 1}"><i>${pn(n)}</i><b>${h}</b><span class="d">${d}</span></div>`;
  S.push(`<section class="slide s-light" data-th="light"><div class="content"><div class="eyebrow rv">03 · ${x('Metodología', 'Method', 'Methodik', 'Metodologia')}</div>
<h2 class="rv" style="--d:1">${x('Una secuencia coordinada, <em>no campañas sueltas.</em>', 'A coordinated sequence, <em>not isolated campaigns.</em>', 'Eine koordinierte Sequenz, <em>keine einzelnen Kampagnen.</em>', 'Uma sequência coordenada, <em>não campanhas soltas.</em>')}</h2>
<p class="lead rv" style="--d:2">${x('Cada cuenta sigue un recorrido ordenado y medible. Toca un paso para ver qué pasa.', 'Each account follows an orderly, measurable journey. Tap a step to see what happens.', 'Jeder Account folgt einem geordneten, messbaren Weg. Tippen Sie auf einen Schritt.', 'Cada conta segue um percurso ordenado e mensurável. Toque num passo para ver o que acontece.')}</p>
<div class="stps">
${stp(1, x('Preparación', 'Preparation', 'Vorbereitung', 'Preparação'), x('Prospectos validados e incorporación progresiva, para no saturar a nadie.', 'Validated prospects and progressive onboarding, so nobody is overloaded.', 'Validierte Interessenten, schrittweise aufgenommen, damit niemand überlastet wird.', 'Prospects validados e incorporação progressiva, para não saturar ninguém.'))}
${stp(2, x('Ejecución', 'Execution', 'Umsetzung', 'Execução'), x('Contacto, seguimiento y registro de toda la actividad.', 'Outreach, follow-up and logging of all activity.', 'Ansprache, Nachfassen und Protokoll der gesamten Aktivität.', 'Contato, acompanhamento e registro de toda a atividade.'))}
${stp(3, x('Contexto', 'Context', 'Kontext', 'Contexto'), x('Cuando hay una respuesta, las acciones pendientes se detienen y la conversación sigue con contexto.', 'When a reply arrives, pending actions stop and the conversation continues with context.', 'Bei einer Antwort stoppen offene Aktionen und das Gespräch geht mit Kontext weiter.', 'Quando chega uma resposta, as ações pendentes param e a conversa segue com contexto.'))}
${stp(4, x('Clasificación', 'Classification', 'Klassifizierung', 'Classificação'), x('Respuestas, objeciones, interés y descartes, ordenados.', 'Replies, objections, interest and disqualifications, organized.', 'Antworten, Einwände, Interesse und Absagen, geordnet.', 'Respostas, objeções, interesse e descartes, organizados.'))}
${stp(5, x('Embudo', 'Pipeline', 'Pipeline', 'Funil'), x('Actualización de estado y cambio de decisor cuando hace falta.', 'Status update and decision-maker change when needed.', 'Statusaktualisierung und Entscheiderwechsel bei Bedarf.', 'Atualização de status e troca de decisor quando necessário.'))}
${stp(6, x('Entrega', 'Handover', 'Übergabe', 'Entrega'), x('Oportunidades con historial completo y próxima acción definida.', 'Opportunities with full history and a defined next action.', 'Opportunities mit vollständigem Verlauf und definierter nächster Aktion.', 'Oportunidades com histórico completo e próxima ação definida.'))}
</div><div class="stdet rv" id="stdet" style="--d:8"></div></div></section>`);

  // 6 · optimización continua
  S.push(`<section class="slide s-soft${fotos ? ' splitR' : ''}" data-th="light">${sph('1758518731706-be5d5230e5a5', x('Ciclo mensual', 'Monthly cycle', 'Monatszyklus', 'Ciclo mensal'), x('Cada mes, <br>mejor', 'Better <br>every month', 'Jeden Monat <br>besser', 'A cada mês, <br>melhor'))}<div class="content"><div class="eyebrow rv">03 · ${x('Mejora permanente', 'Ongoing improvement', 'Ständige Verbesserung', 'Melhoria permanente')}</div>
<h2 class="rv" style="--d:1">${x('Optimización <em>continua.</em>', 'Continuous <em>optimization.</em>', 'Laufende <em>Optimierung.</em>', 'Otimização <em>contínua.</em>')}</h2>
<p class="lead rv" style="--d:2">${x('Supervisamos la campaña de forma continua: calidad de empresas, precisión de decisores, aceptaciones de LinkedIn, entregabilidad, respuestas, objeciones y rendimiento de mensajes. Los cambios son progresivos y basados en evidencia.', 'We supervise the campaign continuously: company quality, decision-maker accuracy, LinkedIn acceptances, deliverability, replies, objections and message performance. Changes are progressive and evidence-based.', 'Wir überwachen die Kampagne laufend: Unternehmensqualität, Entscheiderpräzision, LinkedIn-Annahmen, Zustellbarkeit, Antworten, Einwände und Nachrichtenleistung. Änderungen erfolgen schrittweise und evidenzbasiert.', 'Supervisionamos a campanha continuamente: qualidade das empresas, precisão dos decisores, aceitações no LinkedIn, entregabilidade, respostas, objeções e desempenho das mensagens. As mudanças são progressivas e baseadas em evidência.')}</p>
<div class="eyebrow rv" style="--d:3;margin-top:30px">${x('Revisión mensual', 'Monthly review', 'Monatliche Überprüfung', 'Revisão mensal')}</div>
<div class="cards c3" style="margin-top:0">
<div class="card rv" style="--d:4"><div class="n">↗</div><h3>${x('Continuar', 'Continue', 'Fortsetzen', 'Continuar')}</h3><p>${x('Escalar el enfoque que demuestre mejores señales.', 'Scale the approach that shows the best signals.', 'Den Ansatz mit den besten Signalen ausbauen.', 'Escalar a abordagem que mostre melhores sinais.')}</p></div>
<div class="card rv" style="--d:5"><div class="n">⟲</div><h3>${x('Ajustar', 'Adjust', 'Anpassen', 'Ajustar')}</h3><p>${x('Refinar oferta, mercado, decisor o mensaje.', 'Refine the offer, market, decision-maker or message.', 'Angebot, Markt, Entscheider oder Botschaft verfeinern.', 'Refinar oferta, mercado, decisor ou mensagem.')}</p></div>
<div class="card rv" style="--d:6"><div class="n">■</div><h3>${x('Detener', 'Stop', 'Beenden', 'Encerrar')}</h3><p>${x('Descartar una hipótesis con baja afinidad.', 'Drop a hypothesis with low fit.', 'Eine Hypothese mit geringer Passung verwerfen.', 'Descartar uma hipótese com baixa afinidade.')}</p></div></div></div></section>`);

  // 7 · portal en vivo
  const kp = (l, v, d, mute, suf) => `<div><small>${l}</small><b data-count="${v}" data-suf="${suf || ''}">${v}${suf || ''}</b><i${mute ? ' class="m"' : ''}>${d}</i></div>`;
  const est = x('estimada', 'estimated', 'geschätzt', 'estimada'), estp = x('estimado', 'estimated', 'geschätzt', 'estimado');
  const rowp = (a, b2, c) => `<div class="rowp"><b>${a}</b><span class="tg">${b2}</span><span>${c}</span></div>`;
  S.push(`<section class="slide s-dark" data-th="dark">${bgDark}<div class="content"><div class="eyebrow rv">04 · ${x('Seguimiento', 'Tracking', 'Tracking', 'Acompanhamento')}</div>
<h2 class="rv" style="--d:1">${x('Tu operación, <em>visible en vivo.</em>', 'Your operation, <em>visible live.</em>', 'Ihr Geschäft, <em>live sichtbar.</em>', 'Sua operação, <em>visível ao vivo.</em>')}</h2>
<div class="portal rv" style="--d:2"><div class="tb"><span>${esc(marca)} · ${xp(['Portal de seguimiento', 'Tracking portal', 'Tracking-Portal', 'Portal de acompanhamento'], ['Portal de seguimiento · {c}', 'Tracking portal · {c}', 'Tracking-Portal · {c}', 'Portal de acompanhamento · {c}'])}</span><span class="lv">${x('En vivo · actualizado hoy', 'Live · updated today', 'Live · heute aktualisiert', 'Ao vivo · atualizado hoje')}</span></div>
<div class="tabs"><button class="tab on" data-t="a">${x('Resumen', 'Overview', 'Übersicht', 'Resumo')}</button><button class="tab" data-t="b">${x('Oportunidades', 'Opportunities', 'Opportunities', 'Oportunidades')}</button><button class="tab" data-t="c">${x('Empresas', 'Companies', 'Unternehmen', 'Empresas')}</button></div>
<div class="pane on" data-p="a"><div class="kp">
${kp(x('Contactos alcanzados', 'Contacts reached', 'Erreichte Kontakte', 'Contatos alcançados'), 240, '▲ +18%')}
${kp(x('Respuestas', 'Replies', 'Antworten', 'Respostas'), 21, '▲ +12%')}
${kp(x('Oportunidades', 'Opportunities', 'Opportunities', 'Oportunidades'), 4, '▲ +1')}
${kp(x('Toques de contacto', 'Touchpoints', 'Kontaktpunkte', 'Pontos de contato'), 510, '▲ +22%')}
${kp(x('Apertura de correo', 'Email open rate', 'E-Mail-Öffnungsrate', 'Abertura de e-mail'), 41, est, true, '%')}
${kp(x('Clics', 'Clicks', 'Klicks', 'Cliques'), 6, estp, true, '%')}</div>
<svg class="trend" viewBox="0 0 640 84" preserveAspectRatio="none" width="100%" height="84"><g stroke="#E5E9F0" stroke-width="1"><line x1="0" y1="14" x2="640" y2="14"/><line x1="0" y1="42" x2="640" y2="42"/><line x1="0" y1="70" x2="640" y2="70"/></g>
<path d="M0 70 C40 66 60 48 100 52 S160 26 210 34 S270 56 320 38 S390 12 440 22 S520 44 560 20 S610 14 640 10" fill="none" stroke="${prim}" stroke-width="2.4"/>
<path d="M0 74 C50 72 80 64 130 60 S210 66 260 54 S340 48 400 50 S480 34 540 38 S610 32 640 28" fill="none" stroke="#7C5CE6" stroke-width="2.4"/></svg></div>
<div class="pane" data-p="b"><div class="rows">
${rowp('Northwind Insurance', x('Reunión pedida', 'Meeting requested', 'Termin angefragt', 'Reunião solicitada'), x('Próxima acción: confirmar horario', 'Next action: confirm time', 'Nächste Aktion: Zeit bestätigen', 'Próxima ação: confirmar horário'))}
${rowp('Contoso Logistics', x('Interesado', 'Interested', 'Interessiert', 'Interessado'), x('Próxima acción: enviar caso de éxito', 'Next action: send a case study', 'Nächste Aktion: Fallstudie senden', 'Próxima ação: enviar caso de sucesso'))}
${rowp('Fabrikam Group', x('En conversación', 'In conversation', 'Im Gespräch', 'Em conversa'), x('Próxima acción: responder objeción', 'Next action: answer objection', 'Nächste Aktion: Einwand beantworten', 'Próxima ação: responder objeção'))}</div></div>
<div class="pane" data-p="c"><div class="rows">
${rowp('Northwind Insurance', x('Decisor identificado', 'Decision-maker identified', 'Entscheider identifiziert', 'Decisor identificado'), x('Secuencia activa · paso 3 de 5', 'Active sequence · step 3 of 5', 'Aktive Sequenz · Schritt 3 von 5', 'Sequência ativa · passo 3 de 5'))}
${rowp('Contoso Logistics', x('Contactado', 'Contacted', 'Kontaktiert', 'Contatado'), x('Secuencia activa · paso 2 de 5', 'Active sequence · step 2 of 5', 'Aktive Sequenz · Schritt 2 von 5', 'Sequência ativa · passo 2 de 5'))}
${rowp('Fabrikam Group', x('Respondió', 'Replied', 'Hat geantwortet', 'Respondeu'), x('Secuencia detenida con contexto', 'Sequence stopped with context', 'Sequenz mit Kontext gestoppt', 'Sequência parada com contexto'))}</div></div></div>
<p class="cap rv" style="--d:3">${x('Vista ilustrativa con datos de ejemplo. Acceso desde la semana 1; recomendamos interpretar las métricas entre las semanas 4 y 6.', 'Illustrative view with sample data. Access from week 1; we recommend reading the metrics between weeks 4 and 6.', 'Illustrative Ansicht mit Beispieldaten. Zugang ab Woche 1; wir empfehlen, die Kennzahlen zwischen Woche 4 und 6 zu lesen.', 'Visualização ilustrativa com dados de exemplo. Acesso desde a semana 1; recomendamos interpretar as métricas entre as semanas 4 e 6.')}</p></div></section>`);

  // 8 · qué recibes
  const dl = (n, t) => `<div class="rv" style="--d:${n + 1}"><b>${pn(n)}</b><span>${t}</span></div>`;
  S.push(`<section class="slide s-light${fotos ? ' hasband' : ''}" data-th="light" data-tt="${ttAttr}">${hero('1554469384-e58fac16e23a', '05')}<div class="content"><div class="bh"><div class="eyebrow rv">05 · ${x('Entregables', 'Deliverables', 'Ergebnisse', 'Entregáveis')}</div>
<h2 class="rv" style="--d:1">${x('El servicio deja activos comerciales <em>reutilizables.</em>', 'The service leaves <em>reusable</em> commercial assets.', 'Die Leistung hinterlässt <em>wiederverwendbare</em> Vertriebsassets.', 'O serviço deixa ativos comerciais <em>reutilizáveis.</em>')}</h2></div>
<div class="dl">
${dl(1, x('Oferta prioritaria evaluada e hipótesis comercial.', 'Evaluated priority offer and commercial hypothesis.', 'Bewertetes prioritäres Angebot und Vertriebshypothese.', 'Oferta prioritária avaliada e hipótese comercial.'))}
${dl(2, x('ICP documentado y criterios de inclusión y descarte.', 'Documented ICP and inclusion and exclusion criteria.', 'Dokumentiertes ICP sowie Ein- und Ausschlusskriterien.', 'ICP documentado e critérios de inclusão e descarte.'))}
${dl(3, x('Universo de mercado validado (TAM, SAM y SOM).', 'Validated market universe (TAM, SAM and SOM).', 'Validiertes Marktuniversum (TAM, SAM und SOM).', 'Universo de mercado validado (TAM, SAM e SOM).'))}
${dl(4, x('Base de cuentas investigadas y decisores identificados.', 'Base of researched accounts and identified decision-makers.', 'Basis recherchierter Accounts und identifizierter Entscheider.', 'Base de contas pesquisadas e decisores identificados.'))}
${dl(5, x('Secuencia multicanal y hasta dos enfoques comerciales.', 'Multichannel sequence and up to two commercial approaches.', 'Multichannel-Sequenz und bis zu zwei Vertriebsansätze.', 'Sequência multicanal e até duas abordagens comerciais.'))}
${dl(6, x('Historial de actividad, respuestas y objeciones.', 'History of activity, replies and objections.', 'Verlauf von Aktivität, Antworten und Einwänden.', 'Histórico de atividade, respostas e objeções.'))}
${dl(7, x('Embudo comercial organizado y acceso al portal en vivo.', 'Organized pipeline and access to the live portal.', 'Organisierte Pipeline und Zugang zum Live-Portal.', 'Pipeline organizado e acesso ao portal ao vivo.'))}
${dl(8, x('Informes mensuales de actividad comercial.', 'Monthly commercial activity reports.', 'Monatliche Berichte zur Vertriebsaktivität.', 'Relatórios mensais de atividade comercial.'))}
${dl(9, x('Guía comercial inicial y recomendaciones.', 'Initial playbook and commercial recommendations.', 'Erstes Playbook und Vertriebsempfehlungen.', 'Playbook inicial e recomendações comerciais.'))}
</div></div></section>`);

  // 9 · responsabilidades
  const li_ = a => a.map(t => `<li>${t}</li>`).join('');
  S.push(`<section class="slide s-soft" data-th="light"><div class="content"><div class="eyebrow rv">05 · ${x('Responsabilidades', 'Responsibilities', 'Verantwortlichkeiten', 'Responsabilidades')}</div>
<h2 class="rv" style="--d:1">${x('Quién hace <em>qué.</em>', 'Who does <em>what.</em>', 'Wer macht <em>was.</em>', 'Quem faz <em>o quê.</em>')}</h2>
<div class="two">
<div class="rp dk rv" style="--d:2">${fotos ? `<div class="rpph" style="background-image:url('${U('1572021335469-31706a17aaef')}')"></div>` : ''}<div class="k">${x('Responsabilidad de ', 'Responsibility of ', 'Verantwortung von ', 'Responsabilidade da ')}${esc(marca)}</div><p>${x('Estrategia, investigación, mensajes, configuración de secuencia, ejecución multicanal, seguimientos, clasificación de respuestas, reportes mensuales y optimización continua.', 'Strategy, research, messaging, sequence setup, multichannel execution, follow-ups, reply classification, monthly reporting and continuous optimization.', 'Strategie, Recherche, Nachrichten, Sequenz-Einrichtung, Multichannel-Umsetzung, Nachfassen, Klassifizierung von Antworten, Monatsberichte und laufende Optimierung.', 'Estratégia, pesquisa, mensagens, configuração da sequência, execução multicanal, acompanhamentos, classificação de respostas, relatórios mensais e otimização contínua.')}</p></div>
<div class="rp lt rv" style="--d:3"><div class="k">${xp(['Responsabilidad del cliente', 'Client responsibility', 'Verantwortung des Kunden', 'Responsabilidade do cliente'], ['Responsabilidad de {c}', 'Responsibility of {c}', 'Verantwortung von {c}', 'Responsabilidade da {c}'])}</div><ul>${li_([
    x('Proporcionar información sobre servicios y proyectos.', 'Provide information about services and projects.', 'Informationen zu Leistungen und Projekten bereitstellen.', 'Fornecer informações sobre serviços e projetos.'),
    x('Colaborar en la selección de la oferta.', 'Collaborate in selecting the offer.', 'Bei der Auswahl des Angebots mitwirken.', 'Colaborar na seleção da oferta.'),
    x('Facilitar accesos y aprobar el enfoque inicial.', 'Provide access and approve the initial approach.', 'Zugänge bereitstellen und den ersten Ansatz freigeben.', 'Facilitar acessos e aprovar a abordagem inicial.'),
    x('Responder oportunamente a las oportunidades.', 'Respond promptly to opportunities.', 'Auf Opportunities zeitnah reagieren.', 'Responder oportunamente às oportunidades.'),
    x('Gestionar reuniones, propuestas, negociación y cierre.', 'Handle meetings, proposals, negotiation and closing.', 'Termine, Angebote, Verhandlung und Abschluss übernehmen.', 'Gerenciar reuniões, propostas, negociação e fechamento.'),
    x('Comunicar el resultado de las conversaciones.', 'Report the outcome of the conversations.', 'Das Ergebnis der Gespräche zurückmelden.', 'Comunicar o resultado das conversas.')])}</ul></div></div></div></section>`);

  // 10 · empresas con las que hemos trabajado (3 por diapositiva)
  if (refs.length) {
    const hostOf = u => String(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
    const card = (r, i) => `<div class="ref rv" style="--d:${i + 3}"><div class="rl">${imgOk(r.logo) ? `<img alt="${esc(r.nombre)}" src="${r.logo}">` : `<span>${esc(String(r.nombre || '?').trim().charAt(0).toUpperCase())}</span>`}</div><h3>${esc(r.nombre)}</h3>${r.link ? `<a class="rk" target="_blank" rel="noopener noreferrer" href="${esc(r.link)}">${esc(hostOf(r.link))} ↗</a>` : ''}${r.descripcion ? `<p>${esc(r.descripcion)}</p>` : ''}</div>`;
    for (let k = 0; k < nRef; k++) {
      S.push(`<section class="slide s-soft" data-th="light"><div class="content"><div class="eyebrow rv">06 · ${x('Clientes', 'Clients', 'Kunden', 'Clientes')}</div>
<h2 class="rv" style="--d:1">${x('Trabajos <em>destacados.</em>', 'Featured <em>work.</em>', 'Ausgewählte <em>Projekte.</em>', 'Trabalhos <em>em destaque.</em>')}</h2>
<p class="lead rv" style="--d:2">${x('Empresas con las que ya hemos trabajado.', 'Companies we have already worked with.', 'Unternehmen, mit denen wir bereits gearbeitet haben.', 'Empresas com as quais já trabalhamos.')}</p>
<div class="refs">${refs.slice(k * 2, k * 2 + 2).map(card).join('')}</div></div></section>`);
    }
  }

  // 11 · alcance
  const nScope = refs.length ? 7 : 6;
  S.push(`<section class="slide s-light" data-th="light"><div class="content"><div class="eyebrow rv">${pn(nScope)} · ${xp(['Alcance', 'Scope', 'Umfang', 'Escopo'], ['Alcance para {c}', 'Scope for {c}', 'Umfang für {c}', 'Escopo para {c}'])}</div>
<h2 class="rv" style="--d:1">${x('Un alcance delimitado para <em>aprender con precisión.</em>', 'A defined scope to <em>learn with precision.</em>', 'Ein klar umrissener Umfang, um <em>präzise zu lernen.</em>', 'Um escopo delimitado para <em>aprender com precisão.</em>')}</h2>
<div class="terms">
<div class="in rv" style="--d:2"><h3>${x('Incluye', 'Includes', 'Enthalten', 'Inclui')}</h3><ul>${li_([
    x('Una oferta prioritaria', 'One priority offer', 'Ein prioritäres Angebot', 'Uma oferta prioritária'),
    x('Un ICP principal y un mercado inicial', 'One main ICP and one initial market', 'Ein Haupt-ICP und ein Startmarkt', 'Um ICP principal e um mercado inicial'),
    x('Hasta dos cargos decisores', 'Up to two decision-maker roles', 'Bis zu zwei Entscheiderrollen', 'Até dois cargos decisores'),
    x('LinkedIn y correo electrónico', 'LinkedIn and email', 'LinkedIn und E-Mail', 'LinkedIn e e-mail'),
    x('Hasta dos enfoques relacionados', 'Up to two related approaches', 'Bis zu zwei verwandte Ansätze', 'Até duas abordagens relacionadas'),
    x('Estrategia, investigación, validación y mensajes', 'Strategy, research, validation and messaging', 'Strategie, Recherche, Validierung und Nachrichten', 'Estratégia, pesquisa, validação e mensagens'),
    x('Ejecución, seguimiento, CRM e informes', 'Execution, follow-up, CRM and reports', 'Umsetzung, Nachfassen, CRM und Berichte', 'Execução, acompanhamento, CRM e relatórios'),
    x('Acceso al portal en vivo', 'Access to the live portal', 'Zugang zum Live-Portal', 'Acesso ao portal ao vivo')])}</ul></div>
<div class="ex rv" style="--d:3"><h3>${x('No incluye', 'Does not include', 'Nicht enthalten', 'Não inclui')}</h3><ul>${li_([
    x('Varias ofertas, mercados o ICP simultáneos', 'Several simultaneous offers, markets or ICPs', 'Mehrere gleichzeitige Angebote, Märkte oder ICPs', 'Várias ofertas, mercados ou ICPs simultâneos'),
    x('Publicidad pagada o gestión de redes sociales', 'Paid advertising or social media management', 'Bezahlte Werbung oder Social-Media-Management', 'Publicidade paga ou gestão de redes sociais'),
    x('Producción de contenido', 'Content production', 'Content-Produktion', 'Produção de conteúdo'),
    x('Reuniones comerciales o demostraciones', 'Sales meetings or demos', 'Vertriebstermine oder Demos', 'Reuniões comerciais ou demonstrações'),
    x('Presupuestos, negociación o cierre', 'Quotes, negotiation or closing', 'Angebote, Verhandlung oder Abschluss', 'Orçamentos, negociação ou fechamento'),
    x('Gestión posterior a la venta', 'Post-sale management', 'Betreuung nach dem Verkauf', 'Gestão pós-venda'),
    x('Garantía de respuestas, reuniones o ventas', 'Guarantee of replies, meetings or sales', 'Garantie für Antworten, Termine oder Verkäufe', 'Garantia de respostas, reuniões ou vendas'),
    x('Licencias, dominios o buzones externos específicos', 'Specific external licenses, domains or mailboxes', 'Spezifische externe Lizenzen, Domains oder Postfächer', 'Licenças, domínios ou caixas de correio externos específicos')])}</ul></div></div>
<p class="disc rv" style="--d:4">${x('Los resultados dependerán también de la claridad de la propuesta de valor, la respuesta del mercado y la capacidad del cliente para atender las conversaciones.', 'Results will also depend on the clarity of the value proposition, the market response and the client’s ability to handle the conversations.', 'Die Ergebnisse hängen auch von der Klarheit des Wertversprechens, der Marktreaktion und der Fähigkeit des Kunden ab, die Gespräche zu führen.', 'Os resultados também dependerão da clareza da proposta de valor, da resposta do mercado e da capacidade do cliente de conduzir as conversas.')}</p></div></section>`);

  // 12 · inversión (simulador)
  const nInv = nScope;
  const simHtml = simulador
    ? `<div class="sim rv" style="--d:2"><div class="k">${x('Simula tu inversión', 'Simulate your investment', 'Simulieren Sie Ihre Investition', 'Simule o seu investimento')}</div>
<div class="tot" id="simTot">${esc(sym)}${money(fee * meses)}<small><span id="simN">${meses}</span> ${x('meses', 'months', 'Monate', 'meses')}</small></div>
<div class="eq"><span id="simEq">${esc(sym)}${money(fee)} × ${meses}</span> · ${x('sin costos ocultos', 'no hidden costs', 'keine versteckten Kosten', 'sem custos ocultos')}</div>
<input id="sim" type="range" min="1" max="12" step="1" value="${meses}" data-fee="${fee}" data-sym="${esc(sym)}" data-rec="${meses}">
<div class="scale"><span style="--f:0">1</span><span style="--f:.1818">3</span><span style="--f:.4545">6</span><span style="--f:.7273">9</span><span style="--f:1">12 ${x('meses', 'months', 'Monate', 'meses')}</span></div>
<div class="rec" id="simRec">★ ${x('Plazo recomendado', 'Recommended term', 'Empfohlene Laufzeit', 'Prazo recomendado')}</div></div>`
    : `<div class="sim rv" style="--d:2"><div class="k">${x('Tarifa mensual', 'Monthly fee', 'Monatliche Gebühr', 'Tarifa mensal')}</div><div class="tot">${esc(feeNum)}<small>${x('/ mes', '/ month', '/ Monat', '/ mês')}</small></div><div class="eq">${notaPago}</div></div>`;
  S.push(`<section class="slide s-dark" data-th="dark">${bgFoto('1500632907344-a073709b2448', ovV(.92, .8))}<div class="content"><div class="eyebrow rv">${pn(nInv)} · ${xp(['Inversión', 'Investment', 'Investition', 'Investimento'], ['Inversión para {c}', 'Investment for {c}', 'Investition für {c}', 'Investimento para {c}'])}</div>
<h2 class="rv" style="--d:1">${x('Una inversión <em>clara y mensual.</em>', 'A clear, <em>monthly investment.</em>', 'Eine klare, <em>monatliche Investition.</em>', 'Um investimento <em>claro e mensal.</em>')}</h2>
<div class="inv">${simHtml}
<div class="facts"><div class="rv" style="--d:3"><small>${x('Tarifa mensual', 'Monthly fee', 'Monatliche Gebühr', 'Tarifa mensal')}</small><b>${esc(feeNum)}</b><p>${notaPago}</p></div>
<div class="rv" style="--d:4"><small>${x('Plazo recomendado', 'Recommended term', 'Empfohlene Laufzeit', 'Prazo recomendado')}</small><b>${esc(mesesTxt)}</b><p>${x('El tiempo que toma completar el ciclo: validar la oferta, activar el contacto y optimizar con datos reales.', 'The time it takes to complete the cycle: validate the offer, start outreach and optimize with real data.', 'Die Zeit, die der Zyklus braucht: Angebot validieren, Ansprache starten und mit echten Daten optimieren.', 'O tempo necessário para completar o ciclo: validar a oferta, ativar o contato e otimizar com dados reais.')}</p></div>
<div class="rv" style="--d:5"><small>${x('Modelo de compensación', 'Compensation model', 'Vergütungsmodell', 'Modelo de remuneração')}</small><b style="font-size:21px">${modeloTxt}</b></div></div></div></div></section>`);

  // 13 · próximo paso
  S.push(`<section class="slide close s-dark" data-th="dark">${bgFoto('1521791136064-7986c2920216', ovL(.94, .62))}<div class="content">
<div><div class="eyebrow rv">${x('Próximo paso con ', 'Next step with ', 'Nächster Schritt mit ', 'Próximo passo com ')}${esc(marca)}</div>
<h2 class="rv" style="--d:1">${xp(['Comencemos a generar <em>oportunidades</em> comerciales.', 'Let’s start generating commercial <em>opportunities.</em>', 'Lassen Sie uns beginnen, Vertriebs<em>chancen</em> zu erzeugen.', 'Vamos começar a gerar <em>oportunidades</em> comerciais.'], ['Comencemos a generar <em>oportunidades</em> para {c}.', 'Let’s start generating <em>opportunities</em> for {c}.', 'Lassen Sie uns beginnen, <em>Chancen</em> für {c} zu erzeugen.', 'Vamos começar a gerar <em>oportunidades</em> para {c}.'])}</h2>
<p class="lead rv" style="--d:2">${x('Confirma el inicio del servicio. A partir de ahí definiremos el perfil de cliente ideal y prepararemos el primer bloque de cuentas objetivo.', 'Confirm the start of the service. From there we will define the ideal customer profile and prepare the first block of target accounts.', 'Bestätigen Sie den Start der Leistung. Danach definieren wir das ideale Kundenprofil und bereiten den ersten Block von Ziel-Accounts vor.', 'Confirme o início do serviço. A partir daí definiremos o perfil de cliente ideal e prepararemos o primeiro bloco de contas-alvo.')}</p>
<a class="cta rv" style="--d:3" target="_blank" rel="noopener noreferrer" href="${esc(mailto)}">${x('Comenzar ahora', 'Get started', 'Jetzt starten', 'Começar agora')} <span>↗</span></a></div>
<div class="steps">
<div class="rv" style="--d:3"><i>01</i><span>${x('Confirmar el inicio del servicio.', 'Confirm the start of the service.', 'Start der Leistung bestätigen.', 'Confirmar o início do serviço.')}</span></div>
<div class="rv" style="--d:4"><i>02</i><span>${x('Definir el perfil de cliente ideal y compartir la información necesaria.', 'Define the ideal customer profile and share the necessary information.', 'Das ideale Kundenprofil definieren und die nötigen Informationen teilen.', 'Definir o perfil de cliente ideal e compartilhar as informações necessárias.')}</span></div>
<div class="rv" style="--d:5"><i>03</i><span>${x('Preparar mensajes, cuentas objetivo e iniciar la ejecución.', 'Prepare messages, target accounts and start execution.', 'Nachrichten und Ziel-Accounts vorbereiten und die Umsetzung starten.', 'Preparar mensagens, contas-alvo e iniciar a execução.')}</span></div></div></div>
<div class="foot"><span>${esc(marca)}${mail ? ' · ' + esc(mail) : ''}${web ? ' · ' + esc(web) : ''}</span><span>${x('Confidencial · preparada para ', 'Confidential · prepared for ', 'Vertraulich · erstellt für ', 'Confidencial · preparada para ')}${esc(empresa)}</span></div></section>`);

  const total = S.length;
  const dots = S.map((_, i) => `<button class="dot" aria-label="${i + 1}"></button>`).join('');
  const rootVars = `:root{--ink:#0B1220;--navy:${dark};--text:#475569;--mute:#94A3B8;--line:#E5E9F0;--soft:#F6F8FB;--teal:${prim};--teal-l:${light};--tl-rgb:${rgb(light)};--pr-rgb:${rgb(prim)};--dk-rgb:${rgb(dark)};--sans:'Inter','Segoe UI',system-ui,sans-serif}`;
  const title = `${empresa} · ${x('Presentación', 'Presentation', 'Präsentation', 'Apresentação')} ${marca}`;
  return `<!DOCTYPE html>\n<html lang="${lang}" data-deck="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>${rootVars}${CSS}</style></head><body>
<div class="hint">${x('Gira el teléfono para ver mejor la presentación', 'Rotate your phone for a better view', 'Drehen Sie Ihr Telefon für eine bessere Ansicht', 'Gire o telefone para ver melhor a apresentação')}</div>
<div class="deck" id="deck" data-th="dark" data-tt="dark"><div class="stage" id="stage">
<div class="bar" id="bar"></div>
<div class="top"><div class="brand"><span class="bw">${brandW}</span><span class="bc">${brandC}</span></div><div class="r"><span class="cnt"><b id="cur">01</b> <i>/ ${pn(total)}</i></span><button class="btn-fs" id="fs" type="button">⛶ ${x('Presentar', 'Present', 'Präsentieren', 'Apresentar')}</button></div></div>
${S.join('\n')}
<button class="arr l" id="prev" aria-label="←">‹</button><button class="arr r" id="next" aria-label="→">›</button>
<div class="nav">${dots}</div>
</div></div>
<script>${JS}</script></body></html>`;
}

module.exports = { render };
