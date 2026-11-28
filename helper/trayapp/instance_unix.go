//go:build darwin || linux

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

var instanceLock *os.File

func acquireInstance() (bool, error) {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return false, fmt.Errorf("получение каталога блокировки: %w", err)
	}
	lockDir := filepath.Join(cacheDir, "vless-eevee")
	if err := os.MkdirAll(lockDir, 0700); err != nil {
		return false, fmt.Errorf("создание каталога блокировки: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(lockDir, "tray.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return false, fmt.Errorf("открытие блокировки трея: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return false, nil
		}
		return false, fmt.Errorf("блокировка трея: %w", err)
	}
	instanceLock = file
	return true, nil
}

func releaseInstance() {
	if instanceLock == nil {
		return
	}
	_ = syscall.Flock(int(instanceLock.Fd()), syscall.LOCK_UN)
	_ = instanceLock.Close()
	instanceLock = nil
}
