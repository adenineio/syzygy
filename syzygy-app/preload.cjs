// A sandboxed preload runs as plain JavaScript with no ESM context, which is
// why this file is .cjs while the rest of the app is ESM.
//
// It exposes two version strings to the page and NOTHING else: no ipc channel,
// no require, no relay access. The pane does not read this and must not start
// to -- the moment the page branches on being inside the shell, the shell stops
// being a viewer. It is here so a human in DevTools can tell the app from a
// browser tab.
//
// It also does one thing the page cannot see: the Dock icon follows the accent
// the pane is showing. The pane records its theme as one attribute on <html>;
// this watches that attribute and sends the name, and nothing else, on one
// channel. ipcRenderer lives only in this isolated world, is never handed to
// the page, and is never used to receive.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('szg', Object.freeze({
  shell: process.env.SZG_APP_VERSION || 'dev',
  electron: process.versions.electron,
}))

let lastTheme = ''
const sendTheme = () => {
  const name = document.documentElement.dataset.theme || ''
  if (!name || name === lastTheme) return
  lastTheme = name
  ipcRenderer.send('szg:theme', name)
}

window.addEventListener('DOMContentLoaded', () => {
  sendTheme()
  new MutationObserver(sendTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
})
