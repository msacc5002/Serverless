package main

import (
    "encoding/binary"
    "fmt"
    "log"
    "net"
    "net/http"
    "os"
    "strings"

    "github.com/gorilla/websocket"
)

var (
    upgrader = websocket.Upgrader{
        CheckOrigin: func(r *http.Request) bool {
            return true
        },
    }
    uuid string
)

func init() {
    uuid = os.Getenv("UUID")
    if uuid == "" {
        uuid = "123456"
    }
    uuid = strings.ReplaceAll(uuid, "-", "")
}

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }

    http.HandleFunc("/", handleRequest)
   log.Printf("Server is running on port %s", port)
    log.Fatal(http.ListenAndServe(":"+port, nil))
}

func handleRequest(w http.ResponseWriter, r *http.Request) {
    if websocket.IsWebSocketUpgrade(r) {
        handleWebSocket(w, r)
        return
    }

    w.WriteHeader(http.StatusOK)
    w.Write([]byte("Server is running"))
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
       log.Println("WebSocket upgrade error:", err)
        return
    }
    defer conn.Close()

   log.Println("New WebSocket connection established")

    for {
        messageType, message, err := conn.ReadMessage()
        if err != nil {
           log.Println("Read error:", err)
            return
        }

        if messageType != websocket.BinaryMessage {
           log.Println("Received non-binary message")
            continue
        }

        if err := handleProxyRequest(conn, message); err != nil {
           log.Println("Proxy error:", err)
            return
        }
    }
}

func handleProxyRequest(wsConn *websocket.Conn, message []byte) error {
    if len(message) < 18 {
        return fmt.Errorf("message too short")
    }

    version := message[0]
    id := message[1:17]

    if !validateUUID(id) {
        return fmt.Errorf("invalid UUID")
    }

    i := int(message[17]) + 19
    if len(message) < i+3 {
        return fmt.Errorf("message too short")
    }

    targetPort := binary.BigEndian.Uint16(message[i : i+2])
    i += 2
    atyp := message[i]
    i++

    var host string
    switch atyp {
    case 1:
        if len(message) < i+4 {
            return fmt.Errorf("message too short for IPv4")
        }
        host = net.IP(message[i : i+4]).String()
        i += 4
    case 2:
        if len(message) < i+1 {
            return fmt.Errorf("message too short for domain length")
        }
        domainLen := int(message[i])
        i++
        if len(message) < i+domainLen {
            return fmt.Errorf("message too short for domain name")
        }
        host = string(message[i : i+domainLen])
        i += domainLen
    case 3:
        if len(message) < i+16 {
            return fmt.Errorf("message too short for IPv6")
        }
        host = net.IP(message[i : i+16]).String()
        i += 16
    default:
        return fmt.Errorf("unknown address type")
    }

   log.Printf("Connection details: host=%s, port=%d, atyp=%d", host, targetPort, atyp)

    if err := wsConn.WriteMessage(websocket.BinaryMessage, []byte{version, 0}); err != nil {
        return fmt.Errorf("failed to send response: %w", err)
    }

    tcpConn, err := net.Dial("tcp", fmt.Sprintf("%s:%d", host, targetPort))
    if err != nil {
        return fmt.Errorf("failed to connect to target: %w", err)
    }
    defer tcpConn.Close()

    if len(message) > i {
        if _, err := tcpConn.Write(message[i:]); err != nil {
            return fmt.Errorf("failed to write initial data to target: %w", err)
        }
    }

    errChan := make(chan error, 2)

    go proxyWebSocketToTCP(wsConn, tcpConn, errChan)
    go proxyTCPToWebSocket(tcpConn, wsConn, errChan)

    err = <-errChan
    return err
}

func proxyWebSocketToTCP(wsConn *websocket.Conn, tcpConn net.Conn, errChan chan<- error) {
    for {
        _, message, err := wsConn.ReadMessage()
        if err != nil {
            errChan <- fmt.Errorf("WebSocket read error: %w", err)
            return
        }

        if _, err := tcpConn.Write(message); err != nil {
            errChan <- fmt.Errorf("TCP write error: %w", err)
            return
        }
    }
}

func proxyTCPToWebSocket(tcpConn net.Conn, wsConn *websocket.Conn, errChan chan<- error) {
    buffer := make([]byte, 4096)
    for {
        n, err := tcpConn.Read(buffer)
        if err != nil {
            errChan <- fmt.Errorf("TCP read error: %w", err)
            return
        }

        if err := wsConn.WriteMessage(websocket.BinaryMessage, buffer[:n]); err != nil {
            errChan <- fmt.Errorf("WebSocket write error: %w", err)
            return
        }
    }
}

func validateUUID(id []byte) bool {
    for i, v := range id {
        if v != hexToByte(uuid[i*2:i*2+2]) {
            return false
        }
    }
    return true
}

func hexToByte(hex string) byte {
    var b byte
    fmt.Sscanf(hex, "%02x", &b)
    return b
}
