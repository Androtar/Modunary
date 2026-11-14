const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
app.whenReady().then(async () => {
  const preload = path.join("E:/BannerlordModApp/dist-electron/preload.cjs");
  console.log("preload_exists", fs.existsSync(preload));
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadURL("data:text/html,<html><body>ok</body></html>");
  await new Promise(r => setTimeout(r, 500));
  const has = await win.webContents.executeJavaScript("typeof window.bannerlord");
  const keys = await win.webContents.executeJavaScript("window.bannerlord ? Object.keys(window.bannerlord).join(',') : 'MISSING'");
  console.log("bannerlord_typeof", has);
  console.log("bannerlord_keys", keys);
  app.exit(has === "object" ? 0 : 1);
});
