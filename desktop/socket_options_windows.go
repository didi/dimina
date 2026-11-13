package main

import (
	"net"
	"syscall"
)

func setUDPBroadCast(conn *net.UDPConn) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var option error
	err = raw.Control(func(fd uintptr) {
		option = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
	})
	if err != nil {
		return err
	}
	return option
}
