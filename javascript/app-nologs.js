const net = require('net');
const WebSocket = require('ws');
const http = require('http');

const errcb = (prefix) => (error) => {};

const uuid = (process.env.UUID || '123456').replace(/-/g, '');

let wss;

function setupWebSocketServer() {
    wss = new WebSocket.Server({ noServer: true });

    wss.on('connection', ws => {
        ws.on('message', msg => {
            const [VERSION] = msg;
            const id = msg.slice(1, 17);

            if (!id.every((v, i) => v === parseInt(uuid.substr(i * 2, 2), 16))) {
                return;
            }

            let i = msg.slice(17, 18).readUInt8() + 19;
            const targetPort = msg.slice(i, i += 2).readUInt16BE(0);
            const ATYP = msg.slice(i, i += 1).readUInt8();
            const host = ATYP === 1 ? msg.slice(i, i += 4).join('.') : 
                (ATYP === 2 ? new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8())) : 
                    (ATYP === 3 ? msg.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));

            ws.send(new Uint8Array([VERSION, 0]));

            const duplex = WebSocket.createWebSocketStream(ws);

            net.connect({ host, port: targetPort }, function () {
                this.write(msg.slice(i));
                duplex.on('error', errcb('E1:')).pipe(this).on('error', errcb('E2:')).pipe(duplex);
            }).on('error', errcb('Conn-Err:'));
        });

        ws.on('error', errcb('WS-Err:'));
    });

    return wss;
}

function handleUpgrade(req, socket, head) {
    if (!wss) {
        wss = setupWebSocketServer();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
}

function handleRequest(req, res) {
    if (req.headers['upgrade'] && req.headers['upgrade'].toLowerCase() === 'websocket') {
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Server is running');
}

module.exports = (req, res) => {
    if (req.headers['upgrade'] && req.headers['upgrade'].toLowerCase() === 'websocket') {
        handleUpgrade(req, req.socket, Buffer.alloc(0));
    } else {
        handleRequest(req, res);
    }
};

if (require.main === module) {
    const port = process.env.PORT || 3000;
    const server = http.createServer(handleRequest);
    server.on('upgrade', handleUpgrade);
    server.listen(port, () => {});
}
