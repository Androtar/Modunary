const { app } = require("electron");
const path = require("path");

// Register path aliases by loading compiled? We need TS services - use dynamic import of dist isn't available.
// Instead invoke through running app's IPC is better. Fallback: use electron + require source via tsx.
console.log("app_ready_smoke_skip");
app.whenReady().then(() => {
  const userData = app.getPath("userData");
  console.log("userData", userData);
  app.exit(0);
});
