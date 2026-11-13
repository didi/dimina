package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

type nativeSocket struct {
	mu                 sync.Mutex
	writeMu            sync.Mutex
	owner              *desktopRuntime
	id, kind           string
	ctx                context.Context
	cancel             context.CancelFunc
	closed, connecting bool
	tcp                net.Conn
	udp                *net.UDPConn
	peer               *net.UDPAddr
}

func (r *desktopRuntime) socket(id, kind string) (*nativeSocket, error) {
	if id == "" || len(id) > 160 {
		return nil, errors.New("invalid socketId")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, errors.New("window is closed")
	}
	if socket := r.sockets[id]; socket != nil {
		if socket.kind != kind {
			return nil, errors.New("socket type mismatch")
		}
		return socket, nil
	}
	active := 0
	for _, socket := range r.sockets {
		socket.mu.Lock()
		if !socket.closed {
			active++
		}
		socket.mu.Unlock()
	}
	if active >= 64 || len(r.sockets) >= 4096 {
		return nil, errors.New("too many sockets")
	}
	ctx, cancel := context.WithCancel(r.ctx)
	socket := &nativeSocket{owner: r, id: id, kind: kind, ctx: ctx, cancel: cancel}
	r.sockets[id] = socket
	return socket, nil
}
func socketAddress(p map[string]any) (string, error) {
	host := text(p, "address")
	port := number(p, "port", 0)
	if host == "" || port < 1 || port > 65535 {
		return "", errors.New("address and valid port are required")
	}
	return net.JoinHostPort(host, fmt.Sprint(port)), nil
}
func (s *nativeSocket) event(name string, value any) { s.owner.publish(s.kind+".on"+name, s.id, value) }
func (s *nativeSocket) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.cancel()
	tcp, udp := s.tcp, s.udp
	s.mu.Unlock()
	if tcp != nil {
		_ = tcp.Close()
	}
	if udp != nil {
		_ = udp.Close()
	}
	s.event("Close", map[string]any{})

}
func addressInfo(address net.Addr) map[string]any {
	host, portText, _ := net.SplitHostPort(address.String())
	var port int
	_, _ = fmt.Sscan(portText, &port)
	family := "IPv4"
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		family = "IPv6"
	}
	return map[string]any{"address": host, "port": port, "family": family}
}
func (r *desktopRuntime) socketCall(name string, p map[string]any) (any, error) {
	kind, method, _ := strings.Cut(name, ".")
	socket, err := r.socket(text(p, "socketId"), kind)
	if err != nil {
		return nil, err
	}
	socket.mu.Lock()
	closed := socket.closed
	socket.mu.Unlock()
	if closed {
		return nil, errors.New("socket is closed")
	}
	switch name {
	case "UDPSocket.bind":
		return socket.bind(number(p, "port", 0))
	case "UDPSocket.close", "TCPSocket.close":
		socket.close()
		return nil, nil
	case "UDPSocket.connect":
		address, err := socketAddress(p)
		if err != nil {
			return nil, err
		}
		peer, err := net.ResolveUDPAddr("udp", address)
		if err != nil {
			return nil, err
		}
		if _, err = socket.bind(0); err != nil {
			return nil, err
		}
		socket.mu.Lock()
		socket.peer = peer
		socket.mu.Unlock()
		return nil, nil
	case "UDPSocket.send", "UDPSocket.write":
		return nil, socket.sendUDP(p)
	case "UDPSocket.setTTL":
		ttl := number(p, "ttl", -1)
		if ttl < 0 || ttl > 255 {
			return nil, errors.New("ttl must be between 0 and 255")
		}
		if _, err = socket.bind(0); err != nil {
			return nil, err
		}
		socket.mu.Lock()
		conn := socket.udp
		socket.mu.Unlock()
		err = ipv4.NewPacketConn(conn).SetTTL(ttl)
		if err != nil {
			err = ipv6.NewPacketConn(conn).SetHopLimit(ttl)
		}
		return nil, err
	case "TCPSocket.bindWifi":
		return nil, errors.New("bindWifi is an Android-only API")
	case "TCPSocket.connect":
		address, err := socketAddress(p)
		if err != nil {
			return nil, err
		}
		timeout := number(p, "timeout", 10000)
		if timeout < 1 || timeout > 300000 {
			return nil, errors.New("invalid timeout")
		}
		socket.mu.Lock()
		if socket.connecting || socket.tcp != nil {
			socket.mu.Unlock()
			return nil, errors.New("socket is already connected or connecting")
		}
		socket.connecting = true
		socket.mu.Unlock()
		go socket.connectTCP(address, time.Duration(timeout)*time.Millisecond)
		return nil, nil
	case "TCPSocket.write":
		bytes, err := messageBytes(p["data"])
		if err != nil {
			return nil, err
		}
		socket.mu.Lock()
		conn := socket.tcp
		socket.mu.Unlock()
		if conn == nil {
			return nil, errors.New("socket is not connected")
		}
		socket.writeMu.Lock()
		defer socket.writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
		for len(bytes) > 0 {
			n, err := conn.Write(bytes)
			if err != nil {
				return nil, err
			}
			bytes = bytes[n:]
		}
		return nil, nil
	default:
		return nil, fmt.Errorf("unsupported %s method %s", kind, method)
	}
}
func (s *nativeSocket) bind(port int) (int, error) {
	if port < 0 || port > 65535 {
		return 0, errors.New("invalid port")
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return 0, errors.New("socket is closed")
	}
	if s.udp != nil {
		bound := s.udp.LocalAddr().(*net.UDPAddr).Port
		s.mu.Unlock()
		return bound, nil
	}
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil {
		s.mu.Unlock()
		return 0, err
	}
	s.udp = conn
	s.mu.Unlock()
	s.event("Listening", map[string]any{})
	go s.receiveUDP(conn)
	return conn.LocalAddr().(*net.UDPAddr).Port, nil
}
func (s *nativeSocket) sendUDP(p map[string]any) error {
	bytes, err := messageBytes(p["message"])
	if err != nil {
		return err
	}
	if _, array := p["message"].(map[string]any); array {
		offset := number(p, "offset", 0)
		length := number(p, "length", len(bytes)-offset)
		if offset < 0 || length < 0 || offset > len(bytes) || length > len(bytes)-offset {
			return errors.New("invalid offset or length")
		}
		bytes = bytes[offset : offset+length]
	}
	if len(bytes) > 65507 {
		return errors.New("UDP datagram exceeds 65507 bytes")
	}
	if _, err = s.bind(0); err != nil {
		return err
	}
	s.mu.Lock()
	conn, peer := s.udp, s.peer
	s.mu.Unlock()
	target := peer
	if text(p, "address") != "" {
		address, err := socketAddress(p)
		if err != nil {
			return err
		}
		target, err = net.ResolveUDPAddr("udp", address)
		if err != nil {
			return err
		}
	}
	if target == nil {
		return errors.New("address and port are required")
	}
	if peer != nil && (peer.Port != target.Port || !peer.IP.Equal(target.IP)) {
		return errors.New("datagram target differs from connected peer")
	}
	if boolean(p, "setBroadcast") {
		if err = setUDPBroadCast(conn); err != nil {
			return err
		}
	}
	_, err = conn.WriteToUDP(bytes, target)
	return err
}
func (s *nativeSocket) receiveUDP(conn *net.UDPConn) {
	buffer := make([]byte, 65535)
	for {
		n, remote, err := conn.ReadFromUDP(buffer)
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				s.event("Error", map[string]any{"errMsg": err.Error()})
			}
			return
		}
		s.mu.Lock()
		peer := s.peer
		s.mu.Unlock()
		if peer != nil && (peer.Port != remote.Port || !peer.IP.Equal(remote.IP)) {
			continue
		}
		info := addressInfo(remote)
		info["size"] = n
		s.event("Message", map[string]any{"message": binary(buffer[:n]), "remoteInfo": info, "localInfo": addressInfo(conn.LocalAddr())})
	}
}
func (s *nativeSocket) connectTCP(address string, timeout time.Duration) {
	conn, err := (&net.Dialer{Timeout: timeout}).DialContext(s.ctx, "tcp", address)
	s.mu.Lock()
	s.connecting = false
	if s.closed {
		s.mu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}
		return
	}
	if err != nil {
		s.mu.Unlock()
		s.event("Error", map[string]any{"errMsg": err.Error()})
		return
	}
	s.tcp = conn
	s.mu.Unlock()
	s.event("Connect", map[string]any{})
	buffer := make([]byte, 64<<10)
	for {
		n, err := conn.Read(buffer)
		if n > 0 {
			s.event("Message", map[string]any{"message": binary(buffer[:n]), "remoteInfo": addressInfo(conn.RemoteAddr()), "localInfo": addressInfo(conn.LocalAddr())})
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				s.event("Error", map[string]any{"errMsg": err.Error()})
			}
			s.close()
			return
		}
	}
}
