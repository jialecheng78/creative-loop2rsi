import type { BrowserWindowConstructorOptions } from 'electron'

export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#f4f1ea',
    title: 'Creative RSI Studio',
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: true,
    },
  }
}
