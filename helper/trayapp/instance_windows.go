//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var instanceMutex syscall.Handle

func acquireInstance() (bool, error) {
	name, err := syscall.UTF16PtrFromString("Local\\vless-eevee-tray")
	if err != nil {
		return false, err
	}
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	createMutex := kernel32.NewProc("CreateMutexW")
	handle, _, callErr := createMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return false, fmt.Errorf("создание блокировки трея: %w", callErr)
	}
	if lastErr, ok := callErr.(syscall.Errno); ok && lastErr == syscall.ERROR_ALREADY_EXISTS {
		_ = syscall.CloseHandle(syscall.Handle(handle))
		return false, nil
	}
	instanceMutex = syscall.Handle(handle)
	return true, nil
}

func releaseInstance() {
	if instanceMutex == 0 {
		return
	}
	_ = syscall.CloseHandle(instanceMutex)
	instanceMutex = 0
}
