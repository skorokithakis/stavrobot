// Adapted from design/sb.css for the application shell. Keep it in sync with the
// mockups when the design changes.
export const SHARED_STYLES = `/* ---------- Self-hosted fonts (IBM Plex, latin subset) ---------- */
@font-face{font-family:'IBM Plex Sans';font-style:normal;font-weight:400;font-display:swap;src:url(/assets/fonts/ibm-plex-sans-latin-400-normal.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'IBM Plex Sans';font-style:normal;font-weight:500;font-display:swap;src:url(/assets/fonts/ibm-plex-sans-latin-500-normal.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'IBM Plex Sans';font-style:normal;font-weight:600;font-display:swap;src:url(/assets/fonts/ibm-plex-sans-latin-600-normal.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:400;font-display:swap;src:url(/assets/fonts/ibm-plex-mono-latin-400-normal.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:500;font-display:swap;src:url(/assets/fonts/ibm-plex-mono-latin-500-normal.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
/* Reset the document so the shell can own the full viewport. */
html,body{margin:0;padding:0}
/* Stavrobot admin: sb.css (round 2)
   Light is the default. Dark applies when the OS asks for it.
   .sb-light / .sb-dark force a theme (only for mockups and tests).
   In the app, put class="sb" on <body>. */

/* ---------- Tokens: light (default) ---------- */
.sb{
--bg:#f5f5f4;--surface:#ffffff;--surface-2:#f0efed;--border:#e0ded9;--border-strong:#c4c0b9;--control-border:#8c8781;
--text:#1c1917;--muted:#57534e;--faint:#6b6b6b;
--accent:#f5a524;--accent-hover:#e8960c;--on-accent:#1a1200;--accent-text:#9a4a00;
--success:#166534;--danger:#b91c1c;--info:#1d4ed8;--warning:#9a4a00;
--focus-ring:#9a4a00;--focus-halo:rgba(154,74,0,.18);
--danger-border:#e9a8a8;--danger-hover-bg:#fdf0f0;--danger-fill:#b91c1c;--danger-fill-hover:#991b1b;--on-danger-fill:#ffffff;
--badge-accent-bg:#fdf1dc;--badge-accent-border:#e9c07a;
--success-bg:#e8f5ec;--danger-bg:#fdeeee;--info-bg:#ebf1fe;--warning-bg:#fdf3e1;
--success-border:#a6d6b5;--danger-border-soft:#f0bcbc;--info-border:#b8ccf6;--warning-border:#e9c07a;
--sidebar:#fafaf9;--tabbar:#ffffff;
--row-hover:#fafaf9;--row-selected:#fdf4e3;
--dot-off:#a8a29e;--inset:#f7f6f4;
--shadow:0 12px 32px rgba(28,25,23,.14),0 2px 6px rgba(28,25,23,.06);
--scrim:rgba(28,25,23,.35);
--bubble-user:#fdf1dc;--bubble-bot:#f3f2f0;
--skeleton:#ecebe8;--skeleton-hi:#f7f6f4;
}
/* ---------- Tokens: dark ---------- */
@media (prefers-color-scheme: dark){.sb:not(.sb-light){
--bg:#121212;--surface:#1b1b1b;--surface-2:#242424;--border:#2e2e2e;--border-strong:#454545;--control-border:#6e6e6e;
--text:#ededed;--muted:#a3a3a3;--faint:#8a8a8a;
--accent:#f5a524;--accent-hover:#ffb84d;--on-accent:#1a1200;--accent-text:#f5a524;
--success:#4ade80;--danger:#f87171;--info:#7cb3ff;--warning:#f5a524;
--focus-ring:#f5a524;--focus-halo:rgba(245,165,36,.22);
--danger-border:#6b3030;--danger-hover-bg:rgba(248,113,113,.10);--danger-fill:#f87171;--danger-fill-hover:#fa8c8c;--on-danger-fill:#2a0a0a;
--badge-accent-bg:rgba(245,165,36,.08);--badge-accent-border:rgba(245,165,36,.4);
--success-bg:rgba(74,222,128,.10);--danger-bg:rgba(248,113,113,.10);--info-bg:rgba(124,179,255,.10);--warning-bg:rgba(245,165,36,.10);
--success-border:rgba(74,222,128,.3);--danger-border-soft:rgba(248,113,113,.35);--info-border:rgba(124,179,255,.3);--warning-border:rgba(245,165,36,.35);
--sidebar:#161616;--tabbar:#171717;
--row-hover:rgba(255,255,255,.03);--row-selected:rgba(245,165,36,.08);
--dot-off:#5a5a5a;--inset:#121212;
--shadow:0 16px 40px rgba(0,0,0,.55);
--scrim:rgba(0,0,0,.6);
--bubble-user:#2b2416;--bubble-bot:#242424;
--skeleton:#242424;--skeleton-hi:#2e2e2e;
}}
.sb.sb-dark{
--bg:#121212;--surface:#1b1b1b;--surface-2:#242424;--border:#2e2e2e;--border-strong:#454545;--control-border:#6e6e6e;
--text:#ededed;--muted:#a3a3a3;--faint:#8a8a8a;
--accent:#f5a524;--accent-hover:#ffb84d;--on-accent:#1a1200;--accent-text:#f5a524;
--success:#4ade80;--danger:#f87171;--info:#7cb3ff;--warning:#f5a524;
--focus-ring:#f5a524;--focus-halo:rgba(245,165,36,.22);
--danger-border:#6b3030;--danger-hover-bg:rgba(248,113,113,.10);--danger-fill:#f87171;--danger-fill-hover:#fa8c8c;--on-danger-fill:#2a0a0a;
--badge-accent-bg:rgba(245,165,36,.08);--badge-accent-border:rgba(245,165,36,.4);
--success-bg:rgba(74,222,128,.10);--danger-bg:rgba(248,113,113,.10);--info-bg:rgba(124,179,255,.10);--warning-bg:rgba(245,165,36,.10);
--success-border:rgba(74,222,128,.3);--danger-border-soft:rgba(248,113,113,.35);--info-border:rgba(124,179,255,.3);--warning-border:rgba(245,165,36,.35);
--sidebar:#161616;--tabbar:#171717;
--row-hover:rgba(255,255,255,.03);--row-selected:rgba(245,165,36,.08);
--dot-off:#5a5a5a;--inset:#121212;
--shadow:0 16px 40px rgba(0,0,0,.55);
--scrim:rgba(0,0,0,.6);
--bubble-user:#2b2416;--bubble-bot:#242424;
--skeleton:#242424;--skeleton-hi:#2e2e2e;
}

/* ---------- Base ---------- */
.sb{font-family:'IBM Plex Sans',system-ui,sans-serif;color:var(--text);background:var(--bg);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
.sb *,.sb *::before,.sb *::after{box-sizing:border-box}
.sb a{color:var(--accent-text);text-underline-offset:2px}
.sb a:hover{text-decoration:underline}
.sb :focus{outline:none}
.sb :focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.sb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sb-hidden{display:none!important}

/* ---------- Type ---------- */
.sb-h1{font-size:28px;font-weight:600;margin:0;letter-spacing:-.01em;line-height:1.2}
.sb-h2{font-size:17px;font-weight:600;margin:0;line-height:1.3}
.sb-h3{font-size:15px;font-weight:600;margin:0}
.sb-label{font-size:12px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.sb-mono{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:13px}
.sb-muted{color:var(--muted)}
.sb-faint{color:var(--faint)}
.sb-small{font-size:13px}
.sb-num{font-variant-numeric:tabular-nums}

/* ---------- App layout ---------- */
.sb-app{display:flex;min-height:100vh}
.sb-sidebar{width:240px;flex:none;background:var(--sidebar);border-right:1px solid var(--border);padding:20px 12px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh;overflow-y:auto}
.sb-brand{display:flex;align-items:center;gap:10px;padding:4px 8px 20px;font-weight:600}
.sb-logo{width:28px;height:28px;border-radius:8px;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;flex:none}
.sb-sidebar-foot{margin-top:auto;padding:12px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:4px}
.sb-main{flex:1;min-width:0;padding:40px 48px;display:flex;flex-direction:column;gap:24px}
.sb-page-h{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.sb-page-h p{margin:6px 0 0;color:var(--muted);font-size:14px}
.sb-m{display:flex;flex-direction:column;position:relative;overflow:hidden}
.sb-m-header{height:56px;flex:none;display:none;align-items:center;gap:4px;padding:0 8px 0 16px;border-bottom:1px solid var(--border);background:var(--surface)}
.sb-m-header h1{margin:0;font-size:18px;font-weight:600;flex:1}
.sb-m-header.has-back{padding-left:4px}
.sb-m-content{flex:1;padding:16px 16px 88px;display:flex;flex-direction:column;gap:16px}

/* ---------- Navigation ---------- */
.sb-nav-item{display:flex;align-items:center;gap:12px;height:40px;padding:0 12px;border-radius:8px;color:var(--muted)!important;text-decoration:none!important;font-size:14px;font-weight:500}
.sb-nav-item:hover{background:var(--surface-2);color:var(--text)!important}
.sb-nav-item.is-active{background:var(--surface-2);color:var(--text)!important;box-shadow:inset 0 0 0 1px var(--border)}
.sb-nav-item.is-active svg{color:var(--accent-text)}
.sb-nav-item:focus-visible{outline-offset:-2px}
.sb-tabbar{display:none;grid-template-columns:repeat(5,minmax(0,1fr));background:var(--tabbar);border-top:1px solid var(--border);height:64px}
.sb-tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:11px;font-weight:500;color:var(--faint)!important;text-decoration:none!important;border-radius:8px;margin:4px 2px}
.sb-tab.is-active{color:var(--accent-text)!important}
.sb-tab:focus-visible{outline-offset:-2px}

/* ---------- Cards and rows ---------- */
.sb-card{background:var(--surface);border:1px solid var(--border);border-radius:12px}
.sb-card-h{padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px}
.sb-card-b{padding:16px 20px}
.sb-card-f{padding:12px 20px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px}
.sb-kv{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px}
.sb-kv:last-child{border-bottom:0}
.sb-kv > :first-child{color:var(--muted)}
.sb-row{display:flex;align-items:center;gap:12px;padding:10px 20px;min-height:48px;border-bottom:1px solid var(--border);font-size:14px}
.sb-row:last-child{border-bottom:0}

/* ---------- Buttons ---------- */
.sb-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 16px;border-radius:8px;font:500 14px/1 'IBM Plex Sans',sans-serif;border:1px solid transparent;cursor:pointer;text-decoration:none!important;white-space:nowrap;background:transparent;color:var(--text)}
.sb-btn-primary{background:var(--accent);color:var(--on-accent)!important}
.sb-btn-primary:hover{background:var(--accent-hover)}
.sb-btn-secondary{background:var(--surface);color:var(--text);border-color:var(--border-strong)}
.sb-btn-secondary:hover{background:var(--surface-2)}
.sb-btn-ghost{color:var(--muted)}
.sb-btn-ghost:hover{background:var(--surface-2);color:var(--text)}
.sb-btn-danger{color:var(--danger);border-color:var(--danger-border)}
.sb-btn-danger:hover{background:var(--danger-hover-bg);border-color:var(--danger)}
.sb-btn-danger-fill{background:var(--danger-fill);color:var(--on-danger-fill)}
.sb-btn-danger-fill:hover{background:var(--danger-fill-hover)}
.sb-btn-icon-danger{color:var(--muted)}
.sb-btn-icon-danger:hover{background:var(--danger-hover-bg);color:var(--danger)}
.sb-btn-sm{height:32px;padding:0 12px;font-size:13px}
.sb-btn-lg{height:44px;font-size:15px}
.sb-btn-icon{width:40px;padding:0}
.sb-btn-icon.sb-btn-sm{width:32px}
.sb-btn-icon.sb-btn-lg{width:44px}
.sb-btn-block{width:100%}
.sb-btn[disabled],.sb-btn.is-disabled{opacity:.45;cursor:not-allowed;pointer-events:none}
.sb-btn.is-loading{cursor:progress;pointer-events:none;opacity:.8}
.sb-spinner{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;display:inline-block;flex:none;animation:sb-spin .8s linear infinite}
.sb-spinner-lg{width:22px;height:22px;border-width:2.5px}
@keyframes sb-spin{to{transform:rotate(360deg)}}

/* ---------- Copy button ---------- */
.sb-copy{display:inline-flex;align-items:center;gap:4px;height:28px;min-width:28px;padding:0 6px;border-radius:6px;border:0;background:transparent;color:var(--faint);cursor:pointer;font:500 12px 'IBM Plex Sans',sans-serif;vertical-align:middle}
.sb-copy:hover{background:var(--surface-2);color:var(--text)}
.sb-copy.is-copied{color:var(--success)}

/* ---------- Form controls ---------- */
.sb-field{display:flex;flex-direction:column;gap:6px}
.sb-field-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.sb-field > label,.sb-field-label{font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px}
.sb-req{font-size:11px;font-weight:500;color:var(--danger);letter-spacing:.02em}
.sb-opt{font-size:12px;font-weight:400;color:var(--muted)}
.sb-hint{font-size:12px;color:var(--muted)}
.sb-field-error{font-size:13px;color:var(--danger);display:flex;align-items:flex-start;gap:6px}
.sb-field-error svg{flex:none;margin-top:2px}
.sb-input{height:40px;width:100%;background:var(--surface);border:1px solid var(--control-border);border-radius:8px;color:var(--text);padding:0 12px;font:400 14px 'IBM Plex Sans',sans-serif}
.sb-input.sb-mono{font-family:'IBM Plex Mono',monospace;font-size:13px}
.sb-input::placeholder{color:var(--faint)}
.sb-input:hover{border-color:var(--muted)}
.sb-input:focus{outline:none;border-color:var(--focus-ring);box-shadow:0 0 0 3px var(--focus-halo)}
.sb-input.is-invalid{border-color:var(--danger)}
.sb-input.is-invalid:focus{box-shadow:0 0 0 3px var(--danger-bg)}
.sb-input[disabled],.sb-input.is-disabled{background:var(--surface-2);color:var(--faint);cursor:not-allowed;border-color:var(--border)}
.sb-input-lg{height:44px;font-size:15px}
.sb-textarea{height:auto;min-height:88px;padding:10px 12px;resize:vertical;line-height:1.5}
.sb-code-editor{height:460px;padding:14px 16px;resize:vertical;font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.65;background:var(--inset);white-space:pre;overflow:auto;tab-size:2}
.sb-select-wrap{position:relative}
.sb-select-wrap select{appearance:none;-webkit-appearance:none;padding-right:36px;cursor:pointer}
.sb-select-wrap > svg{position:absolute;right:12px;top:50%;margin-top:-8px;pointer-events:none;color:var(--muted)}
.sb-search{position:relative}
.sb-search > svg{position:absolute;left:12px;top:50%;margin-top:-8px;color:var(--faint);pointer-events:none}
.sb-search .sb-input{padding-left:36px}
.sb-input-row{display:flex;gap:8px;align-items:flex-start}

/* Secret value (never shown back) */
.sb-secret{display:flex;align-items:center;gap:10px;height:40px;padding:0 6px 0 12px;border:1px solid var(--border);border-radius:8px;background:var(--inset);font-size:14px}
.sb-secret .sb-dots{font-family:'IBM Plex Mono',monospace;letter-spacing:.15em;color:var(--faint);flex:1}

/* Checkbox */
.sb-checkbox{appearance:none;-webkit-appearance:none;width:18px;height:18px;margin:0;border:1.5px solid var(--control-border);border-radius:5px;background:var(--surface);display:inline-grid;place-content:center;cursor:pointer;flex:none}
.sb-checkbox::after{content:"";width:9px;height:5px;border-left:2px solid var(--on-accent);border-bottom:2px solid var(--on-accent);transform:rotate(-45deg) translate(1px,-1px);opacity:0}
.sb-checkbox:checked{background:var(--accent);border-color:var(--accent)}
.sb-checkbox:checked::after{opacity:1}
.sb-checkbox:indeterminate{background:var(--accent);border-color:var(--accent)}
.sb-checkbox:indeterminate::after{opacity:1;border-left:0;transform:none;width:8px;height:0}
.sb-checkbox:hover{border-color:var(--faint)}
.sb-checkbox:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.sb-checkbox[disabled]{opacity:.45;cursor:not-allowed}
.sb-check{display:flex;align-items:flex-start;gap:10px;font-size:14px;cursor:pointer}
.sb-check > .sb-checkbox{margin-top:2px}
.sb-checklist{border:1px solid var(--border);border-radius:10px;overflow:hidden}
.sb-checklist-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:13px}
.sb-checklist .sb-check{padding:10px 14px;border-bottom:1px solid var(--border)}
.sb-checklist .sb-check:last-child{border-bottom:0}
.sb-checklist .sb-check:hover{background:var(--row-hover)}
.sb-checklist-body{max-height:320px;overflow-y:auto}

/* Toggle */
.sb-toggle{width:40px;height:24px;border-radius:999px;background:var(--surface-2);border:1px solid var(--control-border);position:relative;padding:0;cursor:pointer;flex:none}
.sb-toggle span{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--faint);transition:left .15s}
.sb-toggle[aria-checked="true"]{background:var(--accent);border-color:var(--accent)}
.sb-toggle[aria-checked="true"] span{left:19px;background:var(--on-accent)}

/* Segmented control */
.sb-seg{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:3px;gap:2px}
.sb-seg button{height:32px;padding:0 14px;border:0;border-radius:7px;background:transparent;color:var(--muted);font:500 13px 'IBM Plex Sans',sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.sb-seg button:hover{color:var(--text)}
.sb-seg button.is-active{background:var(--surface);color:var(--text);box-shadow:0 0 0 1px var(--border),0 1px 2px rgba(0,0,0,.06)}
.sb-seg button:focus-visible{outline-offset:-1px}
.sb-seg-count{font-size:11px;color:var(--faint);font-family:'IBM Plex Mono',monospace}

/* ---------- Badges and state ---------- */
.sb-badge{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;font:500 12px/1 'IBM Plex Mono',monospace;border:1px solid var(--border-strong);color:var(--muted);white-space:nowrap}
.sb-badge-accent{color:var(--accent-text);border-color:var(--badge-accent-border);background:var(--badge-accent-bg)}
.sb-badge-solid{background:var(--surface-2);border-color:var(--border)}
.sb-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dot-off);flex:none}
.sb-dot-on{background:var(--success)}.sb-dot-warn{background:var(--accent)}.sb-dot-err{background:var(--danger)}
.sb-dot-half{background:linear-gradient(90deg,var(--success) 50%,var(--dot-off) 50%)}
.sb-status{display:inline-flex;align-items:center;gap:8px;font-size:14px;white-space:nowrap}
.sb-status.is-off{color:var(--muted)}
.sb-status.is-warn{color:var(--accent-text)}
.sb-status.is-err{color:var(--danger)}
.sb-status.is-on{color:var(--success)}
.sb-pill{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 12px;border-radius:999px;background:var(--success-bg);color:var(--success);font-size:13px;font-weight:500}

/* ---------- Feedback ---------- */
.sb-feedback{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--muted);min-height:20px}
.sb-feedback svg{flex:none}
.sb-feedback.is-success{color:var(--success)}
.sb-feedback.is-error{color:var(--danger)}
.sb-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);font-size:14px;color:var(--text)}
.sb-banner > svg,.sb-banner > .sb-spinner{flex:none}
.sb-banner.is-progress{color:var(--muted)}
.sb-banner.is-success{background:var(--success-bg);border-color:var(--success-border)}
.sb-banner.is-success > svg{color:var(--success)}
.sb-banner.is-error{background:var(--danger-bg);border-color:var(--danger-border-soft)}
.sb-banner.is-error > svg{color:var(--danger)}
.sb-banner .sb-banner-action{margin-left:auto}
.sb-callout{display:flex;gap:12px;padding:14px 16px;border-radius:10px;border:1px solid var(--border);font-size:14px;line-height:1.5}
.sb-callout > svg{flex:none;margin-top:1px}
.sb-callout strong{display:block;margin-bottom:2px}
.sb-callout.is-warning{background:var(--warning-bg);border-color:var(--warning-border)}
.sb-callout.is-warning > svg{color:var(--warning)}
.sb-callout.is-info{background:var(--info-bg);border-color:var(--info-border)}
.sb-callout.is-info > svg{color:var(--info)}

/* ---------- Selectable list ---------- */
.sb-list-item{display:flex;align-items:center;gap:10px;width:100%;min-height:52px;padding:8px 16px;border:0;border-bottom:1px solid var(--border);background:transparent;color:var(--text);font:500 14px 'IBM Plex Sans',sans-serif;text-align:left;cursor:pointer;text-decoration:none!important}
.sb-list-item:hover{background:var(--row-hover)}
.sb-list-item.is-active{background:var(--row-selected);box-shadow:inset 3px 0 0 var(--accent)}
.sb-list-item:focus-visible{outline-offset:-2px}
.sb-list-item .sb-chev{margin-left:auto;color:var(--faint);flex:none}
.sb-list-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sb-list-item-sub{font-size:12px;font-weight:400;color:var(--muted)}

/* ---------- Table ---------- */
.sb-table-wrap{overflow:auto}
.sb-table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}
.sb-table th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:0 16px;height:40px;border-bottom:1px solid var(--border);background:var(--surface);white-space:nowrap;position:sticky;top:0;z-index:1}
.sb-table th.is-upper{text-transform:uppercase;letter-spacing:.06em}
.sb-table td{padding:10px 16px;border-bottom:1px solid var(--border);vertical-align:top}
.sb-table tbody tr{cursor:default}
.sb-table tbody tr:hover td{background:var(--row-hover)}
.sb-table tbody tr.is-selected td{background:var(--row-selected)}
.sb-table tbody tr.is-selected td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.sb-table tbody tr:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-2px}
.sb-table.is-clickable tbody tr{cursor:pointer}
.sb-table td.is-action{width:52px;padding:4px 8px;vertical-align:middle;text-align:right}
.sb-th-sort{display:inline-flex;align-items:center;gap:4px;height:28px;margin:0 -6px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.sb-th-sort:hover{background:var(--surface-2);color:var(--text)}
.sb-th-sort .sb-sort{display:inline-flex;flex-direction:column;color:var(--border-strong)}
.sb-th-sort .sb-sort svg{display:block;margin:-3px 0}
.sb-th-sort.is-asc,.sb-th-sort.is-desc{color:var(--text)}
.sb-th-sort.is-asc .sb-sort-up,.sb-th-sort.is-desc .sb-sort-down{color:var(--accent-text)}
.sb-trunc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Cell types */
.sb-cell-null{display:inline-flex;align-items:center;height:20px;padding:0 6px;border:1px dashed var(--border-strong);border-radius:4px;font:500 11px/1 'IBM Plex Mono',monospace;color:var(--faint);letter-spacing:.04em}
.sb-cell-empty{font:400 13px 'IBM Plex Mono',monospace;color:var(--faint)}
.sb-cell-empty::before{content:'""';margin-right:6px}
.sb-cell-num{font-family:'IBM Plex Mono',monospace;font-size:13px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.sb-cell-date{font-family:'IBM Plex Mono',monospace;font-size:13px;white-space:nowrap}
.sb-cell-date span{color:var(--faint)}
.sb-cell-json{font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:var(--muted)}
.sb-cell-json b{color:var(--text);font-weight:500}
.sb-cell-md{font-size:13px}

/* Pagination */
.sb-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
.sb-pager-btns{display:flex;gap:4px}

/* ---------- Side panel ---------- */
.sb-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.sb-panel-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 12px 14px 20px;border-bottom:1px solid var(--border)}
.sb-panel-h .sb-label{display:block;margin-bottom:2px}
.sb-panel-b{flex:1;min-height:0;overflow-y:auto;padding:4px 20px 20px}
.sb-pf{display:flex;flex-direction:column;gap:6px;padding:14px 0;border-bottom:1px solid var(--border)}
.sb-pf:last-child{border-bottom:0}
.sb-pf-k{display:flex;align-items:center;justify-content:space-between;gap:8px;font:500 12px 'IBM Plex Mono',monospace;color:var(--muted)}
.sb-pf-k .sb-type{color:var(--faint);font-weight:400}
.sb-pf-v{font-size:14px;word-break:break-word}
.sb-value-block{background:var(--inset);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font:400 12.5px/1.65 'IBM Plex Mono',monospace;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;color:var(--text)}

/* ---------- Database explorer ---------- */
.sb-db-controls{display:flex;align-items:flex-end;gap:8px}
.sb-db-body{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;gap:16px}
.sb-db-mobile-bar{display:none}
.sb-db-mobile-only{display:none}
.sb-db-sort-hint{display:none}
.sb-db-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;min-width:0;flex:1;min-height:0}
.sb-db-layout.has-panel{grid-template-columns:minmax(0,1fr) 420px}
.sb-db-table-card{display:flex;flex-direction:column;min-height:0;min-width:0}
.sb-db-table-card .sb-table-wrap{flex:1;min-height:0}
.sb-db-table td{overflow:hidden}
.sb-db-skel-row{display:grid;grid-template-columns:50px 1fr 1.5fr;gap:20px;padding:14px 16px;border-bottom:1px solid var(--border)}
.sb-db-table-btn{flex:1;justify-content:space-between;padding:0 12px}
.sb-db-table-btn-main{display:flex;flex-direction:column;align-items:flex-start;gap:2px;line-height:1.1}
.sb-db-table-btn-name{font-size:14px}
.sb-db-table-btn-sub{font-size:11px}
.sb-db-pager-btn{flex:none}
.sb-db-row-nav{display:none;gap:8px;padding-top:16px}
.sb-db-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px}
.sb-db-overlay .sb-scrim{z-index:0}
.sb-db-schema{position:relative;width:100%;max-width:560px;max-height:calc(100vh - 48px)}
.sb-db-schema-scroll{flex:1;min-height:0;overflow-y:auto}
.sb-db-sheet-h{display:flex;align-items:center;justify-content:space-between;gap:12px}
.sb-db-picker{max-height:85vh}
@media (max-width:768px){
.sb-db-mobile-bar{display:flex;gap:8px}
.sb-db-mobile-only{display:block}
.sb-db-sort-hint{display:flex;align-items:center;gap:4px;margin-left:-8px}
.sb-db-layout{display:flex;flex-direction:column;gap:16px}
.sb-db-layout.has-panel{grid-template-columns:none}
.sb-db-pager-btn{width:44px;height:44px;padding:0}
.sb-db-row-nav{display:flex}
.sb-db-row-panel{border:0;border-radius:0;background:var(--surface);flex:1;min-height:0}
.sb-db-row-panel .sb-panel-h{display:none}
.sb-db-overlay{align-items:flex-end;padding:0}
.sb-db-schema{max-width:none;width:100%;max-height:85vh;border-radius:16px 16px 0 0}
.sb-sheet.sb-db-picker{position:absolute;left:0;right:0;bottom:0;border-radius:16px 16px 0 0;max-height:85vh}
.sb-sheet.sb-db-sort{position:absolute;left:0;right:0;bottom:0;border-radius:16px 16px 0 0;max-height:85vh}
}

/* ---------- Code display ---------- */
.sb-code-display{display:flex;align-items:center;justify-content:center;gap:16px;padding:20px 24px;border:1px solid var(--border);border-radius:12px;background:var(--inset)}
.sb-code-display code{font:500 36px/1 'IBM Plex Mono',monospace;letter-spacing:.18em;color:var(--text)}

/* ---------- Danger zone ---------- */
.sb-danger-zone{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border:1px solid var(--danger-border-soft);border-radius:10px;background:var(--danger-bg)}
.sb-danger-zone strong{display:block;font-size:14px}
.sb-danger-zone span{font-size:13px;color:var(--muted)}

/* ---------- Plugin list + detail ---------- */
.sb-plugins-layout{display:grid;grid-template-columns:320px minmax(0,1fr);gap:24px;align-items:start}
.sb-plugins-layout > *{min-width:0}
.sb-detail-b{padding:24px;display:flex;flex-direction:column;gap:32px}
.sb-detail-sec{display:flex;flex-direction:column;gap:14px}
.sb-detail-title{display:flex;align-items:center;gap:10px}
.sb-sec-h{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.sb-controls-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.sb-checklist.is-readonly .sb-checkbox,.sb-checklist.is-readonly .sb-checklist-h{display:none}

/* ---------- Confirm (popover / bottom sheet) ---------- */
.sb-confirm{position:relative}
.sb-confirm-pop{position:absolute;right:0;bottom:calc(100% + 10px);z-index:40}
.sb-confirm-mobile{display:none}

/* ---------- Loading and load error ---------- */
.sb-skel{display:block;height:12px;border-radius:6px;background:linear-gradient(90deg,var(--skeleton) 25%,var(--skeleton-hi) 50%,var(--skeleton) 75%);background-size:200% 100%;animation:sb-shimmer 1.4s ease-in-out infinite}
@keyframes sb-shimmer{from{background-position:100% 0}to{background-position:-100% 0}}
.sb-state{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;padding:40px 24px}
.sb-state-icon{width:44px;height:44px;border-radius:12px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;color:var(--muted)}
.sb-state.is-error .sb-state-icon{background:var(--danger-bg);color:var(--danger)}
.sb-state strong{font-size:15px}
.sb-state p{margin:0;font-size:14px;color:var(--muted);max-width:360px}

/* ---------- Popover, dialog and sheet ---------- */
.sb-popover{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:18px 20px;display:flex;flex-direction:column;gap:10px;width:340px}
.sb-popover p{margin:0;font-size:14px;color:var(--muted)}
.sb-actions{display:flex;justify-content:flex-end;gap:8px}
.sb-scrim{position:absolute;inset:0;background:var(--scrim)}
.sb-sheet{position:absolute;left:0;right:0;bottom:0;background:var(--surface);border-radius:16px 16px 0 0;box-shadow:var(--shadow);padding:8px 16px 24px;display:flex;flex-direction:column;gap:12px}
.sb-sheet-grip{width:36px;height:4px;border-radius:2px;background:var(--border-strong);margin:0 auto 8px}
.sb-dialog{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden}

/* ---------- Chat ---------- */
.sb-chat{display:flex;flex-direction:column;min-height:0}
.sb-chat-log{flex:1;min-height:0;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:18px}
.sb-msg{display:flex;flex-direction:column;gap:4px;max-width:78%}
.sb-msg-meta{font-size:12px;color:var(--muted);display:flex;gap:8px;align-items:baseline}
.sb-msg-meta b{font-weight:600;color:var(--text)}
.sb-bubble{padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.55;min-width:0}
.sb-msg-user{align-self:flex-end;align-items:flex-end}
.sb-msg-user .sb-bubble{background:var(--bubble-user);border-bottom-right-radius:4px}
.sb-msg-bot{align-self:flex-start}
.sb-msg-bot .sb-bubble{background:var(--bubble-bot);border-bottom-left-radius:4px;max-width:100%}
.sb-msg-error .sb-bubble{background:var(--danger-bg);border:1px solid var(--danger-border-soft);display:flex;gap:10px;align-items:flex-start}
.sb-msg-error .sb-bubble > svg{color:var(--danger);flex:none;margin-top:2px}
.sb-typing{display:inline-flex;gap:4px;align-items:center;padding:14px 16px}
.sb-typing i{width:6px;height:6px;border-radius:50%;background:var(--faint);animation:sb-blink 1.2s infinite}
.sb-typing i:nth-child(2){animation-delay:.2s}.sb-typing i:nth-child(3){animation-delay:.4s}
@keyframes sb-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
.sb-composer{display:flex;align-items:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border)}
.sb-composer textarea{min-height:44px;max-height:160px;height:44px;padding:11px 12px;resize:none;overflow-y:auto;line-height:1.45}
.sb-composer-hint{font-size:12px;color:var(--faint);padding:0 16px 10px}
/* Markdown inside bot messages */
.sb-md > :first-child{margin-top:0}.sb-md > :last-child{margin-bottom:0}
.sb-md p{margin:0 0 10px}
.sb-md h1,.sb-md h2,.sb-md h3{margin:14px 0 6px;line-height:1.3}
.sb-md h1{font-size:18px}.sb-md h2{font-size:16px}.sb-md h3{font-size:15px}
.sb-md ul,.sb-md ol{margin:0 0 10px;padding-left:22px}
.sb-md li{margin:2px 0}
.sb-md code{font:400 12.5px 'IBM Plex Mono',monospace;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
.sb-md pre{margin:0 0 10px;background:var(--inset);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto;font:400 12.5px/1.6 'IBM Plex Mono',monospace;white-space:pre}
.sb-md pre code{background:none;border:0;padding:0}
.sb-md blockquote{margin:0 0 10px;padding:2px 0 2px 12px;border-left:3px solid var(--border-strong);color:var(--muted)}
.sb-md a{color:var(--accent-text)}

/* ---------- Layout helpers ---------- */
.sb-stack{display:flex;flex-direction:column;gap:24px;min-width:0}
.sb-split{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px;align-items:start}
.sb-split > *{min-width:0}
.sb-row.is-selected{background:var(--row-selected)}

/* ---------- Overview ---------- */
.sb-overview{display:grid;grid-template-columns:minmax(0,1fr) 380px;grid-template-rows:minmax(0,1fr);gap:24px;flex:1;min-height:0}
.sb-overview > .sb-chat{height:100%}
.sb-overview-side{display:flex;flex-direction:column;gap:24px;min-width:0;align-self:start}
/* On desktop the overview is bounded to the viewport so only the chat log scrolls. */
.sb-app:has(.sb-chat){height:100vh}
.sb-app:has(.sb-chat) .sb-page{min-height:0}
.sb-app:has(.sb-chat) .sb-main{min-height:0;overflow:hidden}
.sb-app:has(.sb-chat) .sb-overview-side{overflow-y:auto;align-self:stretch}

/* ---------- Steps (login, captcha) ---------- */
.sb-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:14px;counter-reset:sb-step}
.sb-steps li{display:flex;gap:12px;font-size:14px;counter-increment:sb-step}
.sb-steps li::before{content:counter(sb-step);flex:none;width:24px;height:24px;border-radius:50%;background:var(--surface-2);border:1px solid var(--border);font:600 12px/22px 'IBM Plex Sans',sans-serif;text-align:center;color:var(--muted)}
.sb-centered{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 16px}
.sb-auth-card{width:100%;max-width:480px}

/* ---------- Config editor ---------- */
.sb-config-save-mobile{display:none}

/* ---------- Responsive shell ---------- */
.sb-page{flex:1;min-width:0;display:flex;flex-direction:column}
.sb-m-header .sb-logo{margin-right:8px}
.sb-m-header .sb-pill{margin-right:8px}
.sb-sidebar-foot .sb-status{font-size:13px}
.sb-sidebar-foot .sb-mono{font-size:12px}
@media (max-width:768px){
.sb-sidebar{display:none}
.sb-main{padding:16px 16px calc(88px + env(safe-area-inset-bottom,0px));gap:16px}
.sb-m-header{display:flex}
.sb-tabbar{display:grid;position:fixed;left:0;right:0;bottom:0;height:calc(64px + env(safe-area-inset-bottom,0px));padding-bottom:env(safe-area-inset-bottom,0px);z-index:20}
.sb-config-save-mobile{display:inline-flex}
.sb-page-h{display:none}
.sb-overview{display:flex;flex-direction:column;gap:16px;flex:none;min-height:0}
.sb-overview > .sb-chat{height:70vh;max-height:760px;min-height:360px}
.sb-app:has(.sb-chat){height:auto;min-height:100vh}
.sb-app:has(.sb-chat) .sb-main{overflow:visible}
.sb-overview-side{gap:16px}
.sb-stack{gap:16px}
.sb-split{grid-template-columns:minmax(0,1fr)}
.sb-sheet{position:fixed;z-index:30}
.sb-scrim{position:fixed;z-index:25}
}

/* ---------- Auth pages (provider login, Signal captcha) ---------- */
/* The hidden attribute must beat the display rules the components set. */
.sb [hidden]{display:none!important}
.sb-auth-card:has(.sb-card-wide){max-width:560px}
.sb-auth-brand{justify-content:center;font-size:17px;padding:0 0 20px}
.sb-auth-h{padding:28px 28px 8px}
.sb-auth-h h1{font-size:22px;font-weight:600;margin:4px 0 6px;letter-spacing:-.01em;line-height:1.25}
.sb-auth-h p{margin:0;font-size:14px}
.sb-auth-pad{padding:20px 28px 28px;display:flex;flex-direction:column;gap:20px}
.sb-auth-pad.is-tight{gap:16px}
.sb-auth-pad.is-list{gap:10px}
.sb-step-stack{display:flex;flex-direction:column;gap:8px;flex:1;min-width:0}
.sb-step-stack > .sb-btn{align-self:flex-start}
.sb-progress-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:13px}
.sb-progress-list .sb-status{font-size:13px}
.sb-input.sb-captcha-input{min-height:120px;font-size:12.5px}
.sb-spinner-sm{width:12px;height:12px}
.sb-state.is-success .sb-state-icon{background:var(--success-bg);color:var(--success)}
.sb-failure-msg{font-size:12.5px;background:var(--inset);border:1px solid var(--border);border-radius:8px;padding:8px 10px;max-width:100%;word-break:break-word}
.sb-btn.is-copied{color:var(--success);border-color:var(--success)}
.sb-desktop-only{display:block}
.sb-mobile-only{display:none}
.sb-steps li.sb-mobile-only{display:none}
@media (max-width:768px){
.sb-auth-brand{font-size:15px}
.sb-auth-h{padding:20px 20px 4px}
.sb-auth-h h1{font-size:20px}
.sb-auth-pad{padding:16px 20px 20px;gap:16px}
.sb-code-display{padding:16px;gap:12px}
.sb-code-display code{font-size:30px}
.sb-step-stack > .sb-btn{align-self:stretch}
.sb-desktop-only{display:none}
.sb-mobile-only{display:block}
.sb-steps li.sb-mobile-only{display:flex}
.sb-steps li.sb-desktop-only{display:none}
}

/* ---------- Split layout and detail sections (mobile) ---------- */
@media (max-width:768px){
.sb-plugins-layout{grid-template-columns:minmax(0,1fr);gap:16px}
.sb-confirm-pop{display:none!important}
.sb-confirm-mobile{display:block;position:fixed;inset:0;z-index:60}
.sb-confirm-mobile[hidden]{display:none!important}
.sb-confirm-scrim{position:absolute;inset:0;background:var(--scrim)}
.sb-detail-card{border:0;background:transparent;border-radius:0}
.sb-detail-b{padding:0;gap:20px}
.sb-detail-sec{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
.sb-detail-h{border-bottom:0;padding:0 0 4px;min-height:0;background:transparent}
.sb-detail-title{display:none}
}
`;
