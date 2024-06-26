const net = require('net');
const WebSocket = require('ws');
const http = require('http');

const logcb = (...args) => console.log.bind(this, ...args);
const errcb = (...args) => console.error.bind(this, ...args);

const uuid = (process.env.UUID || '123456').replace(/-/g, '');

let wss;

function setupWebSocketServer() {
    console.log('Setting up WebSocket server');
    wss = new WebSocket.Server({ noServer: true });

    wss.on('connection', ws => {
        console.log("New WebSocket connection established");

        ws.on('message', msg => {
            console.log("Received message:", msg);
            
            const [VERSION] = msg;
            const id = msg.slice(1, 17);

            if (!id.every((v, i) => v === parseInt(uuid.substr(i * 2, 2), 16))) {
                console.log("Invalid UUID");
                return;
            }

            let i = msg.slice(17, 18).readUInt8() + 19;
            const targetPort = msg.slice(i, i += 2).readUInt16BE(0);
            const ATYP = msg.slice(i, i += 1).readUInt8();
            const host = ATYP === 1 ? msg.slice(i, i += 4).join('.') : 
                (ATYP === 2 ? new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8())) : 
                    (ATYP === 3 ? msg.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));

            console.log('Connection details:', { host, targetPort, ATYP });

            ws.send(new Uint8Array([VERSION, 0]));
            console.log("Sent response to client");

            const duplex = WebSocket.createWebSocketStream(ws);

            net.connect({ host, port: targetPort }, function () {
                console.log(`Connected to ${host}:${targetPort}`);
                this.write(msg.slice(i));
                duplex.on('error', (error) => {
                    console.error('Duplex error:', error);
                    errcb('E1:')(error);
                }).pipe(this).on('error', (error) => {
                    console.error('Pipe error:', error);
                    errcb('E2:')(error);
                }).pipe(duplex);
            }).on('error', (error) => {
                console.error(`Connection error to ${host}:${targetPort}:`, error);
                errcb('Conn-Err:', { host, port: targetPort })(error);
            });
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            errcb('EE:')(error);
        });

        ws.on('close', () => {
            console.log('WebSocket connection closed');
        });
    });

    return wss;
}

function handleUpgrade(req, socket, head) {
    console.log('Upgrade request received');
    if (!wss) {
        wss = setupWebSocketServer();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        console.log('Upgrade successful, emitting connection');
        wss.emit('connection', ws, req);
    });
}

function handleRequest(req, res) {
    console.log('Received HTTP request:', req.method, req.url);
    if (req.headers['upgrade'] && req.headers['upgrade'].toLowerCase() === 'websocket') {
        console.log('WebSocket upgrade request detected');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Server is running');
}

module.exports = (req, res) => {
    console.log('Serverless function called');
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
    server.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
}
