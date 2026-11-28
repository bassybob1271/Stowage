/**
 * Public BazzyBox website, served at "/" on the BazzyBox host (box.bazzy.tv) to visitors
 * without a session. Signed-in users get the file app at the same URL.
 * Prices come from pricing.ts so the page can never disagree with what the wallet charges.
 * No inline script: the calculator lives in /site.js (CSP script-src 'self').
 */
import { PACKS, SEND_CREDITS_PER_GB, plans, type PackId } from './pricing.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (credits: number) => `$${(credits / 100).toFixed(2)}`;

/** Fonts come from Google; everything else is same-origin. */
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface SiteOptions {
  freeGb: number;
  /** Link back to the Bazzy TV video site. */
  tvUrl?: string;
  /** Link to Bazzy Live. */
  liveUrl?: string;
  signupOpen: boolean;
}

export function siteHtml(o: SiteOptions): string {
  const p = plans(o.freeGb);
  const lite = p.lite;
  const flex = p.flex;
  const studio = p.studio;
  const liteTb = lite.includedBytes / 1e12;
  const litePrice = usd(lite.priceCredits);
  const liteSendGb = lite.sendFreeBytes / 1e9;
  /** From how many TB Studio costs less than Flex plus extra space. */
  const studioFromTb = Math.ceil(flex.includedBytes / 1e12 + (studio.priceCredits - flex.priceCredits) / (flex.overageCreditsPerTbMonth ?? 1));
  const studioTb = studio.includedBytes / 1e12;
  const studioPrice = usd(studio.priceCredits);
  const studioOver = usd(studio.overageCreditsPerTbMonth ?? 0);
  const studioSendGb = studio.sendFreeBytes / 1e9;
  const flexTb = flex.includedBytes / 1e12;
  const flexPrice = usd(flex.priceCredits);
  const overTb = usd(flex.overageCreditsPerTbMonth ?? 0);
  const sendFreeGb = flex.sendFreeBytes / 1e9;
  const sendGb = usd(SEND_CREDITS_PER_GB);
  const freeLabel = o.freeGb >= 1 ? `${o.freeGb} GB` : `${Math.round(o.freeGb * 1000)} MB`;
  const cta = o.signupOpen ? 'Start free' : 'Sign in';
  const ctaHref = o.signupOpen ? '/signup' : '/login';
  const packs = (Object.keys(PACKS) as PackId[]).map((id) => {
    const k = PACKS[id];
    const bonus = Math.round((k.credits / (k.usdCents) - 1) * 100);
    return `<li><b>$${k.usdCents / 100}</b><span>${k.credits.toLocaleString('en-US')} credits${bonus > 0 ? ` <em>+${bonus}%</em>` : ''}</span></li>`;
  }).join('');
  const tv = o.tvUrl ? esc(o.tvUrl) : '';
  const live = o.liveUrl ? esc(o.liveUrl) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>BazzyBox</title>
<meta name="description" content="Cloud storage for filmmakers and musicians, from Bazzy TV. ${liteTb} TB for ${litePrice}, ${flexTb} TB for ${flexPrice}, ${studioTb} TB for ${studioPrice}. Downgrade any day, keep your files.">
<link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..800&display=swap" rel="stylesheet">
<style>
/* VOICE everyday product page for working creators
   IDEA a studio rack: storage as a meter you can see and pull down, not a locked tier
   PICTURE live bill race: Dropbox vs BazzyBox for the space you actually keep
   COLOUR Bazzy TV night ground #0c0d10, bone ink, Bazzy red #ff3d5a, steel #8e95a3
   TYPE Archivo wide 800 + Archivo
   LAYOUT title + promise left, calculator right; stacks title, calculator, promise on phones */
:root{color-scheme:dark;--bg:#0c0d10;--panel:#15171c;--line:#262a31;--ink:#eceef2;--mute:#9aa1ae;--red:#ff3d5a;--steel:#5d6573;--ok:#2fd27a}
*{box-sizing:border-box;min-width:0}
html{scroll-padding-top:72px}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Archivo,system-ui,sans-serif;overflow-x:clip}
a{color:inherit}
.band{padding:clamp(28px,5vw,72px) max(5vw,16px)}
.wrap{max-width:1180px;margin:0 auto}
h1,h2,h3{font-stretch:112%;font-weight:800;letter-spacing:-.02em;line-height:1.05;margin:0;text-wrap:balance}
h1{font-size:clamp(34px,5.4vw,56px)}
h2{font-size:clamp(26px,3.4vw,36px);margin-bottom:12px}
h3{font-size:19px;margin-bottom:6px}
p{margin:0 0 12px;max-width:62ch}
.mute{color:var(--mute)}
nav{position:sticky;top:0;z-index:5;background:color-mix(in oklab,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
nav .wrap{display:flex;align-items:center;gap:8px 18px;flex-wrap:wrap;padding:12px max(5vw,16px)}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;font-stretch:112%;font-size:19px}
.dot{width:11px;height:11px;border-radius:50%;background:var(--red);box-shadow:0 0 0 4px color-mix(in oklab,var(--red) 25%,transparent)}
.links{display:flex;flex-wrap:wrap;gap:4px 16px;margin-left:auto;align-items:center;font-size:15px}
.links a{text-decoration:none;color:var(--mute);padding:8px 0}
.links a:hover{color:var(--ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;border-radius:10px;font:700 16px Archivo,sans-serif;text-decoration:none;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.btn.go{background:var(--red);border-color:var(--red);color:#fff}
.btn:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.links .btn{color:#fff;padding:8px 14px;min-height:40px}
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:clamp(24px,4vw,56px);align-items:center}
.lede{font-size:19px;margin-top:16px}
.ctas{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.small{font-size:14px;color:var(--mute);margin-top:12px}
.calc{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:clamp(18px,2.6vw,28px)}
.calc label{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:15px;color:var(--mute)}
.calc label b{font-stretch:112%;font-size:28px;color:var(--ink);white-space:nowrap}
input[type=range]{width:100%;height:44px;accent-color:var(--red);margin:4px 0 14px}
.bill{display:grid;grid-template-columns:7.5em minmax(0,1fr) 5.5em;gap:10px;align-items:center;margin:10px 0}
.bill span{font-size:15px}
.trk{height:34px;border-radius:6px;background:#1d2027;overflow:hidden}
.fill{height:100%;border-radius:6px;background:var(--steel);transition:width .3s ease}
.bill.us .fill{background:var(--red)}
.bill b{text-align:right;font-stretch:112%;font-size:20px;white-space:nowrap;font-variant-numeric:tabular-nums}
.bill.us b{color:var(--red)}
.save{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 16px}
.save b{font-stretch:112%;font-size:clamp(26px,3.4vw,34px)}
.plan{font-size:13px;color:var(--mute)}
.promise{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:16px;margin-top:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px}
.card p{font-size:15px;color:var(--mute);margin:0}
.k{display:block;font-stretch:112%;font-weight:800;font-size:30px;color:var(--red);margin-bottom:6px}
.alt{background:#08090b}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px;margin-top:20px}
.tier{border:1px solid var(--line);border-radius:16px;padding:24px;background:var(--panel)}
.tier.main{border-color:var(--red)}
.price{font-stretch:112%;font-weight:800;font-size:44px;line-height:1;margin:10px 0 4px;white-space:nowrap}
.price small{font-size:16px;font-weight:600;color:var(--mute)}
.tier ul{list-style:none;padding:0;margin:16px 0 20px}
.tier li{padding:8px 0;border-top:1px solid var(--line);font-size:15px}
.packs{list-style:none;padding:0;margin:14px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(9em,1fr));gap:10px}
.packs li{border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:2px;background:var(--panel)}
.packs b{font-stretch:112%;font-size:24px}
.packs span{font-size:14px;color:var(--mute)}
.packs em{font-style:normal;color:var(--ok);font-weight:700}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:clamp(20px,4vw,48px)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mute);font-weight:600;font-size:14px}
td.n{white-space:nowrap;font-variant-numeric:tabular-nums}
td.us{color:var(--ink);font-weight:700}
details{border-bottom:1px solid var(--line);padding:14px 0}
summary{cursor:pointer;font-weight:700;font-size:17px;list-style-position:outside}
details p{color:var(--mute);margin:10px 0 0;font-size:15px}
footer{border-top:1px solid var(--line)}
footer .wrap{display:flex;flex-wrap:wrap;gap:10px 24px;justify-content:space-between;font-size:14px;color:var(--mute)}
@media(max-width:820px){.hero,.two{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.links a:not(.btn){display:none}.bill{grid-template-columns:6em minmax(0,1fr) 4.8em}table{font-size:13px}th,td{padding:6px 4px}}
@media(prefers-reduced-motion:reduce){.fill{transition:none}}
</style>
</head>
<body>
<nav><div class="wrap">
  <a class="brand" href="/"><span class="dot" aria-hidden="true"></span>BazzyBox</a>
  <div class="links">
    <a href="#pricing">Pricing</a>
    <a href="#switch">Why switch</a>
    <a href="#faq">FAQ</a>
    ${tv ? `<a href="${tv}">Bazzy TV</a>` : ''}
    ${live ? `<a href="${live}">Live</a>` : ''}
    <a href="/login">Sign in</a>
    <a class="btn go" href="${ctaHref}">${cta}</a>
  </div>
</div></nav>

<header class="band">
<div class="wrap hero">
  <div>
    <h1>Storage for filmmakers and musicians that lets you go.</h1>
    <p class="lede">${liteTb} TB for ${litePrice} a month, ${flexTb} TB for ${flexPrice}. Pay for the space you keep, change plans any day, and never lose a file because you downgraded.</p>
    <div class="ctas">
      <a class="btn go" href="${ctaHref}">${o.signupOpen ? `Start with ${freeLabel} free` : 'Sign in'}</a>
      <a class="btn" href="#pricing">See pricing</a>
    </div>
    <p class="small">From Bazzy TV. No card needed for the free plan. Every plan includes <a href="#player">Mazzy</a>, the media player for your songs and videos.</p>
  </div>
  <div class="calc" id="calc" data-lite="${lite.priceCredits}" data-lincl="${liteTb}" data-lover="${lite.overageCreditsPerTbMonth ?? 0}" data-flex="${flex.priceCredits}" data-incl="${flexTb}" data-over="${flex.overageCreditsPerTbMonth ?? 0}" data-studio="${studio.priceCredits}" data-sincl="${studioTb}" data-sover="${studio.overageCreditsPerTbMonth ?? 0}">
    <label for="tb">How much do you keep in the cloud? <b id="tbv">2 TB</b></label>
    <input id="tb" type="range" min="1" max="20" step="1" value="2" aria-describedby="plan" aria-valuetext="2 TB">
    <div class="bill"><span>Dropbox</span><div class="trk"><div class="fill" id="fd" style="width:100%"></div></div><b id="vd">$11.99</b></div>
    <div class="bill us"><span>BazzyBox</span><div class="trk"><div class="fill" id="fb" style="width:83%"></div></div><b id="vb">${usd(Math.min(flex.priceCredits, lite.priceCredits + (lite.overageCreditsPerTbMonth ?? 0)))}</b></div>
    <div class="save"><span class="mute">You save each year</span><b id="sv">$24</b></div>
    <p class="plan" id="plan">Dropbox Plus, 2 TB · BazzyBox Lite, ${liteTb} TB + 1 TB extra</p>
    <p class="plan">Dropbox monthly list prices, November 2026. Team plans need 3 seats; Advanced adds 5 TB per seat.</p>
  </div>
</div>
</header>

<section class="band alt" id="switch">
<div class="wrap">
  <h2>The no-lock-in promise</h2>
  <p class="mute">Dropbox plan changes wait for the end of your billing cycle, and refunds are rare. BazzyBox works the other way.</p>
  <div class="promise">
    <div class="card"><span class="k">Any day</span><h3>Change plans right away</h3><p>Upgrade or downgrade whenever a project starts or wraps. The unused days of your plan go back to your wallet as credits.</p></div>
    <div class="card"><span class="k">Per day</span><h3>Pay for what you keep</h3><p>Space past your ${flexTb} TB is ${overTb} per TB-month, counted daily. Delete a finished project and tomorrow's bill drops.</p></div>
    <div class="card"><span class="k">Never</span><h3>Your files don't get deleted</h3><p>If your wallet runs dry you move to Free. Uploads pause while you're over the free space, but every file stays put.</p></div>
    <div class="card"><span class="k">$0</span><h3>Leave with everything</h3><p>Downloading your own files is always free. Take the whole archive with you whenever you like.</p></div>
  </div>
</div>
</section>

<section class="band" id="player">
<div class="wrap">
  <h2>Mazzy, the media player for Bazzy. Free on every plan.</h2>
  <p class="mute">Your songs and videos play right in BazzyBox, Free plan included. No downloading first, no extra app, no add-on to pay for. Musicians send demo playlists to labels and collaborators; filmmakers share the day's dailies with the director and crew, who leave notes on the exact frame or bar.</p>
  <div class="promise">
    <div class="card"><span class="k">Songs</span><h3>A real music player</h3><p>Waveform scrubbing, the folder as a playlist, a queue, shuffle and repeat, and volume and mute. The mini-player keeps the music going while you browse.</p></div>
    <div class="card"><span class="k">Video</span><h3>Stream, don't download</h3><p>Scrub straight to any moment, change the playback speed, pop out picture-in-picture, and turn on subtitles from an .srt or .vtt file next to the video.</p></div>
    <div class="card"><span class="k">1:36</span><h3>Notes pinned to the moment</h3><p>Pause and write "raise the vocal here": the note is pinned to that second on the timeline. Click a pin to jump back, reply, and tick it off when it's done.</p></div>
    <div class="card"><span class="k">Share</span><h3>Demo playlists and dailies</h3><p>Turn a folder of demos into a playlist with a cover picture and one link. Send dailies as review links: the director and crew play them and leave timed notes without making an account.</p></div>
  </div>
</div>
</section>

<section class="band alt" id="pricing">
<div class="wrap">
  <h2>Four plans and a wallet</h2>
  <p class="mute">Everything is paid in credits. 1 credit is one cent, and credits never expire.</p>
  <div class="tiers">
    <div class="tier">
      <h3>Free</h3>
      <div class="price">$0</div>
      <ul>
        <li>${freeLabel} of storage</li>
        <li>The Mazzy media player for songs and video, plus previews for images and PDFs</li>
        <li>2 GB of share-link downloads a month</li>
      </ul>
      <a class="btn" href="${ctaHref}">${cta}</a>
    </div>
    <div class="tier">
      <h3>BazzyBox Lite</h3>
      <div class="price">${litePrice} <small>per 30 days</small></div>
      <ul>
        <li><b>${liteTb} TB</b> included, then ${usd(lite.overageCreditsPerTbMonth ?? 0)} per TB-month, charged daily</li>
        <li>${liteSendGb} GB of share-link downloads a month, then ${sendGb}/GB</li>
        <li>For a few projects, a demo reel or a catalog of mixes</li>
        <li>Same any-day switching: unused days come back as credits</li>
      </ul>
      <a class="btn" href="${ctaHref}">${o.signupOpen ? 'Get Lite' : 'Sign in'}</a>
    </div>
    <div class="tier main">
      <h3>BazzyBox Flex</h3>
      <div class="price">${flexPrice} <small>per 30 days</small></div>
      <ul>
        <li><b>${flexTb} TB</b> included, then ${overTb} per TB-month, charged daily (Studio is cheaper from ${studioFromTb} TB up)</li>
        <li>${sendFreeGb} GB of share-link downloads a month, then ${sendGb}/GB</li>
        <li>Change plans or cancel any day, unused days refunded as credits</li>
        <li>Renews from your wallet, never a surprise card charge</li>
      </ul>
      <a class="btn go" href="${ctaHref}">${o.signupOpen ? 'Get Flex' : 'Sign in'}</a>
    </div>
    <div class="tier">
      <h3>BazzyBox Studio</h3>
      <div class="price">${studioPrice} <small>per 30 days</small></div>
      <ul>
        <li><b>${studioTb} TB</b> included, then ${studioOver} per TB-month, charged daily</li>
        <li>${studioSendGb} GB of share-link downloads a month, then ${sendGb}/GB</li>
        <li>For full productions, catalogs and archives</li>
        <li>Same any-day switching: unused days come back as credits</li>
      </ul>
      <a class="btn" href="${ctaHref}">${o.signupOpen ? 'Get Studio' : 'Sign in'}</a>
    </div>
  </div>
  <h3 style="margin-top:32px">Credit packs</h3>
  <ul class="packs">${packs}</ul>
</div>
</section>

<section class="band">
<div class="wrap two">
  <div>
    <h2>Built for big media files</h2>
    <p class="mute">Sessions, stems, RAW footage and masters, kept in one private space on Backblaze B2's always-hot cloud storage.</p>
    <ul>
      <li><b>Resumable uploads.</b> Multi-gigabyte files survive a dropped connection or a closed laptop.</li>
      <li><b>Play before you download.</b> The <a href="#player">Mazzy media player</a> scrubs video and auditions mixes on a waveform, free on every plan. PDFs page through in the browser.</li>
      <li><b>Send to clients.</b> Share links with Range support for streaming, ${sendGb}/GB past your allowance, compared with $0.25/GB on MASV.</li>
      <li><b>Playlist Maker.</b> Pick mixes, stems or video, add a cover picture and send one link to a player page anyone can open.</li>
      <li><b>Bring your Dropbox.</b> Connect once, tick the folders, and BazzyBox copies them over in the background. Nothing in your Dropbox changes.</li>
      <li><b>Next: publish to Bazzy TV.</b> Send a finished cut from your box straight to your channel. Coming soon.</li>
    </ul>
  </div>
  <div>
    <h2>Side by side</h2>
    <div class="scroll"><table>
      <thead><tr><th></th><th>Dropbox</th><th>BazzyBox</th></tr></thead>
      <tbody>
        <tr><td>1 TB</td><td class="n">$11.99/mo (2 TB is the smallest)</td><td class="n us">${litePrice}/mo</td></tr>
        <tr><td>3 TB, one person</td><td class="n">$19.99/mo</td><td class="n us">${flexPrice}/mo</td></tr>
        <tr><td>15 TB</td><td class="n">$90/mo (3 seats)</td><td class="n us">${studioPrice}/mo</td></tr>
        <tr><td>Downgrade</td><td>End of billing cycle</td><td class="us">Same day, credit back</td></tr>
        <tr><td>Extra space</td><td>Next plan up</td><td class="us">${overTb}/TB, by the day</td></tr>
        <tr><td>Big file sends</td><td>Plan limits</td><td class="us">${sendGb}/GB past ${sendFreeGb} GB</td></tr>
        <tr><td>Music and video player</td><td>Basic preview</td><td class="us">Mazzy media player, timed notes, free</td></tr>
        <tr><td>Free plan</td><td class="n">2 GB</td><td class="n us">${freeLabel}</td></tr>
      </tbody>
    </table></div>
  </div>
</div>
</section>

<section class="band alt" id="faq">
<div class="wrap">
  <h2>Questions</h2>
  <details><summary>What happens if I downgrade in the middle of a month?</summary><p>The change happens immediately. The days you already paid for and didn't use go back to your wallet as credits, so you can come back to Flex later without paying twice.</p></details>
  <details><summary>What if I'm over the free space when I downgrade?</summary><p>Nothing is deleted. Uploads pause until you're back under the free space or back on Flex. You can still open, play and download everything.</p></details>
  <details><summary>How do credits work?</summary><p>Buy a pack by card and the credits land in your wallet. Flex renews from the wallet every 30 days, and extra storage and paid sends come out of it too. Bigger packs include bonus credits.</p></details>
  <details><summary>Can I get my money back?</summary><p>Unused purchased credits are refundable when you close your account. Contact support and we'll process it.</p></details>
  <details><summary>Where are my files stored?</summary><p>On Backblaze B2, always-hot cloud storage with data centers in North America and Europe. Your files sit in a private space only your account can open.</p></details>
  <details><summary>Is BazzyBox part of Bazzy TV?</summary><p>Yes. It's the storage side of Bazzy TV, made for the same filmmakers and musicians who stream and publish there.</p></details>
</div>
</section>

<footer class="band"><div class="wrap">
  <span>BazzyBox from Bazzy TV</span>
  <span>${tv ? `<a href="${tv}">Watch on Bazzy TV</a> · ` : ''}${live ? `<a href="${live}">Bazzy Live</a> · ` : ''}<a href="/login">Sign in</a></span>
</div></footer>
<script src="/site.js"></script>
</body>
</html>`;
}

/** Calculator for the hero. Dropbox tiers are monthly list prices (Nov 2026). */
export const siteJs = String.raw`
(() => {
  const el = document.getElementById('calc');
  if (!el) return;
  const d = el.dataset;
  const plans = [
    ['Lite', Number(d.lite) / 100, Number(d.lincl), Number(d.lover) / 100],
    ['Flex', Number(d.flex) / 100, Number(d.incl), Number(d.over) / 100],
    ['Studio', Number(d.studio) / 100, Number(d.sincl), Number(d.sover) / 100],
  ];
  /** Cheapest BazzyBox plan for a given amount stored. */
  const ours = (tb) => plans.map(([name, base, incl, over]) => ({ name, incl, cost: base + Math.max(0, tb - incl) * over }))
    .reduce((a, b) => (b.cost < a.cost ? b : a));
  const $ = (id) => document.getElementById(id);
  const dropbox = (tb) => tb <= 2 ? [11.99, 'Dropbox Plus, 2 TB']
    : tb <= 3 ? [19.99, 'Dropbox Professional, 3 TB']
    : tb <= 5 ? [54, 'Dropbox Standard, 3 seats, 5 TB']
    : tb <= 15 ? [90, 'Dropbox Advanced, 3 seats, 15 TB']
    : [Math.ceil(tb / 5) * 30, 'Dropbox Advanced, ' + Math.ceil(tb / 5) + ' seats, ' + Math.ceil(tb / 5) * 5 + ' TB'];
  const money = (x) => '$' + (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2));
  const draw = () => {
    const tb = Number($('tb').value);
    const [db, dl] = dropbox(tb);
    const us = ours(tb), b = us.cost;
    const max = Math.max(db, b);
    $('tbv').textContent = tb + ' TB';
    $('tb').setAttribute('aria-valuetext', tb + ' TB');
    $('vd').textContent = money(db); $('vb').textContent = money(b);
    $('fd').style.width = (db / max * 100) + '%'; $('fb').style.width = (b / max * 100) + '%';
    const yr = Math.round((db - b) * 12);
    $('sv').textContent = '$' + Math.max(0, yr).toLocaleString('en-US');
    $('plan').textContent = dl + ' · BazzyBox ' + us.name + (tb > us.incl ? ', ' + us.incl + ' TB + ' + (tb - us.incl) + ' TB extra' : ', ' + us.incl + ' TB included');
  };
  $('tb').addEventListener('input', draw);
  draw();
})();
`;
