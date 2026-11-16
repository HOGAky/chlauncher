const { spawn } = require("child_process");
const fs = require("fs");
const c = spawn("node", ["dist/sidecar.js", "_m_e_n__"], { stdio: ["pipe", "pipe", "inherit"] });
fs.createReadStream("_boot.txt").pipe(c.stdin);
const out = fs.createWriteStream("_sidecar-out.txt");
c.stdout.pipe(out);
setTimeout(() => { c.kill(); process.exit(0); }, 35000);
