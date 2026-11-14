const { app } = require("electron");
const path = require("path");
app.setName("Modunary");
app.setPath("userData", path.join(app.getPath("appData"), "modunary"));
app.whenReady().then(async () => {
  // dynamic import compiled? use require of dist if built — instead inline minimal check
  const fs = require("fs");
  const steamapps = "D:\\Program Files (x86)\\Steam\\steamapps";
  const acf = path.join(steamapps, "appmanifest_261550.acf");
  const text = fs.readFileSync(acf, "utf8");
  const flags = (text.match(/"StateFlags"\s+"(\d+)"/)||[])[1];
  const dl = path.join(steamapps, "downloading", "261550");
  function hasFiles(dir, depth=0) {
    if (!fs.existsSync(dir) || depth>4) return false;
    for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      if (e.isFile()) return true;
      if (e.isDirectory() && hasFiles(path.join(dir,e.name), depth+1)) return true;
    }
    return false;
  }
  console.log(JSON.stringify({
    StateFlags: flags,
    downloadingExists: fs.existsSync(dl),
    downloadingHasFiles: hasFiles(dl),
    expectBusy: false,
  }));
  app.exit(0);
});
