export type IconId =
  | "arr" | "check" | "globe" | "shield" | "key" | "flame" | "rotate" | "plus" | "minus" | "x" | "lock" | "inbox" | "alert"
  | "back" | "plane" | "sparkle" | "chev" | "pin" | "at" | "search" | "home" | "users" | "target" | "ban" | "gear" | "card"
  | "pulse" | "logout" | "menu" | "download" | "upload" | "power" | "calendar" | "list" | "building" | "link"
  | "store" | "factory" | "coins" | "truck" | "megaphone" | "heart" | "cpu" | "briefcase" | "page" | "sliders"
  | "st-user" | "st-scan" | "st-mail" | "st-gauge" | "st-card" | "st-send";

export function Icon({ id, className }: { id: IconId; className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href={id.startsWith("st-") ? `#${id}` : `#i-${id}`} />
    </svg>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href="#mark" />
    </svg>
  );
}

const S = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

const SPRITE = `
<defs>
<linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F3E2C3"/><stop offset=".5" stop-color="#D4AE72"/><stop offset="1" stop-color="#A67B5B"/></linearGradient>
<linearGradient id="gGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F7E6C2"/><stop offset=".5" stop-color="#D9B57A"/><stop offset="1" stop-color="#9E7545"/></linearGradient>
<linearGradient id="gGoldD" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C79B5E"/><stop offset="1" stop-color="#7C5A34"/></linearGradient>
<linearGradient id="gGoldL" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF6E2"/><stop offset="1" stop-color="#E4C48E"/></linearGradient>
</defs>
<symbol id="mark" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13.2" fill="none" stroke="url(#lg)" stroke-width="1.6"/><path d="M19.11 4.41L24.78 24.18M27.59 12.89L13.30 27.69M24.49 24.49L4.52 19.51M12.89 27.59L7.22 7.82M4.41 19.11L18.70 4.31M7.51 7.51L27.48 12.49" stroke="url(#lg)" stroke-width="1.4" stroke-linecap="round" fill="none"/></symbol>
<symbol id="i-arr" viewBox="0 0 20 20"><path d="M4 10h11m-4.5-4.5L15 10l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-check" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-globe" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/></g></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6L12 3z M8.8 12.2l2.2 2.2 4.4-4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></symbol>
<symbol id="i-key" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8m-3 3l2.5 2.5M14 9l2 2"/></g></symbol>
<symbol id="i-flame" viewBox="0 0 24 24"><path d="M12 21c-3.9 0-6.5-2.7-6.5-6.2 0-3.8 3.2-5.6 3.9-9.8 2.6 1.6 4.1 3.8 4.4 6.4 1-.7 1.6-1.8 1.8-3.1 1.9 1.7 2.9 4 2.9 6.5 0 3.5-2.6 6.2-6.5 6.2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
<symbol id="i-rotate" viewBox="0 0 24 24"><g ${S}><path d="M20 12a8 8 0 01-13.7 5.6M4 12a8 8 0 0113.7-5.6"/><path d="M18 3v4h-4M6 21v-4h4"/></g></symbol>
<symbol id="i-plus" viewBox="0 0 12 12"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-minus" viewBox="0 0 12 12"><path d="M1.5 6h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-x" viewBox="0 0 12 12"><path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 017 0v2.7"/></g></symbol>
<symbol id="i-inbox" viewBox="0 0 24 24"><g ${S}><path d="M4 13l2.2-7.2A2 2 0 018.1 4.4h7.8a2 2 0 011.9 1.4L20 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5z"/><path d="M4 13h4.5l1.2 2.5h4.6l1.2-2.5H20"/></g></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3.5l9.5 16.5h-19L12 3.5z" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.4v.1"/></g></symbol>
<symbol id="i-back" viewBox="0 0 20 20"><path d="M16 10H5m4.5-4.5L5 10l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-plane" viewBox="0 0 24 24"><path d="M20.5 3.5L3.5 10.2l6.6 2.6 2.6 6.7 7.8-16zM10.1 12.8l4.4-4.4" ${S}/></symbol>
<symbol id="i-sparkle" viewBox="0 0 24 24"><path d="M11 3.5l1.9 5.6 5.6 1.9-5.6 1.9L11 18.5l-1.9-5.6L3.5 11l5.6-1.9L11 3.5zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></symbol>
<symbol id="i-chev" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-pin" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.3"/></g></symbol>
<symbol id="i-at" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.4 2.4 0 004.8 0V12a8.4 8.4 0 10-3.3 6.7"/></g></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/></g></symbol>
<symbol id="i-home" viewBox="0 0 24 24"><g ${S}><path d="M4 11l8-6.5 8 6.5V19a1.5 1.5 0 01-1.5 1.5H14v-5h-4v5H5.5A1.5 1.5 0 014 19z"/></g></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><g ${S}><circle cx="9" cy="8.5" r="3.3"/><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 010 5.8M17.5 14.8c1.7.6 2.8 2.2 3 4.7"/></g></symbol>
<symbol id="i-target" viewBox="0 0 24 24"><g ${S}><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2"/></g></symbol>
<symbol id="i-ban" viewBox="0 0 24 24"><g ${S}><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></g></symbol>
<symbol id="i-gear" viewBox="0 0 24 24"><g ${S}><circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6"/></g></symbol>
<symbol id="i-card" viewBox="0 0 24 24"><g ${S}><rect x="3.5" y="6" width="17" height="12" rx="2.2"/><path d="M3.5 10h17M7 14.5h3"/></g></symbol>
<symbol id="i-pulse" viewBox="0 0 24 24"><path d="M3 12h4l2.2-5 4.6 10 2.2-5h5" ${S}/></symbol>
<symbol id="i-logout" viewBox="0 0 24 24"><g ${S}><path d="M14 4.5H6.5A1.5 1.5 0 005 6v12a1.5 1.5 0 001.5 1.5H14"/><path d="M10 12h10m-3.5-3.5L20 12l-3.5 3.5"/></g></symbol>
<symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" ${S}/></symbol>
<symbol id="i-download" viewBox="0 0 24 24"><g ${S}><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/></g></symbol>
<symbol id="i-upload" viewBox="0 0 24 24"><g ${S}><path d="M12 15.5v-11m-4.5 4.5L12 4.5 16.5 9"/><path d="M5 19.5h14"/></g></symbol>
<symbol id="i-power" viewBox="0 0 24 24"><g ${S}><path d="M12 3.5v8"/><path d="M7 6.5a7.5 7.5 0 1010 0"/></g></symbol>
<symbol id="i-calendar" viewBox="0 0 24 24"><g ${S}><rect x="4" y="5.5" width="16" height="14" rx="2.2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></g></symbol>
<symbol id="i-list" viewBox="0 0 24 24"><path d="M9 7h11M9 12h11M9 17h11M4.5 7h.1M4.5 12h.1M4.5 17h.1" ${S}/></symbol>
<symbol id="i-link" viewBox="0 0 16 16"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="st-user" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/></g></symbol>
<symbol id="st-scan" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3.5l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7z"/><path d="M18.5 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></g></symbol>
<symbol id="st-mail" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5" stroke-linecap="round"/></g></symbol>
<symbol id="st-gauge" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 17a8 8 0 1115 0"/><path d="M12 13.5l3.5-3.5"/><circle cx="12" cy="14" r="1.2" fill="currentColor"/></g></symbol>
<symbol id="st-card" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 10h17M7 14.5h3"/></g></symbol>
<symbol id="st-send" viewBox="0 0 24 24"><path d="M20.5 3.5L3.5 10.2l6.6 2.6 2.6 6.7 7.8-16zM10.1 12.8l4.4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></symbol>
<symbol id="i-store" viewBox="0 0 24 24"><g ${S}><path d="M4 9.5l1.4-5h13.2l1.4 5M4 9.5h16M4 9.5a2.7 2.7 0 005.3 0 2.7 2.7 0 005.4 0 2.7 2.7 0 005.3 0"/><path d="M5.5 12v8h13v-8M10 20v-4.5h4V20"/></g></symbol>
<symbol id="i-factory" viewBox="0 0 24 24"><g ${S}><path d="M3.5 20.5V11l5 3v-3l5 3v-3l5 3V4.5h2v16z"/><path d="M3.5 20.5h17M7.5 17.5h2M12 17.5h2"/></g></symbol>
<symbol id="i-coins" viewBox="0 0 24 24"><g ${S}><ellipse cx="9" cy="7" rx="5.5" ry="2.5"/><path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7"/><path d="M9.5 16.5c.9.3 2 .5 3.5.5 3 0 5.5-1.1 5.5-2.5v-4c0-1.1-1.5-2-3.6-2.3"/><path d="M18.5 14.5v4c0 1.4-2.5 2.5-5.5 2.5s-5.5-1.1-5.5-2.5v-2"/></g></symbol>
<symbol id="i-truck" viewBox="0 0 24 24"><g ${S}><path d="M2.5 6.5h11v10h-11zM13.5 10h4l3 3.5v3h-7"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></g></symbol>
<symbol id="i-megaphone" viewBox="0 0 24 24"><g ${S}><path d="M4 10v4a1.5 1.5 0 001.5 1.5H7l5 4v-15l-5 4H5.5A1.5 1.5 0 004 10z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11"/></g></symbol>
<symbol id="i-heart" viewBox="0 0 24 24"><g ${S}><path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0112 7a4.2 4.2 0 017.5 2.5c0 5.6-7.5 10-7.5 10z"/></g></symbol>
<symbol id="i-cpu" viewBox="0 0 24 24"><g ${S}><rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/><rect x="10" y="10" width="4" height="4" rx=".6"/></g></symbol>
<symbol id="i-briefcase" viewBox="0 0 24 24"><g ${S}><rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 6v1.5M3.5 12.5h17"/></g></symbol>
<symbol id="i-page" viewBox="0 0 24 24"><g ${S}><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h6"/></g></symbol>
<symbol id="i-sliders" viewBox="0 0 24 24"><g ${S}><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></g></symbol>
<symbol id="i-building"viewBox="0 0 24 24"><g ${S}><path d="M5 20.5V5a1.5 1.5 0 011.5-1.5h7A1.5 1.5 0 0115 5v15.5M15 9.5h3.5A1.5 1.5 0 0120 11v9.5M3.5 20.5h17"/><path d="M8.5 7.5h3M8.5 11h3M8.5 14.5h3"/></g></symbol>
`;

export function IconSprite() {
  return <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: SPRITE }} />;
}
