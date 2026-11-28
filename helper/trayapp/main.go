package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	_ "embed"

	"github.com/getlantern/systray"
)

//go:embed icon.png
var icon []byte

//go:embed assets/about.png
var aboutImage []byte

var appVersion = "0.0.0"
var versionStatusItem *systray.MenuItem

const (
	releasesAPI     = "https://api.github.com/repos/evangelion3131/vless-extension/releases/latest"
	releasesURL     = "https://github.com/evangelion3131/vless-extension/releases/latest"
	aboutWindowSize = "450,545"
)

var aboutPageTemplate = template.Must(template.New("about").Parse(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>О программе — vless-eevee</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", sans-serif; color: #f4f0ff; background: #100b1b; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 360px; min-height: 100vh; display: grid; place-items: center; padding: 32px; }
    main { width: min(680px, 100%); text-align: center; }
    .logo { width: 144px; height: 144px; object-fit: contain; filter: drop-shadow(0 12px 30px #8b5cf677); }
    h1 { margin: 14px 0 6px; font-size: 34px; letter-spacing: -.04em; }
    .tagline { margin: 0; color: #c4b5fd; font-size: 17px; font-weight: 650; }
    .description { max-width: 560px; margin: 16px auto 24px; color: #c5bfd1; line-height: 1.65; }
    .badges { display: flex; flex-wrap: wrap; justify-content: center; gap: 9px; margin: 22px 0 28px; }
    .badge { padding: 8px 12px; border: 1px solid #44365c; border-radius: 999px; background: #1b1429; color: #ddd4f3; font-size: 12px; }
    .actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 12px; }
    a { color: #fff; text-decoration: none; font-weight: 650; }
    .button { display: inline-block; padding: 11px 17px; border: 1px solid #8058d6; border-radius: 10px; background: #7044c7; }
    .button.secondary { background: #1b1429; border-color: #44365c; }
    .version { margin-top: 22px; color: #9c91ac; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <img class="logo" src="{{.IconURL}}" alt="vless-eevee">
    <h1>vless-eevee 🦊</h1>
    <p class="tagline">Private proxy. Just for your browser.</p>
    <p class="description">Лёгкий VLESS-прокси для Chrome, Brave и Chromium. Подключайтесь к своим серверам прямо в браузере — остальные приложения продолжают работать через обычное соединение.</p>
    <div class="badges">
      <span class="badge">Windows · macOS · Linux</span>
      <span class="badge">Chrome · Brave · Chromium</span>
      <span class="badge">VLESS</span>
      <span class="badge">Только для браузера</span>
    </div>
    <div class="actions">
      <a class="button" href="https://github.com/evangelion3131/vless-extension/releases">Скачать последнюю версию</a>
      <a class="button secondary" href="https://github.com/evangelion3131/vless-extension">Проект на GitHub</a>
    </div>
    <p class="version">Версия helper: {{.Version}}</p>
  </main>
  <script>
    window.addEventListener("load", () => {
      window.moveTo(
        Math.round(screen.availLeft + (screen.availWidth - window.outerWidth) / 2),
        Math.round(screen.availTop + (screen.availHeight - window.outerHeight) / 2)
      );
    });
  </script>
</body>
</html>`))

type release struct {
	TagName string        `json:"tag_name"`
	Assets  []releaseItem `json:"assets"`
}

type releaseItem struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

func main() {
	acquired, err := acquireInstance()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if !acquired {
		return
	}
	defer releaseInstance()

	dataDir := parseDataDir(os.Args[1:])
	systray.Run(func() {
		systray.SetTemplateIcon(icon, icon)
		systray.SetTitle("vless-eevee")
		systray.SetTooltip("vless-eevee")
		versionStatusItem = systray.AddMenuItem("Версия helper: v"+appVersion, "Статус проверки обновлений")
		versionStatusItem.Disable()
		aboutItem := systray.AddMenuItem("О программе", "Информация о vless-eevee")
		checkItem := systray.AddMenuItem("Проверить обновления", "Проверить GitHub Releases")
		exitItem := systray.AddMenuItem("Выход", "Закрыть значок в трее")
		go func() {
			for {
				select {
				case <-aboutItem.ClickedCh:
					go func() {
						if err := showAboutWindow(); err != nil {
							setErrorTooltip(err)
						}
					}()
				case <-checkItem.ClickedCh:
					go checkUpdates(dataDir)
				case <-exitItem.ClickedCh:
					systray.Quit()
					return
				}
			}
		}()
	}, func() {})
}

func parseDataDir(args []string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-data-dir" {
			return args[i+1]
		}
	}
	return ""
}

func showAboutWindow() error {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return fmt.Errorf("получение каталога окна «О программе»: %w", err)
	}
	aboutDir := filepath.Join(cacheDir, "vless-eevee", "about")
	if err := os.MkdirAll(aboutDir, 0700); err != nil {
		return fmt.Errorf("создание каталога окна «О программе»: %w", err)
	}
	iconPath := filepath.Join(aboutDir, "about.png")
	if err := os.WriteFile(iconPath, aboutImage, 0600); err != nil {
		return fmt.Errorf("сохранение иконки окна «О программе»: %w", err)
	}
	page, err := renderAboutPage(appVersion, "about.png")
	if err != nil {
		return fmt.Errorf("подготовка окна «О программе»: %w", err)
	}
	pagePath := filepath.Join(aboutDir, "index.html")
	if err := os.WriteFile(pagePath, page, 0600); err != nil {
		return fmt.Errorf("сохранение окна «О программе»: %w", err)
	}
	if err := openAboutWindow(fileURL(pagePath), pagePath); err != nil {
		return fmt.Errorf("открытие окна «О программе»: %w", err)
	}
	return nil
}

func renderAboutPage(version, iconURL string) ([]byte, error) {
	var page bytes.Buffer
	if err := aboutPageTemplate.Execute(&page, struct {
		Version string
		IconURL string
	}{Version: version, IconURL: iconURL}); err != nil {
		return nil, err
	}
	return page.Bytes(), nil
}

func fileURL(filePath string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(filePath)}).String()
}

func aboutWindowArgs(pageURL string) []string {
	return []string{"--app=" + pageURL, "--window-size=" + aboutWindowSize}
}

func openAboutWindow(pageURL, pagePath string) error {
	if browser := findAboutBrowser(); browser != "" {
		if err := exec.Command(browser, aboutWindowArgs(pageURL)...).Start(); err == nil {
			return nil
		}
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", pagePath)
	case "darwin":
		cmd = exec.Command("open", pagePath)
	case "linux":
		cmd = exec.Command("xdg-open", pagePath)
	default:
		return fmt.Errorf("открытие окна не поддерживается на %s", runtime.GOOS)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return nil
}

func findAboutBrowser() string {
	switch runtime.GOOS {
	case "linux":
		for _, name := range []string{
			"google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
			"brave-browser", "microsoft-edge",
		} {
			if browser, err := exec.LookPath(name); err == nil {
				return browser
			}
		}
	case "darwin":
		for _, browser := range []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		} {
			if _, err := os.Stat(browser); err == nil {
				return browser
			}
		}
	case "windows":
		for _, dir := range []string{
			os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA"),
		} {
			if dir == "" {
				continue
			}
			for _, relative := range []string{
				"Google/Chrome/Application/chrome.exe",
				"BraveSoftware/Brave-Browser/Application/brave.exe",
				"Chromium/Application/chrome.exe",
				"Microsoft/Edge/Application/msedge.exe",
			} {
				browser := filepath.Join(dir, relative)
				if _, err := os.Stat(browser); err == nil {
					return browser
				}
			}
		}
	}
	return ""
}

func checkUpdates(dataDir string) {
	setVersionStatus("Проверяю обновления…")
	systray.SetTooltip("Проверяю обновления…")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 25 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesAPI, nil)
	if err != nil {
		setErrorTooltip(err)
		return
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "vless-eevee")
	resp, err := client.Do(req)
	if err != nil {
		setErrorTooltip(err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		setErrorTooltip(fmt.Errorf("GitHub ответил: %s", resp.Status))
		return
	}
	var latest release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&latest); err != nil {
		setErrorTooltip(err)
		return
	}
	latestVersion := strings.TrimPrefix(latest.TagName, "v")
	if _, ok := parseVersion(latestVersion); !ok {
		setErrorTooltip(fmt.Errorf("неверная версия релиза %q", latest.TagName))
		return
	}
	helperUpdate := compareVersions(latestVersion, appVersion) > 0
	if helperUpdate {
		setVersionStatus(versionStatusText(latestVersion, true))
	}
	var installerURL string
	if helperUpdate {
		assetName, err := installerAssetName(runtime.GOOS, runtime.GOARCH, latestVersion)
		if err != nil {
			setErrorTooltip(err)
			return
		}
		assetURL, ok := releaseAsset(latest, assetName)
		if !ok {
			setErrorTooltip(fmt.Errorf("в релизе нет %s", assetName))
			return
		}
		installerURL = assetURL
	}

	currentExtension, err := readInstalledExtensionVersion(dataDir)
	if err != nil {
		if helperUpdate {
			launchHelperUpdate(client, installerURL, latestVersion)
			return
		}
		setErrorTooltip(err)
		return
	}
	extensionUpdate := compareVersions(latestVersion, currentExtension) > 0
	var extensionDir string
	var extensionErr error
	if extensionUpdate {
		extensionZipURL, ok := releaseAsset(latest, "vless-eevee.extension.zip")
		if !ok {
			extensionErr = fmt.Errorf("в релизе нет архива расширения")
		} else {
			extensionDir, extensionErr = downloadAndExtractExtension(client, extensionZipURL, latestVersion)
			if extensionErr == nil {
				if err := openExtensionsPage(); err != nil {
					extensionErr = fmt.Errorf("не удалось открыть страницу расширений: %w", err)
				} else if err := openExtensionFolder(extensionDir); err != nil {
					extensionErr = fmt.Errorf("не удалось открыть папку расширения: %w", err)
				}
			}
		}
	}
	if helperUpdate {
		launchHelperUpdate(client, installerURL, latestVersion)
		return
	}
	if extensionErr != nil {
		setVersionStatus("Ошибка проверки версии ПО")
		setErrorTooltip(extensionErr)
		return
	}
	if extensionUpdate {
		setVersionStatus(versionStatusText(latestVersion, true))
		systray.SetTooltip("Папка расширения v" + latestVersion + " открыта; загрузите её в браузере")
		return
	}
	setVersionStatus(versionStatusText(latestVersion, false))
	systray.SetTooltip("Установлены последние версии")
}

func versionStatusText(version string, updateAvailable bool) string {
	if updateAvailable {
		return "Доступно обновление ПО: v" + version
	}
	return "Актуальная версия ПО: v" + version
}

func setVersionStatus(status string) {
	if versionStatusItem != nil {
		versionStatusItem.SetTitle(status)
	}
}

func launchHelperUpdate(client *http.Client, assetURL, version string) {
	if err := downloadAndLaunchInstaller(client, assetURL, version); err != nil {
		setErrorTooltip(err)
		return
	}
	systray.SetTooltip("Запущена установка v" + version)
	if runtime.GOOS == "windows" {
		systray.Quit()
	}
}

func releaseAsset(latest release, name string) (string, bool) {
	for _, item := range latest.Assets {
		if item.Name == name && strings.HasPrefix(item.BrowserDownloadURL, "https://github.com/evangelion3131/vless-extension/releases/download/") {
			return item.BrowserDownloadURL, true
		}
	}
	return "", false
}

func installerAssetName(goos, goarch, version string) (string, error) {
	prefix := "vless-eevee.v" + version + "."
	switch {
	case goos == "windows" && goarch == "amd64":
		return prefix + "windows.x64.msi", nil
	case goos == "darwin" && goarch == "amd64":
		return prefix + "macos.x64.pkg", nil
	case goos == "darwin" && goarch == "arm64":
		return prefix + "macos.arm64.pkg", nil
	case goos == "linux" && goarch == "amd64":
		return prefix + "linux.amd64.deb", nil
	case goos == "linux" && goarch == "arm64":
		return prefix + "linux.arm64.deb", nil
	default:
		return "", fmt.Errorf("автообновление не поддерживается для %s/%s", goos, goarch)
	}
}

func downloadAndLaunchInstaller(client *http.Client, assetURL, version string) error {
	req, err := http.NewRequest(http.MethodGet, assetURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "vless-eevee")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("скачивание установщика: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("скачивание установщика: %s", resp.Status)
	}
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return fmt.Errorf("каталог загрузок: %w", err)
	}
	cacheDir = filepath.Join(cacheDir, "vless-eevee", "updates")
	if err := os.MkdirAll(cacheDir, 0700); err != nil {
		return fmt.Errorf("создание каталога обновлений: %w", err)
	}
	file, err := os.CreateTemp(cacheDir, "vless-eevee-"+version+"-*")
	if err != nil {
		return fmt.Errorf("создание файла обновления: %w", err)
	}
	path := file.Name()
	content, err := io.ReadAll(io.LimitReader(resp.Body, (250<<20)+1))
	if err != nil {
		file.Close()
		os.Remove(path)
		return fmt.Errorf("чтение установщика: %w", err)
	}
	if len(content) == 0 || len(content) > 250<<20 {
		file.Close()
		os.Remove(path)
		return fmt.Errorf("неверный размер установщика")
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		os.Remove(path)
		return fmt.Errorf("сохранение установщика: %w", err)
	}
	if err := file.Close(); err != nil {
		os.Remove(path)
		return fmt.Errorf("сохранение установщика: %w", err)
	}
	cmd, err := installerCommand(path)
	if err != nil {
		os.Remove(path)
		return err
	}
	if err := cmd.Start(); err != nil {
		os.Remove(path)
		return fmt.Errorf("запуск установщика: %w", err)
	}
	go func() {
		if err := cmd.Wait(); err != nil {
			systray.SetTooltip("Ошибка установщика: " + err.Error())
		}
		os.Remove(path)
	}()
	return nil
}

func installerCommand(path string) (*exec.Cmd, error) {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("msiexec.exe", "/i", path), nil
	case "darwin":
		return exec.Command("open", "-W", path), nil
	case "linux":
		if _, err := exec.LookPath("pkexec"); err != nil {
			return nil, fmt.Errorf("не найден pkexec для установки обновления")
		}
		if _, err := exec.LookPath("apt-get"); err != nil {
			return nil, fmt.Errorf("не найден apt-get для установки обновления")
		}
		return exec.Command("pkexec", "apt-get", "install", "-y", "--reinstall", path), nil
	default:
		return nil, fmt.Errorf("установка обновления не поддерживается на %s", runtime.GOOS)
	}
}

func openExtensionsPage() error {
	browsers := []string{"google-chrome", "chromium", "chromium-browser", "brave-browser"}
	switch runtime.GOOS {
	case "linux":
		for _, browser := range browsers {
			if path, err := exec.LookPath(browser); err == nil {
				return exec.Command(path, "chrome://extensions").Start()
			}
		}
	case "darwin":
		for _, path := range []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		} {
			if _, err := os.Stat(path); err == nil {
				return exec.Command(path, "chrome://extensions").Start()
			}
		}
	case "windows":
		programFiles := []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")}
		for _, dir := range programFiles {
			if dir == "" {
				continue
			}
			for _, relative := range []string{
				"Google/Chrome/Application/chrome.exe",
				"BraveSoftware/Brave-Browser/Application/brave.exe",
				"Chromium/Application/chrome.exe",
			} {
				path := filepath.Join(dir, relative)
				if _, err := os.Stat(path); err == nil {
					return exec.Command(path, "chrome://extensions").Start()
				}
			}
		}
	}
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", releasesURL).Start()
	case "darwin":
		return exec.Command("open", releasesURL).Start()
	default:
		return exec.Command("xdg-open", releasesURL).Start()
	}
}

func readInstalledExtensionVersion(dataDir string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:17837/extension/version", nil)
	if err == nil {
		statusClient := &http.Client{Timeout: 2 * time.Second}
		resp, requestErr := statusClient.Do(req)
		if requestErr == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				data, readErr := io.ReadAll(io.LimitReader(resp.Body, 128))
				if readErr == nil {
					version := strings.TrimSpace(string(data))
					if _, ok := parseVersion(version); ok {
						return version, nil
					}
				}
			}
		}
	}
	return readPackagedExtensionVersion(dataDir)
}

func readPackagedExtensionVersion(dataDir string) (string, error) {
	if dataDir == "" {
		configDir, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dataDir = filepath.Join(configDir, "vless-eevee")
	}
	var data []byte
	var err error
	for _, file := range []string{
		filepath.Join(dataDir, "installed-extension-version.txt"),
		filepath.Join(dataDir, "extension-version.txt"),
	} {
		data, err = os.ReadFile(file)
		if err == nil {
			break
		}
	}
	if err != nil {
		executable, exeErr := os.Executable()
		if exeErr == nil {
			data, err = os.ReadFile(filepath.Join(filepath.Dir(executable), "vless-eevee.crx.version"))
		}
	}
	if err != nil {
		return "", fmt.Errorf("не удалось прочитать версию расширения: %w", err)
	}
	version := strings.TrimSpace(string(data))
	if _, ok := parseVersion(version); !ok {
		return "", fmt.Errorf("неверная версия расширения %q", version)
	}
	return version, nil
}

func downloadAndExtractExtension(client *http.Client, assetURL, version string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, assetURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "vless-eevee")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("скачивание расширения: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("скачивание расширения: %s", resp.Status)
	}
	const maxArchiveSize = 25 << 20
	archiveData, err := io.ReadAll(io.LimitReader(resp.Body, maxArchiveSize+1))
	if err != nil {
		return "", fmt.Errorf("чтение архива расширения: %w", err)
	}
	if len(archiveData) == 0 || len(archiveData) > maxArchiveSize {
		return "", fmt.Errorf("неверный размер архива расширения")
	}
	archive, err := zip.NewReader(bytes.NewReader(archiveData), int64(len(archiveData)))
	if err != nil {
		return "", fmt.Errorf("неверный архив расширения: %w", err)
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	baseDir := filepath.Join(configDir, "vless-eevee", "extension-updates")
	if err := os.MkdirAll(baseDir, 0700); err != nil {
		return "", fmt.Errorf("создание папки обновлений: %w", err)
	}
	targetDir := filepath.Join(baseDir, "v"+version)
	if info, err := os.Lstat(targetDir); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("недопустимая папка обновления: %s", targetDir)
		}
		manifestData, err := os.ReadFile(filepath.Join(targetDir, "manifest.json"))
		if err != nil {
			return "", fmt.Errorf("папка обновления повреждена: %w", err)
		}
		var manifest struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(manifestData, &manifest); err != nil || manifest.Version != version {
			return "", fmt.Errorf("папка обновления содержит другую версию")
		}
		return targetDir, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("проверка папки обновления: %w", err)
	}
	tempDir, err := os.MkdirTemp(baseDir, ".vless-eevee-*")
	if err != nil {
		return "", fmt.Errorf("создание временной папки: %w", err)
	}
	defer os.RemoveAll(tempDir)
	var totalSize uint64
	for _, item := range archive.File {
		if strings.Contains(item.Name, `\`) {
			return "", fmt.Errorf("недопустимый путь в архиве расширения")
		}
		name := path.Clean(strings.TrimPrefix(item.Name, "./"))
		if name == "." && item.FileInfo().IsDir() {
			continue
		}
		if path.IsAbs(name) || strings.Contains(name, ":") || name == ".." || strings.HasPrefix(name, "../") ||
			item.FileInfo().Mode()&os.ModeSymlink != 0 || item.UncompressedSize64 > maxArchiveSize {
			return "", fmt.Errorf("небезопасный путь в архиве расширения")
		}
		totalSize += item.UncompressedSize64
		if totalSize > maxArchiveSize {
			return "", fmt.Errorf("архив расширения слишком большой")
		}
		filename := filepath.Join(tempDir, filepath.FromSlash(name))
		relative, err := filepath.Rel(tempDir, filename)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
			return "", fmt.Errorf("небезопасный путь в архиве расширения")
		}
		if item.FileInfo().IsDir() {
			if err := os.MkdirAll(filename, 0700); err != nil {
				return "", fmt.Errorf("создание каталога расширения: %w", err)
			}
			continue
		}
		if !item.FileInfo().Mode().IsRegular() {
			return "", fmt.Errorf("недопустимый файл в архиве расширения")
		}
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			return "", fmt.Errorf("создание каталога расширения: %w", err)
		}
		source, err := item.Open()
		if err != nil {
			return "", fmt.Errorf("чтение архива расширения: %w", err)
		}
		destination, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			source.Close()
			return "", fmt.Errorf("создание файла расширения: %w", err)
		}
		written, copyErr := io.Copy(destination, io.LimitReader(source, int64(item.UncompressedSize64)+1))
		source.Close()
		closeErr := destination.Close()
		if copyErr != nil || closeErr != nil || written != int64(item.UncompressedSize64) {
			return "", fmt.Errorf("не удалось распаковать архив расширения")
		}
	}
	manifestData, err := os.ReadFile(filepath.Join(tempDir, "manifest.json"))
	if err != nil {
		return "", fmt.Errorf("в архиве нет manifest.json: %w", err)
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(manifestData, &manifest); err != nil || manifest.Version != version {
		return "", fmt.Errorf("версия расширения в архиве не совпадает с релизом")
	}
	if err := os.Rename(tempDir, targetDir); err != nil {
		return "", fmt.Errorf("сохранение папки расширения: %w", err)
	}
	return targetDir, nil
}

func openExtensionFolder(dir string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	return cmd.Start()
}

func parseVersion(version string) ([3]int, bool) {
	var parts [3]int
	items := strings.Split(version, ".")
	if len(items) != len(parts) {
		return parts, false
	}
	for i, part := range items {
		if part == "" {
			return parts, false
		}
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return parts, false
		}
		parts[i] = value
	}
	return parts, true
}

func compareVersions(a, b string) int {
	left, leftOK := parseVersion(a)
	right, rightOK := parseVersion(b)
	if !leftOK || !rightOK {
		return 0
	}
	for i := range left {
		if left[i] < right[i] {
			return -1
		}
		if left[i] > right[i] {
			return 1
		}
	}
	return 0
}

func setErrorTooltip(err error) {
	setVersionStatus("Ошибка проверки версии ПО")
	systray.SetTooltip("Ошибка обновления: " + err.Error())
}
