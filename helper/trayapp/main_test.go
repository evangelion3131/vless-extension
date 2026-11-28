package main

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		left, right string
		want        int
	}{
		{left: "1.10.0", right: "1.9.9", want: 1},
		{left: "1.2.3", right: "1.2.3", want: 0},
		{left: "1.2.2", right: "1.2.3", want: -1},
	}
	for _, test := range tests {
		if got := compareVersions(test.left, test.right); got != test.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", test.left, test.right, got, test.want)
		}
	}
}

func TestInstallerAssetName(t *testing.T) {
	tests := []struct {
		goos, goarch, want string
	}{
		{"linux", "amd64", "vless-eevee.v1.1.1.linux.amd64.deb"},
		{"linux", "arm64", "vless-eevee.v1.1.1.linux.arm64.deb"},
		{"windows", "amd64", "vless-eevee.v1.1.1.windows.x64.msi"},
		{"darwin", "amd64", "vless-eevee.v1.1.1.macos.x64.pkg"},
		{"darwin", "arm64", "vless-eevee.v1.1.1.macos.arm64.pkg"},
	}
	for _, test := range tests {
		if got, err := installerAssetName(test.goos, test.goarch, "1.1.1"); err != nil || got != test.want {
			t.Errorf("installerAssetName(%s, %s, 1.1.1) = %q, %v; want %q", test.goos, test.goarch, got, err, test.want)
		}
	}
	if _, err := installerAssetName("linux", "386", "1.1.1"); err == nil {
		t.Fatal("unsupported architecture was accepted")
	}
}

func TestVersionStatusText(t *testing.T) {
	if got, want := versionStatusText("1.2.3", false), "Актуальная версия ПО: v1.2.3"; got != want {
		t.Fatalf("versionStatusText(current) = %q, want %q", got, want)
	}
	if got, want := versionStatusText("1.2.4", true), "Доступно обновление ПО: v1.2.4"; got != want {
		t.Fatalf("versionStatusText(update) = %q, want %q", got, want)
	}
}

func TestRenderAboutPage(t *testing.T) {
	page, err := renderAboutPage("<script>", "about.png")
	if err != nil {
		t.Fatal(err)
	}
	text := string(page)
	for _, expected := range []string{
		"vless-eevee 🦊",
		"Private proxy. Just for your browser.",
		"Windows · macOS · Linux",
		`src="about.png"`,
		"window.moveTo(",
		"screen.availWidth - window.outerWidth",
		"&lt;script&gt;",
		"https://github.com/evangelion3131/vless-extension/releases",
	} {
		if !strings.Contains(text, expected) {
			t.Errorf("about page does not contain %q", expected)
		}
	}
	if strings.Contains(text, `<p class="version">Версия helper: <script>`) {
		t.Fatal("about page did not escape the version")
	}
}

func TestAboutWindowSize(t *testing.T) {
	args := aboutWindowArgs("file:///about.html")
	if len(args) != 2 || args[0] != "--app=file:///about.html" || args[1] != "--window-size=450,545" {
		t.Fatalf("aboutWindowArgs() = %v, want app URL and 450x545 window", args)
	}
}

func TestDownloadAndExtractExtension(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "config")
	t.Setenv("XDG_CONFIG_HOME", configDir)
	archiveData := extensionArchive(t, map[string]string{
		"manifest.json": `{"version":"1.2.3"}`,
		"background.js": "self.test = true;",
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archiveData)
	}))
	defer server.Close()

	dir, err := downloadAndExtractExtension(server.Client(), server.URL, "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "background.js")); err != nil || string(got) != "self.test = true;" {
		t.Fatalf("extracted file = %q, err = %v", got, err)
	}
}

func TestDownloadAndExtractExtensionRejectsInvalidArchives(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "config")
	t.Setenv("XDG_CONFIG_HOME", configDir)
	for _, files := range []map[string]string{
		{"manifest.json": `{"version":"1.2.3"}`, "../outside.txt": "not allowed"},
		{"manifest.json": `{"version":"1.2.2"}`},
	} {
		archiveData := extensionArchive(t, files)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write(archiveData)
		}))
		_, err := downloadAndExtractExtension(server.Client(), server.URL, "1.2.3")
		server.Close()
		if err == nil {
			t.Fatal("invalid extension archive was accepted")
		}
	}
	if _, err := os.Stat(filepath.Join(configDir, "vless-eevee", "outside.txt")); !os.IsNotExist(err) {
		t.Fatalf("traversal destination exists or could not be checked: %v", err)
	}
}

func extensionArchive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var result bytes.Buffer
	writer := zip.NewWriter(&result)
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}
