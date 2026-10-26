/**
 * SpendWise Standalone HTTP Server (server.js)
 * Used for Local Development, Render.com, Railway, Docker, or Linux VPS
 */

const http = require('node:http');
const os = require('node:os');
const handler = require('./api/index.js');

const PORT = process.env.PORT || 3000;

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

const server = http.createServer(handler);

server.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIpAddresses();
  console.log('================================================================');
  console.log(` SpendWise Server is running on port ${PORT}!`);
  console.log('================================================================');
  console.log(` Local Access:   http://localhost:${PORT}`);
  if (localIps.length > 0) {
    console.log(` Network Access: http://${localIps[0]}:${PORT}`);
  }
  console.log('================================================================');
});
