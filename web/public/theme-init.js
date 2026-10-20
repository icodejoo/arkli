// 首帧前按“已存主题模式 + 系统深浅色”挂 Vant 暗色类，避免白屏闪一下（外置以满足 CSP script-src 'self'）
// 键名与解析规则要和 src/shared/theme.ts 保持一致（theme.test.ts 会执行本脚本核对）
;(function () {
  var mode = 'system'
  try {
    var saved = localStorage.getItem('arkli.theme')
    if (saved === 'light' || saved === 'dark') mode = saved
  } catch (e) {
    // 存储不可用：按跟随系统
  }
  var dark = mode === 'dark' || (mode === 'system' && !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)
  var root = document.documentElement
  if (dark) root.classList.add('van-theme-dark')
  root.style.colorScheme = dark ? 'dark' : 'light'
})()
