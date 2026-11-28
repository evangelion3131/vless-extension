//go:build linux

package main

import (
	"testing"
)

func TestAcquireInstancePreventsDuplicates(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	acquired, err := acquireInstance()
	if err != nil {
		t.Fatal(err)
	}
	if !acquired {
		t.Fatal("first tray instance did not acquire the lock")
	}
	t.Cleanup(releaseInstance)

	acquired, err = acquireInstance()
	if err != nil {
		t.Fatal(err)
	}
	if acquired {
		t.Fatal("second tray instance acquired the lock")
	}

	releaseInstance()
	acquired, err = acquireInstance()
	if err != nil {
		t.Fatal(err)
	}
	if !acquired {
		t.Fatal("tray lock was not released")
	}
}
