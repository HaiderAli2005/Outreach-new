/** Where the app keeps the light / dark choice on this device. */
export const THEME_KEY = "ap-theme";

/** Sections that follow the light / dark choice: the website, sign-in and its sibling pages, onboarding, the app and admin. */
const THEMED = ["/onboarding", "/app", "/admin", "/signin", "/forgot-password", "/reset-password", "/verify"];

/** True on the pages that follow the light / dark choice. */
export function themed(path: string): boolean {
  return path === "/" || THEMED.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Inline script for the root layout: sets a saved light theme on the themed pages before React paints. */
export const THEME_BOOT = `try{var p=location.pathname,t=${JSON.stringify(THEMED)};if((p==="/"||t.some(function(x){return p===x||p.indexOf(x+"/")===0}))&&localStorage.getItem("${THEME_KEY}")==="light")document.documentElement.setAttribute("data-theme","light")}catch(e){}`;
