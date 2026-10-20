/* global document, localStorage, window */
// Runs synchronously in <head> before the app bundle: applies the colour theme and document
// language saved by the app (src/lib/theme.ts, src/lib/i18n.ts) so the first paint is correct.
;(function () {
  var root = document.documentElement
  var theme = 'system'
  var lang = 'ta'
  try {
    var savedTheme = JSON.parse(localStorage.getItem('kadai.theme') || 'null')
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system')
      theme = savedTheme
    var savedLang = JSON.parse(localStorage.getItem('kadai.lang') || 'null')
    if (savedLang === 'ta' || savedLang === 'en') lang = savedLang
  } catch (_e) {
    // storage unavailable (private mode): keep defaults
  }
  var dark =
    theme === 'dark' ||
    (theme === 'system' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) root.classList.add('dark')
  root.style.colorScheme = dark ? 'dark' : 'light'
  root.lang = lang
})()
