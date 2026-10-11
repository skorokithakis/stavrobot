export type NavKey =
  | "overview"
  | "allowlist"
  | "plugins"
  | "database"
  | "config"
  | "settings";

interface NavItem {
  key: NavKey;
  label: string;
  href: string;
}

const DESKTOP_NAV_ITEMS: NavItem[] = [
  { key: "overview", label: "Overview", href: "/" },
  { key: "allowlist", label: "Allowlist", href: "/settings/allowlist" },
  { key: "plugins", label: "Plugins", href: "/settings/plugins" },
  { key: "database", label: "Database", href: "/explorer" },
  { key: "config", label: "Config", href: "/settings/config" },
  { key: "settings", label: "Settings", href: "/settings" },
];

const MOBILE_TAB_ITEMS: NavItem[] = [
  { key: "overview", label: "Overview", href: "/" },
  { key: "allowlist", label: "Allowlist", href: "/settings/allowlist" },
  { key: "plugins", label: "Plugins", href: "/settings/plugins" },
  { key: "database", label: "Database", href: "/explorer" },
  { key: "settings", label: "Settings", href: "/settings" },
];

const ICON_PATHS: Record<NavKey, string> = {
  overview: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"></path>',
  allowlist: '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"></path>',
  plugins:
    '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"></path>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path>',
  config:
    '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"></path><circle cx="15" cy="6" r="2"></circle><circle cx="9" cy="12" r="2"></circle><circle cx="17" cy="18" r="2"></circle>',
  settings:
    '<circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"></path>',
};

const LOGO_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3"></rect><path d="M12 7V4"></path><circle cx="9" cy="13" r="1" fill="currentColor"></circle><circle cx="15" cy="13" r="1" fill="currentColor"></circle></svg>';

export interface ShellNav {
  active: NavKey;
  model: string;
  uptime: string;
}

export interface ShellOptions {
  title: string;
  content: string;
  /** Heading shown in the mobile header. Defaults to the page title. */
  mobileTitle?: string;
  /** Omit to render a centered, navigation-free page such as login or captcha. */
  nav?: ShellNav;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderIcon(key: NavKey, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[key]}</svg>`;
}

function renderDesktopNav(active: NavKey): string {
  return DESKTOP_NAV_ITEMS.map((item) => {
    const isActive = item.key === active;
    const className = isActive ? "sb-nav-item is-active" : "sb-nav-item";
    const ariaCurrent = isActive ? ' aria-current="page"' : "";
    return `<a class="${className}" href="${item.href}"${ariaCurrent}>${renderIcon(item.key, 18)}${item.label}</a>`;
  }).join("\n");
}

// On mobile, Config is a sub-page of Settings, so it keeps the Settings tab active.
function isMobileTabActive(item: NavItem, active: NavKey): boolean {
  if (item.key === active) {
    return true;
  }
  return item.key === "settings" && active === "config";
}

function renderMobileTabs(active: NavKey): string {
  return MOBILE_TAB_ITEMS.map((item) => {
    const isActive = isMobileTabActive(item, active);
    const className = isActive ? "sb-tab is-active" : "sb-tab";
    const ariaCurrent = isActive ? ' aria-current="page"' : "";
    return `<a class="${className}" href="${item.href}"${ariaCurrent}>${renderIcon(item.key, 22)}${item.label}</a>`;
  }).join("\n");
}

function renderOnlineLabel(uptime: string): string {
  return uptime.length > 0 ? `Online · ${escapeHtml(uptime)}` : "Online";
}

export function renderPageShell(options: ShellOptions): string {
  const { nav } = options;
  const title = escapeHtml(options.title);
  const head =
    `<!DOCTYPE html>\n` +
    `<html lang="en">\n` +
    `<head>\n` +
    `<meta charset="UTF-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${title}</title>\n` +
    `<link rel="stylesheet" href="/assets/sb.css">\n` +
    `</head>\n`;

  if (nav === undefined) {
    return (
      head +
      `<body class="sb">\n` +
      `<div class="sb-centered"><div class="sb-auth-card">${options.content}</div></div>\n` +
      `</body>\n` +
      `</html>\n`
    );
  }

  const mobileTitle = escapeHtml(options.mobileTitle ?? options.title);
  const onlineLabel = renderOnlineLabel(nav.uptime);
  const body =
    `<body class="sb">\n` +
    `<div class="sb-app">\n` +
    `<nav aria-label="Main" class="sb-sidebar">\n` +
    `<div class="sb-brand"><div class="sb-logo">${LOGO_SVG}</div>Stavrobot</div>\n` +
    `${renderDesktopNav(nav.active)}\n` +
    `<div class="sb-sidebar-foot">\n` +
    `<span class="sb-status is-on"><span class="sb-dot sb-dot-on"></span>Online</span>\n` +
    `<span class="sb-mono sb-muted">${escapeHtml(nav.model)}</span>\n` +
    `</div>\n` +
    `</nav>\n` +
    `<div class="sb-page">\n` +
    `<header class="sb-m-header"><div class="sb-logo">${LOGO_SVG}</div><h1>${mobileTitle}</h1><span class="sb-pill"><span class="sb-dot sb-dot-on"></span>${onlineLabel}</span></header>\n` +
    `<main class="sb-main">${options.content}</main>\n` +
    `</div>\n` +
    `<nav aria-label="Main" class="sb-tabbar">\n` +
    `${renderMobileTabs(nav.active)}\n` +
    `</nav>\n` +
    `</div>\n` +
    `</body>\n` +
    `</html>\n`;

  return head + body;
}
