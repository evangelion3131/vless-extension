package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkDirUsesUserConfigDirectory(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configDir)

	dir, err := workDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(configDir, "vless-eevee"); dir != want {
		t.Fatalf("workDir() = %q, want %q", dir, want)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := info.Mode().Perm(), os.FileMode(0700); got != want {
		t.Fatalf("work directory permissions = %04o, want %04o", got, want)
	}
}

func TestWorkDirHonorsWorkerDataDir(t *testing.T) {
	dir := t.TempDir()
	old := workerDataDir
	workerDataDir = dir
	t.Cleanup(func() { workerDataDir = old })

	got, err := workDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != dir {
		t.Fatalf("workDir() = %q, want %q", got, dir)
	}
}

func TestDaemonRejectsSecondListener(t *testing.T) {
	listener, err := net.Listen("tcp", workerAddress)
	if err == nil {
		defer listener.Close()
	}
	got := runDaemon()
	if got == nil {
		t.Fatal("runDaemon() unexpectedly started a second worker")
	}
}
