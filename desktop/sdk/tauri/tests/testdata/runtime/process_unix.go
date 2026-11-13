//go:build !windows

package main

import "syscall"

func processRunning(pid int) bool { return syscall.Kill(pid, 0) == nil }
