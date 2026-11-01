// The language for messages the server writes (notifications, errors, the review CLI): settings.lang in
// goals.json, 'ja' or 'en'. One person per server, so one current language is enough; loading the goals sets it.
let lang = 'ja';
export const setLang = l => { lang = l === 'en' ? 'en' : 'ja'; };
export const getLang = () => lang;
/** Picks the text for the current language. */
export const L = (ja, en) => (lang === 'en' ? en : ja);
