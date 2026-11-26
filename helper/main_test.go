package main

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestWorkDirUsesUserConfigDirectory(t *testing.T) {
	configDir := t.TempDir()
	configEnv := "XDG_CONFIG_HOME"
	if runtime.GOOS == "windows" {
		configEnv = "APPDATA"
	}
	t.Setenv(configEnv, configDir)

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
	if runtime.GOOS != "windows" {
		if got, want := info.Mode().Perm(), os.FileMode(0700); got != want {
			t.Fatalf("work directory permissions = %04o, want %04o", got, want)
		}
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

func TestFetchSubReturnsHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Profile-Title", "Example subscription")
		w.Header().Set("Subscription-Userinfo", "upload=10; download=20; total=100; expire=200")
		_, _ = w.Write([]byte("subscription body"))
	}))
	defer server.Close()

	body, headers, err := fetchSub(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if body != "subscription body" {
		t.Fatalf("body = %q, want subscription body", body)
	}
	if got := headers.Get("Profile-Title"); got != "Example subscription" {
		t.Fatalf("Profile-Title = %q, want Example subscription", got)
	}
	if got := headers.Get("Subscription-Userinfo"); got != "upload=10; download=20; total=100; expire=200" {
		t.Fatalf("Subscription-Userinfo = %q, want subscription metadata", got)
	}
}

func TestMeasureHTTPSDownloadReadsBoundedPayload(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 64*1024)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "65536")
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	tlsConfig := server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	conn, err := tls.Dial("tcp", target.Host, tlsConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	mbps, err := measureHTTPSDownload(conn, target.Host, "/download", len(payload))
	if err != nil {
		t.Fatal(err)
	}
	if mbps <= 0 || math.IsInf(mbps, 0) || math.IsNaN(mbps) {
		t.Fatalf("measured speed = %v Mbps, want a finite positive value", mbps)
	}
}

func TestLongRunningCommandsAreDispatchedAsynchronously(t *testing.T) {
	for _, cmd := range []string{"fetchSub", "latency", "speed"} {
		if !isLongRunningCommand(cmd) {
			t.Errorf("%q should be dispatched asynchronously", cmd)
		}
	}
	if isLongRunningCommand("status") {
		t.Fatal("status should remain synchronous")
	}
}

func TestConcurrentNativeMessageWritesKeepFramesIntact(t *testing.T) {
	const count = 100
	var output bytes.Buffer
	var writers sync.WaitGroup
	for id := 0; id < count; id++ {
		writers.Add(1)
		go func(id int) {
			defer writers.Done()
			writeMessage(&output, response{ID: id, OK: true})
		}(id)
	}
	writers.Wait()

	reader := bytes.NewReader(output.Bytes())
	seen := make(map[int]bool, count)
	for i := 0; i < count; i++ {
		var length uint32
		if err := binary.Read(reader, binary.LittleEndian, &length); err != nil {
			t.Fatalf("read frame length: %v", err)
		}
		frame := make([]byte, length)
		if _, err := io.ReadFull(reader, frame); err != nil {
			t.Fatalf("read frame body: %v", err)
		}
		var got response
		if err := json.Unmarshal(frame, &got); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if seen[got.ID] {
			t.Fatalf("duplicate response ID %d", got.ID)
		}
		seen[got.ID] = true
	}
	if reader.Len() != 0 {
		t.Fatalf("%d unexpected trailing bytes", reader.Len())
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

func TestStopKeepsSharedTunnelUntilLastClientDisconnects(t *testing.T) {
	oldPort, oldCmd, oldDone := xrayPort, xrayCmd, xrayDone
	oldClients, oldServer, oldKey := activeClients, activeServer, activeKey
	t.Cleanup(func() {
		xrayPort, xrayCmd, xrayDone = oldPort, oldCmd, oldDone
		activeClients, activeServer, activeKey = oldClients, oldServer, oldKey
	})

	xrayCmd, xrayDone = nil, nil
	xrayPort = 1080
	activeClients = map[string]time.Time{
		"profile-a": time.Now(),
		"profile-b": time.Now(),
	}
	activeServer = &serverMetadata{Name: "Current", Host: "example.com", Port: 443, Protocol: "vless"}
	activeKey = "shared"

	res := handle(request{ID: 1, Cmd: "stop", ClientID: "profile-a"})
	if !res.OK || res.ClientConnected || res.Port != 1080 || res.Server == nil {
		t.Fatalf("first stop response = %+v, want shared connection retained", res)
	}
	if _, active := activeClients["profile-b"]; !active {
		t.Fatal("other profile was disconnected")
	}

	res = handle(request{ID: 2, Cmd: "stop", ClientID: "profile-b"})
	if !res.OK || res.Port != 0 || res.Server != nil {
		t.Fatalf("last stop response = %+v, want tunnel stopped", res)
	}
}

func TestStartingSameConfigReusesSharedTunnel(t *testing.T) {
	oldPort, oldCmd, oldDone := xrayPort, xrayCmd, xrayDone
	oldClients, oldServer, oldKey := activeClients, activeServer, activeKey
	t.Cleanup(func() {
		xrayPort, xrayCmd, xrayDone = oldPort, oldCmd, oldDone
		activeClients, activeServer, activeKey = oldClients, oldServer, oldKey
	})

	req := request{
		ID:       1,
		Cmd:      "start",
		ClientID: "profile-b",
		Config:   json.RawMessage(`{"outbounds":[{"protocol":"vless"}]}`),
		Server:   &serverMetadata{Name: "Same server", Host: "example.com", Port: 443, Protocol: "vless"},
	}
	xrayCmd, xrayDone = nil, nil
	xrayPort = 1080
	activeClients = map[string]time.Time{"profile-a": time.Now()}
	activeServer = &serverMetadata{Name: "Previous label", Host: "example.com", Port: 443, Protocol: "vless"}
	activeKey = connectionKey(req)

	res := handle(req)
	if !res.OK || !res.ClientConnected || res.Port != 1080 {
		t.Fatalf("start response = %+v, want existing tunnel reused", res)
	}
	if _, active := activeClients["profile-a"]; !active {
		t.Fatal("starting the same server disconnected the first profile")
	}
	if res.Server == nil || res.Server.Name != "Same server" {
		t.Fatalf("server metadata = %+v, want new display name", res.Server)
	}

	res = handle(request{ID: 2, Cmd: "status", ClientID: "profile-a"})
	if !res.ClientConnected || res.Server == nil || res.Server.Name != "Same server" {
		t.Fatalf("other profile status = %+v, want synchronized server", res)
	}
}
