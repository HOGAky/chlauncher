// Minimal mock of the standalone Roblox relay for launcher testing.
// Logs every request to stdout: METHOD path + JSON body + auth header.
const http = require('http');
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers['x-stream-key'] || req.headers['x-admin-secret'] || '';
      console.log(`${req.method} ${req.url} auth=${auth} body=${body}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  })
  .listen(9899, () => console.log('mock relay on :9899'));
