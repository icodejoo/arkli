// 首帧前按系统深浅色挂 Vant 暗色类，避免白屏闪一下（外置以满足 CSP script-src 'self'）
if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('van-theme-dark')
}
